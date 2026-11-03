/**
 * Remote sources: a token whose path is an http(s) URL plays from that URL (an S3
 * presigned link, faked here by a local server) instead of the share. Plus the
 * share-root prefixes (MEDIA_PATH_PREFIXES).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type AuthConfig } from "../src/config.ts";
import { stripRootPrefix } from "../src/media-path.ts";
import { hostAllowed } from "../src/remote.ts";
import { samplesDir, startServer, type TestServer } from "./helpers/server.ts";

let samples: string;
let media: string;
let priv: CryptoKey;
let pubJwk: JWK;
let s3: ReturnType<typeof Bun.serve>;
let s3Base: string;
let s3Hits: { method: string; path: string; range: string | null }[] = [];
let srv: TestServer;

const auth = (): AuthConfig => ({ ...loadConfig({}).auth, mode: "jwt", jwks: JSON.stringify({ keys: [pubJwk] }) });
const token = (path: string, sub = "user-1") =>
  new SignJWT({ path })
    .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
    .setSubject(sub)
    .setIssuer("main")
    .setAudience("wavy")
    .setIssuedAt()
    .setExpirationTime("10m")
    .setJti(crypto.randomUUID())
    .sign(priv);
const post = (url: string, body: unknown, t?: string) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) },
    body: JSON.stringify(body),
  });
const signed = (key: string) => `${s3Base}/bucket/${key}?X-Amz-Expires=900&X-Amz-Signature=ok`;

beforeAll(async () => {
  samples = await samplesDir();
  media = mkdtempSync(join(tmpdir(), "wavy-remote-media-"));
  mkdirSync(join(media, "cases/12"), { recursive: true });
  copyFileSync(join(samples, "video/mp4_h264_aac.mp4"), join(media, "cases/12/clip.mp4"));

  const kp = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  priv = kp.privateKey;
  pubJwk = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "EdDSA" };

  // A tiny S3 stand-in: GET only (presigned URLs aren't valid for HEAD), signature
  // check, Range support, and one redirecting key.
  s3 = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const u = new URL(req.url);
      s3Hits.push({ method: req.method, path: u.pathname, range: req.headers.get("range") });
      if (req.method !== "GET") return new Response("SignatureDoesNotMatch", { status: 403 });
      if (u.searchParams.get("X-Amz-Signature") !== "ok") return new Response("AccessDenied", { status: 403 });
      if (u.pathname === "/bucket/redirect.mp4") return Response.redirect("http://169.254.169.254/latest/meta-data", 302);
      const key = u.pathname.replace(/^\/bucket\//, "");
      const file = Bun.file(join(samples, decodeURIComponent(key)));
      if (!(await file.exists())) return new Response("NoSuchKey", { status: 404 });
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get("range") ?? "");
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), file.size - 1) : file.size - 1;
        return new Response(file.slice(start, end + 1), {
          status: 206,
          headers: { "Content-Range": `bytes ${start}-${end}/${file.size}`, ETag: '"abc"', "Last-Modified": new Date(0).toUTCString() },
        });
      }
      return new Response(file, { headers: { ETag: '"abc"' } });
    },
  });
  s3Base = `http://127.0.0.1:${s3.port}`;
  srv = await startServer(media, {
    auth: auth(),
    remote: { ...loadConfig({}).remote, allowedHosts: [`127.0.0.1:${s3.port}`], allowHttp: true, timeoutMs: 5000 },
    mediaPathPrefixes: ["\\\\fileserver\\media\\", "/mnt/media"],
  });
}, 180_000);

afterAll(async () => {
  await srv?.close();
  await s3?.stop(true);
  if (media) rmSync(media, { recursive: true, force: true });
});

describe("host allowlist", () => {
  test("exact hosts and *.suffix", () => {
    const list = ["*.amazonaws.com", "minio.internal:9000"];
    expect(hostAllowed("bucket.s3.eu-west-1.amazonaws.com", list)).toBe(true);
    expect(hostAllowed("BUCKET.S3.AMAZONAWS.COM", list)).toBe(true);
    expect(hostAllowed("amazonaws.com", list)).toBe(false);
    expect(hostAllowed("evilamazonaws.com", list)).toBe(false);
    expect(hostAllowed("x.amazonaws.com:8080", list)).toBe(false);
    expect(hostAllowed("minio.internal:9000", list)).toBe(true);
    expect(hostAllowed("minio.internal", list)).toBe(false);
    expect(hostAllowed("minio.internal:9001", list)).toBe(false);
  });

  test("config rejects junk hosts", () => {
    expect(() => loadConfig({ REMOTE_ALLOWED_HOSTS: "http://x.com" })).toThrow(/REMOTE_ALLOWED_HOSTS/);
    expect(() => loadConfig({ REMOTE_ALLOWED_HOSTS: "*" })).toThrow(/REMOTE_ALLOWED_HOSTS/);
    expect(loadConfig({ REMOTE_ALLOWED_HOSTS: "*.amazonaws.com, minio:9000" }).remote.allowedHosts).toEqual(["*.amazonaws.com", "minio:9000"]);
  });
});

describe("a token with an http(s) URL plays from that URL", () => {
  test("direct: the session file is proxied from the URL with Range", async () => {
    const url = signed("video/mp4_h264_aac.mp4");
    const res = await post(`${srv.base}/api/sessions`, {}, await token(url));
    expect(res.status).toBe(201);
    const s = (await res.json()) as { sessionId: string; url: string; mode: string };
    expect(s.mode).toBe("direct");
    expect(s.url).toBe(`/api/sessions/${s.sessionId}/file`);

    const part = await fetch(srv.base + s.url, { headers: { Range: "bytes=100-199" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-type")).toBe("video/mp4");
    const original = Buffer.from(await Bun.file(join(samples, "video/mp4_h264_aac.mp4")).arrayBuffer());
    expect(part.headers.get("content-range")).toBe(`bytes 100-199/${original.length}`);
    expect(Buffer.from(await part.arrayBuffer())).toEqual(original.subarray(100, 200));

    const head = await fetch(srv.base + s.url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(original.length));
    // Wavy never sent HEAD upstream.
    expect(s3Hits.some((h) => h.method === "HEAD")).toBe(false);
    // The signature never leaves wavy.
    const state = await (await fetch(`${srv.base}/api/sessions/${s.sessionId}`)).json();
    expect(JSON.stringify(state)).not.toContain("X-Amz-Signature");
    expect((state as { path: string }).path).toBe(`${s3Base}/bucket/video/mp4_h264_aac.mp4`);
  });

  test("HLS: FFmpeg reads the URL (remux, then a seek)", async () => {
    const url = signed("video/ts_h264_aac.ts");
    const s = (await (await post(`${srv.base}/api/sessions`, {}, await token(url))).json()) as { sessionId: string; url: string; mode: string };
    expect(s.mode).toBe("remux");
    const pl = await fetch(srv.base + s.url);
    expect(pl.status).toBe(200);
    expect(await pl.text()).toContain("#EXTINF");
    const seek = await post(`${srv.base}/api/sessions/${s.sessionId}/seek`, { position: 1 });
    expect(seek.status).toBe(200);
    expect((await fetch(srv.base + ((await seek.json()) as { url: string }).url)).status).toBe(200);
    await fetch(`${srv.base}/api/sessions/${s.sessionId}`, { method: "DELETE" });
  }, 60_000);

  test("probe works with the token's URL and shows no signature", async () => {
    const url = signed("video/mp4_h264_aac.mp4");
    const res = await fetch(`${srv.base}/api/probe`, { headers: { Authorization: `Bearer ${await token(url)}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; mode: string };
    expect(body.mode).toBe("direct");
    expect(body.path).not.toContain("?");
  });

  test("a different URL than the token's is refused before anything is fetched", async () => {
    const t = await token(signed("video/mp4_h264_aac.mp4"));
    const before = s3Hits.length;
    const res = await post(`${srv.base}/api/sessions`, { path: signed("video/ts_h264_aac.ts") }, t);
    expect(res.status).toBe(403);
    expect(s3Hits.length).toBe(before);
  });

  test("a share grant can't open a URL, and a URL grant can't open a share file", async () => {
    const share = await token("cases/12/");
    const before = s3Hits.length;
    expect((await post(`${srv.base}/api/sessions`, { path: signed("video/mp4_h264_aac.mp4") }, share)).status).toBe(403);
    expect(s3Hits.length).toBe(before);
    const remote = await token(signed("video/mp4_h264_aac.mp4"));
    expect((await post(`${srv.base}/api/sessions`, { path: "cases/12/clip.mp4" }, remote)).status).toBe(403);
  });

  test("hosts off the list, https-only, credentials and redirects are refused", async () => {
    const cases: [string, number, string][] = [
      ["http://169.254.169.254/latest/meta-data/x.mp4", 403, "remote_forbidden"],
      ["http://localhost:1/x.mp4", 403, "remote_forbidden"],
      [`http://user:pw@127.0.0.1:${s3.port}/bucket/video/mp4_h264_aac.mp4?X-Amz-Signature=ok`, 403, "remote_forbidden"],
      [signed("redirect.mp4"), 502, "remote_unavailable"],
      [`${s3Base}/bucket/video/mp4_h264_aac.mp4?X-Amz-Signature=expired`, 502, "remote_denied"],
      [signed("video/nope.mp4"), 404, "not_found"],
    ];
    for (const [url, status, error] of cases) {
      const res = await post(`${srv.base}/api/sessions`, {}, await token(url));
      const body = (await res.json()) as { error: string };
      expect({ url, status: res.status, error: body.error }).toEqual({ url, status, error });
    }
  });

  test("https is required unless REMOTE_ALLOW_HTTP, and URLs are off with no allowed hosts", async () => {
    const strict = await startServer(media, { auth: auth(), remote: { ...loadConfig({}).remote, allowedHosts: [`127.0.0.1:${s3.port}`], allowHttp: false } });
    const off = await startServer(media, { auth: auth() });
    try {
      const t = await token(signed("video/mp4_h264_aac.mp4"));
      expect(((await (await post(`${strict.base}/api/sessions`, {}, t)).json()) as { error: string }).error).toBe("remote_forbidden");
      expect(((await (await post(`${off.base}/api/sessions`, {}, t)).json()) as { error: string }).error).toBe("remote_disabled");
    } finally {
      await strict.close();
      await off.close();
    }
  });
});

describe("share-root prefixes", () => {
  test("stripRootPrefix removes a known root spelling, and nothing else", () => {
    const p = ["\\\\fileserver\\media\\", "smb://fileserver/media", "/mnt/media/"];
    expect(stripRootPrefix("\\\\fileserver\\media\\cases\\12\\a.mp4", p)).toBe("cases/12/a.mp4");
    expect(stripRootPrefix("\\\\FILESERVER\\Media\\cases\\12\\a.mp4", p)).toBe("cases/12/a.mp4");
    expect(stripRootPrefix("smb://fileserver/media/cases/12/a.mp4", p)).toBe("cases/12/a.mp4");
    expect(stripRootPrefix("/mnt/media/cases/12/a.mp4", p)).toBe("cases/12/a.mp4");
    expect(stripRootPrefix("/mnt/mediax/a.mp4", p)).toBe("/mnt/mediax/a.mp4");
    expect(stripRootPrefix("cases/12/a.mp4", p)).toBe("cases/12/a.mp4");
    expect(stripRootPrefix("/mnt/media/../etc/passwd", p)).toBe("../etc/passwd"); // then rejected for ".."
  });

  test("a UNC path works in the token and in the request", async () => {
    const t = await token("\\\\fileserver\\media\\cases\\12\\");
    const res = await post(`${srv.base}/api/sessions`, { path: "/mnt/media/cases/12/clip.mp4" }, t);
    expect(res.status).toBe(201);
    const s = (await res.json()) as { sessionId: string };
    expect(srv.sessions.get(s.sessionId)?.relPath).toBe("cases/12/clip.mp4");
    expect((await post(`${srv.base}/api/sessions`, { path: "/mnt/media/../etc/passwd" }, t)).status).toBe(400);
  });
});

test("https: certificates are verified, by wavy and by FFmpeg (REMOTE_CA_FILE for a private CA)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wavy-tls-"));
  const gen = Bun.spawnSync([
    "openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
  ], { stderr: "pipe" });
  if (gen.exitCode !== 0) throw new Error(gen.stderr.toString());
  const https = Bun.serve({
    port: 0,
    tls: { key: Bun.file(join(dir, "key.pem")), cert: Bun.file(join(dir, "cert.pem")) },
    fetch: (req) => s3.fetch(req),
  });
  const host = `127.0.0.1:${https.port}`;
  const base = { ...loadConfig({}).remote, allowedHosts: [host] };
  const trusting = await startServer(media, { auth: auth(), remote: { ...base, caFile: join(dir, "cert.pem"), customCa: true } });
  const strict = await startServer(media, { auth: auth(), remote: base });
  try {
    const url = `https://${host}/bucket/video/ts_h264_aac.ts?X-Amz-Signature=ok`;
    const bad = await post(`${strict.base}/api/sessions`, {}, await token(url));
    expect(bad.status).toBe(502);

    const ok = await post(`${trusting.base}/api/sessions`, {}, await token(url));
    expect(ok.status).toBe(201);
    const s = (await ok.json()) as { url: string; mode: string };
    expect(s.mode).toBe("remux");
    expect(await (await fetch(trusting.base + s.url)).text()).toContain("#EXTINF");
  } finally {
    await trusting.close();
    await strict.close();
    await https.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
