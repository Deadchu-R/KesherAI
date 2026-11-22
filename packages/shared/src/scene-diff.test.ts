import assert from "node:assert/strict";
import { test } from "node:test";
import { parseScenePreview, previewText, sceneCounts, sceneDiffText, scenePreview, type SceneDiff } from "./scene-diff.js";

const diff: SceneDiff = {
  engine: "unity",
  scene: "Assets/Main.unity",
  undo: "undo",
  readBefore: true,
  objects: [
    { kind: "added", name: "Enemy", type: "Cube", components: { added: ["Rigidbody"] } },
    { kind: "removed", name: "Old --> Door" },
    { kind: "changed", name: "Player", props: [{ name: "position", from: "(0.00, 0.00, 0.00)", to: "(1, 2, 3)" }] },
  ],
};

test("the preview carries a readable text and the diff, and reads back the same", () => {
  const p = scenePreview(diff);
  assert.match(p, /^Unity scene Assets\/Main\.unity: 1 added, 1 removed, 1 changed\n\+ Enemy \(Cube\) \+Rigidbody\n- Old --> Door\n~ Player\n {4}position: \(0\.00, 0\.00, 0\.00\) → \(1, 2, 3\)\n<!--kesher-scene /);
  const got = parseScenePreview(p);
  assert.deepEqual(got?.diff, diff);
  assert.equal(got?.text, sceneDiffText(diff));
  assert.equal(previewText(p), sceneDiffText(diff));
  assert.deepEqual(sceneCounts(diff), { added: 1, removed: 1, changed: 1 });
});

test("a plain or broken preview has no diff", () => {
  assert.equal(parseScenePreview("--- a/x\n+++ b/x"), undefined);
  assert.equal(parseScenePreview("x\n<!--kesher-scene {bad-->"), undefined);
  assert.equal(parseScenePreview('x\n<!--kesher-scene {"engine":"cry","undo":"undo","objects":[]}-->'), undefined);
  assert.equal(previewText("just text"), "just text");
});

test("objects of the wrong shape are dropped and long text is cut", () => {
  const p = `t\n<!--kesher-scene ${JSON.stringify({ engine: "godot", undo: "queued", readBefore: "yes", objects: [{ kind: "bad", name: "x" }, { kind: "changed", name: "N".repeat(400), props: [{ name: "a" }, { name: "b", to: "1", from: 5 }] }] })}-->`;
  const got = parseScenePreview(p)!.diff;
  assert.equal(got.readBefore, false);
  assert.equal(got.objects.length, 1);
  assert.equal(got.objects[0]!.name.length, 300);
  assert.deepEqual(got.objects[0]!.props, [{ name: "b", to: "1" }]);
});

test("a level plan travels in the preview, checked: bad numbers and a short before-list drop the plan", () => {
  const diff = { engine: "unity" as const, scene: "Assets/A.unity", objects: [{ kind: "changed" as const, name: "Crate" }], undo: "checkpoint" as const, readBefore: true, plan: { min: [0, 0] as [number, number], max: [10, 10] as [number, number], rest: [[1, 1]] as Array<[number, number]>, before: [[2, 2]] as Array<[number, number]>, after: [[3, 3], [4, 4]] as Array<[number, number]>, moved: 1 } };
  assert.deepEqual(parseScenePreview(scenePreview(diff))?.diff.plan, diff.plan);
  const bad = scenePreview({ ...diff, plan: { ...diff.plan, before: [] } });
  assert.equal(parseScenePreview(bad)?.diff.plan, undefined);
  const nan = scenePreview(diff).replace('"min":[0,0]', '"min":["x",0]');
  assert.equal(parseScenePreview(nan)?.diff.plan, undefined);
});
