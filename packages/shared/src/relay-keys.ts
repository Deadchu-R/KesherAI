/**
 * The backup relays' keys (relay-transport.ts): their shapes and checks, in a module with no imports so the hub
 * protocol can check the sealed `relays` message without pulling in the transports.
 */

/** The backup relay providers (the Kesher hub itself is `kesher-hub` in packages/core/src/relay.ts). */
export type BackupRelayKind = "ably" | "supabase";

/** The order backup relays are tried in, after the Kesher hub. */
export const BACKUP_RELAYS: readonly BackupRelayKind[] = ["ably", "supabase"];

/** The keys of the backup relays, as Roee enters them in Settings › Kesher Cloud › Backup relays. */
export interface RelayKeys {
  /** Ably API key (`<app>.<key id>:<secret>`). */
  ably?: { key: string };
  /** Supabase project URL (`https://<ref>.supabase.co`) and its anon (publishable) key. */
  supabase?: { url: string; anonKey: string };
}

/** Names of the backup relays for the screens (the same words on the PC and the phone). */
export const RELAY_NAMES: Record<BackupRelayKind, string> = { ably: "Ably", supabase: "Supabase" };

const ABLY_KEY = /^[A-Za-z0-9_-]{1,40}\.[A-Za-z0-9_-]{1,40}:[A-Za-z0-9_+/=-]{8,120}$/;
const SUPABASE_URL = /^https:\/\/([a-z0-9]{10,40})\.supabase\.co\/?$/;
const SUPABASE_KEY = /^[A-Za-z0-9_.-]{20,1000}$/;

/**
 * Checks an Ably API key's shape.
 *
 * @param key - Untrusted text.
 * @returns The trimmed key, or undefined.
 */
export function cleanAblyKey(key: unknown): string | undefined {
  const k = typeof key === "string" ? key.trim() : "";
  return ABLY_KEY.test(k) ? k : undefined;
}

/**
 * Checks a Supabase project URL: only `https://<ref>.supabase.co`, so the key is never sent anywhere else.
 *
 * @param url - Untrusted text.
 * @returns The URL without a trailing slash, or undefined.
 */
export function cleanSupabaseUrl(url: unknown): string | undefined {
  const u = typeof url === "string" ? url.trim().toLowerCase() : "";
  const m = SUPABASE_URL.exec(u);
  return m ? `https://${m[1]}.supabase.co` : undefined;
}

/**
 * Checks a Supabase anon / publishable key's shape (a JWT or an `sb_publishable_…` key).
 *
 * @param key - Untrusted text.
 * @returns The trimmed key, or undefined.
 */
export function cleanSupabaseKey(key: unknown): string | undefined {
  const k = typeof key === "string" ? key.trim() : "";
  return SUPABASE_KEY.test(k) ? k : undefined;
}

/**
 * Reads relay keys from untrusted input (a settings save, or the sealed `relays` message on the phone). A provider
 * with a missing or malformed field is left out.
 *
 * @param x - Untrusted input: `{ ably?: { key }, supabase?: { url, anonKey } }`.
 * @returns The usable keys.
 */
export function cleanRelayKeys(x: unknown): RelayKeys {
  const o = x && typeof x === "object" ? (x as Record<string, unknown>) : {};
  const a = o.ably && typeof o.ably === "object" ? (o.ably as Record<string, unknown>) : {};
  const s = o.supabase && typeof o.supabase === "object" ? (o.supabase as Record<string, unknown>) : {};
  const key = cleanAblyKey(a.key);
  const url = cleanSupabaseUrl(s.url);
  const anonKey = cleanSupabaseKey(s.anonKey);
  return { ...(key ? { ably: { key } } : {}), ...(url && anonKey ? { supabase: { url, anonKey } } : {}) };
}

/**
 * The backup relays that have keys, in failover order.
 *
 * @param keys - The keys.
 * @returns The kinds, best first.
 */
export function configuredRelays(keys: RelayKeys): BackupRelayKind[] {
  return BACKUP_RELAYS.filter((k) => !!keys[k]);
}
