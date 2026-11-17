import { describe, expect, test } from "bun:test";
import { BlockPeaks, buildPeaksArgs, resamplePeaks } from "../src/peaks.ts";
import type { ProbeResult } from "../src/probe.ts";

const pcm = (samples: number[]) => {
  const buf = new Uint8Array(samples.length * 2);
  const view = new DataView(buf.buffer);
  samples.forEach((s, i) => view.setInt16(i * 2, s, true));
  return buf;
};

describe("BlockPeaks", () => {
  test("keeps the loudest sample per 100-sample block, positive or negative", () => {
    const acc = new BlockPeaks();
    const samples = new Array(250).fill(0);
    samples[10] = 16384;
    samples[150] = -32768;
    samples[249] = 3277;
    acc.push(pcm(samples));
    const blocks = acc.finish();
    expect(blocks.length).toBe(3);
    expect(blocks[0]).toBeCloseTo(0.5, 3);
    expect(blocks[1]).toBe(1);
    expect(blocks[2]).toBeCloseTo(0.1, 3);
    expect(acc.samples).toBe(250);
  });

  test("handles chunks that split a sample", () => {
    const whole = new BlockPeaks();
    const split = new BlockPeaks();
    const data = pcm(Array.from({ length: 333 }, (_, i) => Math.round(Math.sin(i / 7) * 20000)));
    whole.push(data);
    for (let i = 0; i < data.length; i += 7) split.push(data.subarray(i, i + 7));
    expect(split.finish()).toEqual(whole.finish());
    expect(split.samples).toBe(333);
  });
});

describe("resamplePeaks", () => {
  test("takes the max of each slice and rounds to 3 decimals", () => {
    expect(resamplePeaks([0.1, 0.5, 0.2, 0.9, 0.3, 0.12345], 3)).toEqual([0.5, 0.9, 0.3]);
  });
  test("stretches fewer values than slices", () => {
    expect(resamplePeaks([0.2, 0.8], 4)).toEqual([0.2, 0.2, 0.8, 0.8]);
  });
  test("returns zeros for silence or nothing", () => {
    expect(resamplePeaks([], 3)).toEqual([0, 0, 0]);
  });
});

test("buildPeaksArgs maps the chosen audio stream and decodes mono PCM", () => {
  const probe: ProbeResult = {
    container: "mov",
    video: [{ index: 0, codec: "h264" }],
    audio: [
      { index: 1, codec: "aac" },
      { index: 2, codec: "aac" },
    ],
    subtitles: [],
    inputArgs: ["-f", "mpeg"],
  };
  const args = buildPeaksArgs({ input: "/m/a.mov", probe, audioTrack: 1 });
  expect(args.join(" ")).toContain("-f mpeg -i /m/a.mov -map 0:2 -vn");
  expect(args.join(" ")).toContain("-ac 1 -ar 4000 -f s16le");
  expect(() => buildPeaksArgs({ input: "x", probe, audioTrack: 5 })).toThrow();
});

test("GET /api/peaks answers 503 busy with Retry-After when decoding is off", async () => {
  const { samplesDir, startServer } = await import("./helpers/server.ts");
  const srv = await startServer(await samplesDir(), { peaksConcurrency: 0 });
  try {
    const res = await fetch(`${srv.base}/api/peaks?path=audio/mp3.mp3`);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(await res.json()).toMatchObject({ error: "busy" });
  } finally {
    await srv.close();
  }
}, 180_000);
