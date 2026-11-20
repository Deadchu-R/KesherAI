/**
 * Just enough PNG reading to tell whether two design-doc shots really differ. Chromium does not draw some things
 * (gradient icons, anti-aliased lines) to exactly the same pixels every time, so the render compares pictures with a
 * tolerance instead of by their bytes: a real change (text, a button, a layout move) changes pixels a lot.
 * Reads 8-bit, non-interlaced grey/RGB/RGBA PNGs, which is what Playwright writes.
 */
import { inflateSync } from "node:zlib";

/** A decoded picture: width, height, channels per pixel and the raw pixel bytes. */
export interface Pixels {
  w: number;
  h: number;
  ch: number;
  data: Uint8Array;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * Decodes a PNG.
 * @param png The file's bytes.
 * @returns The pixels.
 * @throws For PNGs this reader does not handle (palette, 16-bit, interlaced) or broken ones.
 */
export function decodePng(png: Buffer): Pixels {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let off = 8;
  let w = 0, h = 0, ch = 0;
  const idat: Buffer[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString("latin1", off + 4, off + 8);
    const body = png.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      const depth = body[8]!, color = body[9]!, interlace = body[12]!;
      ch = CHANNELS[color] ?? 0;
      if (depth !== 8 || !ch || interlace) throw new Error("PNG kind not supported");
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const data = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? data[row + x - ch]! : 0;
      const b = y ? data[row - stride + x]! : 0;
      const c = x >= ch && y ? data[row - stride + x - ch]! : 0;
      const v = raw[src + x]!;
      let p: number;
      if (f === 0) p = 0;
      else if (f === 1) p = a;
      else if (f === 2) p = b;
      else if (f === 3) p = (a + b) >> 1;
      else {
        const e = a + b - c, pa = Math.abs(e - a), pb = Math.abs(e - b), pc = Math.abs(e - c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      data[row + x] = (v + p) & 0xff;
    }
  }
  return { w, h, ch, data };
}

/**
 * Whether two shots look different: another size, or any pixel off by more than the tolerance in a channel.
 * @param a One PNG.
 * @param b The other PNG.
 * @param tolerance How far a channel may be off (0–255) and still count as the same; 48 by default.
 * @returns True when they differ (also when either cannot be read).
 */
export function shotsDiffer(a: Buffer, b: Buffer, tolerance = 48): boolean {
  if (a.equals(b)) return false;
  let p: Pixels, q: Pixels;
  try {
    p = decodePng(a);
    q = decodePng(b);
  } catch {
    return true;
  }
  if (p.w !== q.w || p.h !== q.h || p.ch !== q.ch) return true;
  for (let i = 0; i < p.data.length; i++) if (Math.abs(p.data[i]! - q.data[i]!) > tolerance) return true;
  return false;
}
