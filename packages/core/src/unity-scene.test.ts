import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeMoves, readUnityScene } from "./unity-scene.js";

const SCENE = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &100
GameObject:
  m_ObjectHideFlags: 0
  m_PrefabInstance: {fileID: 0}
  m_Component:
  - component: {fileID: 101}
  m_Name: Crate
--- !u!4 &101
Transform:
  m_GameObject: {fileID: 100}
  m_LocalRotation: {x: 0, y: 0.70710677, z: 0, w: 0.70710677}
  m_LocalPosition: {x: 2, y: 0, z: -1.5}
  m_LocalScale: {x: 1, y: 1, z: 1}
  m_Father: {fileID: 0}
--- !u!1 &200
GameObject:
  m_PrefabInstance: {fileID: 900}
  m_Name: Door
--- !u!4 &201 stripped
Transform:
  m_GameObject: {fileID: 200}
  m_LocalPosition: {x: 0, y: 1, z: 0}
  m_Father: {fileID: 101}
`;

test("a Unity scene's objects: names, parents, local position / rotation / scale, prefabs marked", () => {
  const o = readUnityScene(SCENE);
  assert.deepEqual(o.map((x) => [x.id, x.name, x.parent]), [["101", "Crate", "0"], ["201", "Door", "101"]]);
  assert.deepEqual(o[0]!.position, [2, 0, -1.5]);
  assert.deepEqual(o[0]!.rotation, [0, 0.70710677, 0, 0.70710677]);
  assert.deepEqual(o[1]!.rotation, [0, 0, 0, 1]);
  assert.equal(o[1]!.prefab, true);
  assert.throws(() => readUnityScene("binary"), /Force Text/);
});

test("moves waiting for Unity: a newer move of the same object replaces the older, keeping its first 'from'", () => {
  const a = { id: "101", name: "Crate", from: { position: [2, 0, -1.5], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, to: { position: [3, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } };
  const b = { ...a, from: { ...a.from, position: [3, 0, 0] }, to: { ...a.to, position: [4, 0, 0] } };
  const m = mergeMoves(mergeMoves({}, "Assets/A.unity", [a]), "Assets/A.unity", [b]);
  assert.equal(m["Assets/A.unity"]!.length, 1);
  assert.deepEqual(m["Assets/A.unity"]![0]!.from.position, [2, 0, -1.5]);
  assert.deepEqual(m["Assets/A.unity"]![0]!.to.position, [4, 0, 0]);
});
