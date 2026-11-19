/**
 * Google sign-in for the hub: checks a Google Identity Services ID token (RS256 JWT) with WebCrypto against Google's
 * published keys, and decides whether it is the one allowed account (research entry, section 4).
 */
import { fromB64url } from "../../../packages/shared/src/hub.js";

/** The claims the hub reads from a Google ID token. */
export interface GoogleClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  aud: string;
  iss: string;
  exp: number;
}

/** One RSA key from Google's JWKS. */
export interface RsaJwk {
  kid: string;
  kty: "RSA";
  n: string;
  e: string;
  alg?: string;
}

const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const dec = new TextDecoder();

/**
 * Verifies a Google ID token.
 *
 * @param jwt - The token from the Google button.
 * @param clientId - The hub's OAuth client id (the token's audience).
 * @param keyFor - Finds Google's public key by `kid`.
 * @param nowMs - The time now.
 * @returns The claims; throws when the signature, issuer, audience, expiry or email check fails.
 */
export async function verifyGoogleIdToken(jwt: string, clientId: string, keyFor: (kid: string) => Promise<RsaJwk | undefined>, nowMs: number): Promise<GoogleClaims> {
  if (!clientId) throw new Error("No client id is set.");
  const parts = jwt.split(".");
  if (parts.length !== 3 || jwt.length > 4096) throw new Error("Not a JWT.");
  const [h, p, s] = parts as [string, string, string];
  const head = JSON.parse(dec.decode(fromB64url(h))) as { alg?: string; kid?: string };
  if (head.alg !== "RS256" || typeof head.kid !== "string") throw new Error("Unexpected token algorithm.");
  const jwk = await keyFor(head.kid);
  if (!jwk) throw new Error("Unknown signing key.");
  const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromB64url(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new Error("Bad signature.");
  const c = JSON.parse(dec.decode(fromB64url(p))) as Omit<Partial<GoogleClaims>, "email_verified"> & { email_verified?: unknown };
  if (!c.iss || !ISSUERS.has(c.iss)) throw new Error("Wrong issuer.");
  if (c.aud !== clientId) throw new Error("Wrong audience.");
  if (typeof c.exp !== "number" || c.exp * 1000 < nowMs - 60_000) throw new Error("Expired.");
  if (c.email_verified !== true && c.email_verified !== "true") throw new Error("Email not verified.");
  if (typeof c.sub !== "string" || !c.sub || typeof c.email !== "string") throw new Error("Missing account.");
  return { sub: c.sub, email: c.email, email_verified: true, aud: c.aud, iss: c.iss, exp: c.exp };
}

/**
 * Whether a verified account may sign in: once a `sub` is pinned, only that `sub`; before that, only the allowed email
 * (case-insensitive), whose `sub` is then pinned. Email alone is never trusted after the pin (it can change hands).
 *
 * @param claims - The verified claims.
 * @param allowedEmail - The `ALLOWED_EMAIL` secret.
 * @param pinnedSub - The pinned `sub`, if any.
 * @returns "ok", "pin" (allowed, and pin this `sub` now) or "refuse".
 */
export function ownerCheck(claims: GoogleClaims, allowedEmail: string | undefined, pinnedSub: string | undefined): "ok" | "pin" | "refuse" {
  if (pinnedSub) return claims.sub === pinnedSub ? "ok" : "refuse";
  if (!allowedEmail || !claims.email_verified) return "refuse";
  return claims.email.trim().toLowerCase() === allowedEmail.trim().toLowerCase() ? "pin" : "refuse";
}

/**
 * Google's keys, fetched from its JWKS and kept for as long as its `Cache-Control: max-age` says (at least 5 minutes,
 * at most a day).
 *
 * @param fetchImpl - `fetch` (tests pass a fake).
 * @param url - The JWKS address.
 * @returns A key lookup by `kid`.
 */
export function googleKeys(fetchImpl: typeof fetch = fetch, url = "https://www.googleapis.com/oauth2/v3/certs"): (kid: string) => Promise<RsaJwk | undefined> {
  let cache: { keys: RsaJwk[]; until: number } | undefined;
  return async (kid) => {
    const now = Date.now();
    if (!cache || cache.until < now || !cache.keys.some((k) => k.kid === kid)) {
      const r = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error("Google's keys could not be read.");
      const maxAge = Number(/max-age=(\d+)/.exec(r.headers.get("cache-control") ?? "")?.[1] ?? 3600);
      const body = (await r.json()) as { keys?: RsaJwk[] };
      cache = { keys: Array.isArray(body.keys) ? body.keys.filter((k) => k.kty === "RSA") : [], until: now + Math.min(86_400, Math.max(300, maxAge)) * 1000 };
    }
    return cache.keys.find((k) => k.kid === kid);
  };
}
