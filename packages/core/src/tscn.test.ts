import { test } from "node:test";
import assert from "node:assert/strict";
import { readTscn, writeTscn } from "./tscn.js";

const SCENE = `[gd_scene format=3 uid="uid://cecaux1sm7mo0"]

[ext_resource type="PackedScene" uid="uid://b1" path="res://crate.tscn" id="1_crate"]

[node name="Level" type="Node3D" unique_id=11]

[node name="Crate" parent="." unique_id=22 instance=ExtResource("1_crate")]
transform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 2, 0, -1)

[node name="Arm" type="Node3D" parent="." unique_id=33]

[node name="Hand" type="Node3D" parent="Arm" unique_id=44]
visible = false

[node name="Hud" type="Node2D" parent="." unique_id=55]
position = Vector2(10, 20.5)
rotation = 0.5
`;

test("a Godot scene's nodes: paths as Godot names them, transforms, instances, 2D positions", () => {
  const n = readTscn(SCENE);
  assert.deepEqual(n.map((x) => x.path), [".", "Crate", "Arm", "Arm/Hand", "Hud"]);
  assert.deepEqual(n[1]!.transform, { basis: [1, 0, 0, 0, 1, 0, 0, 0, 1], origin: [2, 0, -1] });
  assert.equal(n[1]!.instance, "1_crate");
  assert.equal(n[1]!.uniqueId, "22");
  assert.deepEqual(n[4]!.position2d, [10, 20.5]);
  assert.equal(n[4]!.rotation2d, 0.5);
  assert.throws(() => readTscn("[gd_scene load_steps=2 format=2]"), /Godot 4/);
});

test("moves are written into only the transform lines; a node at the default gets one under its heading", () => {
  const { text, missing } = writeTscn(SCENE, [
    { path: "Crate", transform: { basis: [1, 0, 0, 0, 1, 0, 0, 0, 1], origin: [3.5, 0, -0.5] } },
    { path: "Arm/Hand", transform: { basis: [0, 0, -1, 0, 1, 0, 1, 0, 0], origin: [0, 1.25, 0] } },
    { path: "Hud", position2d: [12, 20.5] },
    { path: "Gone", position2d: [0, 0] },
  ]);
  assert.deepEqual(missing, ["Gone"]);
  assert.match(text, /\[node name="Crate"[^\n]*\]\ntransform = Transform3D\(1, 0, 0, 0, 1, 0, 0, 0, 1, 3\.5, 0, -0\.5\)\n/);
  assert.match(text, /\[node name="Hand"[^\n]*\]\ntransform = Transform3D\(0, 0, -1, 0, 1, 0, 1, 0, 0, 0, 1\.25, 0\)\nvisible = false/);
  assert.match(text, /position = Vector2\(12, 20\.5\)\nrotation = 0\.5/);
  // Everything else as it was.
  assert.equal(text.split("\n").length, SCENE.split("\n").length + 1);
  assert.deepEqual(readTscn(text).map((x) => x.path), readTscn(SCENE).map((x) => x.path));
});

test("each node's look: Godot's built-in meshes with their sizes (defaults when left out), models and scenes it instances", () => {
  const n = readTscn(`[gd_scene format=3]

[ext_resource type="PackedScene" path="res://models/tree.glb" id="1_t"]
[ext_resource type="PackedScene" path="res://door.tscn" id="2_d"]

[sub_resource type="BoxMesh" id="BoxMesh_a"]
size = Vector3(2, 0.5, 3)

[sub_resource type="CylinderMesh" id="Cyl_b"]
height = 4.0

[node name="Level" type="Node3D"]

[node name="Floor" type="MeshInstance3D" parent="."]
mesh = SubResource("BoxMesh_a")

[node name="Pillar" type="MeshInstance3D" parent="."]
mesh = SubResource("Cyl_b")

[node name="Tree" parent="." instance=ExtResource("1_t")]

[node name="Door" parent="." instance=ExtResource("2_d")]
`);
  assert.deepEqual(n[1]!.shape, { kind: "box", size: [2, 0.5, 3] });
  assert.deepEqual(n[2]!.shape, { kind: "cylinder", topRadius: 0.5, bottomRadius: 0.5, height: 4 });
  assert.equal(n[3]!.model, "res://models/tree.glb");
  assert.equal(n[4]!.scene, "res://door.tscn");
});

test("the outliner's details and 2D sprites: a node's script, a sprite's picture, a collision shape's kind", async () => {
  const { readTscn } = await import("./tscn.js");
  const text = `[gd_scene format=3]

[ext_resource type="Script" path="res://fox.gd" id="1_a"]
[ext_resource type="Texture2D" path="res://fox.png" id="2_b"]

[sub_resource type="CapsuleShape2D" id="C_1"]

[node name="World" type="Node2D"]

[node name="Fox" type="Sprite2D" parent="."]
position = Vector2(150, 420)
texture = ExtResource("2_b")
script = ExtResource("1_a")

[node name="Hit" type="CollisionShape2D" parent="Fox"]
shape = SubResource("C_1")
`;
  const n = readTscn(text);
  assert.equal(n[1]!.script, "res://fox.gd");
  assert.equal(n[1]!.texture, "res://fox.png");
  assert.deepEqual(n[1]!.position2d, [150, 420]);
  assert.equal(n[2]!.collision, "CapsuleShape2D");
});

test("2D: rotation and scale written too, added where the file left them at the default", async () => {
  const { writeTscn } = await import("./tscn.js");
  const text = `[gd_scene format=3]\n\n[node name="W" type="Node2D"]\n\n[node name="Fox" type="Sprite2D" parent="."]\nposition = Vector2(1, 2)\nscale = Vector2(2, 2)\n\n[node name="Coin" type="Sprite2D" parent="."]\n`;
  const out = writeTscn(text, [{ path: "Fox", position2d: [5, 6], rotation2d: 0.5, scale2d: [1, 1] }, { path: "Coin", position2d: [3, 4], rotation2d: 0, scale2d: [1, 1] }]).text;
  assert.match(out, /\[node name="Fox"[^\n]*\]\nrotation = 0\.5\nposition = Vector2\(5, 6\)\nscale = Vector2\(1, 1\)/);
  assert.match(out, /\[node name="Coin"[^\n]*\]\nposition = Vector2\(3, 4\)\n/);
  assert.doesNotMatch(out, /Coin[^[]*rotation/);
});
