import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyValues, godotText, readGodotInspector, readUnityInspector, setGodotValue, unityText, unityValue, ValueQueue, type ValueEdit } from "./game-inspector.js";

const PREFAB = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &100
GameObject:
  m_ObjectHideFlags: 0
  serializedVersion: 6
  m_Component:
  - component: {fileID: 400}
  - component: {fileID: 540}
  - component: {fileID: 1140}
  m_Layer: 0
  m_Name: Player
  m_IsActive: 1
--- !u!4 &400
Transform:
  m_GameObject: {fileID: 100}
  m_LocalPosition: {x: 0, y: 1, z: 0}
  m_Children: []
  m_Father: {fileID: 0}
--- !u!54 &540
Rigidbody:
  m_GameObject: {fileID: 100}
  serializedVersion: 4
  m_Mass: 1
  m_UseGravity: 1
--- !u!114 &1140
MonoBehaviour:
  m_GameObject: {fileID: 100}
  m_Script: {fileID: 11500000, guid: 0123456789abcdef0123456789abcdef, type: 3}
  speed: 5.5
  title: Hero
  target: {fileID: 400}
  waypoints:
  - {x: 1, y: 0, z: 0}
  - {x: 2, y: 0, z: 0}
--- !u!1001 &9000
PrefabInstance:
  m_Modification:
    m_TransformParent: {fileID: 400}
    m_Modifications:
    - target: {fileID: 77, guid: fedcba9876543210fedcba9876543210, type: 3}
      propertyPath: m_Name
      value: Gun
      objectReference: {fileID: 0}
  m_SourcePrefab: {fileID: 100100000, guid: fedcba9876543210fedcba9876543210, type: 3}
`;

test("Unity: components and values of a prefab, placed prefabs with their overrides", () => {
  const objs = readUnityInspector(PREFAB);
  const player = objs.find((o) => o.name === "Player")!;
  assert.deepEqual(player.components.map((c) => c.type), ["GameObject", "Transform", "Rigidbody", "MonoBehaviour"]);
  const rb = player.components[2]!;
  assert.deepEqual(rb.fields.map((f) => [f.name, f.value, f.editable]), [["m_Mass", "1", true], ["m_UseGravity", "1", true]]);
  const mb = player.components[3]!;
  assert.equal(mb.script, "0123456789abcdef0123456789abcdef");
  assert.deepEqual(mb.fields.map((f) => [f.name, f.value, f.editable]), [["speed", "5.5", true], ["title", "Hero", true], ["target", "{fileID: 400}", false], ["waypoints", "[2]", false]]);
  const gun = objs.find((o) => o.name === "Gun")!;
  assert.equal(gun.prefab?.source, "fedcba9876543210fedcba9876543210");
  assert.equal(unityValue(PREFAB, "540", "m_Mass"), "1");
});

test("Unity: typed values are checked and quoted, and a queued value goes in or clashes", () => {
  assert.equal(unityText("1", "2.5"), "2.5");
  assert.throws(() => unityText("1", "heavy"));
  assert.equal(unityText("{x: 0, y: 1, z: 0}", "{x: 1, y: 2, z: 3}"), "{x: 1, y: 2, z: 3}");
  assert.throws(() => unityText("{x: 0, y: 1, z: 0}", "{x: 1, y: 2}"));
  assert.equal(unityText("Hero", "Big: Hero"), "'Big: Hero'");
  const e = (name: string, target: string, from: string, to: string): ValueEdit => ({ id: name, engine: "unity", project: "/p", file: "Assets/P.prefab", object: "Player", target, name, from, to, at: "" });
  const r = applyValues(PREFAB, [e("m_Mass", "540", "1", "3"), e("speed", "1140", "9", "7")]);
  assert.equal(r.applied.length, 1);
  assert.equal(r.clashes[0]!.clash!.now, "5.5");
  assert.equal(unityValue(r.text, "540", "m_Mass"), "3");
  assert.equal(r.text.replace("  m_Mass: 3", "  m_Mass: 1"), PREFAB, "only that line changed");
});

const TSCN = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://player.gd" id="1"]
[ext_resource type="PackedScene" path="res://gun.tscn" id="2"]

[sub_resource type="BoxShape3D" id="Box_1"]
size = Vector3(1, 2, 1)

[node name="Main" type="Node3D"]

[node name="Player" type="CharacterBody3D" parent="."]
script = ExtResource("1")
speed = 5.0
title = "Hero"
visible = false

[node name="Gun" parent="Player" instance=ExtResource("2")]
ammo = 12
`;

test("Godot: nodes, sub-resources and instanced scenes with their saved values; typed values checked", () => {
  const objs = readGodotInspector(TSCN);
  assert.deepEqual(objs.map((o) => o.id), ["sub:Box_1", ".", "Player", "Player/Gun"]);
  const player = objs.find((o) => o.id === "Player")!;
  assert.equal(player.parent, ".");
  assert.equal(player.components[0]!.scriptPath, "res://player.gd");
  assert.deepEqual(player.components[0]!.fields.map((f) => [f.name, f.editable]), [["speed", true], ["title", true], ["visible", true]]);
  assert.equal(objs[3]!.prefab?.source, "res://gun.tscn");
  assert.equal(godotText("Vector3(1, 2, 1)", "Vector3(2, 2, 2)"), "Vector3(2, 2, 2)");
  assert.throws(() => godotText("Vector3(1, 2, 1)", "Vector2(2, 2)"));
  assert.equal(godotText('"Hero"', 'Big "Hero"'), '"Big \\"Hero\\""');
  assert.throws(() => godotText("false", "1"));
  const out = setGodotValue(TSCN, "Player/Gun", "ammo", "30");
  assert.match(out, /\nammo = 30\n/);
  assert.equal(out.replace("ammo = 30", "ammo = 12"), TSCN);
  assert.throws(() => setGodotValue(TSCN, "Player", "missing", "1"));
});

test("the queue keeps the first 'from', writes at sync, and holds clashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-values-"));
  try {
    const project = join(root, "G");
    await mkdir(project);
    await writeFile(join(project, "main.tscn"), TSCN);
    const q = new ValueQueue(root);
    const base = { engine: "godot" as const, project, file: "main.tscn", object: "Gun", target: "Player/Gun", name: "ammo" };
    await q.add({ ...base, from: "12", to: "20" });
    await q.add({ ...base, from: "20", to: "30" });
    await q.add({ ...base, target: "Player", object: "Player", name: "speed", from: "4.0", to: "6.0" });
    assert.equal((await q.list()).length, 2);
    const kept: string[] = [];
    const r = await q.sync("godot", project, async (abs) => { kept.push(abs); });
    assert.deepEqual([r.applied, r.clashes], [1, 1]);
    assert.deepEqual(kept, [join(project, "main.tscn")]);
    assert.match(await readFile(join(project, "main.tscn"), "utf8"), /ammo = 30/);
    const left = await q.list();
    assert.equal(left[0]!.clash!.now, "5.0");
    assert.equal(await q.decide(left[0]!.id, "mine"), true);
    assert.equal((await q.sync("godot", project)).applied, 1);
    assert.match(await readFile(join(project, "main.tscn"), "utf8"), /speed = 6.0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
