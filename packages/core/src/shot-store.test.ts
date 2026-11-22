import assert from "node:assert/strict";
import { test } from "node:test";
import { encodePng } from "./flat-image.js";
import { encodeJpeg, JPEG_TABLES } from "./jpeg.js";
import { prepareShot, shrinkRgba, withShotAssets } from "./shot-store.js";

/** A gradient picture. */
function pic(width: number, height: number) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([i % width % 256, (i / width) % 256, 90, 255], i * 4);
  return { width, height, data };
}

test("the Huffman tables are complete: 162 AC symbols, each run/size once", () => {
  assert.equal(JPEG_TABLES.AC_BITS.reduce((a, b) => a + b, 0), 162);
  const want = new Set([0x00, 0xf0]);
  for (let r = 0; r < 16; r++) for (let s = 1; s <= 10; s++) want.add((r << 4) | s);
  assert.deepEqual(new Set(JPEG_TABLES.AC_VALS), want);
  assert.equal(JPEG_TABLES.DC_BITS.reduce((a, b) => a + b, 0), 12);
});

test("encodeJpeg writes a JPEG with the right size", () => {
  const j = encodeJpeg(pic(21, 13));
  assert.deepEqual([j[0], j[1], j.at(-2), j.at(-1)], [0xff, 0xd8, 0xff, 0xd9]);
  const sof = j.indexOf(Buffer.from([0xff, 0xc0]));
  assert.equal(j.readUInt16BE(sof + 5), 13);
  assert.equal(j.readUInt16BE(sof + 7), 21);
});

test("shrinkRgba keeps the shape and leaves narrow pictures alone", () => {
  const small = pic(100, 50);
  assert.equal(shrinkRgba(small, 1280), small);
  const r = shrinkRgba(pic(2560, 1440), 1280);
  assert.deepEqual([r.width, r.height], [1280, 720]);
});

test("prepareShot: a wide PNG becomes a smaller JPEG of at most 1280 px; other bytes are kept", () => {
  const png = encodePng(pic(1600, 900));
  const k = prepareShot(png, "image/png");
  assert.equal(k.mimeType, "image/jpeg");
  assert.deepEqual([k.width, k.height], [1280, 720]);
  assert.ok(k.data.length < png.length);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  assert.equal(prepareShot(jpg, "image/jpeg").data, jpg);
  assert.equal(prepareShot(Buffer.from("junk"), "image/png").mimeType, "image/png");
});

test("withShotAssets gives a result's images an asset each, and leaves others alone", async () => {
  const saved: string[] = [];
  const mk = (out: object) => ({ spec: { name: "t", description: "", inputSchema: {} }, risk: "read" as const, run: async () => out });
  const [a, b] = withShotAssets([mk({ output: "x", images: [{ mimeType: "image/png", data: "AA==" }] }), mk({ output: "y", assetIds: ["keep"], images: [{ mimeType: "image/png", data: "AA==" }] })] as never, async (d) => { saved.push(String(d.length)); return `id${saved.length}`; });
  assert.deepEqual((await a!.run({}, {} as never)).assetIds, ["id1"]);
  assert.deepEqual((await b!.run({}, {} as never)).assetIds, ["keep"]);
  assert.equal(saved.length, 1);
});
