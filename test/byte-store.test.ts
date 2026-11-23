/**
 * The byte-access layer (src/byte-store.ts): FFmpeg reads remote files through it, so
 * it must serve the exact bytes, fetch each block once, share blocks between pods,
 * fill an open file in the background and keep the folder under its limit.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ByteStore, type StoreConfig } from "../src/byte-store.ts";
import { loadConfig } from "../src/config.ts";
import type { MediaFile } from "../src/media-path.ts";

process.env.LOG_LEVEL ??= "silent";

const BLOCK = 64 * 1024;
const SIZE = 10 * BLOCK + 1234; // 11 blocks, the last one short
const data = new Uint8Array(SIZE);
for (let i = 0; i < SIZE; i++) data[i] = (i * 31 + (i >> 8)) & 0xff;

let root: string;
let origin: ReturnType<typeof Bun.serve>;
let hits: string[] = [];
let failing = false;
const remote = { ...loadConfig({}).remote, allowHttp: true, allowedHosts: ["127.0.0.1"] };
const stores: ByteStore[] = [];

const storeCfg = (dir: string, over: Partial<StoreConfig> = {}): StoreConfig => ({
  dir,
  maxBytes: 100 * 1024 ** 2,
  blockBytes: BLOCK,
  readAhead: 2,
  fillConcurrency: 0,
  sweepIntervalMs: 3_600_000,
  ...over,
});
const newStore = async (dir: string, over: Partial<StoreConfig> = {}) => {
  const s = new ByteStore(storeCfg(dir, over), remote);
  await s.init();
  stores.push(s);
  return s;
};
const fileAt = (name: string, signature = "a"): MediaFile => ({
  relPath: `http://127.0.0.1:${origin.port}/${name}`,
  absPath: `http://127.0.0.1:${origin.port}/${name}?X-Amz-Signature=${signature}`,
  realRelPath: name,
  size: SIZE,
  mtimeMs: 0,
  remote: true,
  etag: '"v1"',
});
const get = async (url: string, range?: string) => {
  const res = await fetch(url, range ? { headers: { Range: range } } : {});
  return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()), headers: res.headers };
};
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const until = async (ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await Bun.sleep(20);
  return ok();
};
const blocksIn = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).flatMap((d) => readdirSync(join(dir, d)).filter((f) => /^b\d+$/.test(f))) : [];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "wavy-byte-store-"));
  origin = Bun.serve({
    port: 0,
    fetch: (req) => {
      const range = req.headers.get("range") ?? "";
      hits.push(range);
      if (failing) return new Response("down", { status: 500 });
      const m = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!m) return new Response(data);
      const start = Number(m[1]);
      const end = Math.min(Number(m[2]), SIZE - 1);
      return new Response(data.subarray(start, end + 1), {
        status: 206,
        headers: { "Content-Range": `bytes ${start}-${end}/${SIZE}` },
      });
    },
  });
});

afterAll(() => {
  for (const s of stores) s.stop();
  origin?.stop(true);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("reading through the store", () => {
  test("serves the exact bytes for whole, partial, cross-block and open-ended ranges", async () => {
    const store = await newStore(join(root, "exact"));
    const { url } = store.open(fileAt("a.bin"));
    const whole = await get(url);
    expect(whole.status).toBe(200);
    expect(same(whole.bytes, data)).toBe(true);
    for (const [start, end] of [[0, 0], [5, BLOCK + 9], [BLOCK - 1, BLOCK], [3 * BLOCK, 5 * BLOCK - 1], [SIZE - 10, SIZE - 1]] as const) {
      const part = await get(url, `bytes=${start}-${end}`);
      expect(part.status).toBe(206);
      expect(part.headers.get("content-range")).toBe(`bytes ${start}-${end}/${SIZE}`);
      expect(same(part.bytes, data.subarray(start, end + 1))).toBe(true);
    }
    const open = await get(url, `bytes=${SIZE - 5000}-`);
    expect(same(open.bytes, data.subarray(SIZE - 5000))).toBe(true);
    expect((await get(url, `bytes=${SIZE}-`)).status).toBe(416);
    expect(same(await store.read(fileAt("a.bin"), BLOCK - 3, 2 * BLOCK + 3), data.subarray(BLOCK - 3, 2 * BLOCK + 4))).toBe(true);
  });

  test("each block is fetched once, in whole blocks, however often it's read", async () => {
    const store = await newStore(join(root, "once"));
    const { url } = store.open(fileAt("b.bin"));
    hits = [];
    // A demuxer hopping between two places in the file (non-interleaved audio and video).
    for (let n = 0; n < 20; n++) {
      await get(url, `bytes=${n * 100}-${n * 100 + 99}`);
      await get(url, `bytes=${6 * BLOCK + n * 100}-${6 * BLOCK + n * 100 + 99}`);
    }
    await Bun.sleep(50);
    expect(new Set(hits).size).toBe(hits.length);
    expect(hits.length).toBeLessThanOrEqual(4); // two places, each with one block read ahead
    for (const h of hits) expect(Number(/^bytes=(\d+)-(\d+)$/.exec(h)![1]) % BLOCK).toBe(0);
  });

  test("another pod on the same folder, with a newly signed link, fetches nothing", async () => {
    const dir = join(root, "shared");
    const first = await newStore(dir);
    await get(first.open(fileAt("c.bin", "one")).url);
    hits = [];
    const second = await newStore(dir);
    const again = await get(second.open(fileAt("c.bin", "two")).url);
    expect(same(again.bytes, data)).toBe(true);
    expect(hits).toEqual([]);
  });

  test("an overlay replaces the head and adds a tail, around the stored bytes", async () => {
    const store = await newStore(join(root, "overlay"));
    const head = new Uint8Array(1000).fill(7);
    const tail = new Uint8Array(500).fill(9);
    const { url } = store.open(fileAt("d.bin"), { overlay: { head, tail } });
    const all = await get(url);
    expect(all.bytes.length).toBe(SIZE + 500);
    expect(same(all.bytes.subarray(0, 1000), head)).toBe(true);
    expect(same(all.bytes.subarray(1000, SIZE), data.subarray(1000))).toBe(true);
    expect(same(all.bytes.subarray(SIZE), tail)).toBe(true);
    const edge = await get(url, `bytes=${SIZE - 4}-${SIZE + 3}`);
    expect(same(edge.bytes, new Uint8Array([...data.subarray(SIZE - 4), 9, 9, 9, 9]))).toBe(true);
  });
});

describe("background fill", () => {
  test("an open session's file is fetched whole, then seeks read nothing from the origin", async () => {
    const dir = join(root, "fill");
    const store = await newStore(dir, { fillConcurrency: 3 });
    hits = [];
    const handle = store.open(fileAt("e.bin"), { fill: true });
    expect(await until(() => blocksIn(dir).length === 11)).toBe(true);
    expect(hits.length).toBe(11);
    hits = [];
    expect(same((await get(handle.url, `bytes=${8 * BLOCK}-`)).bytes, data.subarray(8 * BLOCK))).toBe(true);
    expect(hits).toEqual([]);
  });

  test("stops when the session ends", async () => {
    const dir = join(root, "fill-stop");
    const store = await newStore(dir, { fillConcurrency: 1 });
    const handle = store.open(fileAt("f.bin"), { fill: true });
    store.release(handle.id);
    await Bun.sleep(200);
    expect(blocksIn(dir).length).toBeLessThan(11);
  });
});

describe("limits and failures", () => {
  test("over the size limit, the least recently used files go and open ones stay", async () => {
    const dir = join(root, "evict");
    const store = await newStore(dir, { maxBytes: 25 * BLOCK });
    const names = ["g1.bin", "g2.bin", "g3.bin"];
    const handles = [];
    for (const name of names) {
      const h = store.open(fileAt(name));
      await get(h.url);
      handles.push(h);
      await Bun.sleep(30);
    }
    // g1 stays open; g2 is the oldest closed one.
    store.release(handles[1]!.id);
    store.release(handles[2]!.id);
    await store.sweep();
    const left = readdirSync(dir);
    expect(left).toContain(ByteStore.keyOf(fileAt("g1.bin")));
    expect(left).not.toContain(ByteStore.keyOf(fileAt("g2.bin")));
    expect(left).toContain(ByteStore.keyOf(fileAt("g3.bin")));
    // Dropped files are simply fetched again.
    expect(same((await get(store.open(fileAt("g2.bin")).url)).bytes, data)).toBe(true);
  });

  test("a folder that can't be written still plays: blocks are served from the fetch", async () => {
    const notADir = join(root, "blocked");
    writeFileSync(notADir, "x");
    const store = await newStore(notADir);
    const { url } = store.open(fileAt("h.bin"));
    expect(same((await get(url, `bytes=10-${3 * BLOCK}`)).bytes, data.subarray(10, 3 * BLOCK + 1))).toBe(true);
  });

  test("an origin error fails the read instead of serving wrong bytes, and the next read recovers", async () => {
    const store = await newStore(join(root, "errors"));
    const { url } = store.open(fileAt("i.bin"));
    failing = true;
    const broken = await fetch(url, { headers: { Range: `bytes=0-99` } }).then((r) => r.arrayBuffer()).catch(() => null);
    failing = false;
    expect(broken === null || broken.byteLength < 100).toBe(true);
    expect(same((await get(url, "bytes=0-99")).bytes, data.subarray(0, 100))).toBe(true);
  });
});
