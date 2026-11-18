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
