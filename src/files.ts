import { extensionOf } from "./paths.ts";
import type { MediaFile } from "./media-path.ts";

const CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  aac: "audio/aac",
  m4a: "audio/mp4",
  wav: "audio/wav",
  opus: "audio/ogg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  flac: "audio/flac",
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extensionOf(path)] ?? "application/octet-stream";
}

export type RangeResult =
  | { kind: "full" }
  | { kind: "partial"; start: number; end: number }
  | { kind: "unsatisfiable" };

/**
 * Parses a Range header against a file size. Supports "bytes=a-b", "bytes=a-" and
 * "bytes=-n". Multiple ranges are answered with the first one (browsers only send one
 * for media). Malformed headers are ignored, as RFC 9110 allows.
 */
export function parseRange(header: string | undefined | null, size: number): RangeResult {
  if (!header) return { kind: "full" };
  const m = /^bytes=\s*(\d*)\s*-\s*(\d*)\s*(?:,.*)?$/i.exec(header.trim());
  if (!m) return { kind: "full" };
  const [, a = "", b = ""] = m;
  if (a === "" && b === "") return { kind: "full" };

  if (a === "") {
    // Suffix range: the last n bytes.
    const n = Number(b);
    if (n === 0 || size === 0) return { kind: "unsatisfiable" };
    return { kind: "partial", start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  if (start >= size) return { kind: "unsatisfiable" };
  const end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  if (end < start) return { kind: "full" };
  return { kind: "partial", start, end };
}

/** Serves an original file from the share, with HTTP Range support for seeking. */
export function serveFile(file: MediaFile, req: Request): Response {
  const headers = new Headers({
    "Content-Type": contentTypeFor(file.relPath),
    "Accept-Ranges": "bytes",
    "Last-Modified": new Date(file.mtimeMs).toUTCString(),
    ETag: `"${file.size.toString(16)}-${Math.floor(file.mtimeMs).toString(16)}"`,
    "Cache-Control": "private, max-age=3600",
  });

  // If-Range: only honour the range when the client's copy is still current.
  const ifRange = req.headers.get("if-range");
  const rangeHeader = ifRange && ifRange !== headers.get("ETag") && ifRange !== headers.get("Last-Modified")
    ? null
    : req.headers.get("range");

  const range = parseRange(rangeHeader, file.size);
  const head = req.method === "HEAD";
  const blob = Bun.file(file.absPath);

  if (range.kind === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${file.size}`);
    return new Response(null, { status: 416, headers });
  }
  if (range.kind === "partial") {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${file.size}`);
    headers.set("Content-Length", String(range.end - range.start + 1));
    return new Response(head ? null : blob.slice(range.start, range.end + 1), { status: 206, headers });
  }
  headers.set("Content-Length", String(file.size));
  return new Response(head ? null : blob, { status: 200, headers });
}
