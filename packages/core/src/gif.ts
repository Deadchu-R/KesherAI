/**
 * A small GIF maker for browser recordings (docs/research/browser-computer-control.md, Phase 3), with no new
 * dependencies: PNG frames (what CDP's screencast gives) are decoded with fflate, which KesherAI already has, brought to
 * one size, mapped to a fixed 252-color palette with light ordered dithering, and written as an endlessly looping GIF.
 * A fixed palette keeps it fast and every frame consistent; it is meant for showing steps, not for photos.
 */
import { unzlibSync } from "fflate";

/** A decoded picture: width × height pixels, four bytes (RGBA) each. */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * Reads a PNG (8 bits per channel, RGB or RGBA, not interlaced: what Chromium writes).
 *
 * @param png - The file's bytes.
 * @returns Its pixels as RGBA.
 * @throws Error for anything else.
 */
export function decodePng(png: Uint8Array): Rgba {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (png.length < 33 || sig.some((b, i) => png[i] !== b)) throw new Error("Not a PNG.");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  let type = 0;
  const parts: Uint8Array[] = [];
  for (let at = 8; at + 8 <= png.length; ) {
    const len = view.getUint32(at);
    const name = String.fromCharCode(png[at + 4]!, png[at + 5]!, png[at + 6]!, png[at + 7]!);
    const body = png.subarray(at + 8, at + 8 + len);
    if (name === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      const depth = body[8];
      type = body[9]!;
      if (depth !== 8 || (type !== 2 && type !== 6) || body[12] !== 0) throw new Error("Only 8-bit RGB or RGBA PNGs without interlacing.");
    } else if (name === "IDAT") parts.push(body);
    else if (name === "IEND") break;
    at += 12 + len;
  }
  if (!width || !height) throw new Error("The PNG has no size.");
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  const raw = unzlibSync(all);
  const bpp = type === 6 ? 4 : 3;
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) throw new Error("The PNG is cut short.");
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[row + x - bpp]! : 0;
      const b = y ? px[row - stride + x]! : 0;
      const c = x >= bpp && y ? px[row - stride + x - bpp]! : 0;
      let v = raw[src + x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[row + x] = v & 255;
    }
  }
  if (bpp === 4) return { width, height, data: px };
  const data = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) {
    data[j] = px[i]!;
    data[j + 1] = px[i + 1]!;
    data[j + 2] = px[i + 2]!;
    data[j + 3] = 255;
  }
  return { width, height, data };
}

/** 4×4 Bayer matrix, centred on zero, for light ordered dithering. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v - 7.5) / 16);
/** Levels per channel of the fixed palette: 6 × 7 × 6 = 252 colors (green gets one more: the eye sees it best). */
const LR = 6;
const LG = 7;
const LB = 6;

/** The palette's index of a pixel (with dithering by its place). */
function paletteIndex(r: number, g: number, b: number, x: number, y: number): number {
  const d = BAYER[(y & 3) * 4 + (x & 3)]!;
  const q = (v: number, levels: number) => Math.min(levels - 1, Math.max(0, Math.round((v / 255) * (levels - 1) + d)));
  return q(r, LR) * LG * LB + q(g, LG) * LB + q(b, LB);
}

/** GIF's LZW for 8-bit indexes, packed into sub-blocks of at most 255 bytes. */
function lzw(indexes: Uint8Array): Uint8Array {
  const minSize = 8;
  const clear = 1 << minSize;
  const end = clear + 1;
  const out: number[] = [];
  let cur = 0;
  let bits = 0;
  let size = minSize + 1;
  const put = (code: number) => {
    cur |= code << bits;
    bits += size;
    while (bits >= 8) {
      out.push(cur & 255);
      cur >>>= 8;
      bits -= 8;
    }
  };
  let dict = new Map<number, number>();
  let next = end + 1;
  put(clear);
  let prefix = indexes[0] ?? 0;
  for (let i = 1; i < indexes.length; i++) {
    const k = indexes[i]!;
    const key = (prefix << 8) | k;
    const hit = dict.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    put(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      // The decoder widens one code later than the encoder adds it: widen when the next code needs the bit.
      if (next > 1 << size && size < 12) size++;
    } else {
      put(clear);
      dict = new Map();
      next = end + 1;
      size = minSize + 1;
    }
    prefix = k;
  }
  put(prefix);
  put(end);
  if (bits > 0) out.push(cur & 255);
  const blocks: number[] = [minSize];
  for (let i = 0; i < out.length; i += 255) {
    const chunk = out.slice(i, i + 255);
    blocks.push(chunk.length, ...chunk);
  }
  blocks.push(0);
  return Uint8Array.from(blocks);
}

/**
 * Makes a looping GIF from frames.
 *
 * @param frames - The pictures and how long each shows (ms). The GIF takes the last frame's shape (the page as it ended);
 *   frames of another shape (a view that changed size while recording) are fitted inside it on white, not stretched.
 * @param o.maxWidth - The GIF's widest (default 640); taller pictures are kept in proportion.
 * @returns The GIF's bytes.
 */
export function encodeGif(frames: Array<{ image: Rgba; delayMs: number }>, o: { maxWidth?: number } = {}): Uint8Array {
  if (!frames.length) throw new Error("No frames to make a GIF from.");
  const shape = frames[frames.length - 1]!.image;
  const k = Math.min(1, (o.maxWidth ?? 640) / shape.width);
  const W = Math.max(1, Math.round(shape.width * k));
  const H = Math.max(1, Math.round(shape.height * k));
  const white = paletteIndex(255, 255, 255, 0, 0);
  const bytes: number[] = [];
  const u16 = (n: number) => bytes.push(n & 255, (n >> 8) & 255);
  const text = (s: string) => bytes.push(...[...s].map((c) => c.charCodeAt(0)));
  text("GIF89a");
  u16(W);
  u16(H);
  bytes.push(0xf7, 0, 0); // a global table of 256 colors
  for (let i = 0; i < 256; i++) {
    if (i >= LR * LG * LB) {
      bytes.push(0, 0, 0);
      continue;
    }
    const r = Math.floor(i / (LG * LB));
    const g = Math.floor(i / LB) % LG;
    const b = i % LB;
    bytes.push(Math.round((r * 255) / (LR - 1)), Math.round((g * 255) / (LG - 1)), Math.round((b * 255) / (LB - 1)));
  }
  // Loop for ever (the NETSCAPE2.0 extension).
  bytes.push(0x21, 0xff, 11);
  text("NETSCAPE2.0");
  bytes.push(3, 1, 0, 0, 0);
  const idx = new Uint8Array(W * H);
  for (const f of frames) {
    const img = f.image;
    // Fit the frame inside W × H keeping its shape, centred; the rest is white.
    const fit = Math.min(W / img.width, H / img.height);
    const fw = Math.max(1, Math.round(img.width * fit));
    const fh = Math.max(1, Math.round(img.height * fit));
    const ox = Math.floor((W - fw) / 2);
    const oy = Math.floor((H - fh) / 2);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const fx = x - ox;
        const fy = y - oy;
        if (fx < 0 || fy < 0 || fx >= fw || fy >= fh) {
          idx[y * W + x] = white;
          continue;
        }
        const sx = Math.min(img.width - 1, Math.floor((fx * img.width) / fw));
        const sy = Math.min(img.height - 1, Math.floor((fy * img.height) / fh));
        const p = (sy * img.width + sx) * 4;
        idx[y * W + x] = paletteIndex(img.data[p]!, img.data[p + 1]!, img.data[p + 2]!, x, y);
      }
    }
    const cs = Math.min(65535, Math.max(2, Math.round(f.delayMs / 10)));
    bytes.push(0x21, 0xf9, 4, 0, cs & 255, cs >> 8, 0, 0);
    bytes.push(0x2c);
    u16(0);
    u16(0);
    u16(W);
    u16(H);
    bytes.push(0);
    for (const b of lzw(idx)) bytes.push(b);
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}
