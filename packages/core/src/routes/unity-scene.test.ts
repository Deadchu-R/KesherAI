import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSceneText, unitySceneRoutes } from "./unity-scene.js";
import type { UnityObject } from "../unity-scene.js";

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

// ---------- a 2D URP game as Unity saves it: a UI canvas, placed prefabs (nested, one inside itself), sprites from a sheet, a Tilemap ----------
const G = { hero: "a0000000000000000000000000000001", sword: "a0000000000000000000000000000002", loop: "a0000000000000000000000000000003", panel: "a0000000000000000000000000000004", sheet: "a0000000000000000000000000000005", tmp: "f4688fdb7df04437aeb418b961361dc5", image: "fe87c0e1cc204ed48ad3b37840f39efc", hLayout: "30649d3a9faa99c48a7b1166b86bf2a0", scaler: "0cd44c1031e13a943bb63640046fad76" };
const go = (id: number, name: string, comps: number[], active = 1) => `--- !u!1 &${id}\nGameObject:\n  m_Component:\n${comps.map((c) => `  - component: {fileID: ${c}}\n`).join("")}  m_Name: ${name}\n  m_IsActive: ${active}\n`;
const tf = (id: number, goId: number, father: number, children: number[] = [], pos = "{x: 0, y: 0, z: 0}", scale = "{x: 1, y: 1, z: 1}") => `--- !u!4 &${id}\nTransform:\n  m_GameObject: {fileID: ${goId}}\n  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}\n  m_LocalPosition: ${pos}\n  m_LocalScale: ${scale}\n  m_Children:${children.length ? "\n" + children.map((c) => `  - {fileID: ${c}}\n`).join("") : " []\n"}  m_Father: {fileID: ${father}}\n`;
const rt = (id: number, goId: number, father: number, children: number[], a: { min?: string; max?: string; pos?: string; size: string; pivot?: string }) => `--- !u!224 &${id}\nRectTransform:\n  m_GameObject: {fileID: ${goId}}\n  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}\n  m_LocalPosition: {x: 0, y: 0, z: 0}\n  m_LocalScale: {x: 1, y: 1, z: 1}\n  m_Children:${children.length ? "\n" + children.map((c) => `  - {fileID: ${c}}\n`).join("") : " []\n"}  m_Father: {fileID: ${father}}\n  m_AnchorMin: ${a.min ?? "{x: 0.5, y: 0.5}"}\n  m_AnchorMax: ${a.max ?? "{x: 0.5, y: 0.5}"}\n  m_AnchoredPosition: ${a.pos ?? "{x: 0, y: 0}"}\n  m_SizeDelta: ${a.size}\n  m_Pivot: ${a.pivot ?? "{x: 0.5, y: 0.5}"}\n`;
const mb = (id: number, goId: number, script: string, fields: string) => `--- !u!114 &${id}\nMonoBehaviour:\n  m_GameObject: {fileID: ${goId}}\n  m_Enabled: 1\n  m_Script: {fileID: 11500000, guid: ${script}, type: 3}\n${fields}`;
const image = (id: number, goId: number, color: string, sprite = "{fileID: 10905, guid: 0000000000000000f000000000000000, type: 0}") => mb(id, goId, G.image, `  m_Color: ${color}\n  m_Sprite: ${sprite}\n  m_Type: 1\n`);
const sr = (id: number, goId: number, sprite: string, extra = "") => `--- !u!212 &${id}\nSpriteRenderer:\n  m_GameObject: {fileID: ${goId}}\n  m_Enabled: 1\n  m_SortingLayerID: 0\n  m_SortingOrder: 0\n  m_Sprite: ${sprite}\n  m_Color: {r: 1, g: 1, b: 1, a: 1}\n  m_FlipX: 0\n  m_FlipY: 0\n  m_DrawMode: 0\n${extra}`;
const instance = (id: number, src: string, parent: number, mods: Array<[number, string, string, string?]>) => `--- !u!1001 &${id}\nPrefabInstance:\n  m_Modification:\n    serializedVersion: 3\n    m_TransformParent: {fileID: ${parent}}\n    m_Modifications:\n${mods.map(([f, path, value, g]) => `    - target: {fileID: ${f}, guid: ${g ?? src}, type: 3}\n      propertyPath: ${path}\n      value: ${value}\n      objectReference: {fileID: 0}\n`).join("")}    m_RemovedComponents: []\n  m_SourcePrefab: {fileID: 100100000, guid: ${src}, type: 3}\n`;
const HEADER = "%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n";

/** The project: GameScene.unity, three prefabs, a sprite sheet with its .meta, a panel picture, the sorting layers. */
function gameProject(): Record<string, string> {
  const sheetRef = (id: string) => `{fileID: ${id}, guid: ${G.sheet}, type: 3}`;
  const scene = HEADER
    // The canvas: Screen Space Overlay, scaled with the screen at 1920 × 1080 (Unity saved the last Game view's size).
    + go(10, "Canvas", [11, 12, 13]) + rt(11, 10, 0, [21, 31, 41], { size: "{x: 1280, y: 720}", min: "{x: 0, y: 0}", max: "{x: 0, y: 0}" })
    + "--- !u!223 &12\nCanvas:\n  m_GameObject: {fileID: 10}\n  m_Enabled: 1\n  m_RenderMode: 0\n"
    + mb(13, 10, G.scaler, "  m_UiScaleMode: 1\n  m_ReferenceResolution: {x: 1920, y: 1080}\n")
    // A panel stretched to the canvas less 50 on each side, with a sprite.
    + go(20, "Panel", [21, 22]) + rt(21, 20, 11, [], { min: "{x: 0, y: 0}", max: "{x: 1, y: 1}", size: "{x: -100, y: -100}" })
    + image(22, 20, "{r: 0.2, g: 0.4, b: 0.6, a: 0.8}", `{fileID: 21300000, guid: ${G.panel}, type: 3}`)
    // A TextMeshPro title at the top, in Hebrew (Unity writes it escaped).
    + go(30, "Title", [31, 32]) + rt(31, 30, 11, [], { min: "{x: 0.5, y: 1}", max: "{x: 0.5, y: 1}", pivot: "{x: 0.5, y: 1}", pos: "{x: 0, y: -40}", size: "{x: 600, y: 80}" })
    + mb(32, 30, G.tmp, '  m_Color: {r: 1, g: 1, b: 1, a: 1}\n  m_text: "\\u05E9\\u05DC\\u05D5\\u05DD <b>world</b>"\n  m_fontColor: {r: 1, g: 0.5, b: 0, a: 1}\n  m_fontSize: 48\n  m_HorizontalAlignment: 2\n  m_VerticalAlignment: 512\n')
    // A row of buttons in a horizontal layout group, saved all at one point (not laid out yet); the third is off.
    + go(40, "Bar", [41, 42]) + rt(41, 40, 11, [51, 61, 71], { size: "{x: 600, y: 100}" })
    + mb(42, 40, G.hLayout, "  m_Padding:\n    m_Left: 0\n    m_Right: 0\n    m_Top: 0\n    m_Bottom: 0\n  m_ChildAlignment: 4\n  m_Spacing: 10\n  m_ChildForceExpandWidth: 0\n  m_ChildForceExpandHeight: 0\n  m_ChildControlWidth: 0\n  m_ChildControlHeight: 0\n")
    + [50, 60, 70].map((g, i) => go(g, `Button${i + 1}`, [g + 1, g + 2], i === 2 ? 0 : 1) + rt(g + 1, g, 41, [], { size: "{x: 100, y: 50}" }) + image(g + 2, g, "{r: 1, g: 1, b: 1, a: 1}")).join("")
    // A sprite collapsed to a scale of 0 far away: never framed.
    + go(80, "Hidden", [81, 82]) + tf(81, 80, 0, [], "{x: 100, y: 0, z: 0}", "{x: 0, y: 0, z: 0}") + sr(82, 80, sheetRef("21300000"))
    // Two sprites of the sheet, on the "Front" layer and the default one, flipped and tinted.
    + go(90, "Coin", [91, 92]) + tf(91, 90, 0, [], "{x: -2, y: 0, z: 0}") + sr(92, 90, sheetRef("-777"), "  m_SortingLayerID: 1234\n  m_SortingOrder: 5\n").replace("m_SortingLayerID: 0\n  m_SortingOrder: 0\n", "").replace("m_FlipX: 0", "m_FlipX: 1")
    + go(95, "Gem", [96, 97]) + tf(96, 95, 0, [], "{x: 2, y: 0, z: 0}") + sr(97, 95, sheetRef("21300002")).replace("m_SortingOrder: 0", "m_SortingOrder: 9")
    // A Grid with a small Tilemap (two cells of the sheet's coin, one tinted).
    + go(100, "Grid", [101, 102]) + tf(101, 100, 0, [111]) + "--- !u!156049354 &102\nGrid:\n  m_GameObject: {fileID: 100}\n  m_CellSize: {x: 0.5, y: 0.5, z: 0}\n"
    + go(110, "Ground", [111, 112, 113]) + tf(111, 110, 101)
    + "--- !u!1839735485 &112\nTilemap:\n  m_GameObject: {fileID: 110}\n  m_Tiles:\n  - first: {x: -1, y: -2, z: 0}\n    second:\n      serializedVersion: 2\n      m_TileIndex: 0\n      m_TileSpriteIndex: 0\n      m_TileMatrixIndex: 0\n      m_TileColorIndex: 0\n  - first: {x: 0, y: -2, z: 0}\n    second:\n      serializedVersion: 2\n      m_TileIndex: 0\n      m_TileSpriteIndex: 0\n      m_TileMatrixIndex: 0\n      m_TileColorIndex: 1\n"
    + `  m_TileSpriteArray:\n  - m_RefCount: 2\n    m_Data: ${sheetRef("-777")}\n  m_TileColorArray:\n  - m_RefCount: 1\n    m_Data: {r: 1, g: 1, b: 1, a: 1}\n  - m_RefCount: 1\n    m_Data: {r: 1, g: 0, b: 0, a: 1}\n  m_TileAnchor: {x: 0.5, y: 0.5, z: 0}\n`
    + "--- !u!483693784 &113\nTilemapRenderer:\n  m_GameObject: {fileID: 110}\n  m_SortingLayerID: 0\n  m_SortingOrder: -10\n"
    // The hero, a placed prefab: moved, renamed, its nested sword raised (an override on the nested prefab's object).
    + instance(900, G.hero, 0, [[4001, "m_LocalPosition.x", "3"], [4001, "m_LocalPosition.y", "1"], [4000, "m_Name", "Hero (Boss)"], [6001, "m_LocalPosition.y", "2", G.sword]])
    + `--- !u!4 &950 stripped\nTransform:\n  m_CorrespondingSourceObject: {fileID: 4001, guid: ${G.hero}, type: 3}\n  m_PrefabInstance: {fileID: 900}\n`
    + go(300, "Shadow", [301]) + tf(301, 300, 950)
    // A prefab that holds itself: expanded once, the inner one stays a box.
    + instance(910, G.loop, 0, [[7001, "m_LocalPosition.x", "-5"]]);
  const hero = HEADER + go(4000, "Hero", [4001, 4002]) + tf(4001, 4000, 0, [6501]) + sr(4002, 4000, sheetRef("21300002"))
    + instance(4500, G.sword, 4001, [[6001, "m_LocalPosition.x", "0.5"]])
    + `--- !u!4 &6501 stripped\nTransform:\n  m_CorrespondingSourceObject: {fileID: 6001, guid: ${G.sword}, type: 3}\n  m_PrefabInstance: {fileID: 4500}\n`;
  const sword = HEADER + go(6000, "Sword", [6001, 6002]) + tf(6001, 6000, 0) + sr(6002, 6000, sheetRef("-777"));
  const loop = HEADER + go(7000, "Loop", [7001]) + tf(7001, 7000, 0) + instance(7500, G.loop, 7001, [[7001, "m_LocalPosition.x", "1"]]);
  // A 64 × 32 sheet with two 32 × 32 sprites (one by internalID, one through the old name table), 32 pixels per unit.
  const sheetMeta = `fileFormatVersion: 2\nguid: ${G.sheet}\nTextureImporter:\n  internalIDToNameTable:\n  - first:\n      213: 21300002\n    second: gem\n  spriteMode: 2\n  spritePixelsToUnits: 32\n  spriteSheet:\n    serializedVersion: 2\n    sprites:\n    - serializedVersion: 2\n      name: coin\n      rect:\n        serializedVersion: 2\n        x: 0\n        y: 0\n        width: 32\n        height: 32\n      alignment: 7\n      pivot: {x: 0.5, y: 0}\n      internalID: -777\n    - serializedVersion: 2\n      name: gem\n      rect:\n        serializedVersion: 2\n        x: 32\n        y: 0\n        width: 32\n        height: 32\n      alignment: 9\n      pivot: {x: 0.25, y: 0.75}\n      internalID: 0\n`;
  const pngHead = "\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x00\x40\x00\x00\x00\x20";
  return {
    "Assets/Scenes/BuildScenes/GameScene.unity": scene,
    "Assets/Prefabs/Hero.prefab": hero, "Assets/Prefabs/Hero.prefab.meta": `guid: ${G.hero}\n`,
    "Assets/Prefabs/Sword.prefab": sword, "Assets/Prefabs/Sword.prefab.meta": `guid: ${G.sword}\n`,
    "Assets/Prefabs/Loop.prefab": loop, "Assets/Prefabs/Loop.prefab.meta": `guid: ${G.loop}\n`,
    "Assets/Art/sheet.png": pngHead, "Assets/Art/sheet.png.meta": sheetMeta,
    "Assets/UI/panel.png": pngHead, "Assets/UI/panel.png.meta": `guid: ${G.panel}\nTextureImporter:\n  spritePixelsToUnits: 100\n  spriteAlignment: 0\n`,
    "ProjectSettings/TagManager.asset": "TagManager:\n  m_SortingLayers:\n  - name: Default\n    uniqueID: 0\n  - name: Front\n    uniqueID: 1234\n",
  };
}

test("a 2D game's scene: UI laid out by anchors, prefabs expanded (nested, overrides, a cycle stopped), sprites from a sheet, a Tilemap, framed", async () => {
  const dir = await fixture(gameProject());
  const app = Fastify();
  await unitySceneRoutes(app);
  const r = (await app.inject({ url: `/api/unity/scene?project=${encodeURIComponent(dir)}&scene=Assets/Scenes/BuildScenes/GameScene.unity` })).json();
  const all = r.objects as UnityObject[];
  const by = new Map(all.map((o) => [o.name, o]));
  // UI: the canvas at its reference resolution, 100 px to a unit; children from their anchors.
  const canvas = by.get("Canvas")!;
  assert.deepEqual([canvas.position, canvas.scale, canvas.ui!.size, canvas.ui!.canvas, canvas.readOnly], [[0, 0, 0], [0.01, 0.01, 0.01], [1920, 1080], "screen", "ui"]);
  const panel = by.get("Panel")!;
  assert.deepEqual([panel.ui!.size, panel.position, panel.ui!.color, panel.ui!.image], [[1820, 980], [0, 0, 0], [0.2, 0.4, 0.6, 0.8], "Assets/UI/panel.png"]);
  const title = by.get("Title")!;
  assert.deepEqual(title.position, [0, 500, 0]);
  assert.deepEqual([title.ui!.text!.value, title.ui!.text!.size, title.ui!.text!.color, title.ui!.text!.align, title.ui!.text!.valign], ["שלום world", 48, [1, 0.5, 0, 1], "center", "middle"]);
  // The layout group stacks the two active buttons, centred, 10 apart; the inactive one is skipped and marked.
  assert.deepEqual([by.get("Button1")!.position, by.get("Button2")!.position], [[-55, 0, 0], [55, 0, 0]]);
  assert.equal(by.get("Button3")!.active, false);
  assert.ok(by.get("Button2")!.ui!.order > by.get("Panel")!.ui!.order, "later in the Hierarchy draws on top");
  // Prefabs: the hero's root keeps its move key and is movable; its nested sword is read only, with both overrides.
  const hero = by.get("Hero (Boss)")!;
  assert.deepEqual([hero.id, hero.position, hero.prefab, hero.readOnly, hero.sprite], ["4001:900", [3, 1, 0], true, undefined, "Assets/Art/sheet.png"]);
  const sword = by.get("Sword")!;
  assert.deepEqual([sword.parent, sword.position, sword.readOnly], ["4001:900", [0.5, 2, 0], "prefab"]);
  assert.equal(by.get("Shadow")!.parent, "4001:900", "what the scene hung under the prefab hangs under it");
  const loops = all.filter((o) => o.name === "Loop" || /^Prefab /.test(o.name));
  assert.deepEqual(loops.map((o) => [o.id, o.readOnly ?? ""]), [["7001:910", ""], ["7001:910~7500", "prefab"]]);
  // Sprites: the sheet's rects and pivots (by internalID and by the old name table), sorting layers in the project's order.
  const coin = by.get("Coin")!.spriteInfo!, gem = by.get("Gem")!.spriteInfo!;
  assert.deepEqual([coin.rect, coin.pivot, coin.ppu, coin.flip, coin.sort], [[0, 0, 32, 32], [0.5, 0], 32, [true, false], [1, 5]]);
  assert.deepEqual([gem.rect, gem.pivot, gem.sort], [[32, 0, 32, 32], [0.25, 0.75], [0, 9]]);
  // The Tilemap: its cells, the Grid's cell size, its sprite resolved; read only.
  const ground = by.get("Ground")!;
  assert.deepEqual([ground.tilemap!.tiles, ground.tilemap!.cell, ground.tilemap!.colors[1], ground.tilemap!.sprites[0]!.path, ground.tilemap!.sprites[0]!.rect, ground.tilemap!.sort, ground.readOnly], [[-1, -2, 0, 0, 0, -2, 0, 1], [0.5, 0.5], [1, 0, 0, 1], "Assets/Art/sheet.png", [0, 0, 32, 32], [0, -10], "tilemap"]);
  // Framing: 2D, around what draws; the scale-0 sprite at x = 100 is left out.
  assert.equal(r.view, "2d");
  // The Screen Space canvas (1920 × 1080 pixels) is not in that box: it is a panel fitted over it, at its own scale.
  assert.ok(r.bounds.max[0] < 50 && r.bounds.max[0] - r.bounds.min[0] < 19, JSON.stringify(r.bounds));
  assert.ok(r.canvas && r.canvas.scale > 0 && r.canvas.scale * 1920 <= r.bounds.max[0] - r.bounds.min[0] + 1e-9, JSON.stringify(r.canvas));
  // A prefab's inner object is never queued as a move; the expanded root is.
  const move = (id: string) => ({ id, name: "x", from: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, to: { position: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } });
  const q = await app.inject({ method: "POST", url: "/api/unity/scene", payload: { project: dir, scene: "Assets/Scenes/BuildScenes/GameScene.unity", moves: [move(sword.id), move(hero.id)] } });
  assert.equal(q.json().queued, 1);
  await app.close();
});
