/**
 * Rewrites an FFmpeg-made AVI the way many DVR/NVR exports are laid out: an OpenDML
 * super index (indx) in each stream header pointing at small standard index chunks
 * (ix00, ix01) spread through the movi list, one every `every` video frames, and no
 * idx1. Reading that index means one seek per chunk, which is what made large remote
 * AVI files time out.
 */
import { readFileSync, writeFileSync } from "node:fs";

interface Chunk {
  id: string;
  off: number;
  size: number;
}

function* chunks(buf: Buffer, off: number, end: number): Generator<Chunk> {
  while (off + 8 <= end) {
    const size = buf.readUInt32LE(off + 4);
    yield { id: buf.toString("latin1", off, off + 4), off, size };
    off += 8 + size + (size & 1);
  }
}

export function writeOdmlAvi(src: string, dst: string, every: number): { indexChunks: number } {
  const data = readFileSync(src);
  if (data.toString("latin1", 0, 4) !== "RIFF" || data.toString("latin1", 8, 12) !== "AVI ") throw new Error("not an AVI");
  let hdrl: Buffer | undefined;
  let movi: Chunk | undefined;
  for (const c of chunks(data, 12, 8 + data.readUInt32LE(4))) {
    const list = data.toString("latin1", c.off + 8, c.off + 12);
    if (c.id === "LIST" && list === "hdrl") hdrl = Buffer.from(data.subarray(c.off, c.off + 8 + c.size));
    if (c.id === "LIST" && list === "movi") movi = c;
  }
  if (!hdrl || !movi) throw new Error("no hdrl or movi");

  // FFmpeg reserves the super index space as a JUNK chunk in each strl; claim it.
  const indx: number[] = [];
  for (let i = hdrl.indexOf("strl"); i !== -1; i = hdrl.indexOf("strl", i + 4)) {
    const j = hdrl.indexOf("JUNK", i);
    hdrl.write("indx", j, "latin1");
    indx.push(j);
  }
  const streams = indx.length;
  const chunkId = (s: number) => `${String(s).padStart(2, "0")}${s === 0 ? "dc" : "wb"}`;

  const parts: Buffer[] = [Buffer.from("RIFF\0\0\0\0AVI ", "latin1"), hdrl];
  let pos = 12 + hdrl.length;
  const moviStart = pos;
  parts.push(Buffer.from("LIST\0\0\0\0movi", "latin1"));
  pos += 12;
  const pending: { off: number; size: number; key: boolean }[][] = Array.from({ length: streams }, () => []);
  const supers: { off: number; size: number; duration: number }[][] = Array.from({ length: streams }, () => []);
  const push = (b: Buffer) => {
    parts.push(b);
    pos += b.length;
  };
  const flush = () => {
    for (let s = 0; s < streams; s++) {
      const entries = pending[s]!;
      if (entries.length === 0) continue;
      const base = entries[0]!.off;
      const body = Buffer.alloc(24 + entries.length * 8);
      body.writeUInt16LE(2, 0); // wLongsPerEntry
      body.writeUInt8(1, 3); // AVI_INDEX_OF_CHUNKS
      body.writeUInt32LE(entries.length, 4);
      body.write(chunkId(s), 8, "latin1");
      body.writeBigUInt64LE(BigInt(base), 12);
      entries.forEach((e, i) => {
        body.writeUInt32LE(e.off - base, 24 + i * 8);
        body.writeUInt32LE((e.size | (e.key ? 0 : 0x80000000)) >>> 0, 28 + i * 8);
      });
      const head = Buffer.alloc(8);
      head.write(`ix${String(s).padStart(2, "0")}`, 0, "latin1");
      head.writeUInt32LE(body.length, 4);
      supers[s]!.push({ off: pos, size: body.length + 8, duration: entries.length });
      push(Buffer.concat([head, body]));
      pending[s] = [];
    }
  };

  let frames = 0;
  for (const c of chunks(data, movi.off + 12, movi.off + 8 + movi.size)) {
    if (c.id.startsWith("ix") || c.id === "JUNK") continue;
    const s = Number(c.id.slice(0, 2));
    const video = c.id.endsWith("dc") || c.id.endsWith("db");
    pending[s]!.push({ off: pos + 8, size: c.size, key: !video || frames % 25 === 0 });
    push(Buffer.from(data.subarray(c.off, c.off + 8 + c.size + (c.size & 1))));
    if (video && ++frames % every === 0) flush();
  }
  flush();

  const out = Buffer.concat(parts);
  out.writeUInt32LE(out.length - moviStart - 8, moviStart + 4);
  out.writeUInt32LE(out.length - 8, 4);
  indx.forEach((p, s) => {
    const at = 12 + p;
    const cap = out.readUInt32LE(at + 4);
    const entries = supers[s]!;
    if (24 + entries.length * 16 > cap) throw new Error("super index doesn't fit");
    out.writeUInt16LE(4, at + 8); // wLongsPerEntry
    out.writeUInt8(0, at + 11); // AVI_INDEX_OF_INDEXES
    out.writeUInt32LE(entries.length, at + 12);
    out.write(chunkId(s), at + 16, "latin1");
    entries.forEach((e, i) => {
      const o = at + 32 + i * 16;
      out.writeBigUInt64LE(BigInt(e.off), o);
      out.writeUInt32LE(e.size, o + 8);
      out.writeUInt32LE(e.duration, o + 12);
    });
  });
  writeFileSync(dst, out);
  return { indexChunks: supers.reduce((n, s) => n + s.length, 0) };
}
