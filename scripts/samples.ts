import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PlaybackMode } from "../src/decide.ts";

/**
 * Short synthetic test files covering the format inventory in the dev spec.
 * Each one records the playback mode the decision table should pick, so tests
 * can check the rules end to end against real FFmpeg output.
 */
export interface SampleSpec {
  /** Path relative to the samples folder. */
  file: string;
  expected: PlaybackMode;
  /** What the file stands in for. */
  note: string;
  /** FFmpeg output options. Omit for non-media files (see `content`). */
  ffmpeg?: { inputs: "av" | "v" | "a" | "a+cover"; args: string[] };
  /** Literal file content for non-media or corrupt files. */
  content?: string | Uint8Array;
}

/** Formats in the inventory that FFmpeg can read but not write, so they need real files. */
export const NOT_GENERATED = [
  { ext: "dav", note: "Dahua CCTV (DHAV container). FFmpeg has a reader but no writer." },
  { ext: "tak", note: "TAK lossless audio. FFmpeg has a decoder but no encoder." },
];

const X264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"];
const X265 = ["-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error"];
const AAC = ["-c:a", "aac", "-b:a", "128k"];
const AC3 = ["-c:a", "ac3", "-b:a", "192k"];

export const SAMPLES: SampleSpec[] = [
  // Video
  { file: "video/mp4_h264_aac.mp4", expected: "direct", note: "Standard MP4", ffmpeg: { inputs: "av", args: [...X264, ...AAC, "-movflags", "+faststart"] } },
  { file: "video/mp4_h264_10bit_aac.mp4", expected: "transcode", note: "H.264 High 10 (Chrome can't decode 10-bit H.264)", ffmpeg: { inputs: "av", args: ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le", ...AAC] } },
  { file: "video/mp4_hevc_aac.mp4", expected: "transcode", note: "HEVC phone or camera footage", ffmpeg: { inputs: "av", args: [...X265, "-tag:v", "hvc1", ...AAC] } },
  { file: "video/mp4_h264_ac3.mp4", expected: "transcode-audio", note: "MP4 with AC3 audio", ffmpeg: { inputs: "av", args: [...X264, ...AC3] } },
  { file: "video/mov_h264_aac.mov", expected: "remux", note: "QuickTime H.264", ffmpeg: { inputs: "av", args: [...X264, ...AAC] } },
  { file: "video/mov_prores_pcm.mov", expected: "transcode", note: "ProRes 422 edit export", ffmpeg: { inputs: "av", args: ["-c:v", "prores_ks", "-profile:v", "2", "-c:a", "pcm_s16le"] } },
  { file: "video/mov_dnxhr_pcm.mov", expected: "transcode", note: "DNxHR edit export", ffmpeg: { inputs: "av", args: ["-c:v", "dnxhd", "-profile:v", "dnxhr_lb", "-pix_fmt", "yuv422p", "-c:a", "pcm_s16le"] } },
  { file: "video/mts_h264_ac3.mts", expected: "transcode-audio", note: "AVCHD camcorder", ffmpeg: { inputs: "av", args: [...X264, ...AC3, "-f", "mpegts"] } },
  { file: "video/ts_h264_aac.ts", expected: "remux", note: "MPEG-TS H.264", ffmpeg: { inputs: "av", args: [...X264, ...AAC] } },
  { file: "video/ts_h264_aac_51.ts", expected: "transcode-audio", note: "MPEG-TS with 5.1 AAC (mixed down to stereo)", ffmpeg: { inputs: "av", args: [...X264, ...AAC, "-ac", "6"] } },
  { file: "video/ts_mpeg2_ac3.ts", expected: "transcode", note: "Broadcast MPEG-2", ffmpeg: { inputs: "av", args: ["-c:v", "mpeg2video", "-q:v", "4", ...AC3] } },
  { file: "video/mpg_mpeg1_mp2.mpg", expected: "transcode", note: "MPEG-1 program stream", ffmpeg: { inputs: "av", args: ["-c:v", "mpeg1video", "-q:v", "4", "-c:a", "mp2", "-f", "mpeg"] } },
  { file: "video/vob_mpeg2_ac3.vob", expected: "transcode", note: "DVD VOB", ffmpeg: { inputs: "av", args: ["-c:v", "mpeg2video", "-q:v", "4", ...AC3, "-f", "vob"] } },
  { file: "video/avi_xvid_mp3.avi", expected: "transcode", note: "Xvid AVI", ffmpeg: { inputs: "av", args: ["-c:v", "libxvid", "-q:v", "4", "-c:a", "libmp3lame"] } },
  { file: "video/avi_mjpeg_pcm.avi", expected: "transcode", note: "Motion JPEG AVI", ffmpeg: { inputs: "av", args: ["-c:v", "mjpeg", "-pix_fmt", "yuvj420p", "-q:v", "5", "-c:a", "pcm_s16le"] } },
  { file: "video/avi_h264_mp3.avi", expected: "transcode-audio", note: "H.264 AVI", ffmpeg: { inputs: "av", args: [...X264, "-c:a", "libmp3lame"] } },
  { file: "video/avi_h264_g711.avi", expected: "transcode-audio", note: "CCTV-style H.264 with G.711 A-law audio", ffmpeg: { inputs: "av", args: [...X264, "-c:a", "pcm_alaw", "-ar", "8000", "-ac", "1"] } },
  { file: "video/asf_wmv2_wma.asf", expected: "transcode", note: "Windows Media", ffmpeg: { inputs: "av", args: ["-c:v", "wmv2", "-q:v", "4", "-c:a", "wmav2"] } },
  { file: "video/webm_vp9_opus.webm", expected: "direct", note: "WebM VP9", ffmpeg: { inputs: "av", args: ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "500k", "-c:a", "libopus"] } },
  { file: "video/name with spaces 'quotes' $(id).mp4", expected: "direct", note: "Unsafe characters in the file name", ffmpeg: { inputs: "av", args: [...X264, ...AAC] } },

  // CCTV raw streams (no container, no timestamps)
  { file: "cctv/raw_h264.264", expected: "remux", note: "Raw H.264 CCTV export", ffmpeg: { inputs: "v", args: [...X264, "-f", "h264"] } },
  { file: "cctv/raw_hevc.265", expected: "transcode", note: "Raw HEVC CCTV export", ffmpeg: { inputs: "v", args: [...X265, "-f", "hevc"] } },

  // Audio
  { file: "audio/mp3.mp3", expected: "direct", note: "MP3", ffmpeg: { inputs: "a", args: ["-c:a", "libmp3lame", "-b:a", "128k"] } },
  { file: "audio/mp3_cover.mp3", expected: "direct", note: "MP3 with cover art", ffmpeg: { inputs: "a+cover", args: ["-c:a", "libmp3lame", "-c:v", "mjpeg", "-disposition:v", "attached_pic", "-id3v2_version", "3"] } },
  { file: "audio/aac.aac", expected: "direct", note: "Raw AAC (ADTS)", ffmpeg: { inputs: "a", args: [...AAC, "-f", "adts"] } },
  { file: "audio/m4a_aac.m4a", expected: "direct", note: "M4A AAC", ffmpeg: { inputs: "a", args: [...AAC] } },
  { file: "audio/m4a_alac.m4a", expected: "transcode-audio", note: "M4A Apple Lossless", ffmpeg: { inputs: "a", args: ["-c:a", "alac"] } },
  { file: "audio/wav_pcm.wav", expected: "direct", note: "PCM WAV", ffmpeg: { inputs: "a", args: ["-c:a", "pcm_s16le"] } },
  { file: "audio/wav_adpcm.wav", expected: "transcode-audio", note: "ADPCM WAV", ffmpeg: { inputs: "a", args: ["-c:a", "adpcm_ms"] } },
  { file: "audio/wav_g711.wav", expected: "transcode-audio", note: "G.711 mu-law WAV (phone/CCTV audio)", ffmpeg: { inputs: "a", args: ["-c:a", "pcm_mulaw", "-ar", "8000", "-ac", "1"] } },
  { file: "audio/opus.opus", expected: "direct", note: "Opus", ffmpeg: { inputs: "a", args: ["-c:a", "libopus"] } },
  { file: "audio/ogg_vorbis.ogg", expected: "direct", note: "Ogg Vorbis", ffmpeg: { inputs: "a", args: ["-c:a", "libvorbis"] } },
  { file: "audio/oga_opus.oga", expected: "direct", note: "Ogg Opus with .oga extension", ffmpeg: { inputs: "a", args: ["-c:a", "libopus", "-f", "ogg"] } },
  { file: "audio/wma.wma", expected: "transcode-audio", note: "Windows Media Audio", ffmpeg: { inputs: "a", args: ["-c:a", "wmav2", "-f", "asf"] } },
  { file: "audio/flac.flac", expected: "direct", note: "FLAC", ffmpeg: { inputs: "a", args: ["-c:a", "flac"] } },

  // Not media, blocked, or unreadable
  { file: "other/export.g64x", expected: "unsupported", note: "Genetec export (blocked)", content: pseudoRandomBytes(4096, 1) },
  { file: "other/project.prproj", expected: "unsupported", note: "Premiere project (blocked)", content: '<?xml version="1.0"?><PremiereData Version="3"></PremiereData>\n' },
  { file: "other/peaks.pkf", expected: "unsupported", note: "Audition peak file (blocked)", content: pseudoRandomBytes(1024, 2) },
  { file: "other/driver.sys", expected: "unsupported", note: "System file (blocked)", content: pseudoRandomBytes(1024, 3) },
  { file: "other/notes.txt", expected: "unsupported", note: "Extension not on the allowed list", content: "not media\n" },
  { file: "other/corrupt.mp4", expected: "unsupported", note: "Allowed extension but unreadable content", content: pseudoRandomBytes(8192, 4) },
];

export interface GenerateOptions {
  /** Seconds of media per file. */
  duration?: number;
  /** Regenerate files that already exist. */
  force?: boolean;
  concurrency?: number;
  ffmpegPath?: string;
  onProgress?: (spec: SampleSpec, status: "created" | "skipped" | "failed", error?: string) => void;
}

export interface GenerateResult {
  created: string[];
  skipped: string[];
  failed: { file: string; error: string }[];
}

export async function generateSamples(outDir: string, opts: GenerateOptions = {}): Promise<GenerateResult> {
  const duration = opts.duration ?? 10;
  const result: GenerateResult = { created: [], skipped: [], failed: [] };
  const queue = [...SAMPLES];

  const worker = async () => {
    for (let spec = queue.shift(); spec; spec = queue.shift()) {
      const target = join(outDir, spec.file);
      if (!opts.force && (await exists(target))) {
        result.skipped.push(spec.file);
        opts.onProgress?.(spec, "skipped");
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      try {
        if (spec.content !== undefined) {
          await writeFile(target, spec.content);
        } else if (spec.ffmpeg) {
          await runFfmpeg(buildArgs(spec.ffmpeg, duration, target), opts.ffmpegPath);
        }
        result.created.push(spec.file);
        opts.onProgress?.(spec, "created");
      } catch (err) {
        const error = (err as Error).message;
        result.failed.push({ file: spec.file, error });
        opts.onProgress?.(spec, "failed", error);
      }
    }
  };

  await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, worker));

  const manifest = SAMPLES.map(({ file, expected, note }) => ({ file, expected, note }));
  await writeFile(join(outDir, "manifest.json"), JSON.stringify({ samples: manifest, notGenerated: NOT_GENERATED }, null, 2));
  return result;
}

function buildArgs(f: NonNullable<SampleSpec["ffmpeg"]>, duration: number, target: string): string[] {
  const video = ["-f", "lavfi", "-i", `testsrc2=size=640x360:rate=25:duration=${duration}`];
  const audio = ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${duration}`];
  const cover = ["-f", "lavfi", "-i", "color=c=steelblue:size=300x300:duration=1"];
  let inputs: string[];
  let maps: string[];
  switch (f.inputs) {
    case "av":
      inputs = [...video, ...audio];
      maps = ["-map", "0:v", "-map", "1:a"];
      break;
    case "v":
      inputs = video;
      maps = ["-map", "0:v"];
      break;
    case "a":
      inputs = audio;
      maps = ["-map", "0:a"];
      break;
    case "a+cover":
      inputs = [...audio, ...cover];
      maps = ["-map", "0:a", "-map", "1:v", "-frames:v", "1"];
      break;
  }
  return ["-hide_banner", "-loglevel", "error", "-y", ...inputs, ...maps, ...f.args, target];
}

async function runFfmpeg(args: string[], ffmpegPath = "ffmpeg"): Promise<void> {
  const proc = Bun.spawn([ffmpegPath, ...args], { stdout: "ignore", stderr: "pipe", stdin: "ignore" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(stderr.trim().split("\n").slice(-3).join(" | ") || `ffmpeg exited with code ${code}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Deterministic bytes, so corrupt sample files are the same on every run. */
function pseudoRandomBytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed * 2654435761;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}
