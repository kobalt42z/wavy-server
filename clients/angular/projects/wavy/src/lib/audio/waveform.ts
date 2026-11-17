/**
 * Fits `peaks` into `count` bars: each bar is the loudest peak of its slice, scaled so the
 * loudest bar is 1. Quiet recordings still fill the height; silence stays flat.
 */
export function fitPeaks(peaks: readonly number[], count: number): number[] {
  const n = Math.max(0, Math.floor(count));
  if (n === 0) return [];
  if (peaks.length === 0) return new Array<number>(n).fill(0);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * peaks.length) / n);
    const to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / n));
    let max = 0;
    for (let j = from; j < to && j < peaks.length; j++) {
      const v = peaks[j]!;
      if (v > max) max = v;
    }
    out[i] = max;
  }
  // Below this a file is treated as silence, not boosted into noise.
  const loudest = Math.max(0.02, ...out);
  return out.map((v) => Math.min(1, v / loudest));
}

/**
 * Peaks (0 to 1) from decoded audio, e.g. a recording the app holds as a Blob:
 *
 * ```ts
 * const buffer = await new AudioContext().decodeAudioData(await blob.arrayBuffer());
 * peaks = peaksFromAudioBuffer(buffer, 100);
 * ```
 */
export function peaksFromAudioBuffer(buffer: Pick<AudioBuffer, 'numberOfChannels' | 'length' | 'getChannelData'>, count = 100): number[] {
  const out = new Array<number>(count).fill(0);
  if (buffer.length === 0) return out;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < count; i++) {
      const from = Math.floor((i * data.length) / count);
      const to = Math.max(from + 1, Math.floor(((i + 1) * data.length) / count));
      let max = out[i]!;
      for (let j = from; j < to && j < data.length; j++) {
        const v = Math.abs(data[j]!);
        if (v > max) max = v;
      }
      out[i] = Math.min(1, max);
    }
  }
  return out;
}

/** Placeholder bar heights while the real waveform loads (or when there is none). */
export function placeholderPeaks(count: number): number[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => 0.25 + 0.15 * Math.abs(Math.sin(i * 1.7)));
}
