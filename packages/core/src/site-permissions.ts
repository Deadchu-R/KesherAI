/**
 * Standing site permissions (Settings › Browser and computer › Sites): the sites where the browser tools act
 * without asking ("Always on this site" on the approval card, or added by hand), what each allows and since when.
 * Pure helpers over the config, so the routes, the chat and the tests share one set of rules.
 */
import type { GrantRule } from "./approval-grants.js";
import { actionClassOf, hostMatches, sensitiveKind } from "./control-policy.js";

/** What a standing permission allows: only open and read pages, or also click and type. */
export type SiteLevel = "open" | "act";

/** The config's record of a site: when it was given and what it allows (sites older than this list are "act", undated). */
export interface SiteInfo {
  at?: string;
  level?: SiteLevel;
}

/** The slice of the config these helpers read and write. */
export interface SiteConfig {
  browserSites?: string[];
  browserSiteInfo?: Record<string, SiteInfo>;
  controlBlocked?: string[];
  permissions: GrantRule[];
}

/** One row of the list. */
export interface SiteEntry {
  site: string;
  level: SiteLevel;
  /** When it was given (ISO), if known. */
  at?: string;
  /** "always" = the card's "Always on this site" or added by hand; "grant" = an "Until I revoke" rule (Settings › Approvals). */
  source: "always" | "grant";
}

const HOST = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Checks a host written by hand: a plain host name (only that host), or "*.host" for the host and its subdomains. No address
 * scheme, path, port, spaces or other wildcards; a site that always asks (banks, mail, payments, government)
 * or is blocked is refused, since a standing permission could never apply to it.
 *
 * @param raw - What the user typed.
 * @param blocked - The user's blocked sites.
 * @param sensitive - The user's own sensitive sites.
 * @returns The clean host, or the reason it is refused.
 */
export function validateSiteHost(raw: unknown, blocked: readonly string[] = [], sensitive: readonly string[] = []): { host: string } | { error: string } {
  if (typeof raw !== "string") return { error: "Write a site such as example.com." };
  const h = raw.trim().toLowerCase().replace(/^www\./, "");
  if (!h) return { error: "Write a site such as example.com." };
  if (/[/?#@\s:\\]/.test(h)) return { error: "Only the site's name, with no address, path or port (example.com)." };
  if (h.includes("*") && !h.startsWith("*.")) return { error: "A star is allowed only at the start: *.example.com." };
  if (!HOST.test(h)) return { error: "That is not a site name (example.com)." };
  const bare = h.replace(/^\*\./, "");
  if (sensitiveKind(bare, undefined, sensitive)) return { error: "This site always asks (bank, mail, payment, account or government), so it cannot be kept." };
  if (blocked.some((b) => hostMatches(bare, b))) return { error: "This site is blocked." };
  return { host: h };
}

/**
 * The standing permissions, newest first: the sites in `browserSites` plus "Until I revoke" site rules of the chat's own tools.
 *
 * @param c - The config.
 */
export function listSites(c: SiteConfig): SiteEntry[] {
  const out = new Map<string, SiteEntry>();
  for (const site of c.browserSites ?? []) {
    const i = c.browserSiteInfo?.[site];
    out.set(site, { site, level: i?.level ?? "act", ...(i?.at ? { at: i.at } : {}), source: "always" });
  }
  for (const r of c.permissions) {
    if (!r.target?.startsWith("site:") || r.scope !== "everywhere" || r.until || r.tool.startsWith("helper:")) continue;
    const site = r.target.slice(5);
    if (!out.has(site)) out.set(site, { site, level: "act", ...(r.createdAt ? { at: r.createdAt } : {}), source: "grant" });
  }
  return [...out.values()].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "") || a.site.localeCompare(b.site));
}

/**
 * Keeps a site as a standing permission (the card's "Always on this site", or added by hand). An existing one is kept as it is.
 *
 * @param c - The config (changed).
 * @param host - A host (validated, or from a session's scope).
 * @param now - The time now (ms).
 * @param level - What it allows (default: click and type, as "Always" has always meant).
 * @returns Whether the config changed.
 */
export function addSite(c: SiteConfig, host: string, now: number, level: SiteLevel = "act"): boolean {
  const list = (c.browserSites ??= []);
  if (list.includes(host)) return false;
  list.push(host);
  (c.browserSiteInfo ??= {})[host] = { at: new Date(now).toISOString(), level };
  return true;
}

/**
 * Takes a site back: from the list and from "Until I revoke" site rules for it, so the next call there asks again.
 *
 * @param c - The config (changed).
 * @param host - The site as listed.
 * @returns Whether anything was removed.
 */
export function removeSite(c: SiteConfig, host: string): boolean {
  const before = (c.browserSites?.length ?? 0) + c.permissions.length;
  c.browserSites = (c.browserSites ?? []).filter((x) => x !== host);
  if (c.browserSiteInfo) delete c.browserSiteInfo[host];
  c.permissions = c.permissions.filter((r) => !(r.target === `site:${host}` && r.scope === "everywhere" && !r.until));
  return before !== (c.browserSites.length + c.permissions.length);
}

/** A host without "www." and the port, in lower case. */
const plain = (h: string) => h.trim().toLowerCase().replace(/^www\./, "").replace(/:\d+$/, "");

/**
 * Whether a site's standing permission lets this browser call run without asking.
 *
 * @param c - The config.
 * @param host - The call's site.
 * @param tool - The tool (browser_click…).
 * @param input - Its arguments.
 */
export function siteAllows(c: SiteConfig, host: string, tool: string, input?: Record<string, unknown>): boolean {
  const hit = (c.browserSites ?? []).filter((e) => (e.startsWith("*.") ? hostMatches(host, e) : plain(host) === plain(e)));
  if (!hit.length) return false;
  // "Open only" holds for reading and opening pages; any matching entry that allows more wins.
  const act = actionClassOf(tool, input ?? {});
  return hit.some((e) => (c.browserSiteInfo?.[e]?.level ?? "act") === "act" || act === "read" || act === "navigate");
}
