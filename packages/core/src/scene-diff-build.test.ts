import assert from "node:assert/strict";
import { test } from "node:test";
import { godotEditDiff, parseUnityBefore, unityAddComponentDiff, unityCreateDiff, unityModifyDiff, unrealMaterialDiff } from "./scene-diff-build.js";
import { beforeCs, parseSceneChanges, type SceneChange } from "./unity-edit-tools.js";

test("Unity: the Editor's before-read becomes old → new values per object", () => {
  const changes = parseSceneChanges([
    { object: "#-12", action: "move", value: [1, 2, 3] },
    { object: "#-12", action: "set_property", component: "Rigidbody", property: "m_Mass", value: 5 },
    { object: "#-12", action: "move", value: [4, 5, 6] },
    { object: "Level/Old", action: "rename", value: "New" },
    { object: "Level/Old", action: "delete" },
    { object: "Ghost", action: "set_active", value: false },
  ]) as SceneChange[];
  const before = parseUnityBefore("Player #-12\t(0.00, 0.00, 0.00)\nPlayer #-12\t1\nPlayer #-12\t(1.00, 2.00, 3.00)\nLevel/Old #-40\tOld\nLevel/Old #-40\t\n(not found)\n", changes.length);
  const d = unityModifyDiff(changes, before);
  assert.equal(d.readBefore, true);
  assert.deepEqual(d.objects, [
    { kind: "changed", name: "Player #-12", props: [{ name: "position", from: "(0.00, 0.00, 0.00)", to: "(4, 5, 6)" }, { name: "Rigidbody.m_Mass", from: "1", to: "5" }] },
    { kind: "removed", name: "Level/Old #-40" },
    { kind: "changed", name: "Ghost", props: [{ name: "active", to: "false" }] },
  ]);
  // No answer from the Editor: only the new values.
  assert.equal(parseUnityBefore("", 2), undefined);
  assert.equal(unityModifyDiff(changes, undefined).readBefore, false);
});

test("Unity: the before-read C# quotes every name and reads each kind of value", () => {
  const cs = beforeCs(parseSceneChanges([{ object: 'A"; System.IO.File.Delete("x"); //', action: "scale", value: [1, 1, 1] }, { object: "B", action: "set_property", component: "Light", property: "m_Intensity", value: 2 }]) as SceneChange[]);
  assert.match(cs, /Resolve\("A\\"; System\.IO\.File\.Delete\(\\"x\\"\); \/\/"\)/);
  assert.match(cs, /tr\.localScale\.ToString\(\)/);
  assert.match(cs, /Prop\(go, "Light", "m_Intensity"\)/);
  assert.match(cs, /Val = p =>/);
});

test("Unity: a new object and added components", () => {
  assert.deepEqual(unityCreateDiff({ name: "Enemy", primitive: "Cube", parent: "Level", position: [0, 1, 0], components: ["Rigidbody"] }).objects, [
    { kind: "added", name: "Level/Enemy", type: "Cube", components: { added: ["Rigidbody"] }, props: [{ name: "parent", to: "Level" }, { name: "position", to: "(0, 1, 0)" }] },
  ]);
  assert.deepEqual(unityAddComponentDiff({ gameObject: "Player", components: ["AudioSource"] }).objects[0]!.components, { added: ["AudioSource"] });
});

test("Godot: set ops show the editor's current value; add and remove are listed", () => {
  const d = godotEditDiff([
    { op: "add", parent: "Level", type: "Sprite2D", name: "Coin" },
    { op: "set", path: "Player", property: "position", value: "Vector2(10, 20)" },
    { op: "remove", path: "Old" },
    { op: "attach_script", path: "Player", script: "res://player.gd" },
  ], { Player: { position: "Vector2(0, 0)" } });
  assert.deepEqual(d.objects, [
    { kind: "added", name: "Level/Coin", type: "Sprite2D" },
    { kind: "changed", name: "Player", props: [{ name: "position", from: "Vector2(0, 0)", to: "Vector2(10, 20)" }, { name: "script", to: "res://player.gd" }] },
    { kind: "removed", name: "Old" },
  ]);
  assert.equal(d.readBefore, true);
});

test("Unreal: the slot's old material, by index or name", () => {
  const slots = [{ component: "StaticMeshComponent0", materials: [{ slot: "Body", material: "/Game/M_Old.M_Old" }, { slot: "Glass", material: "" }] }];
  const d = unrealMaterialDiff({ level: "/Game/Maps/Arena", actor: "Crate", actorClass: "StaticMeshActor", component: "", slot: "1", material: "/Game/MI_Glass", slots, undo: "queued" });
  assert.deepEqual(d.objects[0], { kind: "changed", name: "Crate", type: "StaticMeshActor", props: [{ name: "StaticMeshComponent0 slot 1", from: "None", to: "/Game/MI_Glass" }] });
  assert.equal(d.undo, "queued");
  assert.equal(unrealMaterialDiff({ level: "/Game/A", actor: "X", component: "", slot: "Body", material: "/Game/M", slots, undo: "undo" }).objects[0]!.props![0]!.from, "/Game/M_Old.M_Old");
  assert.equal(unrealMaterialDiff({ level: "/Game/A", actor: "X", component: "", slot: "0", material: "/Game/M", undo: "undo" }).readBefore, false);
});
