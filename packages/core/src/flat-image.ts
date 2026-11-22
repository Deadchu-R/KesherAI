import { deflateSync } from "node:zlib";

/**
 * Pictures a browser cannot show, turned into PNG for the picture editor ("Open from project": a Unity project's
 * Assets/ often holds TGA and PSD textures). Only what game textures use: TGA true colour or grey (raw or RLE, 8/24/32
 * bits) and a PSD's flattened picture (the composite Photoshop saves with "Maximize compatibility": RGB or grey, 8 bits
 * per channel, raw or RLE). Layers are not read. Pure and bounded: a picture over {@link MAX_PIXELS} is refused.
 */

/** The most pixels converted (8192 x 8192). */
export const MAX_PIXELS = 8192 * 8192;

/** Raw RGBA pixels. */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

const fail = (why: string): never => {
  throw Object.assign(new Error(why), { statusCode: 415 });
};

const checkSize = (w: number, h: number) => {
  if (!w || !h || w * h > MAX_PIXELS) fail(`This picture's size (${w} x ${h}) cannot be opened here.`);
};

/**
 * A TGA file's pixels.
 *
 * @param b - The file.
 * @returns Its pixels as RGBA.
 * @throws With statusCode 415 for colour-mapped or broken files.
 */
export function decodeTga(b: Uint8Array): Rgba {
  if (b.length < 18) fail("Not a TGA file.");
  const idLength = b[0]!, mapType = b[1]!, type = b[2]!;
  const width = b[12]! | (b[13]! << 8), height = b[14]! | (b[15]! << 8), bpp = b[16]!, desc = b[17]!;
  if (mapType !== 0 || ![2, 3, 10, 11].includes(type)) fail("Only true-colour or grey TGA pictures open here.");
  const grey = type === 3 || type === 11;
  if (grey ? bpp !== 8 : bpp !== 24 && bpp !== 32) fail(`TGA with ${bpp} bits per pixel is not supported.`);
  checkSize(width, height);
  const px = bpp / 8, n = width * height;
  const raw = new Uint8Array(n * px);
  let at = 18 + idLength;
  if (type < 9) {
    if (at + raw.length > b.length) fail("The TGA file is cut short.");
    raw.set(b.subarray(at, at + raw.length));
  } else {
    // RLE: a packet's high bit says "repeat the next pixel", its low 7 bits how many (minus one).
    let out = 0;
    while (out < raw.length) {
      if (at >= b.length) fail("The TGA file is cut short.");
      const head = b[at++]!, count = (head & 0x7f) + 1;
      if (head & 0x80) {
        const pixel = b.subarray(at, at + px);
        at += px;
        for (let i = 0; i < count && out < raw.length; i++, out += px) raw.set(pixel, out);
      } else {
        const len = Math.min(count * px, raw.length - out);
        raw.set(b.subarray(at, at + len), out);
        at += count * px;
        out += len;
      }
    }
  }
  const data = new Uint8Array(n * 4);
  const top = (desc & 0x20) !== 0;
  for (let y = 0; y < height; y++) {
    const row = top ? y : height - 1 - y;
    for (let x = 0; x < width; x++) {
      const s = (row * width + x) * px, d = (y * width + x) * 4;
      if (grey) data[d] = data[d + 1] = data[d + 2] = raw[s]!;
      else { data[d] = raw[s + 2]!; data[d + 1] = raw[s + 1]!; data[d + 2] = raw[s]!; }
      data[d + 3] = px === 4 ? raw[s + 3]! : 255;
    }
  }
  return { width, height, data };
}

/**
 * A PSD file's flattened picture (the composite saved after the layers).
 *
 * @param b - The file.
 * @returns Its pixels as RGBA.
 * @throws With statusCode 415 for PSB, 16/32-bit, CMYK or broken files.
 */
export function decodePsd(b: Uint8Array): Rgba {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 26 || String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!) !== "8BPS") fail("Not a PSD file.");
  if (v.getUint16(4) !== 1) fail("Large PSB documents are not supported: save as PSD or PNG.");
  const channels = v.getUint16(12), height = v.getUint32(14), width = v.getUint32(18), depth = v.getUint16(22), mode = v.getUint16(24);
  if (depth !== 8 || (mode !== 3 && mode !== 1)) fail("Only 8-bit RGB or grey PSD pictures open here.");
  checkSize(width, height);
  let at = 26;
  // Colour mode data, image resources, layers and masks: each a length then its bytes; the composite comes after.
  for (let i = 0; i < 3; i++) {
    if (at + 4 > b.length) fail("The PSD file is cut short.");
    at += 4 + v.getUint32(at);
  }
  if (at + 2 > b.length) fail("The PSD file is cut short.");
  const compression = v.getUint16(at);
  at += 2;
  const n = width * height;
  const use = Math.min(channels, mode === 3 ? 4 : 2);
  const planes = Array.from({ length: use }, () => new Uint8Array(n));
  if (compression === 0) {
    for (let c = 0; c < use; c++, at += n) {
      if (at + n > b.length) fail("The PSD file is cut short.");
      planes[c]!.set(b.subarray(at, at + n));
    }
  } else if (compression === 1) {
    // PackBits: every row's byte count first (2 bytes each, all channels), then the rows.
    const counts = at;
    at += channels * height * 2;
    for (let c = 0; c < use; c++) {
      for (let y = 0; y < height; y++) {
        const end = at + v.getUint16(counts + (c * height + y) * 2);
        if (end > b.length) fail("The PSD file is cut short.");
        let out = y * width;
        const stop = out + width;
        while (at < end && out < stop) {
          const h = (b[at++]! << 24) >> 24;
          if (h >= 0) {
            const len = Math.min(h + 1, stop - out);
            planes[c]!.set(b.subarray(at, at + len), out);
            at += h + 1;
            out += len;
          } else if (h !== -128) {
            planes[c]!.fill(b[at++]!, out, Math.min(out + 1 - h, stop));
            out += 1 - h;
          }
        }
        at = end;
      }
    }
  } else fail("This PSD's picture is compressed in a way not supported here (save with Maximize compatibility).");
  const data = new Uint8Array(n * 4);
  const grey = mode === 1;
  for (let i = 0; i < n; i++) {
    const d = i * 4;
    data[d] = planes[0]![i]!;
    data[d + 1] = grey ? planes[0]![i]! : planes[1]?.[i] ?? 0;
    data[d + 2] = grey ? planes[0]![i]! : planes[2]?.[i] ?? 0;
    data[d + 3] = (grey ? planes[1] : planes[3])?.[i] ?? 255;
  }
  return { width, height, data };
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC[(c ^ p[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32([head.subarray(4), body]), 0);
  return Buffer.concat([head, body, tail]);
}

/**
 * RGBA pixels as a PNG file.
 *
 * @param img - The pixels.
 * @returns The PNG's bytes.
 */
export function encodePng(img: Rgba): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const stride = img.width * 4;
  const rows = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) rows.set(img.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", new Uint8Array())]);
}

/**
 * A TGA or PSD file as PNG.
 *
 * @param bytes - The file.
 * @param ext - Its extension ("tga" or "psd").
 * @returns The PNG's bytes.
 */
export function flatToPng(bytes: Uint8Array, ext: string): Buffer {
  return encodePng(/^tga$/i.test(ext) ? decodeTga(bytes) : decodePsd(bytes));
}
