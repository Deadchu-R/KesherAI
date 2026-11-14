/**
 * A web site's own icon, for a shortcut (asked for: "fetch an icon from the internet"): the page's
 * apple-touch-icon or icon link, else /favicon.ico, as a small data: address the sidebar shows in an <img>. Only
 * public http(s) sites, at most 48 KB, image types only.
 */

const TYPES = /^image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|webp|jpeg|gif)$/;
const MAX = 48 * 1024;

/** Whether an address is a public web site (not this computer or the home network). */
export function publicSite(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Only web sites (https://…) have icons to fetch.");
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?$)/i.test(u.hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname) || !u.hostname.includes(".")) throw new Error("Only public web sites.");
  return u;
}

/**
 * The icon links a page names, best first (bigger touch icons, then PNG/SVG icons, then any icon).
 *
 * @param html - The page's head.
 * @param base - The page's address.
 */
export function iconLinks(html: string, base: URL): string[] {
  const found: Array<{ href: string; score: number }> = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    const href = /\bhref\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (!href || !/\bicon\b|apple-touch-icon/.test(rel)) continue;
    const size = Number(/\bsizes\s*=\s*["']?(\d+)/i.exec(tag)?.[1] ?? 0);
    const score = (rel.includes("apple-touch") ? 300 : 0) + (/\.svg(\?|$)/i.test(href) ? 250 : 0) + Math.min(size, 256);
    try {
      found.push({ href: new URL(href.replace(/&amp;/g, "&"), base).href, score });
    } catch {
      /* a broken link */
    }
  }
  return found.sort((a, b) => b.score - a.score).map((f) => f.href);
}

/**
 * Fetches a site's icon.
 *
 * @param site - Any address on the site.
 * @returns A data: address of the image.
 */
export async function siteIcon(site: string, signal?: AbortSignal): Promise<string> {
  const url = publicSite(site);
  const opts = { signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]), headers: { "user-agent": "Mozilla/5.0 (KesherAI)" } };
  const candidates: string[] = [];
  try {
    const res = await fetch(url.origin + "/", opts);
    publicSite(res.url || url.origin);
    const html = (await res.text()).slice(0, 200_000);
    candidates.push(...iconLinks(html, new URL(res.url || url.origin)));
  } catch {
    /* the page did not open: try the usual place */
  }
  candidates.push(`${url.origin}/favicon.ico`);
  for (const c of candidates.slice(0, 5)) {
    try {
      publicSite(c);
      const r = await fetch(c, opts);
      if (r.url) publicSite(r.url);
      const type = (r.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!r.ok || !TYPES.test(type)) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length || buf.length > MAX) continue;
      return `data:${type};base64,${buf.toString("base64")}`;
    } catch {
      /* the next one */
    }
  }
  throw new Error(`No icon found on ${url.hostname}.`);
}
