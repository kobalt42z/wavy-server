/**
 * The S3 slice cache (deploy/cache): the real nginx config in front
 * of an S3 stand-in, with wavy reading remote files through it (REMOTE_CACHE_URL).
 * Needs nginx with the slice module on the PATH; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { cacheUrlFor, type RemoteConfig } from "../src/remote.ts";
import { writeOdmlAvi } from "./helpers/odml-avi.ts";
import { postJson, samplesDir, startServer, type TestServer } from "./helpers/server.ts";

const TEMPLATE = join(import.meta.dir, "../deploy/cache/wavy-cache.conf.template");
const hasNginx = Bun.which("nginx") !== null && Bun.spawnSync(["nginx", "-V"]).stderr.toString().includes("http_slice_module");

let samples: string;
let extra: string;
let media: string;
let nginxDir: string;
let nginx: ReturnType<typeof Bun.spawn> | undefined;
let cachePort: number;
let s3: ReturnType<typeof Bun.serve>;
let s3Hits: { path: string; range: string | null; host: string | null }[] = [];
let srv: TestServer;

const freePort = () => {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port!;
  s.stop(true);
  return port;
};

/** Renders the template the way the nginx image's entrypoint does (envsubst). */
function renderConfig(vars: Record<string, string>): string {
  return readFileSync(TEMPLATE, "utf8").replace(/\$\{([A-Z_]+)\}/g, (m, name: string) => vars[name] ?? m);
}

async function startNginx(dir: string, port: number, hostsRegex: string) {
  mkdirSync(join(dir, "cache"), { recursive: true });
  const site = renderConfig({
    WAVY_CACHE_DIR: join(dir, "cache"),
    WAVY_CACHE_MAX_SIZE: "1g",
    WAVY_CACHE_INACTIVE: "1h",
    WAVY_CACHE_SLICE: "256k",
    WAVY_CACHE_HOSTS: hostsRegex,
    WAVY_CACHE_CA_FILE: "/etc/ssl/certs/ca-certificates.crt",
    NGINX_LOCAL_RESOLVERS: "127.0.0.1",
  }).replace("listen 8080 default_server;", `listen 127.0.0.1:${port} default_server;`);
  writeFileSync(join(dir, "site.conf"), site);
  writeFileSync(
    join(dir, "nginx.conf"),
    `daemon off;
${process.getuid?.() === 0 ? "user root;\n" : ""}worker_processes 1;
pid ${dir}/nginx.pid;
error_log ${dir}/error.log warn;
events { worker_connections 256; }
http {
  access_log off;
  client_body_temp_path ${dir}/body;
  proxy_temp_path ${dir}/proxy;
  fastcgi_temp_path ${dir}/fastcgi;
  uwsgi_temp_path ${dir}/uwsgi;
  scgi_temp_path ${dir}/scgi;
  include ${dir}/site.conf;
}
`,
  );
  const proc = Bun.spawn(["nginx", "-p", dir, "-e", `${dir}/error.log`, "-c", `${dir}/nginx.conf`], { stdout: "ignore", stderr: "pipe" });
  for (let i = 0; i < 100; i++) {
    const ok = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false);
    if (ok) return proc;
    if (proc.exitCode !== null) break;
    await Bun.sleep(50);
  }
  throw new Error(`nginx did not start: ${await new Response(proc.stderr).text()} ${readFileSync(join(dir, "error.log"), "utf8")}`);
}

const remote = (overrides: Partial<RemoteConfig> = {}): RemoteConfig => ({
  ...loadConfig({}).remote,
  allowedHosts: [`127.0.0.1:${s3.port}`],
  allowHttp: true,
  timeoutMs: 5000,
  cacheUrl: `http://127.0.0.1:${cachePort}`,
  cacheTimeoutMs: 2000,
  ...overrides,
});
/** A presigned-style link; every call gets a new signature, like a fresh presign. */
const signed = (key: string) => `${s3Base()}/bucket/${key}?X-Amz-Expires=900&X-Amz-Signature=ok&n=${crypto.randomUUID()}`;
const s3Base = () => `http://127.0.0.1:${s3.port}`;
const probe = (base: string, url: string) => fetch(`${base}/api/probe?path=${encodeURIComponent(url)}`);

beforeAll(async () => {
  if (!hasNginx) return;
  samples = await samplesDir();
  media = mkdtempSync(join(tmpdir(), "wavy-cache-media-"));
  extra = mkdtempSync(join(tmpdir(), "wavy-cache-extra-"));
  writeOdmlAvi(join(samples, "video/avi_h264_g711.avi"), join(extra, "dvr.avi"), 1);

  // S3 stand-in: checks the signature and that Host is its own (presigned URLs sign
  // it), serves Range requests.
  s3 = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const u = new URL(req.url);
      s3Hits.push({ path: decodeURIComponent(u.pathname), range: req.headers.get("range"), host: req.headers.get("host") });
      if (req.method !== "GET") return new Response("SignatureDoesNotMatch", { status: 403 });
      if (u.searchParams.get("X-Amz-Signature") !== "ok") return new Response("AccessDenied", { status: 403 });
      if (req.headers.get("host") !== `127.0.0.1:${s3.port}`) return new Response("SignatureDoesNotMatch (host)", { status: 403 });
      const key = decodeURIComponent(u.pathname.replace(/^\/bucket\//, ""));
      const file = Bun.file(key.startsWith("extra/") ? join(extra, key.slice(6)) : join(samples, key));
      if (!(await file.exists())) return new Response("NoSuchKey", { status: 404 });
      const headers = { ETag: '"abc"', "Last-Modified": new Date(0).toUTCString(), "Cache-Control": "no-cache" };
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get("range") ?? "");
      if (range) {
        const start = Number(range[1]);
        if (start >= file.size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${file.size}` } });
        const end = range[2] ? Math.min(Number(range[2]), file.size - 1) : file.size - 1;
        return new Response(file.slice(start, end + 1), {
          status: 206,
          headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${file.size}` },
        });
      }
      return new Response(file, { headers });
    },
  });

  nginxDir = mkdtempSync(join(tmpdir(), "wavy-cache-nginx-"));
  cachePort = freePort();
  nginx = await startNginx(nginxDir, cachePort, "^127\\.0\\.0\\.1:[0-9]+$");
  srv = await startServer(media, { remote: remote() });
}, 180_000);

afterAll(async () => {
  await srv?.close();
  nginx?.kill();
  await nginx?.exited;
  await s3?.stop(true);
  for (const d of [media, extra, nginxDir]) if (d) rmSync(d, { recursive: true, force: true });
});

test("deploy/cache/wavy-cache.yaml embeds the same nginx config, and its cap stays under the disk", () => {
  const docs = Bun.YAML.parse(readFileSync(join(import.meta.dir, "../deploy/cache/wavy-cache.yaml"), "utf8")) as Record<string, any>[];
  const config = docs.find((d) => d.kind === "ConfigMap");
  expect(config?.data?.["wavy-cache.conf.template"]).toBe(readFileSync(TEMPLATE, "utf8"));
  const gib = (q: string) => Number(/^(\d+)/.exec(q)![1]);
  const pvc = docs.find((d) => d.kind === "PersistentVolumeClaim")!;
  const env = Object.fromEntries(
    docs.find((d) => d.kind === "Deployment")!.spec.template.spec.containers[0].env.map((e: { name: string; value: string }) => [e.name, e.value]),
  );
  expect(gib(env.WAVY_CACHE_MAX_SIZE)).toBeLessThanOrEqual(gib(pvc.spec.resources.requests.storage) * 0.95);
  const policy = docs.find((d) => d.kind === "NetworkPolicy")!;
  expect(policy.spec.ingress[0].from).toEqual([{ podSelector: { matchLabels: { "app.kubernetes.io/name": "wavy-server" } } }]);
});

describe.skipIf(!hasNginx)("S3 slice cache (REMOTE_CACHE_URL)", () => {
  test("the cache URL keeps scheme, host:port, the encoded path and the query", () => {
    const u = new URL("https://bucket.s3.amazonaws.com:8443/cases/a%20b.avi?X-Amz-Signature=x");
    expect(cacheUrlFor("http://wavy-cache:8080/", u, "v1")).toBe(
      "http://wavy-cache:8080/https/bucket.s3.amazonaws.com:8443/v1/cases/a%20b.avi?X-Amz-Signature=x",
    );
  });

  test("a second probe of the same file, with a new signature, reads nothing from S3", async () => {
    s3Hits = [];
    const first = await probe(srv.base, signed("extra/dvr.avi"));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ mode: "transcode-audio", video: { codec: "h264" } });
    expect(s3Hits.length).toBeGreaterThan(0);
    // nginx sends the origin's Host, so the presigned signature still matches.
    expect(s3Hits.every((h) => h.host === `127.0.0.1:${s3.port}`)).toBe(true);
    // Slices, not open-ended ranges.
    expect(s3Hits.every((h) => /^bytes=\d+-\d+$/.test(h.range ?? ""))).toBe(true);

    s3Hits = [];
    // A new link (new signature) for the same object: same slices. The only S3
    // request is wavy's one-byte link check (expired links are refused, ETag versions).
    const second = await probe(srv.base, signed("extra/dvr.avi"));
    expect(second.status).toBe(200);
    expect(s3Hits.map((h) => h.range)).toEqual(["bytes=0-0"]);
  });

  test("HLS and seeking read through the cache", async () => {
    const url = signed("video/avi_h264_mp3.avi");
    const res = await postJson(`${srv.base}/api/sessions`, { path: url });
    expect(res.status).toBe(201);
    const s = (await res.json()) as { sessionId: string; url: string; mode: string };
    expect(s.mode).toBe("transcode-audio");
    expect(await (await fetch(srv.base + s.url)).text()).toContain("#EXTINF");
    const seek = await postJson(`${srv.base}/api/sessions/${s.sessionId}/seek`, { position: 1 });
    expect(seek.status).toBe(200);
    expect((await fetch(srv.base + ((await seek.json()) as { url: string }).url)).status).toBe(200);
    await fetch(`${srv.base}/api/sessions/${s.sessionId}`, { method: "DELETE" });

    // Played again with a fresh link: everything comes from the cache.
    s3Hits = [];
    const again = (await (await postJson(`${srv.base}/api/sessions`, { path: signed("video/avi_h264_mp3.avi") })).json()) as {
      sessionId: string;
      url: string;
    };
    expect(await (await fetch(srv.base + again.url)).text()).toContain("#EXTINF");
    expect(s3Hits.map((h) => h.range)).toEqual(["bytes=0-0"]);
    await fetch(`${srv.base}/api/sessions/${again.sessionId}`, { method: "DELETE" });
  }, 60_000);

  test("direct play is proxied through the cache with exact byte ranges, odd file names included", async () => {
    const key = "video/name with spaces 'quotes' $(id).mp4";
    const url = `${s3Base()}/bucket/${key.split("/").map(encodeURIComponent).join("/")}?X-Amz-Signature=ok`;
    const res = await postJson(`${srv.base}/api/sessions`, { path: url });
    expect(res.status).toBe(201);
    const s = (await res.json()) as { url: string; mode: string };
    expect(s.mode).toBe("direct");
    const original = Buffer.from(await Bun.file(join(samples, key)).arrayBuffer());
    const part = await fetch(srv.base + s.url, { headers: { Range: "bytes=300000-300099" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 300000-300099/${original.length}`);
    expect(Buffer.from(await part.arrayBuffer())).toEqual(original.subarray(300000, 300100));
    // The same bytes again come from the cache.
    s3Hits = [];
    const again = await fetch(srv.base + s.url, { headers: { Range: "bytes=300050-300149" } });
    expect(Buffer.from(await again.arrayBuffer())).toEqual(original.subarray(300050, 300150));
    expect(s3Hits).toEqual([]);
  });

  test("expired links and missing objects still get the origin's answer", async () => {
    const expired = await probe(srv.base, `${s3Base()}/bucket/video/avi_h264_mp3.avi?X-Amz-Signature=expired`);
    expect(expired.status).toBe(502);
    expect(((await expired.json()) as { error: string }).error).toBe("remote_denied");
    const missing = await probe(srv.base, signed("video/nope.avi"));
    expect(missing.status).toBe(404);
  });

  test("the cache only fetches from WAVY_CACHE_HOSTS and only answers GET", async () => {
    const off = await fetch(`http://127.0.0.1:${cachePort}/http/169.254.169.254/v1/latest/meta-data`);
    expect(off.status).toBe(403);
    const post = await fetch(`http://127.0.0.1:${cachePort}/http/127.0.0.1:${s3.port}/v1/bucket/video/avi_h264_mp3.avi`, { method: "POST" });
    expect(post.status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${cachePort}/elsewhere`)).status).toBe(404);
  });

  test("with the cache down, wavy reads from S3 directly", async () => {
    const down = await startServer(media, { remote: remote({ cacheUrl: `http://127.0.0.1:${freePort()}` }) });
    try {
      s3Hits = [];
      const res = await probe(down.base, signed("video/avi_xvid_mp3.avi"));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { mode: string }).mode).toBe("transcode");
      expect(s3Hits.length).toBeGreaterThan(0);
      const s = (await (await postJson(`${down.base}/api/sessions`, { path: signed("video/avi_xvid_mp3.avi") })).json()) as { url: string };
      expect(await (await fetch(down.base + s.url)).text()).toContain("#EXTINF");
    } finally {
      await down.close();
    }
  }, 60_000);
});
