import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILT_IN, buildSurfaces, itemFromResult, openTarget } from "./surfaces.js";
import { MODEL_FILES, chooseView, classifyGpu, detectGpu, modelFromResult, partAskMessage, partsFromGlb, partsFromGltf, partsFromObj, resetGpuDetection } from "./model-surface.js";

const list = buildSurfaces(BUILT_IN, { parts: [], pluginPages: [] });

test("3D files and make_3d results open the model surface", () => {
  for (const f of ["a.glb", "x/b.GLTF", "c.fbx", "d.obj"]) assert.ok(MODEL_FILES.test(f), f);
  assert.ok(!MODEL_FILES.test("a.png") && !MODEL_FILES.test("model.glb.txt"));
  assert.equal(openTarget(BUILT_IN, list, "fox.fbx") && "surface" in openTarget(BUILT_IN, list, "fox.fbx")! && openTarget(BUILT_IN, list, "fox.fbx")!.surface.id, "model");
  assert.equal(openTarget(BUILT_IN, list, "fox.glb")!.surface.id, "model");
  const it = itemFromResult(list, "make_3d", true, "Made the 3D model models/fox.glb (GLB, with its colours and materials); the user can download it.");
  assert.deepEqual(it, { surface: "model", kind: "model", id: "models/fox.glb", path: "models/fox.glb", title: "fox.glb" });
  assert.equal(itemFromResult(list, "make_3d", false, "Made the 3D model a.glb"), undefined);
  assert.equal(itemFromResult(list, "write_file", true, "Made the 3D model a.glb"), undefined);
  assert.equal(modelFromResult("make_3d", true, "ComfyUI is not installed."), undefined);
  assert.equal(modelFromResult("make_3d", true, "Made the 3D model out\\car.obj."), "out/car.obj");
});

test("the live viewer or the static poster: no WebGL2, software drawing, and the user's switch", () => {
  assert.equal(classifyGpu(false), "none");
  assert.equal(classifyGpu(true, "ANGLE (NVIDIA GeForce RTX 3090)"), "gpu");
  assert.equal(classifyGpu(true, "Google SwiftShader"), "software");
  assert.equal(classifyGpu(true, "llvmpipe (LLVM 15)"), "software");
  assert.equal(chooseView("gpu"), "live");
  assert.equal(chooseView("software"), "poster");
  assert.equal(chooseView("software", "live"), "live");
  assert.equal(chooseView("gpu", "static"), "poster");
  assert.equal(chooseView("none", "live"), "poster");
});

test("the GPU is probed once per page", () => {
  resetGpuDetection();
  let made = 0;
  const gl = { getExtension: () => null, getParameter: () => "" };
  const make = () => { made++; return { getContext: () => gl }; };
  assert.equal(detectGpu(make), "gpu");
  assert.equal(detectGpu(() => { throw new Error("no"); }), "gpu");
  assert.equal(made, 1);
  resetGpuDetection();
  assert.equal(detectGpu(() => ({ getContext: () => null })), "none");
  resetGpuDetection();
});

test("parts and materials are read from a file without drawing it", () => {
  const json = { meshes: [{ name: "Body" }, {}], materials: [{ name: "Fur", pbrMetallicRoughness: { baseColorFactor: [1, 0.5, 0, 1] } }, {}] };
  assert.deepEqual(partsFromGltf(json), { meshes: ["Body", "mesh 1"], materials: [{ name: "Fur", color: "#ff8000" }, { name: "material 1" }] });
  const body = new TextEncoder().encode(JSON.stringify(json).padEnd(Math.ceil(JSON.stringify(json).length / 4) * 4, " "));
  const buf = new ArrayBuffer(20 + body.length);
  const v = new DataView(buf);
  v.setUint32(0, 0x46546c67, true); v.setUint32(4, 2, true); v.setUint32(8, buf.byteLength, true);
  v.setUint32(12, body.length, true); v.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(buf, 20).set(body);
  assert.deepEqual(partsFromGlb(buf)?.meshes, ["Body", "mesh 1"]);
  assert.equal(partsFromGlb(new ArrayBuffer(40)), undefined);
  assert.deepEqual(partsFromObj("o Hull\nusemtl Steel\ng Hull\ng Door\nusemtl Steel\n"), { meshes: ["Hull", "Door"], materials: [{ name: "Steel" }] });
});

test("a picked part becomes the ask message, in Hebrew and English", () => {
  const en = partAskMessage({ path: "models/fox.glb", part: "Tail", material: "Fur", instruction: " Make it longer? ", he: false });
  assert.equal(en, 'In the 3D model models/fox.glb, about the part "Tail" (material "Fur"):\n\nMake it longer?');
  const he = partAskMessage({ path: "fox.glb", part: "Tail", instruction: "למה זה כהה?", he: true });
  assert.ok(he.startsWith('במודל התלת ממד fox.glb, על החלק "Tail":') && he.endsWith("למה זה כהה?"));
  assert.ok(partAskMessage({ path: "a", part: "x".repeat(500), instruction: "q", he: false }).length < 400);
});

test("the surface is registered with its phone mode, tools and lazy parts", () => {
  const s = list.find((x) => x.id === "model")!;
  assert.equal(s.phone, "view+ask");
  assert.deepEqual(s.tools, ["make_3d"]);
  assert.ok(typeof s.card === "function" && typeof s.panel === "function");
  assert.ok(s.selection?.({ item: { surface: "model", kind: "model", id: "a.glb" }, title: "", selection: "Tail", instruction: "why?", change: false, he: false }).includes('"Tail"'));
});
