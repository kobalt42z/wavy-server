import { contentTypeFor, parseRange } from "./files.ts";
import { ApiError, badRequest } from "./http/errors.ts";
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
async function remoteFetch(url: string, cfg: RemoteConfig, headers: Record<string, string>): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
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
 */
export async function openRemote(raw: string, cfg: RemoteConfig): Promise<MediaFile> {
  const u = checkRemoteUrl(raw, cfg);
  const url = u.toString();
  const res = await remoteFetch(url, cfg, { Range: "bytes=0-0" });
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

  const upstreamRange = range.kind === "partial" ? `bytes=${range.start}-${range.end}` : undefined;
  const res = await remoteFetch(file.absPath, cfg, upstreamRange ? { Range: upstreamRange } : {});
  if (res.status === 403 || res.status === 401) {
    await res.body?.cancel();
    throw new ApiError(502, "remote_denied", "The media server refused the link (it may have expired).");
  }
  if (res.status !== 200 && res.status !== 206) {
    await res.body?.cancel();
    throw new ApiError(502, "remote_unavailable", `The media server answered HTTP ${res.status}.`);
  }
  for (const h of ["content-length", "content-range"]) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(res.body, { status: res.status, headers });
}

/**
 * FFmpeg/ffprobe input options for a remote file: network protocols only (so the file
 * can't make FFmpeg open local paths), verified TLS, reconnect on drops.
 */
export function remoteInputArgs(cfg: RemoteConfig, url: string): string[] {
  // FFmpeg refuses TLS options on a plain http input, so they're only added for https.
  const tls = /^https:/i.test(url) ? ["-tls_verify", "1", "-ca_file", cfg.caFile] : [];
  return [
    "-protocol_whitelist", cfg.allowHttp ? "https,tls,tcp,http" : "https,tls,tcp",
    ...tls,
    "-reconnect", "1",
    "-reconnect_on_network_error", "1",
    "-reconnect_delay_max", "5",
    // Microseconds: give up on a stalled read.
    "-rw_timeout", String(cfg.timeoutMs * 1000),
  ];
}
