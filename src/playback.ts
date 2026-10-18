import { checkExtension, decide, unsupported, type Decision } from "./decide.ts";
import { ApiError, badRequest } from "./http/errors.ts";
import { log } from "./log.ts";
import type { MediaFile } from "./media-path.ts";
import type { Metrics } from "./metrics.ts";
import { extensionOf } from "./paths.ts";
import { probeFile, type ProbeResult } from "./probe.ts";
import type { PlaybackRules } from "./rules.ts";

export interface Analysis {
  extension: string;
  probe?: ProbeResult;
  decision: Decision;
}

export interface ProbeResponse {
  path: string;
  mode: Decision["mode"];
  reason: string;
  duration: number | null;
  container: string | null;
  size: number;
  video: { codec: string; width: number | null; height: number | null; fps: number | null; pixFmt: string | null } | null;
  /** Audio tracks; the position in this list is the `audioTrack` for POST /api/sessions. */
  audio: { track: number; codec: string; channels: number | null; lang: string | null }[];
  subtitles: { codec: string; lang: string | null }[];
  /** What happens to each stream: copy, encode or none. */
  plan: { video: string; audio: string };
}

/**
 * Probes files and applies the decision table. Results are cached by path, size and
 * modification time, so a probe followed by a session start runs ffprobe once.
 */
export class PlaybackAnalyzer {
  private readonly cache = new Map<string, Analysis>();

  constructor(
    private readonly rules: PlaybackRules,
    private readonly metrics: Metrics,
    private readonly ffprobePath: string,
    private readonly cacheSize = 1000,
  ) {}

  /** Extension as a metrics label: known extensions as-is, anything else as "other". */
  label(extension: string): string {
    return this.rules.allowedExtensions.includes(extension) || extension in this.rules.blockedExtensions
      ? extension
      : "other";
  }

  async analyze(file: MediaFile): Promise<Analysis> {
    const key = `${file.absPath}\0${file.size}\0${file.mtimeMs}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit); // most recently used goes last
      return hit;
    }

    const extension = extensionOf(file.relPath);
    let analysis: Analysis;
    const extReason = checkExtension(extension, this.rules);
    if (extReason) {
      analysis = { extension, decision: unsupported(extReason) };
    } else {
      const stopTimer = this.metrics.probeDuration.startTimer();
      const outcome = await probeFile(file.absPath, this.rules, { ffprobePath: this.ffprobePath });
      stopTimer();
      analysis = outcome.ok
        ? { extension, probe: outcome.probe, decision: decide(outcome.probe, extension, this.rules) }
        : { extension, decision: unsupported(`FFmpeg cannot read this file (${outcome.error}).`) };
    }

    this.metrics.probeResults.inc({ mode: analysis.decision.mode, extension: this.label(extension) });
    if (analysis.decision.mode === "unsupported") {
      // Logged with the probe result so we learn which formats to add.
      log("warn", "unsupported_file", { path: file.relPath, reason: analysis.decision.reason, probe: analysis.probe });
    }

    this.cache.set(key, analysis);
    if (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value!);
    return analysis;
  }

  /**
   * Decision for a session. Picking an audio track other than the first one moves
   * that track to the front and rules out direct play (the browser can't pick it).
   */
  decideForSession(analysis: Analysis, audioTrack: number | undefined): { decision: Decision; probe?: ProbeResult } {
    const { probe } = analysis;
    if (!probe || audioTrack === undefined || audioTrack === 0) return { decision: analysis.decision, probe };
    const track = probe.audio[audioTrack];
    if (!track) throw badRequest(`The file has no audio track ${audioTrack} (it has ${probe.audio.length}).`);
    const reordered: ProbeResult = { ...probe, audio: [track, ...probe.audio.filter((a) => a !== track)] };
    return { decision: decide(reordered, analysis.extension, this.rules, { allowDirect: false }), probe: reordered };
  }

  toResponse(file: MediaFile, a: Analysis): ProbeResponse {
    const v = a.probe?.video[0];
    return {
      path: file.relPath,
      mode: a.decision.mode,
      reason: a.decision.reason,
      duration: a.probe?.duration ?? null,
      container: a.probe?.container ?? null,
      size: file.size,
      video: v
        ? { codec: v.codec, width: v.width ?? null, height: v.height ?? null, fps: v.fps ?? null, pixFmt: v.pixFmt ?? null }
        : null,
      audio: (a.probe?.audio ?? []).map((s, track) => ({
        track,
        codec: s.codec,
        channels: s.channels ?? null,
        lang: s.lang ?? null,
      })),
      subtitles: (a.probe?.subtitles ?? []).map((s) => ({ codec: s.codec, lang: s.lang ?? null })),
      plan: { video: a.decision.video.action, audio: a.decision.audio.action },
    };
  }
}

export function unsupportedError(reason: string): ApiError {
  return new ApiError(422, "unsupported", reason);
}
