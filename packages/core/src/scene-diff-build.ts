/**
 * The scene diffs the engine tools put on their approval cards (shared/scene-diff.ts): built from a tool's arguments
 * and, where the editor answers, a read of the scene as it is now (old → new). Pure: the tools do the reading.
 */
import type { SceneDiff, SceneObjectChange, SceneProp, SceneUndo } from "@kesher/shared";
import type { SceneChange } from "./unity-edit-tools.js";

/** What the Unity Editor read before a change (`beforeCs`): the object's path and id, and the old value. */
export interface UnityBefore {
  path: string;
  old?: string;
}

/**
 * Reads `beforeCs`'s answer.
 *
 * @param text - The Editor's output, one line per change.
 * @param count - How many changes were asked about.
 * @returns One entry per change (undefined where the object was not found), or undefined when the answer does not fit.
 */
export function parseUnityBefore(text: string, count: number): Array<UnityBefore | undefined> | undefined {
  const lines = text.replace(/\r/g, "").replace(/\n+$/, "").split("\n").slice(0, count);
  if (lines.length < count) return undefined;
  return lines.map((l) => {
    if (l.trim() === "(not found)") return undefined;
    const tab = l.indexOf("\t");
    if (tab < 0) return { path: l.trim() };
    const old = l.slice(tab + 1);
    return { path: l.slice(0, tab).trim(), ...(old ? { old } : {}) };
  });
}

const vec = (v: unknown) => (Array.isArray(v) ? `(${v.join(", ")})` : typeof v === "string" ? v : JSON.stringify(v));

/** The property a Unity change sets, as the card names it. */
function unityProp(c: SceneChange): string {
  switch (c.action) {
    case "move": return c.space === "world" ? "world position" : "position";
    case "rotate": return c.space === "world" ? "world rotation" : "rotation";
    case "scale": return "scale";
    case "rename": return "name";
    case "reparent": return "parent";
    case "set_active": return "active";
    case "set_property": return `${c.component}.${c.property}`;
    case "delete": return "";
  }
}

/** Finds or makes the entry for one object, keeping the order the objects first appear in. */
function entry(list: SceneObjectChange[], name: string, kind: SceneObjectChange["kind"] = "changed"): SceneObjectChange {
  let o = list.find((x) => x.name === name);
  if (!o) {
    o = { kind, name };
    list.push(o);
  }
  return o;
}

/**
 * The diff of a `unity_modify_scene` call.
 *
 * @param changes - The checked changes.
 * @param before - What the Editor read before (per change), or undefined when it did not answer.
 * @param scene - The open scene's path, when known.
 * @returns The diff (Unity changes are one undo step in the Editor).
 */
export function unityModifyDiff(changes: SceneChange[], before: Array<UnityBefore | undefined> | undefined, scene?: string): SceneDiff {
  const objects: SceneObjectChange[] = [];
  changes.forEach((c, i) => {
    const b = before?.[i];
    const o = entry(objects, b?.path ?? c.object);
    if (c.action === "delete") {
      o.kind = "removed";
      delete o.props;
      return;
    }
    if (o.kind === "removed") return;
    const to = c.action === "reparent" ? (c.value ? String(c.value) : "(top)") : vec(c.value);
    const props = (o.props ??= []);
    const name = unityProp(c);
    const same = props.find((p) => p.name === name);
    // Two changes of one value: the card shows the first old value and the last new one.
    if (same) same.to = to;
    else props.push({ name, ...(b?.old !== undefined ? { from: b.old } : {}), to });
  });
  return { engine: "unity", ...(scene ? { scene } : {}), objects, undo: "undo", readBefore: !!before };
}

/**
 * The diff of a `unity_create_gameobject` call (nothing to read: the object is new).
 *
 * @param input - The tool's input.
 */
export function unityCreateDiff(input: Record<string, unknown>): SceneDiff {
  const name = String(input.name ?? "").trim().slice(0, 120) || "GameObject";
  const parent = typeof input.parent === "string" && input.parent.trim() ? input.parent.trim() : "";
  const comps = Array.isArray(input.components) ? input.components.map(String).filter(Boolean) : [];
  const props: SceneProp[] = [];
  if (parent) props.push({ name: "parent", to: parent });
  if (Array.isArray(input.position)) props.push({ name: "position", to: vec(input.position) });
  const o: SceneObjectChange = { kind: "added", name: parent ? `${parent}/${name}` : name, ...(typeof input.primitive === "string" ? { type: input.primitive } : {}), ...(comps.length ? { components: { added: comps } } : {}), ...(props.length ? { props } : {}) };
  return { engine: "unity", objects: [o], undo: "undo", readBefore: true };
}

/**
 * The diff of a `unity_add_component` call.
 *
 * @param input - The tool's input.
 */
export function unityAddComponentDiff(input: Record<string, unknown>): SceneDiff {
  const comps = Array.isArray(input.components) ? input.components.map(String).filter(Boolean) : [];
  return { engine: "unity", objects: [{ kind: "changed", name: String(input.gameObject ?? "").slice(0, 300), components: { added: comps } }], undo: "undo", readBefore: true };
}

/**
 * The diff of a `godot_edit` call.
 *
 * @param ops - The tool's ops.
 * @param current - A node's properties as the editor has them now (`godot_get`), by node path; missing when unread.
 * @param scene - The open scene (res://…), when known.
 */
export function godotEditDiff(ops: Array<Record<string, unknown>>, current: Record<string, Record<string, unknown> | undefined>, scene?: string): SceneDiff {
  const objects: SceneObjectChange[] = [];
  const nodeName = (p: unknown) => String(p ?? "") || "(root)";
  for (const o of ops) {
    switch (o.op) {
      case "add": {
        const parent = String(o.parent ?? "");
        const name = String(o.name ?? o.type ?? "Node");
        objects.push({ kind: "added", name: parent ? `${parent}/${name}` : name, ...(o.type ? { type: String(o.type) } : {}) });
        break;
      }
      case "remove":
        entry(objects, nodeName(o.path)).kind = "removed";
        break;
      case "set":
      case "attach_script": {
        const e = entry(objects, nodeName(o.path));
        if (e.kind === "removed") break;
        const prop = o.op === "set" ? String(o.property ?? "") : "script";
        const to = o.op === "set" ? (typeof o.value === "string" ? o.value : JSON.stringify(o.value ?? null)) : String(o.script ?? "");
        const old = current[String(o.path ?? "")]?.[prop];
        const props = (e.props ??= []);
        const same = props.find((p) => p.name === prop);
        if (same) same.to = to;
        else props.push({ name: prop, ...(old !== undefined && old !== null ? { from: typeof old === "string" ? old : JSON.stringify(old) } : {}), to });
        break;
      }
    }
  }
  const sets = ops.filter((o) => o.op === "set" || o.op === "attach_script");
  return { engine: "godot", ...(scene ? { scene } : {}), objects, undo: "undo", readBefore: sets.every((o) => current[String(o.path ?? "")] !== undefined) };
}

/** One mesh component's material slots, as `unreal_inspect_level` reads them. */
export interface UnrealSlots {
  component: string;
  /** Slot name or index → the material's object path ("" for none). */
  materials: Array<{ slot: string; material: string }>;
}

/**
 * The diff of an `unreal_apply_material` call.
 *
 * @param o.level - The level.
 * @param o.actor - The actor's label or id.
 * @param o.component - The mesh component ("" = the first).
 * @param o.slot - The slot (index or name).
 * @param o.material - The new material's object path.
 * @param o.slots - The actor's mesh components and their materials now, when read.
 * @param o.undo - "undo" when the editor is open, "queued" when it is closed.
 */
export function unrealMaterialDiff(o: { level: string; actor: string; actorClass?: string; component: string; slot: string; material: string; slots?: UnrealSlots[]; undo: SceneUndo }): SceneDiff {
  const comp = o.slots ? (o.component ? o.slots.find((s) => s.component === o.component) : o.slots[0]) : undefined;
  const slot = comp?.materials.find((m, i) => m.slot === o.slot || String(i) === o.slot);
  const label = `${comp?.component ?? (o.component || "Mesh")} slot ${o.slot}`;
  const prop: SceneProp = { name: label, ...(slot ? { from: slot.material || "None" } : {}), to: o.material };
  return { engine: "unreal", scene: o.level, objects: [{ kind: "changed", name: o.actor, ...(o.actorClass ? { type: o.actorClass } : {}), props: [prop] }], undo: o.undo, readBefore: !!slot };
}
