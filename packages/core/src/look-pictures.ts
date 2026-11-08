/**
 * Pictures for a look ("design it like One Piece"): found with a web image
 * search (DuckDuckGo, safe search on) — real wallpapers and icons of the
 * subject, for the user's own screen — and Wikimedia Commons (free licences)
 * when the web search finds nothing.
 *
 * Safe by design: fixed addresses to search; pictures are downloaded only
 * through DuckDuckGo's picture proxy or from upload.wikimedia.org, over
 * HTTPS (never straight from the address a result names, so a result cannot
 * point KesherAI at the home network); size limits; and the bytes must really
 * be a PNG, JPEG or WebP picture (checked, not trusted from the server).
 */

const API = "https://commons.wikimedia.org/w/api.php";
const PICTURE_HOST = "upload.wikimedia.org";
const PROXY_HOST = "external-content.duckduckgo.com";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const MAX_PICTURE = 8 * 1024 * 1024;
/** Left out of every search: a background or an icon is not the place for these. */
const SAFE = "-nude -naked -nudity -erotic -sexy -lingerie -bikini -swimsuit -swimwear -underwear -porn -gore -corpse -blood";
const UA = "KesherAI/0.5 (https://github.com/Deadchu-R/KesherAI; local app)";

/** One found picture, with where it is from (shown to the user as credit). */
export interface FoundPicture {
  url: string;
  width: number;
  height: number;
  page: string;
  license: string;
  artist: string;
  /** Where it was found: the web image search or Wikimedia Commons. */
  from?: "web" | "commons";
}

/** A downloaded picture. */
export interface LookPicture extends FoundPicture {
  data: Uint8Array;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
}

/** The picture type from the first bytes, or undefined if it is not one we take. */
export function sniffPicture(b: Uint8Array): LookPicture["mimeType"] | undefined {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "image/webp";
  return undefined;
}

const plain = (html: unknown) => String(html ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 120);

/** Reads Commons' search answer into pictures (only bitmap files with a scaled copy on the picture host). */
export function parseCommons(json: unknown): FoundPicture[] {
  const pages = (json as { query?: { pages?: Record<string, { index?: number; imageinfo?: Array<Record<string, unknown>> }> } })?.query?.pages ?? {};
  return Object.values(pages)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .flatMap((p) => {
      const info = p.imageinfo?.[0];
      if (!info) return [];
      const mime = String(info.mime ?? "");
      // Drawings (SVG) come as Commons' PNG copy, never as SVG (which can carry scripts).
      const url = String(mime === "image/svg+xml" ? (info.thumburl ?? "") : (info.thumburl ?? info.url ?? ""));
      if (!/^image\/(png|jpeg|webp)$/.test(mime) && !(mime === "image/svg+xml" && /\.png$/i.test(url))) return [];
      try {
        const u = new URL(url);
        if (u.protocol !== "https:" || u.hostname !== PICTURE_HOST) return [];
      } catch {
        return [];
      }
      const meta = (info.extmetadata ?? {}) as Record<string, { value?: unknown }>;
      return [{
        url,
        width: Number(info.thumbwidth ?? info.width ?? 0),
        height: Number(info.thumbheight ?? info.height ?? 0),
        page: String(info.descriptionurl ?? ""),
        license: plain(meta.LicenseShortName?.value) || "free licence",
        artist: plain(meta.Artist?.value) || "unknown",
        from: "commons" as const,
      }];
    });
}

/**
 * Searches Commons for pictures of a subject.
 *
 * @param query - What to look for ("One Piece Thousand Sunny").
 * @param opts.width - The width of the copy to get (1920 for a background, 256 for icons).
 * @param opts.wide - Only pictures wider than tall (backgrounds).
 */
export async function findPictures(query: string, opts: { width: number; wide?: boolean; drawings?: boolean; signal?: AbortSignal; fetchImpl?: typeof fetch }): Promise<FoundPicture[]> {
  const q = query.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!q) return [];
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    // The words as a phrase first ("One Piece", not every page with "one" and "piece"), nothing unsuitable for a screen.
    gsrsearch: `filetype:${opts.drawings ? "drawing" : "bitmap"} "${q}" ${SAFE}`,
    gsrnamespace: "6",
    gsrlimit: "24",
    prop: "imageinfo",
    iiprop: "url|mime|size|extmetadata",
    iiextmetadatafilter: "LicenseShortName|Artist",
    iiurlwidth: String(opts.width),
  });
  const res = await (opts.fetchImpl ?? fetch)(`${API}?${params}`, {
    headers: { "user-agent": UA },
    signal: AbortSignal.any([opts.signal ?? new AbortController().signal, AbortSignal.timeout(20_000)]),
  });
  if (!res.ok) throw new Error(`The picture search answered ${res.status}.`);
  const found = parseCommons(await res.json());
  return opts.wide ? found.filter((p) => p.width >= p.height * 1.25 && p.width >= 900) : found.filter((p) => p.width >= 64);
}

/** Reads DuckDuckGo's picture results; each picture is fetched through its proxy, never from the result's own address. */
export function parseWebPictures(json: unknown): FoundPicture[] {
  const results = (json as { results?: Array<Record<string, unknown>> })?.results ?? [];
  return results.flatMap((r) => {
    const image = String(r.image ?? "");
    const page = String(r.url ?? "");
    if (!/^https?:\/\//i.test(image) || image.length > 2000) return [];
    let site = "";
    try {
      site = new URL(page || image).hostname;
    } catch {
      return [];
    }
    return [{ url: `https://${PROXY_HOST}/iu/?u=${encodeURIComponent(image)}&f=1&nofb=1`, width: Number(r.width ?? 0), height: Number(r.height ?? 0), page, license: "from the web, for your own screen", artist: site, from: "web" as const }];
  });
}

/**
 * Searches the web for pictures (DuckDuckGo images, safe search strict).
 *
 * @param opts.shape - wide (backgrounds) or square-ish (icons).
 */
export async function findWebPictures(query: string, opts: { shape: "wide" | "square"; signal?: AbortSignal; fetchImpl?: typeof fetch }): Promise<FoundPicture[]> {
  const q = query.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!q) return [];
  const f = opts.fetchImpl ?? fetch;
  const signal = () => AbortSignal.any([opts.signal ?? new AbortController().signal, AbortSignal.timeout(15_000)]);
  const headers = { "user-agent": BROWSER_UA, "accept-language": "en-US,en;q=0.8" };
  const page = await f(`https://duckduckgo.com/?${new URLSearchParams({ q, iax: "images", ia: "images", kp: "1" })}`, { headers, signal: signal() });
  const vqd = /vqd=["']?([\d-]+)/.exec(await page.text())?.[1];
  if (!vqd) throw new Error("The picture search did not answer as expected.");
  const res = await f(`https://duckduckgo.com/i.js?${new URLSearchParams({ l: "wt-wt", o: "json", q, vqd, f: ",,,,,", p: "1", kp: "1" })}`, { headers: { ...headers, referer: "https://duckduckgo.com/" }, signal: signal() });
  if (!res.ok) throw new Error(`The picture search answered ${res.status}.`);
  const found = parseWebPictures(await res.json());
  return opts.shape === "wide"
    ? found.filter((p) => p.width >= 1280 && p.width >= p.height * 1.3)
    : found.filter((p) => p.width >= 64 && p.height >= 64 && p.width <= p.height * 1.4 && p.height <= p.width * 1.4);
}

/** Downloads one found picture, with the checks above. */
export async function downloadPicture(p: FoundPicture, opts: { signal?: AbortSignal; fetchImpl?: typeof fetch; maxBytes?: number } = {}): Promise<LookPicture> {
  const u = new URL(p.url);
  if (u.protocol !== "https:" || (u.hostname !== PICTURE_HOST && !(u.hostname === PROXY_HOST && u.pathname === "/iu/"))) throw new Error("Pictures come only through the picture search's proxy or Wikimedia Commons.");
  const MAX_BYTES = opts.maxBytes ?? MAX_PICTURE;
  const res = await (opts.fetchImpl ?? fetch)(u, {
    headers: { "user-agent": u.hostname === PROXY_HOST ? BROWSER_UA : UA },
    redirect: "error",
    signal: AbortSignal.any([opts.signal ?? new AbortController().signal, AbortSignal.timeout(30_000)]),
  });
  if (!res.ok) throw new Error(`The picture answered ${res.status}.`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) throw new Error("The picture is too big.");
  const data = new Uint8Array(await res.arrayBuffer());
  if (data.length > MAX_BYTES) throw new Error("The picture is too big.");
  const mimeType = sniffPicture(data);
  if (!mimeType) throw new Error("That file is not a picture.");
  return { ...p, data, mimeType };
}

/**
 * A background and icons for a named style: searches, then downloads the
 * first pictures that work. Fewer (or none) when the subject has few free pictures.
 */
export async function picturesForStyle(style: string, opts: { icons: number; background: boolean; signal?: AbortSignal; fetchImpl?: typeof fetch }): Promise<{ background?: LookPicture; icons: LookPicture[] }> {
  const out: { background?: LookPicture; icons: LookPicture[] } = { icons: [] };
  const net = { ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) };
  const first = async (lists: Array<() => Promise<FoundPicture[]>>, take: number, maxBytes: number, skip?: string) => {
    const got: LookPicture[] = [];
    for (const list of lists) {
      const found = await list().catch(() => [] as FoundPicture[]);
      for (const p of found.filter((x) => x.page !== skip || !skip).slice(0, take + 6)) {
        if (got.length >= take) break;
        try {
          got.push(await downloadPicture(p, { ...net, maxBytes }));
        } catch {
          // try the next one
        }
      }
      if (got.length >= take) break;
    }
    return got;
  };
  if (opts.background) {
    [out.background] = await first([
      () => findWebPictures(`${style} wallpaper`, { shape: "wide", ...net }),
      () => findPictures(style, { width: 1920, wide: true, ...net }),
    ], 1, MAX_PICTURE);
  }
  if (opts.icons > 0) {
    out.icons = await first([
      () => findWebPictures(`${style} icon png`, { shape: "square", ...net }),
      () => findPictures(style, { width: 256, drawings: true, ...net }),
      () => findPictures(style, { width: 256, ...net }),
    ], opts.icons, 2 * 1024 * 1024, out.background?.page);
  }
  return out;
}

/** The tools that get a picture icon when a look is made from a named style. */
export const LOOK_ICON_PAGES = ["#/images", "#/pages", "#/knowledge", "#/models", "#/day", "#/memory"] as const;

/**
 * Finds pictures for a named style and keeps them in the library: the
 * background, and icons for the given tool pages (in order).
 *
 * @param save - Saves a picture in the library; returns its id.
 */
export async function styleLook(
  style: string,
  opts: { background: boolean; iconPages: readonly string[]; save: (p: LookPicture, use: "background" | "icon") => Promise<string>; signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<{ background?: { kind: "image"; assetId: string; dim: number }; icons?: Record<string, { assetId: string }>; credits: string[] }> {
  const r = await picturesForStyle(style, { background: opts.background, icons: opts.iconPages.length, ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  const out: { background?: { kind: "image"; assetId: string; dim: number }; icons?: Record<string, { assetId: string }>; credits: string[] } = { credits: [] };
  if (r.background) {
    out.background = { kind: "image", assetId: await opts.save(r.background, "background"), dim: 55 };
    out.credits.push(r.background.from === "web" ? `background from ${r.background.artist}` : `background: ${r.background.artist} (${r.background.license}) ${r.background.page}`);
  }
  if (r.icons.length) {
    out.icons = {};
    for (const [i, p] of r.icons.entries()) out.icons[opts.iconPages[i]!] = { assetId: await opts.save(p, "icon") };
    out.credits.push(`${r.icons.length} icons from ${[...new Set(r.icons.map((p) => p.artist))].slice(0, 3).join(", ")}`);
  }
  return out;
}
