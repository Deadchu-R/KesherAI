/**
 * Unity scenes (.unity, text YAML: Unity's default "Force Text") read for KesherAI's stand-in (RESEARCH_LOG "A game
 * scene edited in KesherAI without its engine"). Writing the YAML by hand is fragile (file ids, prefab overrides), so
 * moves are not written here: they go to a list the KesherAI Unity package applies with Undo when Unity opens.
 */

import { expandPrefabs, field, FILE_ID, modsOf, parseDocs, ref, yamlScalar } from "./unity-prefabs.js";

/** What an object looks like: one of Unity's built-in meshes, or a model file of the project (resolved by the route). */
export type UnityLook = { builtin: "cube" | "sphere" | "cylinder" | "capsule" | "plane" | "quad" } | { guid: string };

/** A GameObject with its Transform, as the stand-in needs it. */
export interface UnityObject {
  /**
   * The key for a move: the Transform's file id in this scene; for a placed prefab or model, "<the Transform's id in
   * its source>:<the prefab instance's id>" (the two halves of its GlobalObjectId).
   */
  id: string;
  name: string;
  /** The parent Transform's id ("0": at the scene's top). */
  parent: string;
  position: [number, number, number];
  /** A quaternion (x, y, z, w), Unity's left-handed space. */
  rotation: [number, number, number, number];
  scale: [number, number, number];
  /** A placed prefab or model (moving it is an override there). */
  prefab?: boolean;
  /** Its mesh or source, for the stand-in to show the real shape. */
  look?: UnityLook;
  /** Set by the route: the model file the look points at ("Assets/….fbx"). */
  model?: string;
  /** What is attached to it, as Unity's Inspector names them ("MeshRenderer", "BoxCollider", a script's GUID as "script:<guid>"). */
  components?: string[];
  /** A 2D sprite's picture: its GUID here, its file ("Assets/….png") once the route resolves it. */
  sprite?: string;
  /** Off in Unity (its GameObject's m_IsActive is 0); the stand-in hides it unless asked. */
  active?: false;
  /**
   * Not moved from the stand-in: "ui" (uGUI, laid out by anchors, which a plain move would break) or "prefab" (a
   * child inside a placed prefab, which would be an override on an inner object). Its moves are never queued.
   */
  readOnly?: "ui" | "prefab" | "tilemap";
  /** A uGUI RectTransform, laid out (in canvas units; a Screen Space canvas shows 100 units to a metre). */
  ui?: UnityUi;
  /** A SpriteRenderer's settings (with `sprite`): which sprite of its picture, tint, flips, sorting. */
  spriteInfo?: UnitySprite;
  /** A Tilemap's cells (read only here). */
  tilemap?: UnityTilemap;
  /** A SpriteShape's spline, drawn as its outline. */
  shape?: { points: Array<[number, number]>; closed: boolean };
}

/** One sprite of a picture, as the route finds it in the picture's .meta. */
export interface UnitySpriteRect {
  /** The rect in the picture, in pixels from its bottom-left corner (x, y, width, height). */
  rect?: [number, number, number, number];
  /** The pivot, 0–1 in the rect. */
  pivot?: [number, number];
  /** Pixels per unit. */
  ppu?: number;
}

/** A SpriteRenderer's settings. */
export interface UnitySprite extends UnitySpriteRect {
  /** The sprite's file id in its picture (21300000: the whole picture; a sheet's sprites have their own). */
  fileID: string;
  color: [number, number, number, number];
  flip: [boolean, boolean];
  /** Sorting: the layer (its uniqueID here; its place in the project's layer list once the route resolves it) and the order in it. */
  sort: [number, number];
  /** Sliced or tiled draw mode: the drawn size in units. */
  size?: [number, number];
}

/** A Tilemap: its cells, and the sprites and colours they use. */
export interface UnityTilemap {
  /** The Grid's cell size and the tile anchor (0–1 in a cell). */
  cell: [number, number];
  anchor: [number, number];
  /** x, y, sprite index, colour index for each cell, flat. */
  tiles: number[];
  /** The sprites by index: the GUID of the picture (its file once resolved) and the sprite's rect. */
  sprites: Array<{ guid?: string; fileID: string; path?: string } & UnitySpriteRect>;
  colors: Array<[number, number, number, number]>;
  sort: [number, number];
}

/** The most cells read from one Tilemap (a huge one shows its first ones). */
export const MAX_TILES = 50_000;

/** A laid-out uGUI object: its rect and what it draws. */
export interface UnityUi {
  /** Width and height in canvas units. */
  size: [number, number];
  /** The pivot (0–1 in its rect): the object's position is where its pivot is. */
  pivot: [number, number];
  /** Its place in the canvas's draw order (a later one draws on top, as uGUI draws the Hierarchy). */
  order: number;
  /** On a root canvas: how it is shown. */
  canvas?: "screen" | "world";
  /** An Image's or RawImage's tint (0–1). */
  color?: [number, number, number, number];
  /** An Image's sprite or a RawImage's texture: its GUID here, its file once the route resolves it. */
  image?: string;
  /**
   * A TextMeshPro or Text label (rich-text tags removed). `size` is in the rect's own units: canvas pixels on a canvas,
   * and for a TextMeshPro outside any canvas (3D text) a tenth of its font size, as TMP draws it (36 → 3.6 units).
   */
  text?: { value: string; size: number; color: [number, number, number, number]; align: "left" | "center" | "right"; valign: "top" | "middle" | "bottom"; auto?: true; min?: number; max?: number; wrap?: false };
}

/** Unity's class ids for the components the outliner names (the Inspector's names). */
export const COMPONENTS: Record<string, string> = {
  "20": "Camera", "23": "MeshRenderer", "33": "MeshFilter", "50": "Rigidbody2D", "54": "Rigidbody", "58": "CircleCollider2D", "60": "PolygonCollider2D", "61": "BoxCollider2D", "64": "MeshCollider", "65": "BoxCollider", "70": "CapsuleCollider2D", "81": "AudioListener", "82": "AudioSource", "95": "Animator", "108": "Light", "135": "SphereCollider", "136": "CapsuleCollider", "137": "SkinnedMeshRenderer", "143": "CharacterController", "195": "NavMeshAgent", "198": "ParticleSystem", "212": "SpriteRenderer", "222": "CanvasRenderer", "223": "Canvas", "156049354": "Grid", "483693784": "TilemapRenderer", "1839735485": "Tilemap",
};

/** Unity's built-in meshes (in "Library/unity default resources"), by file id. */
const BUILTIN: Record<string, "cube" | "sphere" | "cylinder" | "capsule" | "plane" | "quad"> = { "10202": "cube", "10207": "sphere", "10206": "cylinder", "10208": "capsule", "10209": "plane", "10210": "quad" };
const BUILTIN_GUID = "0000000000000000e000000000000000";

/** `{x: 1, y: 2.5, z: -3}` → the numbers, by key. */
function vec(s: string | undefined, keys: string[], fallback: number[]): number[] {
  if (!s) return fallback;
  return keys.map((k, i) => {
    const m = new RegExp(`\\b${k}:\\s*(-?[\\d.]+(?:e[-+]?\\d+)?)`, "i").exec(s);
    return m ? Number(m[1]) : fallback[i]!;
  });
}

/** A list of references under a key (`m_Children:` then `- {fileID: 5}` lines), in order. */
function listOf(body: string, key: string): string[] {
  const m = new RegExp(`^([ \\t]*)${key}:[ \\t]*\\n((?:\\1- \\{fileID:[^\\n]*\\n?)*)`, "m").exec(body);
  return m ? [...m[2]!.matchAll(new RegExp(`fileID:\\s*(${FILE_ID})`, "g"))].map((x) => x[1]!) : [];
}

/** A list block's entries (`key:` then `- …` items at its indent), each item's text. */
function itemsOf(body: string, key: string): string[] {
  const lines = body.split("\n");
  const at = lines.findIndex((l) => new RegExp(`^\\s*${key}:\\s*$`).test(l));
  if (at < 0) return [];
  const ind = lines[at]!.length - lines[at]!.trimStart().length;
  const out: string[][] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]!, li = l.length - l.trimStart().length;
    if (l.trim() && (li < ind || (li === ind && !l.trimStart().startsWith("- ")))) break;
    if (li === ind && l.trimStart().startsWith("- ")) out.push([l.replace("- ", "  ")]);
    else out[out.length - 1]?.push(l);
  }
  return out.map((x) => x.join("\n"));
}

/**
 * A Tilemap's cells: m_Tiles (each cell's place and indexes into the sprite and colour arrays), m_TileSpriteArray
 * (sprite references) and m_TileColorArray.
 */
function readTilemap(body: string): Omit<UnityTilemap, "cell" | "sort"> {
  const tiles: number[] = [];
  for (const t of itemsOf(body, "m_Tiles")) {
    if (tiles.length >= MAX_TILES * 4) break;
    const p = vec(field(t, "first"), ["x", "y"], [NaN, NaN]);
    const si = Number(field(t, "m_TileSpriteIndex") ?? NaN), ci = Number(field(t, "m_TileColorIndex") ?? 0);
    if (p.every(Number.isFinite) && Number.isFinite(si)) tiles.push(p[0]!, p[1]!, si, Number.isFinite(ci) ? ci : 0);
  }
  const sprites = itemsOf(body, "m_TileSpriteArray").map((x) => { const r = ref(field(x, "m_Data")); return { fileID: r?.fileID ?? "0", ...(r?.guid ? { guid: r.guid } : {}) }; });
  const colors = itemsOf(body, "m_TileColorArray").map((x) => vec(field(x, "m_Data"), RGBA, [1, 1, 1, 1]) as [number, number, number, number]);
  return { anchor: vec(field(body, "m_TileAnchor"), XY, [0.5, 0.5]) as [number, number], tiles, sprites, colors };
}

/** uGUI's layout groups, by their scripts' GUIDs (the same in every project: they come with the UI package). */
const H_LAYOUT = "30649d3a9faa99c48a7b1166b86bf2a0", V_LAYOUT = "59f8146938fff824cb5fd77236b75775";
/** Unity's built-in UI sprites (UISprite, Background…): drawn here as plain colour. */
const BUILTIN_UI = "0000000000000000f000000000000000";
const RGBA = ["r", "g", "b", "a"];
const XY = ["x", "y"];
type V2 = [number, number];

/** A layout group's settings, enough to stack its children roughly as Unity does. */
interface LayoutGroup { kind: "h" | "v" | "grid"; padding: number[]; spacing: V2; align: number; control: [boolean, boolean]; expand: [boolean, boolean]; cell: V2 }
/** A Transform as read, before the UI layout. */
interface Tf {
  id: string;
  go: string;
  parent: string;
  children: string[];
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
  /** A RectTransform's own layout (anchors 0–1 in the parent's rect; sizes and positions in canvas units). */
  rect?: { aMin: V2; aMax: V2; pos: V2; size: V2; pivot: V2 };
  /** The root of a prefab instance expanded in the scene: its move key's two halves. */
  root?: { instance: string; source: string };
}
/** A laid-out RectTransform: its size, pivot and its pivot's place in the parent's local space. */
interface Laid { size: V2; pivot: V2; pos: V2; order: number; canvas?: "screen" | "world"; own?: boolean; /** Outside any canvas (3D text): its font size is not in canvas pixels. */ loose?: boolean }

/** Reads a uGUI component (Image, RawImage, TextMeshPro, Text, CanvasScaler, a layout group) onto its GameObject. */
function readUiComponent(body: string, script: string | undefined, go: string, out: { graphics: Map<string, Omit<UnityUi, "size" | "pivot" | "order">>; scalers: Map<string, V2>; groups: Map<string, LayoutGroup> }): void {
  const f = (k: string) => field(body, k);
  const num = (k: string, fb: number) => { const v = f(k); return v !== undefined && Number.isFinite(Number(v)) && v.trim() !== "" ? Number(v) : fb; };
  const tmp = f("m_text") !== undefined;
  if (tmp || (f("m_Text") !== undefined && f("m_FontData") !== undefined)) {
    // TextMeshPro (m_text, alignment as flags) or the old Text (m_Text, alignment 0–8).
    // Rich text (<color>, <size>, <sprite>, …) is removed; <br> is a line break.
    const value = (yamlScalar(body, tmp ? "m_text" : "m_Text") ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/?[a-zA-Z#][^<>]*>/g, "").replace(/&nbsp;/g, " ").slice(0, 2000);
    if (!value.trim()) {
      // An empty label draws nothing.
      const { text: _gone, ...rest } = out.graphics.get(go) ?? {};
      if (Object.keys(rest).length) out.graphics.set(go, rest);
      return;
    }
    let align: "left" | "center" | "right", valign: "top" | "middle" | "bottom";
    if (tmp) {
      const old = num("m_textAlignment", 257);
      const h = num("m_HorizontalAlignment", old & 0xff), v = num("m_VerticalAlignment", old & 0xff00);
      align = h & 2 ? "center" : h & 4 ? "right" : "left";
      valign = v & 256 ? "top" : v & 1024 ? "bottom" : "middle";
    } else {
      const a = Math.min(8, Math.max(0, num("m_Alignment", 0)));
      align = (["left", "center", "right"] as const)[a % 3]!;
      valign = (["top", "middle", "bottom"] as const)[Math.floor(a / 3)]!;
    }
    const color = vec((tmp ? f("m_fontColor") : undefined) ?? f("m_Color"), RGBA, [1, 1, 1, 1]) as UnityUi["color"] & object;
    const size = tmp ? num("m_fontSize", 36) : num("m_FontSize", 14);
    const auto = tmp && num("m_enableAutoSizing", 0) === 1;
    // Auto size picks the biggest size in [min, max] that fits the rect (TMP's defaults: 18 and 72).
    out.graphics.set(go, { ...out.graphics.get(go), text: { value, size, color, align, valign, ...(auto ? { auto: true as const, min: Math.max(1, num("m_fontSizeMin", 18)), max: Math.max(1, num("m_fontSizeMax", 72)) } : {}), ...(tmp && num("m_enableWordWrapping", 1) === 0 ? { wrap: false as const } : {}) } });
  } else if ((f("m_Sprite") !== undefined && f("m_Type") !== undefined) || (f("m_Texture") !== undefined && f("m_UVRect") !== undefined)) {
    // Image (its sprite) or RawImage (its texture), tinted by m_Color.
    const pic = ref(f(f("m_Sprite") !== undefined ? "m_Sprite" : "m_Texture"))?.guid;
    out.graphics.set(go, { ...out.graphics.get(go), color: vec(f("m_Color"), RGBA, [1, 1, 1, 1]) as [number, number, number, number], ...(pic && pic !== BUILTIN_UI ? { image: pic } : {}) });
  } else if (f("m_ReferenceResolution") !== undefined) {
    // CanvasScaler: "Scale With Screen Size" lays the canvas out at its reference resolution.
    if (num("m_UiScaleMode", 0) === 1) out.scalers.set(go, vec(f("m_ReferenceResolution"), XY, [800, 600]) as V2);
  } else if (f("m_ChildAlignment") !== undefined && f("m_Spacing") !== undefined) {
    const kind = f("m_CellSize") !== undefined ? "grid" : script === H_LAYOUT ? "h" : script === V_LAYOUT ? "v" : undefined;
    if (!kind) return;
    const sp = f("m_Spacing")!;
    out.groups.set(go, {
      kind,
      padding: vec(f("m_Padding"), ["m_Left", "m_Right", "m_Top", "m_Bottom"], [0, 0, 0, 0]),
      spacing: (kind === "grid" ? vec(sp, XY, [0, 0]) : [num("m_Spacing", 0), num("m_Spacing", 0)]) as V2,
      align: num("m_ChildAlignment", 0),
      control: [num("m_ChildControlWidth", 0) === 1, num("m_ChildControlHeight", 0) === 1],
      expand: [num("m_ChildForceExpandWidth", 1) === 1, num("m_ChildForceExpandHeight", 1) === 1],
      cell: vec(f("m_CellSize"), XY, [100, 100]) as V2,
    });
  }
}

/** A TextMeshPro's font size is in points: outside a canvas (3D text) one point is a tenth of a unit. */
export const TMP_WORLD_UNIT = 0.1;

/**
 * What an object draws, with its text sized for where it is: on a canvas the font size is in canvas pixels as
 * saved; outside any canvas it is scaled to world units (see TMP_WORLD_UNIT).
 *
 * @param g - The object's image / text as read.
 * @param loose - True when the object is outside any canvas.
 */
function uiGraphic(g: Omit<UnityUi, "size" | "pivot" | "order"> | undefined, loose?: boolean): Omit<UnityUi, "size" | "pivot" | "order"> {
  if (!g?.text || !loose) return g ?? {};
  const t = g.text;
  return { ...g, text: { ...t, size: t.size * TMP_WORLD_UNIT, ...(t.min !== undefined ? { min: t.min * TMP_WORLD_UNIT } : {}), ...(t.max !== undefined ? { max: t.max * TMP_WORLD_UNIT } : {}) } };
}

/**
 * Stacks a layout group's children (horizontal, vertical or a grid), roughly as uGUI does, when the file does not
 * already hold their laid-out places (Unity saves them; a prefab often has them all at one point).
 *
 * @param g - The group.
 * @param p - The group's own laid-out rect.
 * @param kids - Its active RectTransform children.
 * @param rects - Their rects (changed in place).
 */
function stack(g: LayoutGroup, p: Laid, kids: Tf[], rects: Laid[]): void {
  if (kids.length < 2) return;
  const first = kids[0]!.rect!.pos;
  if (!kids.every((k) => Math.abs(k.rect!.pos[0] - first[0]) < 0.01 && Math.abs(k.rect!.pos[1] - first[1]) < 0.01)) return;
  const [pl, pr, pt, pb] = g.padding as [number, number, number, number];
  const inner: V2 = [p.size[0] - pl - pr, p.size[1] - pt - pb];
  const frac = [0, 0.5, 1];
  const col = frac[g.align % 3] ?? 0, row = frac[Math.floor(g.align / 3)] ?? 0;
  /** Each child's top-left corner in the parent's rect (y down), and its size. */
  const boxes: Array<{ x: number; y: number; w: number; h: number }> = [];
  if (g.kind === "grid") {
    const cols = Math.max(1, Math.floor((inner[0] + g.spacing[0]) / (g.cell[0] + g.spacing[0])));
    kids.forEach((_k, i) => boxes.push({ x: pl + (i % cols) * (g.cell[0] + g.spacing[0]), y: pt + Math.floor(i / cols) * (g.cell[1] + g.spacing[1]), w: g.cell[0], h: g.cell[1] }));
  } else {
    const a: 0 | 1 = g.kind === "h" ? 0 : 1, b: 0 | 1 = a === 0 ? 1 : 0;
    const n = kids.length, gap = g.spacing[0];
    const slots = rects.map((r) => (g.expand[a] ? (inner[a] - gap * (n - 1)) / n : r.size[a]));
    const total = slots.reduce((s, x) => s + x, 0) + gap * (n - 1);
    let at = (a === 0 ? pl : pt) + (inner[a] - total) * (a === 0 ? col : row);
    rects.forEach((r, i) => {
      const along = g.control[a] ? slots[i]! : r.size[a];
      const across = g.control[b] && g.expand[b] ? inner[b] : r.size[b];
      const posAlong = at + (slots[i]! - along) * (a === 0 ? col : row);
      const posAcross = (b === 0 ? pl : pt) + (inner[b] - across) * (b === 0 ? col : row);
      boxes.push(a === 0 ? { x: posAlong, y: posAcross, w: along, h: across } : { x: posAcross, y: posAlong, w: across, h: along });
      at += slots[i]! + gap;
    });
  }
  const left = -p.pivot[0] * p.size[0], top = (1 - p.pivot[1]) * p.size[1];
  rects.forEach((r, i) => {
    const bx = boxes[i]!;
    r.size = [bx.w, bx.h];
    r.pos = [left + bx.x + r.pivot[0] * bx.w, top - bx.y - (1 - r.pivot[1]) * bx.h];
  });
}

/**
 * Lays out every uGUI RectTransform: a root canvas at its reference resolution (Screen Space) or its own size (World
 * Space), each child from its anchors, anchored position, size delta and pivot, layout groups stacked roughly.
 *
 * @returns Transform id → its laid-out rect.
 */
function layoutUi(transforms: Tf[], canvasOf: Map<string, number>, scalers: Map<string, V2>, groups: Map<string, LayoutGroup>, inactive: Set<string>): Map<string, Laid> {
  const byId = new Map(transforms.map((t) => [t.id, t]));
  const kidsOf = new Map<string, string[]>();
  for (const t of transforms) kidsOf.set(t.parent, [...(kidsOf.get(t.parent) ?? []), t.id]);
  // Children in the Hierarchy's order (m_Children), then any the parent's list misses.
  const childrenOf = (id: string) => {
    const all = kidsOf.get(id) ?? [];
    const listed = (byId.get(id)?.children ?? []).filter((c) => all.includes(c));
    return [...listed, ...all.filter((c) => !listed.includes(c))];
  };
  const laid = new Map<string, Laid>();
  let order = 0;
  const rectIn = (t: Tf, p: Laid): Laid => {
    const r = t.rect!;
    const size: V2 = [(r.aMax[0] - r.aMin[0]) * p.size[0] + r.size[0], (r.aMax[1] - r.aMin[1]) * p.size[1] + r.size[1]];
    const anchor = (i: 0 | 1) => (r.aMin[i] + (r.aMax[i] - r.aMin[i]) * r.pivot[i]) * p.size[i] - p.pivot[i] * p.size[i];
    return { size, pivot: r.pivot, pos: [anchor(0) + r.pos[0], anchor(1) + r.pos[1]], order: 0 };
  };
  const visit = (id: string) => {
    const p = laid.get(id)!;
    const kids = childrenOf(id).map((c) => byId.get(c)!).filter((c) => c.rect && !laid.has(c.id));
    const rects = kids.map((c) => rectIn(c, p));
    const g = groups.get(byId.get(id)!.go);
    if (g) {
      const on = kids.map((k, i) => [k, rects[i]!] as const).filter(([k]) => !inactive.has(k.go));
      stack(g, p, on.map(([k]) => k), on.map(([, r]) => r));
    }
    kids.forEach((c, i) => { laid.set(c.id, { ...rects[i]!, order: order++, ...(p.loose ? { loose: true } : {}) }); visit(c.id); });
  };
  const hasCanvasAbove = (t: Tf) => { for (let x = byId.get(t.parent), n = 0; x && n < 256; x = byId.get(x.parent), n++) if (canvasOf.has(x.go)) return true; return false; };
  for (const t of transforms) {
    if (!t.rect || laid.has(t.id) || !canvasOf.has(t.go) || hasCanvasAbove(t)) continue;
    const world = canvasOf.get(t.go) === 2;
    const ref = scalers.get(t.go);
    const size: V2 = world ? t.rect.size : ref ?? (t.rect.size[0] > 0 && t.rect.size[1] > 0 ? t.rect.size : [1920, 1080]);
    laid.set(t.id, { size, pivot: world ? t.rect.pivot : [0.5, 0.5], pos: [0, 0], order: order++, canvas: world ? "world" : "screen", own: world });
    visit(t.id);
  }
  // RectTransforms outside any canvas (a 3D TextMeshPro): their own place, their size from sizeDelta.
  for (const t of transforms) {
    if (!t.rect || laid.has(t.id) || byId.get(t.parent)?.rect) continue;
    laid.set(t.id, { size: t.rect.size, pivot: t.rect.pivot, pos: [t.position[0], t.position[1]], order: order++, own: true, loose: true });
    visit(t.id);
  }
  return laid;
}

/**
 * The scene's objects that have a Transform, with their names and looks; placed prefabs and models too. With the
 * prefabs' files given, each placed prefab is expanded into its own objects (overrides applied, nested prefabs too);
 * without them (or for one not found) it is one object whose place is in the instance's overrides. uGUI objects are
 * laid out (their `ui`: size, pivot, colour, picture, text).
 *
 * @param text - The .unity file.
 * @param prefabs - Prefab GUID → the prefab's text (the route reads them), to expand placed prefabs.
 * @returns The objects, parents before children where the file has them so.
 */
export function readUnityScene(text: string, prefabs?: ReadonlyMap<string, string>): UnityObject[] {
  if (!/^%YAML/.test(text) || !/--- !u!/.test(text)) throw new Error("This is not a Unity scene saved as text (Edit → Project Settings → Editor → Asset Serialization: Force Text).");
  const docs = prefabs?.size ? expandPrefabs(parseDocs(text), prefabs) : parseDocs(text);
  const names = new Map<string, string>();
  const inactive = new Set<string>();
  const looks = new Map<string, UnityLook>();
  /** Every document's class, and a MonoBehaviour's script / a SpriteRenderer's sprite, to name each GameObject's components. */
  const classOf = new Map<string, string>(), scriptOf = new Map<string, string>(), spriteOf = new Map<string, string>();
  const parts = new Map<string, string[]>();
  /** Each component's GameObject (a component an override added is not in the GameObject's list). */
  const ownerOf = new Map<string, string>();
  /** A stripped Transform (a prefab's, named here only as some object's parent) → its prefab instance. */
  const strippedOf = new Map<string, string>();
  const transforms: Tf[] = [];
  const placed: UnityObject[] = [];
  const canvasOf = new Map<string, number>();
  /** 2D: SpriteRenderer settings per component, Tilemaps, their renderers' sorting and Grids' cell sizes per GameObject, SpriteShapes. */
  const spriteInfoOf = new Map<string, UnitySprite>();
  const tilemapOf = new Map<string, Omit<UnityTilemap, "cell" | "sort">>(), tileSortOf = new Map<string, [number, number]>(), gridOf = new Map<string, [number, number]>();
  const shapeOf = new Map<string, NonNullable<UnityObject["shape"]>>();
  const ui = { graphics: new Map<string, Omit<UnityUi, "size" | "pivot" | "order">>(), scalers: new Map<string, V2>(), groups: new Map<string, LayoutGroup>() };
  for (const d of docs) {
    const { cls, id, stripped, body } = d;
    const f = (k: string) => field(body, k);
    classOf.set(id, cls);
    const go = cls === "1" ? undefined : ref(f("m_GameObject"))?.fileID;
    if (go && go !== "0") ownerOf.set(id, go);
    if (cls === "114") {
      const g = ref(f("m_Script"))?.guid;
      if (g) scriptOf.set(id, g);
      if (go && !stripped && f("m_Enabled")?.trim() !== "0") readUiComponent(body, g, go, ui);
    }
    const sortOf = (): [number, number] => [Number(f("m_SortingLayerID") ?? f("m_SortingLayer") ?? 0) || 0, Number(f("m_SortingOrder") ?? 0) || 0];
    if (cls === "212" && f("m_Enabled")?.trim() !== "0") {
      // SpriteRenderer: the sprite (a sheet's sprite by its file id), tint, flips, sorting, and a sliced / tiled size.
      const r = ref(f("m_Sprite"));
      if (r?.guid) {
        spriteOf.set(id, r.guid);
        const drawMode = Number(f("m_DrawMode") ?? 0);
        spriteInfoOf.set(id, { fileID: r.fileID, color: vec(f("m_Color"), RGBA, [1, 1, 1, 1]) as UnitySprite["color"], flip: [f("m_FlipX")?.trim() === "1", f("m_FlipY")?.trim() === "1"], sort: sortOf(), ...(drawMode ? { size: vec(f("m_Size"), XY, [1, 1]) as [number, number] } : {}) });
      }
    }
    if (cls === "1839735485" && go) tilemapOf.set(go, readTilemap(body));
    if (cls === "483693784" && go) tileSortOf.set(go, sortOf());
    if (cls === "156049354" && go) gridOf.set(go, vec(f("m_CellSize"), XY, [1, 1]) as [number, number]);
    if (cls === "114" && go && f("m_Spline") !== undefined) {
      // SpriteShapeController: its spline's control points (drawn as an outline; the fill is not rebuilt here).
      const points = [...(body.split(/^\s*m_ControlPoints:/m)[1] ?? "").matchAll(/^\s*- position: \{x: (-?[\d.e+-]+), y: (-?[\d.e+-]+)/gm)].slice(0, 2000).map((m) => [Number(m[1]), Number(m[2])] as [number, number]);
      if (points.length > 1) shapeOf.set(go, { points, closed: f("m_IsOpenEnded")?.trim() !== "1" });
    }
    if (cls === "223" && go) canvasOf.set(go, Number(f("m_RenderMode") ?? 0) || 0);
    if (cls === "1") {
      names.set(id, (yamlScalar(body, "m_Name") ?? "").trim());
      if (f("m_IsActive")?.trim() === "0") inactive.add(id);
      parts.set(id, [...body.matchAll(new RegExp(`- component:\\s*\\{fileID:\\s*(${FILE_ID})`, "g"))].map((m) => m[1]!));
    } else if ((cls === "4" || cls === "224") && stripped) {
      const pi = ref(f("m_PrefabInstance"))?.fileID;
      if (pi && pi !== "0") strippedOf.set(id, pi);
    } else if (cls === "4" || cls === "224") {
      // Transform, or RectTransform (UI): both have the local position, rotation and scale.
      transforms.push({
        id,
        go: go ?? "0",
        parent: ref(f("m_Father"))?.fileID ?? "0",
        children: listOf(body, "m_Children"),
        position: vec(f("m_LocalPosition"), ["x", "y", "z"], [0, 0, 0]) as [number, number, number],
        rotation: vec(f("m_LocalRotation"), ["x", "y", "z", "w"], [0, 0, 0, 1]) as [number, number, number, number],
        scale: vec(f("m_LocalScale"), ["x", "y", "z"], [1, 1, 1]) as [number, number, number],
        ...(cls === "224" ? { rect: { aMin: vec(f("m_AnchorMin"), XY, [0.5, 0.5]) as V2, aMax: vec(f("m_AnchorMax"), XY, [0.5, 0.5]) as V2, pos: vec(f("m_AnchoredPosition"), XY, [0, 0]) as V2, size: vec(f("m_SizeDelta"), XY, [100, 100]) as V2, pivot: vec(f("m_Pivot"), XY, [0.5, 0.5]) as V2 } } : {}),
        ...(d.instanceRoot ? { root: { instance: d.instanceRoot, source: d.rootSource ?? "0" } } : {}),
      });
    } else if (cls === "33") {
      // MeshFilter: the object's mesh.
      const mesh = ref(f("m_Mesh"));
      if (go && mesh?.guid === BUILTIN_GUID && BUILTIN[mesh.fileID]) looks.set(go, { builtin: BUILTIN[mesh.fileID]! });
      else if (go && mesh?.guid) looks.set(go, { guid: mesh.guid });
    } else if (cls === "1001") {
      // A placed prefab or model not expanded (no prefab file: a model, or not found): its place and name are
      // overrides of its root's properties. Unity 2018.3+ names the source m_SourcePrefab; older projects m_ParentPrefab.
      const src = ref(f("m_SourcePrefab")) ?? ref(f("m_ParentPrefab"));
      const p = [0, 0, 0], r = [0, 0, 0, 1], sc = [1, 1, 1];
      let target: string | undefined, name: string | undefined;
      for (const m of modsOf(body)) {
        const k = /^m_Local(Position|Rotation|Scale)\.([xyzw])$/.exec(m.path);
        if (k) {
          target ??= m.fileID;
          const arr = k[1] === "Position" ? p : k[1] === "Rotation" ? r : sc;
          arr["xyzw".indexOf(k[2]!)] = Number(m.value);
        } else if (m.path === "m_Name") name = m.value.trim();
      }
      if (!target) continue;
      placed.push({
        id: `${target}:${id}`,
        name: name || `Prefab ${id}`,
        parent: ref(f("m_TransformParent"))?.fileID ?? "0",
        position: p as [number, number, number],
        rotation: r as [number, number, number, number],
        scale: sc as [number, number, number],
        prefab: true,
        // One inside an expanded prefab (too deep, or a cycle) is not moved from here.
        ...(id.includes("~") ? { readOnly: "prefab" as const } : {}),
        ...(src?.guid ? { look: { guid: src.guid } } : {}),
      });
    }
  }
  // Components an override added to a prefab's GameObject.
  for (const [c, go] of ownerOf) if (parts.has(go) && !parts.get(go)!.includes(c) && classOf.get(c) !== "4" && classOf.get(c) !== "224") parts.get(go)!.push(c);
  const byInstance = new Map(placed.map((o) => [o.id.slice(o.id.indexOf(":") + 1), o.id]));
  /** The id an object is moved by: an expanded prefab's root keeps its GlobalObjectId halves. */
  const outId = new Map(transforms.flatMap((t) => (t.root ? [[t.id, `${t.root.source}:${t.root.instance}`] as const] : [])));
  /** A parent that is a prefab's inner Transform: the placed prefab stands for it. */
  const parentOf = (id: string) => (strippedOf.has(id) ? byInstance.get(strippedOf.get(id)!) ?? "0" : outId.get(id) ?? id);
  const attached = (go: string) => {
    const list = (parts.get(go) ?? []).flatMap((c) => {
      const k = classOf.get(c);
      if (k === "114") return scriptOf.has(c) ? [`script:${scriptOf.get(c)}`] : ["MonoBehaviour"];
      return k && COMPONENTS[k] ? [COMPONENTS[k]!] : [];
    });
    const comp = (parts.get(go) ?? []).find((c) => spriteOf.has(c));
    const sprite = comp && spriteOf.get(comp);
    return { ...(list.length ? { components: list } : {}), ...(sprite ? { sprite, spriteInfo: { ...spriteInfoOf.get(comp)! } } : {}) };
  };
  const laid = layoutUi(transforms, canvasOf, ui.scalers, ui.groups, inactive);
  const own = transforms.map((t): UnityObject => {
    const l = laid.get(t.id);
    const screen = l?.canvas === "screen";
    const position: [number, number, number] = !l || l.own ? t.position : screen ? [0, 0, 0] : [l.pos[0], l.pos[1], t.position[2]];
    return {
      id: outId.get(t.id) ?? t.id,
      name: names.get(t.go) || `Object ${t.id}`,
      parent: parentOf(t.parent),
      position,
      // A Screen Space canvas: one canvas unit is a pixel, shown at 100 to a unit (Unity 2D's default).
      rotation: screen ? [0, 0, 0, 1] : t.rotation,
      scale: screen ? [0.01, 0.01, 0.01] : t.scale,
      ...(t.root ? { prefab: true } : {}),
      ...(inactive.has(t.go) ? { active: false as const } : {}),
      ...(l ? { readOnly: "ui" as const } : tilemapOf.has(t.go) ? { readOnly: "tilemap" as const } : t.id.includes("~") && !t.root ? { readOnly: "prefab" as const } : {}),
      ...(looks.has(t.go) ? { look: looks.get(t.go)! } : {}),
      ...attached(t.go),
      ...(l ? { ui: { size: l.size, pivot: l.pivot, order: l.order, ...(l.canvas ? { canvas: l.canvas } : {}), ...uiGraphic(ui.graphics.get(t.go), l.loose) } } : {}),
      // A Tilemap's cell size is its parent Grid's.
      ...(tilemapOf.has(t.go) ? { tilemap: { ...tilemapOf.get(t.go)!, cell: gridOf.get(transforms.find((p) => p.id === t.parent)?.go ?? "") ?? gridOf.get(t.go) ?? [1, 1], sort: tileSortOf.get(t.go) ?? [0, 0] } } : {}),
      ...(shapeOf.has(t.go) ? { shape: shapeOf.get(t.go)! } : {}),
    };
  });
  return [...own, ...placed.map((o) => ({ ...o, parent: parentOf(o.parent) }))];
}

/** Where the stand-in looks first: 2D or 3D, and the box around what is visible (Unity's space). */
export interface UnityView {
  view: "2d" | "3d";
  bounds?: { min: [number, number, number]; max: [number, number, number] };
  /**
   * Where a Screen Space canvas is shown when the scene also has world content: the canvas is its own panel (its
   * pixels, never the world's units), fitted over the world box like Unity's Game view. `scale` is world units per
   * canvas pixel, `center` the canvas middle in the world. Absent when there is no such canvas or no world content.
   */
  canvas?: { center: [number, number]; scale: number };
}

/** A 3 × 4 affine matrix (rows), Unity's local → parent space. */
type M = number[];
function compose(p: number[], q: number[], s: number[]): M {
  const [x, y, z, w] = q as [number, number, number, number];
  const r = [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
  return [r[0]! * s[0]!, r[1]! * s[1]!, r[2]! * s[2]!, p[0]!, r[3]! * s[0]!, r[4]! * s[1]!, r[5]! * s[2]!, p[1]!, r[6]! * s[0]!, r[7]! * s[1]!, r[8]! * s[2]!, p[2]!];
}
function mul(a: M, b: M): M {
  const o: number[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) o.push(a[i * 4]! * b[j]! + a[i * 4 + 1]! * b[4 + j]! + a[i * 4 + 2]! * b[8 + j]! + (j === 3 ? a[i * 4 + 3]! : 0));
  return o;
}
const apply = (m: M, v: number[]) => [0, 1, 2].map((i) => m[i * 4]! * v[0]! + m[i * 4 + 1]! * v[1]! + m[i * 4 + 2]! * v[2]! + m[i * 4 + 3]!);

/**
 * The first view of a scene in the stand-in: 2D when it has sprites or UI and no 3D meshes or models, and the box
 * around everything visible that draws (UI rects that draw, sprites, meshes, models, placed prefabs). Inactive objects
 * and anything under a scale of 0 are left out; with only UI, the box is the UI's.
 *
 * @param objects - The scene's objects (readUnityScene, after the route resolved their looks).
 * @returns The view and the box (no box when nothing visible draws).
 */
export function sceneView(objects: readonly UnityObject[]): UnityView {
  const byId = new Map(objects.map((o) => [o.id, o]));
  const draws = (o: UnityObject) => !!(o.ui ? o.ui.color || o.ui.image || o.ui.text : o.sprite || o.look || o.model || o.prefab || o.tilemap?.tiles.length || o.shape);
  /** Under a Screen Space canvas: its rects are pixels on their own panel, not part of the world's extent. */
  const onScreen = (o: UnityObject): boolean => { for (let x: UnityObject | undefined = o, n = 0; x && n < 256; x = byId.get(x.parent), n++) if (x.ui?.canvas === "screen") return true; return false; };
  const worldDraws = objects.some((o) => !onScreen(o) && draws(o));
  const screens = objects.filter((o) => o.ui?.canvas === "screen");
  const world = new Map<string, M | null>();
  /** The object's world matrix; null when it or a parent is off or collapsed to a scale of 0. */
  const worldOf = (o: UnityObject, depth = 0): M | null => {
    if (world.has(o.id)) return world.get(o.id)!;
    let m: M | null = null;
    if (o.active !== false && !o.scale.some((s) => Math.abs(s) < 1e-9) && depth < 256) {
      const parent = byId.get(o.parent);
      const pm = parent ? worldOf(parent, depth + 1) : compose([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
      m = pm && mul(pm, compose(o.position, o.rotation, o.scale));
    }
    world.set(o.id, m);
    return m;
  };
  // Mostly 2D (sprites, tilemaps, sprite shapes, UI) → the 2D view.
  const threeD = objects.filter((o) => o.model || o.look || o.components?.includes("MeshFilter")).length;
  const twoD = objects.filter((o) => o.ui || o.sprite || o.tilemap || o.shape || o.components?.includes("SpriteRenderer")).length;
  const flat = twoD > threeD;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const add = (p: number[]) => p.forEach((v, i) => { min[i] = Math.min(min[i]!, v); max[i] = Math.max(max[i]!, v); });
  for (const o of objects) {
    if (!draws(o) || (worldDraws && onScreen(o))) continue;
    const m = worldOf(o);
    if (!m) continue;
    if (o.ui) {
      const [w, h] = o.ui.size, [px, py] = o.ui.pivot;
      for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) add(apply(m, [(cx - px) * w, (cy - py) * h, 0]));
    } else if (o.tilemap?.tiles.length) {
      const t = o.tilemap, xs: number[] = [], ys: number[] = [];
      for (let i = 0; i < t.tiles.length; i += 4) { xs.push(t.tiles[i]!); ys.push(t.tiles[i + 1]!); }
      const x0 = Math.min(...xs) * t.cell[0], x1 = (Math.max(...xs) + 1) * t.cell[0], y0 = Math.min(...ys) * t.cell[1], y1 = (Math.max(...ys) + 1) * t.cell[1];
      for (const p of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) add(apply(m, [p[0]!, p[1]!, 0]));
    } else if (o.shape) {
      for (const p of o.shape.points) add(apply(m, [p[0], p[1], 0]));
    } else if (o.spriteInfo?.rect && o.spriteInfo.ppu) {
      // A sprite whose rect is known: its drawn size around its pivot.
      const si = o.spriteInfo, w = si.size?.[0] ?? si.rect![2] / si.ppu!, h = si.size?.[1] ?? si.rect![3] / si.ppu!, [px, py] = si.pivot ?? [0.5, 0.5];
      for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) add(apply(m, [(cx - px) * w, (cy - py) * h, 0]));
    } else {
      // A sprite or a mesh: its size is known only once drawn; a unit around its place.
      const c = apply(m, [0, 0, 0]);
      add(c.map((v) => v - 0.5));
      add(c.map((v) => v + 0.5));
    }
  }
  const bounds = Number.isFinite(min[0]) ? { min: min as [number, number, number], max: max as [number, number, number] } : undefined;
  // A Screen Space canvas beside world content: fitted (aspect kept) into the world's box, at its own pixel scale.
  const root = screens[0];
  const canvas = root && worldDraws && bounds && root.ui!.size[0] > 0 && root.ui!.size[1] > 0
    ? { center: [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2] as [number, number], scale: Math.max(1e-6, Math.min((bounds.max[0] - bounds.min[0]) / root.ui!.size[0], (bounds.max[1] - bounds.min[1]) / root.ui!.size[1])) }
    : undefined;
  return { view: flat ? "2d" : "3d", ...(bounds ? { bounds } : {}), ...(canvas ? { canvas } : {}) };
}

/** A move for the Unity package to apply (local position, rotation and scale of one Transform). */
export interface UnityMove {
  id: string;
  name: string;
  /** What it was when the stand-in was made, to tell a clash. */
  from: { position: number[]; rotation: number[]; scale: number[] };
  to: { position: number[]; rotation: number[]; scale: number[] };
}

/**
 * The moves the package applies when Unity opens (KesherAI/pending-moves.json in the project): per scene, merged with
 * those already waiting (a newer move of the same object replaces the older one, keeping the first "from").
 *
 * @param waiting - The file's moves now.
 * @param scene - The scene's path in the project ("Assets/…unity").
 * @param moves - The new moves.
 * @returns The new contents.
 */
export function mergeMoves(waiting: Record<string, UnityMove[]>, scene: string, moves: readonly UnityMove[]): Record<string, UnityMove[]> {
  const list = new Map((waiting[scene] ?? []).map((m) => [m.id, m]));
  for (const m of moves) list.set(m.id, { ...m, from: list.get(m.id)?.from ?? m.from });
  return { ...waiting, [scene]: [...list.values()] };
}
