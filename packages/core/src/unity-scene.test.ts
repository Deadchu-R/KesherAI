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

const MORE = `%YAML 1.1
--- !u!1 &100
GameObject:
  m_Name: Crate
--- !u!4 &101
Transform:
  m_GameObject: {fileID: 100}
  m_LocalRotation: {x: 0, y: 0.70710677, z: 0, w: 0.70710677}
  m_LocalPosition: {x: 2, y: 0, z: -1.5}
  m_LocalScale: {x: 1, y: 1, z: 1}
  m_Father: {fileID: 0}
--- !u!33 &102
MeshFilter:
  m_GameObject: {fileID: 100}
  m_Mesh: {fileID: 10202, guid: 0000000000000000e000000000000000, type: 0}
--- !u!1001 &900
PrefabInstance:
  m_Modification:
    m_TransformParent: {fileID: 101}
    m_Modifications:
    - target: {fileID: -8679921383154817045, guid: 0123456789abcdef0123456789abcdef, type: 3}
      propertyPath: m_LocalPosition.x
      value: 4
      objectReference: {fileID: 0}
    - target: {fileID: -8679921383154817045, guid: 0123456789abcdef0123456789abcdef, type: 3}
      propertyPath: m_LocalRotation.w
      value: 1
      objectReference: {fileID: 0}
    - target: {fileID: 919132149155446097, guid: 0123456789abcdef0123456789abcdef, type: 3}
      propertyPath: m_Name
      value: Chair
      objectReference: {fileID: 0}
  m_SourcePrefab: {fileID: 100100000, guid: 0123456789abcdef0123456789abcdef, type: 3}
--- !u!4 &950 stripped
Transform:
  m_CorrespondingSourceObject: {fileID: -8679921383154817045, guid: 0123456789abcdef0123456789abcdef, type: 3}
  m_PrefabInstance: {fileID: 900}
--- !u!1 &300
GameObject:
  m_Name: Cushion
--- !u!4 &301
Transform:
  m_GameObject: {fileID: 300}
  m_LocalPosition: {x: 0, y: 0.5, z: 0}
  m_Father: {fileID: 950}
`;

test("a Unity scene's objects: names, parents, local position / rotation / scale", () => {
  const o = readUnityScene(SCENE);
  assert.deepEqual(o.map((x) => [x.id, x.name, x.parent]), [["101", "Crate", "0"]]);
  assert.deepEqual(o[0]!.position, [2, 0, -1.5]);
  assert.deepEqual(o[0]!.rotation, [0, 0.70710677, 0, 0.70710677]);
  assert.throws(() => readUnityScene("binary"), /Force Text/);
});

test("looks: Unity's built-in meshes; placed models with their overridden place, and what hangs under them", () => {
  const o = readUnityScene(MORE);
  const by = new Map(o.map((x) => [x.name, x]));
  assert.deepEqual(by.get("Crate")!.look, { builtin: "cube" });
  const chair = by.get("Chair")!;
  assert.equal(chair.id, "-8679921383154817045:900");
  assert.equal(chair.parent, "101");
  assert.deepEqual(chair.position, [4, 0, 0]);
  assert.equal(chair.prefab, true);
  assert.deepEqual(chair.look, { guid: "0123456789abcdef0123456789abcdef" });
  assert.equal(by.get("Cushion")!.parent, chair.id);
});

test("moves waiting for Unity: a newer move of the same object replaces the older, keeping its first 'from'", () => {
  const a = { id: "101", name: "Crate", from: { position: [2, 0, -1.5], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, to: { position: [3, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } };
  const b = { ...a, from: { ...a.from, position: [3, 0, 0] }, to: { ...a.to, position: [4, 0, 0] } };
  const m = mergeMoves(mergeMoves({}, "Assets/A.unity", [a]), "Assets/A.unity", [b]);
  assert.equal(m["Assets/A.unity"]!.length, 1);
  assert.deepEqual(m["Assets/A.unity"]![0]!.from.position, [2, 0, -1.5]);
  assert.deepEqual(m["Assets/A.unity"]![0]!.to.position, [4, 0, 0]);
});
