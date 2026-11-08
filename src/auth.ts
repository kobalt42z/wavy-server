import type { MiddlewareHandler } from "hono";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import { posix } from "node:path";
import type { AuthConfig } from "./config.ts";
import { ApiError } from "./http/errors.ts";
import { log } from "./log.ts";
import { stripRootPrefix, type MediaFile } from "./media-path.ts";
import { isRemoteUrl, redactUrl } from "./remote.ts";

/**
 * Playback access tokens.
 *
 * The main server decides who may watch what. When it says yes, it signs a short-lived
 * JWT (a "grant") with its private key: `sub` (user id), `path` (file, or folder ending
 * in "/", relative to the media root), `iss`, `aud`, `exp`, `iat`, `jti`, and a `kid`
 * header. Wavy only holds the public key, so it can check grants but never make them.
 *
 * The grant is checked once, where a path comes in: `GET /api/probe`, `POST /api/sessions`
 * and `/api/files/*`. It is sent as `Authorization: Bearer <token>`, never in a URL.
 * After that the session URL is the credential: its id is 144 random bits, so the
 * playlist, segments, seeks and Range requests need no token, and a token that expires
 * mid-video never interrupts playback.
 *
 * With AUTH_MODE=none (the default, for development) every request is allowed.
 */
export interface AuthUser {
  id: string;
  name?: string;
  /** The grant this user presented, when auth is on. */
  grant?: Grant;
}

export interface Grant {
  /**
   * Normalized path relative to the media root, ending in "/" for a folder grant;
   * or, when `remote`, the full http(s) URL to play.
   */
  path: string;
  remote?: boolean;
  /** Token id (jti), for the audit log. */
  tokenId: string;
  /** Expiry, seconds since the epoch. */
  expiresAt: number;
}

export type AppEnv = { Variables: { user: AuthUser | null } };

/** Sets `user` to null on every /api request; `requireGrant` replaces it where needed. */
export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("user", null);
  await next();
};

/** May this user view this file? */
export function canViewPath(user: AuthUser | null, file: Pick<MediaFile, "relPath" | "realRelPath" | "absPath" | "remote">): boolean {
  const grant = user?.grant;
  if (!grant) return false;
  // A URL grant covers exactly that URL; a share grant never covers a URL.
  if (grant.remote || file.remote) return Boolean(grant.remote && file.remote && grant.path === file.absPath);
  // A symlink inside a granted folder must not lead to a file outside it.
  return grantCovers(grant.path, file.relPath) && grantCovers(grant.path, file.realRelPath);
}

/**
 * May this request use this session? The unguessable session id is the credential,
 * so a request without a user (an hls.js segment fetch, a <video> Range request) is
 * allowed. A request that does carry a user must be the session's owner.
 */
export function canUseSession(user: AuthUser | null, ownerId: string | null): boolean {
  return user === null || ownerId === null || ownerId === user.id;
}

/** Exact match for a file grant; prefix match for a folder grant (ends in "/"). */
export function grantCovers(grantPath: string, relPath: string): boolean {
  return grantPath.endsWith("/") ? relPath.startsWith(grantPath) : relPath === grantPath;
}

/**
 * Normalizes the `path` claim the way the media resolver normalizes request paths:
 * forward slashes, no "." or empty segments. Keeps a trailing "/" (folder grant).
 * Returns null for anything that isn't a clean relative path.
 */
export function normalizeGrantPath(raw: unknown, rootPrefixes: string[] = []): string | null {
  if (typeof raw !== "string" || raw.trim() === "" || raw.includes("\0")) return null;
  const unified = stripRootPrefix(raw, rootPrefixes).replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified)) return null;
  if (unified.split("/").includes("..")) return null;
  const folder = unified.endsWith("/");
  const norm = posix.normalize(unified).replace(/\/+$/, "");
  if (norm === "" || norm === "." || norm.startsWith("../")) return null;
  return folder ? `${norm}/` : norm;
}

export interface Auth {
  enabled: boolean;
  /**
   * Middleware for the endpoints that take a path. With auth on, it verifies the
   * Bearer token and sets `user`; 401 when the token is missing or invalid.
   */
  requireGrant: MiddlewareHandler<AppEnv>;
  /** May the current user see this file? Always true with auth off. */
  allows(user: AuthUser | null, file: MediaFile): boolean;
}

const unauthorized = (reason: string) =>
  new ApiError(401, "unauthorized", reason, { "WWW-Authenticate": 'Bearer realm="wavy"' });

export function createAuth(cfg: AuthConfig, rootPrefixes: string[] = []): Auth {
  if (cfg.mode === "none") {
    return { enabled: false, requireGrant: async (_c, next) => next(), allows: () => true };
  }

  const keys = loadKeys(cfg);

  const verify = async (token: string): Promise<AuthUser> => {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        algorithms: cfg.algorithms,
        issuer: cfg.issuer,
        audience: cfg.audience,
        clockTolerance: cfg.clockToleranceSec,
        maxTokenAge: cfg.maxTokenAgeSec,
        requiredClaims: ["sub", "exp", "iat", "jti"],
      }));
    } catch (err) {
      const why = err instanceof joseErrors.JOSEError ? err.code : "ERR_UNKNOWN";
      log("warn", "token_rejected", { why, error: err instanceof Error ? err.message : String(err) });
      if (err instanceof joseErrors.JWTExpired) throw unauthorized("The access token has expired. Ask for a new one.");
      throw unauthorized("The access token is not valid.");
    }
    const remote = isRemoteUrl(payload.path);
    const path = remote ? normalizeUrl(payload.path as string) : normalizeGrantPath(payload.path, rootPrefixes);
    if (!path || typeof payload.sub !== "string" || payload.sub === "" || typeof payload.jti !== "string") {
      log("warn", "token_rejected", { why: "bad_claims", sub: payload.sub, jti: payload.jti });
      throw unauthorized("The access token is not valid.");
    }
    const grant: Grant = { path, tokenId: payload.jti, expiresAt: payload.exp! };
    if (remote) grant.remote = true;
    return { id: payload.sub, grant };
  };

  return {
    enabled: true,
    requireGrant: async (c, next) => {
      const header = c.req.header("authorization") ?? "";
      const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
      if (!m) throw unauthorized("An access token is required (Authorization: Bearer <token>).");
      c.set("user", await verify(m[1]!));
      await next();
    },
    allows: canViewPath,
  };
}

/** The URL as `new URL()` writes it, so a grant and a request compare equal. */
function normalizeUrl(raw: string): string | null {
  try {
    return new URL(raw.trim()).toString();
  } catch {
    return null;
  }
}

/** A grant's path, safe for logs (a URL grant loses its query). */
export function grantLabel(grant: Grant | undefined): string | undefined {
  if (!grant) return undefined;
  return grant.remote ? redactUrl(grant.path) : grant.path;
}

function loadKeys(cfg: AuthConfig): JWTVerifyGetKey {
  if (cfg.jwks) {
    let set: JSONWebKeySet;
    try {
      set = JSON.parse(cfg.jwks) as JSONWebKeySet;
    } catch {
      throw new Error("The JWKS (JWT_JWKS / JWT_JWKS_FILE) is not valid JSON");
    }
    if (!Array.isArray(set?.keys) || set.keys.length === 0) throw new Error('The JWKS must look like {"keys":[...]}');
    for (const k of set.keys) {
      if ("d" in k) throw new Error("The JWKS contains a private key. Give wavy the public key only.");
    }
    return createLocalJWKSet(set);
  }
  // Cached for 10 min. A token with an unknown kid (key rotation) triggers a refetch,
  // at most once per cooldown.
  return createRemoteJWKSet(new URL(cfg.jwksUrl!), {
    cacheMaxAge: 10 * 60_000,
    cooldownDuration: cfg.jwksCooldownSec * 1000,
  });
}
