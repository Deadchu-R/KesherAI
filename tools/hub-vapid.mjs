#!/usr/bin/env node
// Prints a new VAPID key pair for the Kesher Cloud hub's notifications (Web Push, RFC 8292), in the form the hub's
// Worker variables take (apps/hub/README.md, "Notifications"):
//   VAPID_PUBLIC_KEY   plain variable: base64url, 65 bytes (uncompressed P-256 point); the page gets it from /api/config
//   VAPID_PRIVATE_KEY  SECRET: base64url, the 32-byte private value "d"
// Run: node tools/hub-vapid.mjs   (nothing is written to disk; paste the private key into Cloudflare yourself and
// never into a file in this repository).
/* global Buffer, console */
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pub = publicKey.export({ format: "jwk" });
const priv = privateKey.export({ format: "jwk" });
const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, "base64url"), Buffer.from(pub.y, "base64url")]);

console.log(`VAPID_PUBLIC_KEY=${raw.toString("base64url")}`);
console.log(`VAPID_PRIVATE_KEY=${priv.d}`);
console.log("VAPID_SUBJECT=https://<your hub address>   (or mailto:<an address you read>)");
console.log("\nThe private key is a secret: Cloudflare dashboard > the Worker > Settings > Variables and Secrets > type Secret.");
