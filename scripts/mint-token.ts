#!/usr/bin/env bun
/**
 * Signs a playback token the way the main server does. For local testing only.
 *
 *   bun scripts/mint-token.ts <private.pem> <path> [kid] [sub] [ttl]
 *   bun scripts/mint-token.ts keys/k1.private.pem cases/12/cam3.mp4 k1 user-42 10m
 *
 * Prints the token. Use it with: curl -H "Authorization: Bearer $TOKEN" ...
 */
import { importPKCS8, SignJWT } from "jose";

const [pemPath, path, kid = "k1", sub = "dev-user", ttl = "10m"] = process.argv.slice(2);
if (!pemPath || !path) {
  console.error("usage: bun scripts/mint-token.ts <private.pem> <path> [kid] [sub] [ttl]");
  process.exit(2);
}
const key = await importPKCS8(await Bun.file(pemPath).text(), "EdDSA");
const token = await new SignJWT({ path })
  .setProtectedHeader({ alg: "EdDSA", kid })
  .setSubject(sub)
  .setIssuer(process.env.JWT_ISSUER ?? "main")
  .setAudience(process.env.JWT_AUDIENCE ?? "wavy")
  .setIssuedAt()
  .setExpirationTime(ttl)
  .setJti(crypto.randomUUID())
  .sign(key);
console.log(token);
