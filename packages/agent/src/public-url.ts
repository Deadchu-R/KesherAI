/**
 * Fetching only public web pages (scan 2026-11-27): the web tools (web_fetch, download_file) and research's page reads
 * open addresses that a model picks, and research may now run on a third-party model (GhostCLI). So no address on this
 * computer (KesherAI's own server on localhost), the home network, a Tailscale network (100.64.0.0/10) or a
 * link-local/unique-local IPv6 range is ever fetched: not as typed, not after a DNS lookup, and not behind a redirect.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** The most redirects one fetch follows (each one is checked again). */
export const MAX_REDIRECTS = 5;

/**
 * Whether an IP address is on this computer or a private network (never fetched by a web tool).
 *
 * @param ip - An IPv4 or IPv6 address (without brackets).
 * @returns True for loopback, unspecified, private, link-local, CGNAT/Tailscale, unique-local and IPv4-mapped forms of those.
 */
export function privateAddress(ip: string): boolean {
  const a = ip.toLowerCase();
  if (isIP(a) === 6) {
    if (a === "::" || a === "::1" || /^(fc|fd|fe[89ab])/.test(a)) return true;
    // An IPv4 address inside IPv6 (::ffff:127.0.0.1, or the hex form ::ffff:7f00:1 that URL parsing produces).
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a)?.[1] ?? hexMapped(a);
    return mapped ? privateAddress(mapped) : false;
  }
  if (isIP(a) !== 4) return false;
  return /^(0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a);
}

/** `::ffff:7f00:1` → `127.0.0.1` (undefined for any other form). */
function hexMapped(a: string): string | undefined {
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (!m) return undefined;
  const hi = Number.parseInt(m[1]!, 16);
  const lo = Number.parseInt(m[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/**
 * Whether a URL's host, as written, is this computer or a private network: `localhost` (and `*.localhost`), a private
 * IP literal, or a single-label name (a home-network machine such as `router`).
 *
 * @param url - The parsed URL.
 */
export function privateHostName(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (isIP(host)) return privateAddress(host);
  return !host.includes(".");
}

/** Looks a host name up (tests pass a fake). */
export type Lookup = (host: string) => Promise<string[]>;

const dnsLookup: Lookup = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/**
 * Throws when a URL is not a public http(s) page: another scheme, a private host name, or a name that resolves to a
 * private address. A name that does not resolve is left to the fetch (which then fails by itself).
 *
 * @param url - The URL.
 * @param resolve - The DNS lookup.
 */
export async function assertPublicUrl(url: URL, resolve: Lookup = dnsLookup): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http and https links can be opened.");
  if (privateHostName(url)) throw new Error("Web tools only open public web pages, not addresses on this computer or the home network.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return;
  const ips = await resolve(host).catch(() => [] as string[]);
  if (ips.some(privateAddress)) throw new Error("Web tools only open public web pages; that name points to this computer or the home network.");
}

/**
 * `fetch` for a public page: checks the address, then follows up to {@link MAX_REDIRECTS} redirects by hand, checking
 * each new address the same way (a public page that redirects to `http://127.0.0.1:…` is refused).
 *
 * @param url - The first address.
 * @param init - The fetch options (its `redirect` is replaced).
 * @param resolve - The DNS lookup (tests pass a fake).
 * @returns The final response; its `url` may be empty for a response built in tests, so the final address is returned too.
 */
export async function fetchPublic(url: URL, init: RequestInit = {}, resolve: Lookup = dnsLookup): Promise<{ res: Response; url: URL }> {
  let at = url;
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(at, resolve);
    const res = await fetch(at, { ...init, redirect: "manual" });
    const to = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!to) return { res, url: at };
    if (hop >= MAX_REDIRECTS) throw new Error("The page redirected too many times.");
    // Not read: the redirect's own body is dropped.
    await res.body?.cancel().catch(() => undefined);
    at = new URL(to, at);
  }
}
