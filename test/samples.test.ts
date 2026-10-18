/**
 * End-to-end check of the decision table: generate every sample with FFmpeg,
 * probe it, and compare the chosen mode with the one recorded in scripts/samples.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeFile } from "../src/analyze.ts";
import { loadRules } from "../src/rules.ts";
import { scanFolder, toCsv } from "../src/scan.ts";
import { generateSamples, SAMPLES } from "../scripts/samples.ts";

const rules = loadRules();
// Reuse ./samples when SAMPLES_DIR is set, otherwise build a fresh set.
const dir = process.env.SAMPLES_DIR ?? mkdtempSync(join(tmpdir(), "wavy-samples-"));
afterAll(() => {
  if (!process.env.SAMPLES_DIR) rmSync(dir, { recursive: true, force: true });
});

beforeAll(async () => {
  const res = await generateSamples(dir, { duration: 2 });
  expect(res.failed).toEqual([]);
}, 120_000);

describe("generated samples get the expected playback mode", () => {
  for (const spec of SAMPLES) {
    test(`${spec.file} -> ${spec.expected}`, async () => {
      const { decision } = await analyzeFile(join(dir, spec.file), rules);
      expect({ file: spec.file, mode: decision.mode }).toEqual({ file: spec.file, mode: spec.expected });
    });
  }
});

test("raw H.264 is probed with the forced input format", async () => {
  const { probe } = await analyzeFile(join(dir, "cctv/raw_h264.264"), rules);
  expect(probe?.inputArgs).toEqual(["-f", "h264", "-framerate", "25"]);
  expect(probe?.video[0]?.codec).toBe("h264");
});

test("cover art in an MP3 is not treated as video", async () => {
  const { probe, decision } = await analyzeFile(join(dir, "audio/mp3_cover.mp3"), rules);
  expect(probe?.video).toEqual([]);
  expect(decision.video.action).toBe("none");
});

test("transcode-audio copies H.264 video and encodes the audio", async () => {
  const { decision } = await analyzeFile(join(dir, "video/avi_h264_g711.avi"), rules);
  expect(decision.video.action).toBe("copy");
  expect(decision.audio).toMatchObject({ action: "encode", codec: "pcm_alaw" });
});

test("scan writes one CSV row per file", async () => {
  const rows = await scanFolder(dir, rules, { concurrency: 4 });
  const byPath = new Map(rows.map((r) => [r.path, r]));
  for (const spec of SAMPLES) expect(byPath.get(spec.file)?.mode).toBe(spec.expected);
  const csv = toCsv(rows);
  expect(csv.split("\n")[0]).toStartWith("path,extension,sizeBytes,container,videoCodec");
  expect(csv).toContain("video/name with spaces 'quotes' $(id).mp4,mp4,");
}, 60_000);
