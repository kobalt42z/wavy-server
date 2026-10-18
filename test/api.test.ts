/**
 * End-to-end API tests: the real server on a random port, real FFmpeg, and the
 * generated sample files. Every supported sample must come out as something Chrome
 * plays (H.264 yuv420p + AAC), either directly or through HLS.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { SAMPLES } from "../scripts/samples.ts";
import { postJson, probeStreams, samplesDir, startServer, type TestServer } from "./helpers/server.ts";

let srv: TestServer;

beforeAll(async () => {
  srv = await startServer(await samplesDir(), { maxTranscodes: 100, maxSessions: 100 });
}, 180_000);
afterAll(() => srv?.close());

const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");

describe("GET /api/probe", () => {
  for (const spec of SAMPLES) {
    test(`${spec.file} -> ${spec.expected}`, async () => {
      const res = await fetch(`${srv.base}/api/probe?path=${encodeURIComponent(spec.file)}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { mode: string; path: string; reason: string };
      expect({ file: spec.file, mode: body.mode }).toEqual({ file: spec.file, mode: spec.expected });
      expect(body.path).toBe(spec.file);
      expect(body.reason.length).toBeGreaterThan(0);
    });
  }

  test("returns the spec's response shape", async () => {
    const res = await fetch(`${srv.base}/api/probe?path=video/avi_h264_g711.avi`);
    const body = await res.json();
    expect(body).toMatchObject({
      mode: "transcode-audio",
      duration: expect.any(Number),
      container: "avi",
      video: { codec: "h264", width: 640, height: 360, fps: 25 },
      audio: [{ track: 0, codec: "pcm_alaw", channels: 1, lang: null }],
      subtitles: [],
      plan: { video: "copy", audio: "encode" },
    });
  });
});

describe("POST /api/sessions plays every supported sample", () => {
  for (const spec of SAMPLES.filter((s) => s.expected !== "unsupported")) {
    test(`${spec.file} (${spec.expected})`, async () => {
      const res = await postJson(`${srv.base}/api/sessions`, { path: spec.file });
      expect(res.status).toBe(201);
      const s = (await res.json()) as { sessionId: string; mode: string; url: string; start: number };
      expect(s.mode).toBe(spec.expected);
      expect(s.sessionId).toMatch(/^[A-Za-z0-9_-]{24}$/);

      if (spec.expected === "direct") {
        expect(s.url).toBe(`/api/files/${enc(spec.file)}`);
        const file = await fetch(srv.base + s.url, { headers: { Range: "bytes=0-15" } });
        expect(file.status).toBe(206);
        expect((await file.arrayBuffer()).byteLength).toBe(16);
      } else {
        expect(s.url).toStartWith(`/api/sessions/${s.sessionId}/index.m3u8`);
        const pl = await fetch(srv.base + s.url);
        expect(pl.status).toBe(200);
        expect(pl.headers.get("content-type")).toBe("application/vnd.apple.mpegurl");
        expect(await pl.text()).toContain("#EXTINF");

        // The HLS output is what Chrome can play: H.264 High yuv420p and/or AAC.
        const streams = await probeStreams(srv.base + s.url);
        const v = streams.find((x) => x.codec_type === "video");
        const a = streams.find((x) => x.codec_type === "audio");
        if (v) {
          expect(v.codec_name).toBe("h264");
          expect(["yuv420p", "yuvj420p"]).toContain(v.pix_fmt!);
        }
        if (a) expect(a.codec_name).toBe("aac");
        expect(v ?? a).toBeDefined();
      }

      const dir = srv.sessions.get(s.sessionId)!.dir;
      const del = await fetch(`${srv.base}/api/sessions/${s.sessionId}`, { method: "DELETE" });
      expect(del.status).toBe(204);
      expect(srv.sessions.get(s.sessionId)).toBeUndefined();
      if (dir) expect(existsSync(dir)).toBe(false);
    }, 60_000);
  }
});

describe("errors", () => {
  test("unsupported files return 422 with a reason", async () => {
    for (const file of ["other/export.g64x", "other/project.prproj", "other/peaks.pkf", "other/driver.sys", "other/notes.txt", "other/corrupt.mp4"]) {
      const res = await postJson(`${srv.base}/api/sessions`, { path: file });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string; reason: string };
      expect(body.error).toBe("unsupported");
      expect(body.reason.length).toBeGreaterThan(5);
    }
    const g64x = (await (await postJson(`${srv.base}/api/sessions`, { path: "other/export.g64x" })).json()) as { reason: string };
    expect(g64x.reason).toContain("Genetec");
  });

  test("path traversal and absolute paths are rejected", async () => {
    for (const path of ["../etc/passwd", "video/../../etc/passwd", "/etc/passwd", "..\\..\\etc\\passwd", "C:/Windows/win.ini"]) {
      const res = await fetch(`${srv.base}/api/probe?path=${encodeURIComponent(path)}`);
      expect({ path, status: res.status }).toEqual({ path, status: 400 });
      expect(((await res.json()) as { error: string }).error).toBe("invalid_path");
    }
    const viaFiles = await fetch(`${srv.base}/api/files/..%2F..%2Fetc%2Fpasswd`);
    expect(viaFiles.status).toBe(400);
  });

  test("missing files are 404", async () => {
    const res = await fetch(`${srv.base}/api/probe?path=video/nope.mp4`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
  });

  test("bad bodies are 400", async () => {
    expect((await fetch(`${srv.base}/api/sessions`, { method: "POST", body: "nope" })).status).toBe(400);
    expect((await postJson(`${srv.base}/api/sessions`, {})).status).toBe(400);
    expect((await postJson(`${srv.base}/api/sessions`, { path: "audio/mp3.mp3", start: -1 })).status).toBe(400);
    expect((await postJson(`${srv.base}/api/sessions`, { path: "audio/mp3.mp3", audioTrack: 3 })).status).toBe(400);
  });

  test("files that need conversion are not served raw", async () => {
    const res = await fetch(`${srv.base}/api/files/video/mov_prores_pcm.mov`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "not_direct" });
  });

  test("unknown sessions are 404, and DELETE is idempotent", async () => {
    expect((await fetch(`${srv.base}/api/sessions/doesnotexist/index.m3u8`)).status).toBe(404);
    expect((await fetch(`${srv.base}/api/sessions/doesnotexist`, { method: "DELETE" })).status).toBe(204);
  });

  test("segment names are restricted to the session folder", async () => {
    const s = (await (await postJson(`${srv.base}/api/sessions`, { path: "video/ts_h264_aac.ts" })).json()) as { sessionId: string };
    for (const name of ["..%2Findex.m3u8", "index.m3u8.bak", "%2Fetc%2Fpasswd"]) {
      expect((await fetch(`${srv.base}/api/sessions/${s.sessionId}/${name}`)).status).toBe(404);
    }
    await fetch(`${srv.base}/api/sessions/${s.sessionId}`, { method: "DELETE" });
  });
});

describe("direct file serving", () => {
  const url = () => `${srv.base}/api/files/video/mp4_h264_aac.mp4`;

  test("full file, ranges, suffix ranges, HEAD and 416", async () => {
    const full = await fetch(url());
    expect(full.status).toBe(200);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("content-type")).toBe("video/mp4");
    const size = (await full.arrayBuffer()).byteLength;

    const part = await fetch(url(), { headers: { Range: "bytes=100-199" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 100-199/${size}`);
    expect((await part.arrayBuffer()).byteLength).toBe(100);

    const open = await fetch(url(), { headers: { Range: `bytes=${size - 10}-` } });
    expect(open.status).toBe(206);
    expect((await open.arrayBuffer()).byteLength).toBe(10);

    const suffix = await fetch(url(), { headers: { Range: "bytes=-20" } });
    expect(suffix.headers.get("content-range")).toBe(`bytes ${size - 20}-${size - 1}/${size}`);
    expect((await suffix.arrayBuffer()).byteLength).toBe(20);

    const head = await fetch(url(), { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(size));

    const bad = await fetch(url(), { headers: { Range: `bytes=${size}-` } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe(`bytes */${size}`);
  });

  test("file names with spaces, quotes and $() are served", async () => {
    const res = await fetch(`${srv.base}/api/files/${enc("video/name with spaces 'quotes' $(id).mp4")}`, {
      headers: { Range: "bytes=0-3" },
    });
    expect(res.status).toBe(206);
  });
});

test("health and metrics", async () => {
  const health = await fetch(`${srv.base}/healthz`);
  expect(health.status).toBe(200);
  expect(await health.json()).toMatchObject({ status: "ok" });

  const metrics = await (await fetch(`${srv.base}/metrics`)).text();
  expect(metrics).toContain("wavy_active_transcodes");
  expect(metrics).toContain('wavy_active_sessions{mode="remux"}');
  expect(metrics).toMatch(/wavy_sessions_started_total\{mode="transcode",extension="mov"\} \d+/);
  expect(metrics).toMatch(/wavy_sessions_rejected_total\{reason="unsupported",extension="g64x"\} \d+/);
  expect(metrics).toContain("wavy_ffmpeg_speed_bucket");
});

test("CORS preflight is answered", async () => {
  const res = await fetch(`${srv.base}/api/sessions`, {
    method: "OPTIONS",
    headers: { Origin: "http://app.example", "Access-Control-Request-Method": "POST" },
  });
  expect(res.status).toBe(204);
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
});
