import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Playback rules: which files are allowed and how each codec is handled.
 * They live in JSON (config/playback-rules.json by default) so formats can be
 * added or rules changed without a code change. See README for each field.
 */
export interface DirectRule {
  /** Label shown in scan output and probe responses. */
  name: string;
  /** ffprobe format_name tokens that match (format_name can be "mov,mp4,m4a,..."). */
  formats: string[];
  /** If set, the file extension must also be one of these. */
  extensions?: string[];
  /** Video codecs Chrome plays natively in this container. Omit for audio-only containers. */
  videoCodecs?: string[];
  /** Audio codecs Chrome plays natively in this container. */
  audioCodecs?: string[];
}

export interface PlaybackRules {
  allowedExtensions: string[];
  /** Extension -> reason shown to the user. */
  blockedExtensions: Record<string, string>;
  /** Extra FFmpeg input options per extension, e.g. raw H.264 needs "-f h264". */
  inputOverrides: Record<string, { args: string[] }>;
  /** Forced input formats to try when auto-detection fails (e.g. "mpeg" for Hikvision). */
  probeFallbackFormats: string[];
  direct: DirectRule[];
  copy: {
    /** Video codecs that can be copied into HLS without re-encoding. */
    videoCodecs: string[];
    videoPixelFormats: string[];
    maxVideoHeight: number;
    /** Audio codecs that can be copied into HLS without re-encoding. */
    audioCodecs: string[];
    maxAudioChannels: number;
  };
  /** Treat HEVC as browser-friendly (only if every PC has a hardware HEVC decoder). */
  allowHevcPassthrough: boolean;
  transcode: {
    maxHeight: number;
  };
}

export const DEFAULT_RULES_PATH = resolve(import.meta.dir, "../config/playback-rules.json");

export function loadRules(path: string = process.env.PLAYBACK_RULES ?? DEFAULT_RULES_PATH): PlaybackRules {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return normalizeRules(raw, path);
}

/** Validates the parsed JSON and lower-cases extensions and codec names. */
export function normalizeRules(raw: unknown, source = "rules"): PlaybackRules {
  const fail = (msg: string): never => {
    throw new Error(`Invalid playback rules (${source}): ${msg}`);
  };
  if (!isObject(raw)) fail("expected a JSON object");
  const r = raw as Record<string, unknown>;

  const strings = (v: unknown, field: string): string[] => {
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) fail(`${field} must be an array of strings`);
    return (v as string[]).map((s) => s.toLowerCase());
  };
  const lower = (v: unknown, field: string): string[] => (v === undefined ? [] : strings(v, field));

  const blocked: Record<string, string> = {};
  if (r.blockedExtensions !== undefined) {
    if (!isObject(r.blockedExtensions)) fail("blockedExtensions must be an object");
    for (const [ext, reason] of Object.entries(r.blockedExtensions as Record<string, unknown>)) {
      if (typeof reason !== "string") fail(`blockedExtensions.${ext} must be a string`);
      blocked[ext.toLowerCase()] = reason as string;
    }
  }

  const overrides: Record<string, { args: string[] }> = {};
  if (r.inputOverrides !== undefined) {
    if (!isObject(r.inputOverrides)) fail("inputOverrides must be an object");
    for (const [ext, o] of Object.entries(r.inputOverrides as Record<string, unknown>)) {
      if (!isObject(o)) fail(`inputOverrides.${ext} must be an object`);
      const args = (o as Record<string, unknown>).args;
      if (!Array.isArray(args) || !args.every((x) => typeof x === "string")) {
        fail(`inputOverrides.${ext}.args must be an array of strings`);
      }
      overrides[ext.toLowerCase()] = { args: args as string[] };
    }
  }

  if (!Array.isArray(r.direct)) fail("direct must be an array");
  const direct = (r.direct as unknown[]).map((d, i): DirectRule => {
    if (!isObject(d)) fail(`direct[${i}] must be an object`);
    const o = d as Record<string, unknown>;
    if (typeof o.name !== "string") fail(`direct[${i}].name must be a string`);
    return {
      name: o.name as string,
      formats: strings(o.formats, `direct[${i}].formats`),
      extensions: o.extensions === undefined ? undefined : strings(o.extensions, `direct[${i}].extensions`),
      videoCodecs: o.videoCodecs === undefined ? undefined : strings(o.videoCodecs, `direct[${i}].videoCodecs`),
      audioCodecs: o.audioCodecs === undefined ? undefined : strings(o.audioCodecs, `direct[${i}].audioCodecs`),
    };
  });

  if (!isObject(r.copy)) fail("copy must be an object");
  const c = r.copy as Record<string, unknown>;
  const num = (v: unknown, field: string): number => {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) fail(`${field} must be a positive number`);
    return v as number;
  };

  if (!isObject(r.transcode)) fail("transcode must be an object");
  const t = r.transcode as Record<string, unknown>;

  return {
    allowedExtensions: strings(r.allowedExtensions, "allowedExtensions"),
    blockedExtensions: blocked,
    inputOverrides: overrides,
    probeFallbackFormats: lower(r.probeFallbackFormats, "probeFallbackFormats"),
    direct,
    copy: {
      videoCodecs: strings(c.videoCodecs, "copy.videoCodecs"),
      videoPixelFormats: strings(c.videoPixelFormats, "copy.videoPixelFormats"),
      maxVideoHeight: num(c.maxVideoHeight, "copy.maxVideoHeight"),
      audioCodecs: strings(c.audioCodecs, "copy.audioCodecs"),
      maxAudioChannels: num(c.maxAudioChannels, "copy.maxAudioChannels"),
    },
    allowHevcPassthrough: r.allowHevcPassthrough === true,
    transcode: { maxHeight: num(t.maxHeight, "transcode.maxHeight") },
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
