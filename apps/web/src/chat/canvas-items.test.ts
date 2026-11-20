import { test } from "node:test";
import assert from "node:assert/strict";
import { diffCounts, diffVersions, imageHistory, stepZoom } from "./canvas-items.js";

test("a picture's history: the chat's made pictures in order, without screen shots or song covers", () => {
  const ev = [
    { type: "tool_result", name: "generate_image", ok: true, assetIds: ["a"] },
    { type: "tool_result", name: "browser_screenshot", ok: true, assetIds: ["shot"] },
    { type: "tool_result", name: "make_music", ok: true, assetIds: ["cover"], audioIds: ["song"] },
    { type: "tool_result", name: "upscale_image", ok: true, assetIds: ["b", "a"] },
    { type: "tool_result", name: "generate_image", ok: false, assetIds: ["bad"] },
  ];
  assert.deepEqual(imageHistory(ev), ["a", "b"]);
  assert.deepEqual(imageHistory(ev, "z"), ["a", "b", "z"]);
});

test("a file's diffs in this chat are its versions", () => {
  const ev = [
    { type: "tool_call", callId: "1", input: { path: "a.ts" } },
    { type: "tool_result", callId: "1", diff: "d1" },
    { type: "tool_call", callId: "2", input: { path: "b.ts" } },
    { type: "tool_result", callId: "2", diff: "other" },
    { type: "tool_call", callId: "3", input: { path: "a.ts" } },
    { type: "tool_result", callId: "3", diff: "d2" },
  ];
  assert.deepEqual(diffVersions(ev, "a.ts", "d1"), { versions: ["d1", "d2"], current: 0 });
  assert.deepEqual(diffVersions(ev, "", "x"), { versions: ["x"], current: 0 });
});

test("diff counts and zoom steps", () => {
  assert.deepEqual(diffCounts("--- a\n+++ b\n@@\n-x\n+y\n+z"), { added: 2, removed: 1 });
  assert.equal(stepZoom(1, 1), 1.25);
  assert.equal(stepZoom(1, -1), 0.8);
  assert.equal(stepZoom(16, 1), 16);
  assert.equal(stepZoom(0.1, -1), 0.1);
});
