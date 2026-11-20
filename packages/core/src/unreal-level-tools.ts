/**
 * Two Unreal level tools for a chat (WORK_LIST "Unreal: inspect_level and apply_material tools"):
 * - `unreal_inspect_level`: the actors of a level (label, class, transform, components, mesh, materials). Live from the
 *   KesherAI Bridge when Unreal is open; with it closed, names and classes straight from the .umap file's header (no
 *   engine), or everything from a headless Unreal when asked (`full`).
 * - `unreal_apply_material`: a material or material instance in one slot of an actor's mesh. In the open editor as
 *   one undo step; with it closed, queued and applied by the offline sync (a checkpoint of the level first). Its
 *   approval card shows the slot's old → new material (scene-diff-build.ts).
 */
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { AgentTool } from "@kesher/agent";
import { scenePreview } from "@kesher/shared";
import { unrealLevelFile } from "./game-sync.js";
import { unrealMaterialDiff, type UnrealSlots } from "./scene-diff-build.js";
import { readUassetFile, type UassetHeader } from "./uasset.js";
import type { UnrealBridge } from "./unreal-bridge.js";

/** A level actor as the bridge's `level` command reads it (KesherLevel.cpp). */
export interface LevelActor {
  id: string;
  name: string;
  class: string;
  parent?: string;
  position?: number[];
  /** A quaternion [x, y, z, w]. */
  rotation?: number[];
  scale?: number[];
  components?: string[];
  folder?: string;
  mesh?: string;
  slots?: UnrealSlots[];
}

/** The bridge's answer for a level. */
export interface LevelRead {
  path: string;
  actors: LevelActor[];
  partitioned?: boolean;
}

const LEVEL = /^\/Game\/[\w/ .-]{1,300}$/;
const ASSET = /^\/(Game|Engine)\/[\w/ .-]{1,300}$/;
const SLOT = /^[\w .-]{1,80}$/;
const MAX_LINES = 400;
/** Level sub-objects that are not actors the user placed. */
const NOT_ACTORS = /^(Model|WorldSettings|Default\w*|Polys|BookMark\w*|NavigationDataChunk\w*|LevelScriptBlueprint|MetaData)$/;
const MATERIAL_CLASS = /^(Material|MaterialInstanceConstant|MaterialInstanceDynamic|MaterialInstance)$/;

const r1 = (n: number) => Math.round(n * 10) / 10 || 0;
const RAD = 180 / Math.PI;
const axis = (a: number) => {
  const x = ((a % 360) + 360) % 360;
  return x > 180 ? x - 360 : x;
};

/**
 * A quaternion as Unreal's rotator (FQuat::Rotator: pitch, yaw, roll in degrees), as the Details panel shows it.
 *
 * @param q - [x, y, z, w].
 * @returns [pitch, yaw, roll], one decimal.
 */
export function quatToRotator(q: number[]): number[] {
  const [x = 0, y = 0, z = 0, w = 1] = q;
  const sing = z * x - w * y;
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * RAD;
  if (sing < -0.4999995) return [-90, r1(yaw), r1(axis(-yaw - 2 * Math.atan2(x, w) * RAD))];
  if (sing > 0.4999995) return [90, r1(yaw), r1(axis(yaw - 2 * Math.atan2(x, w) * RAD))];
  return [r1(Math.asin(2 * sing) * RAD), r1(yaw), r1(Math.atan2(-2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) * RAD)];
}

const short = (path: string) => path.split("/").pop()?.split(".")[0] ?? path;

/**
 * One actor as a line (or a few) for the model.
 *
 * @param a - The actor.
 */
export function actorLine(a: LevelActor): string {
  const at = a.position ? ` at (${a.position.map(r1).join(", ")})` : "";
  const rot = a.rotation ? (quatToRotator(a.rotation).some((n) => n !== 0) ? ` rot (${quatToRotator(a.rotation).join(", ")})` : "") : "";
  const sc = a.scale && a.scale.some((n) => Math.abs(n - 1) > 1e-4) ? ` scale (${a.scale.map((n) => Math.round(n * 1000) / 1000).join(", ")})` : "";
  const extra = [
    a.mesh ? `mesh ${short(a.mesh)}` : "",
    a.components?.length ? `components ${a.components.slice(0, 8).join(", ")}${a.components.length > 8 ? "…" : ""}` : "",
    a.parent ? `attached to ${a.parent}` : "",
    a.folder ? `folder ${a.folder}` : "",
  ].filter(Boolean).join("; ");
  const lines = [`${a.name}${a.id && a.id !== a.name ? ` [${a.id}]` : ""} ${a.class}${at}${rot}${sc}${extra ? ` — ${extra}` : ""}`];
  for (const s of a.slots ?? []) lines.push(`    ${s.component}: ${s.materials.map((m) => `${m.slot}=${m.material ? m.material : "None"}`).join(", ")}`);
  return lines.join("\n");
}

/**
 * The actors of a level from its .umap header (no engine): the exports whose outer is the persistent level, and the
 * components each one holds. No labels or transforms (those are in the saved data, not the header).
 *
 * @param h - The parsed header.
 * @returns The actors (id = the object name), and the materials the level uses (package paths).
 */
export function levelFromHeader(h: Pick<UassetHeader, "exports" | "imports">): { actors: LevelActor[]; materials: string[] } {
  const levelAt = h.exports.findIndex((e) => e.className === "Level");
  if (levelAt < 0) return { actors: [], materials: [] };
  const actors: LevelActor[] = [];
  h.exports.forEach((e, i) => {
    if (e.outer !== levelAt + 1 || NOT_ACTORS.test(e.className) || e.className === "Level") return;
    const components = h.exports.filter((c) => c.outer === i + 1).map((c) => c.className);
    actors.push({ id: e.objectName, name: e.objectName, class: e.className, ...(components.length ? { components } : {}) });
  });
  const materials = h.imports
    .filter((im) => MATERIAL_CLASS.test(im.className))
    .map((im) => {
      const pkg = im.outer < 0 ? h.imports[-im.outer - 1]?.objectName : undefined;
      return pkg ? `${pkg}.${im.objectName}` : im.objectName;
    });
  return { actors, materials: [...new Set(materials)].sort() };
}

/**
 * The project's levels from its Content folder (Unreal closed): every .umap, as /Game paths, without the files World
 * Partition keeps per actor.
 *
 * @param projectDir - The folder with the .uproject.
 * @param max - At most this many.
 */
export async function levelsOnDisk(projectDir: string, max = 500): Promise<string[]> {
  const content = join(projectDir, "Content");
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 12 || out.length >= max) return;
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory()) {
        if (!e.name.startsWith("__External")) await walk(join(dir, e.name), depth + 1);
      } else if (e.name.toLowerCase().endsWith(".umap") && out.length < max) out.push(`/Game/${relative(content, join(dir, e.name)).split(sep).join("/").replace(/\.umap$/i, "")}`);
    }
  };
  await walk(content, 0);
  return out.sort();
}

/** How many actor files World Partition keeps for a level (Content/__ExternalActors__/<level>/…), up to `max`. */
async function externalActors(projectDir: string, level: string, max = 5000): Promise<number> {
  let n = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6 || n >= max) return;
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory()) await walk(join(dir, e.name), depth + 1);
      else if (e.name.endsWith(".uasset")) n++;
    }
  };
  await walk(join(projectDir, "Content", "__ExternalActors__", ...level.replace(/^\/Game\//, "").split("/")), 0);
  return n;
}

/** What the level tools need. */
export interface UnrealLevelDeps {
  bridge?: UnrealBridge;
  /** The project folder (with the .uproject), for reading levels with Unreal closed. */
  projectDir: () => string | undefined;
}

/**
 * The two level tools.
 *
 * @param d - The bridge (when the KesherAI Bridge plugin was ever connected) and the project folder.
 * @returns `unreal_inspect_level` and `unreal_apply_material`.
 */
export function unrealLevelTools(d: UnrealLevelDeps): AgentTool[] {
  const live = () => !!d.bridge?.connected;
  /** A level's actors with their material slots, from the open editor or the copy kept here (never slow). */
  const quickLevel = async (level: string): Promise<LevelRead | undefined> => {
    if (!d.bridge) return undefined;
    if (live()) return d.bridge.standIn<LevelRead>("level", level).catch(() => undefined);
    return d.bridge.keptStandIn<LevelRead>("level", level);
  };
  const findActor = (read: LevelRead | undefined, key: string) => read?.actors.find((a) => a.name === key || a.id === key);
  const materialInput = (input: Record<string, unknown>) => {
    const level = String(input.level ?? "").trim().split(".")[0]!;
    const actor = String(input.actor ?? "").trim().slice(0, 200);
    const material = String(input.material ?? "").trim();
    const slot = String(input.slot ?? "0").trim() || "0";
    const component = String(input.component ?? "").trim().slice(0, 120);
    if (!LEVEL.test(level)) return "level is the level's /Game path, e.g. /Game/Maps/Arena (unreal_inspect_level lists them).";
    if (!actor) return "actor is the actor's label or id from unreal_inspect_level.";
    if (!ASSET.test(material)) return "material is a material or material instance under /Game or /Engine, e.g. /Game/Materials/M_Brick.";
    if (!SLOT.test(slot)) return "slot is the slot's index (0, 1…) or its name.";
    if (component && !/^[\w .-]+$/.test(component)) return "component is the mesh component's name from unreal_inspect_level.";
    return { level, actor, material, slot, component };
  };
  return [
    {
      risk: "read",
      spec: {
        name: "unreal_inspect_level",
        description: "The actors of an Unreal level: label [id], class, location (cm), rotation (pitch, yaw, roll), scale, components, mesh and each mesh slot's material. Without level: the project's levels. Live when Unreal is open (KesherAI Bridge); with it closed, ids and classes from the saved .umap (fast), or full: true for everything from a headless Unreal (30-90 s).",
        inputSchema: {
          type: "object",
          properties: {
            level: { type: "string", description: "The level's /Game path, e.g. /Game/Maps/Arena. Omit to list the levels." },
            filter: { type: "string", description: "Only actors whose label, id or class contains this." },
            limit: { type: "number", description: "At most this many actors (default 80, at most 400)." },
            full: { type: "boolean", description: "Unreal closed: read the level in a headless Unreal (transforms and materials too)." },
          },
        },
      },
      run: async (input) => {
        const dir = d.projectDir();
        const level = String(input.level ?? "").trim().split(".")[0]!;
        if (!level) {
          const levels = live() ? (await d.bridge!.standIn<{ levels: string[] }>("levels")).levels : dir ? await levelsOnDisk(dir) : [];
          if (!levels.length) return { output: dir || live() ? "No levels (.umap) in this project's Content folder." : "No Unreal project is in use: unreal_use_project first." };
          return { output: `${levels.length} level${levels.length === 1 ? "" : "s"}:\n${levels.slice(0, MAX_LINES).join("\n")}` };
        }
        if (!LEVEL.test(level)) return { output: "level is a /Game path, e.g. /Game/Maps/Arena." };
        const filter = String(input.filter ?? "").trim().toLowerCase().slice(0, 80);
        const limit = Math.min(MAX_LINES, Math.max(1, Math.round(Number(input.limit) || 80)));
        const pick = (actors: LevelActor[]) => actors.filter((a) => !filter || `${a.name} ${a.id} ${a.class}`.toLowerCase().includes(filter));
        if (live() || (input.full === true && d.bridge?.available)) {
          const read = await d.bridge!.standIn<LevelRead & { cached?: boolean }>("level", level);
          const actors = pick(read.actors);
          const head = `${read.path}: ${read.actors.length} actors${filter ? `, ${actors.length} match` : ""}${read.cached ? " (the copy read last time)" : live() ? " (live from the open editor)" : " (read in a headless Unreal)"}${read.partitioned ? ". World Partition: only the loaded regions' actors are here" : ""}.`;
          return { output: [head, ...actors.slice(0, limit).map(actorLine), actors.length > limit ? `… ${actors.length - limit} more: narrow with filter or raise limit.` : ""].filter(Boolean).join("\n") };
        }
        if (!dir) return { output: "No Unreal project is in use: unreal_use_project first." };
        const file = unrealLevelFile(dir, level);
        const h = file ? await readUassetFile(file).catch(() => undefined) : undefined;
        if (!h?.ok || !h.isMap) return { output: `No level file for ${level} in this project (Content/…/*.umap). unreal_inspect_level without level lists them.` };
        const { actors: all, materials } = levelFromHeader(h);
        const actors = pick(all);
        const ext = await externalActors(dir, level);
        const head = `${level} (from the saved file, Unreal closed): ${all.length} actors${filter ? `, ${actors.length} match` : ""}. Ids and classes only; full: true (or opening Unreal) gives labels, transforms and materials.${ext ? ` World Partition: ${ext} more actors are kept in their own files.` : ""}`;
        const lines = actors.slice(0, limit).map(actorLine);
        if (actors.length > limit) lines.push(`… ${actors.length - limit} more: narrow with filter or raise limit.`);
        if (materials.length) lines.push(`Materials the level uses: ${materials.slice(0, 40).join(", ")}${materials.length > 40 ? "…" : ""}`);
        return { output: [head, ...lines].join("\n") };
      },
    },
    {
      risk: "write",
      spec: {
        name: "unreal_apply_material",
        description: "Put a material or material instance in one slot of a level actor's mesh (static or skeletal mesh component). Unreal open: one undo step there, then the user saves. Unreal closed: queued and applied in a headless Unreal a few seconds later, the level saved, with a checkpoint first. Find the level, actor and slots with unreal_inspect_level first.",
        inputSchema: {
          type: "object",
          properties: {
            level: { type: "string", description: "/Game/Maps/Arena" },
            actor: { type: "string", description: "The actor's label or [id]." },
            material: { type: "string", description: "/Game/Materials/M_Brick or a material instance (MI_…)." },
            slot: { type: "string", description: "The slot's index (default 0) or name." },
            component: { type: "string", description: "The mesh component's name, when the actor has several." },
          },
          required: ["level", "actor", "material"],
        },
      },
      preview: async (input) => {
        const m = materialInput(input);
        if (typeof m === "string") return m;
        const read = await quickLevel(m.level);
        const a = findActor(read, m.actor);
        return scenePreview(unrealMaterialDiff({ ...m, actor: a?.name ?? m.actor, ...(a ? { actorClass: a.class } : {}), ...(a?.slots ? { slots: a.slots } : {}), undo: live() ? "undo" : "queued" }));
      },
      run: async (input) => {
        const m = materialInput(input);
        if (typeof m === "string") return { output: m };
        const b = d.bridge;
        if (!b?.available) return { output: "The KesherAI Bridge plugin is not set up for this project: open the project in Unreal once with it (the Unreal page installs it)." };
        if (live()) {
          const r = await b.applyMaterial(m.level, { actor: m.actor, component: m.component, slot: m.slot, material: m.material });
          return { output: `${r.actor} · ${r.component} slot ${r.slot}: ${r.from || "None"} → ${r.to} (one undo step in Unreal; not saved yet: save the level there).` };
        }
        const project = await b.project();
        if (!project) return { output: "KesherAI does not know the project yet: open it once in Unreal with the KesherAI Bridge plugin." };
        // baseAt: when the level was read for this change, so a save in Unreal meanwhile is caught as a clash.
        await b.enqueue({ project, path: m.level, graph: "", kind: "material", ops: [{ op: "material", actor: m.actor, component: m.component, slot: m.slot, material: m.material }], request: `${m.actor}: ${short(m.material)}`, baseAt: new Date().toISOString() });
        b.scheduleSync();
        return { output: `Queued: ${m.actor} slot ${m.slot} → ${m.material}. Unreal is closed, so a headless Unreal applies it in a few seconds and saves the level (a checkpoint of the level is kept first; the Game projects page shows the sync).` };
      },
    },
  ];
}
