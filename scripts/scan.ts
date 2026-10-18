#!/usr/bin/env bun
/**
 * Probes every file under a folder and writes a CSV with its codecs and the playback
 * mode the decision table picks. Use it on the real share to see the remux/transcode mix.
 *
 *   bun scripts/scan.ts <folder> [--out inventory.csv] [--concurrency 8] [--rules path.json]
 *
 * Without --out the CSV goes to stdout. A summary by mode and extension goes to stderr.
 */
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { loadRules } from "../src/rules.ts";
import { scanFolder, toCsv, summarize } from "../src/scan.ts";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    out: { type: "string" },
    concurrency: { type: "string", default: "8" },
    rules: { type: "string" },
  },
});

const folder = positionals[0];
if (!folder) {
  console.error("Usage: bun scripts/scan.ts <folder> [--out inventory.csv] [--concurrency 8] [--rules path.json]");
  process.exit(2);
}

const rules = loadRules(values.rules);
const root = resolve(folder);
let done = 0;
const rows = await scanFolder(root, rules, {
  concurrency: Number(values.concurrency) || 8,
  onFile: () => {
    done++;
    if (process.stderr.isTTY && done % 25 === 0) process.stderr.write(`\r${done} files probed`);
  },
});
if (process.stderr.isTTY) process.stderr.write("\r");

const csv = toCsv(rows);
if (values.out) {
  await writeFile(values.out, csv);
  console.error(`Wrote ${rows.length} rows to ${values.out}`);
} else {
  process.stdout.write(csv);
}
console.error(summarize(rows));
