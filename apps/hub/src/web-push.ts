/**
 * Web Push from the hub (the standard every browser speaks: RFC 8030 delivery, RFC 8291 message encryption, RFC 8292
 * VAPID), written on WebCrypto only, so the Worker needs no library. It tells the owner's phone "KesherAI: 2 waiting
 * for you" when something on a PC waits for an approval, wherever the phone is, through the browser's own free push
 * service (Google's for Chrome on Android), the way any web app notifies.
 *
 * What the push service and the hub see: a count. Never what waits, where, or why (that stays sealed to the phone).
 * The message itself is encrypted to the phone's browser, so the push service sees only ciphertext.
 */
import { fromB64url, toB64url, type SealedEnvelope } from "../../../packages/shared/src/hub.js";

/** One browser's push subscription, as `PushSubscription.toJSON()` gives it, plus the page's language. */
export interface PushSub {
  endpoint: string;
  /** The browser's P-256 public key (base64url, 65 bytes uncompressed). */
  p256dh: string;
  /** The browser's auth secret (base64url, 16 bytes). */
  auth: string;
  lang: "he" | "en";
}

/** A subscription as the hub keeps it per paired device: the last count it told and when (for the rate limit). */
export interface StoredPushSub extends PushSub {
  /** The waiting count this device last saw (its page open) or was told (a push). */
  count: number;
  /** When the last push was sent (ms), 0 for never. */
  last: number;
}

/** The hub's VAPID key pair (the public key is also served to the page) and its contact. */
export interface VapidKeys {
  /** base64url, 65 bytes uncompressed P-256. */
  publicKey: string;
  /** base64url, the 32-byte private scalar "d" (a Worker secret, never in git). */
  privateKey: string;
  /** A `mailto:` or `https:` contact the push services may use (RFC 8292 `sub`). */
  subject: string;
}

/** Push timings and the collapse topic. */
export const PUSH = {
  /** At most one push per device in this gap; what comes sooner collapses into the shown notification. */
  gapMs: 30_000,
  /** How long the push service keeps an undelivered message (approvals live 30 minutes). */
  ttlSec: 30 * 60,
  /** The push service replaces an undelivered message with the same topic (RFC 8030 §5.4). */
  topic: "kesher-waiting",
  /** The notification's tag on the phone: a new one replaces the old one. */
  tag: "kesher-waiting",
  /** What a tap opens. */
  url: "/#waiting",
} as const;

/**
 * The push services the hub may call (exact hosts or their subdomains): Google (Chrome, Android), Mozilla (Firefox),
 * Apple (Safari, iOS home-screen apps) and Microsoft (Edge on Windows). Anything else is refused, so a subscription
 * can never make the Worker call an arbitrary address.
 */
const PUSH_HOSTS = ["fcm.googleapis.com", "android.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com"];

const enc = new TextEncoder();

/** base64url text as bytes, or undefined when it is not valid base64url (never throws on untrusted input). */
function bytesOf(s: unknown): Uint8Array | undefined {
  if (typeof s !== "string" || !/^[\w-]+$/.test(s)) return undefined;
  try {
    return fromB64url(s);
  } catch {
    return undefined;
  }
}
const subtle = () => globalThis.crypto.subtle;

/**
 * Checks a subscription sent by the page: an https address of a known push service and well-formed keys.
 *
 * @param x - Untrusted input (`{endpoint, keys: {p256dh, auth}, lang}`).
 * @returns The subscription, or undefined when anything is off.
 */
export function cleanPushSub(x: unknown): PushSub | undefined {
  if (!x || typeof x !== "object") return undefined;
  const o = x as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; lang?: unknown };
  if (typeof o.endpoint !== "string" || o.endpoint.length > 1000) return undefined;
  let url: URL;
  try {
    url = new URL(o.endpoint);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.port || url.username || url.password || !PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return undefined;
  const p256dh = o.keys?.p256dh;
  const auth = o.keys?.auth;
  const pub = bytesOf(p256dh);
  if (typeof p256dh !== "string" || typeof auth !== "string" || pub?.length !== 65 || pub[0] !== 4 || bytesOf(auth)?.length !== 16) return undefined;
  return { endpoint: url.href, p256dh, auth, lang: o.lang === "en" ? "en" : "he" };
}

/**
 * Reads the VAPID setup from the Worker's variables.
 *
 * @param publicKey - `VAPID_PUBLIC_KEY` (plain variable).
 * @param privateKey - `VAPID_PRIVATE_KEY` (secret).
 * @param subject - `VAPID_SUBJECT` (plain variable, `https:` or `mailto:`).
 * @returns The keys, or undefined when any is missing or malformed (push is then off).
 */
export function vapidFromEnv(publicKey?: string, privateKey?: string, subject?: string): VapidKeys | undefined {
  if (!publicKey || !privateKey || !subject || !/^(https:|mailto:)/.test(subject)) return undefined;
  const pub = bytesOf(publicKey);
  if (pub?.length !== 65 || pub[0] !== 4 || bytesOf(privateKey)?.length !== 32) return undefined;
  return { publicKey, privateKey, subject };
}

/** The VAPID private key for WebCrypto (from "d" and the public key's x and y). */
function vapidSigningKey(v: VapidKeys): Promise<CryptoKey> {
  const pub = fromB64url(v.publicKey);
  const jwk: JsonWebKey = { kty: "EC", crv: "P-256", d: v.privateKey, x: toB64url(pub.slice(1, 33)), y: toB64url(pub.slice(33, 65)), ext: false };
  return subtle().importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/**
 * The VAPID token for one push service (RFC 8292): an ES256 JWT for the endpoint's origin, valid 12 hours.
 *
 * @param endpoint - The subscription's address.
 * @param v - The hub's keys.
 * @param now - The time (ms).
 * @returns The `Authorization` header's value.
 */
export async function vapidAuth(endpoint: string, v: VapidKeys, now: number): Promise<string> {
  const part = (o: object) => toB64url(enc.encode(JSON.stringify(o)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: v.subject })}`;
  // WebCrypto's ECDSA signature is r‖s (64 bytes), which is what JWS ES256 wants.
  const sig = await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, await vapidSigningKey(v), enc.encode(unsigned));
  return `vapid t=${unsigned}.${toB64url(sig)}, k=${v.publicKey}`;
}

/** HKDF-SHA-256 (extract and expand) on WebCrypto. */
async function hkdf(ikm: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await subtle().importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** Joins byte arrays. */
function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Encrypts one message for a browser (RFC 8291, `aes128gcm`, one record): a fresh ECDH key per message, the shared
 * secret mixed with the browser's auth secret, then AES-128-GCM.
 *
 * @param plain - The message (a few hundred bytes at most).
 * @param p256dh - The browser's public key (base64url).
 * @param auth - The browser's auth secret (base64url).
 * @param fixed - For tests only: the sender's key pair and the salt.
 * @returns The body to POST: salt(16) ‖ record size(4) ‖ key length(1) ‖ sender key(65) ‖ ciphertext.
 */
export async function encryptPush(plain: Uint8Array, p256dh: string, auth: string, fixed?: { keys: CryptoKeyPair; salt: Uint8Array<ArrayBuffer> }): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = fromB64url(p256dh);
  const authSecret = fromB64url(auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error("The browser's push keys are not valid.");
  const keys = fixed?.keys ?? ((await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])) as CryptoKeyPair);
  const asPublic = new Uint8Array(await subtle().exportKey("raw", keys.publicKey));
  const uaKey = await subtle().importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: uaKey }, keys.privateKey, 256));
  const ikm = await hkdf(shared, authSecret, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = fixed?.salt ?? globalThis.crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(ikm, salt, enc.encode("Content-Encoding: nonce\0"), 12);
  const aes = await subtle().importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 0x02 marks the last (only) record; no padding.
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(plain, new Uint8Array([2]))));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, ct);
}

/**
 * The notification's words, content-free: only how many things wait.
 *
 * @param n - How many wait (1 or more).
 * @param lang - The page's language when the device subscribed.
 * @returns The title and body.
 */
export function pushText(n: number, lang: "he" | "en"): { title: string; body: string } {
  return { title: "KesherAI", body: lang === "he" ? `${n} ${n === 1 ? "מחכה" : "מחכים"} לך` : `${n} waiting for you` };
}

/**
 * Sends one push: the encrypted notification, collapsed by topic, urgent (it is an approval someone waits on).
 *
 * @param sub - The browser's subscription.
 * @param n - How many wait.
 * @param v - The hub's VAPID keys.
 * @param o - The fetch to use and the time.
 * @param note - The PC's sealed `ask_note` for this phone, copied in unread (optional).
 * @returns The push service's status (201 sent; 404 or 410: the subscription is gone).
 */
export async function sendPush(sub: PushSub, n: number, v: VapidKeys, o: { fetch: typeof fetch; now: number }, note?: SealedEnvelope): Promise<number> {
  // `note`: the newest ask sealed by the PC to this phone (the hub cannot open it); the service worker opens it and
  // shows the ask with two buttons. `lang` picks the service worker's words. Without a note: the count only.
  const payload = JSON.stringify({ ...pushText(n, sub.lang), n, tag: PUSH.tag, url: PUSH.url, lang: sub.lang, ...(note ? { note } : {}) });
  const body = await encryptPush(enc.encode(payload), sub.p256dh, sub.auth);
  const r = await o.fetch(sub.endpoint, {
    method: "POST",
    headers: { authorization: await vapidAuth(sub.endpoint, v, o.now), "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: String(PUSH.ttlSec), urgency: "high", topic: PUSH.topic },
    body,
    redirect: "manual",
  });
  return r.status;
}
