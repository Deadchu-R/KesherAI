/**
 * Pure helpers of the scenes surface (ScenesPanel.tsx): which tool results open it, the scene hierarchy read from what
 * the Unity, Unreal and Godot tools returned, the diff built from the changes the user approved, and the "Ask about
 * this object" message. No React, so they run in `node:test`.
 */
import { parseScenePreview, sceneCounts, type SceneDiff, type SceneEngine, type SceneObjectChange } from "@kesher/shared";

/** The scene tools whose results open the surface (a tool of another engine never does). */
export const SCENE_TOOLS: Record<string, SceneEngine> = {
  unity_scene: "unity", unity_modify_scene: "unity", unity_create_gameobject: "unity", unity_add_component: "unity", unity_inspect_object: "unity", unity_blockout: "unity", unity_vfx: "unity",
  godot_scene: "godot", godot_tree: "godot", godot_get: "godot", godot_edit: "godot",
  unreal_inspect_level: "unreal", unreal_apply_material: "unreal", unreal_blockout: "unreal", unreal_vfx: "unreal", level_move: "unreal", level_arrange: "unreal", level_describe: "unreal", level_check: "unreal",
};

/** The engine's name for the card and panel. */
export const ENGINE_TITLE: Record<SceneEngine, { he: string; en: string }> = {
  unity: { he: "סצנת Unity", en: "Unity scene" },
  unreal: { he: "שלב Unreal", en: "Unreal level" },
  godot: { he: "סצנת Godot", en: "Godot scene" },
};

/**
 * The scene a tool step touched.
 *
 * @param tool - The tool's name; `ok` and `output` its result.
 * @returns The engine as the item's id, or undefined for a tool that is not a scene tool or failed.
 */
export function sceneFromResult(tool: string, ok: boolean, _output: string): SceneEngine | undefined {
  return ok ? SCENE_TOOLS[tool] : undefined;
}

/** One object of the hierarchy. */
export interface HNode {
  /** Its name as the engine shows it. */
  name: string;
  /** Its path from the root, with `/` (what a tool addresses it by). */
  path: string;
  /** Its class ("Cube", "StaticMeshActor", "Node2D"), when the tool said. */
  type?: string;
  /** The engine's id ("#123" in Unity), when known. */
  id?: string;
  inactive?: boolean;
  /** Children the tool did not list (a Unity hierarchy cut at its depth). */
  hidden?: number;
  children: HNode[];
}

/** A hierarchy read from a tool result. */
export interface Hierarchy { scene?: string; nodes: HNode[] }

const MAX_NODES = 2000;

/**
 * Reads `unity_scene hierarchy`: "Scene: <path>" lines, then one line per object: two spaces per level, `name #id
 * (n children)`, `(inactive)`.
 *
 * @param text - The tool's output.
 */
export function parseUnityHierarchy(text: string): Hierarchy {
  const nodes: HNode[] = [];
  const stack: HNode[] = [];
  let scene: string | undefined;
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    const sc = /^Scene: (.+?)(?: \(unsaved changes\))?$/.exec(line);
    if (sc) { scene ??= sc[1]; continue; }
    const m = /^( *)(.+?) #(-?\d+)(?: \((\d+) children(, not shown)?\))?( \(inactive\))?$/.exec(line);
    if (!m || count >= MAX_NODES) continue;
    count++;
    const depth = Math.floor(m[1]!.length / 2);
    const parent = stack[depth - 1];
    const name = m[2]!;
    const node: HNode = { name, path: parent ? `${parent.path}/${name}` : name, id: m[3]!, children: [] };
    if (m[6]) node.inactive = true;
    if (m[5] && m[4]) node.hidden = Number(m[4]);
    (parent ? parent.children : nodes).push(node);
    stack.length = depth;
    stack[depth] = node;
  }
  return scene ? { scene, nodes } : { nodes };
}

/**
 * Reads `unreal_inspect_level`: a head line "<level>: N actors…", then one line per actor `Name [id] Class at (x, y, z)
 * … — mesh …; attached to Parent`. An actor attached to another is placed under it.
 *
 * @param text - The tool's output.
 */
export function parseUnrealActors(text: string): Hierarchy {
  const nodes: HNode[] = [];
  const byName = new Map<string, HNode>();
  const pending: Array<[HNode, string]> = [];
  let scene: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const head = /^(\/\S+?): \d+ actors/.exec(line);
    if (head) { scene = head[1]; continue; }
    if (/^\s/.test(line) || /^(…|Materials the level)/.test(line)) continue;
    const m = /^(\S+?)(?: \[([^\]]+)\])? ([A-Za-z_]\w*)(?: at \([^)]*\))?(.*)$/.exec(line);
    if (!m || byName.size >= MAX_NODES) continue;
    const node: HNode = { name: m[1]!, path: m[1]!, type: m[3]!, ...(m[2] ? { id: m[2] } : {}), children: [] };
    byName.set(node.name, node);
    const parent = /attached to (\S+)/.exec(m[4] ?? "")?.[1];
    if (parent) pending.push([node, parent]);
    else nodes.push(node);
  }
  for (const [node, parent] of pending) {
    const p = byName.get(parent);
    if (p && p !== node) { node.path = `${p.path}/${node.name}`; p.children.push(node); } else nodes.push(node);
  }
  return scene ? { scene, nodes } : { nodes };
}

/**
 * Reads `godot_tree`: JSON `{scene, root: {name, type, script?, children?}}`.
 *
 * @param text - The tool's output.
 */
export function parseGodotTree(text: string): Hierarchy {
  let raw: { scene?: unknown; root?: unknown };
  try { raw = JSON.parse(text) as typeof raw; } catch { return { nodes: [] }; }
  let count = 0;
  const walk = (v: unknown, base: string): HNode | undefined => {
    const o = (v ?? {}) as { name?: unknown; type?: unknown; children?: unknown };
    if (typeof o.name !== "string" || count++ >= MAX_NODES) return undefined;
    const path = base ? `${base}/${o.name}` : o.name;
    const kids = Array.isArray(o.children) ? o.children.map((c) => walk(c, path)).filter((c): c is HNode => !!c) : [];
    return { name: o.name, path, ...(typeof o.type === "string" ? { type: o.type } : {}), children: kids };
  };
  const root = walk(raw.root, "");
  const scene = typeof raw.scene === "string" && raw.scene ? raw.scene : undefined;
  return { ...(scene ? { scene } : {}), nodes: root ? [root] : [] };
}

/**
 * Reads a scene tool's output as a hierarchy.
 *
 * @param engine - Which engine's tool made it.
 * @param tool - The tool's name (only the tools that list objects are read).
 * @param output - Its output.
 * @returns The hierarchy, or undefined when this tool's output holds none.
 */
export function parseHierarchy(engine: SceneEngine, tool: string, output: string): Hierarchy | undefined {
  const h = engine === "unity" && tool === "unity_scene" ? parseUnityHierarchy(output)
    : engine === "unreal" && tool === "unreal_inspect_level" ? parseUnrealActors(output)
    : engine === "godot" && tool === "godot_tree" ? parseGodotTree(output)
    : undefined;
  return h && h.nodes.length ? h : undefined;
}

/**
 * How many objects a hierarchy holds.
 *
 * @param nodes - Its roots.
 */
export function countNodes(nodes: readonly HNode[]): number {
  return nodes.reduce((n, x) => n + 1 + countNodes(x.children), 0);
}

/**
 * Joins a later diff to an earlier one: the same object's later change replaces the earlier (an added object that
 * is removed later disappears), the objects come in the order first touched, the undo and plan are the latest.
 *
 * @param a - The diff so far (or none).
 * @param b - The next diff.
 */
export function mergeDiff(a: SceneDiff | undefined, b: SceneDiff): SceneDiff {
  if (!a) return b;
  const by = new Map<string, SceneObjectChange>();
  for (const o of a.objects) by.set(o.name, o);
  for (const o of b.objects) {
    const before = by.get(o.name);
    if (before?.kind === "added" && o.kind === "removed") by.delete(o.name);
    else if (before?.kind === "added" && o.kind === "changed") by.set(o.name, { ...before, props: [...(before.props ?? []), ...(o.props ?? [])] });
    else by.set(o.name, o);
  }
  return { ...b, scene: b.scene ?? a.scene, objects: [...by.values()], readBefore: a.readBefore && b.readBefore };
}

/** The part of an agent event the scene model reads. */
export interface SceneEvent { type: string; callId?: string; name?: string; ok?: boolean; output?: string; preview?: string }

/** What the scenes surface shows for one engine in one chat. */
export interface SceneModel {
  engine: SceneEngine;
  scene?: string;
  nodes: HNode[];
  /** Every change the agent made in this chat that went through, joined. */
  diff?: SceneDiff;
}

/**
 * The scene as one chat's events show it: the newest hierarchy a tool read, and the diffs of the changes that ran
 * (an approval whose tool step then succeeded; a denied or failed one is left out).
 *
 * @param engine - Which engine.
 * @param events - The chat's events, oldest first.
 */
export function sceneModel(engine: SceneEngine, events: readonly SceneEvent[]): SceneModel {
  const ran = new Set(events.filter((e) => e.type === "tool_result" && e.ok && e.callId).map((e) => e.callId));
  let h: Hierarchy | undefined;
  let diff: SceneDiff | undefined;
  for (const e of events) {
    if (e.type === "tool_result" && e.ok && e.name && SCENE_TOOLS[e.name] === engine) h = parseHierarchy(engine, e.name, e.output ?? "") ?? h;
    if (e.type === "approval_request" && e.preview && e.callId && ran.has(e.callId)) {
      const p = parseScenePreview(e.preview);
      if (p && p.diff.engine === engine) diff = mergeDiff(diff, p.diff);
    }
  }
  const scene = diff?.scene ?? h?.scene;
  return { engine, ...(scene ? { scene } : {}), nodes: h?.nodes ?? [], ...(diff ? { diff } : {}) };
}

/**
 * Which objects of the hierarchy the diff touches, by name or by path.
 *
 * @param diff - The joined diff (or none).
 * @returns A lookup from an object's name or path to its kind of change.
 */
export function changeMarks(diff: SceneDiff | undefined): Map<string, SceneObjectChange["kind"]> {
  const m = new Map<string, SceneObjectChange["kind"]>();
  for (const o of diff?.objects ?? []) m.set(o.name, o.kind);
  return m;
}

/**
 * A short line for the card: "42 objects · +2 −0 ~3".
 *
 * @param model - The scene model.
 */
export function sceneSummary(model: SceneModel): { objects: number; added: number; removed: number; changed: number } {
  const c = model.diff ? sceneCounts(model.diff) : { added: 0, removed: 0, changed: 0 };
  return { objects: countNodes(model.nodes), ...c };
}

/**
 * The chat message for "Ask about this object": the engine, the scene, the object's path, and its changed values.
 *
 * @param p - `engine`, `scene`, `object` (its path), `change` (the diff's entry for it, when it has one),
 *   `instruction` and `he`.
 */
export function objectAskMessage(p: { engine: SceneEngine; scene?: string; object: string; change?: SceneObjectChange; instruction: string; he: boolean }): string {
  const e = ENGINE_TITLE[p.engine];
  const where = `${p.he ? e.he : e.en}${p.scene ? ` ${p.scene}` : ""}`;
  const obj = p.object.slice(0, 300);
  const lines = (p.change?.props ?? []).slice(0, 12).map((x) => `  ${x.name}: ${x.from !== undefined ? `${x.from} → ` : ""}${x.to}`);
  const changed = p.change ? `\n${p.he ? "שינוי" : "Change"}: ${p.change.kind}${lines.length ? `\n${lines.join("\n")}` : ""}` : "";
  const ask = p.instruction.trim();
  return p.he ? `ב${where}, על האובייקט "${obj}":${changed}\n\n${ask}` : `In the ${where}, about the object "${obj}":${changed}\n\n${ask}`;
}
