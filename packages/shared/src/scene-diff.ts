/**
 * What a game-engine tool will change in a scene, for the approval card (WORK_LIST "Approval card shows the diff or
 * object list for Unity scene changes"): the objects added, removed and changed, each change as old → new values, and
 * how it can be undone. Unity, Unreal and Godot tools build it from their arguments and a read of the scene as it is.
 *
 * It travels inside the approval request's `preview` text (no new event field): a readable text first, so every client
 * that only shows text still shows the list, then one marker line with the same diff as JSON for the card.
 *
 * Pure (no engine access).
 */

/** The engine a scene belongs to. */
export type SceneEngine = "unity" | "unreal" | "godot";

/** One value that changes: `from` is missing when the old value could not be read (or the object is new). */
export interface SceneProp {
  /** The property, e.g. "position", "Rigidbody.m_Mass", "Mesh slot 0". */
  name: string;
  from?: string;
  to: string;
}

/** One object of the scene the change touches. */
export interface SceneObjectChange {
  kind: "added" | "removed" | "changed";
  /** Its path or label as the engine shows it ("Level/Door", "BP_Door_2"). */
  name: string;
  /** Its class or type ("Cube", "StaticMeshActor", "Node2D"), when known. */
  type?: string;
  /** Components (Unity), nodes (Godot) or actor components (Unreal) added to it or removed from it. */
  components?: { added?: string[]; removed?: string[] };
  props?: SceneProp[];
}

/**
 * How the change can be taken back:
 * - `undo`: one undo step in the open editor (Ctrl+Z there), and a checkpoint when the scene is saved;
 * - `checkpoint`: the scene's file is kept in this chat's checkpoint before it runs (↺ in the chat);
 * - `queued`: the editor is closed, so it waits and is applied at the next sync, with a checkpoint first.
 */
export type SceneUndo = "undo" | "checkpoint" | "queued";

/** Everything the approval card shows about a scene change. */
export interface SceneDiff {
  engine: SceneEngine;
  /** The scene or level ("Assets/Main.unity", "/Game/Maps/Arena", "res://main.tscn"), when known. */
  scene?: string;
  objects: SceneObjectChange[];
  undo: SceneUndo;
  /** The old values were read from the scene (false: the editor did not answer, so only the new values are known). */
  readBefore: boolean;
}

/** The marker line that carries the diff inside a preview. */
const MARK = "<!--kesher-scene ";
const END = "-->";
const MAX_OBJECTS = 60;
const MAX_PROPS = 30;
const MAX_TEXT = 300;

const ENGINE_NAME: Record<SceneEngine, string> = { unity: "Unity scene", unreal: "Unreal level", godot: "Godot scene" };
const SIGN: Record<SceneObjectChange["kind"], string> = { added: "+", removed: "-", changed: "~" };

/**
 * How many objects of each kind a diff has.
 *
 * @param d - The diff.
 * @returns Counts of added, removed and changed objects.
 */
export function sceneCounts(d: SceneDiff): { added: number; removed: number; changed: number } {
  const n = (k: SceneObjectChange["kind"]) => d.objects.filter((o) => o.kind === k).length;
  return { added: n("added"), removed: n("removed"), changed: n("changed") };
}

/**
 * The diff as plain English lines (the text part of the preview, also what the inbox and notifications show).
 *
 * @param d - The diff.
 * @returns e.g. "Unity scene Assets/Main.unity: 1 added, 1 changed\n+ Enemy (Cube) +Rigidbody\n~ Player: position (0, 0, 0) → (1, 2, 3)".
 */
export function sceneDiffText(d: SceneDiff): string {
  const c = sceneCounts(d);
  const counts = [c.added && `${c.added} added`, c.removed && `${c.removed} removed`, c.changed && `${c.changed} changed`].filter(Boolean).join(", ");
  const lines = [`${ENGINE_NAME[d.engine]}${d.scene ? ` ${d.scene}` : ""}: ${counts || "no objects"}`];
  for (const o of d.objects) {
    const comps = [...(o.components?.added ?? []).map((x) => `+${x}`), ...(o.components?.removed ?? []).map((x) => `-${x}`)].join(" ");
    lines.push(`${SIGN[o.kind]} ${o.name}${o.type ? ` (${o.type})` : ""}${comps ? ` ${comps}` : ""}`);
    for (const p of o.props ?? []) lines.push(`    ${p.name}: ${p.from !== undefined ? `${p.from} → ` : ""}${p.to}`);
  }
  return lines.join("\n");
}

/**
 * The approval preview for a scene change: the readable text, then the marker line with the diff for the card.
 *
 * @param d - The diff.
 * @returns The preview text.
 */
export function scenePreview(d: SceneDiff): string {
  // ">" is written as > (only inside JSON strings, where it means the same), so a name can never end the marker.
  return `${sceneDiffText(d)}\n${MARK}${JSON.stringify(d).replace(/>/g, "\\u003e")}${END}`;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v.slice(0, MAX_TEXT) : undefined);
const strs = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.slice(0, MAX_PROPS).map(str).filter((x): x is string => x !== undefined) : undefined);

/** A checked copy of one object (the preview text comes from a tool, so its shape is not trusted blindly). */
function cleanObject(v: unknown): SceneObjectChange | undefined {
  const o = (v ?? {}) as Record<string, unknown>;
  const kind = o.kind === "added" || o.kind === "removed" || o.kind === "changed" ? o.kind : undefined;
  const name = str(o.name);
  if (!kind || !name) return undefined;
  const out: SceneObjectChange = { kind, name };
  const type = str(o.type);
  if (type) out.type = type;
  const comps = (o.components ?? {}) as Record<string, unknown>;
  const added = strs(comps.added);
  const removed = strs(comps.removed);
  if (added?.length || removed?.length) out.components = { ...(added?.length ? { added } : {}), ...(removed?.length ? { removed } : {}) };
  if (Array.isArray(o.props)) {
    const props: SceneProp[] = [];
    for (const raw of o.props.slice(0, MAX_PROPS)) {
      const p = (raw ?? {}) as Record<string, unknown>;
      const pn = str(p.name);
      const to = str(p.to);
      if (!pn || to === undefined) continue;
      const from = str(p.from);
      props.push({ name: pn, ...(from !== undefined ? { from } : {}), to });
    }
    if (props.length) out.props = props;
  }
  return out;
}

/**
 * Finds the scene diff in an approval preview.
 *
 * @param preview - The approval request's preview.
 * @returns The diff and the text before the marker, or undefined when the preview has none (or it is broken).
 */
export function parseScenePreview(preview: string): { diff: SceneDiff; text: string } | undefined {
  const at = preview.lastIndexOf(`\n${MARK}`);
  if (at < 0 || !preview.endsWith(END)) return undefined;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(preview.slice(at + 1 + MARK.length, -END.length)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const engine = raw.engine === "unity" || raw.engine === "unreal" || raw.engine === "godot" ? raw.engine : undefined;
  const undo = raw.undo === "undo" || raw.undo === "checkpoint" || raw.undo === "queued" ? raw.undo : undefined;
  if (!engine || !undo || !Array.isArray(raw.objects)) return undefined;
  const objects = raw.objects.slice(0, MAX_OBJECTS).map(cleanObject).filter((o): o is SceneObjectChange => !!o);
  const scene = str(raw.scene);
  return { diff: { engine, ...(scene ? { scene } : {}), objects, undo, readBefore: raw.readBefore === true }, text: preview.slice(0, at) };
}

/**
 * A preview without its scene marker line (for places that show the preview as text: the inbox, notifications).
 *
 * @param preview - The approval request's preview.
 * @returns The text part.
 */
export function previewText(preview: string): string {
  return parseScenePreview(preview)?.text ?? preview;
}
