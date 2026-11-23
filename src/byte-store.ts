/**
 * The byte-access layer: every read FFmpeg and ffprobe make of a remote file goes
 * through this store, never to S3 directly.
 *
 * FFmpeg's demuxers assume a seek is free. Over HTTP each one is a new request, and
 * every container layout pays for that differently (an index at the end, audio stored
 * far from video, no index at all). So FFmpeg gets a loopback URL instead, and the
 * store decides how the bytes are fetched and kept:
 *
 *  - the file is cut into fixed blocks, each fetched once and kept as a file under
 *    REMOTE_STORE_DIR (a volume shared by all pods, or local disk);
 *  - each read warms the blocks after it, so a file read at two places at once
 *    (non-interleaved audio and video) is two sequential streams;
 *  - while a session is open the rest of the file is fetched in the background,
 *    nearest to the play position first; after that every seek is local;
 *  - least recently used files are dropped when the folder is over its size limit.
 *
 * A store failure never stops playback: a block that can't be written or read back
 * is served from memory and fetched again next time.
 *
 * Block files are written to a temp name and renamed, so pods sharing the folder
 * never see half a block, and two pods fetching the same block just write it twice.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { ApiError } from "./http/errors.ts";
import { log } from "./log.ts";
import type { MediaFile } from "./media-path.ts";
import type { Metrics } from "./metrics.ts";
import { fetchRemote, type RemoteConfig } from "./remote.ts";

export interface StoreConfig {
  /** Folder for block files. Shared between pods when it's on a shared volume. */
  dir: string;
  /** The folder is kept under this size by dropping least recently used files. */
  maxBytes: number;
  blockBytes: number;
  /** Blocks warmed after the one being read, at most. */
  readAhead: number;
  /** Background requests filling an open file. 0 turns the fill off. */
  fillConcurrency: number;
  /** How often the folder's size is checked. */
  sweepIntervalMs: number;
}

/**
 * Bytes served in place of, and after, the original: FFmpeg sees
 * [head][original bytes from head.length][tail]. Used for rebuilt indexes (avi-index.ts).
 */
export interface Overlay {
  head: Uint8Array;
  tail: Uint8Array;
}

export interface OpenOptions {
  overlay?: Overlay;
  /** Fetch the whole file in the background while this handle is open (playback sessions). */
  fill?: boolean;
}

export interface StoreHandle {
  id: string;
  /** Loopback URL of the file, for FFmpeg's -i. */
  url: string;
}

interface Entry {
  key: string;
  dir: string;
  size: number;
  blocks: number;
  /** Blocks known to be in the folder. Other pods add blocks too, so the folder is always asked. */
  have: Set<number>;
  inflight: Map<number, Promise<Uint8Array>>;
  refs: number;
  fillRefs: number;
  fillers: number;
  /** Block last read by FFmpeg: where the background fill works from. */
  cursor: number;
  /** The most recently opened link to the file (links are signed per viewer and expire). */
  file: MediaFile;
  ready: Promise<void>;
}

interface Registration {
  entry: Entry;
  file: MediaFile;
  overlay?: Overlay;
  fill: boolean;
  requests: number;
  bytesServed: number;
  blocksFetched: number;
  openedAt: number;
}

const BLOCK_NAME = /^b(\d+)$/;
const USED_MARK = ".used";

export class ByteStore {
  private readonly entries = new Map<string, Entry>();
  private readonly regs = new Map<string, Registration>();
  private server?: ReturnType<typeof Bun.serve>;
  private sweeper?: ReturnType<typeof setInterval>;
  private sweeping = false;
  private lastWriteWarning = 0;

  constructor(
    private readonly cfg: StoreConfig,
    private readonly remote: RemoteConfig,
    private readonly metrics?: Metrics,
  ) {}

  /** Creates the folder and starts the size check. The store works without it (from memory). */
  async init(): Promise<void> {
    await mkdir(this.cfg.dir, { recursive: true }).catch((err) => this.warnWrite(err));
    this.sweeper = setInterval(() => void this.sweep(), this.cfg.sweepIntervalMs);
    this.sweeper.unref?.();
    void this.sweep();
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.server?.stop(true);
    this.server = undefined;
    for (const reg of this.regs.values()) {
      reg.entry.refs = 0;
      reg.entry.fillRefs = 0;
    }
    this.regs.clear();
  }

  /** One version of one object: a new link to the same object shares its blocks. */
  static keyOf(file: MediaFile): string {
    return createHash("sha256")
      .update(`${file.relPath}\0${file.size}\0${file.mtimeMs}\0${file.etag ?? ""}`)
      .digest("hex")
      .slice(0, 40);
  }

  private entryFor(file: MediaFile): Entry {
    const key = ByteStore.keyOf(file);
    let e = this.entries.get(key);
    if (!e) {
      const dir = join(this.cfg.dir, key);
      e = {
        key,
        dir,
        size: file.size,
        blocks: Math.ceil(file.size / this.cfg.blockBytes),
        have: new Set(),
        inflight: new Map(),
        refs: 0,
        fillRefs: 0,
        fillers: 0,
        cursor: 0,
        file,
        ready: mkdir(dir, { recursive: true }).then(
          () => undefined,
          (err) => this.warnWrite(err),
        ),
      };
      this.entries.set(key, e);
    }
    e.file = file;
    return e;
  }

  /** A loopback URL FFmpeg can read the file from. Release it when FFmpeg is done. */
  open(file: MediaFile, opts: OpenOptions = {}): StoreHandle {
    const entry = this.entryFor(file);
    entry.refs += 1;
    const reg: Registration = {
      entry,
      file,
      overlay: opts.overlay,
      fill: Boolean(opts.fill),
      requests: 0,
      bytesServed: 0,
      blocksFetched: 0,
      openedAt: Date.now(),
    };
    const id = randomBytes(18).toString("base64url");
    this.regs.set(id, reg);
    void this.touch(entry);
    if (reg.fill) {
      entry.fillRefs += 1;
      this.startFill(entry);
    }
    const name = encodeURIComponent(file.relPath.split("/").pop() || "file");
    return { id, url: `http://127.0.0.1:${this.listen()}/v/${id}/${name}` };
  }

  release(id: string | undefined): void {
    const reg = id ? this.regs.get(id) : undefined;
    if (!reg) return;
    this.regs.delete(id!);
    reg.entry.refs -= 1;
    if (reg.fill) reg.entry.fillRefs -= 1;
    // What FFmpeg did with the file: many requests for few bytes is a layout that
    // seeks a lot, and the first thing to look at when a format plays badly.
    log("info", "remote_read", {
      path: reg.file.relPath,
      size: reg.entry.size,
      requests: reg.requests,
      bytesServed: reg.bytesServed,
      blocksFetched: reg.blocksFetched,
      openMs: Date.now() - reg.openedAt,
    });
  }

  /** True for the loopback URLs this store hands out. */
  isLocalUrl(url: string): boolean {
    return this.server !== undefined && url.startsWith(`http://127.0.0.1:${this.server.port}/v/`);
  }

  /** Reads the inclusive byte range [start, end] of the original file through the store. */
  async read(file: MediaFile, start: number, end: number): Promise<Uint8Array> {
    const entry = this.entryFor(file);
    const out = new Uint8Array(end - start + 1);
    const B = this.cfg.blockBytes;
    for (let i = Math.floor(start / B); i * B <= end; i++) {
      const block = await this.block(entry, i, file);
      const from = Math.max(start - i * B, 0);
      const to = Math.min(end - i * B + 1, block.length);
      out.set(block.subarray(from, to), i * B + from - start);
    }
    return out;
  }

  /** A small file kept next to an object's blocks (a rebuilt index, for example). */
  async readAux(file: MediaFile, name: string): Promise<Uint8Array | null> {
    const entry = this.entryFor(file);
    try {
      return await Bun.file(join(entry.dir, name)).bytes();
    } catch {
      return null;
    }
  }

  async writeAux(file: MediaFile, name: string, bytes: Uint8Array): Promise<void> {
    const entry = this.entryFor(file);
    await entry.ready;
    await this.writeAtomic(entry, name, bytes);
  }

  // ---- blocks ----

  private blockLength(entry: Entry, i: number): number {
    return Math.min(this.cfg.blockBytes, entry.size - i * this.cfg.blockBytes);
  }

  /** Block `i`: from a fetch already running, from the folder, or from the origin. */
  private block(entry: Entry, i: number, file: MediaFile, reg?: Registration): Promise<Uint8Array> {
    let p = entry.inflight.get(i);
    if (p) return p;
    p = this.loadBlock(entry, i, file, reg);
    entry.inflight.set(i, p);
    const done = () => {
      if (entry.inflight.get(i) === p) entry.inflight.delete(i);
    };
    p.then(done, done);
    return p;
  }

  private async loadBlock(entry: Entry, i: number, file: MediaFile, reg?: Registration): Promise<Uint8Array> {
    const length = this.blockLength(entry, i);
    await entry.ready;
    try {
      const stored = await Bun.file(join(entry.dir, `b${i}`)).bytes();
      if (stored.length === length) {
        entry.have.add(i);
        this.metrics?.remoteBlocks.inc({ source: "store" });
        return stored;
      }
    } catch {
      // Not in the folder (or the folder is gone): fetch it.
    }
    entry.have.delete(i);
    const start = i * this.cfg.blockBytes;
    const bytes = await this.fetchBlock(file, start, start + length - 1);
    this.metrics?.remoteBlocks.inc({ source: "origin" });
    this.metrics?.remoteBytesFetched.inc(bytes.length);
    if (reg) reg.blocksFetched += 1;
    if (await this.writeAtomic(entry, `b${i}`, bytes)) entry.have.add(i);
    return bytes;
  }

  /** One range from the origin, retried twice. A refused link is not retried. */
  private async fetchBlock(file: MediaFile, start: number, end: number): Promise<Uint8Array> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetchRemote(file, this.remote, { start, end });
        if (res.status !== 206 && !(start === 0 && end === file.size - 1)) {
          await res.body?.cancel();
          throw new ApiError(502, "remote_unavailable", `The media server answered HTTP ${res.status} to a range request.`);
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length !== end - start + 1) throw new ApiError(502, "remote_unavailable", "The media server sent a short range.");
        return bytes;
      } catch (err) {
        const denied = err instanceof ApiError && err.code === "remote_denied";
        if (denied || attempt >= 2) throw err;
        await Bun.sleep(200 * (attempt + 1));
      }
    }
  }

  private async writeAtomic(entry: Entry, name: string, bytes: Uint8Array): Promise<boolean> {
    const path = join(entry.dir, name);
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await Bun.write(tmp, bytes);
        await rename(tmp, path);
        return true;
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => {});
        if (attempt === 0) {
          // Another pod may have dropped the folder while making room.
          await mkdir(entry.dir, { recursive: true }).catch(() => {});
          continue;
        }
        this.warnWrite(err);
      }
    }
    return false;
  }

  private warnWrite(err: unknown): void {
    if (Date.now() - this.lastWriteWarning < 60_000) return;
    this.lastWriteWarning = Date.now();
    log("warn", "remote_store_write_failed", { dir: this.cfg.dir, error: String((err as Error)?.message ?? err) });
  }

  // ---- background fill ----

  private startFill(entry: Entry): void {
    // A file that would take most of the folder is read on demand only.
    if (this.cfg.fillConcurrency <= 0 || entry.size > this.cfg.maxBytes / 2) return;
    while (entry.fillers < this.cfg.fillConcurrency) {
      entry.fillers += 1;
      void this.fillLoop(entry).finally(() => {
        entry.fillers -= 1;
      });
    }
  }

  private async fillLoop(entry: Entry): Promise<void> {
    let failures = 0;
    while (entry.fillRefs > 0) {
      const i = this.nextMissing(entry);
      if (i < 0) return;
      try {
        await this.block(entry, i, entry.file);
        failures = 0;
      } catch {
        if (++failures >= 5) return; // the link expired or the origin is down: reads still try on demand
        await Bun.sleep(1000);
      }
    }
  }

  /** The first block from the play position on (wrapping) that is neither stored nor being fetched. */
  private nextMissing(entry: Entry): number {
    for (let n = 0; n < entry.blocks; n++) {
      const i = (entry.cursor + n) % entry.blocks;
      if (!entry.have.has(i) && !entry.inflight.has(i)) return i;
    }
    return -1;
  }

  // ---- loopback server ----

  private listen(): number {
    this.server ??= Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: (req) => this.serve(req),
    });
    return this.server.port!;
  }

  private serve(req: Request): Response {
    const m = /^\/v\/([A-Za-z0-9_-]+)\//.exec(new URL(req.url).pathname);
    const reg = m ? this.regs.get(m[1]!) : undefined;
    if (!reg || (req.method !== "GET" && req.method !== "HEAD")) return new Response(null, { status: 404 });
    const total = reg.entry.size + (reg.overlay?.tail.length ?? 0);
    const r = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get("range") ?? "");
    const start = r ? Number(r[1]) : 0;
    const end = r && r[2] ? Math.min(Number(r[2]), total - 1) : total - 1;
    if (start >= total || start > end) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
    }
    const headers = {
      "Accept-Ranges": "bytes",
      "Content-Type": "application/octet-stream",
      "Content-Length": String(end - start + 1),
      ...(r ? { "Content-Range": `bytes ${start}-${end}/${total}` } : {}),
    };
    if (req.method === "HEAD") return new Response(null, { status: r ? 206 : 200, headers });

    reg.requests += 1;
    const it = this.parts(reg, start, end);
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

  /** The inclusive range [start, end] of the file as FFmpeg sees it (overlay included). */
  private async *parts(reg: Registration, start: number, end: number): AsyncGenerator<Uint8Array> {
    const { entry, overlay } = reg;
    const B = this.cfg.blockBytes;
    const count = (bytes: Uint8Array) => {
      reg.bytesServed += bytes.length;
      return bytes;
    };
    const headLen = overlay?.head.length ?? 0;
    if (start < headLen) yield count(overlay!.head.subarray(start, Math.min(end + 1, headLen)));

    const midStart = Math.max(start, headLen);
    const midEnd = Math.min(end, entry.size - 1);
    // Reads ahead a little at first and more as the read goes on: a demuxer hopping
    // around a file shouldn't pull megabytes at every stop, a steady read should.
    let ahead = 0;
    for (let i = Math.floor(midStart / B); midStart <= midEnd && i * B <= midEnd; i++) {
      entry.cursor = i;
      ahead = Math.min(this.cfg.readAhead, ahead + 1);
      for (let k = 1; k <= ahead && i + k < entry.blocks; k++) {
        this.block(entry, i + k, reg.file, reg).catch(() => {});
      }
      const block = await this.block(entry, i, reg.file, reg);
      yield count(block.subarray(Math.max(midStart - i * B, 0), Math.min(midEnd - i * B + 1, block.length)));
    }

    const tailStart = Math.max(start, entry.size);
    if (overlay && tailStart <= end) yield count(overlay.tail.subarray(tailStart - entry.size, end - entry.size + 1));
  }

  // ---- size limit ----

  private async touch(entry: Entry): Promise<void> {
    await entry.ready;
    const mark = join(entry.dir, USED_MARK);
    const now = new Date();
    try {
      await utimes(mark, now, now);
    } catch {
      await Bun.write(mark, "").catch(() => {});
    }
  }

  /**
   * Keeps the folder under its limit: drops the least recently used files that no
   * session on this pod has open. Every pod runs this; dropping the same folder twice
   * is harmless, and a pod that loses blocks it was reading fetches them again.
   */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      for (const e of this.entries.values()) {
        if (e.refs > 0) await this.touch(e);
        else if (e.inflight.size === 0) this.entries.delete(e.key);
      }
      const names = await readdir(this.cfg.dir).catch(() => [] as string[]);
      const dirs: { name: string; bytes: number; usedAt: number }[] = [];
      let total = 0;
      for (const name of names) {
        const dir = join(this.cfg.dir, name);
        const files = await readdir(dir).catch(() => null);
        if (!files) continue;
        const bytes = files.filter((f) => BLOCK_NAME.test(f)).length * this.cfg.blockBytes;
        const usedAt = (await stat(join(dir, USED_MARK)).catch(() => stat(dir).catch(() => null)))?.mtimeMs ?? 0;
        dirs.push({ name, bytes, usedAt });
        total += bytes;
      }
      this.metrics?.remoteStoreBytes.set(total);
      if (total <= this.cfg.maxBytes) return;
      dirs.sort((a, b) => a.usedAt - b.usedAt);
      // Down to 90%, so the next block doesn't trigger another round.
      for (const d of dirs) {
        if (total <= this.cfg.maxBytes * 0.9) break;
        if ((this.entries.get(d.name)?.refs ?? 0) > 0) continue;
        await rm(join(this.cfg.dir, d.name), { recursive: true, force: true }).catch(() => {});
        this.entries.delete(d.name);
        total -= d.bytes;
        log("info", "remote_store_evicted", { key: d.name, bytes: d.bytes });
      }
      this.metrics?.remoteStoreBytes.set(total);
    } finally {
      this.sweeping = false;
    }
  }
}
