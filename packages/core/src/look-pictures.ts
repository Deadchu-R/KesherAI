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
      const url = String(info.thumburl ?? info.url ?? "");
      if (!/^image\/(png|jpeg|webp)$/.test(String(info.mime ?? ""))) return [];
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
export async function findPictures(query: string, opts: { width: number; wide?: boolean; signal?: AbortSignal; fetchImpl?: typeof fetch }): Promise<FoundPicture[]> {
  const q = query.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!q) return [];
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: `filetype:bitmap ${q}`,
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
    const small = await findPictures(style, { width: 256, ...opts });
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
