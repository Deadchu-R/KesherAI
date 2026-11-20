import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { COMPONENTS } from "./unity-scene.js";
import { realInside } from "./game-checkpoints.js";

/**
 * Inspector values with the engine closed (RESEARCH_LOG "Gap list: engine work without the engine open", 2026-11-20,
 * step 6): the components and property values of Unity's text YAML (.unity scenes, .prefab, .asset, .mat) and Godot's
 * .tscn / .tres, read as text; a value changed in KesherAI is queued (never written at once) and goes in at the next
 * sync while the engine is closed, with a clash check: when the value in the file is no longer the one it was changed
 * from, the change waits for Roee's choice on the Sync and conflicts sheet. Only the one line of that value is
 * changed; the rest of the file stays byte for byte.
 */

/** One property value. */
export interface InspectorField {
  /** The property's name in the file (Unity: m_Mass; Godot: mass). */
  name: string;
  /** Its text in the file (Unity YAML or Godot's own form). */
  value: string;
  /** Whether it can be changed here: a number, true/false, a text, or a vector/colour; not references or lists. */
  editable: boolean;
}

/** One component (Unity) or one node's own properties (Godot). */
export interface InspectorComponent {
  /** The change target: Unity's file id of the component; Godot's node path, "resource" or "sub:<id>". */
  target: string;
  type: string;
  /** A Unity script's GUID (resolved to its file by the route). */
  script?: string;
  /** A Godot node's script (res://…). */
  scriptPath?: string;
  fields: InspectorField[];
}

/** One object: a GameObject, a placed prefab, a Godot node, or an asset's own data. */
export interface InspectorObject {
  id: string;
  name: string;
  /** The parent object's id (absent at the top). */
  parent?: string;
  components: InspectorComponent[];
  /** A placed prefab (Unity) or an instanced scene (Godot): its source and the values changed on this copy. */
  prefab?: { source?: string; overrides: Array<{ target: string; name: string; value: string }> };
}

/** Unity classes the outliner list does not name, by class id. */
const MORE_CLASSES: Record<string, string> = { "1": "GameObject", "4": "Transform", "21": "Material", "114": "MonoBehaviour", "224": "RectTransform", "1001": "PrefabInstance", "1660057539": "SceneRoots" };
/** Unity's bookkeeping fields: never shown. */
const HIDDEN = new Set(["m_ObjectHideFlags", "m_CorrespondingSourceObject", "m_PrefabInstance", "m_PrefabAsset", "m_GameObject", "serializedVersion", "m_EditorHideFlags", "m_EditorClassIdentifier", "m_Script", "m_Children", "m_Father", "m_Component", "m_Modification", "m_SourcePrefab"]);
const UNITY_NUM = /^-?\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i;
const INLINE = /^\{[^{}\n]*\}$/;

/** The fields of one Unity YAML document (its lines at the first level of the object). */
function unityFields(doc: string): InspectorField[] {
  const out: InspectorField[] = [];
  const lines = doc.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const m = /^ {2}(\w+):(?: (.*))?$/.exec(lines[i]!);
    if (!m || HIDDEN.has(m[1]!)) continue;
    const value = (m[2] ?? "").trim();
    // A block below (a list or a map): shown in short, not editable.
    if (!value) {
      let n = 0;
      while (i + 1 < lines.length && /^ {2}(?: |- )/.test(lines[i + 1]!)) {
        i++;
        if (/^ {2}- /.test(lines[i]!)) n++;
      }
      out.push({ name: m[1]!, value: n ? `[${n}]` : "{…}", editable: false });
      continue;
    }
    out.push({ name: m[1]!, value, editable: unityEditable(value) });
  }
  return out;
}

/** Whether a Unity YAML value is one line that can be changed safely (no reference, no list). */
function unityEditable(value: string): boolean {
  if (/fileID:/.test(value)) return false;
  if (INLINE.test(value)) return true;
  return !value.startsWith("[") && !value.startsWith("|") && !value.startsWith(">") && value.length <= 500;
}

/**
 * The objects of a Unity text asset: GameObjects with their components and values, placed prefabs with their
 * overrides, and (for .asset / .mat) the asset's own objects.
 *
 * @param text - The file (Force Text YAML).
 * @returns The objects, in file order.
 */
export function readUnityInspector(text: string): InspectorObject[] {
  if (!/^%YAML/.test(text) || !/--- !u!/.test(text)) throw new Error("This is not a Unity file saved as text (Edit → Project Settings → Editor → Asset Serialization: Force Text).");
  const docs = new Map<string, { cls: string; body: string; stripped: boolean }>();
  for (const d of text.split(/^--- !u!/m).slice(1)) {
    const head = /^(\d+) &(-?\d+)( stripped)?/.exec(d);
    if (head) docs.set(head[2]!, { cls: head[1]!, body: d, stripped: !!head[3] });
  }
  const field = (body: string, k: string) => new RegExp(`^ {2}${k}:\\s*(.*)$`, "m").exec(body)?.[1];
  const fileId = (s?: string) => /fileID:\s*(-?\d+)/.exec(s ?? "")?.[1];
  const guid = (s?: string) => /guid:\s*([0-9a-f]{32})/.exec(s ?? "")?.[1];
  const typeOf = (cls: string) => COMPONENTS[cls] ?? MORE_CLASSES[cls] ?? `Class ${cls}`;
  const owned = new Set<string>();
  const out: InspectorObject[] = [];
  // Transform id → its GameObject, for the parents.
  const goOfTransform = new Map<string, string>();
  for (const [id, d] of docs) if ((d.cls === "4" || d.cls === "224") && !d.stripped) goOfTransform.set(id, fileId(field(d.body, "m_GameObject")) ?? "0");
  const parentOfGo = new Map<string, string>();
  for (const [id, d] of docs) {
    if ((d.cls !== "4" && d.cls !== "224") || d.stripped) continue;
    const father = fileId(field(d.body, "m_Father"));
    const go = goOfTransform.get(id);
    if (go && father && father !== "0" && goOfTransform.get(father)) parentOfGo.set(go, goOfTransform.get(father)!);
  }
  for (const [id, d] of docs) {
    if (d.cls !== "1" || d.stripped) continue;
    const comps = [...d.body.matchAll(/- component:\s*\{fileID:\s*(-?\d+)/g)].map((m) => m[1]!);
    const components: InspectorComponent[] = [];
    for (const c of comps) {
      const cd = docs.get(c);
      if (!cd || cd.stripped) continue;
      owned.add(c);
      const script = cd.cls === "114" ? guid(field(cd.body, "m_Script")) : undefined;
      components.push({ target: c, type: typeOf(cd.cls), ...(script ? { script } : {}), fields: unityFields(cd.body) });
    }
    const go: InspectorObject = { id, name: (field(d.body, "m_Name") ?? "").trim() || `Object ${id}`, components: [{ target: id, type: "GameObject", fields: unityFields(d.body).filter((f) => f.name !== "m_Name") }, ...components] };
    const parent = parentOfGo.get(id);
    if (parent) go.parent = parent;
    owned.add(id);
    out.push(go);
  }
  for (const [id, d] of docs) {
    if (d.cls !== "1001") continue;
    owned.add(id);
    const overrides = [...d.body.matchAll(/- target:\s*(\{[^}]*\})\s*\n\s*propertyPath:\s*(\S+)\s*\n\s*value:\s*(.*)/g)].map((m) => ({ target: fileId(m[1]) ?? "0", name: m[2]!, value: m[3]!.trim() }));
    const name = overrides.find((o) => o.name === "m_Name")?.value;
    const source = guid(field(d.body, "m_SourcePrefab"));
    out.push({ id, name: name || `Prefab ${id}`, components: [], prefab: { ...(source ? { source } : {}), overrides: overrides.slice(0, 300) } });
  }
  // An asset's own data (a ScriptableObject, a material, settings): documents that belong to no GameObject.
  for (const [id, d] of docs) {
    if (owned.has(id) || d.stripped || d.cls === "4" || d.cls === "224" || d.cls === "1660057539") continue;
    if (fileId(field(d.body, "m_GameObject")) && fileId(field(d.body, "m_GameObject")) !== "0") continue;
    const script = d.cls === "114" ? guid(field(d.body, "m_Script")) : undefined;
    out.push({ id, name: (field(d.body, "m_Name") ?? "").trim() || typeOf(d.cls), components: [{ target: id, type: typeOf(d.cls), ...(script ? { script } : {}), fields: unityFields(d.body) }] });
  }
  return out;
}

/** The section of one Unity document: [start, end) offsets in the text. */
function unityDoc(text: string, target: string): [number, number] | undefined {
  const re = new RegExp(`^--- !u!\\d+ &${target.replace(/[^\d-]/g, "")}\\b.*$`, "m");
  const m = re.exec(text);
  if (!m) return undefined;
  const next = text.indexOf("\n--- !u!", m.index + 1);
  return [m.index, next < 0 ? text.length : next + 1];
}

/**
 * A value's text in a Unity file.
 *
 * @param text - The file.
 * @param target - The document's file id.
 * @param name - The field.
 * @returns Its text, or undefined when it is not there.
 */
export function unityValue(text: string, target: string, name: string): string | undefined {
  const r = unityDoc(text, target);
  if (!r || !/^\w+$/.test(name)) return undefined;
  return new RegExp(`^ {2}${name}: (.*)$`, "m").exec(text.slice(r[0], r[1]))?.[1]?.replace(/\r$/, "").trim();
}

/**
 * The text a new Unity value is written as, checked against the old one's kind.
 *
 * @param from - The value as it is in the file.
 * @param to - The new value, as typed.
 * @returns The text to write.
 * @throws When it does not fit (a number for a number, a {x: …} map for a map, one line).
 */
export function unityText(from: string, to: string): string {
  const v = to.trim();
  if (/[\r\n]/.test(v) || v.length > 500) throw new Error("One line, under 500 characters.");
  if (UNITY_NUM.test(from)) {
    if (!UNITY_NUM.test(v)) throw new Error("This value is a number.");
    return v;
  }
  if (INLINE.test(from)) {
    const keys = (s: string) => [...s.matchAll(/(\w+):/g)].map((m) => m[1]).join(",");
    if (!INLINE.test(v) || /fileID/.test(v) || keys(v) !== keys(from) || ![...v.matchAll(/:\s*([^,}]*)/g)].every((m) => UNITY_NUM.test(m[1]!.trim()))) throw new Error(`Write it as ${from.replace(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi, "n")} with numbers.`);
    return v;
  }
  // A text: quoted when YAML would read it as something else.
  return /^[\w .,()/-]*$/.test(v) && !/^[\s-]|\s$/.test(v) && v !== "" ? v : `'${v.replace(/'/g, "''")}'`;
}

/**
 * A Unity file with one value changed (only that line).
 *
 * @param text - The file.
 * @param target - The document's file id.
 * @param name - The field.
 * @param value - The text to write (from {@link unityText}).
 * @returns The new file.
 */
export function setUnityValue(text: string, target: string, name: string, value: string): string {
  const r = unityDoc(text, target);
  if (!r || !/^\w+$/.test(name)) throw new Error("That value is not in the file.");
  const doc = text.slice(r[0], r[1]);
  const re = new RegExp(`^( {2}${name}: )(.*?)(\\r?)$`, "m");
  if (!re.test(doc)) throw new Error("That value is not in the file.");
  return text.slice(0, r[0]) + doc.replace(re, (_m, a: string, _old: string, cr: string) => `${a}${value}${cr}`) + text.slice(r[1]);
}

// ---------- Godot ----------

const GODOT_NUM = /^-?\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i;
const GODOT_CTOR = /^(Vector[234]i?|Color|Rect2i?|Quaternion|Plane|AABB|Basis|Transform[23]D|Projection)\(([-\d.,\se]*)\)$/i;
const attr = (head: string, key: string) => new RegExp(`\\b${key}="((?:[^"\\\\]|\\\\.)*)"`).exec(head)?.[1];

/** Whether a Godot value can be changed here: a number, true/false, a "text", or a vector/colour of numbers. */
function godotEditable(v: string): boolean {
  return GODOT_NUM.test(v) || v === "true" || v === "false" || (/^"(?:[^"\\]|\\.)*"$/.test(v) && v.length <= 500) || GODOT_CTOR.test(v);
}

/** The target of a section ("node path", "resource", "sub:<id>"), or undefined for sections without values to show. */
function godotTarget(kind: string, head: string): { target: string; name: string; type: string; parent?: string; instance?: string } | undefined {
  if (kind === "node") {
    const name = attr(head, "name") ?? "";
    const parent = attr(head, "parent");
    const path = parent === undefined ? "." : parent === "." ? name : `${parent}/${name}`;
    const instance = /instance=ExtResource\("([^"]+)"\)/.exec(head)?.[1];
    return { target: path, name, type: attr(head, "type") ?? (instance ? "Instance" : "Node"), ...(parent !== undefined ? { parent } : {}), ...(instance ? { instance } : {}) };
  }
  if (kind === "resource") return { target: "resource", name: "Resource", type: attr(head, "type") ?? "Resource" };
  if (kind === "sub_resource") {
    const id = attr(head, "id") ?? "";
    return { target: `sub:${id}`, name: `${attr(head, "type") ?? "SubResource"} ${id}`, type: attr(head, "type") ?? "SubResource" };
  }
  return undefined;
}

/**
 * The nodes and resources of a Godot .tscn or .tres, with their saved values (Godot saves only the ones changed from
 * the default).
 *
 * @param text - The file.
 * @returns The objects, in file order.
 */
export function readGodotInspector(text: string): InspectorObject[] {
  if (!/^\[gd_(scene|resource)\b/m.test(text)) throw new Error("This is not a Godot scene or resource (.tscn, .tres).");
  const ext = new Map<string, string>();
  const out: InspectorObject[] = [];
  let cur: InspectorObject | undefined;
  for (const line of text.split(/\r?\n/)) {
    const head = /^\[(\w+)\s*(.*)\]\s*$/.exec(line);
    if (head) {
      cur = undefined;
      if (head[1] === "ext_resource") {
        const id = attr(head[2] ?? "", "id"), path = attr(head[2] ?? "", "path");
        if (id && path) ext.set(id, path);
        continue;
      }
      const t = godotTarget(head[1]!, head[2] ?? "");
      if (!t) continue;
      cur = { id: t.target, name: t.target === "." ? t.name || "." : t.name, components: [{ target: t.target, type: t.type, fields: [] }] };
      if (t.parent !== undefined) cur.parent = t.parent;
      if (t.instance) cur.prefab = { ...(ext.get(t.instance) ? { source: ext.get(t.instance)! } : {}), overrides: [] };
      out.push(cur);
      continue;
    }
    const kv = /^([\w/]+)\s*=\s*(.*)$/.exec(line);
    if (!cur || !kv) continue;
    const comp = cur.components[0]!;
    if (kv[1] === "script") {
      const id = /ExtResource\("([^"]+)"\)/.exec(kv[2]!)?.[1];
      if (id && ext.get(id)) comp.scriptPath = ext.get(id)!;
      continue;
    }
    // A multi-line value (an array or a dictionary over lines) is shown by its first line, not editable.
    const value = kv[2]!.trim();
    const field = { name: kv[1]!, value: value.length > 300 ? `${value.slice(0, 300)}…` : value, editable: godotEditable(value) };
    // (An instanced scene's values here are its overrides: they show as its own fields.)
    comp.fields.push(field);
  }
  return out;
}

/** The [start, end) lines of a Godot section by target. */
function godotSection(lines: string[], target: string): [number, number] | undefined {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const head = /^\[(\w+)\s*(.*)\]\s*$/.exec(lines[i]!);
    if (!head) continue;
    if (start >= 0) return [start, i];
    if (godotTarget(head[1]!, head[2] ?? "")?.target === target) start = i;
  }
  return start >= 0 ? [start, lines.length] : undefined;
}

/**
 * A value's text in a Godot file.
 *
 * @param text - The file.
 * @param target - The node path, "resource" or "sub:<id>".
 * @param name - The property.
 * @returns Its text, or undefined when it is not saved in the file.
 */
export function godotValue(text: string, target: string, name: string): string | undefined {
  const lines = text.split("\n");
  const r = godotSection(lines, target);
  if (!r) return undefined;
  for (let i = r[0] + 1; i < r[1]; i++) {
    const kv = /^([\w/]+)\s*=\s*(.*?)\r?$/.exec(lines[i]!);
    if (kv && kv[1] === name) return kv[2]!.trim();
  }
  return undefined;
}

/**
 * The text a new Godot value is written as, checked against the old one's kind.
 *
 * @param from - The value as it is in the file.
 * @param to - The new value, as typed (a text without its quotes).
 * @returns The text to write.
 * @throws When it does not fit.
 */
export function godotText(from: string, to: string): string {
  const v = to.trim();
  if (/[\r\n]/.test(v) || v.length > 500) throw new Error("One line, under 500 characters.");
  if (GODOT_NUM.test(from)) {
    if (!GODOT_NUM.test(v)) throw new Error("This value is a number.");
    return v;
  }
  if (from === "true" || from === "false") {
    if (v !== "true" && v !== "false") throw new Error("This value is true or false.");
    return v;
  }
  const ctor = GODOT_CTOR.exec(from);
  if (ctor) {
    const m = GODOT_CTOR.exec(v);
    const count = (s: string) => s.split(",").length;
    if (!m || m[1] !== ctor[1] || count(m[2]!) !== count(ctor[2]!) || !m[2]!.split(",").every((n) => GODOT_NUM.test(n.trim()))) throw new Error(`Write it as ${ctor[1]}(…) with ${count(ctor[2]!)} numbers.`);
    return v;
  }
  if (/^"(?:[^"\\]|\\.)*"$/.test(from)) {
    const plain = /^"(?:[^"\\]|\\.)*"$/.test(v) ? v.slice(1, -1).replace(/\\(["\\])/g, "$1") : v;
    return `"${plain.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  throw new Error("This value cannot be changed here.");
}

/**
 * A Godot file with one value changed (only that line).
 *
 * @param text - The file.
 * @param target - The node path, "resource" or "sub:<id>".
 * @param name - The property.
 * @param value - The text to write (from {@link godotText}).
 * @returns The new file.
 */
export function setGodotValue(text: string, target: string, name: string, value: string): string {
  const lines = text.split("\n");
  const r = godotSection(lines, target);
  if (r) {
    for (let i = r[0] + 1; i < r[1]; i++) {
      const kv = /^([\w/]+)(\s*=\s*)(.*?)(\r?)$/.exec(lines[i]!);
      if (kv && kv[1] === name) {
        lines[i] = `${kv[1]}${kv[2]}${value}${kv[4]}`;
        return lines.join("\n");
      }
    }
  }
  throw new Error("That value is not in the file.");
}

// ---------- The queue ----------

/** A value changed in KesherAI, waiting for the next sync with the engine closed. */
export interface ValueEdit {
  id: string;
  engine: "unity" | "godot";
  /** The project folder. */
  project: string;
  /** The file, relative to the project ("Assets/Player.prefab", "scenes/main.tscn"). */
  file: string;
  /** The object's name, for the lists. */
  object: string;
  target: string;
  name: string;
  /** The value it was changed from (the clash check) and to (already in the file's own form). */
  from: string;
  to: string;
  at: string;
  /** The value in the file was no longer `from` at a sync: waits for a choice. */
  clash?: { now: string; at: string };
  decision?: "mine" | "skip";
}

/** How a file's value is read and set, per engine. */
const ENGINES = {
  unity: { get: unityValue, set: setUnityValue, text: unityText },
  godot: { get: godotValue, set: setGodotValue, text: godotText },
} as const;

/**
 * The text a typed value is written as, for an engine.
 *
 * @param engine - unity or godot.
 * @param from - The value now.
 * @param to - As typed.
 */
export function valueText(engine: ValueEdit["engine"], from: string, to: string): string {
  return ENGINES[engine].text(from, to);
}

/**
 * Applies a file's queued values to its text: each one whose value is still `from` (or chosen "mine"); the others
 * become clashes (or stay, when already clashing or skipped).
 *
 * @param text - The file now.
 * @param edits - That file's queued values.
 * @returns The new text, the ones applied, and the ones newly clashing (their clash set).
 */
export function applyValues(text: string, edits: ValueEdit[]): { text: string; applied: ValueEdit[]; clashes: ValueEdit[] } {
  let out = text;
  const applied: ValueEdit[] = [];
  const clashes: ValueEdit[] = [];
  for (const e of edits) {
    if (e.decision === "skip" || (e.clash && e.decision !== "mine")) continue;
    const io = ENGINES[e.engine];
    const now = io.get(out, e.target, e.name);
    if (now === undefined) {
      // Gone from the file (the object was removed, or the value went back to its default in Godot): a clash too.
      e.clash = { now: "", at: new Date().toISOString() };
      clashes.push(e);
      continue;
    }
    if (now !== e.from && e.decision !== "mine") {
      e.clash = { now, at: new Date().toISOString() };
      clashes.push(e);
      continue;
    }
    out = io.set(out, e.target, e.name, e.to);
    applied.push(e);
  }
  return { text: out, applied, clashes };
}

/** The queue of inspector values, in KesherAI's data folder (never in the project). */
export class ValueQueue {
  private lock: Promise<unknown> = Promise.resolve();

  /** @param dir - KesherAI's data folder. */
  constructor(private readonly dir: string) {}

  private get file() {
    return join(this.dir, "game-values.json");
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => undefined);
    return next;
  }

  /** @returns Every queued value. */
  async list(): Promise<ValueEdit[]> {
    try {
      const l = JSON.parse(await readFile(this.file, "utf8")) as ValueEdit[];
      return Array.isArray(l) ? l : [];
    } catch {
      return [];
    }
  }

  private async save(list: ValueEdit[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(`${this.file}.tmp`, JSON.stringify(list.slice(-2000), null, 1));
    await rename(`${this.file}.tmp`, this.file);
  }

  /**
   * Queues a value (a newer change of the same value replaces the older one and keeps its `from`).
   *
   * @param e - The change, without id and time.
   * @returns The queued change.
   */
  add(e: Omit<ValueEdit, "id" | "at" | "clash" | "decision">): Promise<ValueEdit> {
    return this.serial(async () => {
      const list = await this.list();
      const old = list.find((x) => x.engine === e.engine && x.project === e.project && x.file === e.file && x.target === e.target && x.name === e.name);
      const next: ValueEdit = { ...e, from: old?.from ?? e.from, id: old?.id ?? randomUUID(), at: new Date().toISOString() };
      await this.save([...list.filter((x) => x !== old), next]);
      return next;
    });
  }

  /**
   * Drops queued values.
   *
   * @param ids - Their ids.
   * @returns How many were there.
   */
  remove(ids: string[]): Promise<number> {
    return this.serial(async () => {
      const list = await this.list();
      const keep = list.filter((x) => !ids.includes(x.id));
      if (keep.length !== list.length) await this.save(keep);
      return list.length - keep.length;
    });
  }

  /**
   * Roee's choice for a clash: "mine" writes it at the next sync, "engine" drops it, "skip" leaves it.
   *
   * @param id - The queued value.
   * @param choice - The choice.
   * @returns Whether it was there.
   */
  decide(id: string, choice: "mine" | "engine" | "skip"): Promise<boolean> {
    return this.serial(async () => {
      const list = await this.list();
      const e = list.find((x) => x.id === id);
      if (!e) return false;
      if (choice === "engine") await this.save(list.filter((x) => x !== e));
      else {
        e.decision = choice;
        await this.save(list);
      }
      return true;
    });
  }

  /**
   * Writes a project's queued values into its files (the engine must be closed: the caller checks), one file at a time,
   * after the write hook (a checkpoint) for each file.
   *
   * @param engine - The project's engine.
   * @param project - The project folder.
   * @param before - Called with each file's full path before it is written.
   * @returns How many went in, how many newly clash, and the files that could not be read.
   */
  sync(engine: ValueEdit["engine"], project: string, before: (abs: string) => Promise<void> = async () => undefined): Promise<{ applied: number; clashes: number; failed: number }> {
    return this.serial(async () => {
      const list = await this.list();
      const mine = list.filter((x) => x.engine === engine && x.project === project);
      let applied = 0, clashes = 0, failed = 0;
      for (const file of new Set(mine.map((x) => x.file))) {
        const abs = join(project, file);
        const edits = mine.filter((x) => x.file === file);
        // A link put in the project since the value was queued is not written through (security scan 168).
        const ok = await realInside(project, abs).then(() => true, () => false);
        const text = ok ? await readFile(abs, "utf8").catch(() => undefined) : undefined;
        if (text === undefined) {
          failed += edits.length;
          continue;
        }
        const r = applyValues(text, edits);
        clashes += r.clashes.length;
        if (r.applied.length) {
          await before(abs);
          await writeFile(abs, r.text);
          applied += r.applied.length;
          for (const a of r.applied) list.splice(list.indexOf(a), 1);
        }
      }
      await this.save(list);
      return { applied, clashes, failed };
    });
  }
}
