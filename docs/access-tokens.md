# Access tokens: wiring wavy to the main server

Wavy plays a file only when the main server says the user may see it. The main
server says so by signing a short-lived token (a JWT) with a private key that only it
holds. Wavy checks the token with the matching public key.

The token is a wavy-only grant. It has nothing to do with how the main server logs
its own users in (sessions, cookies, anything else). Wavy never sees that login.

```
Browser                         Main server                         Wavy
  │  POST /media/token {path}  ──▶ │ is the user logged in?             │
  │                                │ may this user see this path?       │
  │  ◀── { token } (10 min) ────── │ sign {sub, path, aud, iss, exp…}   │
  │                                                                     │
  │  POST /api/sessions  Authorization: Bearer <token>  ──────────────▶ │ check signature, iss, aud,
  │  ◀───────────── { sessionId, mode, url: /api/sessions/{id}/… } ──── │ exp, path; start session
  │                                                                     │
  │  GET  {url}  (playlist, segments, Range requests, seek, stop) ────▶ │ the session id is the
  │      no token from here on                                          │ credential
```

There are four pieces to set up: the keys, wavy's settings, the token endpoint on
the main server, and the frontend. Sections 9 and 10 cover files on S3 (an `http(s)`
link in the token) and paths written with the share's full name.

## 1. Make the key pair (once)

From the wavy repo:

```bash
bun scripts/gen-token-keys.ts keys k1
```

This writes:

| File | Goes to | Secret? |
| --- | --- | --- |
| `keys/k1.private.pem` | The main server, as a secret (env var or mounted file) | **Yes.** Never give it to wavy, never commit it. |
| `keys/k1.private.jwk` | The same key as a JWK, if you prefer that format | Yes |
| `keys/jwks.json` | Wavy | No, it's the public key. |

`keys/` is in `.gitignore`. Store the private key in your secret manager, then delete
the local copy.

`k1` is the key id (`kid`). The main server puts it in each token's header, and wavy
uses it to pick the right public key. That's what makes key rotation possible
(section 6).

## 2. Configure wavy

| Variable | Value |
| --- | --- |
| `AUTH_MODE` | `jwt` |
| `JWT_JWKS_FILE` | Path to `jwks.json`, for example `/etc/wavy-token-keys/jwks.json`. Or `JWT_JWKS` with the JSON inline, or `JWT_JWKS_URL` (see below). |
| `JWT_ALGORITHMS` | `EdDSA` (default) |
| `JWT_ISSUER` | `main` (default). Must equal the token's `iss`. |
| `JWT_AUDIENCE` | `wavy` (default). Must equal the token's `aud`. |
| `JWT_CLOCK_TOLERANCE_SEC` | `60` (default). Allowed clock difference between the two servers. |
| `JWT_MAX_TOKEN_AGE_SEC` | `900` (default). Wavy refuses tokens issued longer ago than this, even if `exp` is later. Keep it at or above your token lifetime. |
| `CORS_ORIGINS` | Your web app's origin, for example `https://app.example.com`. The `Authorization` header is already allowed. |

Locally:

```bash
AUTH_MODE=jwt JWT_JWKS_FILE=keys/jwks.json MEDIA_ROOT=./samples bun run start
```

Docker: mount the file and set the same variables, for example
`-v $PWD/keys/jwks.json:/etc/wavy-token-keys/jwks.json:ro -e AUTH_MODE=jwt -e JWT_JWKS_FILE=/etc/wavy-token-keys/jwks.json`.

Wavy won't start with `AUTH_MODE=jwt` and no keys, with a JWKS that contains a private
key, or with a symmetric algorithm such as `HS256`. With `AUTH_MODE=none` (the default)
the API is open and wavy logs a warning at startup.

### Kubernetes

The base already sets `AUTH_MODE=jwt` and the other `JWT_*` values in the
`wavy-server-env` ConfigMap (`deploy/k8s/base/kustomization.yaml`). It mounts the
public keys from a Secret named `wavy-token-keys` at `/etc/wavy-token-keys/jwks.json`.
Create that Secret by hand, like the SMB credentials:

```bash
kubectl -n wavy create secret generic wavy-token-keys --from-file=jwks.json=keys/jwks.json
```

To change a setting in one environment, merge it in your overlay:

```yaml
configMapGenerator:
  - name: wavy-server-env
    behavior: merge
    literals:
      - CORS_ORIGINS=https://app.example.com
      - JWT_ISSUER=main
```

CI (`deploy/k8s/check-invariants.ts`) fails if an overlay turns `AUTH_MODE` off.

### Alternative: wavy fetches the keys from the main server

If the main server publishes its public keys at a URL (a JWKS endpoint, example in
section 3), set `JWT_JWKS_URL=https://main.internal/.well-known/jwks.json` instead of
`JWT_JWKS_FILE`. In Kubernetes, also remove the `token-keys` volume and mount in an
overlay. Wavy caches the keys for 10 minutes. A token with a `kid` it hasn't seen
makes it fetch again, at most once every 30 seconds. With this setup, rotating keys
needs no change on the wavy side.

## 3. The token endpoint on the main server (Node, `jose`)

```bash
npm i jose
```

Give the main server the private key, for example as the env var
`WAVY_SIGNING_KEY` (the contents of `k1.private.pem`) and `WAVY_SIGNING_KID=k1`.

```ts
// wavy-token.ts
import { importPKCS8, SignJWT, exportJWK, createPublicKey } from "jose";
import { randomUUID } from "node:crypto";
import path from "node:path/posix";

const KID = process.env.WAVY_SIGNING_KID ?? "k1";
const privateKey = await importPKCS8(process.env.WAVY_SIGNING_KEY!, "EdDSA");

/** Signs a 10-minute grant for one file (or a folder, when relPath ends in "/"). */
export async function signWavyToken(userId: string, relPath: string): Promise<string> {
  return new SignJWT({ path: relPath })
    .setProtectedHeader({ alg: "EdDSA", kid: KID })
    .setSubject(String(userId))  // any stable user id; wavy logs it and ties the session to it
    .setIssuer("main")           // = JWT_ISSUER on wavy
    .setAudience("wavy")         // = JWT_AUDIENCE on wavy
    .setIssuedAt()
    .setExpirationTime("10m")    // only used to start playback, so keep it short
    .setJti(randomUUID())        // unique id, appears in wavy's audit log
    .sign(privateKey);
}

/** Cleans a client path so it compares the way wavy compares it. Null if unsafe. */
export function cleanMediaPath(p: unknown): string | null {
  if (typeof p !== "string" || p.includes("\0")) return null;
  const unified = p.replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified) || unified.split("/").includes("..")) return null;
  const norm = path.normalize(unified).replace(/\/+$/, "");
  return norm && norm !== "." ? norm : null;
}
```

The endpoint, here with Express. Use your own login middleware and permission rules:

```ts
import express from "express";
import { signWavyToken, cleanMediaPath } from "./wavy-token.js";

const app = express();
app.use(express.json());

app.post("/media/token", requireLogin, async (req, res) => {
  const relPath = cleanMediaPath(req.body?.path);
  if (!relPath) return res.status(400).json({ error: "bad_path" });

  // The only place the "may this user see this file?" decision is made.
  if (!(await canUserViewMedia(req.user, relPath))) return res.status(403).json({ error: "forbidden" });

  const token = await signWavyToken(req.user.id, relPath);
  // Optional: record the grant on your side too (who, which file, when).
  res.set("Cache-Control", "no-store").json({ token, expiresIn: 600 });
});
```

Notes:

- `path` is relative to the media root that wavy sees (`MEDIA_ROOT`, the SMB share),
  for example `cases/12/cam3.mp4`, with forward slashes.
- A folder grant is a path ending in `/`, such as `cases/12/`. It lets the user open
  any file in that folder with one token. Wavy matches it as a prefix, so `cases/12/`
  never matches `cases/123/`. Prefer per-file tokens unless you need folders.
- Only for the `JWT_JWKS_URL` setup, publish the public key:

  ```ts
  const publicJwk = await exportJWK(createPublicKey(process.env.WAVY_SIGNING_KEY!));
  app.get("/.well-known/jwks.json", (_req, res) =>
    res.json({ keys: [{ ...publicJwk, kid: KID, alg: "EdDSA", use: "sig" }] }));
  ```

  This endpoint only needs to be reachable from wavy's pods, not from the internet.

## 4. The frontend

1. Ask the main server for a token for the file.
2. Start a wavy session with `Authorization: Bearer <token>`.
3. Play the `url` wavy returns (relative to wavy's base URL). Don't add the token to
   it: the session URL is the credential from here on, for HLS segments and for
   direct files (`/api/sessions/{id}/file`).
4. Stop the session when done (`DELETE /api/sessions/{id}`), as today.

With `player/wavy-player.js`, pass `getToken`. The player calls it once per
`load()`, and sends the token to the probe and the session start only:

```js
const player = new WavyPlayer(video, {
  Hls,
  apiBase: "https://wavy.example.com",
  getToken: async (path) => {
    const res = await fetch("/media/token", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (!res.ok) throw new Error(`token: HTTP ${res.status}`);
    return (await res.json()).token;
  },
});
await player.load("cases/12/cam3.mp4");
```

Without the player (the Angular directive, for example):

```ts
const { token } = await (await fetch('/media/token', {
  method: 'POST', credentials: 'include',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
})).json();

const res = await fetch(`${WAVY}/api/sessions`, {
  method: 'POST',
  credentials: 'include', // keeps the ingress affinity cookie, so all requests hit the same pod
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ path }),
});
const session = await res.json();   // { sessionId, mode, url, ... }
session.url = WAVY + session.url;   // give this to [streamSupport] / <video> / hls.js
```

Get a fresh token for each new file or each new session. A token that expires
during playback does nothing: the session keeps working until it's stopped, goes
idle (HLS), or reaches `SESSION_MAX_AGE_MS` (4 h by default).

What wavy answers when something is wrong:

| Status | Meaning |
| --- | --- |
| `401 unauthorized` | No token, a bad signature, wrong `iss`/`aud`, expired, unknown `kid`. Get a new token. |
| `403 forbidden` | The token is valid but its `path` doesn't cover the requested file. |

## 5. Try it end to end

```bash
bun scripts/gen-token-keys.ts keys k1
AUTH_MODE=jwt JWT_JWKS_FILE=keys/jwks.json MEDIA_ROOT=./samples bun run start &

TOKEN=$(bun scripts/mint-token.ts keys/k1.private.pem video/mp4_h264_aac.mp4 k1 user-42)
curl -s -X POST localhost:8080/api/sessions \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'
# {"sessionId":"…","mode":"direct","url":"/api/sessions/…/file",…}
curl -s -o /dev/null -w '%{http_code}\n' -H 'Range: bytes=0-99' localhost:8080/api/sessions/<id>/file   # 206
```

`scripts/mint-token.ts` signs a token exactly as the main server should, so it's also
a reference for comparing tokens when something doesn't match.

## 6. Rotating the key

1. `bun scripts/gen-token-keys.ts keys k2`. This adds `k2` to `keys/jwks.json` next to `k1`.
2. Give wavy the new `jwks.json`, which holds both keys:
   `kubectl -n wavy create secret generic wavy-token-keys --from-file=jwks.json=keys/jwks.json --dry-run=client -o yaml | kubectl apply -f -`
   and then `kubectl -n wavy rollout restart deploy/wavy-server`, because wavy reads the
   file at startup. (With `JWT_JWKS_URL`, skip this step.)
3. Switch the main server to `k2` (`WAVY_SIGNING_KEY`, `WAVY_SIGNING_KID=k2`).
4. After 15 minutes, no `k1` tokens are left. Remove `k1` from `jwks.json` and update
   the Secret again.

## 7. Revoking access

Stop issuing tokens to the user. Their existing tokens expire within minutes. To
also end playback that has already started, stop their sessions
(`DELETE /api/sessions/{id}`), or restart the pods in an emergency. Every
`session_started` log line has the user (`sub`) and token id (`jti`).

## 8. Audit log and troubleshooting

Wavy writes JSON lines to stdout:

| Event | Fields |
| --- | --- |
| `session_started` | `user` (sub), `tokenId` (jti), `path`, `mode`, `sessionId` |
| `session_ended` | `user`, `path`, `cause`, `openSeconds` |
| `file_served` | `/api/files` downloads: `user`, `tokenId`, `path`, `range` |
| `token_rejected` | `why`: `ERR_JWT_EXPIRED`, `ERR_JWS_SIGNATURE_VERIFICATION_FAILED`, `ERR_JWT_CLAIM_VALIDATION_FAILED` (wrong `iss`/`aud`, missing claim, too old), `ERR_JWKS_NO_MATCHING_KEY` (unknown `kid`), `ERR_JOSE_ALG_NOT_ALLOWED`, `bad_claims` (bad `path`) |
| `access_denied` | `user`, `grant` (token path), `path` (requested) |

Common mistakes:

- `ERR_JWT_CLAIM_VALIDATION_FAILED`: the main server's `iss`/`aud` differ from
  `JWT_ISSUER`/`JWT_AUDIENCE`, or a token is older than `JWT_MAX_TOKEN_AGE_SEC`.
- `ERR_JWKS_NO_MATCHING_KEY`: the `kid` in the token isn't in wavy's `jwks.json`.
- Expired right away: the two servers' clocks differ by more than 60 s. Fix NTP.
- `403` for a file that should be allowed: compare the `grant` and `path` fields of
  `access_denied`. Case and leading folders must match exactly.

## 9. Files on S3 (an http(s) link in the token)

When the file isn't on the share, put a link to it in the token's `path`, for example
an S3 presigned GET URL. Wavy then plays from that link and doesn't touch the share.
Nothing else changes for the frontend.

**Wavy:**

```bash
REMOTE_ALLOWED_HOSTS=my-bucket.s3.eu-west-1.amazonaws.com   # or *.amazonaws.com, minio.internal:9000
# REMOTE_ALLOW_HTTP=true          only for a plain-http store inside the cluster
# REMOTE_CA_FILE=/etc/wavy/ca.pem for a store with a private CA
```

In Kubernetes, add these to `wavy-server-env` in your overlay. The pods also need egress
to that host (NetworkPolicy, firewall, proxy).

**Main server:**

```ts
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({ region: "eu-west-1" });

// Instead of signWavyToken(user.id, "cases/12/cam3.mp4"):
const link = await getSignedUrl(s3, new GetObjectCommand({ Bucket: "my-bucket", Key: "cases/12/cam3.mp4" }), {
  expiresIn: 4 * 60 * 60, // the whole viewing: wavy opens the link again on every seek
});
const token = await signWavyToken(user.id, link);
```

The frontend calls `POST /api/sessions` with the token and an empty body (or
`{ "path": <the same link> }`). Wavy picks the link up from the token.

**What wavy enforces:**

- Only hosts on `REMOTE_ALLOWED_HOSTS` are fetched, https only by default. A link with
  `user:password@` is refused, and so is a redirect. This stops the token from being
  used to make wavy reach internal services (SSRF).
- A URL grant covers exactly that URL. A share grant never opens a URL, and a URL grant
  never opens a share file. This is checked before anything is fetched.
- FFmpeg may only use network protocols (`https,tls,tcp`), so a crafted remote file
  can't make it read local files. It also verifies TLS certificates (`-tls_verify 1`),
  which FFmpeg doesn't do by default.
- Presigned URLs only allow GET, so wavy reads the file size with a one-byte `Range`
  GET. Browser Range requests for direct files are passed through to the store.
- The link's query string (the signature) never appears in logs or API responses.
  They show `https://host/path` only.

**Two things to know:**

1. **The browser can read the link.** A JWT is signed, not encrypted, so anyone holding
   the token can decode it and fetch the presigned URL directly from S3 until it
   expires, bypassing wavy and its audit log. If that matters, the next step is an
   `s3://bucket/key` path in the token. Wavy would then hold read-only S3 credentials
   and presign the link itself, so the browser never sees a usable link.
2. **The link must outlive the session.** Wavy opens the link again for every seek and
   every restart of a transcode. A 15-minute presign would break seeking after 15
   minutes. Presign it for as long as a viewing can last, up to `SESSION_MAX_AGE_MS`
   (4 h by default).

## 10. Paths with the share's full name (`MEDIA_PATH_PREFIXES`)

Wavy compares paths relative to the share root (`cases/12/cam3.mp4`). If parts of your
system store the full name, for example `\\fileserver\media\cases\12\cam3.mp4`,
`smb://fileserver/media/...` or `/mnt/media/...`, list those roots:

```bash
MEDIA_PATH_PREFIXES='\\fileserver\media\,smb://fileserver/media/,/mnt/media/'
```

Wavy removes a matching root from the front of the path, in requests and in tokens
alike. Letter case is ignored and the longest root wins. Then it checks the path as
usual, so `..` and paths that leave the share are still refused.

Recommendations:

- **One canonical form, made by the main server.** The main server writes the token,
  so convert paths there once (relative to the share, forward slashes). The prefix
  list is a safety net for full paths that slip through.
- **Never guess.** If a path is missing a folder (`12/cam3.mp4` instead of
  `cases/12/cam3.mp4`), wavy answers 404 instead of searching for the file. A search
  could grant the wrong file.
- **Letter case:** the share ignores case, but the token check compares exactly. A
  token for `Cases/12/` doesn't cover `cases/12/x.mp4`, so the request is refused
  rather than allowed. To avoid it, store paths in the case the share reports (as
  `bun run scan` lists them).
- **Folder grants end in `/`.** `cases/12/` covers `cases/12/a.mp4` but not
  `cases/123/a.mp4`.
