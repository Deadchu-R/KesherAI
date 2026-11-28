import { test } from "node:test";
import assert from "node:assert/strict";
import { scenePreview, type SceneDiff } from "@kesher/shared";
import { BUILT_IN, buildSurfaces, itemFromResult } from "./surfaces.js";
import { changeMarks, countNodes, mergeDiff, objectAskMessage, parseGodotTree, parseHierarchy, parseUnityHierarchy, parseUnrealActors, sceneModel, sceneSummary } from "./scene-surface.js";

const list = buildSurfaces(BUILT_IN, { parts: [], pluginPages: [] });
const UNITY = "Scene: Assets/Scenes/Main.unity (unsaved changes)\nEach line: name #id (children). Use the #id with unity_inspect_object and unity_modify_scene.\nPlayer #101 (2 children)\n  Camera #102\n  Gun #103 (1 children)\n    Muzzle #104 (inactive)\nWorld #105 (40 children, not shown)\n";

test("scene tools open the scenes surface, one item per engine", () => {
  assert.deepEqual(itemFromResult(list, "unity_scene", true, UNITY), { surface: "scenes", kind: "scene", id: "unity", title: "Unity scene" });
  assert.equal(itemFromResult(list, "godot_edit", true, "ok")?.id, "godot");
  assert.equal(itemFromResult(list, "unreal_inspect_level", true, "x")?.id, "unreal");
  assert.equal(itemFromResult(list, "unity_scene", false, "no"), undefined);
  assert.equal(itemFromResult(list, "read_file", true, UNITY), undefined);
  const s = list.find((x) => x.id === "scenes")!;
  assert.equal(s.phone, "view+ask");
  assert.ok(s.tools.includes("unity_modify_scene") && s.tools.includes("godot_tree"));
});

test("Unity hierarchy: scene path, nesting, ids, inactive and hidden children", () => {
  const h = parseUnityHierarchy(UNITY);
  assert.equal(h.scene, "Assets/Scenes/Main.unity");
  assert.deepEqual(h.nodes.map((n) => n.name), ["Player", "World"]);
  assert.deepEqual(h.nodes[0]!.children.map((n) => n.path), ["Player/Camera", "Player/Gun"]);
  assert.equal(h.nodes[0]!.children[1]!.children[0]!.inactive, true);
  assert.equal(h.nodes[1]!.hidden, 40);
  assert.equal(countNodes(h.nodes), 5);
});

test("Unreal actors nest under the actor they are attached to; Godot tree is JSON", () => {
  const u = parseUnrealActors("/Game/Maps/Arena: 3 actors (live from the open editor).\nDoor_1 [Door_1] StaticMeshActor at (0, 0, 0) — mesh SM_Door; components A, B\nHandle StaticMeshActor at (1, 0, 0) — attached to Door_1\n    StaticMeshComponent0: Slot0=M_Wood\nLight_2 PointLight\n… 5 more: narrow with filter.");
  assert.equal(u.scene, "/Game/Maps/Arena");
  assert.deepEqual(u.nodes.map((n) => n.name), ["Door_1", "Light_2"]);
  assert.equal(u.nodes[0]!.children[0]!.path, "Door_1/Handle");
  const g = parseGodotTree(JSON.stringify({ scene: "res://main.tscn", root: { name: "Main", type: "Node2D", children: [{ name: "Hero", type: "Sprite2D" }] } }));
  assert.equal(g.scene, "res://main.tscn");
  assert.equal(g.nodes[0]!.children[0]!.path, "Main/Hero");
  assert.deepEqual(parseGodotTree("not json").nodes, []);
  assert.equal(parseHierarchy("unity", "unity_modify_scene", UNITY), undefined);
});

const diff = (objects: SceneDiff["objects"], extra: Partial<SceneDiff> = {}): SceneDiff => ({ engine: "unity", scene: "Assets/Scenes/Main.unity", objects, undo: "undo", readBefore: true, ...extra });

test("the scene diff model: added, removed, changed, joined across steps, only for changes that ran", () => {
  const a = diff([{ kind: "added", name: "Enemy", type: "Cube" }, { kind: "changed", name: "Player", props: [{ name: "position", from: "(0, 0, 0)", to: "(1, 2, 3)" }] }]);
  const b = diff([{ kind: "removed", name: "Enemy" }, { kind: "changed", name: "Player", props: [{ name: "position", from: "(1, 2, 3)", to: "(5, 0, 0)" }] }, { kind: "removed", name: "World" }]);
  const m = mergeDiff(a, b);
  assert.deepEqual(m.objects.map((o) => `${o.kind}:${o.name}`), ["changed:Player", "removed:World"]);
  assert.equal(m.objects[0]!.props![0]!.to, "(5, 0, 0)");
  const events = [
    { type: "tool_result", callId: "1", name: "unity_scene", ok: true, output: UNITY },
    { type: "approval_request", callId: "2", name: "unity_modify_scene", preview: scenePreview(a) },
    { type: "tool_result", callId: "2", name: "unity_modify_scene", ok: true, output: "done" },
    { type: "approval_request", callId: "3", name: "unity_modify_scene", preview: scenePreview(b) },
    { type: "tool_result", callId: "3", name: "unity_modify_scene", ok: false, output: "denied" },
  ];
  const model = sceneModel("unity", events);
  assert.equal(model.scene, "Assets/Scenes/Main.unity");
  assert.deepEqual(model.diff?.objects.map((o) => o.name), ["Enemy", "Player"]);
  assert.deepEqual(sceneSummary(model), { objects: 5, added: 1, removed: 0, changed: 1 });
  assert.equal(changeMarks(model.diff).get("Player"), "changed");
  assert.equal(sceneModel("godot", events).diff, undefined);
});

test("a picked object becomes the ask message with its changed values", () => {
  const change = { kind: "changed" as const, name: "Player", props: [{ name: "position", from: "(0, 0, 0)", to: "(1, 2, 3)" }] };
  const en = objectAskMessage({ engine: "unity", scene: "Assets/Main.unity", object: "Player/Gun", change, instruction: "Why did it move?", he: false });
  assert.ok(en.startsWith('In the Unity scene Assets/Main.unity, about the object "Player/Gun":'));
  assert.ok(en.includes("position: (0, 0, 0) → (1, 2, 3)") && en.endsWith("Why did it move?"));
  const he = objectAskMessage({ engine: "godot", object: "Main/Hero", instruction: "מה זה?", he: true });
  assert.ok(he.includes('על האובייקט "Main/Hero"') && he.includes("סצנת Godot"));
});
