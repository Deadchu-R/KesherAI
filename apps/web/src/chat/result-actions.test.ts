import { test } from "node:test";
import assert from "node:assert/strict";
import { directResults, imageActions, pbrActions, pbrMaps, pbrSets, playerActions, stepActions, type ActionStep } from "./result-actions.js";

const A = "0f8fad5b-d9cb-469f-a165-70867728950e";
const B = "1f8fad5b-d9cb-469f-a165-70867728950e";
const gen: ActionStep = { call: { callId: "c1", name: "generate_image", input: { prompt: "a red fox", width: 768 } }, result: { ok: true, output: "", assetIds: [A] } };

test("a picture's buttons follow what the chat can run", () => {
  assert.deepEqual(imageActions(A, gen, []).map((a) => a.id), ["canvas"], "nothing to run: only the canvas");
  const all = imageActions(A, gen, ["generate_image", "upscale_image", "remove_background", "unity_import_sprite", "unity_create_pbr_material"]);
  assert.deepEqual(all.map((a) => a.id), ["canvas", "upscale", "variations", "nobg", "unity", "texture"]);
  assert.deepEqual(all.find((a) => a.id === "variations")!.do, { tool: "generate_image", input: { prompt: "a red fox", width: 768 }, times: 4 });
  assert.deepEqual(all.find((a) => a.id === "unity")!.do, { tool: "unity_import_sprite", input: { file: A } });
  const shot: ActionStep = { call: { callId: "c2", name: "browser_screenshot", input: {} } };
  assert.ok(!imageActions(A, shot, ["generate_image"]).some((a) => a.id === "variations"), "no prompt, no variations");
});

test("sounds and videos: Save, and Transcribe when it is there", () => {
  assert.deepEqual(playerActions(A, "audio", []).map((a) => a.id), ["save"]);
  assert.deepEqual(playerActions(A, "video", ["transcribe_audio"]).map((a) => a.id), ["save", "transcribe"]);
});

test("a step's buttons: diff and PBR in the canvas, engine page and Undo", () => {
  const edit: ActionStep = { call: { callId: "e", name: "edit_file", input: { path: "src/a.ts" } }, result: { ok: true, output: "", diff: "@@ -1 +1 @@\n-a\n+b" } };
  assert.deepEqual(stepActions(edit).map((a) => a.id), ["diff"]);
  const mat: ActionStep = { call: { callId: "m", name: "unity_create_pbr_material", input: { name: "Rust", maps: { albedo: A, normal: B, roughness: "C:/x.png" } } }, result: { ok: true, output: "done" } };
  assert.deepEqual(pbrMaps(mat), { albedo: A, normal: B });
  assert.deepEqual(stepActions(mat, "r1").map((a) => a.id), ["pbr", "engine", "undo"]);
  assert.deepEqual(stepActions(mat).map((a) => a.id), ["pbr", "engine"], "no receipt, no Undo");
  assert.deepEqual(stepActions({ ...mat, result: { ok: false, output: "x" } }), [], "a failed step gets none");
  assert.equal(pbrMaps({ call: { callId: "x", name: "y", input: { maps: { albedo: A } } } }), undefined, "one map is not a set");
});

test("a button's own results are found among the chat's events", () => {
  const ev = [
    { seq: 1, type: "tool_call", callId: "c1", name: "generate_image" },
    { seq: 2, type: "tool_call", callId: "direct-1", name: "generate_image" },
    { seq: 3, type: "tool_result", callId: "direct-1", name: "generate_image" },
    { seq: 4, type: "tool_call", callId: "direct-2", name: "generate_image" },
    { seq: 5, type: "tool_call", callId: "direct-3", name: "upscale_image" },
  ];
  const r = directResults(ev, 1, "generate_image");
  assert.deepEqual(r.done.map((e) => e.callId), ["direct-1"]);
  assert.deepEqual(r.running, ["direct-2"]);
  assert.deepEqual(directResults(ev, 3, "generate_image").done, []);
});

test("a made PBR set: canvas, Apply to selected in Unity, Save as material, 4 variations", () => {
  const id = (n: number) => `${n}f8fad5b-d9cb-469f-a165-70867728950e`;
  const output = `Made 1 PBR texture set(s) "Old Brick" with x.safetensors; the user sees the maps.\nSet 1: albedo=${id(0)} normal=${id(1)} roughness=${id(2)} ao=${id(3)} height=${id(4)} (1024x1024, seam fixed, seam 1.02)`;
  const step: ActionStep = { call: { callId: "p1", name: "make_pbr_texture", input: { prompt: "old brick wall" } }, result: { ok: true, output, assetIds: [id(0)] } };
  assert.deepEqual(pbrSets(step), [{ albedo: id(0), normal: id(1), roughness: id(2), ao: id(3), height: id(4) }]);
  const all = pbrActions(step, ["make_pbr_texture", "unity_create_pbr_material"]);
  assert.deepEqual(all.map((a) => a.id), ["pbr", "apply", "material", "variations"]);
  assert.deepEqual(all[1]!.do, { tool: "unity_create_pbr_material", input: { name: "Old Brick", maps: { albedo: id(0), normal: id(1), roughness: id(2), ao: id(3) }, apply_to: ["selection"] } });
  assert.equal("apply_to" in (all[2]!.do as { input: object }).input, false);
  assert.deepEqual(all[3]!.do, { tool: "make_pbr_texture", input: { prompt: "old brick wall", name: "Old Brick", count: 4 } });
  // Without Unity: only the canvas (and variations when it can run).
  assert.deepEqual(pbrActions(step, []).map((a) => a.id), ["pbr"]);
  assert.deepEqual(stepActions(step, undefined, ["unity_create_pbr_material"]).map((a) => a.id), ["pbr", "apply", "material"]);
  // Several sets: numbered canvas and Apply buttons, one Variations.
  const two = { ...step, result: { ...step.result!, output: `${output}\nSet 2: albedo=${id(5)} normal=${id(6)} (1024x1024, checked, seam 1.1)` } };
  assert.deepEqual(pbrActions(two, ["make_pbr_texture", "unity_create_pbr_material"]).map((a) => a.id), ["pbr 1", "apply 1", "pbr 2", "apply 2", "variations"]);
  assert.deepEqual(pbrSets({ ...step, result: { ...step.result!, ok: false } }), []);
});

test("a PBR set's albedo has no sprite or texture buttons of its own", () => {
  const step: ActionStep = { call: { callId: "p1", name: "make_pbr_texture", input: { prompt: "x" } }, result: { ok: true, output: "" } };
  assert.deepEqual(imageActions("0f8fad5b-d9cb-469f-a165-70867728950e", step, ["unity_import_sprite", "unity_create_pbr_material", "remove_background"]).map((a) => a.id), ["canvas", "nobg"]);
});
