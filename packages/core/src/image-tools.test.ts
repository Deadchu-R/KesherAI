import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { editImage, editImageTool, type ImageToolIo } from "./image-tools.js";
import { checkRect, imageSize, rectMaskPng, type SharpLike } from "./image-ops.js";

/** A 100 x 50 PNG header (enough for `imageSize`). */
const png = (() => {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(100, 16);
  b.writeUInt32BE(50, 20);
  return new Uint8Array(b);
})();

/** A fake `sharp` that records the call and returns one byte. */
function fakeSharp(calls: string[]): () => Promise<SharpLike> {
  const sharp = (() => ({
    resize: (o: object) => (calls.push(`resize ${JSON.stringify(o)}`), { toBuffer: async () => new Uint8Array([1]) }),
    extract: (o: object) => (calls.push(`extract ${JSON.stringify(o)}`), { toBuffer: async () => new Uint8Array([2]) }),
    rotate: (d: number) => (calls.push(`rotate ${d}`), { toBuffer: async () => new Uint8Array([3]) }),
  })) as unknown as SharpLike;
  return async () => sharp;
}

function io(calls: string[], saved: Array<{ meta: Record<string, unknown>; data: Uint8Array }> = []): ImageToolIo {
  return {
    sharp: fakeSharp(calls),
    load: async (ref) => (ref === "gone" ? undefined : { data: png, mimeType: "image/png", parent: { id: "p-1", meta: { version: 2, prompt: "a cat" } } }),
    save: async (data, _mime, meta) => (saved.push({ data, meta }), { id: "new-1" }),
  };
}

test("edit_image: crop, rotate and resize make a new version that remembers its parent", async () => {
  const calls: string[] = [];
  const saved: Array<{ meta: Record<string, unknown>; data: Uint8Array }> = [];
  const crop = await editImage({ image: "a", op: "crop", x: 10, y: 5, width: 40, height: 20 }, io(calls, saved));
  assert.deepEqual(crop.assetIds, ["new-1"]);
  assert.match(calls[0]!, /extract .*"left":10.*"top":5.*"width":40.*"height":20/);
  assert.deepEqual(saved[0]!.meta, { prompt: "a cat", parent: "p-1", version: 3, op: "crop" });
  await editImage({ image: "a", op: "rotate", degrees: 90 }, io(calls));
  assert.equal(calls[1], "rotate 90");
  await editImage({ image: "a", op: "resize", width: 50, keep: true }, io(calls));
  assert.match(calls[2]!, /resize .*"width":50.*"fit":"inside"/);
});

test("edit_image: refuses bad input with a readable text and saves nothing", async () => {
  const calls: string[] = [];
  const saved: Array<{ meta: Record<string, unknown>; data: Uint8Array }> = [];
  const run = (i: Record<string, unknown>) => editImage({ image: "a", ...i }, io(calls, saved));
  assert.match((await run({ op: "melt" })).output, /Unknown op/);
  assert.match((await editImage({ image: "gone", op: "rotate", degrees: 90 }, io(calls))).output, /No picture/);
  assert.match((await run({ op: "crop", x: 90, y: 0, width: 20, height: 10 })).output, /outside the picture \(100 x 50\)/);
  assert.match((await run({ op: "crop", x: 0, y: 0, width: 1.5, height: 10 })).output, /whole pixel/);
  assert.match((await run({ op: "rotate", degrees: 45 })).output, /90, 180, 270/);
  assert.match((await run({ op: "resize" })).output, /width and\/or height/);
  assert.match((await run({ op: "inpaint", x: 0, y: 0, width: 5, height: 5, prompt: "sky" })).output, /No image model/);
  assert.deepEqual([calls, saved], [[], []]);
});

test("edit_image: without sharp it says so; inpaint sends a mask with the area white", async () => {
  const noSharp: ImageToolIo = { ...io([]), sharp: async () => undefined };
  assert.match((await editImage({ image: "a", op: "rotate", degrees: 180 }, noSharp)).output, /sharp.*not available/);
  let seen: { mask: Uint8Array; prompt: string; width: number } | undefined;
  const withModel: ImageToolIo = { ...io([]), inpaint: async (o) => ((seen = o), { data: new Uint8Array([9]), mimeType: "image/png", model: "m1" }) };
  const r = await editImage({ image: "a", op: "inpaint", x: 2, y: 1, width: 3, height: 2, prompt: "a red hat" }, withModel);
  assert.deepEqual(r.assetIds, ["new-1"]);
  assert.equal(seen?.prompt, "a red hat");
  assert.equal(seen?.width, 100);
});

test("rectMaskPng: a valid grey PNG, white only inside the rectangle", () => {
  const m = Buffer.from(rectMaskPng(6, 4, { x: 2, y: 1, width: 3, height: 2 }));
  assert.deepEqual(imageSize(m), { width: 6, height: 4 });
  // Find IDAT and decode it.
  const at = m.indexOf("IDAT");
  const len = m.readUInt32BE(at - 4);
  const raw = inflateSync(m.subarray(at + 4, at + 4 + len));
  const rows = [0, 1, 2, 3].map((y) => [...raw.subarray(y * 7 + 1, y * 7 + 7)].join(","));
  assert.deepEqual(rows, ["0,0,0,0,0,0", "0,0,255,255,255,0", "0,0,255,255,255,0", "0,0,0,0,0,0"]);
  assert.throws(() => checkRect({ x: -1, y: 0, width: 2, height: 2 }), /whole pixel/);
});

test("edit_image tool: registered as safe with a schema that needs image and op", () => {
  const t = editImageTool({} as never, () => undefined);
  assert.equal(t.spec.name, "edit_image");
  assert.equal(t.risk, "safe");
  assert.deepEqual((t.spec.inputSchema as { required: string[] }).required, ["image", "op"]);
});
