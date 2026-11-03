/**
 * Access tokens: the main server signs a short-lived grant, wavy checks it once at the
 * endpoints that take a path, and the session URL carries playback from there.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grantCovers, normalizeGrantPath } from "../src/auth.ts";
import { loadConfig, type AuthConfig } from "../src/config.ts";
import { samplesDir, startServer, type TestServer } from "./helpers/server.ts";

let media: string;
let srv: TestServer;
let priv: CryptoKey;
let pubJwk: JWK;
let otherPriv: CryptoKey;

const authConfig = (jwks: JWK[]): AuthConfig => ({
  ...loadConfig({}).auth,
  mode: "jwt",
  jwks: JSON.stringify({ keys: jwks }),
});

interface TokenOpts {
  path?: unknown;
  sub?: string;
  aud?: string;
  iss?: string;
  exp?: number | string;
  iat?: number;
  key?: CryptoKey;
  kid?: string;
  jti?: string | null;
}

async function token(o: TokenOpts = {}): Promise<string> {
  const claims: Record<string, unknown> = {};
  if (o.path !== undefined) claims.path = o.path;
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: o.kid ?? "k1" })
    .setSubject(o.sub ?? "user-1")
    .setIssuer(o.iss ?? "main")
    .setAudience(o.aud ?? "wavy")
    .setIssuedAt(o.iat)
    .setExpirationTime(o.exp ?? "10m");
  if (o.jti !== null) jwt.setJti(o.jti ?? crypto.randomUUID());
  return jwt.sign(o.key ?? priv);
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const now = () => Math.floor(Date.now() / 1000);

beforeAll(async () => {
  const samples = await samplesDir();
  media = mkdtempSync(join(tmpdir(), "wavy-auth-media-"));
  for (const d of ["cases/12", "cases/123", "cases/13"]) mkdirSync(join(media, d), { recursive: true });
  copyFileSync(join(samples, "video/mp4_h264_aac.mp4"), join(media, "cases/12/clip.mp4"));
  copyFileSync(join(samples, "video/ts_h264_aac.ts"), join(media, "cases/12/cam.ts"));
  copyFileSync(join(samples, "video/mp4_h264_aac.mp4"), join(media, "cases/123/clip.mp4"));
  copyFileSync(join(samples, "video/mp4_h264_aac.mp4"), join(media, "cases/13/secret.mp4"));
  // A link inside a granted folder that points outside it.
  symlinkSync(join(media, "cases/13/secret.mp4"), join(media, "cases/12/link.mp4"));

  const kp = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  priv = kp.privateKey;
  pubJwk = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "EdDSA", use: "sig" };
  otherPriv = (await generateKeyPair("EdDSA", { crv: "Ed25519" })).privateKey;

  srv = await startServer(media, { auth: authConfig([pubJwk]) });
}, 180_000);

afterAll(async () => {
  await srv?.close();
  if (media) rmSync(media, { recursive: true, force: true });
});

describe("grant paths", () => {
  test("normalizeGrantPath cleans paths and keeps the folder slash", () => {
    expect(normalizeGrantPath("cases/12/clip.mp4")).toBe("cases/12/clip.mp4");
    expect(normalizeGrantPath("cases//12/./clip.mp4")).toBe("cases/12/clip.mp4");
    expect(normalizeGrantPath("cases\\12\\")).toBe("cases/12/");
    expect(normalizeGrantPath("cases/12/")).toBe("cases/12/");
    for (const bad of ["", " ", "/etc/passwd", "C:/x", "../x", "cases/../13/", "a\0b", ".", "./", 42, null]) {
      expect({ bad, got: normalizeGrantPath(bad) }).toEqual({ bad, got: null });
    }
  });

  test("a file grant is exact; a folder grant is a prefix ending in /", () => {
    expect(grantCovers("cases/12/clip.mp4", "cases/12/clip.mp4")).toBe(true);
    expect(grantCovers("cases/12/clip.mp4", "cases/12/clip.mp4.bak")).toBe(false);
    expect(grantCovers("cases/12/", "cases/12/clip.mp4")).toBe(true);
    expect(grantCovers("cases/12/", "cases/123/clip.mp4")).toBe(false);
    expect(grantCovers("cases/12", "cases/12/clip.mp4")).toBe(false);
  });
});

describe("config", () => {
  test("AUTH_MODE=jwt needs keys, and only asymmetric algorithms are allowed", () => {
    expect(() => loadConfig({ AUTH_MODE: "jwt" })).toThrow(/public keys/);
    expect(() => loadConfig({ AUTH_MODE: "jwt", JWT_JWKS_URL: "https://main/jwks", JWT_ALGORITHMS: "HS256" })).toThrow(/not allowed/);
    expect(() => loadConfig({ AUTH_MODE: "jwt", JWT_JWKS_URL: "https://main/jwks", JWT_ALGORITHMS: "none" })).toThrow(/not allowed/);
    expect(() => loadConfig({ AUTH_MODE: "maybe" })).toThrow(/AUTH_MODE/);
    expect(loadConfig({ AUTH_MODE: "jwt", JWT_JWKS_URL: "https://main/jwks" }).auth).toMatchObject({
      mode: "jwt",
      algorithms: ["EdDSA"],
      issuer: "main",
      audience: "wavy",
      clockToleranceSec: 60,
    });
  });

  test("a JWKS holding a private key is refused at startup", async () => {
    const kp = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    const privJwk = await exportJWK(kp.privateKey);
    await expect(startServer(media, { auth: authConfig([privJwk]) })).rejects.toThrow(/private key/);
  });
});

describe("POST /api/sessions with a token", () => {
  test("no token is 401 with a Bearer challenge", async () => {
    const res = await post(`${srv.base}/api/sessions`, { path: "cases/12/clip.mp4" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(await res.json()).toMatchObject({ error: "unauthorized" });
  });

  test("a token in the URL is not accepted", async () => {
    const t = await token({ path: "cases/12/clip.mp4" });
    const res = await post(`${srv.base}/api/sessions?token=${t}&access_token=${t}`, { path: "cases/12/clip.mp4" });
    expect(res.status).toBe(401);
  });

  test("bad tokens are 401", async () => {
    const path = "cases/12/clip.mp4";
    const cases: Record<string, string> = {
      "wrong key": await token({ path, key: otherPriv }),
      "wrong audience": await token({ path, aud: "other" }),
      "wrong issuer": await token({ path, iss: "someone" }),
      "expired past the skew allowance": await token({ path, iat: now() - 300, exp: now() - 120 }),
      "unknown kid": await token({ path, kid: "k9" }),
      "too old (iat)": await token({ path, iat: now() - 3600, exp: now() + 600 }),
      "no jti": await token({ path, jti: null }),
      "no path": await token({}),
      "traversal path": await token({ path: "../etc/" }),
      garbage: "not.a.jwt",
    };
    // alg "none", and HS256 signed with the public key as the secret (algorithm confusion).
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const body = b64({ sub: "user-1", path, iss: "main", aud: "wavy", iat: now(), exp: now() + 600, jti: "x" });
    cases["alg none"] = `${b64({ alg: "none", kid: "k1" })}.${body}.`;
    const hsInput = `${b64({ alg: "HS256", kid: "k1" })}.${body}`;
    const hmacKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(JSON.stringify(pubJwk)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = Buffer.from(await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(hsInput))).toString("base64url");
    cases["HS256 with the public key"] = `${hsInput}.${sig}`;

    for (const [name, t] of Object.entries(cases)) {
      const res = await post(`${srv.base}/api/sessions`, { path }, bearer(t));
      expect({ name, status: res.status }).toEqual({ name, status: 401 });
    }
  });

  test("a token just past exp still works inside the clock skew allowance", async () => {
    const t = await token({ path: "cases/12/clip.mp4", iat: now() - 60, exp: now() - 20 });
    const res = await post(`${srv.base}/api/sessions`, { path: "cases/12/clip.mp4" }, bearer(t));
    expect(res.status).toBe(201);
  });

  test("a token for another file is 403", async () => {
    const t = await token({ path: "cases/12/clip.mp4" });
    for (const path of ["cases/123/clip.mp4", "cases/13/secret.mp4", "cases/12/cam.ts"]) {
      const res = await post(`${srv.base}/api/sessions`, { path }, bearer(t));
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
  });

  test("a folder grant covers its files only, not a sibling with the same prefix", async () => {
    const t = await token({ path: "cases/12/" });
    expect((await post(`${srv.base}/api/sessions`, { path: "cases/12/clip.mp4" }, bearer(t))).status).toBe(201);
    expect((await post(`${srv.base}/api/sessions`, { path: "cases/12//./clip.mp4" }, bearer(t))).status).toBe(201);
    expect((await post(`${srv.base}/api/sessions`, { path: "cases/123/clip.mp4" }, bearer(t))).status).toBe(403);
    // A symlink inside the folder that leads out of it.
    expect((await post(`${srv.base}/api/sessions`, { path: "cases/12/link.mp4" }, bearer(t))).status).toBe(403);
  });

  test("the body path may be left out for a file grant", async () => {
    const t = await token({ path: "cases/12/clip.mp4" });
    const res = await post(`${srv.base}/api/sessions`, {}, bearer(t));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { mode: string }).mode).toBe("direct");
    // A folder grant doesn't say which file.
    expect((await post(`${srv.base}/api/sessions`, {}, bearer(await token({ path: "cases/12/" })))).status).toBe(400);
  });

  test("the session records the token's user and id", async () => {
    const jti = crypto.randomUUID();
    const t = await token({ path: "cases/12/clip.mp4", sub: "alice", jti });
    const s = (await (await post(`${srv.base}/api/sessions`, {}, bearer(t))).json()) as { sessionId: string };
    expect(srv.sessions.get(s.sessionId)).toMatchObject({ ownerId: "alice", tokenId: jti, relPath: "cases/12/clip.mp4" });
  });
});

describe("after the session starts, the session URL is the credential", () => {
  test("direct: the file plays from the session URL with Range, without a token", async () => {
    const t = await token({ path: "cases/12/clip.mp4" });
    const s = (await (await post(`${srv.base}/api/sessions`, {}, bearer(t))).json()) as { sessionId: string; url: string; mode: string };
    expect(s.url).toBe(`/api/sessions/${s.sessionId}/file`);
    const part = await fetch(srv.base + s.url, { headers: { Range: "bytes=0-99" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-type")).toBe("video/mp4");
    expect((await part.arrayBuffer()).byteLength).toBe(100);
    expect((await fetch(srv.base + s.url, { method: "HEAD" })).status).toBe(200);
    // An expired token sent along by a fetch wrapper is ignored here.
    const stale = await token({ path: "cases/12/clip.mp4", iat: now() - 900, exp: now() - 600 });
    expect((await fetch(srv.base + s.url, { headers: { Range: "bytes=0-9", ...bearer(stale) } })).status).toBe(206);

    expect((await fetch(`${srv.base}/api/sessions/${s.sessionId}`, { method: "DELETE" })).status).toBe(204);
    expect((await fetch(srv.base + s.url, { headers: { Range: "bytes=0-9" } })).status).toBe(404);
  });

  test("HLS: playlist and segments play without a token", async () => {
    const t = await token({ path: "cases/12/cam.ts" });
    const s = (await (await post(`${srv.base}/api/sessions`, {}, bearer(t))).json()) as { sessionId: string; url: string; mode: string };
    expect(s.mode).toBe("remux");
    const playlist = await (await fetch(srv.base + s.url)).text();
    const seg = playlist.split("\n").find((l) => l && !l.startsWith("#"))!;
    expect((await fetch(`${srv.base}/api/sessions/${s.sessionId}/${seg}`)).status).toBe(200);
    expect((await post(`${srv.base}/api/sessions/${s.sessionId}/seek`, { position: 1 })).status).toBe(200);
    await fetch(`${srv.base}/api/sessions/${s.sessionId}`, { method: "DELETE" });
  });

  test("a direct session's file URL can't be guessed into another session's file", async () => {
    expect((await fetch(`${srv.base}/api/sessions/AAAAAAAAAAAAAAAAAAAAAAAA/file`)).status).toBe(404);
  });
});

describe("other endpoints that take a path", () => {
  test("probe needs a token covering the path", async () => {
    expect((await fetch(`${srv.base}/api/probe?path=cases/12/clip.mp4`)).status).toBe(401);
    const t = await token({ path: "cases/12/clip.mp4" });
    expect((await fetch(`${srv.base}/api/probe?path=cases/12/clip.mp4`, { headers: bearer(t) })).status).toBe(200);
    expect((await fetch(`${srv.base}/api/probe?path=cases/13/secret.mp4`, { headers: bearer(t) })).status).toBe(403);
  });

  test("/api/files needs a token covering the path", async () => {
    expect((await fetch(`${srv.base}/api/files/cases/12/clip.mp4`)).status).toBe(401);
    const t = await token({ path: "cases/12/" });
    expect((await fetch(`${srv.base}/api/files/cases/12/clip.mp4`, { headers: { Range: "bytes=0-9", ...bearer(t) } })).status).toBe(206);
    expect((await fetch(`${srv.base}/api/files/cases/13/secret.mp4`, { headers: bearer(t) })).status).toBe(403);
  });

  test("health, metrics and CORS preflight need no token", async () => {
    expect((await fetch(`${srv.base}/healthz`)).status).toBe(200);
    expect((await fetch(`${srv.base}/metrics`)).status).toBe(200);
    const pre = await fetch(`${srv.base}/api/sessions`, {
      method: "OPTIONS",
      headers: { Origin: "http://app.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");
  });
});

test("keys can come from a JWKS URL, and a new kid is picked up (key rotation)", async () => {
  const keys: JWK[] = [pubJwk];
  let fetches = 0;
  const jwksServer = Bun.serve({
    port: 0,
    fetch: () => {
      fetches++;
      return Response.json({ keys });
    },
  });
  const remote = await startServer(media, {
    auth: { ...authConfig([]), jwks: undefined, jwksUrl: `http://127.0.0.1:${jwksServer.port}/.well-known/jwks.json`, jwksCooldownSec: 0 },
  });
  try {
    const ok = await post(`${remote.base}/api/sessions`, {}, bearer(await token({ path: "cases/12/clip.mp4" })));
    expect(ok.status).toBe(201);

    const kp2 = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    keys.push({ ...(await exportJWK(kp2.publicKey)), kid: "k2", alg: "EdDSA" });
    const rotated = await post(`${remote.base}/api/sessions`, {}, bearer(await token({ path: "cases/12/clip.mp4", key: kp2.privateKey, kid: "k2" })));
    expect(rotated.status).toBe(201);
    expect(fetches).toBe(2);
  } finally {
    await remote.close();
    await jwksServer.stop(true);
  }
});

test("direct sessions are not ended for being idle (a paused <video> sends nothing)", async () => {
  const idle = await startServer(media, { idleTimeoutMs: 200, reapIntervalMs: 50, auth: authConfig([pubJwk]) });
  try {
    const t = await token({ path: "cases/12/" });
    const direct = (await (await post(`${idle.base}/api/sessions`, { path: "cases/12/clip.mp4" }, bearer(t))).json()) as { sessionId: string };
    const hls = (await (await post(`${idle.base}/api/sessions`, { path: "cases/12/cam.ts" }, bearer(t))).json()) as { sessionId: string };
    await Bun.sleep(600);
    expect(idle.sessions.get(direct.sessionId)).toBeDefined();
    expect(idle.sessions.get(hls.sessionId)).toBeUndefined();
  } finally {
    await idle.close();
  }
});
