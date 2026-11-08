/**
 * Pictures for a look ("design it like One Piece"): free pictures from
 * Wikimedia Commons, where every file has a free licence, so KesherAI can
 * use them as a background or as tool icons without copying anyone's art.
 *
 * Safe by design: one fixed address to search, pictures only from
 * upload.wikimedia.org over HTTPS, at most 8 MB, and the bytes must really be
 * a PNG, JPEG or WebP picture (checked, not trusted from the server).
 */

const API = "https://commons.wikimedia.org/w/api.php";
const PICTURE_HOST = "upload.wikimedia.org";
const MAX_BYTES = 8 * 1024 * 1024;
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

/** Downloads one found picture, with the checks above. */
export async function downloadPicture(p: FoundPicture, opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}): Promise<LookPicture> {
  const u = new URL(p.url);
  if (u.protocol !== "https:" || u.hostname !== PICTURE_HOST) throw new Error("Pictures come only from Wikimedia Commons.");
  const res = await (opts.fetchImpl ?? fetch)(u, {
    headers: { "user-agent": UA },
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
  if (opts.background) {
    let wide = await findPictures(style, { width: 1920, wide: true, ...opts });
    if (!wide.length) wide = (await findPictures(`${style} wallpaper`, { width: 1920, wide: true, ...opts }).catch(() => []));
    for (const p of wide.slice(0, 4)) {
      try {
        out.background = await downloadPicture(p, opts);
        break;
      } catch {
        // try the next one
      }
    }
  }
  if (opts.icons > 0) {
    // Icons: drawings first (logos-free symbols, emblems), then photos.
    const drawings = await findPictures(style, { width: 256, drawings: true, ...opts }).catch(() => []);
    const small = [...drawings, ...(drawings.length >= opts.icons ? [] : await findPictures(style, { width: 256, ...opts }))];
    const skip = out.background?.page;
    for (const p of small.filter((x) => x.page !== skip).slice(0, opts.icons + 4)) {
      if (out.icons.length >= opts.icons) break;
      try {
        out.icons.push(await downloadPicture(p, opts));
      } catch {
        // skip it
      }
    }
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
    out.credits.push(`background: ${r.background.artist} (${r.background.license}) ${r.background.page}`);
  }
  if (r.icons.length) {
    out.icons = {};
    for (const [i, p] of r.icons.entries()) out.icons[opts.iconPages[i]!] = { assetId: await opts.save(p, "icon") };
    out.credits.push(`${r.icons.length} icons from Wikimedia Commons (free licences)`);
  }
  return out;
}
