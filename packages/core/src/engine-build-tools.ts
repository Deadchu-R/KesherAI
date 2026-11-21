/**
 * The engine tools of the engine specialists (engine-specialists.ts) that were missing:
 * - `unity_blockout` / `unreal_blockout` (Level design): primitives or prefabs placed on a grid from one plan, a
 *   lighting pass and the navmesh, as one undo step; the approval card lists every object added (scene diff).
 * - `unity_vfx` / `unreal_vfx` (VFX): a particle effect from a preset and a few numbers (Unity's Particle System,
 *   Unreal's Niagara through the KesherAI Bridge), or tuning one. With the editor closed, the spec is written into the
 *   project and queued (Unity: `KesherAI/pending-vfx/*.json`, applied by the bridge's KesherVfx.cs when Unity opens;
 *   Unreal: the bridge's offline queue, applied by a headless Unreal).
 * - `unity_texture_settings` (Materials): texture import settings (normal map, sRGB, size, compression).
 *
 * The plan → objects math is pure and shared by both engines: a grid in meters, x right, z forward, y up. Unity uses
 * it as is; Unreal (centimeters, Z up) maps grid x → Y, z → X, y → Z, which keeps the handedness, so yaw means the
 * same turn in both.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@kesher/agent";
import { scenePreview, type SceneDiff, type SceneEngine, type SceneObjectChange } from "@kesher/shared";
import { safeName, type UnityEditDeps } from "./unity-edit-tools.js";
import { csString } from "./unity-tools.js";
import type { UnrealBridge } from "./unreal-bridge.js";

/** Shapes a block-out item can be. */
export const BLOCK_SHAPES = ["floor", "wall", "cube", "ramp", "cylinder", "sphere", "prefab"] as const;
/** One of {@link BLOCK_SHAPES}. */
export type BlockShape = (typeof BLOCK_SHAPES)[number];
/** Light types of the lighting pass. */
export const LIGHT_TYPES = ["directional", "point", "spot"] as const;
const MAX_ITEMS = 200;
const MAX_LIGHTS = 20;
const WALL_THICKNESS = 0.2;
const FLOOR_THICKNESS = 0.2;

/** One placed object, engine-neutral: meters, x right, y up, z forward; size is [right, up, forward]. */
export interface PlacedBlock {
  name: string;
  shape: BlockShape;
  /** A prefab (Unity `Assets/…prefab`) or a Blueprint / static mesh (Unreal `/Game/…`). */
  asset?: string;
  center: [number, number, number];
  size: [number, number, number];
  /** Tilt up along forward (ramps), degrees. */
  pitch: number;
  yaw: number;
}

/** One light of the lighting pass, engine-neutral. */
export interface PlacedLight {
  name: string;
  type: (typeof LIGHT_TYPES)[number];
  center: [number, number, number];
  pitch: number;
  yaw: number;
  intensity: number;
  /** #rrggbb */
  color: string;
}

/** A checked block-out plan, ready for an engine. */
export interface Blockout {
  /** Grid cell size, meters. */
  cell: number;
  parent: string;
  blocks: PlacedBlock[];
  lights: PlacedLight[];
  /** Bounds for the navmesh (min and max corners, meters), when asked. */
  navmesh?: { min: [number, number, number]; max: [number, number, number] };
  /** Unreal: the level (/Game/Maps/…). */
  level?: string;
}

const num = (v: unknown, dflt: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
const r3 = (n: number) => Math.round(n * 1000) / 1000 || 0;
const pair = (v: unknown, dflt: [number, number], min: number, max: number): [number, number] =>
  Array.isArray(v) && v.length === 2 ? [num(v[0], dflt[0], min, max), num(v[1], dflt[1], min, max)] : dflt;
const COLOR = /^#[0-9a-f]{6}$/i;
/** Asset paths: Unity `Assets/…`, Unreal `/Game/…` or `/Engine/…`; never `..`. */
const ASSET_PATH = /^(Assets\/|\/(Game|Engine)\/)(?!(.*\/)?\.\.(\/|$))[\w/ .-]{1,300}$/;
const NAME = (v: unknown, dflt: string) => (typeof v === "string" && v.trim() ? v.trim().replace(/[^\p{L}\p{N} _().-]/gu, "_").slice(0, 80) : dflt);

/**
 * Checks a block-out plan and turns its grid cells into placed objects.
 *
 * Items: `shape`, `cell` [x, z] (the first cell), `span` [w, d] cells (default [1, 1]), `height` m, `elevation` m
 * (the bottom; a floor's top), `yaw` degrees, `name`, `asset` (prefab). A wall runs along its longer span; a ramp
 * rises by `height` over its forward span. Lights: `type`, `cell`, `height`, `intensity`, `color`, `pitch`, `yaw`.
 *
 * @param input - The tool's input.
 * @param engine - Whose asset paths are allowed for prefabs.
 * @returns The plan, or what is wrong in words.
 */
export function parseBlockout(input: Record<string, unknown>, engine: SceneEngine): Blockout | string {
  const cell = num(input.cell, 2, 0.25, 50);
  const items = Array.isArray(input.items) ? input.items : [];
  const lightsIn = Array.isArray(input.lights) ? input.lights : [];
  if (!items.length && !lightsIn.length && input.navmesh !== true) return "Give items to place (and lights, or navmesh true).";
  if (items.length > MAX_ITEMS) return `At most ${MAX_ITEMS} items in one call: split the level into parts.`;
  if (lightsIn.length > MAX_LIGHTS) return `At most ${MAX_LIGHTS} lights in one call.`;
  const blocks: PlacedBlock[] = [];
  for (const [i, raw] of items.entries()) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const shape = BLOCK_SHAPES.find((s) => s === o.shape);
    if (!shape) return `Item ${i + 1}: shape is one of ${BLOCK_SHAPES.join(", ")}.`;
    const [cx, cz] = pair(o.cell, [0, 0], -500, 500);
    const [w, d] = pair(o.span, [1, 1], 1, 200);
    const base = num(o.elevation, 0, -100, 500);
    const yaw = num(o.yaw, 0, -360, 360);
    const name = NAME(o.name, `${shape}_${i + 1}`);
    const x = (cx + w / 2) * cell;
    const z = (cz + d / 2) * cell;
    let asset: string | undefined;
    if (shape === "prefab") {
      asset = typeof o.asset === "string" ? o.asset.trim() : "";
      if (!ASSET_PATH.test(asset) || (engine === "unity") !== asset.startsWith("Assets/")) return `Item ${i + 1}: asset is ${engine === "unity" ? "an Assets/….prefab path" : "a /Game/… Blueprint or static mesh path"}.`;
    }
    const h = num(o.height, shape === "wall" ? 3 : shape === "floor" ? FLOOR_THICKNESS : shape === "ramp" ? 1 : cell, 0.05, 200);
    let size: [number, number, number];
    let y = base + h / 2;
    let pitch = 0;
    switch (shape) {
      case "floor":
        size = [w * cell, h, d * cell];
        y = base - h / 2;
        break;
      case "wall":
        size = d > w ? [WALL_THICKNESS, h, d * cell] : [w * cell, h, WALL_THICKNESS];
        break;
      case "ramp": {
        const run = d * cell;
        pitch = (Math.atan2(h, run) * 180) / Math.PI;
        size = [w * cell, FLOOR_THICKNESS, Math.hypot(run, h)];
        break;
      }
      case "prefab":
        size = [1, 1, 1];
        y = base;
        break;
      default:
        size = [w * cell, h, d * cell];
    }
    blocks.push({ name, shape, ...(asset ? { asset } : {}), center: [r3(x), r3(y), r3(z)], size: size.map(r3) as [number, number, number], pitch: r3(pitch), yaw: r3(yaw) });
  }
  const lights: PlacedLight[] = [];
  for (const [i, raw] of lightsIn.entries()) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const type = LIGHT_TYPES.find((t) => t === o.type);
    if (!type) return `Light ${i + 1}: type is one of ${LIGHT_TYPES.join(", ")}.`;
    const [cx, cz] = pair(o.cell, [0, 0], -500, 500);
    const color = typeof o.color === "string" && COLOR.test(o.color) ? o.color.toLowerCase() : "#ffffff";
    lights.push({
      name: NAME(o.name, type === "directional" ? "Sun" : `${type}_light_${i + 1}`),
      type,
      center: [r3((cx + 0.5) * cell), r3(num(o.height, type === "directional" ? 10 : 3, 0, 500)), r3((cz + 0.5) * cell)],
      pitch: r3(num(o.pitch, type === "point" ? 0 : 50, -90, 90)),
      yaw: r3(num(o.yaw, 30, -360, 360)),
      intensity: r3(num(o.intensity, type === "directional" ? 1 : 2, 0, 100_000)),
      color,
    });
  }
  const plan: Blockout = { cell, parent: NAME(input.parent, "Blockout"), blocks, lights };
  if (engine === "unreal") {
    const level = typeof input.level === "string" ? input.level.trim().split(".")[0]! : "";
    if (!/^\/Game\/(?!(.*\/)?\.\.(\/|$))[\w/ .-]{1,300}$/.test(level)) return "level is the level's path, e.g. /Game/Maps/Arena (unreal_inspect_level lists them).";
    plan.level = level;
  }
  if (input.navmesh === true) {
    if (!blocks.length) return "navmesh needs placed items to size it (or give items in the same call).";
    const lo = [0, 1, 2].map((k) => Math.min(...blocks.map((b) => b.center[k]! - b.size[k]! / 2)) - (k === 1 ? 1 : 2));
    const hi = [0, 1, 2].map((k) => Math.max(...blocks.map((b) => b.center[k]! + b.size[k]! / 2)) + (k === 1 ? 3 : 2));
    plan.navmesh = { min: lo.map(r3) as [number, number, number], max: hi.map(r3) as [number, number, number] };
  }
  return plan;
}

const fmt = (v: number[]) => `[${v.join(", ")}]`;

/**
 * What a block-out adds, for the approval card.
 *
 * @param engine - The engine.
 * @param plan - The checked plan.
 * @param undo - How it can be taken back (one undo step live; queued when the editor is closed).
 * @returns The scene diff (every object added under the parent, the lights, the navmesh).
 */
export function blockoutDiff(engine: SceneEngine, plan: Blockout, undo: SceneDiff["undo"]): SceneDiff {
  const objects: SceneObjectChange[] = [
    ...plan.blocks.map((b): SceneObjectChange => ({ kind: "added", name: `${plan.parent}/${b.name}`, type: b.asset ? b.asset.split("/").pop()! : b.shape, props: [{ name: "position (m)", to: fmt(b.center) }, ...(b.asset ? [] : [{ name: "size (m)", to: fmt(b.size) }]), ...(b.yaw || b.pitch ? [{ name: "rotation", to: `pitch ${b.pitch}°, yaw ${b.yaw}°` }] : [])] })),
    ...plan.lights.map((l): SceneObjectChange => ({ kind: "added", name: `${plan.parent}/${l.name}`, type: `${l.type} light`, props: [{ name: "position (m)", to: fmt(l.center) }, { name: "intensity", to: String(l.intensity) }, { name: "color", to: l.color }] })),
    ...(plan.navmesh ? [{ kind: "added" as const, name: `${plan.parent}/NavMesh`, type: engine === "unreal" ? "NavMeshBoundsVolume" : "NavMeshSurface", props: [{ name: "bounds (m)", to: `${fmt(plan.navmesh.min)} → ${fmt(plan.navmesh.max)}` }] }] : []),
  ];
  return { engine, ...(plan.level ? { scene: plan.level } : {}), objects, undo, readBefore: false };
}

const f = (n: number) => `${r3(n)}f`;
const v3 = (a: number[]) => `new UnityEngine.Vector3(${a.map(f).join(", ")})`;
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

/** Unity primitive and scale for a shape (Unity's cylinder is 2 m high). */
function unityShape(b: PlacedBlock): { prim: string; scale: number[] } {
  if (b.shape === "cylinder") return { prim: "Cylinder", scale: [b.size[0], b.size[1] / 2, b.size[2]] };
  if (b.shape === "sphere") return { prim: "Sphere", scale: b.size };
  return { prim: "Cube", scale: b.size };
}

/**
 * C# that places a block-out in the open Unity scene as one Undo group: a parent (found or made), each block (a
 * primitive, or a prefab instance), the lights, and a NavMeshSurface (AI Navigation package, found by reflection)
 * that is built at once.
 *
 * @param plan - The checked plan.
 * @returns C# for the Editor (returns a summary line).
 */
export function unityBlockoutCs(plan: Blockout): string {
  const blocks = plan.blocks.map((b) => {
    const make = b.asset
      ? `{ var src = UnityEditor.AssetDatabase.LoadAssetAtPath<UnityEngine.GameObject>(${csString(b.asset)});
  if (src == null) { missing.Add(${csString(b.asset)}); continue_ = true; } else go = (UnityEngine.GameObject)UnityEditor.PrefabUtility.InstantiatePrefab(src); }`
      : `go = UnityEngine.GameObject.CreatePrimitive(UnityEngine.PrimitiveType.${unityShape(b).prim});`;
    return `{ UnityEngine.GameObject go = null; var continue_ = false;
  ${make}
  if (!continue_) { go.name = ${csString(b.name)}; UnityEditor.Undo.RegisterCreatedObjectUndo(go, "KesherAI: block-out");
  go.transform.SetParent(root.transform, false);
  go.transform.localPosition = ${v3(b.center)}; go.transform.localRotation = UnityEngine.Quaternion.Euler(${f(-b.pitch)}, ${f(b.yaw)}, 0f);
  ${b.asset ? "" : `go.transform.localScale = ${v3(unityShape(b).scale)}; go.isStatic = true;`} placed++; } }`;
  });
  const lights = plan.lights.map((l) => {
    const [r, g, bl] = rgb(l.color);
    return `{ var go = new UnityEngine.GameObject(${csString(l.name)}); UnityEditor.Undo.RegisterCreatedObjectUndo(go, "KesherAI: light");
  go.transform.SetParent(root.transform, false); go.transform.localPosition = ${v3(l.center)};
  go.transform.localRotation = UnityEngine.Quaternion.Euler(${f(l.pitch)}, ${f(l.yaw)}, 0f);
  var li = go.AddComponent<UnityEngine.Light>(); li.type = UnityEngine.LightType.${l.type === "directional" ? "Directional" : l.type === "spot" ? "Spot" : "Point"};
  li.intensity = ${f(l.intensity)}; li.color = new UnityEngine.Color(${f(r!)}, ${f(g!)}, ${f(bl!)}); li.shadows = UnityEngine.LightShadows.Soft; lit++; }`;
  });
  const nav = plan.navmesh
    ? `var navType = System.Type.GetType("Unity.AI.Navigation.NavMeshSurface, Unity.AI.Navigation");
if (navType == null) nav = "no navmesh: install the AI Navigation package (com.unity.ai.navigation), then run again with navmesh true";
else { var surf = root.GetComponent(navType) ?? UnityEditor.Undo.AddComponent(root, navType);
  navType.GetMethod("BuildNavMesh")?.Invoke(surf, null); nav = "NavMeshSurface on " + root.name + " built"; }`
    : "";
  return `UnityEditor.Undo.IncrementCurrentGroup(); var group = UnityEditor.Undo.GetCurrentGroup(); UnityEditor.Undo.SetCurrentGroupName("KesherAI: block-out");
var root = UnityEngine.GameObject.Find(${csString(plan.parent)});
if (root == null) { root = new UnityEngine.GameObject(${csString(plan.parent)}); UnityEditor.Undo.RegisterCreatedObjectUndo(root, "KesherAI: block-out"); }
var placed = 0; var lit = 0; var nav = ""; var missing = new System.Collections.Generic.List<string>();
${blocks.join("\n")}
${lights.join("\n")}
${nav}
UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(root.scene);
UnityEditor.Undo.CollapseUndoOperations(group);
UnityEditor.Selection.activeGameObject = root;
return "Placed " + placed + " objects and " + lit + " lights under " + root.name + (nav != "" ? "; " + nav : "") + (missing.Count > 0 ? "; prefabs not found: " + string.Join(", ", missing) : "") + " (one Undo step in Unity; not saved yet: unity_scene save).";`;
}

/** One actor for the bridge's `level_spawn` (Unreal units: cm, X forward, Y right, Z up). */
export interface SpawnActor {
  op: "spawn";
  name: string;
  /** A basic shape (/Engine/BasicShapes/…), a static mesh or a Blueprint class; or a class for lights and volumes. */
  mesh?: string;
  asset?: string;
  class?: string;
  folder: string;
  location: [number, number, number];
  /** Pitch, yaw, roll in degrees. */
  rotation: [number, number, number];
  scale: [number, number, number];
  intensity?: number;
  color?: string;
}

const UE_SHAPES: Partial<Record<BlockShape, string>> = { cylinder: "/Engine/BasicShapes/Cylinder.Cylinder", sphere: "/Engine/BasicShapes/Sphere.Sphere" };
/** Grid meters (x right, y up, z forward) → Unreal cm (X forward = z, Y right = x, Z up = y). */
const ue = (p: number[]): [number, number, number] => [r3(p[2]! * 100), r3(p[0]! * 100), r3(p[1]! * 100)];

/**
 * A block-out as the bridge's `level_spawn` actors: static mesh actors with the engine's basic shapes (100 cm, so the
 * scale is the size in meters), Blueprints or meshes by path, lights, and a NavMeshBoundsVolume.
 *
 * @param plan - The checked plan.
 * @returns The actors, in order.
 */
export function unrealSpawnActors(plan: Blockout): SpawnActor[] {
  const folder = plan.parent;
  const out: SpawnActor[] = plan.blocks.map((b) => ({
    op: "spawn",
    name: b.name,
    ...(b.asset ? { asset: b.asset } : { mesh: UE_SHAPES[b.shape] ?? "/Engine/BasicShapes/Cube.Cube" }),
    folder,
    location: ue(b.center),
    rotation: [b.pitch, b.yaw, 0],
    scale: b.asset ? [1, 1, 1] : [b.size[2], b.size[0], b.size[1]],
  }));
  for (const l of plan.lights)
    out.push({ op: "spawn", name: l.name, class: l.type === "directional" ? "/Script/Engine.DirectionalLight" : l.type === "spot" ? "/Script/Engine.SpotLight" : "/Script/Engine.PointLight", folder, location: ue(l.center), rotation: [-l.pitch, l.yaw, 0], scale: [1, 1, 1], intensity: l.intensity, color: l.color });
  if (plan.navmesh) {
    const { min, max } = plan.navmesh;
    const mid = [0, 1, 2].map((k) => (min[k]! + max[k]!) / 2);
    const size = [0, 1, 2].map((k) => max[k]! - min[k]!);
    // The volume's brush is 200 cm across: its scale is half the size in meters.
    out.push({ op: "spawn", name: "NavMeshBounds", class: "/Script/NavigationSystem.NavMeshBoundsVolume", folder, location: ue(mid), rotation: [0, 0, 0], scale: [r3(size[2]! / 2), r3(size[0]! / 2), r3(size[1]! / 2)] });
  }
  return out;
}

/** The effect presets: a starting point the description's numbers change. */
export const VFX_PRESETS = {
  fire: { rate: 60, lifetime: 1.2, speed: 1.5, size: 0.5, color: "#ffb030", colorEnd: "#ff3000", gravity: -0.2, looping: true, duration: 5, max: 300, shape: "cone" },
  smoke: { rate: 20, lifetime: 4, speed: 0.6, size: 1.2, color: "#808080", colorEnd: "#303030", gravity: -0.05, looping: true, duration: 5, max: 200, shape: "cone" },
  sparks: { rate: 40, lifetime: 0.6, speed: 6, size: 0.06, color: "#ffe080", colorEnd: "#ff6000", gravity: 1, looping: true, duration: 2, max: 200, shape: "cone" },
  magic: { rate: 30, lifetime: 1.5, speed: 0.8, size: 0.15, color: "#80a0ff", colorEnd: "#d040ff", gravity: -0.1, looping: true, duration: 5, max: 200, shape: "sphere" },
  rain: { rate: 400, lifetime: 1.5, speed: 12, size: 0.04, color: "#a0c0e0", colorEnd: "#a0c0e0", gravity: 1, looping: true, duration: 5, max: 500, shape: "box" },
  dust: { rate: 10, lifetime: 6, speed: 0.1, size: 0.08, color: "#d8c8a8", colorEnd: "#d8c8a8", gravity: 0, looping: true, duration: 10, max: 100, shape: "box" },
  explosion: { rate: 0, lifetime: 0.8, speed: 8, size: 0.6, color: "#fff0a0", colorEnd: "#ff2000", gravity: 0.3, looping: false, duration: 1, max: 150, shape: "sphere", burst: 120 },
  trail: { rate: 50, lifetime: 0.5, speed: 0, size: 0.2, color: "#ffffff", colorEnd: "#40a0ff", gravity: 0, looping: true, duration: 5, max: 100, shape: "edge" },
} as const;
/** One of the {@link VFX_PRESETS}. */
export type VfxPreset = keyof typeof VFX_PRESETS;
const SHAPES = ["cone", "sphere", "box", "edge"] as const;
/** About the most live particles one effect should keep on a phone (the VFX checklist's budget). */
export const PHONE_PARTICLES = 500;

/** A checked effect spec (the numbers after the preset and the overrides). */
export interface VfxSpec {
  name: string;
  preset: VfxPreset;
  rate: number;
  lifetime: number;
  speed: number;
  size: number;
  color: string;
  colorEnd: string;
  gravity: number;
  looping: boolean;
  duration: number;
  max: number;
  shape: (typeof SHAPES)[number];
  burst?: number;
  position?: [number, number, number];
  attachTo?: string;
}

/** The numbers an input may set, with their limits. */
const LIMITS: Record<string, [number, number]> = { rate: [0, 5000], lifetime: [0.05, 60], speed: [0, 200], size: [0.005, 50], gravity: [-10, 10], duration: [0.1, 120], max: [1, 20000], burst: [0, 5000] };

/**
 * Checks an effect request: a preset, then the numbers the input gives (`color_end` as `colorEnd`).
 *
 * @param input - The tool's input (`name`, `preset`, numbers, `color`, `color_end`, `looping`, `shape`, `position`,
 *   `attach_to`).
 * @param only - Tuning: only the numbers the input gives are returned (no preset).
 * @returns The spec (for tuning: just the given fields), or what is wrong in words.
 */
export function parseVfx(input: Record<string, unknown>, only = false): VfxSpec | Partial<VfxSpec> | string {
  const preset = (Object.keys(VFX_PRESETS) as VfxPreset[]).find((p) => p === input.preset);
  if (!only && !preset) return `preset is one of ${Object.keys(VFX_PRESETS).join(", ")}.`;
  const out: Record<string, unknown> = only ? {} : { ...VFX_PRESETS[preset!], preset, name: NAME(input.name, `FX_${preset}`).replace(/\s+/g, "_") };
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) if (input[k] !== undefined) out[k] = num(input[k], lo, lo, hi);
  for (const [k, key] of [["color", "color"], ["color_end", "colorEnd"]] as const) {
    if (input[k] === undefined) continue;
    if (typeof input[k] !== "string" || !COLOR.test(input[k] as string)) return `${k} is a #rrggbb color.`;
    out[key] = (input[k] as string).toLowerCase();
  }
  if (typeof input.looping === "boolean") out.looping = input.looping;
  if (input.shape !== undefined) {
    const s = SHAPES.find((x) => x === input.shape);
    if (!s) return `shape is one of ${SHAPES.join(", ")}.`;
    out.shape = s;
  }
  if (Array.isArray(input.position)) {
    const p = input.position.map(Number);
    if (p.length !== 3 || !p.every(Number.isFinite)) return "position is [x, y, z] in meters.";
    out.position = p.map(r3);
  }
  if (typeof input.attach_to === "string" && input.attach_to.trim()) out.attachTo = input.attach_to.trim().slice(0, 300);
  if (only && !Object.keys(out).length) return "Give the numbers to change (rate, lifetime, speed, size, color, …).";
  return out as Partial<VfxSpec>;
}

/** A warning when an effect would keep more live particles than a phone should draw. */
export function vfxBudgetNote(s: Pick<VfxSpec, "rate" | "lifetime" | "max"> & { burst?: number }): string {
  const live = Math.min(s.max, Math.max(s.rate * s.lifetime, s.burst ?? 0));
  return live > PHONE_PARTICLES ? ` About ${Math.round(live)} live particles: more than the ~${PHONE_PARTICLES} a phone should draw per effect.` : "";
}

/**
 * What an effect adds or changes, for the approval card.
 *
 * @param engine - The engine.
 * @param spec - The spec (a full one to create, a part to tune).
 * @param target - Tuning: the object or asset tuned.
 * @param undo - How it can be taken back.
 */
export function vfxDiff(engine: SceneEngine, spec: Partial<VfxSpec>, target: string | undefined, undo: SceneDiff["undo"]): SceneDiff {
  const props = Object.entries(spec)
    .filter(([k]) => k !== "name" && k !== "preset")
    .map(([k, v]) => ({ name: k, to: Array.isArray(v) ? fmt(v as number[]) : String(v) }));
  const name = target ?? `${spec.attachTo ? `${spec.attachTo}/` : ""}${spec.name ?? "effect"}`;
  return { engine, objects: [{ kind: target ? "changed" : "added", name, type: engine === "unreal" ? "Niagara System" : "Particle System", ...(spec.preset ? { components: { added: [spec.preset] } } : {}), props }], undo, readBefore: false };
}

/**
 * C# that sets a Particle System from a spec (only the fields given), shared by create and tune.
 *
 * @param s - The spec's fields to set.
 */
function particleSetCs(s: Partial<VfxSpec>): string {
  const lines: string[] = ["var main = ps.main;"];
  if (s.duration !== undefined) lines.push(`main.duration = ${f(s.duration)};`);
  if (s.looping !== undefined) lines.push(`main.loop = ${s.looping};`);
  if (s.lifetime !== undefined) lines.push(`main.startLifetime = ${f(s.lifetime)};`);
  if (s.speed !== undefined) lines.push(`main.startSpeed = ${f(s.speed)};`);
  if (s.size !== undefined) lines.push(`main.startSize = ${f(s.size)};`);
  if (s.gravity !== undefined) lines.push(`main.gravityModifier = ${f(s.gravity)};`);
  if (s.max !== undefined) lines.push(`main.maxParticles = ${Math.round(s.max)};`);
  if (s.color !== undefined) lines.push(`main.startColor = new UnityEngine.Color(${rgb(s.color).map(f).join(", ")});`);
  if (s.rate !== undefined) lines.push(`{ var em = ps.emission; em.rateOverTime = ${f(s.rate)}; }`);
  if (s.burst !== undefined) lines.push(`{ var em = ps.emission; em.SetBursts(new[] { new UnityEngine.ParticleSystem.Burst(0f, (short)${Math.round(s.burst)}) }); }`);
  if (s.shape !== undefined) lines.push(`{ var sh = ps.shape; sh.shapeType = UnityEngine.ParticleSystemShapeType.${{ cone: "Cone", sphere: "Sphere", box: "Box", edge: "SingleSidedEdge" }[s.shape]}; }`);
  if (s.color !== undefined || s.colorEnd !== undefined) {
    const a = s.color ? rgb(s.color) : [1, 1, 1];
    const b = s.colorEnd ? rgb(s.colorEnd) : a;
    lines.push(`{ var col = ps.colorOverLifetime; col.enabled = true; var g = new UnityEngine.Gradient();
  g.SetKeys(new[] { new UnityEngine.GradientColorKey(new UnityEngine.Color(${a.map(f).join(", ")}), 0f), new UnityEngine.GradientColorKey(new UnityEngine.Color(${b.map(f).join(", ")}), 1f) },
    new[] { new UnityEngine.GradientAlphaKey(1f, 0f), new UnityEngine.GradientAlphaKey(1f, 0.7f), new UnityEngine.GradientAlphaKey(0f, 1f) });
  col.color = g; }`);
  }
  return lines.join("\n");
}

/**
 * C# that makes a Particle System GameObject from a spec, as one Undo step: at a position or under an object, with
 * the render pipeline's particle material (URP's Particles Unlit when present, else the built-in default).
 *
 * @param s - The checked spec.
 */
export function unityVfxCs(s: VfxSpec): string {
  return `UnityEngine.Transform parent = null;
${s.attachTo ? `{ var p = UnityEngine.GameObject.Find(${csString(s.attachTo)}); if (p == null) return "No GameObject " + ${csString(s.attachTo)} + " in the open scene; nothing was added."; parent = p.transform; }` : ""}
var go = new UnityEngine.GameObject(${csString(s.name)});
UnityEditor.Undo.RegisterCreatedObjectUndo(go, "KesherAI: effect " + go.name);
if (parent != null) go.transform.SetParent(parent, false);
${s.position ? `go.transform.localPosition = ${v3(s.position)};` : ""}
var ps = go.AddComponent<UnityEngine.ParticleSystem>();
${particleSetCs(s)}
var rend = go.GetComponent<UnityEngine.ParticleSystemRenderer>();
var mat = UnityEditor.AssetDatabase.LoadAssetAtPath<UnityEngine.Material>("Packages/com.unity.render-pipelines.universal/Runtime/Materials/ParticlesUnlit.mat")
  ?? UnityEditor.AssetDatabase.GetBuiltinExtraResource<UnityEngine.Material>("Default-ParticleSystem.mat");
if (mat != null) rend.sharedMaterial = mat;
UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(go.scene);
UnityEditor.Selection.activeGameObject = go;
return "Made the effect " + go.name + " (" + ${csString(s.preset)} + ", Particle System; one Undo step, not saved yet: unity_scene save).";`;
}

/**
 * C# that tunes the Particle System on an object (only the given numbers), as one Undo step.
 *
 * @param target - The object's path or name.
 * @param s - The numbers to change.
 */
export function unityVfxTuneCs(target: string, s: Partial<VfxSpec>): string {
  return `var go = UnityEngine.GameObject.Find(${csString(target)});
if (go == null) return "No GameObject " + ${csString(target)} + " in the open scene.";
var ps = go.GetComponent<UnityEngine.ParticleSystem>();
if (ps == null) return go.name + " has no Particle System.";
UnityEditor.Undo.RecordObject(ps, "KesherAI: tune effect");
${particleSetCs(s)}
UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(go.scene);
return "Tuned " + go.name + " (one Undo step).";`;
}

/** Texture import kinds of `unity_texture_settings`. */
const TEXTURE_KINDS = ["color", "normal", "mask", "sprite"] as const;
const COMPRESS = { none: "Uncompressed", low: "CompressedLQ", normal: "Compressed", high: "CompressedHQ" } as const;

/**
 * C# that sets texture import settings and reimports: the kind (color: sRGB; normal: Normal map; mask: linear, for
 * roughness, metallic and AO), max size and compression.
 *
 * @param paths - Assets/ texture paths.
 * @param o - The settings.
 */
export function textureSettingsCs(paths: string[], o: { kind: (typeof TEXTURE_KINDS)[number]; maxSize: number; compression: keyof typeof COMPRESS; mipmaps: boolean }): string {
  const type = o.kind === "normal" ? "NormalMap" : o.kind === "sprite" ? "Sprite" : "Default";
  return `var paths = new string[] { ${paths.map(csString).join(", ")} }; var log = new System.Text.StringBuilder();
foreach (var path in paths) {
  var ti = UnityEditor.AssetImporter.GetAtPath(path) as UnityEditor.TextureImporter;
  if (ti == null) { log.AppendLine("not a texture: " + path); continue; }
  ti.textureType = UnityEditor.TextureImporterType.${type};
  ti.sRGBTexture = ${o.kind === "color" || o.kind === "sprite"};
  ti.maxTextureSize = ${o.maxSize}; ti.mipmapEnabled = ${o.mipmaps};
  ti.textureCompression = UnityEditor.TextureImporterCompression.${COMPRESS[o.compression]};
  ti.SaveAndReimport(); log.AppendLine("set: " + path);
}
return log.ToString() + "(${o.kind}, max ${o.maxSize}, ${o.compression} compression)";`;
}

/** The queued spec file of a Unity effect made with Unity closed (applied by the bridge's KesherVfx.cs). */
export const unityPendingVfx = (project: string, name: string): string => join(project, "KesherAI", "pending-vfx", `${safeName(name, "FX")}.json`);

/** Unity's answer when the Editor did not run the C# (closed or busy): the effect is queued instead. */
const UNITY_CLOSED = /^Unity did not run it/;

const blockoutSchema = (unreal: boolean) => ({
  type: "object",
  properties: {
    ...(unreal ? { level: { type: "string", description: "/Game/Maps/Arena (unreal_inspect_level lists the levels)." } } : {}),
    cell: { type: "number", description: "Grid cell size in meters (default 2)." },
    parent: { type: "string", description: `The parent ${unreal ? "outliner folder" : "GameObject"} (default Blockout).` },
    items: {
      type: "array",
      description: `Up to ${MAX_ITEMS} things to place.`,
      items: {
        type: "object",
        properties: {
          shape: { type: "string", enum: [...BLOCK_SHAPES] },
          cell: { type: "array", items: { type: "number" }, description: "[x, z]: the first grid cell (x right, z forward)." },
          span: { type: "array", items: { type: "number" }, description: "[w, d] cells (default [1, 1]); a wall runs along the longer one; a ramp rises along d." },
          height: { type: "number", description: "Meters (wall default 3, ramp rise default 1, floor thickness 0.2)." },
          elevation: { type: "number", description: "Meters: its bottom (a floor's top)." },
          yaw: { type: "number", description: "Degrees." },
          name: { type: "string" },
          asset: { type: "string", description: unreal ? "shape prefab: a /Game/… Blueprint or static mesh." : "shape prefab: an Assets/….prefab path." },
        },
        required: ["shape", "cell"],
      },
    },
    lights: {
      type: "array",
      description: "The lighting pass: one directional (sun), a few point or spot lights.",
      items: { type: "object", properties: { type: { type: "string", enum: [...LIGHT_TYPES] }, cell: { type: "array", items: { type: "number" } }, height: { type: "number" }, intensity: { type: "number" }, color: { type: "string", description: "#rrggbb" }, pitch: { type: "number" }, yaw: { type: "number" }, name: { type: "string" } }, required: ["type"] },
    },
    navmesh: { type: "boolean", description: unreal ? "Add a NavMeshBoundsVolume around the items (the navmesh builds)." : "Add a NavMeshSurface and build it (AI Navigation package)." },
  },
});

const vfxProps = {
  preset: { type: "string", enum: Object.keys(VFX_PRESETS) },
  name: { type: "string" },
  rate: { type: "number", description: "Particles per second." },
  lifetime: { type: "number", description: "Seconds." },
  speed: { type: "number", description: "Meters per second." },
  size: { type: "number", description: "Meters." },
  color: { type: "string", description: "#rrggbb at birth." },
  color_end: { type: "string", description: "#rrggbb at death (it fades out)." },
  gravity: { type: "number", description: "1 = falls like a stone, negative rises." },
  looping: { type: "boolean" },
  duration: { type: "number" },
  max: { type: "number", description: "Max live particles." },
  burst: { type: "number", description: "Particles at once at the start." },
  shape: { type: "string", enum: [...SHAPES] },
  position: { type: "array", items: { type: "number" }, description: "[x, y, z] meters." },
};

/**
 * The Unity tools of the specialists: block-out, effects and texture settings.
 *
 * @param d - The project, the "no project" check and C# in the open Editor (unity-tools.ts).
 */
export function unityBuildTools(d: UnityEditDeps): AgentTool[] {
  return [
    {
      risk: "write",
      spec: { name: "unity_blockout", description: "Block out a level in the open Unity scene from a grid plan in one call: floors, walls, ramps, cubes, cylinders, spheres or prefabs on grid cells, a lighting pass, and a NavMeshSurface built at once; one Undo step, under one parent. The user sees every object added before it runs.", inputSchema: blockoutSchema(false) },
      askFirst: () => "Adds objects to the open Unity scene.",
      preview: async (input) => {
        const plan = parseBlockout(input, "unity");
        return typeof plan === "string" ? plan : scenePreview(blockoutDiff("unity", plan, "undo"));
      },
      run: async (input) => {
        d.need();
        const plan = parseBlockout(input, "unity");
        if (typeof plan === "string") return { output: plan };
        return { output: await d.evalCs(unityBlockoutCs(plan)) };
      },
    },
    {
      risk: "write",
      spec: {
        name: "unity_vfx",
        description: `Make or tune a particle effect in the open Unity scene (Particle System). create: a preset and the numbers that differ, at a position or under an object (attach_to); with Unity closed the spec is written to KesherAI/pending-vfx/ and the KesherAI Bridge makes it when Unity opens. tune: only the numbers to change on an existing effect (target). Keep under ~${PHONE_PARTICLES} live particles for phones.`,
        inputSchema: { type: "object", properties: { action: { type: "string", enum: ["create", "tune"] }, target: { type: "string", description: "tune: the effect's GameObject path." }, attach_to: { type: "string", description: "create: a parent GameObject path." }, ...vfxProps }, required: ["action"] },
      },
      preview: async (input) => {
        const tune = input.action === "tune";
        const s = parseVfx(input, tune);
        return typeof s === "string" ? s : scenePreview(vfxDiff("unity", s, tune ? String(input.target ?? "") : undefined, "undo"));
      },
      run: async (input) => {
        d.need();
        const tune = input.action === "tune";
        const s = parseVfx(input, tune);
        if (typeof s === "string") return { output: s };
        if (tune) {
          const target = typeof input.target === "string" ? input.target.trim() : "";
          if (!target) return { output: "target is the effect's GameObject path." };
          return { output: await d.evalCs(unityVfxTuneCs(target, s)) };
        }
        const spec = s as VfxSpec;
        const said = await d.evalCs(unityVfxCs(spec));
        const project = d.project();
        if (UNITY_CLOSED.test(said) && project) {
          const file = unityPendingVfx(project, spec.name);
          await mkdir(join(project, "KesherAI", "pending-vfx"), { recursive: true });
          await writeFile(file, JSON.stringify({ ...spec, queuedAt: new Date().toISOString() }, null, 2));
          return { output: `Unity is not open, so the spec is queued in KesherAI/pending-vfx/: the KesherAI Bridge makes ${spec.name} when Unity opens.${vfxBudgetNote(spec)}` };
        }
        return { output: said + vfxBudgetNote(spec) };
      },
    },
    {
      risk: "write",
      spec: {
        name: "unity_texture_settings",
        description: "Set texture import settings and reimport: kind color (sRGB, albedo), normal (Normal map), mask (linear: roughness, metallic, AO) or sprite; max size (phones: 1024 or 2048); compression; mipmaps.",
        inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" }, description: "Assets/ texture paths (up to 20)." }, kind: { type: "string", enum: [...TEXTURE_KINDS] }, max_size: { type: "number" }, compression: { type: "string", enum: Object.keys(COMPRESS) }, mipmaps: { type: "boolean" } }, required: ["paths", "kind"] },
      },
      preview: async (input) => `Texture import settings (${String(input.kind)}) for:\n${(Array.isArray(input.paths) ? input.paths : []).slice(0, 20).map((p) => `  ${String(p)}`).join("\n")}`,
      run: async (input) => {
        d.need();
        const paths = (Array.isArray(input.paths) ? input.paths : []).map(String).filter((p) => ASSET_PATH.test(p) && p.startsWith("Assets/")).slice(0, 20);
        const kind = TEXTURE_KINDS.find((k) => k === input.kind);
        if (!paths.length || !kind) return { output: `paths are Assets/ texture paths; kind is one of ${TEXTURE_KINDS.join(", ")}.` };
        const size = [256, 512, 1024, 2048, 4096].find((n) => n >= num(input.max_size, 2048, 32, 8192)) ?? 4096;
        const compression = (Object.keys(COMPRESS) as Array<keyof typeof COMPRESS>).find((k) => k === input.compression) ?? "normal";
        return { output: await d.evalCs(textureSettingsCs(paths, { kind, maxSize: size, compression, mipmaps: input.mipmaps !== false && kind !== "sprite" })) };
      },
    },
  ];
}

/** Each preset's Niagara template (by asset name under /Niagara; the bridge finds it in the asset registry). */
export const NIAGARA_TEMPLATES: Record<VfxPreset, string> = { fire: "Fountain", smoke: "BlowingParticles", sparks: "DirectionalBurst", magic: "HangingParticulates", rain: "BlowingParticles", dust: "HangingParticulates", explosion: "OmnidirectionalBurst", trail: "Fountain" };

/** What the Unreal tools need: the KesherAI Bridge. */
export interface UnrealBuildDeps {
  bridge?: UnrealBridge;
}

/**
 * The Unreal tools of the specialists: block-out (`level_spawn`) and Niagara effects (`vfx_create`) through the
 * KesherAI Bridge; with Unreal closed both go into the bridge's offline queue (a checkpoint of the level first).
 *
 * @param d - The bridge.
 */
export function unrealBuildTools(d: UnrealBuildDeps): AgentTool[] {
  const live = () => !!d.bridge?.connected;
  const noBridge = "The KesherAI Bridge plugin is not set up for this project: open the project in Unreal once with it (the Unreal page installs it).";
  return [
    {
      risk: "write",
      spec: { name: "unreal_blockout", description: "Block out a level in Unreal from a grid plan in one call: floors, walls, ramps and shapes (the engine's basic shapes) or Blueprints / meshes on grid cells, a lighting pass, and a NavMeshBoundsVolume; one undo step in the open editor, or queued and applied by a headless Unreal (the level saved, a checkpoint first) when it is closed. The user sees every actor added before it runs.", inputSchema: blockoutSchema(true) },
      askFirst: () => "Adds actors to an Unreal level.",
      preview: async (input) => {
        const plan = parseBlockout(input, "unreal");
        return typeof plan === "string" ? plan : scenePreview(blockoutDiff("unreal", plan, live() ? "undo" : "queued"));
      },
      run: async (input) => {
        const plan = parseBlockout(input, "unreal");
        if (typeof plan === "string") return { output: plan };
        const b = d.bridge;
        if (!b?.available) return { output: noBridge };
        const actors = unrealSpawnActors(plan);
        if (live()) {
          const r = await b.request<{ spawned: number; missing?: string[] }>("level_spawn", { path: plan.level, actors }, 120_000);
          return { output: `Placed ${r.spawned} actors in ${plan.level} (folder ${plan.parent}; one undo step; not saved yet: save the level in Unreal).${r.missing?.length ? ` Not found: ${r.missing.join(", ")}.` : ""}` };
        }
        const project = await b.project();
        if (!project) return { output: "KesherAI does not know the project yet: open it once in Unreal with the KesherAI Bridge plugin." };
        await b.enqueue({ project, path: plan.level!, graph: "", kind: "spawn", ops: actors, request: `Block-out: ${actors.length} actors`, baseAt: new Date().toISOString() });
        b.scheduleSync();
        return { output: `Queued ${actors.length} actors for ${plan.level}: Unreal is closed, so a headless Unreal places them in a few seconds and saves the level (a checkpoint of the level first).` };
      },
    },
    {
      risk: "write",
      spec: {
        name: "unreal_vfx",
        description: `Make a Niagara effect from a preset: a copy of the engine's matching template (or of template, a system you name) saved as /Game/KesherVFX/NS_<name>, optionally placed in a level at a position. The spec's numbers go with it: tune them in the Niagara toolset of Unreal's MCP server (user parameters) when it is connected, or tell the user which to set. With Unreal closed it is queued. Keep under ~${PHONE_PARTICLES} live particles for phones.`,
        inputSchema: { type: "object", properties: { level: { type: "string", description: "Optional: place it in this level (/Game/Maps/…)." }, template: { type: "string", description: "Optional: a Niagara system to copy (/Game/… or /Niagara/…)." }, ...vfxProps }, required: ["preset"] },
      },
      preview: async (input) => {
        const s = parseVfx(input);
        return typeof s === "string" ? s : scenePreview(vfxDiff("unreal", s, undefined, live() ? "undo" : "queued"));
      },
      run: async (input) => {
        const s = parseVfx(input);
        if (typeof s === "string") return { output: s };
        const spec = s as VfxSpec;
        const b = d.bridge;
        if (!b?.available) return { output: noBridge };
        const template = typeof input.template === "string" && /^\/(Game|Niagara)\/(?!(.*\/)?\.\.(\/|$))[\w/ .-]{1,300}$/.test(input.template.trim()) ? input.template.trim() : NIAGARA_TEMPLATES[spec.preset];
        const level = typeof input.level === "string" && /^\/Game\/(?!(.*\/)?\.\.(\/|$))[\w/ .-]{1,300}$/.test(input.level.trim()) ? input.level.trim() : undefined;
        const path = `/Game/KesherVFX/NS_${spec.name.replace(/[^\w]/g, "_").replace(/^NS_/, "")}`;
        const args = { op: "vfx", preset: spec.preset, template, spec, ...(level ? { level } : {}), ...(spec.position ? { location: ue(spec.position) } : {}) };
        if (live()) {
          const r = await b.request<{ asset: string; placed?: string; template: string }>("vfx_create", { ...args, path }, 120_000);
          return { output: `Made ${r.asset} from ${r.template}${r.placed ? `, placed as ${r.placed}` : ""} (not saved yet). Tune: rate ${spec.rate}/s, lifetime ${spec.lifetime} s, speed ${spec.speed} m/s, size ${spec.size} m, ${spec.color} → ${spec.colorEnd}.${vfxBudgetNote(spec)}` };
        }
        const project = await b.project();
        if (!project) return { output: "KesherAI does not know the project yet: open it once in Unreal with the KesherAI Bridge plugin." };
        await b.enqueue({ project, path, graph: "", kind: "vfx", ops: [args], request: `Effect: ${spec.name} (${spec.preset})`, baseAt: new Date().toISOString() });
        b.scheduleSync();
        return { output: `Queued ${path}: Unreal is closed, so a headless Unreal makes it in a few seconds.${vfxBudgetNote(spec)}` };
      },
    },
  ];
}
