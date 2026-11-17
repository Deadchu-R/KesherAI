/**
 * Finding the computer again when its internet address changes (Roee, 2026-11-17: "I want the student to connect to
 * her computer from anywhere without hassle"). A quick Cloudflare address changes when KesherAI restarts; the phone
 * then knew only the old one. Now the computer leaves its new address, encrypted, in a public ntfy topic; the phone
 * reads it there when the old address does not answer.
 *
 * Both the topic's name and the encryption key come from the phone's own key, which only the phone and the computer
 * know: the computer keeps the SHA-256 of each device key (device-keys.ts), the phone hashes the key it holds. So
 * nobody else can find the topic, and ntfy sees only an encrypted blob. The same steps run in the phone app
 * (apps/android/www/link-beacon.js, checked against this file by link-beacon.test.ts).
 */

/** The public ntfy server the address goes through (it keeps a message about 12 hours). */
export const BEACON_SERVER = "https://ntfy.sh";

const subtle = () => globalThis.crypto.subtle;
const bytes = (s: string) => new TextEncoder().encode(s);
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/**
 * The secret a beacon is built from: the SHA-256 (hex) of the phone's key, which is what the computer keeps.
 *
 * @param key - The phone's key (a device key, or the shared token).
 */
export async function beaconSecret(key: string): Promise<string> {
  return hex(await subtle().digest("SHA-256", bytes(key)));
}

/**
 * The ntfy topic for a secret: 40 hex characters nobody can guess.
 *
 * @param secret - From {@link beaconSecret} (or the computer's stored hash).
 */
export async function beaconTopic(secret: string): Promise<string> {
  return `kai${hex(await subtle().digest("SHA-256", bytes(`kesherai-link-topic:${secret}`))).slice(0, 40)}`;
}

async function aesKey(secret: string) {
  const raw = await subtle().digest("SHA-256", bytes(`kesherai-link-key:${secret}`));
  return subtle().importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** What a beacon carries. */
export interface BeaconLink {
  /** The computer's internet address now (https://…, no key in it). */
  url: string;
  /** The computer's name. */
  name?: string;
  /** When it was sent (ms). */
  t: number;
}

/**
 * Encrypts the computer's address for one key (AES-GCM, a fresh IV each time).
 *
 * @param secret - From {@link beaconSecret}.
 * @param link - The address and name.
 * @returns base64url(IV ‖ ciphertext).
 */
export async function sealLink(secret: string, link: BeaconLink): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, await aesKey(secret), bytes(JSON.stringify(link))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64url(out);
}

/**
 * Opens a beacon: undefined when it is not for this key, damaged, or not an https address.
 *
 * @param secret - From {@link beaconSecret}.
 * @param sealed - From {@link sealLink}.
 */
export async function openLink(secret: string, sealed: string): Promise<BeaconLink | undefined> {
  try {
    const all = unb64url(sealed.trim());
    const plain = await subtle().decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, await aesKey(secret), all.slice(12));
    const o = JSON.parse(new TextDecoder().decode(plain)) as Partial<BeaconLink>;
    if (typeof o.url !== "string" || !/^https:\/\/[\w.-]+(:\d+)?\/?$/.test(o.url)) return undefined;
    return { url: o.url.replace(/\/$/, ""), t: Number(o.t) || 0, ...(typeof o.name === "string" ? { name: o.name.slice(0, 60) } : {}) };
  } catch {
    return undefined;
  }
}
