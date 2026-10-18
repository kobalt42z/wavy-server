import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { decide } from "../src/decide.ts";
import { parseRange } from "../src/files.ts";
import { buildHlsArgs, parseProgressSpeed, SEGMENT_NAME, type HlsOptions } from "../src/hls.ts";
import { ApiError } from "../src/http/errors.ts";
import { encodeMediaPath, resolveMediaPath } from "../src/media-path.ts";
import type { ProbeResult } from "../src/probe.ts";
import { loadRules } from "../src/rules.ts";

const rules = loadRules();

describe("resolveMediaPath", () => {
  const root = mkdtempSync(join(tmpdir(), "wavy-root-"));
  const outside = mkdtempSync(join(tmpdir(), "wavy-outside-"));
  mkdirSync(join(root, "cctv/cam 1"), { recursive: true });
  writeFileSync(join(root, "cctv/cam 1/clip.mp4"), "x");
  writeFileSync(join(root, "..hidden.mp4"), "x");
  writeFileSync(join(outside, "secret.mp4"), "secret");
  symlinkSync(join(outside, "secret.mp4"), join(root, "escape.mp4"));
  symlinkSync(outside, join(root, "escape-dir"));
  symlinkSync(join(root, "cctv/cam 1/clip.mp4"), join(root, "inside-link.mp4"));

  const code = async (p: string) => {
    try {
      await resolveMediaPath(root, p);
      return "ok";
    } catch (e) {
      return (e as ApiError).code;
    }
  };

  test("accepts relative paths inside the root", async () => {
    const f = await resolveMediaPath(root, "cctv/cam 1/clip.mp4");
    expect(f.relPath).toBe("cctv/cam 1/clip.mp4");
    expect(f.size).toBe(1);
    expect(await code("./cctv//cam 1/clip.mp4")).toBe("ok");
    expect(await code("..hidden.mp4")).toBe("ok");
    expect(await code("inside-link.mp4")).toBe("ok");
  });

  test("rejects traversal, absolute paths, NUL and escaping symlinks", async () => {
    expect(await code("../etc/passwd")).toBe("invalid_path");
    expect(await code("cctv/../../etc/passwd")).toBe("invalid_path");
    expect(await code("cctv\\..\\..\\etc\\passwd")).toBe("invalid_path");
    expect(await code("/etc/passwd")).toBe("invalid_path");
    expect(await code("C:\\Windows\\win.ini")).toBe("invalid_path");
    expect(await code("clip\0.mp4")).toBe("invalid_path");
    expect(await code("")).toBe("invalid_path");
    expect(await code("escape.mp4")).toBe("invalid_path");
    expect(await code("escape-dir/secret.mp4")).toBe("invalid_path");
  });

  test("missing files and folders are not_found", async () => {
    expect(await code("nope.mp4")).toBe("not_found");
    expect(await code("cctv")).toBe("not_found");
  });

  test("encodeMediaPath keeps slashes", () => {
    expect(encodeMediaPath("a b/c#d?.mp4")).toBe("a%20b/c%23d%3F.mp4");
  });
});

describe("parseRange", () => {
  test("handles the forms browsers send", () => {
    expect(parseRange(null, 100)).toEqual({ kind: "full" });
    expect(parseRange("bytes=0-", 100)).toEqual({ kind: "partial", start: 0, end: 99 });
    expect(parseRange("bytes=10-19", 100)).toEqual({ kind: "partial", start: 10, end: 19 });
    expect(parseRange("bytes=90-500", 100)).toEqual({ kind: "partial", start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ kind: "partial", start: 90, end: 99 });
    expect(parseRange("bytes=-500", 100)).toEqual({ kind: "partial", start: 0, end: 99 });
    expect(parseRange("bytes=0-1, 5-6", 100)).toEqual({ kind: "partial", start: 0, end: 1 });
  });

  test("unsatisfiable and malformed ranges", () => {
    expect(parseRange("bytes=100-", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=-0", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=0-", 0)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("items=0-5", 100)).toEqual({ kind: "full" });
    expect(parseRange("bytes=5-2", 100)).toEqual({ kind: "full" });
    expect(parseRange("bytes=-", 100)).toEqual({ kind: "full" });
  });
});

describe("buildHlsArgs", () => {
  const opts: HlsOptions = {
    input: "/media/a b.mov",
    outDir: "/tmp/sessions/abc",
    start: 0,
    prefix: "g1",
    hlsTime: 4,
    segmentType: "fmp4",
    x264Preset: "veryfast",
    x264Crf: 23,
    audioBitrate: "160k",
  };
  const probe = (video: Partial<ProbeResult["video"][0]> | null, audio: string | null, extra: Partial<ProbeResult> = {}): ProbeResult => ({
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    duration: 60,
    video: video ? [{ index: 0, codec: "h264", pixFmt: "yuv420p", width: 1920, height: 1080, ...video }] : [],
    audio: audio ? [{ index: video ? 1 : 0, codec: audio, channels: 2 }] : [],
    subtitles: [],
    inputArgs: [],
    ...extra,
  });
  const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  test("remux copies both streams", () => {
    const p = probe({}, "aac");
    const args = buildHlsArgs(decide(p, "mov", rules), p, opts);
    expect(after(args, "-c:v")).toBe("copy");
    expect(after(args, "-c:a")).toBe("copy");
    expect(args).not.toContain("-ss");
    expect(args).toContain("0:0");
    expect(args).toContain("0:1");
    expect(after(args, "-hls_segment_type")).toBe("fmp4");
    expect(after(args, "-hls_segment_filename")).toBe("/tmp/sessions/abc/g1_%05d.m4s");
    expect(after(args, "-hls_fmp4_init_filename")).toBe("g1_init.mp4");
    expect(args.at(-1)).toBe("/tmp/sessions/abc/index.m3u8");
    expect(after(args, "-i")).toBe("/media/a b.mov");
  });

  test("partial transcode copies video and encodes audio to stereo AAC", () => {
    const p = probe({}, "ac3");
    const args = buildHlsArgs(decide(p, "mts", rules), p, opts);
    expect(after(args, "-c:v")).toBe("copy");
    expect(after(args, "-c:a")).toBe("aac");
    expect(after(args, "-ac")).toBe("2");
    expect(after(args, "-b:a")).toBe("160k");
  });

  test("full transcode encodes H.264 High yuv420p, caps height, keys every segment, seeks with -ss", () => {
    const p = probe({ codec: "hevc", height: 2160, width: 3840 }, "aac");
    const args = buildHlsArgs(decide(p, "mp4", rules), p, { ...opts, start: 42.5 });
    expect(after(args, "-c:v")).toBe("libx264");
    expect(after(args, "-profile:v")).toBe("high");
    expect(after(args, "-pix_fmt")).toBe("yuv420p");
    expect(after(args, "-vf")).toBe("scale=-2:'min(1080,ih)'");
    expect(after(args, "-force_key_frames")).toBe("expr:gte(t,n_forced*4)");
    expect(after(args, "-ss")).toBe("42.500");
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
  });

  test("raw CCTV input options go before -i; audio-only files map no video", () => {
    const raw = probe({}, null, { inputArgs: ["-f", "h264", "-framerate", "25"] });
    const args = buildHlsArgs(decide(raw, "264", rules), raw, opts);
    expect(args.slice(args.indexOf("-i") - 4, args.indexOf("-i"))).toEqual(["-f", "h264", "-framerate", "25"]);

    const wma = probe(null, "wmav2", { container: "asf" });
    const a = buildHlsArgs(decide(wma, "wma", rules), wma, { ...opts, segmentType: "mpegts" });
    expect(a).not.toContain("-c:v");
    expect(a.filter((x) => x === "-map")).toHaveLength(1);
    expect(after(a, "-hls_segment_filename")).toBe("/tmp/sessions/abc/g1_%05d.ts");
    expect(a).not.toContain("-hls_fmp4_init_filename");
  });

  test("refuses direct and unsupported decisions", () => {
    const p = probe({}, "aac");
    expect(() => buildHlsArgs(decide(p, "mp4", rules), p, opts)).toThrow();
  });

  test("segment names and progress parsing", () => {
    expect(SEGMENT_NAME.test("g1_00001.m4s")).toBe(true);
    expect(SEGMENT_NAME.test("g1_init.mp4")).toBe(true);
    expect(SEGMENT_NAME.test("g12_00001.ts")).toBe(true);
    expect(SEGMENT_NAME.test("../index.m3u8")).toBe(false);
    expect(SEGMENT_NAME.test("index.m3u8")).toBe(false);
    expect(parseProgressSpeed("speed=1.52x")).toBe(1.52);
    expect(parseProgressSpeed("speed=N/A")).toBeUndefined();
    expect(parseProgressSpeed("frame=10")).toBeUndefined();
  });
});

describe("loadConfig", () => {
  test("defaults follow the spec", () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ port: 8080, mediaRoot: "/media", maxTranscodes: 4, idleTimeoutMs: 60_000, hlsTime: 4, segmentType: "fmp4" });
  });
  test("reads and validates environment variables", () => {
    expect(loadConfig({ MAX_TRANSCODES: "8", HLS_SEGMENT_TYPE: "mpegts", CORS_ORIGINS: "https://a, https://b" })).toMatchObject({
      maxTranscodes: 8,
      segmentType: "mpegts",
      corsOrigins: ["https://a", "https://b"],
    });
    expect(() => loadConfig({ MAX_TRANSCODES: "lots" })).toThrow("MAX_TRANSCODES");
    expect(() => loadConfig({ HLS_SEGMENT_TYPE: "dash" })).toThrow("HLS_SEGMENT_TYPE");
  });
});
