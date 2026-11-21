import { test } from "node:test";
import assert from "node:assert/strict";
import { readUnityScene, sceneView, TMP_WORLD_UNIT, type UnityObject } from "./unity-scene.js";

/**
 * Fixture: a Screen Space - Overlay canvas (CanvasScaler 1920 × 1080) with a stretched panel, a TextMeshPro label of
 * font size 36 in a 400 × 80 rect, an auto-size label, a world SpriteRenderer at scale 1, and a 3D TextMeshPro outside
 * any canvas. The checks: laid-out rects, the font sizes, and that the UI never takes the world's units.
 */
const HEAD = "%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n";
const go = (id: number, name: string, comps: number[]) => `--- !u!1 &${id}\nGameObject:\n  m_Component:\n${comps.map((c) => `  - component: {fileID: ${c}}\n`).join("")}  m_Name: ${name}\n  m_IsActive: 1\n`;
const kids = (c: number[]) => (c.length ? "\n" + c.map((k) => `  - {fileID: ${k}}\n`).join("") : " []\n");
const tf = (id: number, g: number, father: number, children: number[] = [], pos = "{x: 0, y: 0, z: 0}") => `--- !u!4 &${id}\nTransform:\n  m_GameObject: {fileID: ${g}}\n  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}\n  m_LocalPosition: ${pos}\n  m_LocalScale: {x: 1, y: 1, z: 1}\n  m_Children:${kids(children)}  m_Father: {fileID: ${father}}\n`;
const rt = (id: number, g: number, father: number, children: number[], a: { min?: string; max?: string; pos?: string; size: string; pivot?: string }) => `--- !u!224 &${id}\nRectTransform:\n  m_GameObject: {fileID: ${g}}\n  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}\n  m_LocalPosition: {x: 0, y: 0, z: 0}\n  m_LocalScale: {x: 1, y: 1, z: 1}\n  m_Children:${kids(children)}  m_Father: {fileID: ${father}}\n  m_AnchorMin: ${a.min ?? "{x: 0.5, y: 0.5}"}\n  m_AnchorMax: ${a.max ?? "{x: 0.5, y: 0.5}"}\n  m_AnchoredPosition: ${a.pos ?? "{x: 0, y: 0}"}\n  m_SizeDelta: ${a.size}\n  m_Pivot: ${a.pivot ?? "{x: 0.5, y: 0.5}"}\n`;
const mb = (id: number, g: number, fields: string) => `--- !u!114 &${id}\nMonoBehaviour:\n  m_GameObject: {fileID: ${g}}\n  m_Enabled: 1\n${fields}`;
const tmp = (id: number, g: number, text: string, extra: string) => mb(id, g, `  m_text: ${text}\n  m_fontColor: {r: 1, g: 1, b: 1, a: 1}\n${extra}`);

const SCENE = HEAD
  + go(10, "Canvas", [11, 12, 13]) + rt(11, 10, 0, [21, 31, 41], { size: "{x: 800, y: 600}", min: "{x: 0, y: 0}", max: "{x: 0, y: 0}" })
  + "--- !u!223 &12\nCanvas:\n  m_GameObject: {fileID: 10}\n  m_Enabled: 1\n  m_RenderMode: 0\n"
  + mb(13, 10, "  m_UiScaleMode: 1\n  m_ReferenceResolution: {x: 1920, y: 1080}\n")
  // A panel stretched to the canvas less 100 on every side (size delta -200 × -200).
  + go(20, "Panel", [21, 22]) + rt(21, 20, 11, [], { min: "{x: 0, y: 0}", max: "{x: 1, y: 1}", size: "{x: -200, y: -200}" })
  + mb(22, 20, "  m_Color: {r: 0, g: 0, b: 0, a: 0.5}\n  m_Sprite: {fileID: 0}\n  m_Type: 0\n")
  // A label of font size 36 in a 400 × 80 rect, with rich text and a line break.
  + go(30, "Score", [31, 32]) + rt(31, 30, 11, [], { size: "{x: 400, y: 80}", pos: "{x: 0, y: 300}" })
  + tmp(32, 30, '"<color=#ff0000>Score</color><br>12 &nbsp;pts"', "  m_fontSize: 36\n  m_enableAutoSizing: 0\n")
  // An auto-size label (min 10, max 60) in a stretched rect.
  + go(40, "Auto", [41, 42]) + rt(41, 40, 11, [], { min: "{x: 0, y: 0}", max: "{x: 1, y: 0}", size: "{x: -400, y: 120}", pivot: "{x: 0.5, y: 0}" })
  + tmp(42, 40, "Long text", "  m_fontSize: 36\n  m_enableAutoSizing: 1\n  m_fontSizeMin: 10\n  m_fontSizeMax: 60\n  m_enableWordWrapping: 0\n")
  // A world sprite at scale 1.
  + go(50, "Coin", [51, 52]) + tf(51, 50, 0, [], "{x: 3, y: 1, z: 0}")
  + "--- !u!212 &52\nSpriteRenderer:\n  m_GameObject: {fileID: 50}\n  m_Enabled: 1\n  m_Sprite: {fileID: 21300000, guid: a0000000000000000000000000000001, type: 3}\n  m_Color: {r: 1, g: 1, b: 1, a: 1}\n"
  // A 3D TextMeshPro (outside any canvas), font size 36 in a 20 × 5 rect, and an empty label.
  + go(60, "Sign", [61, 62]) + rt(61, 60, 0, [], { size: "{x: 20, y: 5}" })
  + tmp(62, 60, "nm", "  m_fontSize: 36\n")
  + go(70, "Empty", [71, 72]) + rt(71, 70, 11, [], { size: "{x: 50, y: 50}" })
  + tmp(72, 70, '""', "  m_fontSize: 36\n");

const find = (o: UnityObject[], name: string) => o.find((x) => x.name === name)!;

test("a Screen Space canvas lays out at its reference resolution; a stretched panel from the parent's rect", () => {
  const o = readUnityScene(SCENE);
  assert.deepEqual(find(o, "Canvas").ui!.size, [1920, 1080]);
  assert.equal(find(o, "Canvas").ui!.canvas, "screen");
  // Anchors 0…1 with a size delta of -200: the canvas less 100 on each side.
  assert.deepEqual(find(o, "Panel").ui!.size, [1720, 880]);
  // A label's rect is its own size delta; a stretched-in-x one is the parent's width plus the delta.
  assert.deepEqual(find(o, "Score").ui!.size, [400, 80]);
  assert.deepEqual(find(o, "Auto").ui!.size, [1520, 120]);
});

test("a canvas label's font size is in canvas pixels; rich text goes, <br> breaks the line", () => {
  const t = find(readUnityScene(SCENE), "Score").ui!.text!;
  assert.equal(t.size, 36);
  assert.equal(t.value, "Score\n12  pts");
  assert.equal(t.auto, undefined);
});

test("auto size keeps its minimum and maximum; wrapping off is kept; an empty label draws nothing", () => {
  const o = readUnityScene(SCENE);
  const t = find(o, "Auto").ui!.text!;
  assert.deepEqual([t.auto, t.min, t.max, t.wrap], [true, 10, 60, false]);
  assert.equal(find(o, "Empty").ui!.text, undefined);
});

test("3D text outside a canvas is sized in world units (a tenth of its font size), not canvas pixels", () => {
  const sign = find(readUnityScene(SCENE), "Sign").ui!;
  assert.equal(sign.canvas, undefined);
  assert.ok(Math.abs(sign.text!.size - 36 * TMP_WORLD_UNIT) < 1e-9);
  // 3.6 of a 5-high rect: it fits, and never fills a screen's worth of world.
  assert.ok(sign.text!.size < sign.size[1]);
});

test("the UI keeps its own scale: the world box is the sprite's, and the canvas is fitted over it, not in world units", () => {
  const o = readUnityScene(SCENE);
  const coin = find(o, "Coin");
  assert.deepEqual(coin.scale, [1, 1, 1]);
  const v = sceneView(o);
  // Neither the 1920 × 1080 canvas nor its pixels stretch the world's box.
  assert.ok(v.bounds && v.bounds.max[0] - v.bounds.min[0] < 30, `box ${JSON.stringify(v.bounds)}`);
  // The panel, at its own scale: world units per canvas pixel, so the canvas fits the box (aspect kept).
  assert.ok(v.canvas);
  const w = v.bounds!.max[0] - v.bounds!.min[0], h = v.bounds!.max[1] - v.bounds!.min[1];
  assert.ok(Math.abs(v.canvas!.scale - Math.min(w / 1920, h / 1080)) < 1e-9);
  assert.ok(1920 * v.canvas!.scale <= w + 1e-9 && 1080 * v.canvas!.scale <= h + 1e-9);
  // The label's font in the world after the fit: 36 canvas pixels × the panel's scale (its pixel size is its own).
  assert.ok(Math.abs(36 * v.canvas!.scale - 36 * Math.min(w / 1920, h / 1080)) < 1e-9);
  // Without world content, the canvas alone is framed at the default 100 pixels to a unit (the panel, 1720 wide, is 17.2), with no panel placement.
  const only = sceneView(o.filter((x) => x.name !== "Coin" && x.name !== "Sign"));
  assert.equal(only.canvas, undefined);
  assert.ok(only.bounds && Math.abs(only.bounds.max[0] - only.bounds.min[0] - 17.2) < 1e-6);
});
