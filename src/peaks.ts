import type { ProbeResult } from "./probe.ts";

/** Sample rate the audio is decoded at for peaks. Enough for a waveform, cheap to decode. */
export const PEAKS_SAMPLE_RATE = 4000;
/** Samples per block: the resolution kept in memory before resampling to the asked count. */
const BLOCK = 100; // 25 ms at 4 kHz

export interface PeaksOptions {
  ffmpegPath: string;
  /** Path or URL given to FFmpeg's -i. */
  input: string;
  probe: ProbeResult;
  /** Index in `probe.audio` (the API's audioTrack). */
  audioTrack: number;
  count: number;
  /** Input options put before the file's own (remote protocol options). */
  inputProtocolArgs?: string[];
  timeoutMs: number;
}

export interface PeaksResult {
  /** Seconds of audio that were decoded. */
  duration: number;
  /** `count` values from 0 to 1: the loudest sample in each slice, as a fraction of full scale. */
  peaks: number[];
}

/** FFmpeg arguments that decode one audio stream to mono 16-bit PCM on stdout. */
export function buildPeaksArgs(o: Pick<PeaksOptions, "input" | "probe" | "audioTrack" | "inputProtocolArgs">): string[] {
  const stream = o.probe.audio[o.audioTrack];
  if (!stream) throw new Error(`no audio track ${o.audioTrack}`);
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    ...(o.inputProtocolArgs ?? []),
    ...o.probe.inputArgs,
    "-i",
    o.input,
    "-map",
    `0:${stream.index}`,
    "-vn",
    "-sn",
    "-dn",
    "-ac",
    "1",
    "-ar",
    String(PEAKS_SAMPLE_RATE),
    "-f",
    "s16le",
    "-acodec",
    "pcm_s16le",
    "pipe:1",
  ];
}

/**
 * Keeps the loudest sample of every BLOCK samples of a stream of little-endian
 * 16-bit PCM chunks. Chunks may split a sample or a block anywhere.
 */
export class BlockPeaks {
  readonly blocks: number[] = [];
  private current = 0;
  private inBlock = 0;
  private carry: number | null = null;
  samples = 0;

  push(chunk: Uint8Array): void {
    let i = 0;
    if (this.carry !== null && chunk.length > 0) {
      this.add(((chunk[0]! << 8) | this.carry) << 16 >> 16);
      this.carry = null;
      i = 1;
    }
    for (; i + 1 < chunk.length; i += 2) this.add(((chunk[i + 1]! << 8) | chunk[i]!) << 16 >> 16);
    if (i < chunk.length) this.carry = chunk[i]!;
  }

  finish(): number[] {
    if (this.inBlock > 0) this.blocks.push(this.current);
    this.inBlock = 0;
    this.current = 0;
    return this.blocks;
  }

  private add(sample: number): void {
    const v = sample < 0 ? -sample / 32768 : sample / 32767;
    if (v > this.current) this.current = v;
    this.samples++;
    if (++this.inBlock === BLOCK) {
      this.blocks.push(this.current);
      this.current = 0;
      this.inBlock = 0;
    }
  }
}

/** Splits `values` into `count` equal slices and keeps the largest value of each. */
export function resamplePeaks(values: number[], count: number): number[] {
  const out = new Array<number>(count).fill(0);
  if (values.length === 0) return out;
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i * values.length) / count);
    const to = Math.max(from + 1, Math.floor(((i + 1) * values.length) / count));
    let max = 0;
    for (let j = from; j < to && j < values.length; j++) if (values[j]! > max) max = values[j]!;
    out[i] = Math.round(max * 1000) / 1000;
  }
  return out;
}

/** Decodes the audio with FFmpeg and returns `count` peaks. Rejects on FFmpeg failure or timeout. */
export async function computePeaks(o: PeaksOptions): Promise<PeaksResult> {
  const proc = Bun.spawn([o.ffmpegPath, ...buildPeaksArgs(o)], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, o.timeoutMs);
  const stderr = new Response(proc.stderr).text();
  const acc = new BlockPeaks();
  try {
    for await (const chunk of proc.stdout) acc.push(chunk);
    const code = await proc.exited;
    if (timedOut) throw new Error(`decoding took longer than ${Math.round(o.timeoutMs / 1000)} s`);
    if (code !== 0) {
      const lines = (await stderr.catch(() => "")).trim().split("\n").slice(-2).join(" | ");
      throw new Error(lines || `ffmpeg exited with code ${code}`);
    }
  } finally {
    clearTimeout(timer);
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }
  const blocks = acc.finish();
  return { duration: acc.samples / PEAKS_SAMPLE_RATE, peaks: resamplePeaks(blocks, o.count) };
}
