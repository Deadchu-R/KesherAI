import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { decodePng, shotsDiffer } from "./design-png.js";

/** A small RGB PNG; each row uses the given filter (0 none, 1 sub, 2 up, 4 Paeth stored as raw = same bytes). */
function png(w: number, h: number, pixel: (x: number, y: number) => [number, number, number], filter = 0): Buffer {
  const rows: number[] = [];
  const px = (x: number, y: number) => pixel(x, y);
  for (let y = 0; y < h; y++) {
    rows.push(filter);
    for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
      const v = px(x, y)[c]!;
      const left = x ? px(x - 1, y)[c]! : 0;
      rows.push(filter === 1 ? (v - left) & 0xff : v);
    }
  }
  const chunk = (type: string, body: Buffer) => {
    const b = Buffer.alloc(12 + body.length);
    b.writeUInt32BE(body.length, 0);
    b.write(type, 4, "latin1");
    body.copy(b, 8);
    return b; // the CRC is not checked by the reader
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from(rows))), chunk("IEND", Buffer.alloc(0))]);
}

const grad = (x: number, y: number): [number, number, number] => [x * 20, y * 30, 100];

test("decodes plain and Sub-filtered rows to the same pixels", () => {
  const a = decodePng(png(4, 3, grad, 0)), b = decodePng(png(4, 3, grad, 1));
  assert.equal(a.w, 4);
  assert.equal(a.ch, 3);
  assert.deepEqual([...a.data.slice(3, 6)], [20, 0, 100]);
  assert.deepEqual(a.data, b.data);
});

test("small drawing noise is the same picture; a real change, a new size or a broken file is not", () => {
  const base = png(4, 3, grad);
  assert.equal(shotsDiffer(base, png(4, 3, grad, 1)), false);
  assert.equal(shotsDiffer(base, png(4, 3, (x, y) => (x === 2 && y === 1 ? [62, 30, 100] : grad(x, y)))), false);
  assert.equal(shotsDiffer(base, png(4, 3, (x, y) => (x === 2 && y === 1 ? [255, 255, 255] : grad(x, y)))), true);
  assert.equal(shotsDiffer(base, png(5, 3, grad)), true);
  assert.equal(shotsDiffer(base, Buffer.from("nope")), true);
});
