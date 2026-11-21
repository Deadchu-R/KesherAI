import { test } from "node:test";
import assert from "node:assert/strict";
import { zlibSync } from "fflate";
import { decodePng, encodeGif, type Rgba } from "./gif.js";
import { frameDelays, thinFrames } from "./browser-record.js";

/** A PNG built by hand: RGB or RGBA rows, each row with its own filter (to test the un-filtering). */
function png(width: number, height: number, rgba: boolean, pixel: (x: number, y: number) => number[], filters: number[]): Uint8Array {
  const bpp = rgba ? 4 : 3;
  const raw: number[] = [];
  const rows: number[][] = [];
  for (let y = 0; y < height; y++) {
    const row: number[] = [];
    for (let x = 0; x < width; x++) row.push(...pixel(x, y).slice(0, bpp));
    rows.push(row);
  }
  for (let y = 0; y < height; y++) {
    const f = filters[y % filters.length]!;
    raw.push(f);
    for (let i = 0; i < rows[y]!.length; i++) {
      const a = i >= bpp ? rows[y]![i - bpp]! : 0;
      const b = y ? rows[y - 1]![i]! : 0;
      const c = i >= bpp && y ? rows[y - 1]![i - bpp]! : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const pred = [0, a, b, (a + b) >> 1, paeth][f]!;
      raw.push((rows[y]![i]! - pred) & 255);
    }
  }
  const chunk = (name: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length);
    new DataView(out.buffer).setUint32(0, body.length);
    out.set([...name].map((ch) => ch.charCodeAt(0)), 4);
    out.set(body, 8);
    return out; // the CRC is not checked by decodePng
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  ihdr.set([8, rgba ? 6 : 2, 0, 0, 0], 8);
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlibSync(Uint8Array.from(raw))), chunk("IEND", new Uint8Array())];
  const all = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) {
    all.set(x, o);
    o += x.length;
  }
  return all;
}

/** A GIF reader just good enough to check the encoder: size, palette, frames' delays and LZW-decoded indexes. */
function readGif(g: Uint8Array) {
  assert.equal(String.fromCharCode(...g.subarray(0, 6)), "GIF89a");
  const w = g[6]! | (g[7]! << 8);
  const h = g[8]! | (g[9]! << 8);
  let at = 13 + 3 * 256;
  const frames: Array<{ delay: number; idx: number[] }> = [];
  let delay = 0;
  while (g[at] !== 0x3b) {
    if (g[at] === 0x21) {
      if (g[at + 1] === 0xf9) delay = (g[at + 4]! | (g[at + 5]! << 8)) * 10;
      at += 2;
      while (g[at]) at += g[at]! + 1;
      at++;
      continue;
    }
    assert.equal(g[at], 0x2c);
    at += 10;
    const min = g[at++]!;
    const data: number[] = [];
    while (g[at]) {
      data.push(...g.subarray(at + 1, at + 1 + g[at]!));
      at += g[at]! + 1;
    }
    at++;
    // LZW decode.
    const clear = 1 << min;
    let size = min + 1;
    let dict: number[][] = [];
    const reset = () => {
      dict = Array.from({ length: clear + 2 }, (_, i) => [i]);
      size = min + 1;
    };
    reset();
    const out: number[] = [];
    let bit = 0;
    let prev: number[] | undefined;
    for (;;) {
      let code = 0;
      for (let i = 0; i < size; i++, bit++) code |= ((data[bit >> 3]! >> (bit & 7)) & 1) << i;
      if (code === clear) {
        reset();
        prev = undefined;
        continue;
      }
      if (code === clear + 1) break;
      const entry = code < dict.length ? dict[code]! : [...prev!, prev![0]!];
      out.push(...entry);
      if (prev) dict.push([...prev, entry[0]!]);
      prev = entry;
      if (dict.length === 1 << size && size < 12) size++;
    }
    frames.push({ delay, idx: out });
  }
  return { w, h, frames, palette: (i: number) => [g[13 + i * 3]!, g[14 + i * 3]!, g[15 + i * 3]!] };
}

test("gif: PNGs with every row filter decode to the right pixels (RGB and RGBA)", () => {
  const px = (x: number, y: number) => [(x * 37 + y * 11) & 255, (x * 5 + y * 90) & 255, (x * y * 3) & 255, 200];
  for (const rgba of [false, true]) {
    const img = decodePng(png(7, 5, rgba, px, [0, 1, 2, 3, 4]));
    assert.equal(img.width, 7);
    assert.equal(img.height, 5);
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 7; x++) {
        const i = (y * 7 + x) * 4;
        assert.deepEqual([...img.data.subarray(i, i + 4)], [...px(x, y).slice(0, 3), rgba ? 200 : 255]);
      }
  }
  assert.throws(() => decodePng(Uint8Array.from([1, 2, 3])), /Not a PNG/);
});

test("gif: frames round-trip through LZW with their delays; solid colors stay exact", () => {
  const solid = (w: number, h: number, c: number[]): Rgba => ({ width: w, height: h, data: Uint8Array.from({ length: w * h * 4 }, (_, i) => (i % 4 === 3 ? 255 : c[i % 4]!)) });
  // A noisy frame makes the dictionary fill up (past 4096 codes) and reset: the hard part of LZW.
  const noisy: Rgba = { width: 200, height: 150, data: Uint8Array.from({ length: 200 * 150 * 4 }, (_, i) => (i * 2654435761) >>> 24) };
  const g = encodeGif([{ image: solid(200, 150, [255, 0, 0]), delayMs: 500 }, { image: noisy, delayMs: 120 }, { image: solid(100, 75, [0, 0, 255]), delayMs: 1000 }, { image: solid(200, 150, [0, 0, 255]), delayMs: 300 }]);
  // Frames decoded only when their turn comes give the same file (one picture in memory at a time; scan 169).
  let calls = 0;
  const lazy = (img: Rgba) => () => (calls++, img);
  assert.deepEqual(encodeGif([{ image: lazy(solid(200, 150, [255, 0, 0])), delayMs: 500 }, { image: lazy(noisy), delayMs: 120 }, { image: lazy(solid(100, 75, [0, 0, 255])), delayMs: 1000 }, { image: lazy(solid(200, 150, [0, 0, 255])), delayMs: 300 }]), g);
  assert.equal(calls, 4, "each frame decoded once");
  const r = readGif(g);
  assert.equal(r.w, 200);
  assert.equal(r.h, 150);
  assert.deepEqual(r.frames.map((f) => f.delay), [500, 120, 1000, 300]);
  for (const f of r.frames) assert.equal(f.idx.length, 200 * 150);
  assert.deepEqual(r.palette(r.frames[0]!.idx[0]!), [255, 0, 0]);
  assert.deepEqual(r.palette(r.frames[2]!.idx[999]!), [0, 0, 255]);
  // The noisy frame decodes to what the encoder mapped (each index a palette color).
  assert.ok(r.frames[1]!.idx.every((i) => i < 252));
  // A frame of another shape is fitted inside the last one's on white, not stretched.
  const odd = readGif(encodeGif([{ image: solid(100, 150, [0, 0, 0]), delayMs: 100 }, { image: solid(200, 150, [0, 0, 0]), delayMs: 100 }]));
  assert.deepEqual(odd.palette(odd.frames[0]!.idx[0]!), [255, 255, 255]);
  assert.deepEqual(odd.palette(odd.frames[0]!.idx[100]!), [0, 0, 0]);
  // Wide pictures are scaled down to 640.
  assert.equal(readGif(encodeGif([{ image: solid(1280, 100, [0, 0, 0]), delayMs: 100 }])).w, 640);
});

test("recording: each frame stays until the next; long recordings keep their total time", () => {
  const d = frameDelays([{ at: 0, data: Buffer.alloc(0) }, { at: 40, data: Buffer.alloc(0) }, { at: 1040, data: Buffer.alloc(0) }, { at: 9000, data: Buffer.alloc(0) }]);
  assert.deepEqual(d, [80, 1000, 5000, 1500]);
  const thin = thinFrames(Array(300).fill(100), 120);
  assert.equal(thin.length, 120);
  assert.equal(thin.reduce((a, b) => a + b.delay, 0), 30000);
});
