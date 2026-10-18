import { checkExtension, decide, unsupported, type Decision } from "./decide.ts";
import { probeFile, type ProbeOptions, type ProbeResult } from "./probe.ts";
import { extensionOf } from "./paths.ts";
import type { PlaybackRules } from "./rules.ts";

export interface Analysis {
  extension: string;
  /** Missing when the extension was rejected or ffprobe failed. */
  probe?: ProbeResult;
  decision: Decision;
}

/** Extension check, then ffprobe, then the decision table. Never throws for bad files. */
export async function analyzeFile(path: string, rules: PlaybackRules, opts: ProbeOptions = {}): Promise<Analysis> {
  const extension = extensionOf(path);
  const extReason = checkExtension(extension, rules);
  if (extReason) return { extension, decision: unsupported(extReason) };

  const outcome = await probeFile(path, rules, opts);
  if (!outcome.ok) {
    return { extension, decision: unsupported(`FFmpeg cannot read this file (${outcome.error}).`) };
  }
  return { extension, probe: outcome.probe, decision: decide(outcome.probe, extension, rules) };
}
