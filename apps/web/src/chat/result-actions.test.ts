import { test } from "node:test";
import assert from "node:assert/strict";
import { directResults, imageActions, pbrMaps, playerActions, stepActions, type ActionStep } from "./result-actions.js";

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
