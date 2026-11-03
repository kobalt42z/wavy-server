#!/usr/bin/env bun
/**
 * Makes the key pair for playback access tokens.
 *
 *   bun scripts/gen-token-keys.ts [outDir] [kid]     # defaults: ./keys, k<yyyymmdd>
 *
 * Writes:
 *   <kid>.private.pem   PKCS#8 Ed25519 private key. For the main server only; keep it secret.
 *   <kid>.private.jwk   The same private key as a JWK, if the main server prefers that.
 *   jwks.json           The public key set for wavy (JWT_JWKS_FILE). On rotation, the
 *                       new key is added next to the ones already in the file.
 */
import { exportJWK, exportPKCS8, generateKeyPair, type JWK } from "jose";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outDir = process.argv[2] ?? "keys";
const kid = process.argv[3] ?? `k${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
if (!/^[A-Za-z0-9._-]{1,64}$/.test(kid)) throw new Error(`kid must be letters, digits, ".", "_" or "-" (got "${kid}")`);

mkdirSync(outDir, { recursive: true, mode: 0o700 });
const privPem = join(outDir, `${kid}.private.pem`);
if (existsSync(privPem)) throw new Error(`${privPem} already exists; pick another kid`);

const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
writeFileSync(privPem, await exportPKCS8(privateKey), { mode: 0o600 });
writeFileSync(join(outDir, `${kid}.private.jwk`), JSON.stringify({ ...(await exportJWK(privateKey)), kid, alg: "EdDSA" }, null, 2) + "\n", { mode: 0o600 });

const jwksPath = join(outDir, "jwks.json");
const existing: { keys: JWK[] } = existsSync(jwksPath) ? JSON.parse(readFileSync(jwksPath, "utf8")) : { keys: [] };
existing.keys = existing.keys.filter((k) => k.kid !== kid);
existing.keys.push({ ...(await exportJWK(publicKey)), kid, alg: "EdDSA", use: "sig" });
writeFileSync(jwksPath, JSON.stringify(existing, null, 2) + "\n");

console.log(`kid:          ${kid}`);
console.log(`private key:  ${privPem}  (main server only)`);
console.log(`public keys:  ${jwksPath}  (${existing.keys.length} key(s); give this to wavy)`);
