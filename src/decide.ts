import type { PlaybackRules } from "./rules.ts";
import type { AudioStream, ProbeResult, VideoStream } from "./probe.ts";

/**
 * How a file is played, cheapest first:
 * - direct: Chrome plays the original file as-is (HTTP Range).
 * - remux: codecs are fine, only the container changes (copy into HLS).
 * - transcode-audio: video is copied (or there is none), audio is re-encoded to AAC.
 * - transcode: video is re-encoded to H.264.
 * - unsupported: not media, not allowed, or FFmpeg can't read it.
 */
export type PlaybackMode = "direct" | "remux" | "transcode-audio" | "transcode" | "unsupported";

export type StreamAction = "copy" | "encode" | "none";

export interface StreamPlan {
  action: StreamAction;
  /** Source stream index in the input file. */
  index?: number;
  codec?: string;
  /** Why the stream must be re-encoded, when action is "encode". */
  reason?: string;
}

export interface Decision {
  mode: PlaybackMode;
  /** One line explaining the choice. For unsupported files this is shown to the user. */
  reason: string;
  video: StreamPlan;
  audio: StreamPlan;
  /** Name of the direct rule that matched, when mode is "direct". */
  directRule?: string;
  /** Scale video down to this height when re-encoding (never up). */
  maxOutputHeight?: number;
}

const NONE: StreamPlan = { action: "none" };

/** Returns a reason when the extension alone rules the file out, otherwise null. */
export function checkExtension(ext: string, rules: PlaybackRules): string | null {
  const blocked = rules.blockedExtensions[ext];
  if (blocked) return blocked;
  if (!rules.allowedExtensions.includes(ext)) {
    return ext ? `.${ext} files are not on the list of allowed formats.` : "Files without an extension are not allowed.";
  }
  return null;
}

export function unsupported(reason: string): Decision {
  return { mode: "unsupported", reason, video: NONE, audio: NONE };
}

/** Picks the cheapest playback mode for a probed file. Video and audio are decided independently. */
export function decide(
  probe: ProbeResult,
  ext: string,
  rules: PlaybackRules,
  opts: { allowDirect?: boolean } = {},
): Decision {
  const extReason = checkExtension(ext, rules);
  if (extReason) return unsupported(extReason);

  const v = probe.video[0];
  const a = probe.audio[0];
  if (!v && !a) return unsupported("The file has no audio or video stream.");

  // allowDirect: false forces HLS, e.g. when the viewer picks a non-default audio track.
  const direct = opts.allowDirect === false ? null : matchDirect(probe, ext, v, a, rules);
  if (direct) {
    return {
      mode: "direct",
      reason: `Chrome plays ${describe(v, a)} in ${direct} natively.`,
      video: v ? { action: "copy", index: v.index, codec: v.codec } : NONE,
      audio: a ? { action: "copy", index: a.index, codec: a.codec } : NONE,
      directRule: direct,
    };
  }

  const video = v ? planVideo(v, rules) : NONE;
  const audio = a ? planAudio(a, rules) : NONE;

  if (video.action === "encode") {
    return {
      mode: "transcode",
      reason: `Video: ${video.reason}.` + (audio.action === "encode" ? ` Audio: ${audio.reason}.` : ""),
      video,
      audio,
      maxOutputHeight: rules.transcode.maxHeight,
    };
  }
  if (audio.action === "encode") {
    return {
      mode: "transcode-audio",
      reason: `Audio: ${audio.reason}.` + (v ? ` ${v.codec} video is copied.` : ""),
      video,
      audio,
    };
  }
  return {
    mode: "remux",
    reason: `${describe(v, a)} can be copied; only the container (${probe.container}) changes.`,
    video,
    audio,
  };
}

function videoCodecsFor(list: string[] | undefined, rules: PlaybackRules): string[] {
  const codecs = list ?? [];
  return rules.allowHevcPassthrough && codecs.includes("h264") ? [...codecs, "hevc"] : codecs;
}

function matchDirect(
  probe: ProbeResult,
  ext: string,
  v: VideoStream | undefined,
  a: AudioStream | undefined,
  rules: PlaybackRules,
): string | null {
  // Files that need forced input options (raw streams) never play as-is.
  if (probe.inputArgs.length > 0) return null;
  const containerTokens = probe.container.split(",");
  for (const rule of rules.direct) {
    if (!rule.formats.some((f) => containerTokens.includes(f))) continue;
    if (rule.extensions && !rule.extensions.includes(ext)) continue;
    if (v) {
      if (!videoCodecsFor(rule.videoCodecs, rules).includes(v.codec)) continue;
      if (v.codec === "h264" && !pixFmtOk(v, rules)) continue;
    }
    if (a && !(rule.audioCodecs ?? []).includes(a.codec)) continue;
    return rule.name;
  }
  return null;
}

function pixFmtOk(v: VideoStream, rules: PlaybackRules): boolean {
  // Unknown pixel format: assume 8-bit 4:2:0, the common case.
  return !v.pixFmt || rules.copy.videoPixelFormats.includes(v.pixFmt);
}

function planVideo(v: VideoStream, rules: PlaybackRules): StreamPlan {
  const base = { index: v.index, codec: v.codec };
  if (!videoCodecsFor(rules.copy.videoCodecs, rules).includes(v.codec)) {
    return { ...base, action: "encode", reason: `${v.codec} is not playable in Chrome` };
  }
  if (v.codec === "h264" && !pixFmtOk(v, rules)) {
    return { ...base, action: "encode", reason: `${v.codec} ${v.pixFmt} (${v.profile ?? "unknown profile"}) is not playable in Chrome` };
  }
  if (v.height && v.height > rules.copy.maxVideoHeight) {
    return { ...base, action: "encode", reason: `${v.height}p is above the ${rules.copy.maxVideoHeight}p copy limit` };
  }
  return { ...base, action: "copy" };
}

function planAudio(a: AudioStream, rules: PlaybackRules): StreamPlan {
  const base = { index: a.index, codec: a.codec };
  if (!rules.copy.audioCodecs.includes(a.codec)) {
    return { ...base, action: "encode", reason: `${a.codec} is converted to AAC` };
  }
  if (a.channels && a.channels > rules.copy.maxAudioChannels) {
    return { ...base, action: "encode", reason: `${a.channels} channels are mixed down to stereo` };
  }
  return { ...base, action: "copy" };
}

function describe(v?: VideoStream, a?: AudioStream): string {
  return [v?.codec, a?.codec].filter(Boolean).join(" + ");
}
