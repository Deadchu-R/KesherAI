/**
 * Unity YAML documents and prefab instances, for the scene stand-in (unity-scene.ts). A scene places prefabs as
 * PrefabInstance documents (a source prefab and a list of overrides); here each one is expanded into the prefab's own
 * documents, with the overrides applied to their text, so the rest of the reader sees one flat list of documents.
 *
 * Ids: a document that came from a prefab gets "<the instance's id>~<its id in the prefab>" (nested prefabs nest the
 * same way), and every local reference inside it (`{fileID: N}`) is renamed the same way. External references (with a
 * guid) are left alone. Nothing is ever written back: this is for showing the scene only.
 */

/** One YAML document of a Unity file: `--- !u!<class> &<id>[ stripped]` and its text. */
export interface UnityDoc {
  /** Unity's class id ("1" GameObject, "4" Transform, "224" RectTransform, "114" MonoBehaviour, "1001" PrefabInstance…). */
  cls: string;
  /** Its file id in this file; for a document from an expanded prefab "<instance>~<id in the prefab>". */
  id: string;
  /** A stand-in for an object of a prefab instance (only its links; the object itself is in the prefab). */
  stripped: boolean;
  /** The document's text after its header line. */
  body: string;
  /** "<guid>:<fileID>" names this object has in the prefab assets it came from (an override's target is one of them). */
  keys?: string[];
  /** On the root Transform of a prefab instance expanded in this file: the instance's id. */
  instanceRoot?: string;
  /** With instanceRoot: the root Transform's fileID in its prefab (the first half of its GlobalObjectId). */
  rootSource?: string;
}

/** A file id as the reader keeps it: a number, or ids joined by "~" for objects from expanded prefabs. */
export const FILE_ID = "-?\\d+(?:~-?\\d+)*";

/** How deep prefabs inside prefabs are expanded (a deeper one stays a placeholder box). */
export const PREFAB_DEPTH = 6;
/** The most documents all expansions of one scene may add (a scene placing a huge prefab many times stays readable). */
export const MAX_EXPANDED_DOCS = 150_000;

/**
 * Splits a Unity YAML file into its documents.
 *
 * @param text - The file's text (a scene or a prefab).
 * @returns Its documents, in file order.
 */
export function parseDocs(text: string): UnityDoc[] {
  const out: UnityDoc[] = [];
  for (const d of text.split(/^--- !u!/m).slice(1)) {
    const head = /^(\d+) &(-?\d+)( stripped)?[^\n]*\n?/.exec(d);
    if (head) out.push({ cls: head[1]!, id: head[2]!, stripped: !!head[3], body: d.slice(head[0].length) });
  }
  return out;
}

/** A field's text on its own line (`  m_Name: Crate` → "Crate"), the first one found at any depth. */
export function field(body: string, key: string): string | undefined {
  return new RegExp(`^\\s+${key}:[ \\t]*(.*)$`, "m").exec(body)?.[1];
}

/** `{fileID: 123, guid: abc, type: 3}` → its parts (a fileID may be a "~" id of an expanded prefab). */
export function ref(s: string | undefined): { fileID: string; guid?: string } | undefined {
  const m = new RegExp(`fileID:\\s*(${FILE_ID})(?:,\\s*guid:\\s*([0-9a-f]{32}))?`).exec(s ?? "");
  return m ? { fileID: m[1]!, ...(m[2] ? { guid: m[2] } : {}) } : undefined;
}

/** The GUIDs of the prefabs a file places (Unity 2018.3+: m_SourcePrefab; older: m_ParentPrefab). */
export function prefabSources(text: string): string[] {
  return [...new Set([...text.matchAll(/m_(?:SourcePrefab|ParentPrefab):\s*\{fileID:\s*-?\d+,\s*guid:\s*([0-9a-f]{32})/g)].map((m) => m[1]!))];
}

const indentOf = (l: string) => l.length - l.trimStart().length;

/** YAML's double-quoted escapes (Unity writes non-Latin text, such as Hebrew, as \uXXXX). */
function unescapeDq(s: string): string {
  const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0", '"': '"', "\\": "\\", "/": "/", " ": " ", _: " ", N: "\u0085", L: " ", P: " ", e: "\x1b", a: "\x07", b: "\b" };
  return s.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{2}|[\s\S])/g, (all, e: string) => (e.length > 1 ? String.fromCodePoint(parseInt(e.slice(1), 16)) : simple[e] ?? all));
}

/** Lines of a flow scalar folded as YAML does: a line break is a space, an empty line a newline. */
function fold(first: string, more: string[], escaped: boolean): string {
  let out = first;
  let afterEmpty = false;
  for (const l0 of more) {
    const l = l0.trim();
    if (escaped && /(^|[^\\])(\\\\)*\\$/.test(out)) { out = out.slice(0, -1) + l; afterEmpty = false; continue; }
    if (!l) { out += "\n"; afterEmpty = true; continue; }
    out += (afterEmpty ? "" : " ") + l;
    afterEmpty = false;
  }
  return out;
}

/** A scalar's value from its first line's rest and the more-indented lines after it. */
function parseScalar(rest: string, more: string[]): string {
  if (rest.startsWith('"')) {
    const all = fold(rest.slice(1), more, true);
    let end = all.length;
    for (let i = 0; i < all.length; i++) { if (all[i] === "\\") i++; else if (all[i] === '"') { end = i; break; } }
    return unescapeDq(all.slice(0, end));
  }
  if (rest.startsWith("'")) {
    const all = fold(rest.slice(1), more, false);
    let end = all.length;
    for (let i = 0; i < all.length; i++) { if (all[i] !== "'") continue; if (all[i + 1] === "'") { i++; continue; } end = i; break; }
    return all.slice(0, end).replace(/''/g, "'");
  }
  if (/^[|>][-+]?$/.test(rest)) {
    const lines = more.map((l) => l.replace(/\s+$/, ""));
    const cut = Math.min(...lines.filter(Boolean).map(indentOf), Infinity);
    const body = lines.map((l) => l.slice(Number.isFinite(cut) ? cut : 0));
    return (rest[0] === "|" ? body.join("\n") : body.join(" ")).replace(/\n+$/, "");
  }
  return fold(rest, more, false).trim();
}

/**
 * A scalar field's full value, as YAML reads it: plain, 'single-quoted' or "double-quoted" (escapes decoded), over
 * several lines when Unity folded it (long texts).
 *
 * @param body - A document's text.
 * @param key - The field ("m_text").
 * @returns The value, or undefined when the document has no such field.
 */
export function yamlScalar(body: string, key: string): string | undefined {
  const lines = body.split("\n");
  const re = new RegExp(`^(\\s*)${key}:(?:[ \\t]+(.*))?$`);
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]!);
    if (!m) continue;
    const indent = m[1]!.length;
    const more: string[] = [];
    for (let j = i + 1; j < lines.length && (!lines[j]!.trim() || indentOf(lines[j]!) > indent); j++) more.push(lines[j]!);
    while (more.length && !more[more.length - 1]!.trim()) more.pop();
    return parseScalar((m[2] ?? "").trimEnd(), more);
  }
  return undefined;
}

/** A value as a YAML scalar: numbers and simple words as they are, anything else double-quoted (JSON is valid YAML). */
const scalarText = (v: string) => (/^[-+\w.]*$/.test(v) ? v : JSON.stringify(v));

/**
 * One override applied to a document's text, as Unity does when it loads a prefab instance: `m_LocalPosition.x` sets
 * one key of an inline map, `m_Name` a whole field, `m_Sprite` (an object reference) its `{fileID…}`. A path through
 * a block (`m_FontData.m_FontSize`) is followed; array elements (`m_Children.Array.data[0]`) are not applied.
 *
 * @param body - The document's text.
 * @param path - The override's propertyPath.
 * @param value - Its value ("" for an object reference).
 * @param objRef - Its objectReference text (`{fileID: …, guid: …}`), used when the value is empty.
 * @returns The changed text (the same text when the path is not found).
 */
export function setProp(body: string, path: string, value: string, objRef?: string): string {
  const segs = path.split(".");
  if (segs.some((s) => !/^\w+$/.test(s)) || segs.includes("Array")) return body;
  const lines = body.split("\n");
  let from = 0, end = lines.length, parentIndent = -1;
  for (let s = 0; s < segs.length; s++) {
    let at = -1, m: RegExpExecArray | null = null;
    for (let i = from; i < end; i++) {
      m = /^(\s*)(\w+):(?:[ \t]+(.*))?$/.exec(lines[i]!);
      if (m && m[2] === segs[s] && m[1]!.length > parentIndent) { at = i; break; }
    }
    if (at < 0 || !m) return body;
    const indent = m[1]!.length, rest = (m[3] ?? "").trim();
    let blockEnd = at + 1;
    // A block: more-indented lines, and for a list Unity's "- " items at the key's own indent.
    while (blockEnd < end && (!lines[blockEnd]!.trim() || indentOf(lines[blockEnd]!) > indent || (!rest && indentOf(lines[blockEnd]!) === indent && lines[blockEnd]!.trimStart().startsWith("- ")))) blockEnd++;
    if (rest.startsWith("{") && s === segs.length - 2) {
      // An inline map: one key in it (`m_LocalPosition: {x: 1, y: 2, z: 3}`).
      const k = segs[s + 1]!;
      if (!new RegExp(`[{,]\\s*${k}:`).test(rest)) return body;
      lines[at] = `${m[1]}${segs[s]}: ${rest.replace(new RegExp(`([{,]\\s*${k}:\\s*)([^,}]*)`), (_a, pre: string) => `${pre}${scalarText(value)}`)}`;
      return lines.join("\n");
    }
    if (s === segs.length - 1) {
      // A block (a nested map or a list) is never replaced by a scalar.
      if (!rest && blockEnd > at + 1 && lines.slice(at + 1, blockEnd).some((l) => l.trim())) return body;
      const v = value === "" && objRef && /fileID/.test(objRef) ? objRef.trim() : scalarText(value);
      lines.splice(at, blockEnd - at, `${m[1]}${segs[s]}: ${v}`);
      return lines.join("\n");
    }
    from = at + 1; end = blockEnd; parentIndent = indent;
  }
  return body;
}

/** One override of a prefab instance. */
export interface UnityMod {
  fileID: string;
  guid?: string;
  path: string;
  value: string;
  /** The objectReference's text, for an override that points at an asset (a sprite…). */
  objRef?: string;
}

/**
 * The overrides of a PrefabInstance document (m_Modification.m_Modifications), in file order.
 *
 * @param body - The PrefabInstance's text.
 * @returns Its overrides.
 */
export function modsOf(body: string): UnityMod[] {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => /^\s*m_Modifications:\s*$/.test(l));
  if (start < 0) return [];
  const keyIndent = indentOf(lines[start]!);
  const items: string[][] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.trim() && indentOf(l) <= keyIndent && !l.trimStart().startsWith("- ")) break;
    if (/^\s*- target:/.test(l)) items.push([l.replace("- ", "  ")]);
    else items[items.length - 1]?.push(l);
  }
  const out: UnityMod[] = [];
  for (const item of items) {
    const chunk = item.join("\n");
    const t = ref(field(chunk, "target"));
    const path = field(chunk, "propertyPath")?.trim();
    if (!t || !path) continue;
    const objRef = field(chunk, "objectReference")?.trim();
    out.push({ fileID: t.fileID, ...(t.guid ? { guid: t.guid } : {}), path, value: yamlScalar(chunk, "value") ?? "", ...(objRef ? { objRef } : {}) });
  }
  return out;
}

/** A "~" id's fileID in the file that holds it: Unity names an object of a nested prefab (instance ^ source) & 2^63-1. */
export function fileIdOf(id: string): string {
  const cut = id.indexOf("~");
  if (cut < 0) return id;
  try {
    return ((BigInt(id.slice(0, cut)) ^ BigInt(fileIdOf(id.slice(cut + 1)))) & 0x7fffffffffffffffn).toString();
  } catch {
    return id;
  }
}

/** A prefab's document copied into the file that placed it as instance `pi` (its id and local references renamed). */
function remap(d: UnityDoc, pi: string, guid: string): UnityDoc {
  const body = d.body.replace(new RegExp(`\\{fileID: (${FILE_ID})\\}`, "g"), (all, x: string) => (x === "0" ? all : `{fileID: ${pi}~${x}}`));
  return { cls: d.cls, id: `${pi}~${d.id}`, stripped: d.stripped, body, keys: [...(d.keys ?? []), `${guid}:${fileIdOf(d.id)}`] };
}

const isTransform = (d: UnityDoc) => d.cls === "4" || d.cls === "224";

/**
 * Expands every prefab instance of a file into the prefab's documents, overrides applied, nested prefabs too (up to
 * PREFAB_DEPTH, never a prefab inside itself, and at most MAX_EXPANDED_DOCS documents added). An instance whose prefab
 * is not given (not found, too big, too deep, a cycle) stays as its PrefabInstance document.
 *
 * Stripped documents that stand for an expanded instance's objects are dropped, and references to them point at the
 * expanded objects (a child the scene added under a prefab's object hangs under it).
 *
 * @param docs - The file's documents (parseDocs).
 * @param prefabs - Prefab GUID → the prefab file's text.
 * @param limits - Depth and size limits (tests use smaller ones).
 * @returns The documents with the instances expanded; the roots of this file's own instances carry instanceRoot.
 */
export function expandPrefabs(docs: UnityDoc[], prefabs: ReadonlyMap<string, string>, limits: { depth?: number; docs?: number } = {}): UnityDoc[] {
  const maxDepth = limits.depth ?? PREFAB_DEPTH, maxDocs = limits.docs ?? MAX_EXPANDED_DOCS;
  /** Each prefab expanded once (its own ids), then copied per instance. */
  const memo = new Map<string, UnityDoc[] | null>();
  let added = 0;
  const load = (guid: string, stack: string[]): UnityDoc[] | null => {
    if (stack.includes(guid) || stack.length >= maxDepth) return null;
    if (memo.has(guid)) return memo.get(guid)!;
    const text = prefabs.get(guid);
    const inner = text ? expandFile(parseDocs(text), [...stack, guid]).map(({ instanceRoot: _i, rootSource: _r, ...d }) => d) : null;
    memo.set(guid, inner);
    return inner;
  };
  const expandFile = (list: UnityDoc[], stack: string[]): UnityDoc[] => {
    const copies = new Map<string, UnityDoc[]>();
    for (const pi of list) {
      if (pi.cls !== "1001" || pi.stripped) continue;
      const src = ref(field(pi.body, "m_SourcePrefab")) ?? ref(field(pi.body, "m_ParentPrefab"));
      const inner = src?.guid ? load(src.guid, stack) : null;
      if (!inner || added + inner.length > maxDocs) continue;
      added += inner.length;
      const copy = inner.map((d) => remap(d, pi.id, src!.guid!));
      const byKey = new Map<string, UnityDoc[]>();
      for (const d of copy) for (const k of d.keys!) byKey.set(k, [...(byKey.get(k) ?? []), d]);
      for (const m of modsOf(pi.body)) for (const d of byKey.get(`${m.guid ?? src!.guid}:${m.fileID}`) ?? []) d.body = setProp(d.body, m.path, m.value, m.objRef);
      // The prefab's root Transform hangs where the instance was placed.
      const root = copy.find((d) => isTransform(d) && !d.stripped && ref(field(d.body, "m_Father"))?.fileID === "0");
      if (root) {
        const parent = ref(field(pi.body, "m_TransformParent"))?.fileID ?? "0";
        root.body = setProp(root.body, "m_Father", "", `{fileID: ${parent}}`);
        root.instanceRoot = pi.id;
        root.rootSource = fileIdOf(root.id.slice(pi.id.length + 1));
      }
      copies.set(pi.id, copy);
    }
    if (!copies.size) return list;
    // Stripped stand-ins of expanded objects → the expanded objects.
    const renamed = new Map<string, string>();
    for (const d of list) {
      if (!d.stripped) continue;
      const pi = ref(field(d.body, "m_PrefabInstance"))?.fileID;
      const src = ref(field(d.body, "m_CorrespondingSourceObject"));
      const copy = pi ? copies.get(pi) : undefined;
      if (!copy || !src) continue;
      const hit = copy.find((c) => c.keys!.includes(`${src.guid}:${src.fileID}`));
      if (hit) renamed.set(d.id, hit.id);
    }
    const out: UnityDoc[] = [];
    for (const d of list) {
      if ((d.cls === "1001" && copies.has(d.id)) || renamed.has(d.id)) continue;
      out.push(d);
    }
    for (const c of copies.values()) out.push(...c);
    if (renamed.size) {
      const re = new RegExp(`\\{fileID: (${FILE_ID})\\}`, "g");
      for (const d of out) d.body = d.body.replace(re, (all, x: string) => (renamed.has(x) ? `{fileID: ${renamed.get(x)}}` : all));
    }
    return out;
  };
  return expandFile(docs, []);
}
