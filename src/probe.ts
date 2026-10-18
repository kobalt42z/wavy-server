import type { PlaybackRules } from "./rules.ts";
import { extensionOf } from "./paths.ts";

export interface VideoStream {
  index: number;
  codec: string;
  profile?: string;
  pixFmt?: string;
  width?: number;
  height?: number;
  fps?: number;
}

export interface AudioStream {
  index: number;
  codec: string;
  channels?: number;
  sampleRate?: number;
  lang?: string;
}

export interface SubtitleStream {
  index: number;
  codec: string;
  lang?: string;
}

export interface ProbeResult {
  /** ffprobe format_name, e.g. "mov,mp4,m4a,3gp,3g2,mj2". */
  container: string;
  duration?: number;
  size?: number;
  bitRate?: number;
  video: VideoStream[];
  audio: AudioStream[];
  subtitles: SubtitleStream[];
  /** FFmpeg input options needed to read this file (placed before -i). */
  inputArgs: string[];
}

export type ProbeOutcome = { ok: true; probe: ProbeResult } | { ok: false; error: string };

export interface ProbeOptions {
  ffprobePath?: string;
  timeoutMs?: number;
}

/**
 * Runs ffprobe on a file. Uses the extension's input override if one exists, and
 * retries with each fallback format if auto-detection fails.
 */
export async function probeFile(path: string, rules: PlaybackRules, opts: ProbeOptions = {}): Promise<ProbeOutcome> {
  const ext = extensionOf(path);
  const override = rules.inputOverrides[ext]?.args;
  const attempts: string[][] = override ? [override] : [[], ...rules.probeFallbackFormats.map((f) => ["-f", f])];

  let lastError = "ffprobe could not read the file";
  for (const inputArgs of attempts) {
    const res = await runFfprobe(path, inputArgs, opts);
    if (!res.ok) {
      lastError = res.error;
      continue;
    }
    const probe = parseFfprobe(res.json, inputArgs);
    if (probe.video.length === 0 && probe.audio.length === 0) {
      lastError = "no audio or video stream found";
      continue;
    }
    return { ok: true, probe };
  }
  return { ok: false, error: lastError };
}

async function runFfprobe(
  path: string,
  inputArgs: string[],
  opts: ProbeOptions,
): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
  // Argument array, never a shell string, so file names can't inject commands.
  const cmd = [
    opts.ffprobePath ?? "ffprobe",
    "-v", "error",
    "-show_streams",
    "-show_format",
    "-of", "json",
    ...inputArgs,
    "-i", path,
  ];
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs ?? 30_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      const msg = stderr.trim().split("\n").pop() || `ffprobe exited with code ${code}`;
      return { ok: false, error: proc.signalCode === "SIGKILL" ? "ffprobe timed out" : msg };
    }
    return { ok: true, json: JSON.parse(stdout) };
  } catch (err) {
    return { ok: false, error: `ffprobe failed: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

interface RawStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  channels?: number;
  sample_rate?: string;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
}

interface RawProbe {
  streams?: RawStream[];
  format?: { format_name?: string; duration?: string; size?: string; bit_rate?: string };
}

/** Converts raw ffprobe JSON into the normalized shape the rest of the service uses. */
export function parseFfprobe(json: unknown, inputArgs: string[] = []): ProbeResult {
  const raw = (json ?? {}) as RawProbe;
  const streams = raw.streams ?? [];
  const video: VideoStream[] = [];
  const audio: AudioStream[] = [];
  const subtitles: SubtitleStream[] = [];

  for (const s of streams) {
    const index = s.index ?? 0;
    const codec = (s.codec_name ?? "unknown").toLowerCase();
    if (s.codec_type === "video") {
      // Cover art in audio files shows up as a video stream; it is not playable video.
      if (s.disposition?.attached_pic === 1) continue;
      video.push({
        index,
        codec,
        profile: s.profile,
        pixFmt: s.pix_fmt,
        width: s.width,
        height: s.height,
        fps: parseRate(s.avg_frame_rate) ?? parseRate(s.r_frame_rate),
      });
    } else if (s.codec_type === "audio") {
      audio.push({
        index,
        codec,
        channels: s.channels,
        sampleRate: toNumber(s.sample_rate),
        lang: s.tags?.language,
      });
    } else if (s.codec_type === "subtitle") {
      subtitles.push({ index, codec, lang: s.tags?.language });
    }
  }

  return {
    container: (raw.format?.format_name ?? "unknown").toLowerCase(),
    duration: toNumber(raw.format?.duration),
    size: toNumber(raw.format?.size),
    bitRate: toNumber(raw.format?.bit_rate),
    video,
    audio,
    subtitles,
    inputArgs,
  };
}

function parseRate(rate?: string): number | undefined {
  if (!rate) return undefined;
  const [n, d] = rate.split("/").map(Number);
  if (n === undefined || !Number.isFinite(n) || n <= 0) return undefined;
  const fps = d ? n / d : n;
  return Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : undefined;
}

function toNumber(v?: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
