/**
 * The backup path from the phone to the PC when the hub is down (docs/research/c-20261122-37.md, "Recommended
 * Architecture"): the PC tells its phones its Tailscale address (the tailnet-only `tailscale serve` HTTPS address and
 * its 100.x address), and the phone goes there directly when the hub does not answer, answers 5xx, or has used up its
 * daily storage. Only devices in the user's own tailnet can reach these addresses, and they still need this phone's
 * own key (the same auth as the home-network path). Shared by the PC (hello, pairing link), the hub page and the
 * Android app, so all three choose the same way.
 */

/** Where the PC can be reached inside the user's tailnet. Every field is optional (older PCs send none). */
export interface TailscaleDirect {
  /** The `tailscale serve` HTTPS address, e.g. `https://pc.tail1234.ts.net` (tailnet only, a real certificate). */
  url?: string;
  /** The PC's Tailscale IPv4 address (100.64.0.0/10). */
  ip?: string;
  /** The PC's MagicDNS name, e.g. `pc.tail1234.ts.net`. */
  dns?: string;
}

/** Tailscale's CGNAT range, 100.64.0.0/10. */
const TAILSCALE_IP = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(25[0-5]|2[0-4]\d|1?\d?\d)\.(25[0-5]|2[0-4]\d|1?\d?\d)$/;
/** A MagicDNS name: labels under ts.net. */
const MAGIC_DNS = /^(?=.{1,200}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/i;

/**
 * Whether an address is in Tailscale's range (100.64.0.0/10).
 *
 * @param ip - An IPv4 address.
 * @returns True for a Tailscale address.
 */
export function isTailscaleIp(ip: string): boolean {
  return TAILSCALE_IP.test(ip);
}

/**
 * Keeps only safe, well-formed fields: the HTTPS address must be `https://<name>.ts.net` with no path, query or
 * credentials (anything else could send the phone, and its key, to another site); the IP must be a Tailscale one.
 *
 * @param raw - What came in (a hello frame, a link, storage).
 * @returns The clean fields, or undefined when none is left.
 */
export function cleanTailscaleDirect(raw: unknown): TailscaleDirect | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const x = raw as Record<string, unknown>;
  const out: TailscaleDirect = {};
  if (typeof x.url === "string" && x.url.length <= 220) {
    try {
      const u = new URL(x.url);
      if (u.protocol === "https:" && MAGIC_DNS.test(u.hostname) && !u.username && !u.password && !u.search && !u.hash && (u.pathname === "/" || u.pathname === "") && !u.port) out.url = u.origin;
    } catch {
      /* not an address */
    }
  }
  if (typeof x.ip === "string" && isTailscaleIp(x.ip)) out.ip = x.ip;
  if (typeof x.dns === "string" && MAGIC_DNS.test(x.dns.replace(/\.$/, ""))) out.dns = x.dns.replace(/\.$/, "").toLowerCase();
  return out.url || out.ip || out.dns ? out : undefined;
}

/**
 * The addresses to try for the direct path, best first: the HTTPS one (works from an https page too), then the
 * 100.x address on KesherAI's port (needs remote access on; plain HTTP, but inside WireGuard).
 *
 * @param direct - What the PC said.
 * @param port - KesherAI's port on the PC (7420 by default).
 * @returns The base addresses, without a trailing slash.
 */
export function directUrls(direct: TailscaleDirect | undefined, port = 7420): string[] {
  const out: string[] = [];
  if (direct?.url) out.push(direct.url);
  if (direct?.ip) out.push(`http://${direct.ip}:${port}`);
  return out;
}

/** How a check of the hub went: `status` is missing when it did not answer at all (no network, a timeout). */
export interface HubProbe {
  status?: number;
  /** The hub's error code from the JSON body, e.g. `hub-storage-limit`. */
  error?: string;
}

/** Which way the phone talks to the PC: through the hub, directly through Tailscale, or neither works. */
export type PhonePath = "hub" | "tailscale" | "none";

/**
 * Whether the hub can carry the link now: it answered, and not with a server error or its daily-storage refusal.
 * A 4xx (signed out, a revoked device) is the hub working: the phone must fix that there, not go around it.
 *
 * @param probe - How the check went.
 * @returns True when the hub is usable.
 */
export function hubUsable(probe: HubProbe): boolean {
  if (probe.status === undefined) return false;
  if (probe.error === "hub-storage-limit" || probe.error === "hub-limit") return false;
  return probe.status < 500;
}

/**
 * Chooses the path: the hub first; when it is not usable and the PC told its Tailscale address, directly; otherwise
 * the hub anyway (it shows its own error), or "none" when it did not even answer.
 *
 * @param probe - How the hub check went.
 * @param direct - What the PC said (from presence or the pairing link).
 * @returns The path, and for "tailscale" the addresses to try.
 */
export function choosePath(probe: HubProbe, direct: TailscaleDirect | undefined): { path: PhonePath; urls: string[] } {
  if (hubUsable(probe)) return { path: "hub", urls: [] };
  const urls = directUrls(direct);
  if (urls.length) return { path: "tailscale", urls };
  return { path: probe.status === undefined ? "none" : "hub", urls: [] };
}

/** The status line for each path, Hebrew and English (the same words on the hub page and in the app). */
export const PATH_LABELS: Record<PhonePath, { he: string; en: string }> = {
  hub: { he: "דרך ההאב", en: "Through the hub" },
  tailscale: { he: "ישיר דרך Tailscale", en: "Direct through Tailscale" },
  none: { he: "אין חיבור", en: "Not connected" },
};

/** The one-time hint when the hub is down and the phone has no Tailscale path. */
export const TAILSCALE_HINT = {
  he: "ההאב לא זמין. התקן את Tailscale בטלפון ובמחשב (באותו חשבון) כדי להגיע למחשב ישירות.",
  en: "The hub is unavailable. Install Tailscale on the phone and the PC (same account) to reach the PC directly.",
};
