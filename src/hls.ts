import { join } from "node:path";
import type { Decision } from "./decide.ts";
import type { ProbeResult } from "./probe.ts";

export interface HlsOptions {
  input: string;
  outDir: string;
  /** Seek start in seconds (FFmpeg -ss before -i). */
  start: number;
  /** Prefix for segment file names, so segments of a restarted encode never collide. */
  prefix: string;
  hlsTime: number;
  segmentType: "fmp4" | "mpegts";
  x264Preset: string;
  x264Crf: number;
  audioBitrate: string;
}

export const PLAYLIST_NAME = "index.m3u8";

/** Segment and init file names a session serves. Anything else is refused. */
export const SEGMENT_NAME = /^[A-Za-z0-9_-]{1,64}\.(m4s|mp4|ts)$/;

export function segmentContentType(name: string): string {
  return name.endsWith(".ts") ? "video/mp2t" : "video/mp4";
}

/**
 * FFmpeg arguments that turn a file into an HLS event playlist, following the decision:
 * each stream is copied or re-encoded (H.264 High yuv420p / AAC stereo).
 * Returned as an argument array: never passed through a shell.
 */
export function buildHlsArgs(decision: Decision, probe: ProbeResult, o: HlsOptions): string[] {
  if (decision.mode === "direct" || decision.mode === "unsupported") {
    throw new Error(`buildHlsArgs called for ${decision.mode} mode`);
  }
  const { video, audio } = decision;
  const args = [
    "-hide_banner",
    "-nostdin",
    "-loglevel", "error",
    // Machine-readable progress on stdout (speed=, out_time=) for metrics.
    "-progress", "pipe:1",
    "-nostats",
    // Rebuild missing timestamps (raw CCTV streams, broken exports).
    "-fflags", "+genpts",
  ];
  if (o.start > 0) args.push("-ss", formatSeconds(o.start));
  args.push(...probe.inputArgs, "-i", o.input);

  if (video.action !== "none" && video.index !== undefined) args.push("-map", `0:${video.index}`);
  if (audio.action !== "none" && audio.index !== undefined) args.push("-map", `0:${audio.index}`);
  args.push("-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1");

  if (video.action === "copy") {
    args.push("-c:v", "copy");
  } else if (video.action === "encode") {
    const maxH = decision.maxOutputHeight ?? 1080;
    args.push(
      "-c:v", "libx264",
      "-preset", o.x264Preset,
      "-crf", String(o.x264Crf),
      "-profile:v", "high",
      "-pix_fmt", "yuv420p",
      // Downscale to maxH, never upscale; -2 keeps the width even.
      "-vf", `scale=-2:'min(${maxH},ih)'`,
      // A keyframe at every segment boundary, whatever the frame rate.
      "-force_key_frames", `expr:gte(t,n_forced*${o.hlsTime})`,
      "-sc_threshold", "0",
    );
  }

  if (audio.action === "copy") {
    args.push("-c:a", "copy");
  } else if (audio.action === "encode") {
    args.push("-c:a", "aac", "-b:a", o.audioBitrate, "-ac", "2", "-ar", "48000");
  }

  args.push(
    "-avoid_negative_ts", "make_zero",
    "-max_muxing_queue_size", "1024",
    "-f", "hls",
    "-hls_time", String(o.hlsTime),
    "-hls_list_size", "0",
    "-hls_playlist_type", "event",
    "-hls_segment_type", o.segmentType,
    "-hls_flags", "independent_segments+temp_file",
  );
  if (o.segmentType === "fmp4") {
    args.push("-hls_fmp4_init_filename", `${o.prefix}_init.mp4`);
    args.push("-hls_segment_filename", join(o.outDir, `${o.prefix}_%05d.m4s`));
  } else {
    args.push("-hls_segment_filename", join(o.outDir, `${o.prefix}_%05d.ts`));
  }
  args.push(join(o.outDir, PLAYLIST_NAME));
  return args;
}

function formatSeconds(s: number): string {
  return (Math.round(s * 1000) / 1000).toFixed(3);
}

/** Reads "speed=1.23x" from an FFmpeg -progress block. */
export function parseProgressSpeed(line: string): number | undefined {
  const m = /^speed=\s*([\d.]+)x\s*$/.exec(line.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
