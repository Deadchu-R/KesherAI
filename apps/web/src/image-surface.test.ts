import { test } from "node:test";
import assert from "node:assert/strict";
import { IMAGE_FILES, formatSize, imageFromResult, regionFromDrag, regionMessage, resizeDims, toImagePoint, versionChain } from "./image-surface";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

test("imageFromResult: picture steps only, ids from the step or the text", () => {
  assert.equal(imageFromResult("generate_image", true, "Generated 1 image(s).", [ID]), ID);
  assert.equal(imageFromResult("edit_image", true, `Done (ids: ${ID}).`), ID);
  assert.equal(imageFromResult("generate_image", false, "x", [ID]), undefined);
  assert.equal(imageFromResult("write_file", true, ID, [ID]), undefined);
  assert.equal(imageFromResult("generate_image", true, "no picture"), undefined);
});

test("file types", () => {
  for (const f of ["a.png", "b.JPG", "c.jpeg", "d.webp", "e.gif"]) assert.ok(IMAGE_FILES.test(f), f);
  assert.ok(!IMAGE_FILES.test("a.svg"));
});

test("regionFromDrag: any direction, clamped, tiny ones dropped", () => {
  const size = { w: 400, h: 300 };
  assert.deepEqual(regionFromDrag({ x: 100, y: 80 }, { x: 20, y: 10 }, size), { x: 20, y: 10, w: 80, h: 70 });
  assert.deepEqual(regionFromDrag({ x: -50, y: -5 }, { x: 900, y: 400 }, size), { x: 0, y: 0, w: 400, h: 300 });
  assert.equal(regionFromDrag({ x: 10, y: 10 }, { x: 14, y: 100 }, size), undefined);
});

test("toImagePoint maps the screen to picture pixels", () => {
  assert.deepEqual(toImagePoint({ x: 150, y: 120 }, { left: 50, top: 20, width: 200, height: 100 }, { w: 400, h: 200 }), { x: 200, y: 200 });
});

test("resizeDims: locked follows the other side, unlocked does not, limits hold", () => {
  assert.deepEqual(resizeDims({ w: 400, h: 200 }, { side: "w", value: 200 }, true), { w: 200, h: 100 });
  assert.deepEqual(resizeDims({ w: 400, h: 200 }, { side: "h", value: 50 }, true), { w: 100, h: 50 });
  assert.deepEqual(resizeDims({ w: 400, h: 200 }, { side: "w", value: 200 }, false), { w: 200, h: 200 });
  assert.deepEqual(resizeDims({ w: 400, h: 200 }, { side: "w", value: 99999 }, false), { w: 8192, h: 200 });
  assert.deepEqual(resizeDims({ w: 400, h: 200 }, { side: "w", value: Number.NaN }, false), { w: 1, h: 200 });
});

test("regionMessage: the region in pixels and percent, ask or change, Hebrew and English", () => {
  const base = { id: ID, title: "fox", size: { w: 400, h: 200 }, region: { x: 100, y: 50, w: 200, h: 100 }, instruction: " what is this? ", change: false };
  const en = regionMessage({ ...base, he: false });
  assert.match(en, /about this area: x=100, y=50, width=200, height=100 \(of 400×200; 25%–75% across, 25%–75% down\)/);
  assert.ok(en.includes(`asset ${ID}`) && en.endsWith("what is this?"));
  assert.match(regionMessage({ ...base, he: true }), /על האזור הזה: x=100, y=50, רוחב=200/);
  assert.match(regionMessage({ ...base, change: true, he: false }), /change only this area[\s\S]*new version/);
  assert.match(regionMessage({ ...base, change: true, he: true }), /לשנות רק את האזור הזה/);
});

test("versionChain: oldest first, survives a loop and a missing record", () => {
  const m = new Map([["c", { parent: "b" }], ["b", { parent: "a" }], ["a", {}]]);
  assert.deepEqual(versionChain(m, "c"), ["a", "b", "c"]);
  assert.deepEqual(versionChain(new Map([["x", { parent: "y" }], ["y", { parent: "x" }]]), "x"), ["y", "x"]);
  assert.deepEqual(versionChain(new Map(), "z"), ["z"]);
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(340 * 1024), "340 KB");
  assert.equal(formatSize(1.2 * 1024 * 1024), "1.2 MB");
});

test("a region as selection text and back", async () => {
  const { regionSelection, parseRegionSelection } = await import("./image-surface");
  const t = regionSelection({ x: 1, y: 2, w: 30, h: 40 }, { w: 640, h: 480 });
  assert.equal(t, "1,2,30,40/640×480");
  assert.deepEqual(parseRegionSelection(t), { region: { x: 1, y: 2, w: 30, h: 40 }, size: { w: 640, h: 480 } });
  assert.equal(parseRegionSelection("hello"), undefined);
});
