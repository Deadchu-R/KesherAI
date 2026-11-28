/**
 * Picture operations on the PC for the image surface (apps/web ImagePanel): resize through `sharp` (Roee 28.11: approved,
 * loaded only when a picture is resized), the size of a picture without decoding it, and the metadata a new version
 * carries. When `sharp` is not there (an unsupported platform, or the part not installed) {@link resizeImage} says so
 * and the panel resizes on its own canvas instead, so nothing breaks.
 */

/** The little of `sharp` used here (the real module fits; tests pass a fake). */
export interface SharpLike {
  (input: Uint8Array): {
    resize(o: { width?: number; height?: number; fit: "inside" | "fill"; withoutEnlargement?: boolean }): { toBuffer(): Promise<Uint8Array> };
  };
}

/** Loads `sharp`, or undefined when it is not installed. */
export type SharpLoader = () => Promise<SharpLike | undefined>;

/** Loads the real `sharp` the first time it is asked for (a failed load is not tried again). */
let loaded: Promise<SharpLike | undefined> | undefined;
const loadSharp: SharpLoader = () => {
  loaded ??= import("sharp").then((m) => m.default as unknown as SharpLike).catch(() => undefined);
  return loaded;
};

/** The longest side a resize may make (keeps a typo from asking for a gigapixel picture). */
export const MAX_SIDE = 8192;

/**
 * Resizes a picture with `sharp`. One side keeps the picture's proportions; both sides stretch to exactly that size
 * unless `keep` is true (then the picture fits inside).
 *
 * @param data - The picture's bytes (PNG, JPEG, WebP or GIF).
 * @param o - The new `width` and/or `height` (1 to {@link MAX_SIDE}); `keep` keeps the proportions.
 * @param load - How to get `sharp` (tests pass a fake).
 * @returns The resized bytes (`via: "sharp"`), or undefined when `sharp` is not available (use the canvas path).
 * @throws When a side is not a whole number in range, or neither is given.
 */
export async function resizeImage(
  data: Uint8Array,
  o: { width?: number; height?: number; keep?: boolean },
  load: SharpLoader = loadSharp,
): Promise<{ data: Uint8Array; via: "sharp" } | undefined> {
  const ok = (n: number | undefined) => n === undefined || (Number.isInteger(n) && n >= 1 && n <= MAX_SIDE);
  if (!ok(o.width) || !ok(o.height) || (o.width === undefined && o.height === undefined)) throw new Error(`Give a width and/or height of 1 to ${MAX_SIDE}.`);
  const sharp = await load();
  if (!sharp) return undefined;
  const fit = o.keep || o.width === undefined || o.height === undefined ? "inside" : "fill";
  const size = { ...(o.width !== undefined ? { width: o.width } : {}), ...(o.height !== undefined ? { height: o.height } : {}) };
  return { data: await sharp(data).resize({ ...size, fit }).toBuffer(), via: "sharp" };
}

/**
 * The pixel size of a PNG, GIF or JPEG read from its header (no decoding).
 *
 * @param d - The file's bytes.
 * @returns Width and height, or undefined for another type or a cut file.
 */
export function imageSize(d: Uint8Array): { width: number; height: number } | undefined {
  const b = Buffer.from(d.buffer, d.byteOffset, d.byteLength);
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 10 && b.subarray(0, 3).toString() === "GIF") return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    // JPEG: walk the segments to a start-of-frame marker.
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const m = b[i + 1]!;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return undefined;
}

/**
 * The metadata a saved new version carries: which picture it came from and its number in the chain.
 *
 * @param parent - The picture it was made from (its asset id and its own meta).
 * @param op - What made it ("crop", "rotate", "resize", "inpaint"…).
 * @returns The meta to save with the new asset.
 */
export function versionMeta(parent: { id: string; meta?: Record<string, unknown> | undefined }, op: string): Record<string, unknown> {
  const n = typeof parent.meta?.version === "number" ? parent.meta.version : 1;
  return { ...(typeof parent.meta?.prompt === "string" ? { prompt: parent.meta.prompt } : {}), parent: parent.id, version: n + 1, op };
}
