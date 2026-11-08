import { realpath, stat } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { ApiError, notFound } from "./http/errors.ts";

export interface MediaFile {
  /** Normalized path relative to the media root, with forward slashes. */
  relPath: string;
  /** Real absolute path on disk (symlinks resolved, guaranteed inside the root). */
  absPath: string;
  /** relPath of the real file (symlinks resolved); equals relPath when no symlink is involved. */
  realRelPath: string;
  size: number;
  mtimeMs: number;
  /** An http(s) source (src/remote.ts): relPath is the URL without its query, absPath the full URL. */
  remote?: boolean;
  etag?: string;
}

const invalid = (reason: string) => new ApiError(400, "invalid_path", reason);

/**
 * Checks a client-supplied path and turns it into a real file inside the media root.
 * Rejects absolute paths, "..", NUL bytes, folders and symlinks that lead outside the root.
 */
export async function resolveMediaPath(root: string, input: string | undefined | null): Promise<MediaFile> {
  if (typeof input !== "string" || input.trim() === "") throw invalid("A file path is required.");
  if (input.includes("\0")) throw invalid("The path contains a NUL byte.");
  const unified = input.replace(/\\/g, "/");
  if (unified.startsWith("/") || isAbsolute(input) || /^[a-zA-Z]:/.test(unified)) {
    throw invalid("Paths must be relative to the media root.");
  }
  if (unified.split("/").includes("..")) throw invalid('Paths may not contain "..".');

  const rootReal = await realpath(root).catch(() => {
    throw new ApiError(500, "media_root_unavailable", "The media share is not available.");
  });
  const candidate = resolve(rootReal, normalize(unified));
  if (!isInside(rootReal, candidate)) throw invalid("The path leaves the media root.");

  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw notFound("The file does not exist.");
  }
  // A symlink inside the share may point anywhere; only follow it if it stays inside.
  if (!isInside(rootReal, real)) throw invalid("The path leaves the media root.");

  const st = await stat(real).catch(() => {
    throw notFound("The file does not exist.");
  });
  if (!st.isFile()) throw notFound("The path is not a file.");

  return {
    relPath: relative(rootReal, candidate).split(sep).join("/"),
    absPath: real,
    realRelPath: relative(rootReal, real).split(sep).join("/"),
    size: st.size,
    mtimeMs: st.mtimeMs,
  };
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel.split(sep)[0] !== ".." && !isAbsolute(rel);
}

/** Encodes a relative path for use in a URL, keeping the slashes. */
export function encodeMediaPath(relPath: string): string {
  return relPath.split("/").map(encodeURIComponent).join("/");
}

/**
 * Strips a known spelling of the share root from the front of a path, so a client
 * that sends `\\fileserver\media\cases\12\a.mp4` or `/mnt/media/cases/12/a.mp4` gets
 * `cases/12/a.mp4`. The prefix match ignores case (UNC host and share names do) and
 * the longest prefix wins. Paths that match no prefix are returned unchanged, and are
 * then checked like any other path: nothing is guessed.
 */
export function stripRootPrefix(input: string, prefixes: string[]): string {
  if (prefixes.length === 0) return input;
  const unified = input.replace(/\\/g, "/");
  const lower = unified.toLowerCase();
  const sorted = prefixes
    .map((p) => {
      const u = p.replace(/\\/g, "/");
      return u.endsWith("/") ? u : `${u}/`;
    })
    .sort((a, b) => b.length - a.length);
  for (const pre of sorted) {
    if (lower.startsWith(pre.toLowerCase())) return unified.slice(pre.length);
  }
  return input;
}
