/**
 * The rebuilt AVI index (src/avi-index.ts): the virtual file FFmpeg reads must decode
 * exactly like the original, open without touching the original index chunks, and
 * seek to exact timestamps.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AviIndexer, buildAviIndex } from "../src/avi-index.ts";
import { loadConfig } from "../src/config.ts";
import type { MediaFile } from "../src/media-path.ts";
import { writeOdmlAvi } from "./helpers/odml-avi.ts";
import { samplesDir } from "./helpers/server.ts";

let dir: string;
let origin: ReturnType<typeof Bun.serve>;
let hits: string[] = [];

// Async spawns: the loopback server runs in this process and must keep serving.
const run = async (cmd: string[]) => {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
};
const ffprobe = async (args: string[]) => {
  const p = await run(["ffprobe", "-v", "error", "-protocol_whitelist", "file,http,tcp", ...args]);
  if (p.code !== 0) throw new Error(p.err);
  return p.out.trim();
};
/** pts of the first video frame FFmpeg decodes after `-ss at`. */
const firstFrameAt = async (input: string, at: number) => {
  const p = await run([
    "ffmpeg", "-nostats", "-protocol_whitelist", "file,http,tcp",
    "-ss", String(at), "-i", input, "-copyts", "-frames:v", "1", "-vf", "showinfo", "-an", "-f", "null", "-",
  ]);
  return Number(/pts_time:([0-9.]+)/.exec(p.err)?.[1]);
};
const localReader = (path: string) => {
  const bytes = readFileSync(path);
  return async (start: number, end: number) => new Uint8Array(bytes.subarray(start, end + 1));
};

beforeAll(async () => {
  const samples = await samplesDir();
  dir = mkdtempSync(join(tmpdir(), "wavy-avi-index-"));
  const src = join(dir, "src.avi");
  const ff = Bun.spawnSync([
    "ffmpeg", "-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=30",
    "-f", "lavfi", "-i", "sine=d=30",
    "-c:v", "libx264", "-preset", "ultrafast", "-g", "25", "-pix_fmt", "yuv420p",
    "-c:a", "pcm_alaw", "-ar", "8000", "-ac", "1", src,
  ]);
  if (ff.exitCode !== 0) throw new Error(ff.stderr.toString());
  writeOdmlAvi(src, join(dir, "dvr.avi"), 25);
  Bun.write(join(dir, "plain.avi"), Bun.file(join(samples, "video/avi_xvid_mp3.avi")));
  origin = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      hits.push(req.headers.get("range") ?? "");
      const file = Bun.file(join(dir, u.pathname.slice(1)));
      const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get("range") ?? "");
      if (!m) return new Response(file);
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), file.size - 1) : file.size - 1;
      return new Response(file.slice(start, end + 1), {
        status: 206,
        headers: { "Content-Range": `bytes ${start}-${end}/${file.size}` },
      });
    },
  });
});

afterAll(() => {
  origin?.stop(true);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("buildAviIndex", () => {
  test("files without an OpenDML index are left alone", async () => {
    const path = join(dir, "plain.avi");
    expect(await buildAviIndex(localReader(path), Bun.file(path).size)).toBeNull();
  });

  test("merges one index chunk per second into one per stream", async () => {
    const path = join(dir, "dvr.avi");
    const index = await buildAviIndex(localReader(path), Bun.file(path).size);
    expect(index).not.toBeNull();
    expect(index!.chunks).toBeGreaterThanOrEqual(60); // about 30 per stream in the original
    // Two merged chunks: 32-byte header + 8 bytes per entry (750 frames + 750 audio chunks).
    expect(index!.tail.length).toBeGreaterThan(2 * 32 + 1500 * 8 - 64);
  });
});

describe("AviIndexer (virtual file over loopback)", () => {
  const cfg = { ...loadConfig({}).remote, allowHttp: true, allowedHosts: ["127.0.0.1"] };
  let indexer: AviIndexer;
  let file: MediaFile;
  let url: string;

  beforeAll(async () => {
    const size = Bun.file(join(dir, "dvr.avi")).size;
    file = {
      relPath: `http://127.0.0.1:${origin.port}/dvr.avi`,
      absPath: `http://127.0.0.1:${origin.port}/dvr.avi?X-Amz-Signature=ok`,
      realRelPath: "dvr.avi",
      size,
      mtimeMs: 0,
      remote: true,
    };
    indexer = new AviIndexer(cfg);
    const opened = await indexer.open(file, 10_000);
    expect(opened).not.toBeNull();
    url = opened!.url;
  });
  afterAll(() => indexer?.stop());

  test("decodes like the original: same streams, duration and frame count", async () => {
    const show = "-show_entries";
    const what = "stream=codec_name,nb_read_frames:format=duration";
    const original = await ffprobe(["-count_frames", show, what, "-of", "compact", join(dir, "dvr.avi")]);
    const virtual = await ffprobe(["-count_frames", show, what, "-of", "compact", url]);
    expect(virtual).toBe(original);
  });

  test("opening reads no original index chunk, and seeks land on the exact time", async () => {
    hits = [];
    for (const at of [0, 12, 27]) expect(await firstFrameAt(url, at)).toBeCloseTo(at, 2);
    // Only big data reads go to the origin: the index comes from memory.
    for (const h of hits) {
      const m = /^bytes=(\d+)-(\d+)$/.exec(h)!;
      expect(Number(m[2]) - Number(m[1])).toBeGreaterThan(64 * 1024);
    }
  });

  test("released URLs stop working", async () => {
    const opened = (await indexer.open(file, 0))!;
    expect((await fetch(opened.url, { headers: { Range: "bytes=0-3" } })).status).toBe(206);
    indexer.release(opened.id);
    expect((await fetch(opened.url, { headers: { Range: "bytes=0-3" } })).status).toBe(404);
  });
});
