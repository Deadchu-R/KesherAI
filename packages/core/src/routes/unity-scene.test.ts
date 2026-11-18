import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unitySceneRoutes } from "./unity-scene.js";

const SCENE = "%YAML 1.1\n--- !u!1 &100\nGameObject:\n  m_Name: Crate\n--- !u!4 &101\nTransform:\n  m_GameObject: {fileID: 100}\n  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}\n  m_LocalPosition: {x: 2, y: 0, z: -1}\n  m_LocalScale: {x: 1, y: 1, z: 1}\n  m_Father: {fileID: 0}\n";

test("a Unity scene without Unity: listed, read, and moves queued for the package (never outside Assets)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "unity-"));
  await mkdir(join(dir, "Assets", "Scenes"), { recursive: true });
  await mkdir(join(dir, "ProjectSettings"));
  await writeFile(join(dir, "Assets", "Scenes", "Main.unity"), SCENE);
  const app = Fastify();
  await unitySceneRoutes(app);
  assert.deepEqual((await app.inject({ url: `/api/unity/scenes?project=${encodeURIComponent(dir)}` })).json().scenes, ["Assets/Scenes/Main.unity"]);
  assert.equal((await app.inject({ url: `/api/unity/scene?project=${encodeURIComponent(dir)}&scene=Assets/Scenes/Main.unity` })).json().objects[0].name, "Crate");
  const move = { id: "101", name: "Crate", from: { position: [2, 0, -1], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, to: { position: [5, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } };
  const r = await app.inject({ method: "POST", url: "/api/unity/scene", payload: { project: dir, scene: "Assets/Scenes/Main.unity", moves: [move, { ...move, id: "x;rm" }] } });
  assert.equal(r.json().queued, 1);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "KesherAI", "pending-moves.json"), "utf8"))["Assets/Scenes/Main.unity"][0].to.position, [5, 0, 0]);
  assert.equal((await app.inject({ url: `/api/unity/scene?project=${encodeURIComponent(dir)}&scene=Assets/../x.unity` })).statusCode, 400);
  await app.close();
});

test("the stand-in's looks: a placed model found through its .meta, a prefab's first mesh, and the model's bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "unity-"));
  await mkdir(join(dir, "Assets", "Models"), { recursive: true });
  await mkdir(join(dir, "ProjectSettings"));
  const G1 = "11111111111111111111111111111111", G2 = "22222222222222222222222222222222", G3 = "33333333333333333333333333333333";
  await writeFile(join(dir, "Assets", "Models", "Chair.fbx"), "FBX");
  await writeFile(join(dir, "Assets", "Models", "Chair.fbx.meta"), `fileFormatVersion: 2\nguid: ${G1}\n`);
  await writeFile(join(dir, "Assets", "Lamp.prefab"), "--- !u!33 &1\nMeshFilter:\n  m_Mesh: {fileID: 10207, guid: 0000000000000000e000000000000000, type: 0}\n");
  await writeFile(join(dir, "Assets", "Lamp.prefab.meta"), `guid: ${G2}\n`);
  const placed = (id: number, g: string) => `--- !u!1001 &${id}\nPrefabInstance:\n  m_Modification:\n    m_TransformParent: {fileID: 0}\n    m_Modifications:\n    - target: {fileID: 5, guid: ${g}, type: 3}\n      propertyPath: m_LocalPosition.x\n      value: 1\n      objectReference: {fileID: 0}\n  m_SourcePrefab: {fileID: 100100000, guid: ${g}, type: 3}\n`;
  await writeFile(join(dir, "Assets", "Main.unity"), `%YAML 1.1\n${placed(7, G1)}${placed(8, G2)}${placed(9, G3)}`);
  const app = Fastify();
  await unitySceneRoutes(app);
  const o = (await app.inject({ url: `/api/unity/scene?project=${encodeURIComponent(dir)}&scene=Assets/Main.unity` })).json().objects;
  assert.equal(o[0].model, "Assets/Models/Chair.fbx");
  assert.deepEqual(o[1].look, { builtin: "sphere" });
  assert.equal(o[2].look, undefined);
  const a = await app.inject({ url: `/api/unity/asset?project=${encodeURIComponent(dir)}&path=Assets/Models/Chair.fbx` });
  assert.equal(a.body, "FBX");
  assert.equal((await app.inject({ url: `/api/unity/asset?project=${encodeURIComponent(dir)}&path=Assets/../x.fbx` })).statusCode, 400);
  assert.equal((await app.inject({ url: `/api/unity/asset?project=${encodeURIComponent(dir)}&path=Assets/Lamp.prefab` })).statusCode, 400);
  await app.close();
});
