import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CA_FILE, type RemoteConfig } from "./remote.ts";

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
  /**
   * Other spellings of the share root that clients may put in front of a path
   * (`\\fileserver\media\`, `smb://fileserver/media/`, `/mnt/media/`). Stripped before
   * the path is checked, in requests and in token paths alike.
   */
  mediaPathPrefixes: string[];
  auth: AuthConfig;
  /** Playing tokens whose path is an http(s) URL. Off while allowedHosts is empty. */
  remote: RemoteConfig;
}

/** Algorithms a token may be signed with. Asymmetric only: wavy holds no signing key. */
export const TOKEN_ALGORITHMS = ["EdDSA", "Ed25519", "ES256", "ES384", "ES512", "RS256", "PS256"] as const;

/**
 * Playback grants signed by the main server. See README "Access tokens".
 * mode "none" leaves the API open (development); "jwt" requires a token to start playback.
 */
export interface AuthConfig {
  mode: "none" | "jwt";
  /** URL of the main server's public keys (JWKS). Fetched and cached. */
  jwksUrl?: string;
  /** Public keys as a JWKS JSON document ({"keys":[...]}), from JWT_JWKS or JWT_JWKS_FILE. */
  jwks?: string;
  /** Accepted "alg" values; anything else is rejected before the signature is checked. */
  algorithms: string[];
  issuer: string;
  audience: string;
  /** Allowed clock difference with the main server when checking exp/nbf/iat. */
  clockToleranceSec: number;
  /** Tokens older than this (by iat) are rejected, whatever their exp says. */
  maxTokenAgeSec: number;
  /** With jwksUrl: the minimum time between two fetches (an unknown kid triggers one). */
  jwksCooldownSec: number;
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

  const list = (raw: string | undefined) => (raw ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  const bool = (name: string, def: boolean): boolean => {
    const raw = env[name];
    if (raw === undefined || raw === "") return def;
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
    throw new Error(`${name} must be true or false (got "${raw}")`);
  };
  for (const h of list(env.REMOTE_ALLOWED_HOSTS)) {
    if (!/^(\*\.)?[a-z0-9.-]+(:\d+)?$/i.test(h) || h === "*.") throw new Error(`REMOTE_ALLOWED_HOSTS: "${h}" is not a host, host:port or *.suffix`);
  }

  const authMode = str("AUTH_MODE", "none");
  if (authMode !== "none" && authMode !== "jwt") throw new Error(`AUTH_MODE must be "none" or "jwt" (got "${authMode}")`);
  const algorithms = str("JWT_ALGORITHMS", "EdDSA").split(",").map((a) => a.trim()).filter(Boolean);
  for (const a of algorithms) {
    if (!(TOKEN_ALGORITHMS as readonly string[]).includes(a)) {
      throw new Error(`JWT_ALGORITHMS: "${a}" is not allowed (use ${TOKEN_ALGORITHMS.join(", ")})`);
    }
  }
  let jwks = env.JWT_JWKS || undefined;
  if (!jwks && env.JWT_JWKS_FILE) jwks = readFileSync(env.JWT_JWKS_FILE, "utf8");
  const jwksUrl = env.JWT_JWKS_URL || undefined;
  if (authMode === "jwt" && !jwks && !jwksUrl) {
    throw new Error("AUTH_MODE=jwt needs the main server's public keys: set JWT_JWKS_FILE, JWT_JWKS or JWT_JWKS_URL");
  }
  if (jwksUrl && !/^https?:\/\//.test(jwksUrl)) throw new Error(`JWT_JWKS_URL must be an http(s) URL (got "${jwksUrl}")`);

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
    mediaPathPrefixes: list(env.MEDIA_PATH_PREFIXES),
    remote: {
      allowedHosts: list(env.REMOTE_ALLOWED_HOSTS),
      allowHttp: bool("REMOTE_ALLOW_HTTP", false),
      timeoutMs: int("REMOTE_TIMEOUT_MS", 15_000, 1),
      caFile: str("REMOTE_CA_FILE", DEFAULT_CA_FILE),
      customCa: Boolean(env.REMOTE_CA_FILE),
    },
    auth: {
      mode: authMode,
      jwks,
      jwksUrl,
      algorithms,
      issuer: str("JWT_ISSUER", "main"),
      audience: str("JWT_AUDIENCE", "wavy"),
      clockToleranceSec: int("JWT_CLOCK_TOLERANCE_SEC", 60, 0),
      maxTokenAgeSec: int("JWT_MAX_TOKEN_AGE_SEC", 900, 1),
      jwksCooldownSec: int("JWT_JWKS_COOLDOWN_SEC", 30, 0),
    },
  };
}
