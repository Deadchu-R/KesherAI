/**
 * Signed device tokens (`kh2_…`): a device token that carries its own claims (device id, kind, issue time) and an
 * HMAC-SHA-256 over them, so the hub can tell who calls without reading storage (a day Cloudflare refuses reads or
 * writes). The HMAC key is derived (HKDF) from the hub's private key, so it survives restarts and is never stored.
 *
 * Format: `kh2_<device id>.<kind>.<issued at, base 36 ms>.<signature, base64url>` (under 100 characters).
 * The hub still keeps the token's SHA-256 like an old `kh_` token, so a token whose signature cannot be checked (the
 * key changed) is looked up by its hash instead, and rotating or revoking ends it at once.
 */
import { cleanDeviceKind, fromB64url, toB64url, type HubCryptoKey, type HubDeviceKind } from "../../../packages/shared/src/hub.js";

/** The prefix of a signed token. */
export const SIGNED_TOKEN_PREFIX = "kh2_";

/** What a signed token says about its device. */
export interface DeviceTokenClaims {
  deviceId: string;
  kind: HubDeviceKind;
  /** When it was issued (ms); must match the device row's `tokenIssuedAt`. */
  issuedAt: number;
}

const enc = new TextEncoder();

/**
 * The secret part of the hub's private key: the JWK's `d` (the key's own bytes), else the whole text.
 *
 * @param jwkText - The `HUB_PRIVATE_KEY` secret (or the key the hub keeps), as JWK text.
 * @returns The material to derive from.
 */
export function secretMaterial(jwkText: string): string {
  try {
    const d = (JSON.parse(jwkText) as { d?: unknown }).d;
    if (typeof d === "string" && d.length >= 32) return d;
  } catch {
    // Not JSON: the text itself.
  }
  return jwkText;
}

/**
 * Derives an HMAC-SHA-256 key for one purpose from the hub's secret (HKDF-SHA-256), so different uses never share a key.
 *
 * @param jwkText - The hub's private key as JWK text.
 * @param purpose - What the key signs (e.g. `device-token-v2`, `socket-ticket-v1`).
 * @returns A key for sign and verify.
 */
export async function deriveHmacKey(jwkText: string, purpose: string): Promise<HubCryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(secretMaterial(jwkText)), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode("kesher-hub"), info: enc.encode(purpose) }, base, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"]);
}

/** The signed part of a token. */
function claimsText(c: DeviceTokenClaims): string {
  return `${SIGNED_TOKEN_PREFIX}${c.deviceId}.${c.kind}.${c.issuedAt.toString(36)}`;
}

/**
 * Issues a signed device token.
 *
 * @param key - From {@link deriveHmacKey} (`device-token-v2`).
 * @param claims - The device and the issue time.
 * @returns The token.
 */
export async function issueDeviceToken(key: HubCryptoKey, claims: DeviceTokenClaims): Promise<string> {
  const head = claimsText(claims);
  return `${head}.${toB64url(await crypto.subtle.sign("HMAC", key, enc.encode(head)))}`;
}

const TOKEN_RE = /^kh2_(d[\w-]{1,40})\.(pc|phone|claude-chat)\.([0-9a-z]{1,12})\.([\w-]{43})$/;

/**
 * Checks a signed token's form and signature (no storage). Revocation and rotation are checked by the caller.
 *
 * @param key - From {@link deriveHmacKey} (`device-token-v2`).
 * @param token - The bearer token.
 * @returns Its claims, or undefined when it is not a signed token or the signature does not match.
 */
export async function verifyDeviceToken(key: HubCryptoKey, token: string): Promise<DeviceTokenClaims | undefined> {
  const m = TOKEN_RE.exec(token);
  if (!m) return undefined;
  const [, deviceId, kind, iat, sig] = m as unknown as [string, string, string, string, string];
  const claims: DeviceTokenClaims = { deviceId, kind: cleanDeviceKind(kind), issuedAt: parseInt(iat, 36) };
  if (claims.kind !== kind || !Number.isSafeInteger(claims.issuedAt)) return undefined;
  try {
    return (await crypto.subtle.verify("HMAC", key, fromB64url(sig), enc.encode(claimsText(claims)))) ? claims : undefined;
  } catch {
    return undefined;
  }
}
