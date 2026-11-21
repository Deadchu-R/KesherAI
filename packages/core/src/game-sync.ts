import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { BlueprintJson, QueuedEdit } from "./unreal-bridge.js";

/**
 * Engine work with the engine closed, synced later (RESEARCH_LOG "Gap list: engine work without the engine open",
 * 2026-11-20, steps 1 and 2): the parts the Unreal bridge and the Unity CLI share.
 *
 * - **Clash:** a change queued in KesherAI was made on a saved copy of a graph; when the engine saved the graph's
 *   file after that copy, both sides changed it. Roee's rule: never decide alone, ask every time (the "Sync and
 *   conflicts" sheet on the Game projects page): keep mine, keep the engine's, or skip for now.
 * - **Report:** each sync ends with one report; a phone notification goes out only for a failure or a new clash.
 */

/** How much later than the saved copy the engine's file must be to count as changed there (file times are coarse). */
const SLACK_MS = 2000;

/** The choice for a clash, made on the Sync and conflicts sheet. */
export type ClashChoice = "mine" | "engine" | "skip";

/** How one sync ended (for the page and the notification). */
export interface SyncReport {
  engine: "unreal" | "unity" | "godot";
  /** The project (Unreal: its name; Unity and Godot: its folder). */
  project: string;
  applied: number;
  failed: number;
  /** Changes newly found clashing with an edit made in the engine. */
  clashes: number;
  error?: string;
}

/** A batch of queued changes about to be applied (a checkpoint of their files is taken first, game-checkpoints.ts). */
export interface SyncBatch {
  engine: "unreal" | "unity";
  /** The project folder. */
  project: string;
  /** The project's name. */
  name: string;
  /** The asset files the batch will write. */
  files: string[];
  /** How many changes it applies. */
  count: number;
}

/**
 * The files a batch of queued changes writes (each graph's asset file, once).
 *
 * @param edits - The changes about to be applied.
 * @param fileOf - The file of each change's graph.
 */
export function batchFiles(edits: QueuedEdit[], fileOf: (q: QueuedEdit) => string | undefined): string[] {
  return [...new Set(edits.map(fileOf).filter((f): f is string => !!f))];
}

/**
 * The saved graph's node ids and titles (kept with a queued change, so a clash can show what the engine changed).
 *
 * @param graph - The graph the change was made on.
 * @returns id → title, at most 400 nodes.
 */
export function nodeSig(graph: BlueprintJson | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0;
  for (const g of graph?.graphs ?? []) {
    for (const node of g.nodes ?? []) {
      if (n++ >= 400) return out;
      out[node.id] = String(node.title ?? node.class ?? "").slice(0, 80);
    }
  }
  return out;
}

/**
 * The nodes added and removed between two versions of a graph (by node id), for the clash sheet.
 *
 * @param base - The node signature the queued change was made on.
 * @param now - The graph as it is in the engine now.
 * @returns The titles added and removed (at most 30 each).
 */
export function graphDiff(base: Record<string, string>, now: BlueprintJson): { added: string[]; removed: string[] } {
  const current = nodeSig(now);
  const added = Object.keys(current).filter((id) => !(id in base)).map((id) => current[id]!);
  const removed = Object.keys(base).filter((id) => !(id in current)).map((id) => base[id]!);
  return { added: added.slice(0, 30), removed: removed.slice(0, 30) };
}

/**
 * One short line per queued operation, for "your side" of a clash.
 *
 * @param ops - The graph operations ({ op: "add" | "connect" | "set" | "move" | "delete" | "comment", … }).
 * @param base - Node titles, to name the nodes an operation touches.
 * @returns At most 30 lines.
 */
export function opsSummary(ops: unknown[], base: Record<string, string> = {}): string[] {
  const name = (v: unknown) => {
    const id = typeof v === "object" && v ? String((v as { node?: unknown }).node ?? "") : String(v ?? "");
    return base[id] ?? id;
  };
  return ops.slice(0, 30).map((raw) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const what = String(o.function ?? o.event ?? o.variable ?? o.name ?? "");
    switch (o.op) {
      case "add": return `+ ${String(o.type ?? "node")}${what ? ` ${what}` : ""}`;
      case "connect": return `→ ${name(o.from)} ⟶ ${name(o.to)}`;
      case "set": return `= ${name(o.node)}.${String(o.pin ?? "")}: ${String(o.value ?? "").slice(0, 40)}`;
      case "delete": return `− ${name(o.node)}`;
      case "move": return `↔ ${name(o.node)}`;
      case "comment": return `💬 ${name(o.node)}`;
      case "material": return `◧ ${String(o.actor ?? "")} [${String(o.slot ?? "0")}]: ${String(o.material ?? "").split("/").pop() ?? ""}`;
      case "spawn": return `+ ${String(o.name ?? o.shape ?? o.class ?? "actor")}`;
      case "vfx": return `✨ ${String(o.preset ?? "effect")}`;
      default: return String(o.op ?? "?");
    }
  });
}

/**
 * The asset file of an Unreal object path in a project (/Game/Doors/BP_Door.BP_Door → Content/Doors/BP_Door.uasset).
 *
 * @param projectDir - The folder with the .uproject.
 * @param objectPath - The Blueprint's object path.
 * @returns The file, or undefined for paths outside /Game (plugins, engine).
 */
export function unrealAssetFile(projectDir: string, objectPath: string): string | undefined {
  const m = /^\/Game\/([^.]+)(?:\.[^/]*)?$/.exec(objectPath);
  if (!m || m[1]!.split("/").some((p) => p === ".." || p === "")) return undefined;
  return join(projectDir, "Content", `${m[1]}.uasset`);
}

/**
 * The file of an Unreal level's package in a project (/Game/Maps/Arena → Content/Maps/Arena.umap).
 *
 * @param projectDir - The folder with the .uproject.
 * @param levelPath - The level's package or object path.
 * @returns The file, or undefined for paths outside /Game.
 */
export function unrealLevelFile(projectDir: string, levelPath: string): string | undefined {
  const file = unrealAssetFile(projectDir, levelPath);
  return file?.replace(/\.uasset$/, ".umap");
}

/**
 * The file of a Unity graph path in a project (Assets/AI/Enemy.asset, or a graph inside a scene or prefab:
 * Assets/Main.unity#Player/Body@0).
 *
 * @param projectDir - The Unity project folder.
 * @param graphPath - The graph's path as the KesherAI package names it.
 * @returns The file, or undefined for a path outside Assets/.
 */
export function unityAssetFile(projectDir: string, graphPath: string): string | undefined {
  const file = graphPath.split("#")[0]!;
  if (!/^Assets\//.test(file) || file.split("/").some((p) => p === "..")) return undefined;
  return join(projectDir, file);
}

/**
 * Whether the engine saved a queued change's file after the copy the change was made on.
 *
 * @param edit - The queued change (with baseAt, the time of that copy).
 * @param file - The graph's file in the project (undefined: cannot tell, no clash).
 * @returns The time the engine saved it, when it is a clash.
 */
export async function engineChangedAt(edit: QueuedEdit, file: string | undefined): Promise<string | undefined> {
  if (!edit.baseAt || !file || edit.kind === "create") return undefined;
  const st = await stat(file).catch(() => undefined);
  if (!st) return undefined;
  return st.mtimeMs > Date.parse(edit.baseAt) + SLACK_MS ? new Date(st.mtimeMs).toISOString() : undefined;
}

/**
 * Splits a project's queued changes into the ones to apply now and the ones held back: new clashes (marked on the
 * change, to be asked about) and changes already waiting for a choice or skipped for now.
 *
 * @param mine - The project's queued changes.
 * @param fileOf - The file each change's graph is saved in.
 * @returns What to apply, and the changes newly found clashing (their clash field set; the caller saves them).
 */
export async function sortForSync(mine: QueuedEdit[], fileOf: (q: QueuedEdit) => string | undefined): Promise<{ apply: QueuedEdit[]; newClashes: QueuedEdit[] }> {
  const apply: QueuedEdit[] = [];
  const newClashes: QueuedEdit[] = [];
  for (const q of mine) {
    if (q.decision === "mine") { apply.push(q); continue; }
    if (q.decision === "skip" || q.clash) continue;
    const at = await engineChangedAt(q, fileOf(q));
    if (at) {
      q.clash = { engineAt: at };
      newClashes.push(q);
    } else apply.push(q);
  }
  return { apply, newClashes };
}
