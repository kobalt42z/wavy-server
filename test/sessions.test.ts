/**
 * Session lifecycle: restart-on-seek, idle cleanup, the transcode cap, stop via
 * sendBeacon, audio track choice, and FFmpeg failures.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postJson, probeStreams, processAlive, startServer } from "./helpers/server.ts";

const media = mkdtempSync(join(tmpdir(), "wavy-session-media-"));

async function ffmpeg(args: string[]) {
  const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...args], { stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(err);
}

beforeAll(async () => {
  const src = ["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=20", "-f", "lavfi", "-i", "sine=frequency=440:duration=20"];
  // 20 s HEVC: a full transcode long enough to seek in.
  await ffmpeg([...src, "-map", "0:v", "-map", "1:a", "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error", "-c:a", "aac", join(media, "long_hevc.mp4")]);
  // 20 s H.264 in TS: a remux.
  await ffmpeg([...src, "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", join(media, "long_h264.ts")]);
  // Direct MP4 with two audio tracks (AAC English, AC3 French).
  await ffmpeg([
    ...src.slice(0, 4), "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-f", "lavfi", "-i", "sine=frequency=880:duration=3",
    "-map", "0:v", "-map", "1:a", "-map", "2:a", "-t", "3",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a:0", "aac", "-c:a:1", "ac3",
    "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=fra", join(media, "two_tracks.mp4"),
  ]);
}, 120_000);
afterAll(() => rmSync(media, { recursive: true, force: true }));

test("seek restarts FFmpeg at the new position and drops the old segments", async () => {
  const srv = await startServer(media);
  try {
    const s = (await (await postJson(`${srv.base}/api/sessions`, { path: "long_hevc.mp4" })).json()) as { sessionId: string; url: string; mode: string };
    expect(s.mode).toBe("transcode");
    expect(await (await fetch(srv.base + s.url)).text()).toContain("g1_");
    const session = srv.sessions.get(s.sessionId)!;
    const firstPid = session.proc?.pid;

    const seek = await postJson(`${srv.base}/api/sessions/${s.sessionId}/seek`, { position: 12 });
    expect(seek.status).toBe(200);
    const body = (await seek.json()) as { url: string; start: number };
    expect(body.start).toBe(12);
    expect(body.url).toBe(`/api/sessions/${s.sessionId}/index.m3u8?v=2`);
    if (firstPid) expect(await processAlive(firstPid)).toBe(false);

    const playlist = await (await fetch(srv.base + body.url)).text();
    expect(playlist).toContain("g2_");
    expect(playlist).not.toContain("g1_");
    expect(existsSync(join(session.dir, "g1_init.mp4"))).toBe(false);

    // The new encode covers the rest of the file only (20 s - 12 s).
    await waitFor(() => session.encoder === "done", 30_000);
    const final = await (await fetch(srv.base + body.url)).text();
    const total = [...final.matchAll(/#EXTINF:([\d.]+)/g)].reduce((t, m) => t + Number(m[1]), 0);
    expect(total).toBeGreaterThan(6);
    expect(total).toBeLessThan(10);
    expect(final).toContain("#EXT-X-ENDLIST");
  } finally {
    await srv.close();
  }
}, 60_000);

test("sessions with no segment requests are stopped and cleaned up", async () => {
  const srv = await startServer(media, { idleTimeoutMs: 1500, reapIntervalMs: 100 });
  try {
    const s = (await (await postJson(`${srv.base}/api/sessions`, { path: "long_hevc.mp4" })).json()) as { sessionId: string };
    const session = srv.sessions.get(s.sessionId)!;
    const pid = session.proc!.pid;
    await waitFor(() => srv.sessions.get(s.sessionId) === undefined, 5_000);
    expect(await processAlive(pid)).toBe(false);
    expect(existsSync(session.dir)).toBe(false);
    expect(await (await fetch(`${srv.base}/metrics`)).text()).toContain('wavy_sessions_ended_total{cause="idle"} 1');
  } finally {
    await srv.close();
  }
}, 30_000);

test("full transcodes are capped per pod with 503 + Retry-After; remux is not", async () => {
  const srv = await startServer(media, { maxTranscodes: 1, retryAfterSec: 7 });
  try {
    const first = await postJson(`${srv.base}/api/sessions`, { path: "long_hevc.mp4" });
    expect(first.status).toBe(201);
    const second = await postJson(`${srv.base}/api/sessions`, { path: "long_hevc.mp4" });
    expect(second.status).toBe(503);
    expect(second.headers.get("retry-after")).toBe("7");
    expect(await second.json()).toMatchObject({ error: "capacity" });

    const remux = await postJson(`${srv.base}/api/sessions`, { path: "long_h264.ts" });
    expect(remux.status).toBe(201);
    expect(((await remux.json()) as { mode: string }).mode).toBe("remux");

    const metrics = await (await fetch(`${srv.base}/metrics`)).text();
    expect(metrics).toContain("wavy_active_transcodes 1");
    expect(metrics).toContain("wavy_transcode_capacity 1");

    // Freeing the slot lets the next one in.
    const { sessionId } = (await first.json()) as { sessionId: string };
    await fetch(`${srv.base}/api/sessions/${sessionId}`, { method: "DELETE" });
    expect((await postJson(`${srv.base}/api/sessions`, { path: "long_hevc.mp4" })).status).toBe(201);
  } finally {
    await srv.close();
  }
}, 30_000);

test("POST /stop (for sendBeacon) ends the session", async () => {
  const srv = await startServer(media);
  try {
    const s = (await (await postJson(`${srv.base}/api/sessions`, { path: "long_h264.ts" })).json()) as { sessionId: string };
    const res = await fetch(`${srv.base}/api/sessions/${s.sessionId}/stop`, { method: "POST", body: "" });
    expect(res.status).toBe(204);
    expect(srv.sessions.get(s.sessionId)).toBeUndefined();
  } finally {
    await srv.close();
  }
}, 30_000);

test("picking a second audio track switches a direct file to HLS with that track", async () => {
  const srv = await startServer(media);
  try {
    const probe = (await (await fetch(`${srv.base}/api/probe?path=two_tracks.mp4`)).json()) as { mode: string; audio: { track: number; codec: string; channels: number; lang: string }[] };
    expect(probe.mode).toBe("direct");
    expect(probe.audio).toEqual([
      { track: 0, codec: "aac", channels: 1, lang: "eng" },
      { track: 1, codec: "ac3", channels: 1, lang: "fra" },
    ]);

    const res = await postJson(`${srv.base}/api/sessions`, { path: "two_tracks.mp4", audioTrack: 1 });
    expect(res.status).toBe(201);
    const s = (await res.json()) as { mode: string; url: string };
    expect(s.mode).toBe("transcode-audio");
    const streams = await probeStreams(srv.base + s.url);
    expect(streams.filter((x) => x.codec_type === "audio").map((x) => x.codec_name)).toEqual(["aac"]);
  } finally {
    await srv.close();
  }
}, 30_000);

test("an FFmpeg failure is reported to the player and counted", async () => {
  // `false` stands in for an FFmpeg that exits with an error.
  const srv = await startServer(media, { ffmpegPath: "false" });
  try {
    const res = await postJson(`${srv.base}/api/sessions`, { path: "long_hevc.mp4" });
    expect(res.status).toBe(201);
    const s = (await res.json()) as { url: string };
    const pl = await fetch(srv.base + s.url);
    expect(pl.status).toBe(502);
    expect(await pl.json()).toMatchObject({ error: "ffmpeg_failed" });
    expect(await (await fetch(`${srv.base}/metrics`)).text()).toContain(
      'wavy_ffmpeg_failures_total{mode="transcode",extension="mp4"} 1',
    );
  } finally {
    await srv.close();
  }
}, 30_000);

test("shutdown kills every FFmpeg process", async () => {
  const srv = await startServer(media);
  const s = (await (await postJson(`${srv.base}/api/sessions`, { path: "long_hevc.mp4" })).json()) as { sessionId: string };
  const session = srv.sessions.get(s.sessionId)!;
  const pid = session.proc!.pid;
  await srv.close();
  expect(await processAlive(pid)).toBe(false);
  expect(existsSync(session.dir)).toBe(false);
}, 30_000);

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(50);
  }
}
