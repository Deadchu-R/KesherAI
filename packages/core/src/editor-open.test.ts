import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error: plain browser modules (no types), shared by the editors' pages and this test
import { acceptOf, checkOpen, explain, kindOfName, recentAdd, setHebrew, LIMITS } from "../../../plugins/model-editor/ui/open-file.js";
// @ts-expect-error: a plain browser module (no types)
import { findSibling, mtlTextures, normPath, resolveGltf, resolveMtl, resolveObj, splitModel } from "../../../plugins/model-editor/ui/model-resolve.js";
import { readFileSync } from "node:fs";

/** A File stand-in: a name, and a folder path when it came from a dropped folder. */
const f = (name: string, relPath?: string) => ({ name, size: 10, relPath });

test("every editor's open-file.js is the same file as the 3D editor's copy", () => {
  const base = readFileSync("plugins/model-editor/ui/open-file.js", "utf8");
  for (const e of ["image", "sound", "video"]) assert.equal(readFileSync(`plugins/${e}-editor/ui/open-file.js`, "utf8"), base, e);
});

test("open checks: the editor's own types only, not empty, not over the kind's limit", () => {
  assert.deepEqual(checkOpen("a.glb", 5, ["model", "part", "image"]), { ok: true, kind: "model" });
  assert.deepEqual(checkOpen("a.bin", 5, ["model", "part"]), { ok: true, kind: "part" });
  assert.equal(checkOpen("a.mp3", 5, ["model"]).ok, false);
  assert.equal(checkOpen("a.exe", 5, ["model"]).why, "type");
  assert.equal(checkOpen("a.usdz", 5, ["model"]).why, "type");
  assert.equal(checkOpen("a.psd", 5, ["image"]).why, "type");
  assert.equal(checkOpen("a.png", 0, ["image"]).why, "empty");
  assert.equal(checkOpen("a.png", LIMITS.image + 1, ["image"]).why, "big");
  assert.equal(checkOpen("a.mp4", LIMITS.video, ["video"]).ok, true);
  assert.equal(kindOfName("Scan.PLY"), "model");
  assert.equal(kindOfName("noext"), null);
  assert.match(acceptOf(["audio"]), /^\.wav,\.mp3,\.ogg/);
});

test("refusals are plain words in both languages", () => {
  setHebrew(false);
  assert.match(explain({ why: "big", limit: 100 * 1024 ** 2 }, "x.png", ["image"]), /up to 100 MB/);
  assert.match(explain({ why: "type" }, "x.exe", ["image"]), /PNG, JPG/);
  setHebrew(true);
  assert.match(explain({ why: "empty" }, "x.png", ["image"]), /ריק/);
  setHebrew(false);
});

test("Recent keeps the last 10, newest first, a file only once", () => {
  let list: Array<{ name: string; size: number }> = [];
  for (let i = 0; i < 12; i++) list = recentAdd(list, { name: `f${i}.glb`, size: i });
  assert.equal(list.length, 10);
  assert.equal(list[0]!.name, "f11.glb");
  list = recentAdd(list, { name: "f5.glb", size: 5 });
  assert.equal(list.length, 10);
  assert.equal(list[0]!.name, "f5.glb");
  assert.equal(list.filter((r) => r.name === "f5.glb").length, 1);
});

test("a glTF's buffers and pictures are found beside it, by path or by name; what is missing is named", () => {
  const json = { buffers: [{ uri: "scene.bin" }], images: [{ uri: "textures/wood%20oak.png" }, { uri: "C:\\Users\\x\\export\\metal.jpg" }, { uri: "data:image/png;base64,AAAA" }, { uri: "gone.png" }, { bufferView: 1 }] };
  const files = [f("scene.bin"), f("wood oak.png", "Model/textures/wood oak.png"), f("METAL.JPG")];
  const r = resolveGltf(json, files);
  assert.equal(r.found.get("scene.bin"), files[0]);
  assert.equal(r.found.get("textures/wood%20oak.png"), files[1]);
  assert.equal(r.found.get("C:\\Users\\x\\export\\metal.jpg"), files[2]);
  assert.deepEqual(r.missing, ["gone.png"]);
  assert.equal(findSibling("https://x.test/a.png", files), undefined);
  assert.equal(normPath(".\\Tex\\A%20b.PNG"), "tex/a b.png");
});

test("an OBJ's .mtl comes from its mtllib line (or the only .mtl), and the .mtl's pictures with their options skipped", () => {
  const files = [f("house.mtl"), f("brick.png"), f("other.mtl")];
  assert.equal(resolveObj("mtllib house.mtl\nv 0 0 0", files).mtl, files[0]);
  assert.deepEqual(resolveObj("mtllib nope.mtl\nv 0 0 0", files).missing, ["nope.mtl"]);
  assert.equal(resolveObj("v 0 0 0", [f("only.mtl")]).mtl?.name, "only.mtl");
  assert.equal(resolveObj("v 0 0 0", files).mtl, undefined);
  const mtl = "newmtl a\nmap_Kd brick.png\nmap_Bump -bm 1.0 bump map.png\nmap_Ks missing.png\nKd 1 1 1\n";
  assert.deepEqual(mtlTextures(mtl), ["brick.png", "bump map.png", "missing.png"]);
  const r = resolveMtl(mtl, [...files, f("bump map.png")]);
  assert.equal(r.found.get("brick.png"), files[1]);
  assert.deepEqual(r.missing, ["missing.png"]);
});

test("the model among the opened files is chosen by format, the rest ride along", () => {
  const files = [f("a.png"), f("m.obj"), f("m.glb"), f("m.mtl")];
  const { main, rest } = splitModel(files);
  assert.equal(main?.name, "m.glb");
  assert.equal(rest.length, 3);
  assert.equal(splitModel([f("a.png")]).main, undefined);
});
