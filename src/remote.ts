import { contentTypeFor, parseRange } from "./files.ts";
import { ApiError, badRequest } from "./http/errors.ts";
import { log } from "./log.ts";
import type { MediaFile } from "./media-path.ts";

/**
 * Remote sources: a token whose `path` is an http(s) URL (an S3 presigned link, for
 * example) is played from that URL instead of the share.
 *
 * Only hosts on REMOTE_ALLOWED_HOSTS are fetched, https only unless REMOTE_ALLOW_HTTP,
 * no credentials in the URL, and no redirects. FFmpeg gets a protocol whitelist, so a
 * remote file can't make it open local files. The full URL (with its signature) is
 * never logged or returned: logs and responses use origin + path only.
 */
export interface RemoteConfig {
  /** Exact hosts ("bucket.s3.eu-west-1.amazonaws.com", "minio.internal:9000") or "*.suffix". Empty = remote sources off. */
  allowedHosts: string[];
  allowHttp: boolean;
  /** Timeout for wavy's own requests to the remote (open and each proxied range). */
  timeoutMs: number;
  /**
   * CA bundle FFmpeg verifies https certificates against (FFmpeg doesn't verify by
   * default). Also used by wavy's own requests when set explicitly (REMOTE_CA_FILE).
   */
  caFile: string;
  customCa?: boolean;
  /**
   * Base URL of the slice cache (deploy/cache), e.g.
   * "http://wavy-cache:8080". Empty = read remote files straight from the origin.
   */
  cacheUrl?: string;
  /** How long to wait for the cache before reading from the origin instead. */
  cacheTimeoutMs?: number;
}

/** After the cache fails, it's skipped for this long and files are read from the origin. */
export const CACHE_RETRY_MS = 30_000;
const cacheDownUntil = new WeakMap<RemoteConfig, number>();
/** Healthy answers from the cache's /healthz are trusted this long, so most opens don't ask. */
const HEALTH_TTL_MS = 5_000;
const cacheHealthyUntil = new WeakMap<RemoteConfig, number>();

const cacheUsable = (cfg: RemoteConfig) => Boolean(cfg.cacheUrl) && (cacheDownUntil.get(cfg) ?? 0) <= Date.now();

/**
 * The cache URL for an origin URL: <cache>/<scheme>/<host[:port]>/<version>/<path>?<query>.
 * The cache strips the version before fetching, and keys slices by it.
 */
export function cacheUrlFor(cacheBase: string, url: URL, version: string): string {
  return `${cacheBase.replace(/\/+$/, "")}/${url.protocol.slice(0, -1)}/${url.host}/${version}${url.pathname}${url.search}`;
}

/**
 * Where to read a remote file from: the cache, unless it failed in the last
 * CACHE_RETRY_MS (then the origin, so a cache outage never stops playback).
 */
export function readUrlOf(file: MediaFile, cfg: RemoteConfig): string {
  return file.cacheUrl && cacheUsable(cfg) ? file.cacheUrl : file.absPath;
}

/**
 * Checks the cache's /healthz: before opening a file through it (cached for
 * HEALTH_TTL_MS), and after FFmpeg failed reading through it (FFmpeg can't tell us
 * why). Marks it down when it doesn't answer, so reads go to the origin.
 */
export async function checkCache(cfg: RemoteConfig): Promise<boolean> {
  if (!cfg.cacheUrl) return false;
  try {
    const res = await fetch(`${cfg.cacheUrl.replace(/\/+$/, "")}/healthz`, {
      redirect: "manual",
      signal: AbortSignal.timeout(cfg.cacheTimeoutMs ?? 5_000),
    });
    await res.body?.cancel();
    if (res.ok) {
      cacheHealthyUntil.set(cfg, Date.now() + HEALTH_TTL_MS);
      return true;
    }
  } catch {
    // down
  }
  cacheDownUntil.set(cfg, Date.now() + CACHE_RETRY_MS);
  log("warn", "remote_cache_unavailable", { cache: cfg.cacheUrl, retryInMs: CACHE_RETRY_MS });
  return false;
}

/** Replaces a remote file's signed URLs (origin and cache) with origin + path. */
export function redactRemote(text: string, file: Pick<MediaFile, "remote" | "absPath" | "relPath" | "cacheUrl">): string {
  if (!file.remote) return text;
  let out = text.split(file.absPath).join(file.relPath);
  if (file.cacheUrl) out = out.split(file.cacheUrl).join(file.relPath);
  return out;
}

export const DEFAULT_CA_FILE = "/etc/ssl/certs/ca-certificates.crt";

export const isRemoteUrl = (p: unknown): p is string => typeof p === "string" && /^https?:\/\//i.test(p.trim());

/** Origin + path: safe to log and to show (drops the query, where presigned signatures live). */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "<invalid url>";
  }
}

export function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((entry) => {
    const e = entry.toLowerCase();
    if (e.startsWith("*.")) {
      const suffix = e.slice(1); // ".example.com"
      return h.endsWith(suffix) && h.length > suffix.length && !h.slice(0, -suffix.length).includes(":");
    }
    return h === e;
  });
}

/** Checks a remote URL against the policy. Throws 400/403 with a reason. */
export function checkRemoteUrl(raw: string, cfg: RemoteConfig): URL {
  if (cfg.allowedHosts.length === 0) throw new ApiError(403, "remote_disabled", "Playing from a URL is not enabled on this server.");
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw badRequest("The media URL is not valid.");
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && cfg.allowHttp)) {
    throw new ApiError(403, "remote_forbidden", "Only https media URLs are allowed.");
  }
  if (u.username || u.password) throw new ApiError(403, "remote_forbidden", "Media URLs may not contain credentials.");
  if (!hostAllowed(u.host, cfg.allowedHosts)) {
    throw new ApiError(403, "remote_forbidden", `The host ${u.host} is not on the allowed list.`);
  }
  return u;
}

/**
 * Fetch with no redirect following. The timeout covers the response headers only,
 * so a long proxied body isn't cut off.
 */
async function remoteFetch(
  url: string,
  cfg: RemoteConfig,
  headers: Record<string, string>,
  timeoutMs = cfg.timeoutMs,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      headers,
      redirect: "manual",
      signal: ctrl.signal,
      ...(cfg.customCa ? { tls: { ca: await Bun.file(cfg.caFile).text() } } : {}),
    });
  } catch {
    const why = ctrl.signal.aborted ? "timed out" : "could not be reached";
    throw new ApiError(502, "remote_unavailable", `The media server ${why}.`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    throw new ApiError(502, "remote_unavailable", "The media URL redirects, which is not allowed.");
  }
  return res;
}

/**
 * Opens a remote file: checks the URL, then reads its size with a one-byte range GET
 * (presigned S3 URLs are signed for GET only, so HEAD would be refused).
 *
 * That GET always goes to the origin, even with a cache: it's what refuses an
 * expired or forged link, and its ETag versions the cache URL, so an overwritten
 * object is never served from old slices. Only the reads after it use the cache.
 */
export async function openRemote(raw: string, cfg: RemoteConfig): Promise<MediaFile> {
  const u = checkRemoteUrl(raw, cfg);
  const url = u.toString();
  const [res, cacheOk] = await Promise.all([remoteFetch(url, cfg, { Range: "bytes=0-0" }), cacheReady(cfg)]);
  const file = await fileFrom(url, res);
  if (cacheOk && cfg.cacheUrl) file.cacheUrl = cacheUrlFor(cfg.cacheUrl, u, cacheVersion(file));
  return file;
}

/** Identifies one version of an object: its ETag, or size + Last-Modified without one. */
function cacheVersion(file: MediaFile): string {
  return Bun.hash(`${file.etag ?? ""}\0${file.size}\0${file.mtimeMs}`).toString(36);
}

async function cacheReady(cfg: RemoteConfig): Promise<boolean> {
  if (!cfg.cacheUrl || !cacheUsable(cfg)) return false;
  if ((cacheHealthyUntil.get(cfg) ?? 0) > Date.now()) return true;
  return checkCache(cfg);
}

async function fileFrom(url: string, res: Response): Promise<MediaFile> {
  await res.body?.cancel();
  if (res.status === 403 || res.status === 401) {
    throw new ApiError(502, "remote_denied", "The media server refused the link (it may have expired).");
  }
  if (res.status === 404) throw new ApiError(404, "not_found", "The file does not exist on the media server.");
  let size: number | undefined;
  if (res.status === 206) {
    const m = /\/(\d+)\s*$/.exec(res.headers.get("content-range") ?? "");
    if (m) size = Number(m[1]);
  } else if (res.status === 200) {
    const len = res.headers.get("content-length");
    if (len) size = Number(len);
  }
  if (size === undefined || !Number.isFinite(size)) {
    throw new ApiError(502, "remote_unavailable", `The media server answered HTTP ${res.status} without a file size.`);
  }
  const lastModified = Date.parse(res.headers.get("last-modified") ?? "");
  return {
    relPath: redactUrl(url),
    absPath: url,
    realRelPath: redactUrl(url),
    size,
    mtimeMs: Number.isFinite(lastModified) ? lastModified : 0,
    remote: true,
    etag: res.headers.get("etag") ?? undefined,
  };
}

/** Proxies a remote file to the browser, passing the Range request through. */
export async function serveRemote(file: MediaFile, req: Request, cfg: RemoteConfig): Promise<Response> {
  const headers = new Headers({
    "Content-Type": contentTypeFor(file.relPath),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
  });
  if (file.etag) headers.set("ETag", file.etag);
  if (file.mtimeMs) headers.set("Last-Modified", new Date(file.mtimeMs).toUTCString());

  const range = parseRange(req.headers.get("range"), file.size);
  if (range.kind === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${file.size}`);
    return new Response(null, { status: 416, headers });
  }
  if (req.method === "HEAD") {
    if (range.kind === "partial") {
      headers.set("Content-Range", `bytes ${range.start}-${range.end}/${file.size}`);
      headers.set("Content-Length", String(range.end - range.start + 1));
      return new Response(null, { status: 206, headers });
    }
    headers.set("Content-Length", String(file.size));
    return new Response(null, { status: 200, headers });
  }

  const res = await fetchRemote(file, cfg, range.kind === "partial" ? { start: range.start, end: range.end } : undefined);
  for (const h of ["content-length", "content-range"]) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(res.body, { status: res.status, headers });
}

/**
 * Reads a remote file, or the inclusive byte range [start, end] of it: through the
 * cache when there is one, from the origin when the cache is down. Returns the 200/206
 * response; throws 502 for a refused link or any other answer.
 */
export async function fetchRemote(file: MediaFile, cfg: RemoteConfig, range?: { start: number; end: number }): Promise<Response> {
  const rangeHeader: Record<string, string> = range ? { Range: `bytes=${range.start}-${range.end}` } : {};
  let res: Response | undefined;
  const viaCache = readUrlOf(file, cfg);
  if (viaCache !== file.absPath) {
    // Through the cache; if it's gone, mark it down and read from the origin.
    try {
      res = await remoteFetch(viaCache, cfg, rangeHeader, cfg.cacheTimeoutMs ?? 5_000);
      if (res.status >= 500) {
        await res.body?.cancel();
        res = undefined;
      }
    } catch {
      res = undefined;
    }
    if (!res) {
      cacheDownUntil.set(cfg, Date.now() + CACHE_RETRY_MS);
      log("warn", "remote_cache_unavailable", { cache: cfg.cacheUrl, retryInMs: CACHE_RETRY_MS });
    }
  }
  res ??= await remoteFetch(file.absPath, cfg, rangeHeader);
  if (res.status === 403 || res.status === 401) {
    await res.body?.cancel();
    throw new ApiError(502, "remote_denied", "The media server refused the link (it may have expired).");
  }
  if (res.status !== 200 && res.status !== 206) {
    await res.body?.cancel();
    throw new ApiError(502, "remote_unavailable", `The media server answered HTTP ${res.status}.`);
  }
  return res;
}

/** Reads the inclusive byte range [start, end] of a remote file straight from the origin. */
export async function fetchOriginRange(file: MediaFile, cfg: RemoteConfig, start: number, end: number): Promise<Uint8Array> {
  const res = await remoteFetch(file.absPath, cfg, { Range: `bytes=${start}-${end}` });
  if (res.status !== 206) {
    await res.body?.cancel();
    throw new ApiError(502, "remote_unavailable", `The media server answered HTTP ${res.status} to a range request.`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length !== end - start + 1) throw new ApiError(502, "remote_unavailable", "The media server sent a short range.");
  return bytes;
}

/**
 * FFmpeg/ffprobe input options for a remote file: network protocols only (so the file
 * can't make FFmpeg open local paths), verified TLS, reconnect on drops.
 */
export function remoteInputArgs(cfg: RemoteConfig, url: string): string[] {
  // FFmpeg refuses TLS options on a plain http input, so they're only added for https.
  const tls = /^https:/i.test(url) ? ["-tls_verify", "1", "-ca_file", cfg.caFile] : [];
  // The in-cluster cache is usually plain http even when origins must be https.
  const viaCache = Boolean(cfg.cacheUrl) && url.startsWith(cfg.cacheUrl!.replace(/\/+$/, "") + "/");
  // wavy's own loopback server for AVI files with a rebuilt index (src/avi-index.ts).
  const loopback = url.startsWith(`http://127.0.0.1:`);
  return [
    "-protocol_whitelist", cfg.allowHttp || viaCache || loopback ? "https,tls,tcp,http" : "https,tls,tcp",
    ...tls,
    "-reconnect", "1",
    "-reconnect_on_network_error", "1",
    "-reconnect_delay_max", "5",
    // Microseconds: give up on a stalled read.
    "-rw_timeout", String(cfg.timeoutMs * 1000),
  ];
}
