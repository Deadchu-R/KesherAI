/**
 * Kesher Cloud hub: sealing messages end to end with WebCrypto only (the same code runs in Node 22, the Cloudflare
 * Worker and the phone's WebView).
 *
 * Each device has an ECDH P-256 key pair; the private half never leaves it. A message from A to B is sealed with
 * AES-GCM-256 under HKDF-SHA-256(ECDH(A, B), salt = message id, info = "kesher-hub v1"), with `v|id|from|to|kind` as
 * authenticated data, so the hub (or anyone) cannot read it, alter it, or pass it off as another message, sender,
 * recipient or kind. Replays of a whole envelope are caught by the recipient with {@link ReplayGuard}.
 */
import { BODY_FOR_KIND, HUB_PROTOCOL, parseSealedBody, ttlFor, type SealedBody, type SealedEnvelope, type SealedKind } from "./hub-protocol.js";

/** WebCrypto as this runtime has it (Node, the Worker, a browser), typed from the runtime's own declarations. */
type Subtle = typeof globalThis.crypto.subtle;
const subtle = (): Subtle => globalThis.crypto.subtle;

/** A WebCrypto key in this runtime (Node's `webcrypto.CryptoKey` or the browser's `CryptoKey`). */
export type HubCryptoKey = Awaited<ReturnType<Subtle["importKey"]>>;

/** The fields of an EC JWK this module reads. */
interface EcJwk {
  kty?: string;
  crv?: string;
  d?: string;
  x?: string;
  y?: string;
}
const enc = new TextEncoder();
const dec = new TextDecoder();
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

/**
 * Bytes to base64url (no padding).
 *
 * @param bytes - The bytes.
 * @returns The text.
 */
export function toB64url(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Base64url (with or without padding) to bytes.
 *
 * @param s - The text.
 * @returns The bytes.
 */
export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

/**
 * Random bytes as base64url (ids, tokens, secrets).
 *
 * @param n - How many random bytes.
 * @returns The text.
 */
export function randomB64url(n: number): string {
  return toB64url(globalThis.crypto.getRandomValues(new Uint8Array(n)));
}

/**
 * SHA-256 of a text, as hex (how tokens, codes and tickets are kept at rest).
 *
 * @param text - The text.
 * @returns 64 hex characters.
 */
export async function sha256Hex(text: string): Promise<string> {
  const h = new Uint8Array(await subtle().digest("SHA-256", enc.encode(text)));
  return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compares two texts in time that does not depend on where they differ.
 *
 * @param a - One text.
 * @param b - The other.
 * @returns Whether they are equal.
 */
export function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** A device's key pair; `publicKey` is the raw point as base64url, ready to send. */
export interface HubKeyPair {
  privateKey: HubCryptoKey;
  publicKey: string;
}

/**
 * Makes a new ECDH P-256 key pair.
 *
 * @param extractable - Whether the private key can be exported (a PC stores it in its encrypted config; the phone keeps
 *   a non-extractable key in IndexedDB).
 * @returns The pair.
 */
export async function generateHubKeys(extractable: boolean): Promise<HubKeyPair> {
  const pair = (await subtle().generateKey(ECDH, extractable, ["deriveBits"])) as { privateKey: HubCryptoKey; publicKey: HubCryptoKey };
  return { privateKey: pair.privateKey, publicKey: toB64url(await subtle().exportKey("raw", pair.publicKey)) };
}

/**
 * Exports a private key as JWK text (for the PC's encrypted config, or the hub's Worker secret).
 *
 * @param key - An extractable private key.
 * @returns JSON text.
 */
export async function exportPrivateJwk(key: HubCryptoKey): Promise<string> {
  return JSON.stringify(await subtle().exportKey("jwk", key));
}

/**
 * Reads a private key from JWK text, and works out its public key.
 *
 * @param jwkText - JSON text of an EC P-256 private JWK.
 * @returns The pair (the private key not extractable).
 */
export async function importPrivateJwk(jwkText: string): Promise<HubKeyPair> {
  const jwk = JSON.parse(jwkText) as EcJwk;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d || !jwk.x || !jwk.y) throw new Error("Not a P-256 private key.");
  const privateKey = await subtle().importKey("jwk", { kty: "EC", crv: "P-256", d: jwk.d, x: jwk.x, y: jwk.y }, ECDH, false, ["deriveBits"]);
  const pub = await subtle().importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, ECDH, true, []);
  return { privateKey, publicKey: toB64url(await subtle().exportKey("raw", pub)) };
}

/**
 * Reads a public key sent as raw base64url.
 *
 * @param b64 - The raw point (65 bytes, uncompressed).
 * @returns The key, or throws when it is not a P-256 point.
 */
export async function importPublicKey(b64: string): Promise<HubCryptoKey> {
  const raw = fromB64url(b64);
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("Not a P-256 public key.");
  return subtle().importKey("raw", raw, ECDH, true, []);
}

/**
 * The 6-digit fingerprint both screens show at pairing, so the hub cannot swap a key unnoticed.
 *
 * @param publicKey - Raw public key, base64url.
 * @returns Six digits, as "123 456".
 */
export async function keyFingerprint(publicKey: string): Promise<string> {
  const h = new Uint8Array(await subtle().digest("SHA-256", fromB64url(publicKey)));
  const n = (((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0) % 1_000_000;
  const s = String(n).padStart(6, "0");
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}

/** The authenticated data: everything the hub routes by, so none of it can be changed. */
function aad(e: Pick<SealedEnvelope, "id" | "from" | "to" | "kind">): Uint8Array<ArrayBuffer> {
  return enc.encode(`${HUB_PROTOCOL}|${e.id}|${e.from}|${e.to}|${e.kind}`);
}

/** The AES key for one message between two devices. */
async function messageKey(ownPrivate: HubCryptoKey, otherPublic: string, id: string, use: "encrypt" | "decrypt"): Promise<HubCryptoKey> {
  const shared = await subtle().deriveBits({ name: "ECDH", public: await importPublicKey(otherPublic) }, ownPrivate, 256);
  const base = await subtle().importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return subtle().deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode(id), info: enc.encode("kesher-hub v1") }, base, { name: "AES-GCM", length: 256 }, false, [use]);
}

/** Where a sealed message goes. */
export interface SealTo {
  /** Message id; a new random one when left out. */
  id?: string;
  from: string;
  to: string;
  kind: SealedKind;
  ttl?: number;
}

/**
 * Seals a message for one recipient.
 *
 * @param head - Sender, recipient, kind, id and ttl.
 * @param body - The plain content (its type must fit the kind).
 * @param senderPrivate - The sender's private key.
 * @param recipientPublic - The recipient's public key (raw base64url).
 * @returns The envelope to relay.
 */
export async function sealMessage(head: SealTo, body: SealedBody, senderPrivate: HubCryptoKey, recipientPublic: string): Promise<SealedEnvelope> {
  if (BODY_FOR_KIND[head.kind] !== body.type) throw new Error(`A ${head.kind} envelope cannot hold a ${body.type}.`);
  const id = head.id ?? randomB64url(16);
  const meta = { id, from: head.from, to: head.to, kind: head.kind };
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await messageKey(senderPrivate, recipientPublic, id, "encrypt");
  const ct = await subtle().encrypt({ name: "AES-GCM", iv, additionalData: aad(meta) }, key, enc.encode(JSON.stringify(body)));
  return { v: HUB_PROTOCOL, ...meta, ttl: ttlFor(head.kind, head.ttl), iv: toB64url(iv), ct: toB64url(ct) };
}

/**
 * Opens a sealed envelope addressed to this device.
 *
 * @param env - The envelope.
 * @param recipientPrivate - This device's private key.
 * @param senderPublic - The claimed sender's public key (from presence).
 * @returns The checked body; throws when it was tampered with, is for someone else, or does not fit its kind.
 */
export async function openEnvelope(env: SealedEnvelope, recipientPrivate: HubCryptoKey, senderPublic: string): Promise<SealedBody> {
  const key = await messageKey(recipientPrivate, senderPublic, env.id, "decrypt");
  let plain: ArrayBuffer;
  try {
    plain = await subtle().decrypt({ name: "AES-GCM", iv: fromB64url(env.iv), additionalData: aad(env) }, key, fromB64url(env.ct));
  } catch {
    throw new Error("The message could not be opened (changed, or not for this device).");
  }
  const body = parseSealedBody(JSON.parse(dec.decode(plain)), env.kind);
  if (!body) throw new Error("The message does not fit its kind.");
  return body;
}

/**
 * Remembers envelope ids already opened, for as long as they could still be redelivered (their ttl), so a replayed
 * envelope is ignored. Kept in memory; tasks are also deduplicated by task id where they are stored.
 */
export class ReplayGuard {
  private seen = new Map<string, number>();

  /** @param max - How many ids to keep at most (the oldest go first). */
  constructor(private readonly max = 5000) {}

  /**
   * Records an id.
   *
   * @param id - The envelope id.
   * @param ttlSeconds - How long it could still come back.
   * @param now - The time now, in ms.
   * @returns True the first time, false for a replay.
   */
  first(id: string, ttlSeconds: number, now = Date.now()): boolean {
    for (const [k, until] of this.seen) {
      if (until > now && this.seen.size <= this.max) break;
      this.seen.delete(k);
    }
    if (this.seen.has(id)) return false;
    this.seen.set(id, now + ttlSeconds * 1000);
    return true;
  }
}
