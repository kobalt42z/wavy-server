#!/usr/bin/env bun
/**
 * Generates short test files for every format in the inventory that FFmpeg can write.
 *
 *   bun scripts/generate-samples.ts [outDir] [--force] [--duration 10]
 *
 * Default outDir is ./samples. Existing files are kept unless --force is given.
 */
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { generateSamples, NOT_GENERATED } from "./samples.ts";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    force: { type: "boolean", default: false },
    duration: { type: "string", default: "10" },
    concurrency: { type: "string", default: "4" },
  },
});

const outDir = resolve(positionals[0] ?? "samples");
const duration = Number(values.duration);
if (!Number.isFinite(duration) || duration <= 0) {
  console.error("--duration must be a positive number of seconds");
  process.exit(2);
}

console.error(`Writing samples to ${outDir}`);
const result = await generateSamples(outDir, {
  duration,
  force: values.force,
  concurrency: Number(values.concurrency) || 4,
  onProgress: (spec, status, error) => {
    const mark = status === "created" ? "+" : status === "skipped" ? "=" : "!";
    console.error(`${mark} ${spec.file}${error ? `  (${error})` : ""}`);
  },
});

console.error(
  `\n${result.created.length} created, ${result.skipped.length} already there, ${result.failed.length} failed.`,
);
for (const n of NOT_GENERATED) console.error(`Not generated: .${n.ext} - ${n.note}`);
process.exit(result.failed.length > 0 ? 1 : 0);
