import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSceneText, unitySceneRoutes } from "./unity-scene.js";

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

test("a package's script (TextMeshPro…) is named from the packages' own files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "unity-"));
  await mkdir(join(dir, "Assets"), { recursive: true });
  await mkdir(join(dir, "ProjectSettings"));
  const pkg = join(dir, "Library", "PackageCache", "com.unity.textmeshpro@3.0.6", "Scripts", "Runtime");
  await mkdir(pkg, { recursive: true });
  const G = "f4688fdb7df04437aeb418b961361dc5";
  await writeFile(join(pkg, "TextMeshProUGUI.cs"), "//");
  await writeFile(join(pkg, "TextMeshProUGUI.cs.meta"), `guid: ${G}\n`);
  await writeFile(join(dir, "Assets", "Main.unity"), `%YAML 1.1\n--- !u!1 &1\nGameObject:\n  m_Component:\n  - component: {fileID: 2}\n  - component: {fileID: 3}\n  m_Name: Title\n--- !u!4 &2\nTransform:\n  m_GameObject: {fileID: 1}\n--- !u!114 &3\nMonoBehaviour:\n  m_GameObject: {fileID: 1}\n  m_Script: {fileID: 11500000, guid: ${G}, type: 3}\n`);
  const app = Fastify();
  await unitySceneRoutes(app);
  const o = (await app.inject({ url: `/api/unity/scene?project=${encodeURIComponent(dir)}&scene=Assets/Main.unity` })).json().objects;
  assert.deepEqual(o[0].components, ["TextMeshProUGUI.cs"]);
  await app.close();
});

/** A small fixture project: Assets/, ProjectSettings/ and the files given (path → text). */
async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "unity-"));
  await mkdir(join(dir, "Assets"), { recursive: true });
  await mkdir(join(dir, "ProjectSettings"));
  for (const [f, text] of Object.entries(files)) {
    await mkdir(join(dir, f, ".."), { recursive: true });
    await writeFile(join(dir, f), text);
  }
  return dir;
}

test("scenes outside Assets/Scenes: deep folders, linked folders, embedded packages and the Build Settings' list", async () => {
  const dir = await fixture({
    "Assets/_Game/Levels/World1/Zone/Act/Green Hill.unity": SCENE,
    "Assets/Ignored~/Old.unity": SCENE,
    "Packages/com.me.levels/Scenes/Boss.unity": SCENE,
    "Packages/manifest.json": "{}",
    "Shared/Menu.unity": SCENE,
    "ProjectSettings/EditorBuildSettings.asset": "EditorBuildSettings:\n  m_Scenes:\n  - enabled: 1\n    path: Assets/Linked/Menu.unity\n  - enabled: 1\n    path: Assets/Gone.unity\n",
  });
  await symlink(join(dir, "Shared"), join(dir, "Assets", "Linked"), "junction").catch(() => undefined);
  const app = Fastify();
  await unitySceneRoutes(app);
  const r = (await app.inject({ url: `/api/unity/scenes?project=${encodeURIComponent(dir)}` })).json();
  assert.deepEqual(r.scenes, ["Assets/Linked/Menu.unity", "Assets/_Game/Levels/World1/Zone/Act/Green Hill.unity", "Packages/com.me.levels/Scenes/Boss.unity"]);
  const boss = await app.inject({ url: `/api/unity/scene?project=${encodeURIComponent(dir)}&scene=${encodeURIComponent("Packages/com.me.levels/Scenes/Boss.unity")}` });
  assert.equal(boss.json().objects[0].name, "Crate");
  await app.close();
});

test("no scenes says why: an empty Assets, or files but no .unity", async () => {
  const app = Fastify();
  await unitySceneRoutes(app);
  const empty = await fixture({});
  assert.deepEqual((await app.inject({ url: `/api/unity/scenes?project=${encodeURIComponent(empty)}` })).json().reason, "empty");
  const none = await fixture({ "Assets/Scripts/Player.cs": "//" });
  const r = (await app.inject({ url: `/api/unity/scenes?project=${encodeURIComponent(none)}` })).json();
  assert.equal(r.reason, "none");
  assert.equal(r.files, 1);
  await app.close();
});

test("a big scene is streamed: baked data dropped, binary refused with a clear message, old prefab format read", async () => {
  const mesh = `--- !u!43 &500\nMesh:\n  m_Name: Baked\n${"  _typelessdata: 0011223344556677\n".repeat(20000)}`;
  const oldPrefab = "--- !u!1001 &9\nPrefab:\n  m_Modification:\n    m_TransformParent: {fileID: 0}\n    m_Modifications:\n    - target: {fileID: 5, guid: 44444444444444444444444444444444, type: 2}\n      propertyPath: m_LocalPosition.x\n      value: 3\n      objectReference: {fileID: 0}\n  m_ParentPrefab: {fileID: 100100000, guid: 44444444444444444444444444444444, type: 2}\n";
  const dir = await fixture({ "Assets/Big.unity": `${SCENE}${mesh}${oldPrefab}`, "Assets/Bin.unity": "\u0000\u0000binary" });
  const kept = await readSceneText(join(dir, "Assets", "Big.unity"));
  assert.ok(kept.length < 2000, "the mesh's data is not kept");
  assert.match(kept, /--- !u!43 &500/);
  const app = Fastify();
  await unitySceneRoutes(app);
  const big = (await app.inject({ url: `/api/unity/scene?project=${encodeURIComponent(dir)}&scene=Assets/Big.unity` })).json();
  assert.equal(big.objects[0].name, "Crate");
  assert.equal(big.objects[1].position[0], 3);
  const bin = await app.inject({ url: `/api/unity/scene?project=${encodeURIComponent(dir)}&scene=Assets/Bin.unity` });
  assert.equal(bin.statusCode, 415);
  assert.match(bin.json().error, /Force Text/);
  await assert.rejects(readSceneText(join(dir, "Assets", "Big.unity"), -1), /took too long/);
  // Scan 171: a kept class with a huge serialized line is cut, and too much kept text is refused (never held whole).
  const blob = `--- !u!114 &7\nMonoBehaviour:\n  m_Name: Data\n  _bytes: ${"ab".repeat(100_000)}\n`;
  const dir2 = await fixture({ "Assets/Blob.unity": `${SCENE}${blob}` });
  const cut = await readSceneText(join(dir2, "Assets", "Blob.unity"));
  assert.ok(cut.length < 40_000, "a long kept line is cut");
  await assert.rejects(readSceneText(join(dir2, "Assets", "Blob.unity"), 20_000, 1000), (e: Error & { statusCode?: number }) => e.statusCode === 413);
  await app.close();
});
