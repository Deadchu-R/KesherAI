import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeElements, sceneKey } from "./canvas-merge.js";

test("canvas merge: the higher version wins per element, the server on a tie; new ones from both sides stay", () => {
  const local = [{ id: "a", version: 3, t: "mine" }, { id: "b", version: 2, t: "mine" }, { id: "c", version: 1, t: "only mine" }];
  const remote = [{ id: "a", version: 2, t: "old" }, { id: "b", version: 2, t: "model" }, { id: "d", version: 1, t: "model added" }];
  assert.deepEqual(mergeElements(local, remote).map((e) => `${e.id}:${e.t}`), ["a:mine", "b:model", "c:only mine", "d:model added"]);
  assert.deepEqual(mergeElements([], remote).map((e) => e.id), ["a", "b", "d"]);
  assert.equal(sceneKey(local), "3:6");
  assert.notEqual(sceneKey(local), sceneKey(mergeElements(local, remote)));
});
