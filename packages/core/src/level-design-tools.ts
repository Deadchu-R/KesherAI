/**
 * The level-design agent's chat tools (WORK_LIST "Specialised engine agents": level design), for Unity scenes and
 * Unreal levels, with the engine open or closed:
 * - `level_describe`: a compact text map (objects by area, bounds, counts by type, free space);
 * - `level_arrange`: N copies of an object along a line, on a grid, on a circle or scattered, inside bounds, with
 *   spacing and rotation jitter, standing on the ground when it is known;
 * - `level_move`: move, turn and scale named objects;
 * - `level_check`: overlaps, objects outside the bounds, floating objects.
 * Changes are pending moves, approved in one card with a top-down before/after plan (shared/scene-diff.ts), and kept in
 * the turn's checkpoint (chat-tools-games.ts `engineWrites`). Unity: only KesherAI/pending-moves.json, which the Unity
 * package applies with Undo (the .unity YAML is never written here). Unreal: the KesherAI Bridge (one undo step in the
 * open editor; a headless Unreal when it is closed); .umap/.uasset are never written here.
 *
 * The maths is in level-design.ts. Positions are meters, x right, y up, z forward in both engines (Unreal's
 * centimeters and X-forward are converted at the edge), the same grid as unity_blockout / unreal_blockout.
 */
import { join } from "node:path";
import type { AgentTool } from "@kesher/agent";
import { scenePreview, type SceneDiff, type SceneObjectChange, type ScenePlan, type SceneUndo } from "@kesher/shared";
import type { SpawnActor } from "./engine-build-tools.js";
import { arrangePoints, baseName, checkLevel, describeLevel, footprint, groundHeight, MAX_COPIES, PATTERNS, type Box, type LevelObject, type Pattern, type Placement, type Vec3 } from "./level-design.js";
import type { UnityObject } from "./unity-scene.js";
import { worldPlaces } from "./unity-scene.js";
import { levelsOnDisk, quatToRotator, type LevelActor, type LevelRead } from "./unreal-level-tools.js";
import type { UnrealBridge } from "./unreal-bridge.js";

/** Most objects one call changes (the card lists them; a bigger change is several calls). */
export const MAX_EDITS = 300;
/** Where spawned copies go in the Outliner. */
const FOLDER = "KesherLevel";
const LEVEL_PATH = /^\/Game\/(?!(.*\/)?\.\.(\/|$))[\w/ .-]{1,300}$/;
const ASSET_PATH = /^\/(Game|Engine)\/(?!(.*\/)?\.\.(\/|$))[\w/ .-]{1,300}$/;
const UNITY_SCENE = /^(Assets|Packages)\/.+\.unity$/i;
const GROUND_NAME = /(^|[^a-z])(ground|floor|terrain|landscape)([^a-z]|$)/i;
const NOT_SOLID_CLASS = /Light|Camera|Volume|PlayerStart|Sky|Fog|Atmosphere|Cloud|Note|Target|Brush|Info|Manager|Controller|Emitter|Niagara|Sound|Audio|Trigger/i;

const r2 = (n: number) => Math.round(n * 100) / 100 || 0;

/** What the tools need from the engines (injectable for tests). */
export interface LevelDesignDeps {
  /** The Unity project in use. */
  unityProject: () => string | undefined;
  /** The Unreal project folder in use. */
  unrealProjectDir: () => string | undefined;
  /** The KesherAI Bridge (the same one unreal_inspect_level uses). */
  bridge?: Pick<UnrealBridge, "connected" | "available" | "keptStandIn" | "standIn" | "moveActors" | "request" | "enqueue" | "project" | "scheduleSync">;
  /** Reading a Unity scene (the stand-in's reader, wired in server/build-conversations.ts: it lives with the routes). */
  readUnity?: (project: string, scene: string) => Promise<{ objects: UnityObject[] }>;
  /** A project's Unity scenes (the stand-in's list). */
  unityScenes?: (project: string) => Promise<string[]>;
  /** Queueing Unity moves (KesherAI/pending-moves.json, applied by the Unity package with Undo). */
  queueUnity?: (project: string, scene: string, moves: UnityMoveOut[]) => Promise<{ queued: number; waiting: number }>;
  /** An Unreal project's levels (default: the .umap files on disk). */
  unrealLevels?: (dir: string) => Promise<string[]>;
}

/** A move as the Unity package's pending-moves.json holds it. */
export interface UnityMoveOut {
  id: string;
  name: string;
  from: { position: number[]; rotation: number[]; scale: number[] };
  to: { position: number[]; rotation: number[]; scale: number[] };
}

/** One level read in, engine-neutral, with what writing back needs. */
export interface LoadedLevel {
  engine: "unity" | "unreal";
  /** "Assets/….unity" or "/Game/…". */
  scene: string;
  objects: LevelObject[];
  /** Unity: the scene's objects by id. */
  unity?: Map<string, UnityObject>;
  /** Unreal: the actors by id. */
  actors?: Map<string, LevelActor>;
  /** Unreal: read from the open editor. */
  live?: boolean;
}

/** An object's new place. */
export interface Edit {
  object: LevelObject;
  pos: Vec3;
  /** Turn about the up axis to add, degrees. */
  yawDelta: number;
  /** Multiplier of the scale. */
  scaleMul: number;
}

/** What a call will do, before anyone agrees to it. */
export interface LevelPlan {
  edits: Edit[];
  /** New objects (Unreal only), ready for the bridge. */
  spawns: SpawnActor[];
  /** Plain sentences: what was adjusted, skipped or could not be done. */
  notes: string[];
}

// ---- reading a level as engine-neutral objects ---------------------------------------------------------------------

/**
 * A Unity scene's objects as level objects (world places; UI, inactive objects and the insides of placed prefabs are
 * not placed things).
 *
 * @param objects - The scene's objects.
 */
export function unityLevelObjects(objects: readonly UnityObject[]): LevelObject[] {
  const world = worldPlaces(objects);
  const out: LevelObject[] = [];
  for (const o of objects) {
    if (o.active === false || o.ui) continue;
    const w = world.get(o.id)!;
    const builtin = o.look && "builtin" in o.look ? o.look.builtin : undefined;
    const comps = o.components ?? [];
    const type = builtin ? builtin[0]!.toUpperCase() + builtin.slice(1) : o.prefab ? "Prefab" : o.model ? "Model" : comps.includes("Light") ? "Light" : comps.includes("Camera") ? "Camera" : comps.some((c) => /Renderer$|MeshFilter/.test(c)) ? "Mesh" : "Empty";
    const base: Vec3 = builtin === "plane" ? [10, 0, 10] : builtin === "quad" ? [1, 1, 0.01] : builtin === "cylinder" || builtin === "capsule" ? [1, 2, 1] : [1, 1, 1];
    const size: Vec3 = [Math.abs(base[0] * w.scale[0]), Math.abs(base[1] * w.scale[1]), Math.abs(base[2] * w.scale[2])];
    const solid = !o.readOnly && !!(o.look || o.model || o.prefab || comps.some((c) => /Renderer$|Collider$|MeshFilter/.test(c)));
    out.push({
      id: o.id,
      name: o.name,
      type,
      pos: [r2(w.position[0]), r2(w.position[1]), r2(w.position[2])],
      size,
      yaw: r2(w.yaw),
      ...(solid && (builtin === "plane" || GROUND_NAME.test(o.name)) ? { ground: true } : {}),
      solid,
      movable: o.parent === "0" && !o.readOnly,
      ...(o.parent !== "0" ? { parent: o.parent } : {}),
    });
  }
  return out;
}

/** Unreal's centimeters (X forward, Y right, Z up) as the neutral grid's meters (x right, y up, z forward). */
const fromUnreal = (p: number[]): Vec3 => [r2((p[1] ?? 0) / 100), r2((p[2] ?? 0) / 100), r2((p[0] ?? 0) / 100)];
/** The neutral grid's meters as Unreal's centimeters. */
const toUnreal = (p: Vec3): [number, number, number] => [r2(p[2] * 100), r2(p[0] * 100), r2(p[1] * 100)];

/**
 * An Unreal level's actors as level objects. Actors without a place (read from the .umap header only) are left out.
 *
 * @param actors - The bridge's actors.
 */
export function unrealLevelObjects(actors: readonly LevelActor[]): LevelObject[] {
  const out: LevelObject[] = [];
  for (const a of actors) {
    if (!a.position) continue;
    const s = a.scale ?? [1, 1, 1];
    const solid = !NOT_SOLID_CLASS.test(a.class) && (!!a.mesh || /StaticMeshActor|SkeletalMeshActor|Landscape|_C$/.test(a.class));
    out.push({
      id: a.id,
      name: a.name,
      type: a.class,
      pos: fromUnreal(a.position),
      size: [Math.abs(s[1] ?? 1), Math.abs(s[2] ?? 1), Math.abs(s[0] ?? 1)],
      yaw: a.rotation ? quatToRotator(a.rotation)[1]! : 0,
      ...(solid && (/Landscape/.test(a.class) || GROUND_NAME.test(`${a.name} ${a.mesh ?? ""}`)) ? { ground: true } : {}),
      solid,
      movable: !a.parent,
      ...(a.parent ? { parent: a.parent } : {}),
    });
  }
  return out;
}

// ---- planning ----------------------------------------------------------------------------------------------------

/**
 * Finds objects by name: the exact id or name, else the same name without its number ("Crate" finds "Crate (1)",
 * "Crate_2"…), case-insensitive.
 *
 * @param objects - The level's objects.
 * @param key - What the user or model called it.
 */
export function findObjects(objects: readonly LevelObject[], key: string): LevelObject[] {
  const k = key.trim().toLowerCase();
  if (!k) return [];
  const byId = objects.filter((o) => o.id === key.trim());
  return byId.length ? byId : objects.filter((o) => o.name.toLowerCase() === k || baseName(o.name).toLowerCase() === k);
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
const pair = (v: unknown): [number, number] | undefined => (Array.isArray(v) && v.length === 2 && v.every((n) => num(n) !== undefined) ? [num(v[0])!, num(v[1])!] : undefined);
const triple = (v: unknown): Vec3 | undefined => (Array.isArray(v) && v.length === 3 && v.every((n) => num(n) !== undefined) ? [num(v[0])!, num(v[1])!, num(v[2])!] : undefined);
const boxOf = (v: unknown): Box | undefined => {
  const b = (v ?? {}) as Record<string, unknown>;
  const min = pair(b.min), max = pair(b.max);
  return min && max && max[0] > min[0] && max[1] > min[1] ? { min, max } : undefined;
};

/** The source asset of copies to spawn: a path under /Game or /Engine. */
function spawnSource(source: string, actor: LevelActor | undefined, asset: string): { mesh?: string; asset?: string } | undefined {
  const path = asset || (ASSET_PATH.test(source) ? source : "") || actor?.mesh || "";
  if (!ASSET_PATH.test(path)) return undefined;
  return /^\/Engine\/BasicShapes\//.test(path) ? { mesh: path } : { asset: path };
}

/**
 * Plans `level_arrange`: the existing objects named by `source` move into the pattern (so does every copy there is),
 * and in Unreal the copies still missing are spawned from the source's mesh or an asset path.
 *
 * @param level - The level, read.
 * @param input - The tool's input.
 * @returns The plan, or a sentence saying what is wrong with the input.
 */
export function planArrange(level: LoadedLevel, input: Record<string, unknown>): LevelPlan | string {
  const source = String(input.source ?? "").trim();
  if (!source) return "source is the name of an object that is already in the level (\"Crate\" finds Crate (1), Crate (2)…)" + (level.engine === "unreal" ? ", or an asset path (/Game/…/SM_Crate) to place new copies." : ".");
  const count = Math.round(num(input.count) ?? 0);
  if (count < 1 || count > MAX_COPIES) return `count is how many copies, 1 to ${MAX_COPIES}.`;
  const pattern = (PATTERNS as readonly string[]).includes(String(input.pattern)) ? (input.pattern as Pattern) : "grid";
  const bounds = boxOf(input.bounds);
  if (input.bounds !== undefined && !bounds) return "bounds is { min: [x, z], max: [x, z] } in meters, with max bigger than min.";
  const isAsset = ASSET_PATH.test(source);
  const matches = isAsset ? [] : findObjects(level.objects, source).filter((o) => o.movable);
  const notes: string[] = [];
  const lonely = !isAsset && !findObjects(level.objects, source).length;
  if (lonely) return `No object named "${source}" in ${level.scene}. level_describe lists what is there.`;
  if (!isAsset && !matches.length) return `"${source}" is part of something else (a UI element, a child of another object, or inside a placed prefab): move its parent instead.`;
  const first = matches[0];
  const ground = groundHeight(level.objects, new Set(matches.map((m) => m.id)));
  const size: [number, number] = first ? [first.size[0], first.size[2]] : [num(input.width) ?? 1, num(input.depth) ?? 1];
  const here = first ? ground(first.pos[0], first.pos[2]) : undefined;
  const lift = input.snap_to_ground === false ? 0 : first ? Math.max(0, first.pos[1] - (here ?? 0)) : 0;
  const centroid: [number, number] | undefined = matches.length ? [matches.reduce((s, m) => s + m.pos[0], 0) / matches.length, matches.reduce((s, m) => s + m.pos[2], 0) / matches.length] : undefined;
  const yawGiven = num(input.yaw) !== undefined || num(input.yaw_jitter) !== undefined;
  const groundY = num(input.ground_y);
  const arranged = arrangePoints({
    pattern,
    count,
    size,
    ...(bounds ? { bounds } : {}),
    ...(pair(input.center) ?? centroid ? { center: (pair(input.center) ?? centroid)! } : {}),
    ...(pair(input.from) ? { from: pair(input.from)! } : {}),
    ...(pair(input.to) ? { to: pair(input.to)! } : {}),
    ...(num(input.columns) !== undefined ? { columns: num(input.columns)! } : {}),
    ...(num(input.spacing) !== undefined ? { spacing: num(input.spacing)! } : {}),
    ...(num(input.radius) !== undefined ? { radius: num(input.radius)! } : {}),
    ...(num(input.start_angle) !== undefined ? { startAngle: num(input.start_angle)! } : {}),
    ...(num(input.yaw) !== undefined ? { yaw: num(input.yaw)! } : {}),
    ...(num(input.yaw_jitter) !== undefined ? { yawJitter: num(input.yaw_jitter)! } : {}),
    ...(num(input.pos_jitter) !== undefined ? { posJitter: num(input.pos_jitter)! } : {}),
    ...(num(input.scale_jitter) !== undefined ? { scaleJitter: num(input.scale_jitter)! } : {}),
    seed: num(input.seed) ?? 1,
    avoid: level.objects.filter((o) => o.solid && !o.ground && !matches.includes(o)).map(footprint),
    y: groundY ?? first?.pos[1] ?? 0,
    ...(input.snap_to_ground === false ? {} : { ground: groundY !== undefined ? () => groundY : ground }),
    lift,
  });
  notes.push(...arranged.notes);
  const edits: Edit[] = [];
  const placed = arranged.placements;
  placed.slice(0, matches.length).forEach((p: Placement, i) => {
    const o = matches[i]!;
    edits.push({ object: o, pos: p.pos, yawDelta: yawGiven ? r2(p.yaw - o.yaw) : 0, scaleMul: p.scale });
  });
  const rest = placed.slice(matches.length);
  const spawns: SpawnActor[] = [];
  if (rest.length) {
    const actor = first && level.actors?.get(first.id);
    const src = level.engine === "unreal" ? spawnSource(source, actor, String(input.asset ?? "").trim()) : undefined;
    if (src) {
      const scale = actor?.scale ?? [1, 1, 1];
      rest.forEach((p, i) => spawns.push({ op: "spawn", name: `${isAsset ? baseName(source.split("/").pop()!.split(".")[0]!) : baseName(source)}_${i + 1}`, ...src, folder: FOLDER, location: toUnreal(p.pos), rotation: [0, p.yaw, 0], scale: scale.map((x) => r2(x * p.scale)) as [number, number, number] }));
    } else {
      notes.push(level.engine === "unity"
        ? `${rest.length} more copies are needed: only the ${matches.length} object(s) named "${source}" that are already in the scene can be placed from here. Make the others with unity_blockout (a prefab, Unity open) or duplicate them in Unity, then arrange again.`
        : `${rest.length} more copies are needed but there is no mesh to copy: give asset (a /Game/… static mesh or Blueprint).`);
    }
  }
  if (matches.length > placed.length && placed.length) notes.push(`${matches.length - placed.length} more object(s) named "${source}" were left where they are.`);
  return { edits, spawns, notes };
}

/**
 * Plans `level_move`: the named objects' new places, turns and scales.
 *
 * @param level - The level, read.
 * @param input - The tool's input (`objects`).
 * @returns The plan, or a sentence saying what is wrong with the input.
 */
export function planMove(level: LoadedLevel, input: Record<string, unknown>): LevelPlan | string {
  const list = Array.isArray(input.objects) ? input.objects.slice(0, MAX_EDITS) : [];
  if (!list.length) return "objects is a list of { name, position?: [x, y, z], offset?: [dx, dy, dz], rotate?: degrees about the up axis, scale?: a multiplier } (meters; x right, y up, z forward).";
  const edits: Edit[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const m = (raw ?? {}) as Record<string, unknown>;
    const name = String(m.name ?? "").trim();
    const found = findObjects(level.objects, name);
    if (!found.length) { notes.push(`No object named "${name}".`); continue; }
    const pos = triple(m.position), off = triple(m.offset), rot = num(m.rotate), sc = num(m.scale);
    if (!pos && !off && rot === undefined && sc === undefined) { notes.push(`"${name}": nothing to change (give position, offset, rotate or scale).`); continue; }
    if (sc !== undefined && sc <= 0) { notes.push(`"${name}": scale is a multiplier above 0.`); continue; }
    if (found.length > 1 && (pos || m.all !== true)) {
      notes.push(`"${name}" names ${found.length} objects: use an exact name, or offset with all: true.`);
      continue;
    }
    for (const o of found) {
      if (!o.movable) { notes.push(`"${o.name}" cannot be moved from here (a UI element, a child of another object or inside a placed prefab): move its parent.`); continue; }
      if (seen.has(o.id)) continue;
      seen.add(o.id);
      const to: Vec3 = pos ?? (off ? [o.pos[0] + off[0], o.pos[1] + off[1], o.pos[2] + off[2]] : o.pos);
      edits.push({ object: o, pos: [r2(to[0]), r2(to[1]), r2(to[2])], yawDelta: rot ?? 0, scaleMul: sc ?? 1 });
    }
  }
  if (!edits.length) return notes.join(" ") || "Nothing to move.";
  return { edits, spawns: [], notes };
}

// ---- the approval card -------------------------------------------------------------------------------------------

const fmt = (p: readonly number[]) => `(${p.map((n) => r2(n)).join(", ")})`;

/**
 * The scene diff for a plan: one "changed" object per move (position, turn, scale as old → new) and one "added" per
 * copy, with the top-down plan (everything else as dots, the old and new places).
 *
 * @param level - The level, read.
 * @param plan - What will be done.
 * @param undo - How it can be taken back.
 */
export function levelDiff(level: LoadedLevel, plan: LevelPlan, undo: SceneUndo): SceneDiff {
  const objects: SceneObjectChange[] = plan.edits.map((e) => {
    const props = [{ name: "position (m)", from: fmt(e.object.pos), to: fmt(e.pos) }];
    if (e.yawDelta) props.push({ name: "yaw", from: `${r2(e.object.yaw)}°`, to: `${r2(e.object.yaw + e.yawDelta)}°` });
    if (e.scaleMul !== 1) props.push({ name: "scale", from: "×1", to: `×${r2(e.scaleMul)}` });
    return { kind: "changed", name: e.object.name, type: e.object.type, props };
  });
  for (const s of plan.spawns) {
    const at = fromUnreal(s.location);
    objects.push({ kind: "added", name: s.name, type: (s.asset ?? s.mesh ?? "").split("/").pop()?.split(".")[0] ?? "copy", props: [{ name: "position (m)", to: fmt(at) }, { name: "yaw", to: `${r2(s.rotation[1])}°` }] });
  }
  const edited = new Set(plan.edits.map((e) => e.object.id));
  const rest = level.objects.filter((o) => o.solid && !o.ground && !edited.has(o.id)).slice(0, 300).map((o) => [o.pos[0], o.pos[2]] as [number, number]);
  const before = plan.edits.map((e) => [e.object.pos[0], e.object.pos[2]] as [number, number]);
  const after = [...plan.edits.map((e) => [e.pos[0], e.pos[2]] as [number, number]), ...plan.spawns.map((s) => [s.location[1] / 100, s.location[0] / 100] as [number, number])];
  const all = [...rest, ...before, ...after];
  const pad = 2;
  const xs = all.map((p) => p[0]), zs = all.map((p) => p[1]);
  const min: [number, number] = [Math.min(...xs) - pad, Math.min(...zs) - pad];
  const max: [number, number] = [Math.max(...xs) + pad, Math.max(...zs) + pad];
  const planPic: ScenePlan = { min, max: [Math.max(max[0], min[0] + 10), Math.max(max[1], min[1] + 10)], rest, before, after, moved: plan.edits.length };
  return { engine: level.engine, scene: level.scene, objects, undo, readBefore: true, plan: planPic };
}

// ---- engine writes -------------------------------------------------------------------------------------------------

/** The quaternion (x, y, z, w) after turning `q` by `deg` about the world's up axis (1: Unity's y, 2: Unreal's z). */
export function turnQuat(q: readonly number[], deg: number, up: 1 | 2): number[] {
  if (!deg) return [...q];
  const h = (deg * Math.PI) / 360;
  const d = [0, 0, 0, Math.cos(h)];
  d[up] = Math.sin(h);
  const [ax, ay, az, aw] = d as [number, number, number, number];
  const [bx = 0, by = 0, bz = 0, bw = 1] = q;
  // Hamilton product d ⊗ q: q first, then the turn about the world axis.
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz].map((n) => Math.round(n * 1e6) / 1e6);
}

/** The Unity package's moves for the edits (top-level objects only, so local = world). */
export function unityMoves(level: LoadedLevel, edits: readonly Edit[]): UnityMoveOut[] {
  return edits.flatMap((e) => {
    const o = level.unity?.get(e.object.id);
    if (!o) return [];
    return [{ id: o.id, name: o.name, from: { position: [...o.position], rotation: [...o.rotation], scale: [...o.scale] }, to: { position: [...e.pos], rotation: turnQuat(o.rotation, e.yawDelta, 1), scale: o.scale.map((s) => r2(s * e.scaleMul * 1000) / 1000 || s) } }];
  });
}

/** The bridge's moves for the edits (Unreal's centimeters). */
export function unrealMoves(level: LoadedLevel, edits: readonly Edit[]): Array<{ id: string; from: { position: number[]; rotation: number[] }; to: { position: number[]; rotation: number[]; scale: number[] } }> {
  return edits.flatMap((e) => {
    const a = level.actors?.get(e.object.id);
    if (!a?.position) return [];
    const rotation = a.rotation ?? [0, 0, 0, 1];
    const scale = a.scale ?? [1, 1, 1];
    return [{ id: a.id, from: { position: [...a.position], rotation: [...rotation] }, to: { position: toUnreal(e.pos), rotation: turnQuat(rotation, e.yawDelta, 2), scale: scale.map((s) => r2(s * e.scaleMul * 1000) / 1000 || s) } }];
  });
}

// ---- the tools -----------------------------------------------------------------------------------------------------

/** Where a call points: the engine and the scene, or what is missing. */
export type Target = { engine: "unity"; scene: string } | { engine: "unreal"; scene: string } | string;

/**
 * Which scene or level a call means: `scene` (Assets/….unity or /Game/…), or the only one the project in use has.
 *
 * @param d - The engines.
 * @param input - The tool's input (`scene`, `engine`).
 */
export async function resolveTarget(d: LevelDesignDeps, input: Record<string, unknown>): Promise<Target> {
  const given = String(input.scene ?? input.level ?? "").trim();
  // An Unreal object path (/Game/Maps/Arena.Arena) names the level before the dot; a Unity scene keeps its ".unity".
  const scene = given.startsWith("/Game/") ? given.split(".")[0]! : given;
  const unity = d.unityProject();
  const unrealDir = d.unrealProjectDir();
  const wanted = input.engine === "unity" || input.engine === "unreal" ? input.engine : UNITY_SCENE.test(scene) ? "unity" : scene.startsWith("/Game/") ? "unreal" : undefined;
  const engine = wanted ?? (unity && !unrealDir ? "unity" : unrealDir && !unity ? "unreal" : undefined);
  if (!engine) return unity && unrealDir ? "Both a Unity and an Unreal project are in use: say which with engine (unity or unreal) or give scene." : "No Unity or Unreal project is in use: pick one first (unity_status, unreal_use_project).";
  if (engine === "unity") {
    if (!unity) return "No Unity project is in use.";
    if (scene) return UNITY_SCENE.test(scene) && !scene.split("/").includes("..") ? { engine, scene } : "scene is a Unity scene path, e.g. Assets/Scenes/Main.unity.";
    const scenes = await d.unityScenes?.(unity).catch(() => [] as string[]) ?? [];
    return scenes.length === 1 ? { engine, scene: scenes[0]! } : scenes.length ? `Which scene? ${scenes.slice(0, 30).join(", ")}` : "No .unity scenes in this project.";
  }
  if (!unrealDir) return "No Unreal project is in use: unreal_use_project first.";
  if (scene) return LEVEL_PATH.test(scene) ? { engine, scene } : "scene is an Unreal level path, e.g. /Game/Maps/Arena.";
  const levels = await (d.unrealLevels ?? levelsOnDisk)(unrealDir).catch(() => [] as string[]);
  return levels.length === 1 ? { engine, scene: levels[0]! } : levels.length ? `Which level? ${levels.slice(0, 30).join(", ")}` : "No levels (.umap) in this project.";
}

/**
 * Reads the level a target points at.
 *
 * @param d - The engines.
 * @param t - From {@link resolveTarget}.
 * @returns The level, or a sentence saying why it could not be read.
 */
export async function loadLevel(d: LevelDesignDeps, t: Exclude<Target, string>): Promise<LoadedLevel | string> {
  if (t.engine === "unity") {
    const project = d.unityProject()!;
    if (!d.readUnity) return "Unity scenes cannot be read here.";
    try {
      const read = await d.readUnity(project, t.scene);
      return { engine: "unity", scene: t.scene, objects: unityLevelObjects(read.objects), unity: new Map(read.objects.map((o) => [o.id, o])) };
    } catch (e) {
      return `Could not read ${t.scene}: ${(e as Error).message}`;
    }
  }
  const b = d.bridge;
  const live = !!b?.connected;
  const read: LevelRead | undefined = b ? await (live ? b.standIn<LevelRead>("level", t.scene).catch(() => undefined) : b.keptStandIn<LevelRead>("level", t.scene)) : undefined;
  if (!read) return `${t.scene} has not been read yet with its places: open it in Unreal once (KesherAI Bridge), or call unreal_inspect_level with full: true (a headless Unreal, 30-90 s), then try again.`;
  const objects = unrealLevelObjects(read.actors);
  if (!objects.length) return `${t.scene} was read without places (only names and classes): call unreal_inspect_level with full: true, then try again.`;
  return { engine: "unreal", scene: t.scene, objects, actors: new Map(read.actors.map((a) => [a.id, a])), live };
}

const TARGET_PROPS = {
  scene: { type: "string", description: "Unity: Assets/Scenes/Main.unity. Unreal: /Game/Maps/Arena. Omit when the project has only one." },
  engine: { type: "string", enum: ["unity", "unreal"], description: "Only when both a Unity and an Unreal project are in use and scene does not say." },
} as const;

/** The system-prompt lines for the group. */
export const LEVEL_NOTE =
  "Level design (level_describe, level_arrange, level_move, level_check) works on Unity scenes and Unreal levels, with the editor open or closed: start with level_describe to see what is there, then level_arrange (N copies of an object along a line, on a grid, on a circle or scattered) or level_move; every change is one approval card with a before/after plan and is kept in a checkpoint (↺). Positions are meters, x right, y up, z forward, in both engines. level_check finds overlaps, objects outside the bounds and floating objects; fix them with level_move. In Unity only objects already in the scene can be arranged (the editor applies the moves); Unreal can also place new copies of a mesh.";

/**
 * The four level-design tools.
 *
 * @param d - The engines.
 * @returns `level_describe`, `level_arrange`, `level_move` and `level_check`.
 */
export function levelDesignTools(d: LevelDesignDeps): AgentTool[] {
  const live = (l: LoadedLevel) => l.live === true;
  const undoOf = (l: LoadedLevel): SceneUndo => (l.engine === "unity" ? "checkpoint" : live(l) ? "undo" : "queued");
  /** Resolves and reads in one step: the level, or the sentence to hand the model. */
  const open = async (input: Record<string, unknown>): Promise<LoadedLevel | string> => {
    const t = await resolveTarget(d, input);
    return typeof t === "string" ? t : loadLevel(d, t);
  };
  /** Plans a write call and builds its preview, or returns the sentence. */
  const planned = async (input: Record<string, unknown>, how: (l: LoadedLevel) => LevelPlan | string): Promise<{ level: LoadedLevel; plan: LevelPlan } | string> => {
    const level = await open(input);
    if (typeof level === "string") return level;
    const plan = how(level);
    return typeof plan === "string" ? plan : { level, plan };
  };
  /** Applies a plan: Unity's pending moves, or the Unreal bridge's moves and spawns. */
  const apply = async (level: LoadedLevel, plan: LevelPlan): Promise<string> => {
    const lines: string[] = [];
    if (level.engine === "unity") {
      const moves = unityMoves(level, plan.edits);
      if (!moves.length) return "Nothing to move.";
      const project = d.unityProject()!;
      if (!d.queueUnity) return "Unity moves cannot be queued here.";
      const r = await d.queueUnity(project, level.scene, moves);
      lines.push(`Queued ${r.queued} move${r.queued === 1 ? "" : "s"} for ${level.scene} (${r.waiting} waiting in all). The KesherAI Unity package applies them as one Undo step when the scene is open (now, if Unity is open with it; otherwise when it opens). The scene is kept in a checkpoint first (↺ in the chat).`);
    } else {
      const b = d.bridge;
      if (!b?.available) return "The KesherAI Bridge plugin is not set up for this project: open the project in Unreal once with it (the Unreal page installs it).";
      const moves = unrealMoves(level, plan.edits);
      if (moves.length) {
        const r = await b.moveActors(level.scene, moves);
        lines.push(`${r.moved} moved in ${level.scene}${live(level) ? " (one undo step in Unreal; not saved yet: save the level there)" : " in a headless Unreal, the level saved (a checkpoint of it was kept first)"}.${r.clashes.length ? ` Left where they are, because they moved in Unreal meanwhile: ${r.clashes.slice(0, 10).join(", ")}.` : ""}${r.missing.length ? ` Not found: ${r.missing.slice(0, 10).join(", ")}.` : ""}`);
      }
      if (plan.spawns.length) {
        if (live(level)) {
          const r = await b.request<{ spawned: number; missing?: string[] }>("level_spawn", { path: level.scene, actors: plan.spawns }, 120_000);
          lines.push(`Placed ${r.spawned} new actors in folder ${FOLDER} (one undo step; not saved yet).${r.missing?.length ? ` Not found: ${r.missing.join(", ")}.` : ""}`);
        } else {
          const project = await b.project();
          if (!project) return [...lines, "KesherAI does not know the project yet: open it once in Unreal with the KesherAI Bridge plugin."].join("\n");
          await b.enqueue({ project, path: level.scene, graph: "", kind: "spawn", ops: plan.spawns, request: `Level design: ${plan.spawns.length} copies`, baseAt: new Date().toISOString() });
          b.scheduleSync();
          lines.push(`Queued ${plan.spawns.length} new actors: a headless Unreal places them in a few seconds and saves the level.`);
        }
      }
    }
    return lines.join("\n");
  };
  const notes = (p: LevelPlan) => (p.notes.length ? `\n${p.notes.join("\n")}` : "");
  const preview = (level: LoadedLevel, plan: LevelPlan) => `${scenePreview(levelDiff(level, plan, undoOf(level)))}`;

  return [
    {
      risk: "read",
      spec: {
        name: "level_describe",
        description: "A compact text map of a Unity scene or Unreal level, also with the editor closed: object counts by type, the bounds, the objects by area (a 3 × 3 split) and the biggest free space. Positions in meters (x right, y up, z forward). Use it before level_arrange, level_move or level_check.",
        inputSchema: { type: "object", properties: { ...TARGET_PROPS, filter: { type: "string", description: "Only objects whose name or type contains this." } } },
      },
      run: async (input) => {
        const level = await open(input);
        if (typeof level === "string") return { output: level };
        return { output: describeLevel(level.objects, { title: `${level.engine === "unity" ? "Unity scene" : "Unreal level"} ${level.scene}`, filter: String(input.filter ?? "").slice(0, 80) }) };
      },
    },
    {
      risk: "read",
      spec: {
        name: "level_check",
        description: "Checks a level for objects that overlap, stand outside the bounds, or float above the ground. Sizes are estimates (a mesh is 1 m times its scale) and a pivot is taken to be the middle, so treat a borderline finding as a hint. Fix findings with level_move.",
        inputSchema: { type: "object", properties: { ...TARGET_PROPS, bounds: { type: "object", description: "{ min: [x, z], max: [x, z] } in meters; default the floors' box." }, tolerance: { type: "number", description: "Meters above the ground that count as floating, and outside the bounds that count as outside (default 0.3)." } } },
      },
      run: async (input) => {
        const level = await open(input);
        if (typeof level === "string") return { output: level };
        const bounds = boxOf(input.bounds);
        const r = checkLevel(level.objects, { ...(bounds ? { bounds } : {}), ...(num(input.tolerance) !== undefined ? { tolerance: Math.max(0, num(input.tolerance)!) } : {}) });
        const cap = 25;
        const out = [`${level.scene}: ${r.checked} placed things checked${r.bounds ? ` against x ${r2(r.bounds.min[0])}..${r2(r.bounds.max[0])}, z ${r2(r.bounds.min[1])}..${r2(r.bounds.max[1])}` : " (no floors or bounds, so no outside check)"}.`];
        out.push(r.overlaps.length ? `Overlapping (${r.overlaps.length}):\n${r.overlaps.slice(0, cap).map((o) => `  ${o.a} ↔ ${o.b} by ${o.depth} m`).join("\n")}${r.overlaps.length > cap ? `\n  … ${r.overlaps.length - cap} more` : ""}` : "Overlapping: none.");
        out.push(r.outside.length ? `Outside the bounds (${r.outside.length}):\n${r.outside.slice(0, cap).map((o) => `  ${o.name} by ${o.by} m`).join("\n")}${r.outside.length > cap ? `\n  … ${r.outside.length - cap} more` : ""}` : "Outside the bounds: none.");
        out.push(r.floating.length ? `Floating (${r.floating.length}):\n${r.floating.slice(0, cap).map((o) => `  ${o.name} ${o.gap} m above the ground`).join("\n")}${r.floating.length > cap ? `\n  … ${r.floating.length - cap} more` : ""}` : "Floating: none.");
        return { output: out.join("\n") };
      },
    },
    {
      risk: "write",
      spec: {
        name: "level_arrange",
        description: `Place N copies of an object along a line, on a grid, on a circle or scattered, inside bounds, with spacing and rotation jitter, standing on the ground when it is known. source names objects already in the level ("Crate" finds Crate (1), Crate_2…): they are moved into the pattern. Unreal can also place new copies for the rest (from that object's mesh, or asset: a /Game/… static mesh or Blueprint); Unity can only move objects already in the scene. The user sees a before/after plan and the list in one card; it is kept in a checkpoint. Run level_describe first. Positions are meters, x right, y up, z forward.`,
        inputSchema: {
          type: "object",
          properties: {
            ...TARGET_PROPS,
            source: { type: "string", description: "The object to copy/arrange: a name in the level, or (Unreal) an asset path /Game/…." },
            asset: { type: "string", description: "Unreal: the mesh or Blueprint (/Game/… or /Engine/BasicShapes/Cube.Cube) for new copies." },
            count: { type: "number", description: `How many copies in all (1-${MAX_COPIES}).` },
            pattern: { type: "string", enum: [...PATTERNS], description: "Default grid." },
            bounds: { type: "object", description: "{ min: [x, z], max: [x, z] }: every copy stays inside." },
            center: { type: "array", items: { type: "number" }, description: "[x, z] middle of a grid or circle." },
            from: { type: "array", items: { type: "number" }, description: "[x, z] start of a line." },
            to: { type: "array", items: { type: "number" }, description: "[x, z] end of a line." },
            columns: { type: "number", description: "Grid columns." },
            spacing: { type: "number", description: "Meters between copies (default 1.25 × the object's size)." },
            radius: { type: "number", description: "Circle radius in meters." },
            start_angle: { type: "number", description: "Circle: degrees of the first copy from +x toward +z." },
            yaw: { type: "number", description: "Degrees about the up axis for every copy." },
            yaw_jitter: { type: "number", description: "Each copy turns by up to ± this many degrees." },
            pos_jitter: { type: "number", description: "Each copy moves by up to ± this many meters (not scatter)." },
            scale_jitter: { type: "number", description: "Each copy's scale varies by up to ± this fraction." },
            seed: { type: "number", description: "Same seed, same result." },
            snap_to_ground: { type: "boolean", description: "Stand on the floor under each copy when known (default true)." },
            ground_y: { type: "number", description: "A fixed height in meters, when the floor is not in the level." },
          },
          required: ["source", "count"],
        },
      },
      askFirst: () => "Moves or adds objects in a Unity scene or an Unreal level.",
      preview: async (input) => {
        const p = await planned(input, (l) => planArrange(l, input));
        return typeof p === "string" ? p : `${preview(p.level, p.plan)}${notes(p.plan)}`;
      },
      run: async (input) => {
        const p = await planned(input, (l) => planArrange(l, input));
        if (typeof p === "string") return { output: p };
        if (!p.plan.edits.length && !p.plan.spawns.length) return { output: `Nothing to place.${notes(p.plan)}` };
        return { output: `${await apply(p.level, p.plan)}${notes(p.plan)}` };
      },
    },
    {
      risk: "write",
      spec: {
        name: "level_move",
        description: "Move, turn and scale named objects in a Unity scene or Unreal level (up to 300). Each entry: name, then position (absolute [x, y, z]) or offset ([dx, dy, dz]), rotate (degrees about the up axis, added) and scale (a multiplier). Meters; x right, y up, z forward. One approval card with a before/after plan; kept in a checkpoint.",
        inputSchema: {
          type: "object",
          properties: {
            ...TARGET_PROPS,
            objects: { type: "array", items: { type: "object", properties: { name: { type: "string" }, position: { type: "array", items: { type: "number" } }, offset: { type: "array", items: { type: "number" } }, rotate: { type: "number" }, scale: { type: "number" }, all: { type: "boolean", description: "The name matches several objects (Crate for Crate (1), (2)…): offset, rotate or scale all of them." } }, required: ["name"] }, description: "What to move." },
          },
          required: ["objects"],
        },
      },
      askFirst: () => "Moves objects in a Unity scene or an Unreal level.",
      preview: async (input) => {
        const p = await planned(input, (l) => planMove(l, input));
        return typeof p === "string" ? p : `${preview(p.level, p.plan)}${notes(p.plan)}`;
      },
      run: async (input) => {
        const p = await planned(input, (l) => planMove(l, input));
        if (typeof p === "string") return { output: p };
        return { output: `${await apply(p.level, p.plan)}${notes(p.plan)}` };
      },
    },
  ];
}

/**
 * The project files a level-design write touches, for the chat turn's checkpoint (chat-tools-games.ts `engineWrites`).
 *
 * @param input - The tool's input.
 * @param dirs - The projects in use.
 * @param levelFile - Unreal: a level's .umap in the project.
 * @returns The engine, project folder and files (the Unity scene and its pending moves; the Unreal level), or undefined.
 */
export function levelWrites(input: Record<string, unknown>, dirs: { unity?: string; unreal?: string }, levelFile: (dir: string, level: string) => string | undefined): { engine: "unity" | "unreal"; project: string; files: string[] } | undefined {
  const given = String(input.scene ?? input.level ?? "").trim();
  const scene = given.startsWith("/Game/") ? given.split(".")[0]! : given;
  const engine = input.engine === "unity" || input.engine === "unreal" ? input.engine : UNITY_SCENE.test(scene) ? "unity" : scene.startsWith("/Game/") ? "unreal" : dirs.unity && !dirs.unreal ? "unity" : dirs.unreal && !dirs.unity ? "unreal" : undefined;
  if (engine === "unity" && dirs.unity) {
    if (scene && !(UNITY_SCENE.test(scene) && !scene.split("/").includes(".."))) return undefined;
    return { engine, project: dirs.unity, files: [...(scene ? [join(dirs.unity, scene)] : []), join(dirs.unity, "KesherAI", "pending-moves.json")] };
  }
  if (engine === "unreal" && dirs.unreal && scene) {
    const file = levelFile(dirs.unreal, scene);
    return file ? { engine, project: dirs.unreal, files: [file] } : undefined;
  }
  return undefined;
}
