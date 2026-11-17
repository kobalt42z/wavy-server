import { fitPeaks, peaksFromAudioBuffer, placeholderPeaks } from './waveform';

describe('waveform helpers', () => {
  it('fitPeaks keeps the max of each slice and scales the loudest bar to 1', () => {
    expect(fitPeaks([0.1, 0.2, 0.4, 0.1], 2)).toEqual([0.5, 1]);
    expect(fitPeaks([0.5, 0.25], 4)).toEqual([1, 1, 0.5, 0.5]);
    expect(fitPeaks([], 3)).toEqual([0, 0, 0]);
    expect(fitPeaks([0.1], 0)).toEqual([]);
  });

  it('fitPeaks does not boost silence into noise', () => {
    const bars = fitPeaks([0.001, 0.002], 2);
    expect(Math.max(...bars)).toBeLessThan(0.2);
  });

  it('peaksFromAudioBuffer takes the loudest sample of every channel', () => {
    const left = new Float32Array([0, 0.5, -0.2, 0.1]);
    const right = new Float32Array([0, -0.1, 0.9, 0]);
    const buffer = { numberOfChannels: 2, length: 4, getChannelData: (c: number) => (c === 0 ? left : right) };
    const peaks = peaksFromAudioBuffer(buffer, 2);
    expect(peaks[0]).toBeCloseTo(0.5);
    expect(peaks[1]).toBeCloseTo(0.9);
  });

  it('placeholderPeaks gives low, varied bars', () => {
    const p = placeholderPeaks(10);
    expect(p).toHaveLength(10);
    expect(Math.max(...p)).toBeLessThanOrEqual(0.4);
    expect(new Set(p).size).toBeGreaterThan(3);
  });
});
