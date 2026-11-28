/**
 * Picture operations on the PC for the image surface (apps/web ImagePanel): resize through `sharp` (Roee 28.11: approved,
 * loaded only when a picture is resized), the size of a picture without decoding it, and the metadata a new version
 * carries. When `sharp` is not there (an unsupported platform, or the part not installed) {@link resizeImage} says so
 * and the panel resizes on its own canvas instead, so nothing breaks.
 */
import { deflateSync } from "node:zlib";

/** The little of `sharp` used here (the real module fits; tests pass a fake). */
export interface SharpLike {
  (input: Uint8Array): {
    resize(o: { width?: number; height?: number; fit: "inside" | "fill"; withoutEnlargement?: boolean }): { toBuffer(): Promise<Uint8Array> };
    extract(o: { left: number; top: number; width: number; height: number }): { toBuffer(): Promise<Uint8Array> };
    rotate(degrees: number): { toBuffer(): Promise<Uint8Array> };
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

/** A rectangle in pixels of the picture. */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Checks a rectangle the model sent against the picture: whole numbers, at least 1 px, inside the picture.
 *
 * @param r - The model's `x`, `y`, `width`, `height` (untrusted).
 * @param size - The picture's size when known (from its header).
 * @returns The rectangle.
 * @throws With a readable message when it is not usable.
 */
export function checkRect(r: Partial<Record<keyof PixelRect, unknown>>, size?: { width: number; height: number }): PixelRect {
  const n = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) ? v : NaN);
  const out = { x: n(r.x), y: n(r.y), width: n(r.width), height: n(r.height) };
  if (!(out.x >= 0 && out.y >= 0 && out.width >= 1 && out.height >= 1)) throw new Error("Give x, y (from 0) and width, height (at least 1) as whole pixel numbers.");
  if (size && (out.x + out.width > size.width || out.y + out.height > size.height)) throw new Error(`The area goes outside the picture (${size.width} x ${size.height}).`);
  return out;
}

/**
 * Crops a picture to a rectangle with `sharp`.
 *
 * @param data - The picture's bytes.
 * @param rect - The checked rectangle ({@link checkRect}).
 * @param load - How to get `sharp` (tests pass a fake).
 * @returns The cropped bytes, or undefined when `sharp` is not available.
 */
export async function cropImage(data: Uint8Array, rect: PixelRect, load: SharpLoader = loadSharp): Promise<Uint8Array | undefined> {
  const sharp = await load();
  return sharp ? sharp(data).extract({ left: rect.x, top: rect.y, width: rect.width, height: rect.height }).toBuffer() : undefined;
}

/**
 * Rotates a picture by a quarter turn multiple with `sharp`.
 *
 * @param data - The picture's bytes.
 * @param degrees - 90, 180, 270 or -90 (clockwise).
 * @param load - How to get `sharp` (tests pass a fake).
 * @returns The rotated bytes, or undefined when `sharp` is not available.
 * @throws When the angle is not a quarter turn.
 */
export async function rotateImage(data: Uint8Array, degrees: number, load: SharpLoader = loadSharp): Promise<Uint8Array | undefined> {
  if (![90, 180, 270, -90].includes(degrees)) throw new Error("Rotate by 90, 180, 270 or -90 degrees.");
  const sharp = await load();
  return sharp ? sharp(data).rotate(degrees).toBuffer() : undefined;
}

/**
 * A black picture with a white rectangle, as the inpainting mask (white = repaint, black = keep): an 8-bit grey PNG
 * written by hand (no `sharp` needed).
 *
 * @param width - The picture's width.
 * @param height - The picture's height.
 * @param rect - The area to repaint.
 * @returns The PNG bytes.
 */
export function rectMaskPng(width: number, height: number, rect: PixelRect): Uint8Array {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width + 1);
    if (y >= rect.y && y < rect.y + rect.height) raw.fill(255, row + 1 + rect.x, row + 1 + Math.min(width, rect.x + rect.width));
  }
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth; colour type 0 = grey
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

/** CRC-32 of a buffer (PNG chunks). */
function crc32(b: Buffer): number {
  let c = ~0;
  for (const x of b) {
    c ^= x;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
