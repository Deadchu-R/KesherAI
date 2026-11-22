/**
 * A small baseline JPEG writer (no new dependencies), used to keep the chat's screenshots light: a 1280 px screen
 * as PNG is several hundred KB, as JPEG about a tenth of that. One quantization table and the standard
 * luminance Huffman tables (ITU T.81 Annex K) are used for all three channels, with no chroma subsampling, so
 * thin text stays sharp.
 */
import type { Rgba } from "./gif.js";

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45,
  38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

/** The standard luminance quantization table (quality 50), in row order. */
const QUANT50 = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49,
  64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];

/** Huffman tables: how many codes there are of each length 1..16, and the symbols in code order. */
const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24,
  0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53,
  0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93,
  0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9,
  0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];

/** The standard tables, for tests. */
export const JPEG_TABLES = { DC_BITS, DC_VALS, AC_BITS, AC_VALS };

/** Symbol → [code, length], built from the counts per length (the JPEG canonical code assignment). */
function codeTable(bits: number[], vals: number[]): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>();
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]!; i++) out.set(vals[k++]!, [code++, len]);
    code <<= 1;
  }
  return out;
}

/** The quantization table for a quality 1..100, in row order (the usual libjpeg scaling). */
function quantTable(quality: number): number[] {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const scale = q < 50 ? 5000 / q : 200 - q * 2;
  return QUANT50.map((v) => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))));
}

/** cos((2x+1)·u·π/16) · (u = 0 ? 1/√8 : 1/2), the 1-D DCT basis, [u][x]. */
const BASIS = Array.from({ length: 8 }, (_, u) => Array.from({ length: 8 }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / 16) * (u === 0 ? Math.SQRT1_2 / 2 : 0.5)));

/** Collects bits into bytes, writing 0x00 after every 0xFF as the format requires. */
class BitWriter {
  private bytes: number[] = [];
  private acc = 0;
  private n = 0;
  put(code: number, len: number): void {
    this.acc = (this.acc << len) | (code & ((1 << len) - 1));
    this.n += len;
    while (this.n >= 8) {
      const b = (this.acc >> (this.n - 8)) & 0xff;
      this.bytes.push(b);
      if (b === 0xff) this.bytes.push(0);
      this.n -= 8;
    }
    this.acc &= (1 << this.n) - 1;
  }
  /** Pads the last byte with 1-bits and returns everything written. */
  finish(): number[] {
    if (this.n) this.put(0x7f, 8 - this.n);
    return this.bytes;
  }
}

/** The number of bits a value needs (its "size" category) and the bits to write for it. */
function category(v: number): [number, number] {
  const a = Math.abs(v);
  let size = 0;
  while (a >> size) size++;
  return [size, v < 0 ? (v - 1) & ((1 << size) - 1) : v];
}

/**
 * Encodes pixels as a baseline JPEG.
 *
 * @param img - RGBA pixels (alpha is ignored).
 * @param quality - 1..100; 72 keeps screen text readable at a fraction of the PNG's size.
 * @returns The file's bytes.
 */
export function encodeJpeg(img: Rgba, quality = 72): Buffer {
  const { width: w, height: h, data } = img;
  const quant = quantTable(quality);
  const dc = codeTable(DC_BITS, DC_VALS);
  const ac = codeTable(AC_BITS, AC_VALS);
  const head: number[] = [0xff, 0xd8];
  const seg = (marker: number, body: number[]) => head.push(0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body);
  seg(0xdb, [0, ...ZIGZAG.map((i) => quant[i]!)]);
  seg(0xc0, [8, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]);
  seg(0xc4, [0x00, ...DC_BITS, ...DC_VALS]);
  seg(0xc4, [0x10, ...AC_BITS, ...AC_VALS]);
  seg(0xda, [3, 1, 0, 2, 0, 3, 0, 0, 63, 0]);

  const bw = new BitWriter();
  const prevDc = [0, 0, 0];
  const planes = [new Float32Array(64), new Float32Array(64), new Float32Array(64)];
  const tmp = new Float32Array(64);
  for (let by = 0; by < h; by += 8) {
    for (let bx = 0; bx < w; bx += 8) {
      // Colour planes of this block (edges repeat the last pixel), level-shifted to -128..127.
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const i = (Math.min(h - 1, by + y) * w + Math.min(w - 1, bx + x)) * 4;
          const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
          planes[0]![y * 8 + x] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
          planes[1]![y * 8 + x] = -0.168736 * r - 0.331264 * g + 0.5 * b;
          planes[2]![y * 8 + x] = 0.5 * r - 0.418688 * g - 0.081312 * b;
        }
      }
      for (let c = 0; c < 3; c++) {
        const p = planes[c]!;
        // Rows, then columns.
        for (let y = 0; y < 8; y++) for (let u = 0; u < 8; u++) { let s = 0; for (let x = 0; x < 8; x++) s += p[y * 8 + x]! * BASIS[u]![x]!; tmp[y * 8 + u] = s; }
        const q: number[] = new Array<number>(64);
        for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) { let s = 0; for (let y = 0; y < 8; y++) s += tmp[y * 8 + u]! * BASIS[v]![y]!; q[v * 8 + u] = Math.round(s / quant[v * 8 + u]!); }
        // DC: the change from the last block of this channel.
        const diff = q[0]! - prevDc[c]!;
        prevDc[c] = q[0]!;
        const [dsz, dbits] = category(diff);
        const dcode = dc.get(dsz)!;
        bw.put(dcode[0], dcode[1]);
        if (dsz) bw.put(dbits, dsz);
        // AC: runs of zeros and the next value, in zigzag order.
        let run = 0;
        for (let k = 1; k < 64; k++) {
          const v = q[ZIGZAG[k]!]!;
          if (!v) { run++; continue; }
          while (run > 15) { const z = ac.get(0xf0)!; bw.put(z[0], z[1]); run -= 16; }
          const [sz, bits] = category(v);
          const code = ac.get((run << 4) | sz)!;
          bw.put(code[0], code[1]);
          bw.put(bits, sz);
          run = 0;
        }
        if (run) { const eob = ac.get(0x00)!; bw.put(eob[0], eob[1]); }
      }
    }
  }
  return Buffer.from([...head, ...bw.finish(), 0xff, 0xd9]);
}
