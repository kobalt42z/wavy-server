import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { analyzeFile } from "./analyze.ts";
import type { PlaybackRules } from "./rules.ts";

export interface ScanRow {
  path: string;
  extension: string;
  sizeBytes: number | "";
  container: string;
  videoCodec: string;
  resolution: string;
  fps: number | "";
  pixFmt: string;
  audioCodec: string;
  audioChannels: number | "";
  durationSec: number | "";
  mode: string;
  videoAction: string;
  audioAction: string;
  reason: string;
}

const COLUMNS: (keyof ScanRow)[] = [
  "path", "extension", "sizeBytes", "container", "videoCodec", "resolution", "fps", "pixFmt",
  "audioCodec", "audioChannels", "durationSec", "mode", "videoAction", "audioAction", "reason",
];

/** Recursively lists regular files. Symlinks are skipped so a scan can't leave the root or loop. */
export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable folder: skip it rather than abort the whole scan
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) out.push(full);
    }
  };
  await walk(root);
  return out;
}

export async function scanFolder(
  root: string,
  rules: PlaybackRules,
  opts: { concurrency?: number; onFile?: (row: ScanRow) => void } = {},
): Promise<ScanRow[]> {
  const files = await listFiles(root);
  const rows: ScanRow[] = new Array(files.length);
  let next = 0;

  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      const file = files[i]!;
      const row = await scanOne(root, file, rules);
      rows[i] = row;
      opts.onFile?.(row);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 8) }, worker));
  return rows;
}

async function scanOne(root: string, file: string, rules: PlaybackRules): Promise<ScanRow> {
  const { extension, probe, decision } = await analyzeFile(file, rules);
  const v = probe?.video[0];
  const a = probe?.audio[0];
  let size: number | "" = probe?.size ?? "";
  if (size === "") {
    try {
      size = (await stat(file)).size;
    } catch {
      size = "";
    }
  }
  return {
    path: relative(root, file),
    extension,
    sizeBytes: size,
    container: probe?.container ?? "",
    videoCodec: v?.codec ?? "",
    resolution: v?.width && v?.height ? `${v.width}x${v.height}` : "",
    fps: v?.fps ?? "",
    pixFmt: v?.pixFmt ?? "",
    audioCodec: a?.codec ?? "",
    audioChannels: a?.channels ?? "",
    durationSec: probe?.duration !== undefined ? Math.round(probe.duration * 100) / 100 : "",
    mode: decision.mode,
    videoAction: decision.video.action,
    audioAction: decision.audio.action,
    reason: decision.reason,
  };
}

export function toCsv(rows: ScanRow[]): string {
  const lines = [COLUMNS.join(",")];
  for (const row of rows) lines.push(COLUMNS.map((c) => csvCell(row[c])).join(","));
  return lines.join("\n") + "\n";
}

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Human summary: file count and total size per mode, then the extension mix per mode. */
export function summarize(rows: ScanRow[]): string {
  const byMode = new Map<string, { count: number; bytes: number; exts: Map<string, number> }>();
  for (const r of rows) {
    const m = byMode.get(r.mode) ?? { count: 0, bytes: 0, exts: new Map() };
    m.count++;
    m.bytes += typeof r.sizeBytes === "number" ? r.sizeBytes : 0;
    m.exts.set(r.extension || "(none)", (m.exts.get(r.extension || "(none)") ?? 0) + 1);
    byMode.set(r.mode, m);
  }
  const order = ["direct", "remux", "transcode-audio", "transcode", "unsupported"];
  const lines = [`\n${rows.length} files`];
  for (const mode of order) {
    const m = byMode.get(mode);
    if (!m) continue;
    const pct = ((m.count / rows.length) * 100).toFixed(1);
    const exts = [...m.exts.entries()].sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e} ${n}`).join(", ");
    lines.push(`  ${mode.padEnd(16)} ${String(m.count).padStart(6)}  ${pct.padStart(5)}%  ${formatBytes(m.bytes).padStart(9)}  ${exts}`);
  }
  return lines.join("\n");
}

function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
