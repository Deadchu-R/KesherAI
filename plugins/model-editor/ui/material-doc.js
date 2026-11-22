// The 3D editor's node material graphs (docs/research/c-20261122-14.md): a MaterialDoc in OpenPBR / MaterialX words,
// its ~30 starter nodes, checks (types, cycles), edits as ops (the same vocabulary as VsDoc's applyVsOps: add, delete,
// move, connect, disconnect, set), a GLSL compile for the live preview (three.js's WebGLRenderer, injected into
// MeshStandard/PhysicalMaterial with onBeforeCompile: the vendored three.js 0.181 has no TSL / WebGPU build), a Unity
// Shader Graph export (URP Lit, text), the Unreal command it will send (the plugin side comes next) and the chat's
// `material_graph` tool. Pure functions, no browser or three.js needs (tested in packages/core/src/material-doc.test.ts).

/** The MaterialDoc format version (kept in the doc, so a later editor can upgrade old graphs). */
export const MATERIAL_DOC_VERSION = 1;

/**
 * @typedef {"float"|"vec2"|"vec3"|"vec4"|"tex"|"dyn"} PinType  `dyn` takes the widest vector connected (Unity's
 *   Dynamic Vector); `tex` is a texture object, which only goes into a texture input.
 * @typedef {{ id: string, cls: string, x: number, y: number, values?: Record<string, number|number[]>, props?: Record<string, unknown> }} MaterialNode
 * @typedef {{ from: string, out: string, to: string, in: string }} MaterialLink
 * @typedef {{ version: number, name: string, nodes: MaterialNode[], links: MaterialLink[] }} MaterialDoc
 * @typedef {{ node?: string, pin?: string, code: string, en: string, he: string }} MaterialIssue
 */

// ---------- the node set ----------
// ins: [name, type, default]; outs: [name, type]; u: Unity Shader Graph node and its slot ids (none: not in Unity);
// ue: the Unreal material expression; c: the colour pins (defaults in sRGB, linear in the shader).
const F = "float", V2 = "vec2", V3 = "vec3", V4 = "vec4", T = "tex", D = "dyn";
const math2 = (cls, title, he, unity, ue, a = 0, b = 0) => ({ cls, title, he, cat: "math", ins: [["A", D, a], ["B", D, b]], outs: [["Out", D]], u: [unity, { A: 0, B: 1, Out: 2 }], ue });
const math1 = (cls, title, he, unity, ue, d = 0) => ({ cls, title, he, cat: "math", ins: [["In", D, d]], outs: [["Out", D]], u: [unity, { In: 0, Out: 1 }], ue });

/** The node set: every class a MaterialDoc may hold. */
export const MATERIAL_NODES = [
  { cls: "Float", title: "Float", he: "מספר", cat: "input", ins: [], outs: [["Out", F]], props: { value: 0.5 }, u: ["Vector1Node", { Out: 0 }], ue: "MaterialExpressionConstant" },
  { cls: "Color", title: "Color", he: "צבע", cat: "input", ins: [], outs: [["Out", V3]], props: { value: "#cccccc" }, u: ["ColorNode", { Out: 0 }], ue: "MaterialExpressionConstant3Vector" },
  { cls: "Vector2", title: "Vector 2", he: "וקטור 2", cat: "input", ins: [], outs: [["Out", V2]], props: { value: [0, 0] }, u: ["Vector2Node", { Out: 0 }], ue: "MaterialExpressionConstant2Vector" },
  { cls: "Vector3", title: "Vector 3", he: "וקטור 3", cat: "input", ins: [], outs: [["Out", V3]], props: { value: [0, 0, 0] }, u: ["Vector3Node", { Out: 0 }], ue: "MaterialExpressionConstant3Vector" },
  { cls: "Vector4", title: "Vector 4", he: "וקטור 4", cat: "input", ins: [], outs: [["Out", V4]], props: { value: [0, 0, 0, 0] }, u: ["Vector4Node", { Out: 0 }], ue: "MaterialExpressionConstant4Vector" },
  { cls: "Time", title: "Time", he: "זמן", cat: "input", ins: [], outs: [["Time", F]], u: ["TimeNode", { Time: 0 }], ue: "MaterialExpressionTime" },
  { cls: "UV", title: "UV", he: "UV", cat: "coords", ins: [], outs: [["Out", V2]], u: ["UVNode", { Out: 0 }], ue: "MaterialExpressionTextureCoordinate" },
  { cls: "TilingOffset", title: "Tiling And Offset", he: "חזרה והזזה", cat: "coords", ins: [["UV", V2, "uv"], ["Tiling", V2, [1, 1]], ["Offset", V2, [0, 0]]], outs: [["Out", V2]], u: ["TilingAndOffsetNode", { UV: 0, Tiling: 1, Offset: 2, Out: 3 }], ue: "MaterialExpressionTextureCoordinate" },
  { cls: "Panner", title: "Panner", he: "גלילה", cat: "coords", ins: [["UV", V2, "uv"], ["Speed", V2, [0.1, 0]], ["Time", F, "time"]], outs: [["Out", V2]], ue: "MaterialExpressionPanner",
    why: { en: "Shader Graph has no Panner: use Tiling And Offset with Time × Speed as the offset.", he: "ב-Shader Graph אין Panner: השתמש ב-Tiling And Offset עם זמן × מהירות כהזזה." } },
  { cls: "TextureAsset", title: "Texture", he: "טקסטורה", cat: "texture", ins: [], outs: [["Tex", T]], props: { source: "map", name: "" }, u: ["PropertyNode", { Tex: 0 }], ue: "MaterialExpressionTextureObjectParameter" },
  { cls: "TextureSample", title: "Sample Texture 2D", he: "דגימת טקסטורה", cat: "texture", ins: [["Texture", T, null], ["UV", V2, "uv"]], outs: [["RGBA", V4], ["R", F], ["G", F], ["B", F], ["A", F]], u: ["SampleTexture2DNode", { RGBA: 0, Texture: 1, UV: 2, R: 4, G: 5, B: 6, A: 7 }], ue: "MaterialExpressionTextureSample" },
  { cls: "NormalUnpack", title: "Normal Unpack", he: "פריסת נורמל", cat: "texture", ins: [["In", V4, [0.5, 0.5, 1, 1]]], outs: [["Out", V3]], u: ["NormalUnpackNode", { In: 0, Out: 1 }], ue: "MaterialExpressionComponentMask" },
  { cls: "NormalStrength", title: "Normal Strength", he: "עוצמת נורמל", cat: "texture", ins: [["In", V3, [0, 0, 1]], ["Strength", F, 1]], outs: [["Out", V3]], u: ["NormalStrengthNode", { In: 0, Strength: 1, Out: 2 }], ue: "MaterialExpressionMaterialFunctionCall" },
  math2("Add", "Add", "חיבור", "AddNode", "MaterialExpressionAdd"),
  math2("Subtract", "Subtract", "חיסור", "SubtractNode", "MaterialExpressionSubtract"),
  math2("Multiply", "Multiply", "כפל", "MultiplyNode", "MaterialExpressionMultiply", 1, 1),
  math2("Divide", "Divide", "חילוק", "DivideNode", "MaterialExpressionDivide", 1, 1),
  math2("Power", "Power", "חזקה", "PowerNode", "MaterialExpressionPower", 1, 2),
  math2("Min", "Minimum", "מינימום", "MinimumNode", "MaterialExpressionMin"),
  math2("Max", "Maximum", "מקסימום", "MaximumNode", "MaterialExpressionMax"),
  { cls: "Lerp", title: "Lerp", he: "מעבר (Lerp)", cat: "math", ins: [["A", D, 0], ["B", D, 1], ["T", D, 0.5]], outs: [["Out", D]], u: ["LerpNode", { A: 0, B: 1, T: 2, Out: 3 }], ue: "MaterialExpressionLinearInterpolate" },
  { cls: "Clamp", title: "Clamp", he: "הגבלה", cat: "math", ins: [["In", D, 0], ["Min", D, 0], ["Max", D, 1]], outs: [["Out", D]], u: ["ClampNode", { In: 0, Min: 1, Max: 2, Out: 3 }], ue: "MaterialExpressionClamp" },
  math1("OneMinus", "One Minus", "אחד פחות", "OneMinusNode", "MaterialExpressionOneMinus"),
  math1("Saturate", "Saturate", "רוויה 0–1", "SaturateNode", "MaterialExpressionSaturate"),
  math1("Sine", "Sine", "סינוס", "SineNode", "MaterialExpressionSine"),
  math1("Abs", "Absolute", "ערך מוחלט", "AbsoluteNode", "MaterialExpressionAbs"),
  math1("Normalize", "Normalize", "נרמול", "NormalizeNode", "MaterialExpressionNormalize", [0, 0, 1]),
  { cls: "Dot", title: "Dot Product", he: "מכפלה סקלרית", cat: "math", ins: [["A", D, 0], ["B", D, 0]], outs: [["Out", F]], u: ["DotProductNode", { A: 0, B: 1, Out: 2 }], ue: "MaterialExpressionDotProduct" },
  { cls: "Step", title: "Step", he: "מדרגה", cat: "math", ins: [["Edge", D, 0.5], ["In", D, 0]], outs: [["Out", D]], u: ["StepNode", { Edge: 0, In: 1, Out: 2 }], ue: "MaterialExpressionStep" },
  { cls: "Smoothstep", title: "Smoothstep", he: "מדרגה רכה", cat: "math", ins: [["Edge1", D, 0], ["Edge2", D, 1], ["In", D, 0]], outs: [["Out", D]], u: ["SmoothstepNode", { Edge1: 0, Edge2: 1, In: 2, Out: 3 }], ue: "MaterialExpressionSmoothStep" },
  { cls: "Fresnel", title: "Fresnel Effect", he: "פרנל (שוליים)", cat: "coords", ins: [["Normal", V3, "normal"], ["Power", F, 2]], outs: [["Out", F]], u: ["FresnelNode", { Normal: 0, Power: 2, Out: 3 }], ue: "MaterialExpressionFresnel" },
  { cls: "Split", title: "Split", he: "פיצול ערוצים", cat: "vector", ins: [["In", D, 0]], outs: [["R", F], ["G", F], ["B", F], ["A", F]], u: ["SplitNode", { In: 0, R: 1, G: 2, B: 3, A: 4 }], ue: "MaterialExpressionComponentMask" },
  { cls: "Combine", title: "Combine", he: "איחוד ערוצים", cat: "vector", ins: [["R", F, 0], ["G", F, 0], ["B", F, 0], ["A", F, 1]], outs: [["RGBA", V4], ["RGB", V3], ["RG", V2]], u: ["CombineNode", { R: 0, G: 1, B: 2, A: 3, RGBA: 4, RGB: 5, RG: 6 }], ue: "MaterialExpressionAppendVector" },
  { cls: "Output", title: "Material Output (PBR)", he: "פלט החומר (PBR)", cat: "output", c: ["BaseColor", "Emissive"],
    ins: [["BaseColor", V3, [0.8, 0.8, 0.8]], ["Metallic", F, 0], ["Roughness", F, 0.5], ["Normal", V3, null], ["Emissive", V3, [0, 0, 0]], ["Opacity", F, 1], ["AO", F, 1]], outs: [], ue: "MaterialOutput" },
];
const BY_CLS = new Map(MATERIAL_NODES.map((n) => [n.cls, n]));

/** The texture slots of the part's own material that a Texture node can read (glTF's PBR slots). */
export const TEXTURE_SOURCES = ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "aoMap", "alphaMap"];

/**
 * A node class's definition.
 *
 * @param cls - The class, e.g. "Multiply".
 * @returns The definition, or undefined for an unknown class.
 */
export function nodeDef(cls) { return BY_CLS.get(cls); }

const WIDTH = { float: 1, vec2: 2, vec3: 3, vec4: 4 };
const TYPE_OF = ["", "float", "vec2", "vec3", "vec4"];
const ISSUE = (code, en, he, node, pin) => ({ code, en, he, ...(node ? { node } : {}), ...(pin ? { pin } : {}) });

/**
 * Whether an output of one type may go into an input of another: numbers and vectors into each other (a float
 * fills every channel, a wider vector is cut, a narrower one padded with 0, as in Shader Graph); a texture only
 * into a texture input.
 *
 * @param from - The output's type.
 * @param to - The input's type.
 * @returns Whether they fit.
 */
export function typesFit(from, to) {
  return (from === "tex") === (to === "tex");
}

/** The pin of a node, by direction and name. */
function pinOf(node, dir, name) {
  const def = BY_CLS.get(node?.cls);
  return def?.[dir === "in" ? "ins" : "outs"].find((p) => p[0] === name);
}

// ---------- checks ----------
/**
 * Checks a material graph: known classes, unique ids, one output, links between real pins in the right direction,
 * one wire into each input, types that fit, and no cycles.
 *
 * @param doc - The graph.
 * @returns `ok` and the problems found (each in English and Hebrew, with the node and pin when there is one).
 */
export function validateMaterialDoc(doc) {
  const issues = [];
  const nodes = Array.isArray(doc?.nodes) ? doc.nodes : [];
  const byId = new Map();
  for (const n of nodes) {
    if (!n || typeof n.id !== "string" || !n.id) { issues.push(ISSUE("id", "A node has no id.", "לנוד אין מזהה.")); continue; }
    if (byId.has(n.id)) issues.push(ISSUE("dup", `Two nodes are called ${n.id}.`, `שני נודים בשם ${n.id}.`, n.id));
    byId.set(n.id, n);
    if (!BY_CLS.has(n.cls)) issues.push(ISSUE("class", `${n.id}: unknown node "${n.cls}".`, `${n.id}: נוד לא מוכר "${n.cls}".`, n.id));
  }
  const outs = nodes.filter((n) => n?.cls === "Output");
  if (outs.length !== 1) issues.push(ISSUE("output", outs.length ? "A material has one Material Output." : "The graph needs a Material Output.", outs.length ? "לחומר יש פלט אחד בלבד." : "לגרף צריך פלט חומר."));
  const into = new Set();
  const next = new Map();
  for (const l of Array.isArray(doc?.links) ? doc.links : []) {
    const a = byId.get(l?.from), b = byId.get(l?.to);
    const po = a && pinOf(a, "out", l.out), pi = b && pinOf(b, "in", l.in);
    if (!po || !pi) { issues.push(ISSUE("link", `A wire goes to a pin that is not there (${l?.from}.${l?.out} → ${l?.to}.${l?.in}).`, `חוט מחובר לפין שלא קיים (${l?.from}.${l?.out} ← ${l?.to}.${l?.in}).`, l?.to, l?.in)); continue; }
    const key = `${l.to}:${l.in}`;
    if (into.has(key)) issues.push(ISSUE("twice", `${l.to}.${l.in} has two wires into it.`, `ל-${l.to}.${l.in} נכנסים שני חוטים.`, l.to, l.in));
    into.add(key);
    if (!typesFit(po[1], pi[1])) issues.push(ISSUE("type", `${l.from}.${l.out} (${po[1]}) cannot go into ${l.to}.${l.in} (${pi[1]}).`, `${l.from}.${l.out} (${po[1]}) לא יכול להיכנס ל-${l.to}.${l.in} (${pi[1]}).`, l.to, l.in));
    if (!next.has(l.from)) next.set(l.from, []);
    next.get(l.from).push(l.to);
  }
  const cyc = findCycle(byId.keys(), next);
  if (cyc) issues.push(ISSUE("cycle", `A loop: ${cyc.join(" → ")}. A material's wires only go forward.`, `לולאה: ${cyc.join(" ← ")}. החוטים בחומר הולכים רק קדימה.`, cyc[0]));
  return { ok: !issues.length, issues };
}

/** The first loop in a graph (its node ids, back to the first), or undefined. */
function findCycle(ids, next) {
  const state = new Map();
  const path = [];
  const visit = (id) => {
    state.set(id, 1);
    path.push(id);
    for (const to of next.get(id) ?? []) {
      if (state.get(to) === 1) return [...path.slice(path.indexOf(to)), to];
      if (!state.get(to)) { const c = visit(to); if (c) return c; }
    }
    path.pop();
    state.set(id, 2);
    return undefined;
  };
  for (const id of ids) if (!state.get(id)) { const c = visit(id); if (c) return c; }
  return undefined;
}

// ---------- edits ----------
const clone = (o) => JSON.parse(JSON.stringify(o));
const num = (v, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * A pin value or a property value, cleaned: numbers stay finite, vectors keep their width, a colour is #rrggbb.
 *
 * @param value - What was asked.
 * @param like - The default it replaces (its shape decides the result's shape).
 * @returns The clean value, or undefined when it cannot be one.
 */
export function cleanValue(value, like) {
  if (typeof like === "string" && like.startsWith("#")) {
    const s = String(value ?? "").trim();
    return /^#[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : undefined;
  }
  if (typeof like === "string") return String(value ?? "").slice(0, 64);
  if (Array.isArray(like)) {
    const arr = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/).filter(Boolean) : typeof value === "number" ? like.map(() => value) : undefined;
    if (!arr) return undefined;
    return like.map((d, i) => num(arr[i], d));
  }
  const n = num(value, NaN);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Applies edits to a material graph, in order, each checked; a failed op is reported and skipped, the rest go on.
 * Ops: `add` {cls, id?, x?, y?, values?, props?}, `delete` {node}, `move` {node, x, y}, `connect` {from, out?, to,
 * in} (replaces the wire already in that input; refused when the types do not fit or it makes a loop),
 * `disconnect` {to, in}, `set` {node, pin, value} or {node, prop, value}.
 *
 * @param doc - The graph (not changed).
 * @param ops - The edits.
 * @param newId - Makes an id for an added node without one (given a counter); default "n1", "n2"… not yet taken.
 * @returns The changed copy and one result per op (`node` is the added node's id).
 */
export function applyMaterialOps(doc, ops, newId) {
  const d = clone(doc);
  d.nodes ??= [];
  d.links ??= [];
  const results = [];
  const has = (id) => d.nodes.some((n) => n.id === id);
  let counter = 0;
  const makeId = () => {
    for (;;) {
      counter++;
      const id = newId ? newId(counter) : `n${counter}`;
      if (!has(id)) return id;
    }
  };
  for (const raw of Array.isArray(ops) ? ops : []) {
    const op = raw && typeof raw === "object" ? raw : {};
    const kind = String(op.op ?? "");
    const fail = (error) => results.push({ op: kind, ok: false, error });
    const node = d.nodes.find((n) => n.id === op.node);
    switch (kind) {
      case "add": {
        const def = BY_CLS.get(String(op.cls ?? op.type ?? ""));
        if (!def) { fail(`Unknown node "${op.cls ?? op.type}".`); break; }
        if (def.cls === "Output" && d.nodes.some((n) => n.cls === "Output")) { fail("The graph has a Material Output already."); break; }
        const want = typeof op.id === "string" && /^[\w-]{1,40}$/.test(op.id) && !has(op.id) ? op.id : makeId();
        const n = { id: want, cls: def.cls, x: Math.round(num(op.x, 0)), y: Math.round(num(op.y, 0)) };
        if (def.props) n.props = clone(def.props);
        for (const [k, v] of Object.entries(op.props && typeof op.props === "object" ? op.props : {})) setProp(n, def, k, v);
        for (const [k, v] of Object.entries(op.values && typeof op.values === "object" ? op.values : {})) setValue(n, def, k, v);
        d.nodes.push(n);
        results.push({ op: kind, ok: true, node: want });
        break;
      }
      case "delete":
        if (!node) { fail(`No node ${op.node}.`); break; }
        if (node.cls === "Output") { fail("The Material Output stays."); break; }
        d.nodes = d.nodes.filter((n) => n !== node);
        d.links = d.links.filter((l) => l.from !== node.id && l.to !== node.id);
        results.push({ op: kind, ok: true });
        break;
      case "move":
        if (!node) { fail(`No node ${op.node}.`); break; }
        node.x = Math.round(num(op.x, node.x));
        node.y = Math.round(num(op.y, node.y));
        results.push({ op: kind, ok: true });
        break;
      case "connect": {
        const a = d.nodes.find((n) => n.id === op.from), b = d.nodes.find((n) => n.id === op.to);
        if (!a || !b) { fail(`No node ${a ? op.to : op.from}.`); break; }
        const outName = typeof op.out === "string" && op.out ? op.out : BY_CLS.get(a.cls)?.outs[0]?.[0];
        const po = pinOf(a, "out", outName), pi = pinOf(b, "in", op.in);
        if (!po) { fail(`${a.id} has no output "${op.out}".`); break; }
        if (!pi) { fail(`${b.id} has no input "${op.in}".`); break; }
        if (!typesFit(po[1], pi[1])) { fail(`${po[1]} cannot go into ${pi[1]}.`); break; }
        const rest = d.links.filter((l) => !(l.to === b.id && l.in === pi[0]));
        const link = { from: a.id, out: po[0], to: b.id, in: pi[0] };
        const next = new Map();
        for (const l of [...rest, link]) { if (!next.has(l.from)) next.set(l.from, []); next.get(l.from).push(l.to); }
        if (findCycle(d.nodes.map((n) => n.id), next)) { fail("That wire would make a loop."); break; }
        d.links = [...rest, link];
        results.push({ op: kind, ok: true });
        break;
      }
      case "disconnect": {
        const before = d.links.length;
        d.links = d.links.filter((l) => !(l.to === op.to && l.in === op.in));
        if (d.links.length === before) fail(`Nothing goes into ${op.to}.${op.in}.`);
        else results.push({ op: kind, ok: true });
        break;
      }
      case "set": {
        if (!node) { fail(`No node ${op.node}.`); break; }
        const def = BY_CLS.get(node.cls);
        const ok = typeof op.prop === "string" ? setProp(node, def, op.prop, op.value) : setValue(node, def, String(op.pin ?? ""), op.value);
        if (ok) results.push({ op: kind, ok: true });
        else fail(`${node.id}: that value does not fit ${op.prop ?? op.pin}.`);
        break;
      }
      default:
        fail(`Unknown op "${kind}".`);
    }
  }
  return { doc: d, results };
}

/** Sets an input's own value (used while no wire goes into it). */
function setValue(n, def, pin, value) {
  const p = def?.ins.find((x) => x[0] === pin);
  if (!p || typeof p[2] === "string" || p[2] === null) return false;
  const v = cleanValue(value, p[2]);
  if (v === undefined) return false;
  (n.values ??= {})[pin] = v;
  return true;
}
/** Sets a property (a constant's value, a texture's source and name). */
function setProp(n, def, key, value) {
  if (!def?.props || !(key in def.props)) return false;
  if (key === "source") {
    if (!TEXTURE_SOURCES.includes(String(value))) return false;
    (n.props ??= {}).source = String(value);
    return true;
  }
  if (key === "name") { (n.props ??= {}).name = String(value ?? "").replace(/[^\w]/g, "").slice(0, 40); return true; }
  const v = cleanValue(value, def.props[key]);
  if (v === undefined) return false;
  (n.props ??= {})[key] = v;
  return true;
}

/**
 * A new graph for a part's material, read from it: its colour (times its colour texture), roughness, metalness,
 * emissive colour, and its normal map through Normal Unpack, so the graph shows the material as it is.
 *
 * @param m - What the material has: `{ name, color: "#rrggbb", roughness, metalness, emissive: "#rrggbb",
 *   maps: ["map", "normalMap", …] }`.
 * @returns The graph.
 */
export function starterDoc(m = {}) {
  const ops = [
    { op: "add", cls: "Output", id: "out", x: 560, y: 40, values: { Metallic: m.metalness ?? 0, Roughness: m.roughness ?? 0.5 } },
    { op: "add", cls: "Color", id: "base", x: 40, y: 20, props: { value: m.color ?? "#cccccc" } },
  ];
  const maps = new Set(m.maps ?? []);
  if (maps.has("map")) {
    ops.push(
      { op: "add", cls: "TextureAsset", id: "tex", x: 40, y: 110, props: { source: "map", name: "BaseMap" } },
      { op: "add", cls: "TextureSample", id: "sample", x: 220, y: 110 },
      { op: "add", cls: "Multiply", id: "tint", x: 400, y: 20 },
      { op: "connect", from: "tex", to: "sample", in: "Texture" },
      { op: "connect", from: "base", to: "tint", in: "A" },
      { op: "connect", from: "sample", out: "RGBA", to: "tint", in: "B" },
      { op: "connect", from: "tint", to: "out", in: "BaseColor" },
    );
  } else ops.push({ op: "connect", from: "base", to: "out", in: "BaseColor" });
  if (maps.has("normalMap")) {
    ops.push(
      { op: "add", cls: "TextureAsset", id: "ntex", x: 40, y: 290, props: { source: "normalMap", name: "NormalMap" } },
      { op: "add", cls: "TextureSample", id: "nsample", x: 220, y: 290 },
      { op: "add", cls: "NormalUnpack", id: "unpack", x: 400, y: 290 },
      { op: "connect", from: "ntex", to: "nsample", in: "Texture" },
      { op: "connect", from: "nsample", out: "RGBA", to: "unpack", in: "In" },
      { op: "connect", from: "unpack", to: "out", in: "Normal" },
    );
  }
  if (m.emissive && m.emissive !== "#000000") ops.push({ op: "set", node: "out", pin: "Emissive", value: hexToRgb(m.emissive) });
  return applyMaterialOps({ version: MATERIAL_DOC_VERSION, name: m.name || "Material", nodes: [], links: [] }, ops).doc;
}

// ---------- colour and numbers ----------
/** "#rrggbb" → [r, g, b] in 0..1 (sRGB). */
export function hexToRgb(hex) {
  const s = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ""))?.[1] ?? "cccccc";
  return [0, 2, 4].map((i) => Math.round((parseInt(s.slice(i, i + 2), 16) / 255) * 1e4) / 1e4);
}
/** One sRGB channel → linear (the shader works in linear light, as three.js does). */
export function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
/** A GLSL float literal (always with a point). */
function lit(n) {
  const v = Number.isFinite(n) ? n : 0;
  const s = String(Math.round(v * 1e6) / 1e6);
  return /[.e]/.test(s) ? s : `${s}.0`;
}
/** A GLSL value of a type from a default (a number fills every channel). */
function litOf(type, v) {
  const w = WIDTH[type] ?? 1;
  const arr = Array.isArray(v) ? v : [v ?? 0];
  if (w === 1) return lit(num(arr[0]));
  return `${type}(${Array.from({ length: w }, (_, i) => lit(num(arr[i] ?? (arr.length === 1 ? arr[0] : 0)))).join(", ")})`;
}
/** Converts a GLSL expression from one vector width to another (fill, cut or pad with 0). */
function conv(expr, from, to) {
  const a = WIDTH[from] ?? 1, b = WIDTH[to] ?? 1;
  if (a === b) return expr;
  if (a === 1) return `${to}(${expr})`;
  if (b === 1) return `(${expr}).x`;
  if (b < a) return `(${expr}).${"xyzw".slice(0, b)}`;
  return `${to}(${expr}, ${Array(b - a).fill("0.0").join(", ")})`;
}

// ---------- the order and types of a graph ----------
/** The nodes that reach the output, in an order where every node comes after the nodes wired into it. */
function reachOrder(doc) {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const into = new Map();
  for (const l of doc.links) { if (!into.has(l.to)) into.set(l.to, []); into.get(l.to).push(l); }
  const order = [];
  const seen = new Set();
  const visit = (id) => {
    if (seen.has(id) || !byId.has(id)) return;
    seen.add(id);
    for (const l of into.get(id) ?? []) visit(l.from);
    order.push(byId.get(id));
  };
  const out = doc.nodes.find((n) => n.cls === "Output");
  if (out) visit(out.id);
  return { order, into, byId };
}

/**
 * Each node's resolved types: a dynamic pin takes the widest vector wired into the node's dynamic inputs (or the
 * width of its own default values), as Shader Graph's Dynamic Vector does.
 *
 * @param doc - A valid graph.
 * @returns For each node id, `{ dyn, out: { pin: type } }`.
 */
export function resolveTypes(doc) {
  const { order, into } = reachOrder(doc);
  const types = new Map();
  for (const n of order) {
    const def = BY_CLS.get(n.cls);
    let w = 0;
    for (const [name, type, dflt] of def.ins) {
      if (type !== "dyn") continue;
      const l = (into.get(n.id) ?? []).find((x) => x.in === name);
      if (l) w = Math.max(w, WIDTH[types.get(l.from)?.out[l.out]] ?? 1);
      else { const v = n.values?.[name] ?? dflt; w = Math.max(w, Array.isArray(v) ? v.length : 1); }
    }
    const dyn = TYPE_OF[Math.min(4, Math.max(1, w))];
    const out = {};
    for (const [name, type] of def.outs) out[name] = type === "dyn" ? dyn : type;
    types.set(n.id, { dyn, out });
  }
  return types;
}

// ---------- GLSL for the live preview ----------
/**
 * Compiles a graph into GLSL pieces for three.js's MeshStandard/PhysicalMaterial (WebGL), put in by
 * {@link patchShaders}: uniforms, the graph's lines (after the normal maps, so Fresnel sees the final normal) that
 * set diffuseColor, roughnessFactor, metalnessFactor and the normal, then the emissive and the ambient occlusion.
 * Constants are uniforms (`kmC`), so changing a colour or a number needs no new shader.
 *
 * @param doc - The graph.
 * @returns `ok` and `issues` (from {@link validateMaterialDoc}); when ok: `decl`, `main`, `emissive`, `ao`, the
 *   constants (`consts`: node id and linear [x, y, z, w]), the textures (`textures`: node id and source slot),
 *   `transparent`, `usesTime` and `key` (changes when the shader's code changes).
 */
export function compileMaterialGlsl(doc) {
  const v = validateMaterialDoc(doc);
  if (!v.ok) return { ok: false, issues: v.issues };
  const { order, into, byId } = reachOrder(doc);
  const types = resolveTypes(doc);
  const consts = [];
  const textures = [];
  const lines = [];
  const varOf = (id, pin) => `km_${id.replace(/[^\w]/g, "_")}_${pin}`;
  let usesTime = false;
  const out = order.find((n) => n.cls === "Output");
  /** The expression for an input, in the type it needs. */
  const input = (n, name, want) => {
    const def = BY_CLS.get(n.cls);
    const p = def.ins.find((x) => x[0] === name);
    const l = (into.get(n.id) ?? []).find((x) => x.in === name);
    if (l) {
      const src = byId.get(l.from);
      if (src.cls === "TextureAsset") return `kmTex${textures.findIndex((t) => t.node === src.id)}`;
      return conv(varOf(src.id, l.out), types.get(src.id).out[l.out], want);
    }
    if (p[2] === "uv") return conv("kmUv", "vec2", want);
    if (p[2] === "time") { usesTime = true; return conv("kmTime", "float", want); }
    if (p[2] === "normal") return conv("normal", "vec3", want);
    let value = n.values?.[name] ?? p[2];
    if (def.c?.includes(name)) value = (Array.isArray(value) ? value : [value]).map((c) => srgbToLinear(num(c)));
    return litOf(want, value);
  };
  for (const n of order) {
    const def = BY_CLS.get(n.cls);
    const t = types.get(n.id);
    const dyn = t.dyn;
    const I = (name) => input(n, name, (() => { const p = def.ins.find((x) => x[0] === name); return p[1] === "dyn" ? dyn : p[1]; })());
    const set = (pin, expr) => lines.push(`${t.out[pin]} ${varOf(n.id, pin)} = ${expr};`);
    switch (n.cls) {
      case "Float": case "Color": case "Vector2": case "Vector3": case "Vector4": {
        const raw = n.props?.value ?? def.props.value;
        const vec = n.cls === "Color" ? hexToRgb(raw).map(srgbToLinear) : Array.isArray(raw) ? raw : [num(raw)];
        const i = consts.push({ node: n.id, value: [0, 1, 2, 3].map((k) => num(vec[k], 0)) }) - 1;
        set("Out", `kmC[${i}]${{ Float: ".x", Color: ".rgb", Vector2: ".xy", Vector3: ".xyz", Vector4: "" }[n.cls]}`);
        break;
      }
      case "Time": usesTime = true; set("Time", "kmTime"); break;
      case "UV": set("Out", "kmUv"); break;
      case "TilingOffset": set("Out", `${I("UV")} * ${I("Tiling")} + ${I("Offset")}`); break;
      case "Panner": set("Out", `${I("UV")} + ${I("Speed")} * ${I("Time")}`); break;
      case "TextureAsset": textures.push({ node: n.id, source: TEXTURE_SOURCES.includes(n.props?.source) ? n.props.source : "map" }); break;
      case "TextureSample": {
        const linked = (into.get(n.id) ?? []).some((l) => l.in === "Texture");
        set("RGBA", linked ? `texture2D(${I("Texture")}, ${I("UV")})` : "vec4(1.0)");
        for (const [c, s] of [["R", "r"], ["G", "g"], ["B", "b"], ["A", "a"]]) set(c, `${varOf(n.id, "RGBA")}.${s}`);
        break;
      }
      case "NormalUnpack": set("Out", `${I("In")}.xyz * 2.0 - 1.0`); break;
      case "NormalStrength": { const i = I("In"), s = I("Strength"); set("Out", `vec3(${i}.xy * ${s}, mix(1.0, ${i}.z, clamp(${s}, 0.0, 1.0)))`); break; }
      case "Add": set("Out", `${I("A")} + ${I("B")}`); break;
      case "Subtract": set("Out", `${I("A")} - ${I("B")}`); break;
      case "Multiply": set("Out", `${I("A")} * ${I("B")}`); break;
      case "Divide": set("Out", `${I("A")} / ${I("B")}`); break;
      case "Power": set("Out", `pow(${I("A")}, ${I("B")})`); break;
      case "Min": set("Out", `min(${I("A")}, ${I("B")})`); break;
      case "Max": set("Out", `max(${I("A")}, ${I("B")})`); break;
      case "Lerp": set("Out", `mix(${I("A")}, ${I("B")}, ${I("T")})`); break;
      case "Clamp": set("Out", `clamp(${I("In")}, ${I("Min")}, ${I("Max")})`); break;
      case "OneMinus": set("Out", `1.0 - ${I("In")}`); break;
      case "Saturate": set("Out", `clamp(${I("In")}, 0.0, 1.0)`); break;
      case "Sine": set("Out", `sin(${I("In")})`); break;
      case "Abs": set("Out", `abs(${I("In")})`); break;
      case "Normalize": set("Out", `normalize(${I("In")})`); break;
      case "Dot": set("Out", `dot(${I("A")}, ${I("B")})`); break;
      case "Step": set("Out", `step(${I("Edge")}, ${I("In")})`); break;
      case "Smoothstep": set("Out", `smoothstep(${I("Edge1")}, ${I("Edge2")}, ${I("In")})`); break;
      case "Fresnel": set("Out", `pow(1.0 - clamp(dot(normalize(${I("Normal")}), normalize(vViewPosition)), 0.0, 1.0), ${I("Power")})`); break;
      case "Split": {
        const w = WIDTH[dyn], i = I("In");
        ["R", "G", "B", "A"].forEach((c, k) => set(c, k >= w ? "0.0" : w === 1 ? i : `${i}.${"xyzw"[k]}`));
        break;
      }
      case "Combine": { const r = I("R"), g = I("G"), b = I("B"), a = I("A"); set("RGBA", `vec4(${r}, ${g}, ${b}, ${a})`); set("RGB", `vec3(${r}, ${g}, ${b})`); set("RG", `vec2(${r}, ${g})`); break; }
      case "Output": break;
    }
  }
  const linked = (name) => (into.get(out.id) ?? []).some((l) => l.in === name);
  const opacity = input(out, "Opacity", "float");
  const transparent = linked("Opacity") || num(out.values?.Opacity, 1) < 1;
  lines.push(`diffuseColor.rgb = ${input(out, "BaseColor", "vec3")};`);
  if (transparent) lines.push(`diffuseColor.a *= ${opacity};`);
  lines.push(`metalnessFactor = clamp(${input(out, "Metallic", "float")}, 0.0, 1.0);`);
  lines.push(`roughnessFactor = clamp(${input(out, "Roughness", "float")}, 0.04, 1.0);`);
  if (linked("Normal")) lines.push(`normal = normalize(kmTangentFrame(-vViewPosition, normal, kmUv) * ${input(out, "Normal", "vec3")});`);
  const decl = [
    "varying vec2 kmUv;",
    ...(usesTime ? ["uniform float kmTime;"] : []),
    ...(consts.length ? [`uniform vec4 kmC[${consts.length}];`] : []),
    ...textures.map((_, i) => `uniform sampler2D kmTex${i};`),
    ...(linked("Normal") ? [TANGENT_FRAME] : []),
  ].join("\n");
  const main = lines.map((l) => `  ${l}`).join("\n");
  const emissive = `totalEmissiveRadiance = ${input(out, "Emissive", "vec3")};`;
  const ao = linked("AO") || num(out.values?.AO, 1) !== 1 ? `{ float kmAo = clamp(${input(out, "AO", "float")}, 0.0, 1.0); reflectedLight.indirectDiffuse *= kmAo; reflectedLight.indirectSpecular *= kmAo; }` : "";
  return { ok: true, issues: [], decl, main, emissive, ao, consts, textures, transparent, usesTime, key: `km${hash32(decl + main + emissive + ao)}` };
}

// The tangent frame from screen derivatives (no tangents needed), as three.js's own getTangentFrame.
const TANGENT_FRAME = `mat3 kmTangentFrame(vec3 eye_pos, vec3 surf_norm, vec2 uv) {
  vec3 q0 = dFdx(eye_pos.xyz); vec3 q1 = dFdy(eye_pos.xyz);
  vec2 st0 = dFdx(uv.st); vec2 st1 = dFdy(uv.st);
  vec3 N = normalize(surf_norm);
  vec3 q1perp = cross(q1, N); vec3 q0perp = cross(N, q0);
  vec3 Tn = q1perp * st0.x + q0perp * st1.x; vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(Tn, Tn), dot(B, B));
  float scale = (det == 0.0) ? 0.0 : inversesqrt(det);
  return mat3(Tn * scale, B * scale, N);
}`;

/**
 * Puts a compiled graph into three.js's standard/physical shader source (the strings onBeforeCompile gets).
 *
 * @param vertex - The vertex shader.
 * @param fragment - The fragment shader.
 * @param c - From {@link compileMaterialGlsl}.
 * @returns The two shaders; unchanged when a chunk they need is not there.
 */
export function patchShaders(vertex, fragment, c) {
  const need = ["#include <common>", "#include <normal_fragment_maps>", "#include <emissivemap_fragment>", "#include <aomap_fragment>"];
  if (!c?.ok || !vertex.includes("#include <uv_vertex>") || need.some((s) => !fragment.includes(s))) return { vertex, fragment };
  const v = vertex.replace("#include <common>", "#include <common>\nvarying vec2 kmUv;").replace("#include <uv_vertex>", "#include <uv_vertex>\n  kmUv = uv;");
  const f = fragment
    .replace("#include <common>", `#include <common>\n${c.decl}`)
    .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>\n  // KesherAI material graph\n${c.main}`)
    .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>\n  ${c.emissive}`)
    .replace("#include <aomap_fragment>", `#include <aomap_fragment>\n  ${c.ao}`);
  return { vertex: v, fragment: f };
}

// ---------- ids ----------
/** A 32-bit FNV-1a hash of a string, as 8 hex digits. */
function hash32(s, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
/** A Unity-style 32-hex-digit object id that is always the same for the same words (so exports are deterministic). */
function oid(...parts) {
  const s = parts.join("|");
  return [0x811c9dc5, 0x2f6b9a1d, 0x5bd1e995, 0x1b873593].map((seed) => hash32(s, seed)).join("");
}

// ---------- export to Unity Shader Graph (URP Lit) ----------
/**
 * The nodes of a graph that an engine cannot take (they block the export), with why and what to use instead.
 *
 * @param doc - The graph.
 * @param engine - "unity" (Shader Graph) or "unreal".
 * @returns One entry per node: id, class, title and why (English and Hebrew).
 */
export function unsupportedNodes(doc, engine = "unity") {
  return (doc?.nodes ?? []).flatMap((n) => {
    const def = BY_CLS.get(n.cls);
    const ok = engine === "unreal" ? !!def?.ue : !!def?.u || n.cls === "Output";
    if (ok) return [];
    return [{ node: n.id, cls: n.cls, title: def?.title ?? n.cls, he: def?.he ?? n.cls, why: def?.why ?? { en: `${engine === "unreal" ? "Unreal" : "Shader Graph"} has no such node.`, he: "אין נוד כזה במנוע." } }];
  });
}

const SG = "UnityEditor.ShaderGraph.";
const xyzw = (a, w = 4) => Object.fromEntries("xyzw".slice(0, w).split("").map((k, i) => [k, num(a?.[i], 0)]));
/** A Shader Graph slot object. */
function slot(id, type, slotId, name, dir, extra = {}) {
  return { m_SGVersion: 0, m_Type: SG + type, m_ObjectId: id, m_Id: slotId, m_DisplayName: name, m_SlotType: dir, m_Hidden: false, m_ShaderOutputName: name.replace(/\s/g, ""), m_StageCapability: 3, ...extra };
}
/** The Shader Graph slot for one of our pins (its class and value). */
function slotFor(id, n, pinName, slotId, dir, type, value) {
  const p = n.cls === "TextureSample" && pinName === "Texture" ? "tex-in" : n.cls === "TextureSample" && pinName === "UV" || n.cls === "TilingOffset" && pinName === "UV" ? "uv" : n.cls === "Fresnel" && pinName === "Normal" ? "normal" : n.cls === "TextureAsset" ? "tex-out" : type;
  const arr = Array.isArray(value) ? value : [num(value, 0)];
  switch (p) {
    case "tex-in": return slot(id, "Texture2DInputMaterialSlot", slotId, pinName, dir, { m_BareResource: false, m_Texture: { m_SerializedTexture: "", m_Guid: "" }, m_DefaultType: 0 });
    case "tex-out": return slot(id, "Texture2DMaterialSlot", slotId, "Out", dir, { m_BareResource: false });
    case "uv": return slot(id, "UVMaterialSlot", slotId, "UV", dir, { m_Value: { x: 0, y: 0 }, m_DefaultValue: { x: 0, y: 0 }, m_Labels: [], m_Channel: 0 });
    case "normal": return slot(id, "NormalMaterialSlot", slotId, "Normal", dir, { m_Value: { x: 0, y: 0, z: 0 }, m_DefaultValue: { x: 0, y: 0, z: 0 }, m_Labels: [], m_Space: 2 });
    case "float": return slot(id, "Vector1MaterialSlot", slotId, pinName, dir, { m_Value: num(arr[0]), m_DefaultValue: num(arr[0]), m_Labels: [] });
    case "vec2": case "vec3": case "vec4": {
      const w = WIDTH[p];
      return slot(id, `Vector${w}MaterialSlot`, slotId, pinName, dir, { m_Value: xyzw(arr, w), m_DefaultValue: xyzw(arr, w), m_Labels: [] });
    }
    default: {
      const v = xyzw(arr.length === 1 ? [arr[0], arr[0], arr[0], arr[0]] : arr);
      if (n.cls === "Multiply") {
        const m = {};
        for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) m[`e${r}${c}`] = r === 0 ? v["xyzw"[c]] : 0;
        return slot(id, "DynamicValueMaterialSlot", slotId, pinName, dir, { m_Value: m, m_DefaultValue: m });
      }
      return slot(id, "DynamicVectorMaterialSlot", slotId, pinName, dir, { m_Value: v, m_DefaultValue: v });
    }
  }
}

// The URP Lit stack: [block, our pin, slot class, display name, slot extras].
const FRAGMENT_BLOCKS = [
  ["BaseColor", "BaseColor", "ColorRGBMaterialSlot", "Base Color"],
  ["NormalTS", "Normal", "NormalMaterialSlot", "Normal (Tangent Space)"],
  ["Metallic", "Metallic", "Vector1MaterialSlot", "Metallic"],
  ["Smoothness", "Roughness", "Vector1MaterialSlot", "Smoothness"],
  ["Emission", "Emissive", "ColorRGBMaterialSlot", "Emission"],
  ["Occlusion", "AO", "Vector1MaterialSlot", "Ambient Occlusion"],
];

/**
 * Writes a Unity Shader Graph (.shadergraph: JSON objects one after another, as Unity saves them) for the URP Lit
 * target. Roughness becomes Smoothness (a One Minus node when wired, 1 − value when not); Opacity makes it
 * transparent with an Alpha block; each Texture node is a Texture2D property the material shows. The same graph
 * always gives the same text.
 *
 * @param doc - The graph.
 * @param o - `name`: the shader's name in Unity's menu (Shader Graphs/<name>).
 * @returns `ok` and `text`, or the reasons it cannot: `issues` (the graph has problems) and `unsupported` (nodes
 *   Shader Graph does not have).
 */
export function exportShaderGraph(doc, o = {}) {
  const v = validateMaterialDoc(doc);
  const unsupported = unsupportedNodes(doc, "unity");
  if (!v.ok || unsupported.length) return { ok: false, issues: v.issues, unsupported };
  const name = String(o.name || doc.name || "Material").replace(/[^\w\- ]/g, "").trim() || "Material";
  const salt = `${name}`;
  const objs = [];
  const nodeRefs = [], edges = [], props = [];
  const nodeId = (n) => oid(salt, "node", n.id);
  const slotId = (n, pin) => oid(salt, "slot", n.id, pin);
  const out = doc.nodes.find((n) => n.cls === "Output");
  const minX = Math.min(...doc.nodes.map((n) => n.x)), maxX = Math.max(...doc.nodes.map((n) => n.x));
  const draw = (x, y) => ({ m_Expanded: true, m_Position: { serializedVersion: "2", x: Math.round((x - minX) * 1.4) - 800, y: Math.round(y * 1.4) - 200, width: 208, height: 302 } });
  const common = (n, type, title, slots) => ({ m_SGVersion: 0, m_Type: SG + type, m_ObjectId: nodeId(n), m_Group: { m_Id: "" }, m_Name: title, m_DrawState: draw(n.x, n.y), m_Slots: slots.map((s) => ({ m_Id: s.m_ObjectId })), synonyms: [], m_Precision: 0, m_PreviewExpanded: true, m_DismissedVersion: 0, m_PreviewMode: 0, m_CustomColors: { m_SerializableColors: [] } });
  const usedNames = new Set();
  const texProp = new Map();
  for (const n of doc.nodes) {
    if (n.cls !== "TextureAsset") continue;
    const src = n.props?.source ?? "map";
    let base = String(n.props?.name || { map: "BaseMap", normalMap: "NormalMap", roughnessMap: "RoughnessMap", metalnessMap: "MetallicMap", emissiveMap: "EmissionMap", aoMap: "OcclusionMap", alphaMap: "AlphaMap" }[src] || "Texture");
    for (let i = 2; usedNames.has(base); i++) base = `${base.replace(/\d+$/, "")}${i}`;
    usedNames.add(base);
    const pid = oid(salt, "prop", n.id);
    texProp.set(n.id, pid);
    props.push({ m_SGVersion: 0, m_Type: `${SG}Internal.Texture2DShaderProperty`, m_ObjectId: pid, m_Guid: { m_GuidSerialized: guidOf(pid) }, m_Name: base, m_DefaultRefNameVersion: 1, m_RefNameGeneratedByDisplayName: `_${base}`, m_DefaultReferenceName: `_${base}`, m_OverrideReferenceName: "", m_GeneratePropertyBlock: true, m_UseCustomSlotLabel: false, m_CustomSlotLabel: "", m_DismissedVersion: 0, m_Precision: 0, overrideHLSLDeclaration: false, hlslDeclarationOverride: 0, m_Hidden: false, m_Value: { m_SerializedTexture: "", m_Guid: "" }, isMainTexture: src === "map", useTilingAndOffset: false, m_Modifiable: true, m_DefaultType: src === "normalMap" ? 3 : 0 });
  }
  for (const n of doc.nodes) {
    if (n.cls === "Output") continue;
    const def = BY_CLS.get(n.cls);
    const [type, ids] = def.u;
    const slots = [];
    for (const [pin, t, dflt] of def.ins) slots.push(slotFor(slotId(n, pin), n, pin, ids[pin], 0, t, n.values?.[pin] ?? (typeof dflt === "string" || dflt === null ? 0 : dflt)));
    for (const [pin, t] of def.outs) slots.push(slotFor(slotId(n, pin), n, pin, ids[pin], 1, t, 0));
    if (n.cls === "TextureSample") slots.push(slot(oid(salt, "slot", n.id, "Sampler"), "SamplerStateMaterialSlot", 3, "Sampler", 0, { m_BareResource: false }));
    const node = common(n, type, def.title, slots);
    const value = n.props?.value ?? def.props?.value;
    if (n.cls === "Float") node.m_Value = num(value);
    if (n.cls === "Color") { const [r, g, b] = hexToRgb(value); node.m_Color = { color: { r, g, b, a: 1 }, mode: 0 }; }
    if (/^Vector[234]$/.test(n.cls)) node.m_Value = xyzw(value, Number(n.cls.slice(-1)));
    if (n.cls === "UV") node.m_OutputChannel = 0;
    if (n.cls === "TextureSample") Object.assign(node, { m_TextureType: 0, m_NormalMapSpace: 0, m_EnableGlobalMipBias: true, m_MipSamplingMode: 0 });
    if (n.cls === "NormalUnpack") node.m_NormalMapSpace = 0;
    if (n.cls === "TextureAsset") node.m_Property = { m_Id: texProp.get(n.id) };
    nodeRefs.push({ m_Id: node.m_ObjectId });
    objs.push(node, ...slots);
  }
  const edge = (fromNode, fromSlot, toNode, toSlot) => edges.push({ m_OutputSlot: { m_Node: { m_Id: fromNode }, m_SlotId: fromSlot }, m_InputSlot: { m_Node: { m_Id: toNode }, m_SlotId: toSlot } });
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  for (const l of doc.links) {
    if (l.to === out.id) continue;
    const a = byId.get(l.from), b = byId.get(l.to);
    edge(nodeId(a), BY_CLS.get(a.cls).u[1][l.out], nodeId(b), BY_CLS.get(b.cls).u[1][l.in]);
  }
  // The Master Stack: vertex and fragment blocks, each a BlockNode with one input slot.
  const transparent = doc.links.some((l) => l.to === out.id && l.in === "Opacity") || num(out.values?.Opacity, 1) < 1;
  const outVal = (pin) => out.values?.[pin] ?? BY_CLS.get("Output").ins.find((p) => p[0] === pin)[2];
  const block = (ctx, descriptor, cls, title, extra, i) => {
    const id = oid(salt, "block", descriptor);
    const s = slot(oid(salt, "blockslot", descriptor), cls, 0, title, 0, extra);
    s.m_ShaderOutputName = descriptor;
    objs.push({ m_SGVersion: 0, m_Type: `${SG}BlockNode`, m_ObjectId: id, m_Group: { m_Id: "" }, m_Name: `${ctx}Description.${descriptor}`, m_DrawState: { m_Expanded: true, m_Position: { serializedVersion: "2", x: 0, y: 0, width: 0, height: 0 } }, m_Slots: [{ m_Id: s.m_ObjectId }], synonyms: [], m_Precision: 0, m_PreviewExpanded: true, m_DismissedVersion: 0, m_PreviewMode: 0, m_CustomColors: { m_SerializableColors: [] }, m_SerializedDescriptor: `${ctx}Description.${descriptor}`, m_Order: i }, s);
    return id;
  };
  const vertex = [
    block("Vertex", "Position", "PositionMaterialSlot", "Position", { m_Value: xyzw([0, 0, 0], 3), m_DefaultValue: xyzw([0, 0, 0], 3), m_Labels: [], m_Space: 0 }, 0),
    block("Vertex", "Normal", "NormalMaterialSlot", "Normal", { m_Value: xyzw([0, 0, 0], 3), m_DefaultValue: xyzw([0, 0, 0], 3), m_Labels: [], m_Space: 0 }, 1),
    block("Vertex", "Tangent", "TangentMaterialSlot", "Tangent", { m_Value: xyzw([0, 0, 0], 3), m_DefaultValue: xyzw([0, 0, 0], 3), m_Labels: [], m_Space: 0 }, 2),
  ];
  const fragment = [];
  const blocks = transparent ? [...FRAGMENT_BLOCKS, ["Alpha", "Opacity", "Vector1MaterialSlot", "Alpha"]] : FRAGMENT_BLOCKS;
  blocks.forEach(([descriptor, pin, cls, title], i) => {
    let value = outVal(pin);
    if (pin === "Roughness") value = 1 - num(value, 0.5);
    const arr = Array.isArray(value) ? value : [num(value, 0)];
    const extra = cls === "Vector1MaterialSlot" ? { m_Value: num(arr[0]), m_DefaultValue: num(arr[0]), m_Labels: [] }
      : cls === "NormalMaterialSlot" ? { m_Value: xyzw([0, 0, 0], 3), m_DefaultValue: xyzw([0, 0, 0], 3), m_Labels: [], m_Space: 3 }
      : { m_Value: xyzw(arr, 3), m_DefaultValue: xyzw(arr, 3), m_Labels: [], m_ColorMode: descriptor === "Emission" ? 1 : 0, m_DefaultColor: { r: num(arr[0]), g: num(arr[1]), b: num(arr[2]), a: 1 } };
    const id = block("Surface", descriptor, cls, title, extra, i);
    fragment.push(id);
    const l = doc.links.find((x) => x.to === out.id && x.in === pin);
    if (!l) return;
    const a = byId.get(l.from);
    const from = [nodeId(a), BY_CLS.get(a.cls).u[1][l.out]];
    if (pin === "Roughness") {
      // Unity's Lit takes Smoothness: a One Minus between the roughness and the block.
      const om = { id: "__roughness_to_smoothness", cls: "OneMinus", x: maxX, y: out.y + 120 };
      const slots = [slotFor(slotId(om, "In"), om, "In", 0, 0, "dyn", 0), slotFor(slotId(om, "Out"), om, "Out", 1, 1, "dyn", 0)];
      const node = common(om, "OneMinusNode", "One Minus (roughness → smoothness)", slots);
      objs.push(node, ...slots);
      nodeRefs.push({ m_Id: node.m_ObjectId });
      edge(from[0], from[1], node.m_ObjectId, 0);
      edge(node.m_ObjectId, 1, id, 0);
    } else edge(from[0], from[1], id, 0);
  });
  const catId = oid(salt, "category");
  const targetId = oid(salt, "target"), subId = oid(salt, "lit");
  const graph = {
    m_SGVersion: 3, m_Type: `${SG}GraphData`, m_ObjectId: oid(salt, "graph"),
    m_Properties: props.map((p) => ({ m_Id: p.m_ObjectId })), m_Keywords: [], m_Dropdowns: [], m_CategoryData: [{ m_Id: catId }],
    m_Nodes: [...nodeRefs, ...vertex.map((id) => ({ m_Id: id })), ...fragment.map((id) => ({ m_Id: id }))],
    m_GroupDatas: [], m_StickyNoteDatas: [], m_Edges: edges,
    m_VertexContext: { m_Position: { x: Math.round((maxX - minX) * 1.4) - 500, y: -200 }, m_Blocks: vertex.map((id) => ({ m_Id: id })) },
    m_FragmentContext: { m_Position: { x: Math.round((maxX - minX) * 1.4) - 500, y: 100 }, m_Blocks: fragment.map((id) => ({ m_Id: id })) },
    m_PreviewData: { serializedMesh: { m_SerializedMesh: "{\"mesh\":{\"instanceID\":0}}", m_Guid: "" }, preventRotation: false },
    m_Path: "Shader Graphs", m_GraphPrecision: 1, m_PreviewMode: 2, m_OutputNode: { m_Id: "" }, m_SubDatas: [], m_ActiveTargets: [{ m_Id: targetId }],
  };
  const category = { m_SGVersion: 0, m_Type: `${SG}CategoryData`, m_ObjectId: catId, m_Name: "", m_ChildObjectList: props.map((p) => ({ m_Id: p.m_ObjectId })) };
  const target = { m_SGVersion: 1, m_Type: "UnityEditor.Rendering.Universal.ShaderGraph.UniversalTarget", m_ObjectId: targetId, m_Datas: [], m_ActiveSubTarget: { m_Id: subId }, m_AllowMaterialOverride: false, m_SurfaceType: transparent ? 1 : 0, m_ZTestMode: 4, m_ZWriteControl: 0, m_AlphaMode: 0, m_RenderFace: 2, m_AlphaClip: false, m_CastShadows: true, m_ReceiveShadows: true, m_SupportsLODCrossFade: false, m_CustomEditorGUI: "", m_SupportVFX: false };
  const lit = { m_SGVersion: 2, m_Type: "UnityEditor.Rendering.Universal.ShaderGraph.UniversalLitSubTarget", m_ObjectId: subId, m_WorkflowMode: 1, m_NormalDropOffSpace: 0, m_ClearCoat: false, m_BlendModePreserveSpecular: true };
  const text = [graph, category, ...props, ...objs, target, lit].map((x) => JSON.stringify(x, null, 4)).join("\n\n") + "\n\n";
  return { ok: true, issues: [], unsupported: [], text, name };
}
/** A dashed GUID from a 32-hex-digit id. */
function guidOf(h) { return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`; }

// ---------- Unreal: the command the KesherAI Bridge plugin will run (its side comes next) ----------
/**
 * The `material_build` command for the KesherAI Bridge plugin (UMaterialEditingLibrary: create the material, add
 * each expression, connect them and the material's inputs, recompile, save). The plugin side is not there yet;
 * this is the interface it will take. Normal maps' green channel is flipped on the way (Unreal is DirectX-style).
 *
 * @param doc - The graph.
 * @param path - The new material's asset path, e.g. "/Game/Materials/M_Rock".
 * @returns The command, or `ok: false` with the problems and the nodes Unreal does not have.
 */
export function unrealMaterialCommand(doc, path) {
  const v = validateMaterialDoc(doc);
  const unsupported = unsupportedNodes(doc, "unreal");
  if (!v.ok || unsupported.length) return { ok: false, issues: v.issues, unsupported };
  const out = doc.nodes.find((n) => n.cls === "Output");
  const prop = { BaseColor: "MP_BaseColor", Metallic: "MP_Metallic", Roughness: "MP_Roughness", Normal: "MP_Normal", Emissive: "MP_EmissiveColor", Opacity: "MP_Opacity", AO: "MP_AmbientOcclusion" };
  return {
    ok: true,
    command: "material_build",
    args: {
      path: String(path || `/Game/KesherAI/M_${String(doc.name || "Material").replace(/[^\w]/g, "")}`),
      blendMode: doc.links.some((l) => l.to === out.id && l.in === "Opacity") ? "BLEND_Translucent" : "BLEND_Opaque",
      expressions: doc.nodes.filter((n) => n !== out).map((n) => ({ id: n.id, class: BY_CLS.get(n.cls).ue, node: n.cls, x: n.x, y: n.y, values: n.values ?? {}, props: n.props ?? {} })),
      links: doc.links.filter((l) => l.to !== out.id),
      outputs: doc.links.filter((l) => l.to === out.id).map((l) => ({ property: prop[l.in], from: l.from, out: l.out })),
      flipNormalGreen: true,
    },
  };
}

// ---------- the chat's material_graph tool ----------
/** The `material_graph` tool, as a chat model sees it (JSON schema). */
export const MATERIAL_GRAPH_TOOL = {
  name: "material_graph",
  description: "Build or change the node material graph of the chosen 3D part with node operations. Ops run in order; an added node's id (yours) can be used by later ops.",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string", description: "One short sentence: what the graph does now." },
      ops: {
        type: "array",
        items: {
          type: "object",
          properties: {
            op: { type: "string", enum: ["add", "delete", "move", "connect", "disconnect", "set"] },
            cls: { type: "string", description: "add: the node class." },
            id: { type: "string", description: "add: an id for the new node." },
            node: { type: "string" }, from: { type: "string" }, out: { type: "string" }, to: { type: "string" }, in: { type: "string" },
            pin: { type: "string" }, prop: { type: "string" }, value: {}, x: { type: "number" }, y: { type: "number" },
          },
          required: ["op"],
        },
      },
    },
    required: ["ops"],
  },
};

/**
 * The system and user messages that ask a chat model for a `material_graph` call: the tool, every node class with
 * its pins, and the graph as it is.
 *
 * @param doc - The graph now.
 * @param words - What the person asked (any language).
 * @returns Chat messages.
 */
export function materialChatMessages(doc, words) {
  const classes = MATERIAL_NODES.map((d) => `${d.cls}(${d.ins.map((p) => `${p[0]}:${p[1]}`).join(", ")}${d.props ? `; props ${Object.keys(d.props).join(", ")}` : ""}) -> ${d.outs.map((p) => `${p[0]}:${p[1]}`).join(", ") || "material"}`).join("\n");
  const now = (doc?.nodes ?? []).map((n) => `${n.id}: ${n.cls}${n.props ? ` ${JSON.stringify(n.props)}` : ""}${n.values ? ` values ${JSON.stringify(n.values)}` : ""}`).join("\n");
  const wires = (doc?.links ?? []).map((l) => `${l.from}.${l.out} -> ${l.to}.${l.in}`).join("\n");
  return [
    { role: "system", content: `You edit a node material graph (PBR, like Unity Shader Graph). Answer with JSON only, no other text: {"tool":"material_graph","summary":"…","ops":[…]}.\nTool: ${JSON.stringify(MATERIAL_GRAPH_TOOL)}\nNode classes (inputs -> outputs; dyn = any vector):\n${classes}\nRules: the Output node (id "out") stays; a value of a colour is "#rrggbb" for Color props and [r,g,b] 0..1 for pins; Texture nodes read the part's own textures (prop source: ${TEXTURE_SOURCES.join(", ")}); place new nodes left of the output (x 0..500, y 0..600, 180 apart). Use as few nodes as do the job.` },
    { role: "user", content: `The graph now:\n${now || "(empty)"}\nWires:\n${wires || "(none)"}\n\nRequest: ${String(words).slice(0, 1500)}` },
  ];
}

/**
 * Reads a chat model's answer as a `material_graph` call (JSON, maybe inside other words or a code block).
 *
 * @param text - The answer.
 * @returns `{ ops, summary }`, or undefined when it holds no ops.
 */
export function parseMaterialToolCall(text) {
  const s = String(text ?? "");
  const start = s.indexOf("{"), end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const j = JSON.parse(s.slice(start, end + 1));
    const call = j?.arguments && typeof j.arguments === "object" ? j.arguments : j;
    if (!Array.isArray(call?.ops) || !call.ops.length) return undefined;
    return { ops: call.ops.slice(0, 200), summary: typeof call.summary === "string" ? call.summary.slice(0, 300) : "" };
  } catch {
    return undefined;
  }
}
