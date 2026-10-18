import { tmpdir } from "node:os";
import { join } from "node:path";

/** Runtime settings, read from environment variables. See README "Configuration". */
export interface Config {
  port: number;
  /** Read-only media share. Every API path is relative to this folder. */
  mediaRoot: string;
  /** Each session writes its HLS segments to a subfolder here. */
  sessionsDir: string;
  ffmpegPath: string;
  ffprobePath: string;
  /** Concurrent full transcodes per pod. More get 503 with Retry-After. */
  maxTranscodes: number;
  /** Concurrent HLS sessions of any mode per pod. */
  maxSessions: number;
  /** A session with no playlist or segment request for this long is stopped. */
  idleTimeoutMs: number;
  /** Hard limit on a session's lifetime. */
  maxSessionAgeMs: number;
  /** How often idle sessions are looked for. */
  reapIntervalMs: number;
  /** How long a playlist request waits for FFmpeg's first segment. */
  playlistWaitMs: number;
  /** Seconds of media per HLS segment. */
  hlsTime: number;
  segmentType: "fmp4" | "mpegts";
  /** libx264 preset for full transcodes. */
  x264Preset: string;
  x264Crf: number;
  audioBitrate: string;
  /** Seconds sent in Retry-After when the pod is full. */
  retryAfterSec: number;
  /** Optional path to the playback rules JSON (defaults to config/playback-rules.json). */
  rulesPath?: string;
  /** Origins allowed to call the API from a browser ("*" or a comma-separated list). */
  corsOrigins: string[];
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const int = (name: string, def: number, min = 0): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min} (got "${raw}")`);
    return n;
  };
  const str = (name: string, def: string): string => (env[name] === undefined || env[name] === "" ? def : env[name]!);

  const segmentType = str("HLS_SEGMENT_TYPE", "fmp4");
  if (segmentType !== "fmp4" && segmentType !== "mpegts") {
    throw new Error(`HLS_SEGMENT_TYPE must be "fmp4" or "mpegts" (got "${segmentType}")`);
  }

  return {
    port: int("PORT", 8080, 0),
    mediaRoot: str("MEDIA_ROOT", "/media"),
    sessionsDir: str("SESSIONS_DIR", join(tmpdir(), "sessions")),
    ffmpegPath: str("FFMPEG_PATH", "ffmpeg"),
    ffprobePath: str("FFPROBE_PATH", "ffprobe"),
    maxTranscodes: int("MAX_TRANSCODES", 4, 0),
    maxSessions: int("MAX_SESSIONS", 50, 1),
    idleTimeoutMs: int("SESSION_IDLE_TIMEOUT_MS", 60_000, 1),
    maxSessionAgeMs: int("SESSION_MAX_AGE_MS", 4 * 60 * 60_000, 1),
    reapIntervalMs: int("SESSION_REAP_INTERVAL_MS", 5_000, 1),
    playlistWaitMs: int("PLAYLIST_WAIT_MS", 15_000, 0),
    hlsTime: int("HLS_TIME", 4, 1),
    segmentType,
    x264Preset: str("X264_PRESET", "veryfast"),
    x264Crf: int("X264_CRF", 23, 0),
    audioBitrate: str("AUDIO_BITRATE", "160k"),
    retryAfterSec: int("RETRY_AFTER_SEC", 5, 1),
    rulesPath: env.PLAYBACK_RULES || undefined,
    corsOrigins: str("CORS_ORIGINS", "*").split(",").map((o) => o.trim()).filter(Boolean),
  };
}
