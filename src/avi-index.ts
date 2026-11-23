/**
 * Fast seeking in remote OpenDML AVI files (big camera / DVR recordings on S3).
 *
 * These files split their index into small `ix##` chunks spread through the file,
 * typically one per second. Reading that index means one seek per chunk, which over
 * HTTP is one request per chunk, so remote AVIs are probed with `-use_odml 0`
 * (probe.ts). Without the index, though, FFmpeg seeks by reading the file from the
 * start up to the target: a seek to minute 40 of a 4 GB file downloads ~3 GB.
 *
 * So wavy reads the index itself, once per file: the super index from the header,
 * then every ix chunk with small parallel range requests. It merges them into a few
 * big ix chunks and serves FFmpeg a virtual copy of the file from a loopback server:
 *
 *   [header with the super index rewritten] [the original bytes ...] [merged ix chunks]
 *        from memory                          proxied from S3/cache     from memory
 *
 * FFmpeg then opens the file with its normal OpenDML support: a handful of reads that
 * all hit memory, and every seek jumps straight to the right byte.
 */
import { randomBytes } from "node:crypto";
import { log } from "./log.ts";
import type { MediaFile } from "./media-path.ts";
import { fetchOriginRange, fetchRemote, type RemoteConfig } from "./remote.ts";

export interface AviIndex {
  /** Original file size. */
  size: number;
  /** Bytes [0, head.length) of the virtual file: the original header, super index rewritten. */
  head: Uint8Array;
  /** Bytes [size, size + tail.length) of the virtual file: the merged ix chunks. */
  tail: Uint8Array;
  /** Number of ix chunks read from the original. */
  chunks: number;
}

/** Reads the inclusive byte range [start, end]. */
export type RangeReader = (start: number, end: number) => Promise<Uint8Array>;

const AVI_INDEX_OF_INDEXES = 0;
const AVI_INDEX_OF_CHUNKS = 1;
/** Largest header we read (hdrl with its reserved super index space is usually < 64 KB). */
const MAX_HEADER = 4 * 1024 * 1024;
/** Range requests in flight while reading ix chunks. */
const CONCURRENCY = 96;
/** ix chunks closer than this are read with one request. */
const MERGE_GAP = 64 * 1024;
const MERGE_MAX = 2 * 1024 * 1024;

const fourcc = (b: Uint8Array, o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

interface SuperIndex {
  /** Offset of the indx chunk's data (after its 8-byte header) in the file. */
  at: number;
  /** Capacity in entries. */
  capacity: number;
  chunkId: string;
  entries: { offset: number; size: number; duration: number }[];
}

/** Finds each stream's OpenDML super index in the header. Null when the file has none. */
function parseHeader(head: Uint8Array): { supers: SuperIndex[]; hdrlEnd: number } | null {
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (fourcc(head, 0) !== "RIFF" || fourcc(head, 8) !== "AVI " || fourcc(head, 12) !== "LIST" || fourcc(head, 20) !== "hdrl") return null;
  const hdrlEnd = 20 + v.getUint32(16, true);
  if (hdrlEnd > head.length) return { supers: [], hdrlEnd };
  const supers: SuperIndex[] = [];
  // Walk hdrl's children; each strl list is one stream, in stream order.
  for (let o = 24; o + 8 <= hdrlEnd; ) {
    const id = fourcc(head, o);
    const size = v.getUint32(o + 4, true);
    if (id === "LIST" && fourcc(head, o + 8) === "strl") {
      for (let c = o + 12; c + 8 <= o + 8 + size; ) {
        const cid = fourcc(head, c);
        const csize = v.getUint32(c + 4, true);
        if (cid === "indx" && csize >= 24) {
          const d = c + 8;
          const longs = v.getUint16(d, true);
          const type = head[d + 3];
          const n = v.getUint32(d + 4, true);
          if (longs !== 4 || type !== AVI_INDEX_OF_INDEXES) return null;
          const capacity = Math.floor((csize - 24) / 16);
          if (n > capacity) return null;
          const entries = [];
          for (let i = 0; i < n; i++) {
            const e = d + 24 + i * 16;
            entries.push({ offset: Number(v.getBigUint64(e, true)), size: v.getUint32(e + 8, true), duration: v.getUint32(e + 12, true) });
          }
          supers.push({ at: d, capacity, chunkId: fourcc(head, d + 8), entries });
        }
        c += 8 + csize + (csize & 1);
      }
    }
    o += 8 + size + (size & 1);
  }
  return { supers, hdrlEnd };
}

interface ChunkEntry {
  /** Absolute offset of the chunk's data. */
  pos: number;
  /** Size, with bit 31 set for non-keyframes (as stored). */
  sizeFlags: number;
}

function parseIxChunk(b: Uint8Array): { chunkId: string; entries: ChunkEntry[] } | null {
  if (b.length < 32) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const id = fourcc(b, 0);
  if (!/^(ix\d\d|\d\dix)$/.test(id)) return null;
  const longs = v.getUint16(8, true);
  const type = b[11];
  const n = v.getUint32(12, true);
  if (longs !== 2 || type !== AVI_INDEX_OF_CHUNKS || b.length < 32 + n * 8) return null;
  const base = Number(v.getBigUint64(20, true));
  const entries: ChunkEntry[] = [];
  for (let i = 0; i < n; i++) {
    entries.push({ pos: base + v.getUint32(32 + i * 8, true), sizeFlags: v.getUint32(36 + i * 8, true) });
  }
  return { chunkId: fourcc(b, 16), entries };
}

/** One merged standard index chunk (ix##), base offset = first entry. */
function buildIxChunk(fcc: string, chunkId: string, entries: ChunkEntry[]): Uint8Array {
  const out = new Uint8Array(32 + entries.length * 8);
  const v = new DataView(out.buffer);
  const base = entries[0]!.pos;
  for (let i = 0; i < 4; i++) out[i] = fcc.charCodeAt(i);
  v.setUint32(4, out.length - 8, true);
  v.setUint16(8, 2, true); // wLongsPerEntry
  out[10] = 0; // bIndexSubType
  out[11] = AVI_INDEX_OF_CHUNKS;
  v.setUint32(12, entries.length, true);
  for (let i = 0; i < 4; i++) out[16 + i] = chunkId.charCodeAt(i);
  v.setBigUint64(20, BigInt(base), true);
  entries.forEach((e, i) => {
    v.setUint32(32 + i * 8, e.pos - base, true);
    v.setUint32(36 + i * 8, e.sizeFlags >>> 0, true);
  });
  return out;
}

/** Retries a failed range read twice (one flaky request among thousands shouldn't lose the index). */
function withRetry(read: RangeReader): RangeReader {
  return async (start, end) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await read(start, end);
      } catch (err) {
        if (attempt >= 2) throw err;
        await Bun.sleep(100 * (attempt + 1));
      }
    }
  };
}

/** Runs `fn` over `items` with at most `limit` in flight. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/**
 * Reads an AVI's OpenDML index and builds the virtual file's head and tail.
 * Returns null for files without a usable OpenDML index (FFmpeg then does as before).
 */
export async function buildAviIndex(read: RangeReader, size: number): Promise<AviIndex | null> {
  if (size < 64) return null;
  let head = await read(0, Math.min(size, 64 * 1024) - 1);
  let parsed = parseHeader(head);
  if (!parsed) return null;
  if (parsed.hdrlEnd > head.length) {
    if (parsed.hdrlEnd > MAX_HEADER || parsed.hdrlEnd > size) return null;
    head = await read(0, parsed.hdrlEnd - 1);
    parsed = parseHeader(head);
    if (!parsed) return null;
  }
  head = head.slice(0, parsed.hdrlEnd);
  const { supers } = parsed;
  if (supers.length === 0 || supers.every((s) => s.entries.length === 0)) return null;

  // Every ix chunk, nearby ones read together.
  const wanted = supers.flatMap((s) => s.entries).filter((e) => e.size >= 32 && e.offset + e.size <= size);
  wanted.sort((a, b) => a.offset - b.offset);
  const ranges: { start: number; end: number }[] = [];
  for (const e of wanted) {
    const last = ranges.at(-1);
    const end = e.offset + e.size - 1;
    if (last && e.offset - last.end <= MERGE_GAP && end - last.start < MERGE_MAX) last.end = Math.max(last.end, end);
    else ranges.push({ start: e.offset, end });
  }
  const blocks = await pool(ranges, CONCURRENCY, async (r) => ({ start: r.start, bytes: await read(r.start, r.end) }));
  const bytesAt = (offset: number, length: number): Uint8Array | null => {
    // Blocks are sorted and don't overlap: binary search the one holding `offset`.
    let lo = 0;
    let hi = blocks.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const b = blocks[mid]!;
      if (offset < b.start) hi = mid - 1;
      else if (offset >= b.start + b.bytes.length) lo = mid + 1;
      else return offset + length <= b.start + b.bytes.length ? b.bytes.subarray(offset - b.start, offset - b.start + length) : null;
    }
    return null;
  };

  // Per stream: merge its ix chunks into as few as possible (a chunk's entries are
  // 32-bit offsets from its base, so one merged chunk spans < 4 GB).
  const tailParts: Uint8Array[] = [];
  let tailLen = size & 1; // keep chunks word-aligned
  if (tailLen) tailParts.push(new Uint8Array(1));
  const newSupers: { s: SuperIndex; entries: { offset: number; size: number; duration: number }[] }[] = [];
  const SPAN = 2 ** 32 - 1;
  for (const s of supers) {
    const merged: { offset: number; size: number; duration: number }[] = [];
    let group: ChunkEntry[] = [];
    let groupDuration = 0;
    let fcc = "";
    let chunkId = s.chunkId;
    const flush = () => {
      if (group.length === 0) return;
      const chunk = buildIxChunk(fcc, chunkId, group);
      merged.push({ offset: size + tailLen, size: chunk.length, duration: groupDuration });
      tailParts.push(chunk);
      tailLen += chunk.length;
      group = [];
      groupDuration = 0;
    };
    for (const e of s.entries) {
      const raw = bytesAt(e.offset, e.size);
      const ix = raw ? parseIxChunk(raw) : null;
      if (!ix) return null; // not what the super index promised: leave the file alone
      if (ix.entries.length === 0) continue;
      fcc ||= fourcc(raw!, 0);
      chunkId = ix.chunkId;
      const base = group[0]?.pos ?? ix.entries[0]!.pos;
      const fits = ix.entries.every((x) => x.pos >= base && x.pos - base <= SPAN);
      if (!fits) flush();
      group.push(...ix.entries);
      groupDuration += e.duration;
    }
    flush();
    if (merged.length > s.capacity) return null;
    newSupers.push({ s, entries: merged });
  }

  const patched = head.slice();
  const pv = new DataView(patched.buffer);
  for (const { s, entries } of newSupers) {
    pv.setUint32(s.at + 4, entries.length, true);
    patched.fill(0, s.at + 24, s.at + 24 + s.capacity * 16);
    entries.forEach((e, i) => {
      const o = s.at + 24 + i * 16;
      pv.setBigUint64(o, BigInt(e.offset), true);
      pv.setUint32(o + 8, e.size, true);
      pv.setUint32(o + 12, e.duration, true);
    });
  }
  const tail = new Uint8Array(tailLen);
  let o = 0;
  for (const p of tailParts) {
    tail.set(p, o);
    o += p.length;
  }
  return { size, head: patched, tail, chunks: wanted.length };
}

interface Registration {
  index: AviIndex;
  file: MediaFile;
}

/**
 * Builds and caches AVI indexes for remote files, and serves the virtual files to
 * FFmpeg from a server on 127.0.0.1 (never reachable from outside the pod).
 */
export class AviIndexer {
  private readonly indexes = new Map<string, Promise<AviIndex | null>>();
  private readonly ready = new Map<string, AviIndex | null>();
  private readonly regs = new Map<string, Registration>();
  private server?: ReturnType<typeof Bun.serve>;

  constructor(
    private readonly cfg: RemoteConfig,
    private readonly cacheSize = 16,
    /** How the index is read; tests and the default read the origin directly. */
    private readonly reader: (file: MediaFile) => RangeReader = (file) => withRetry((start, end) => fetchOriginRange(file, cfg, start, end)),
  ) {}

  private key(file: MediaFile): string {
    return `${file.relPath}\0${file.size}\0${file.mtimeMs}\0${file.etag ?? ""}`;
  }

  /** Starts building the index in the background (no-op when it's built or building). */
  warm(file: MediaFile): Promise<AviIndex | null> {
    const key = this.key(file);
    let p = this.indexes.get(key);
    if (p) {
      // Most recently used goes last.
      this.indexes.delete(key);
      this.indexes.set(key, p);
      return p;
    }
    const started = Date.now();
    p = buildAviIndex(this.reader(file), file.size).then(
      (index) => {
        this.ready.set(key, index);
        if (index) {
          log("info", "avi_index_built", {
            path: file.relPath,
            chunks: index.chunks,
            indexBytes: index.tail.length,
            ms: Date.now() - started,
          });
        }
        return index;
      },
      (err) => {
        // Not cached: the next session tries again.
        this.indexes.delete(key);
        log("warn", "avi_index_failed", { path: file.relPath, error: String((err as Error)?.message ?? err) });
        return null;
      },
    );
    this.indexes.set(key, p);
    while (this.indexes.size > this.cacheSize) {
      const oldest = this.indexes.keys().next().value!;
      this.indexes.delete(oldest);
      this.ready.delete(oldest);
    }
    return p;
  }

  /**
   * A loopback URL FFmpeg can read with full seeking, or null to read the file as
   * before. With `waitMs` 0 it only uses an index that's already built (a start at 0
   * needs no index); otherwise it waits up to `waitMs` for the build.
   */
  async open(file: MediaFile, waitMs: number): Promise<{ url: string; id: string } | null> {
    const key = this.key(file);
    const p = this.warm(file);
    let index = this.ready.get(key);
    if (index === undefined && waitMs > 0) {
      index = await Promise.race([p, Bun.sleep(waitMs).then(() => undefined)]);
    }
    if (!index) return null;
    const id = randomBytes(18).toString("base64url");
    this.regs.set(id, { index, file });
    const name = encodeURIComponent(file.relPath.split("/").pop() || "file.avi");
    return { url: `http://127.0.0.1:${this.listen()}/v/${id}/${name}`, id };
  }

  release(id: string | undefined): void {
    if (id) this.regs.delete(id);
  }

  stop(): void {
    this.server?.stop(true);
    this.server = undefined;
    this.regs.clear();
  }

  private listen(): number {
    this.server ??= Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: (req) => this.serve(req),
    });
    return this.server.port!;
  }

  private async serve(req: Request): Promise<Response> {
    const m = /^\/v\/([A-Za-z0-9_-]+)\//.exec(new URL(req.url).pathname);
    const reg = m ? this.regs.get(m[1]!) : undefined;
    if (!reg || (req.method !== "GET" && req.method !== "HEAD")) return new Response(null, { status: 404 });
    const { index, file } = reg;
    const total = index.size + index.tail.length;
    const r = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get("range") ?? "");
    const start = r ? Number(r[1]) : 0;
    const end = r && r[2] ? Math.min(Number(r[2]), total - 1) : total - 1;
    if (start >= total || start > end) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
    }
    const headers = {
      "Accept-Ranges": "bytes",
      "Content-Type": "video/x-msvideo",
      "Content-Length": String(end - start + 1),
      ...(r ? { "Content-Range": `bytes ${start}-${end}/${total}` } : {}),
    };
    if (req.method === "HEAD") return new Response(null, { status: r ? 206 : 200, headers });

    const cfg = this.cfg;
    async function* parts(): AsyncGenerator<Uint8Array> {
      const headLen = index.head.length;
      if (start < headLen) yield index.head.subarray(start, Math.min(end + 1, headLen));
      const midStart = Math.max(start, headLen);
      const midEnd = Math.min(end, index.size - 1);
      if (midStart <= midEnd) {
        const res = await fetchRemote(file, cfg, { start: midStart, end: midEnd });
        const reader = res.body!.getReader();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            yield value;
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      }
      const tailStart = Math.max(start, index.size);
      if (tailStart <= end) yield index.tail.subarray(tailStart - index.size, end - index.size + 1);
    }
    const it = parts();
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        try {
          const { value, done } = await it.next();
          if (done) c.close();
          else c.enqueue(value);
        } catch (err) {
          c.error(err);
        }
      },
      async cancel() {
        await it.return(undefined);
      },
    });
    return new Response(body, { status: r ? 206 : 200, headers });
  }
}
