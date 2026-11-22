// The 3D editor's material graph (docs/research/c-20261122-14.md; Unity Shader Graph, Unreal's Material Editor and
// Blender's shader nodes): the chosen part's material as nodes in a dock under the view, previewed live on the model,
// saved inside the material (glTF extras, so it goes with the GLB and back into game projects), exported as a Unity
// Shader Graph (approval card into the opened Unity project, else a file), and built by the chat model from words
// (the material_graph tool: its ops are previewed, then kept or discarded). A phone gets the same: one finger pans,
// two pinch, a tap on an output and then on an input connects them.
/* global matchMedia, document, Blob, URL, addEventListener, removeEventListener, requestAnimationFrame, setTimeout, CSS, TextEncoder */
import * as THREE from "three";
import { MATERIAL_NODES, TEXTURE_SOURCES, applyMaterialOps, compileMaterialGlsl, exportShaderGraph, materialChatMessages, nodeDef, parseMaterialToolCall, patchShaders, starterDoc, typesFit, unsupportedNodes, validateMaterialDoc } from "./material-doc.js";
import { openMenu } from "./add-media.js";

let he = false;
/**
 * Hebrew or English for the dock's words.
 *
 * @param on - Hebrew.
 */
export function setHebrew(on) { he = on; }
const L = (h, e) => (he ? h : e);
const $ = (id) => document.getElementById(id);

// ---------- the live preview (three.js WebGL: the graph's GLSL put into the standard shader) ----------
const TIME = { value: 0 };
/**
 * Moves the graphs' Time on (call once a frame).
 *
 * @param seconds - The time now, in seconds.
 */
export function tick(seconds) { TIME.value = seconds; }

/** Each material's shader state: its code key and the uniforms the shader reads. */
const live = new WeakMap();
const WHITE = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
const FLAT = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
WHITE.needsUpdate = FLAT.needsUpdate = true;

/**
 * Shows a graph on a material: a new shader only when the graph's wiring changed; constants and textures are
 * uniforms. The graph is kept in the material's userData (glTF extras). A graph with problems leaves the last good one.
 *
 * @param material - A MeshStandardMaterial or MeshPhysicalMaterial.
 * @param doc - The graph.
 * @returns The compile result (`ok`, `issues`).
 */
export function applyGraph(material, doc) {
  material.userData.kesherGraph = JSON.parse(JSON.stringify(doc));
  const c = compileMaterialGlsl(doc);
  if (!c.ok) return c;
  let st = live.get(material);
  if (!st) { st = { key: "", uniforms: { kmTime: TIME, kmC: { value: [] } }, transparent: material.transparent }; live.set(material, st); }
  st.uniforms.kmC.value = c.consts.map((k) => new THREE.Vector4(...k.value));
  c.textures.forEach((t, i) => { (st.uniforms[`kmTex${i}`] ??= { value: null }).value = material[t.source] ?? (t.source === "normalMap" ? FLAT : WHITE); });
  // What a GLB reader without the graph sees: the output's own numbers, and a colour wired straight in.
  const out = doc.nodes.find((n) => n.cls === "Output");
  const into = (pin) => doc.links.find((l) => l.to === out.id && l.in === pin);
  if (!into("Roughness")) material.roughness = Number(out.values?.Roughness ?? 0.5);
  if (!into("Metallic")) material.metalness = Number(out.values?.Metallic ?? 0);
  const base = into("BaseColor") && doc.nodes.find((n) => n.id === into("BaseColor").from);
  if (base?.cls === "Color" && material.color) material.color.set(base.props?.value ?? "#cccccc");
  if (st.key !== c.key) {
    st.key = c.key;
    const uniforms = st.uniforms;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      const p = patchShaders(shader.vertexShader, shader.fragmentShader, c);
      shader.vertexShader = p.vertex;
      shader.fragmentShader = p.fragment;
    };
    material.customProgramCacheKey = () => c.key;
    material.transparent = c.transparent || st.transparent;
    material.needsUpdate = true;
  }
  return c;
}

/**
 * Takes a graph off a material (back to its own settings).
 *
 * @param material - The material.
 */
export function clearGraph(material) {
  delete material.userData.kesherGraph;
  const st = live.get(material);
  if (!st) return;
  material.onBeforeCompile = THREE.Material.prototype.onBeforeCompile;
  material.customProgramCacheKey = THREE.Material.prototype.customProgramCacheKey;
  material.transparent = st.transparent;
  live.delete(material);
  material.needsUpdate = true;
}

/**
 * Shows the graphs kept in a model's materials (a GLB saved with graphs, a duplicated part).
 *
 * @param root - The model.
 */
export function restoreGraphs(root) {
  root?.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m?.userData?.kesherGraph && !live.has(m) && m.isMeshStandardMaterial) applyGraph(m, m.userData.kesherGraph);
    }
  });
}

/** The part's material as a standard one (Phong or Lambert from OBJ / FBX become standard, keeping colour and maps). */
function pbrOf(mesh) {
  const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  if (m?.isMeshStandardMaterial) return m;
  const s = new THREE.MeshStandardMaterial({ color: m?.color ?? 0xcccccc, map: m?.map ?? null, normalMap: m?.normalMap ?? null, transparent: !!m?.transparent, opacity: m?.opacity ?? 1, side: m?.side ?? THREE.FrontSide, name: m?.name ?? "" });
  if (Array.isArray(mesh.material)) mesh.material[0] = s; else mesh.material = s;
  return s;
}

// ---------- the dock ----------
// Rows are taller under a finger (a phone or a tablet), so each pin is a bigger target.
const W = 170, HEAD = 24, ROW = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches ? 26 : 20, PROP = 22;
const PIN_COLOR = { float: "#9ee35a", vec2: "#2ad3ba", vec3: "#f2c94c", vec4: "#e8839b", tex: "#ff8b5a", dyn: "#9aa0a6" };
const CAT = { input: ["קלט", "Input"], coords: ["קואורדינטות", "Coordinates"], texture: ["טקסטורות", "Textures"], math: ["מתמטיקה", "Math"], vector: ["וקטורים", "Vectors"] };

const S = {
  /** @type {any} */ mesh: null, material: null, doc: null,
  history: [], view: { x: 20, y: 20, z: 1 }, selected: "", armed: null, draft: null,
  /** @type {{ msg: Function, busy: Function, call: Function, asset: Function, saveToProject: Function, partName: Function, onClose: Function }} */ o: null,
};
let dock = null;

/** Whether the dock is open. */
export function isOpen() { return !!dock && !dock.hidden; }

/**
 * Opens the dock on a part (or empties it when there is none).
 *
 * @param mesh - The chosen part's mesh, or null.
 * @param o - The editor's helpers: msg(text, error), busy(text), call(method, params) (window.kesher.call),
 *   asset() (the Unity/Unreal asset the model came from, or null), saveToProject(asset, format, make),
 *   partName(), onClose().
 */
export function open(mesh, o) {
  S.o = o;
  build();
  dock.hidden = false;
  setTarget(mesh);
}

/** Closes the dock (the graphs stay on their materials). */
export function close() {
  if (!dock) return;
  finishDraft(true);
  dock.hidden = true;
  S.o?.onClose?.();
}

/**
 * Shows another part's material (the editor's selection changed).
 *
 * @param mesh - The mesh, or null.
 */
export function setTarget(mesh) {
  if (!dock) return;
  finishDraft(true);
  S.mesh = mesh ?? null;
  S.material = mesh ? pbrOf(mesh) : null;
  S.history = [];
  S.selected = "";
  S.armed = null;
  if (S.material) {
    const m = S.material;
    S.doc = m.userData.kesherGraph ?? starterDoc({ name: (m.name || S.o.partName() || "Material").replace(/[^\w\- ]/g, ""), color: `#${m.color?.getHexString() ?? "cccccc"}`, roughness: m.roughness, metalness: m.metalness, emissive: `#${m.emissive?.getHexString() ?? "000000"}`, maps: TEXTURE_SOURCES.filter((k) => m[k]) });
    applyGraph(m, S.doc);
  } else S.doc = null;
  $("mdPart").textContent = S.mesh ? S.o.partName() : L("בחר חלק עם צורה", "Choose a part with a shape");
  render();
  requestAnimationFrame(fit);
}

/** Makes the dock's elements once. */
function build() {
  if (dock) return;
  dock = $("matDock");
  dock.innerHTML = `
    <div class="md-top">
      <b class="md-title"></b><span class="md-part muted small" id="mdPart" dir="auto"></span><span class="grow"></span>
      <button type="button" id="mdAdd" class="primary"></button>
      <button type="button" id="mdDel">🗑</button>
      <button type="button" id="mdFit">⤢</button>
      <button type="button" id="mdUndo">↶</button>
      <button type="button" id="mdExport"></button>
      <button type="button" id="mdClose">✕</button>
    </div>
    <div class="md-body">
      <div class="md-canvas" id="mdCanvas" tabindex="0" dir="ltr"><div class="md-world" id="mdWorld"><svg class="md-wires" id="mdWires" width="1" height="1"></svg></div><div class="md-hint muted small" id="mdHint"></div></div>
      <div class="md-side" id="mdSide"></div>
    </div>
    <div class="md-approve" id="mdApprove" hidden role="status"><span id="mdApproveText" dir="auto"></span><button type="button" id="mdKeep" class="primary"></button><button type="button" id="mdDiscard"></button></div>
    <form class="md-chat" id="mdChat"><input id="mdWords" dir="auto" autocomplete="off" /><button type="submit" class="primary" id="mdGo">✨</button></form>`;
  dock.querySelector(".md-title").textContent = L("◇ גרף חומר", "◇ Material graph");
  const label = (id, text, title) => { const b = $(id); if (text) b.textContent = text; b.title = title; b.setAttribute("aria-label", title); };
  label("mdAdd", L("＋ נוד", "＋ Node"), L("הוספת נוד (A)", "Add a node (A)"));
  label("mdDel", "", L("מחיקת הנוד הנבחר (Delete)", "Delete the chosen node (Delete)"));
  label("mdFit", "", L("הכול בתצוגה", "Fit all"));
  label("mdUndo", "", L("ביטול (Ctrl+Z)", "Undo (Ctrl+Z)"));
  label("mdExport", L("ייצוא ▾", "Export ▾"), L("ייצוא ל-Unity או Unreal", "Export to Unity or Unreal"));
  label("mdClose", "", L("סגירת הגרף", "Close the graph"));
  $("mdKeep").textContent = L("השאר", "Keep");
  $("mdDiscard").textContent = L("בטל", "Discard");
  $("mdWords").placeholder = L("✨ תאר את החומר: ברזל חלוד, זוהר כחול בשוליים…", "✨ Describe the material: rusty iron, a blue glow at the edges…");
  $("mdHint").textContent = L("הקש על יציאה ואז על כניסה כדי לחבר · אצבע אחת מזיזה, שתיים מגדילות", "Tap an output, then an input, to connect · one finger pans, two zoom");
  $("mdAdd").onclick = () => addMenu($("mdAdd"));
  $("mdDel").onclick = () => S.selected && edit([{ op: "delete", node: S.selected }]);
  $("mdFit").onclick = fit;
  $("mdUndo").onclick = undo;
  $("mdExport").onclick = () => exportMenu($("mdExport"));
  $("mdClose").onclick = close;
  $("mdKeep").onclick = () => finishDraft(true);
  $("mdDiscard").onclick = () => finishDraft(false);
  $("mdChat").onsubmit = (e) => { e.preventDefault(); void fromWords(); };
  wireCanvas();
  // The dock's keys stay in the dock (the editor's W, Delete, Ctrl+Z… are for the scene).
  dock.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea, select")) { e.stopPropagation(); return; }
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "z") { e.preventDefault(); undo(); }
    else if ((k === "Delete" || k === "Backspace") && S.selected) edit([{ op: "delete", node: S.selected }]);
    else if (k === "Escape") { S.armed = null; render(); }
    else if (k.toLowerCase() === "a" && !e.ctrlKey && !e.metaKey) addMenu($("mdAdd"));
    else if (k.toLowerCase() === "f") fit();
    else return;
    e.stopPropagation();
  });
}

// ---------- edits, undo and the chat's draft ----------
/** Applies ops (one undo step), shows the result and says what failed. */
function edit(ops, { history = true } = {}) {
  if (!S.doc || !S.material) return { results: [] };
  finishDraft(true);
  const before = S.doc;
  const r = applyMaterialOps(S.doc, ops);
  const failed = r.results.filter((x) => !x.ok);
  if (failed.length === r.results.length && failed.length) { S.o.msg(failed[0].error, true); return r; }
  if (history) { S.history.push(before); if (S.history.length > 80) S.history.shift(); }
  S.doc = r.doc;
  if (ops.some((o) => o.op === "delete" && o.node === S.selected)) S.selected = "";
  applyGraph(S.material, S.doc);
  render();
  if (failed.length) S.o.msg(failed[0].error, true);
  return r;
}
function undo() {
  if (S.draft) return finishDraft(false);
  const prev = S.history.pop();
  if (!prev || !S.material) return;
  S.doc = prev;
  applyGraph(S.material, S.doc);
  render();
}
/** Ends the chat's draft: kept (one undo step back to before it) or discarded. */
function finishDraft(keep) {
  const d = S.draft;
  if (!d) return;
  S.draft = null;
  $("mdApprove").hidden = true;
  if (keep) S.history.push(d.before);
  else { S.doc = d.before; if (S.material) applyGraph(S.material, S.doc); }
  render();
}
/** The chat model builds or changes the graph from words (the material_graph tool); shown live until kept. */
async function fromWords() {
  const words = $("mdWords").value.trim();
  if (!words || !S.doc) return;
  finishDraft(true);
  S.o.busy(L("המודל בונה את הגרף…", "The model is building the graph…"));
  let call;
  try {
    call = parseMaterialToolCall(await S.o.call("chat", { messages: materialChatMessages(S.doc, words), temperature: 0 }));
  } catch (e) {
    S.o.msg(e.message || String(e), true);
    return;
  } finally { S.o.busy(""); }
  if (!call) return S.o.msg(L("המודל לא החזיר שינויים לגרף. נסה לנסח אחרת.", "The model gave no graph changes. Try other words."), true);
  const r = applyMaterialOps(S.doc, call.ops);
  const ok = r.results.filter((x) => x.ok).length, failed = r.results.length - ok;
  if (!ok) return S.o.msg(r.results[0]?.error ?? L("שום שינוי לא התאים לגרף", "No change fitted the graph"), true);
  const v = validateMaterialDoc(r.doc);
  S.draft = { before: S.doc, added: new Set(r.results.filter((x) => x.node).map((x) => x.node)) };
  S.doc = r.doc;
  unstack(S.doc, S.draft.added);
  applyGraph(S.material, S.doc);
  $("mdWords").value = "";
  $("mdApproveText").textContent = `✨ ${call.summary || words} · ${L(`${ok} שינויים`, `${ok} changes`)}${failed ? L(` (${failed} דולגו)`, ` (${failed} skipped)`) : ""}${v.ok ? "" : ` · ${he ? v.issues[0].he : v.issues[0].en}`}`;
  $("mdApprove").hidden = false;
  render();
  fit();
}

/** Moves the chat's new nodes down until none sits on another node (models often reuse the same spot). */
function unstack(doc, added) {
  for (const n of doc.nodes) {
    if (!added.has(n.id)) continue;
    for (let i = 0; i < 40 && doc.nodes.some((o) => o !== n && Math.abs(o.x - n.x) < W - 20 && Math.abs(o.y - n.y) < 60); i++) n.y += 70;
  }
}

// ---------- drawing ----------
/** A node's rows: its property line (constants and textures), then its inputs and outputs side by side. */
function layout(n) {
  const def = nodeDef(n.cls);
  const top = HEAD + (def.props ? PROP : 0);
  const rows = Math.max(def.ins.length, def.outs.length, 1);
  return { def, top, h: top + rows * ROW + 6 };
}
/** Where a pin is, in graph units. */
function pinAt(n, dir, name) {
  const { def, top } = layout(n);
  const i = (dir === "in" ? def.ins : def.outs).findIndex((p) => p[0] === name);
  return { x: n.x + (dir === "in" ? 0 : W), y: n.y + top + Math.max(0, i) * ROW + ROW / 2 };
}
/** What a node's property line shows. */
function propText(n) {
  const v = n.props?.value;
  if (n.cls === "TextureAsset") return `▣ ${n.props?.source ?? "map"}`;
  if (Array.isArray(v)) return v.map((x) => Math.round(x * 100) / 100).join(", ");
  return typeof v === "number" ? String(Math.round(v * 1000) / 1000) : String(v ?? "");
}

function render() {
  if (!dock || dock.hidden) return;
  const world = $("mdWorld"), svg = $("mdWires");
  world.querySelectorAll(".mn").forEach((e) => e.remove());
  $("mdHint").hidden = !!S.armed || (S.doc?.links.length ?? 0) > 2;
  for (const id of ["mdAdd", "mdDel", "mdUndo", "mdExport", "mdWords", "mdGo"]) $(id).disabled = !S.doc;
  $("mdDel").disabled = !S.selected || S.doc?.nodes.find((n) => n.id === S.selected)?.cls === "Output";
  $("mdUndo").disabled = !S.history.length && !S.draft;
  if (!S.doc) { svg.innerHTML = ""; renderSide(); return; }
  const linked = new Set(S.doc.links.map((l) => `${l.to}:${l.in}`));
  const used = new Set(S.doc.links.map((l) => `${l.from}:${l.out}`));
  const unity = new Set(unsupportedNodes(S.doc, "unity").map((u) => u.node));
  for (const n of S.doc.nodes) {
    const { def, top, h } = layout(n);
    const el = document.createElement("div");
    el.className = `mn cat-${def.cat}${n.id === S.selected ? " on" : ""}${S.draft?.added.has(n.id) ? " new" : ""}`;
    el.style.cssText = `left:${n.x}px;top:${n.y}px;width:${W}px;height:${h}px`;
    el.dataset.node = n.id;
    const head = document.createElement("div");
    head.className = "mn-head";
    head.textContent = he ? def.he : def.title;
    if (unity.has(n.id)) { const b = document.createElement("span"); b.className = "mn-warn"; b.textContent = "⚠ Unity"; b.title = he ? def.why?.he ?? "" : def.why?.en ?? ""; head.append(b); }
    el.append(head);
    if (def.props) {
      const p = document.createElement("div");
      p.className = "mn-prop";
      if (n.cls === "Color") { const sw = document.createElement("i"); sw.style.background = n.props?.value ?? "#ccc"; p.append(sw); }
      p.append(document.createTextNode(propText(n)));
      el.append(p);
    }
    const pin = (dir, [name, type], i) => {
      const b = document.createElement("button");
      b.type = "button";
      const on = dir === "in" ? linked.has(`${n.id}:${name}`) : used.has(`${n.id}:${name}`);
      const armed = S.armed && S.armed.node === n.id && S.armed.pin === name && S.armed.dir === dir;
      b.className = `mp ${dir}${on ? " wired" : ""}${armed ? " armed" : ""}`;
      b.style.top = `${top + i * ROW}px`;
      b.style.height = `${ROW}px`;
      b.style.setProperty("--pc", PIN_COLOR[type] ?? "#9aa0a6");
      b.dataset.pin = name;
      b.dataset.dir = dir;
      b.setAttribute("aria-label", `${name} (${type})`);
      b.innerHTML = "<i></i><span></span>";
      b.lastChild.textContent = name;
      el.append(b);
    };
    def.ins.forEach((p, i) => pin("in", p, i));
    def.outs.forEach((p, i) => pin("out", p, i));
    world.append(el);
  }
  drawWires();
  renderSide();
  place();
}
function drawWires() {
  const svg = $("mdWires");
  const byId = new Map(S.doc.nodes.map((n) => [n.id, n]));
  svg.innerHTML = S.doc.links.map((l) => {
    const a = byId.get(l.from), b = byId.get(l.to);
    if (!a || !b) return "";
    const p = pinAt(a, "out", l.out), q = pinAt(b, "in", l.in);
    const dx = Math.max(40, Math.abs(q.x - p.x) / 2);
    const type = nodeDef(a.cls).outs.find((x) => x[0] === l.out)?.[1];
    return `<path d="M${p.x},${p.y} C${p.x + dx},${p.y} ${q.x - dx},${q.y} ${q.x},${q.y}" stroke="${PIN_COLOR[type] ?? "#9aa0a6"}" />`;
  }).join("");
}
function place() { $("mdWorld").style.transform = `translate(${S.view.x}px, ${S.view.y}px) scale(${S.view.z})`; }
/** Fits every node in the canvas. */
function fit() {
  if (!S.doc?.nodes.length || !dock || dock.hidden) return;
  const c = $("mdCanvas");
  const xs = S.doc.nodes.map((n) => n.x), ys = S.doc.nodes.map((n) => n.y);
  const x0 = Math.min(...xs) - 20, y0 = Math.min(...ys) - 20;
  const x1 = Math.max(...S.doc.nodes.map((n) => n.x + W)) + 20, y1 = Math.max(...S.doc.nodes.map((n) => n.y + layout(n).h)) + 20;
  const z = Math.max(0.3, Math.min(1.2, c.clientWidth / (x1 - x0), c.clientHeight / (y1 - y0)));
  S.view = { z, x: (c.clientWidth - (x1 - x0) * z) / 2 - x0 * z, y: (c.clientHeight - (y1 - y0) * z) / 2 - y0 * z };
  place();
}

/** The side panel: the chosen node's values, or the graph's problems, and Unity's notes. */
function renderSide() {
  const side = $("mdSide");
  side.replaceChildren();
  const h = (text) => { const b = document.createElement("b"); b.textContent = text; side.append(b); };
  const note = (text, cls = "muted small") => { const p = document.createElement("p"); p.className = cls; p.textContent = text; side.append(p); };
  if (!S.doc) return note(L("בחר חלק בתצוגה כדי לראות את החומר שלו כגרף.", "Choose a part in the view to see its material as a graph."));
  const v = validateMaterialDoc(S.doc);
  const n = S.doc.nodes.find((x) => x.id === S.selected);
  if (!n) {
    h(L("החומר", "The material"));
    note(L("הקש על נוד כדי לשנות את הערכים שלו. Roughness הופך ל-Smoothness בייצוא ל-Unity.", "Tap a node to change its values. Roughness becomes Smoothness in the Unity export."));
  } else {
    const def = nodeDef(n.cls);
    h(he ? def.he : def.title);
    if (def.why) note(`⚠ ${he ? def.why.he : def.why.en}`, "md-warn small");
    for (const [key, dflt] of Object.entries(def.props ?? {})) field(side, n, { prop: key }, n.props?.[key] ?? dflt, key);
    const linked = new Set(S.doc.links.filter((l) => l.to === n.id).map((l) => l.in));
    for (const [pin, , dflt] of def.ins) {
      if (linked.has(pin) || dflt === null || typeof dflt === "string") continue;
      field(side, n, { pin }, n.values?.[pin] ?? dflt, pin, def.c?.includes(pin));
    }
  }
  if (!v.ok) for (const i of v.issues) note(`⚠ ${he ? i.he : i.en}`, "md-warn small");
}
/** One value's control: a colour, a number, a vector's numbers, or a texture slot. */
function field(side, n, where, value, name, colour = false) {
  const row = document.createElement("label");
  row.className = "md-field";
  const t = document.createElement("span");
  t.textContent = name === "source" ? L("טקסטורה מהחלק", "Texture of the part") : name === "name" ? L("שם ב-Unity", "Name in Unity") : name;
  row.append(t);
  let before = null;
  const set = (val, commit) => {
    if (!before) before = S.doc;
    const r = applyMaterialOps(S.doc, [{ op: "set", node: n.id, ...where, value: val }]);
    if (!r.results[0]?.ok) return;
    S.doc = r.doc;
    applyGraph(S.material, S.doc);
    if (commit) { S.history.push(before); before = null; render(); } else { const el = $("mdWorld").querySelector(`[data-node="${CSS.escape(n.id)}"] .mn-prop`); if (el) el.lastChild.textContent = propText(S.doc.nodes.find((x) => x.id === n.id)); }
  };
  const isHex = typeof value === "string" && value.startsWith("#");
  if (name === "source") {
    const s = document.createElement("select");
    for (const k of TEXTURE_SOURCES) { const o = document.createElement("option"); o.value = k; o.textContent = k + (S.material?.[k] ? "" : L(" (ריק)", " (empty)")); s.append(o); }
    s.value = value;
    s.onchange = () => set(s.value, true);
    row.append(s);
  } else if (name === "name") {
    const i = document.createElement("input");
    i.value = value; i.dir = "ltr";
    i.onchange = () => set(i.value, true);
    row.append(i);
  } else if (isHex || (colour && Array.isArray(value))) {
    const i = document.createElement("input");
    i.type = "color";
    i.value = isHex ? value : `#${new THREE.Color().setRGB(value[0], value[1], value[2], THREE.SRGBColorSpace).getHexString(THREE.SRGBColorSpace)}`;
    const conv = () => (isHex ? i.value : new THREE.Color(i.value).getRGB(new THREE.Color(), THREE.SRGBColorSpace).toArray().map((x) => Math.round(x * 1e4) / 1e4));
    i.oninput = () => set(conv(), false);
    i.onchange = () => set(conv(), true);
    row.append(i);
  } else {
    const vals = Array.isArray(value) ? value : [value];
    const box = document.createElement("div");
    box.className = "md-nums";
    const inputs = vals.map((x) => { const i = document.createElement("input"); i.type = "number"; i.step = "0.05"; i.value = String(x); i.dir = "ltr"; box.append(i); return i; });
    const read = () => (Array.isArray(value) ? inputs.map((i) => Number(i.value) || 0) : Number(inputs[0].value) || 0);
    inputs.forEach((i) => { i.oninput = () => set(read(), false); i.onchange = () => set(read(), true); });
    row.append(box);
  }
  side.append(row);
}

// ---------- the canvas: pan, pinch, wheel, drag nodes, tap to connect ----------
function wireCanvas() {
  const c = $("mdCanvas");
  const pts = new Map();
  let drag = null, pinch = null;
  const local = (e) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  c.addEventListener("pointerdown", (e) => {
    if (e.button > 0 && e.pointerType === "mouse" && e.button !== 1) return;
    c.focus({ preventScroll: true });
    if (e.target.closest(".mp")) return; // a pin: handled on click
    pts.set(e.pointerId, local(e));
    c.setPointerCapture(e.pointerId);
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: S.view.z, x: S.view.x, y: S.view.y, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      drag = null;
      return;
    }
    const nodeEl = e.target.closest(".mn");
    const p = local(e);
    if (nodeEl && S.doc) {
      const n = S.doc.nodes.find((x) => x.id === nodeEl.dataset.node);
      drag = { kind: "node", n, el: nodeEl, sx: p.x, sy: p.y, nx: n.x, ny: n.y, moved: false };
    } else drag = { kind: "pan", sx: p.x, sy: p.y, vx: S.view.x, vy: S.view.y, moved: false };
  });
  c.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    const p = local(e);
    pts.set(e.pointerId, p);
    if (pinch && pts.size === 2) {
      const [a, b] = [...pts.values()];
      const z = Math.max(0.25, Math.min(2.5, pinch.z * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d));
      S.view = { z, x: pinch.cx - (pinch.cx - pinch.x) * (z / pinch.z), y: pinch.cy - (pinch.cy - pinch.y) * (z / pinch.z) };
      return place();
    }
    if (!drag) return;
    const dx = p.x - drag.sx, dy = p.y - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    if (drag.kind === "pan") { S.view.x = drag.vx + dx; S.view.y = drag.vy + dy; place(); return; }
    drag.n.x = Math.round(drag.nx + dx / S.view.z);
    drag.n.y = Math.round(drag.ny + dy / S.view.z);
    drag.el.style.left = `${drag.n.x}px`;
    drag.el.style.top = `${drag.n.y}px`;
    drawWires();
  });
  const up = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.kind === "node") {
      if (d.moved) {
        const x = d.n.x, y = d.n.y;
        d.n.x = d.nx; d.n.y = d.ny; // back, so the move is one undo step through edit()
        edit([{ op: "move", node: d.n.id, x, y }]);
      } else { S.selected = d.n.id; render(); }
    } else if (!d.moved) { S.selected = ""; S.armed = null; render(); }
  };
  c.addEventListener("pointerup", up);
  c.addEventListener("pointercancel", up);
  c.addEventListener("wheel", (e) => {
    e.preventDefault();
    const p = local(e);
    const z = Math.max(0.25, Math.min(2.5, S.view.z * Math.exp(-e.deltaY * 0.0015)));
    S.view = { z, x: p.x - (p.x - S.view.x) * (z / S.view.z), y: p.y - (p.y - S.view.y) * (z / S.view.z) };
    place();
  }, { passive: false });
  c.addEventListener("click", (e) => {
    const b = e.target.closest(".mp");
    if (!b || !S.doc) return;
    tapPin(b.closest(".mn").dataset.node, b.dataset.pin, b.dataset.dir);
  });
}
/** Tap to connect: an output then an input (or the other way); a tap on a wired input picks its wire up. */
function tapPin(node, pin, dir) {
  const a = S.armed;
  if (a && a.node === node && a.pin === pin && a.dir === dir) { S.armed = null; return render(); }
  if (a && a.dir !== dir) {
    const [o, i] = dir === "in" ? [a, { node, pin }] : [{ node, pin }, a];
    S.armed = null;
    edit([{ op: "connect", from: o.node, out: o.pin, to: i.node, in: i.pin }]);
    return;
  }
  if (dir === "in" && !a) {
    const l = S.doc.links.find((x) => x.to === node && x.in === pin);
    if (l) { S.armed = { node: l.from, pin: l.out, dir: "out" }; edit([{ op: "disconnect", to: node, in: pin }]); return; }
  }
  S.armed = { node, pin, dir };
  render();
}

// ---------- add a node ----------
/** The node menu: a search over the node set by category; an armed output connects into the new node. */
function addMenu(anchor) {
  if (!S.doc) return;
  document.querySelector(".md-add")?.remove();
  const m = document.createElement("div");
  m.className = "md-add";
  m.setAttribute("role", "dialog");
  m.setAttribute("aria-label", L("הוספת נוד", "Add a node"));
  const q = document.createElement("input");
  q.type = "search"; q.dir = "auto"; q.placeholder = L("🔍 חיפוש נוד…", "🔍 Search nodes…");
  const list = document.createElement("div");
  list.className = "md-add-list";
  m.append(q, list);
  const show = () => {
    const w = q.value.trim().toLowerCase();
    list.replaceChildren();
    for (const [cat, [ch, ce]] of Object.entries(CAT)) {
      const items = MATERIAL_NODES.filter((d) => d.cat === cat && (!w || d.title.toLowerCase().includes(w) || d.cls.toLowerCase().includes(w) || d.he.includes(w)));
      if (!items.length) continue;
      const t = document.createElement("div"); t.className = "md-add-cat"; t.textContent = L(ch, ce); list.append(t);
      for (const d of items) {
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.cls = d.cls;
        b.textContent = he ? `${d.he} · ${d.title}` : d.title;
        if (!d.u) { const s = document.createElement("small"); s.textContent = " ⚠ Unity"; b.append(s); }
        b.onclick = () => { m.remove(); addNode(d.cls); };
        list.append(b);
      }
    }
  };
  q.oninput = show;
  q.onkeydown = (e) => { if (e.key === "Enter") list.querySelector("button")?.click(); if (e.key === "Escape") m.remove(); e.stopPropagation(); };
  show();
  dock.append(m);
  const r = anchor.getBoundingClientRect(), dr = dock.getBoundingClientRect();
  m.style.top = `${r.bottom - dr.top + 4}px`;
  q.focus();
  const away = (e) => { if (!m.contains(e.target) && e.target !== anchor) { m.remove(); removeEventListener("pointerdown", away, true); } };
  addEventListener("pointerdown", away, true);
}
function addNode(cls) {
  const c = $("mdCanvas");
  const a = S.armed;
  const from = a && S.doc.nodes.find((n) => n.id === a.node);
  const x = from ? from.x + (a.dir === "out" ? W + 50 : -W - 50) : Math.round((c.clientWidth / 2 - S.view.x) / S.view.z - W / 2);
  const y = from ? from.y : Math.round((c.clientHeight / 2 - S.view.y) / S.view.z - 40);
  const ops = [{ op: "add", cls, id: `${cls.toLowerCase()}${S.doc.nodes.length + 1}`, x, y }];
  const def = nodeDef(cls);
  if (a && from) {
    const fromType = nodeDef(from.cls)[a.dir === "out" ? "outs" : "ins"].find((p) => p[0] === a.pin)?.[1];
    const id = ops[0].id;
    if (a.dir === "out") { const pin = def.ins.find((p) => typesFit(fromType, p[1])); if (pin) ops.push({ op: "connect", from: a.node, out: a.pin, to: id, in: pin[0] }); }
    else { const pin = def.outs.find((p) => typesFit(p[1], fromType)); if (pin) ops.push({ op: "connect", from: id, out: pin[0], to: a.node, in: a.pin }); }
  }
  S.armed = null;
  const r = edit(ops);
  const added = r.results[0]?.node;
  if (added) { S.selected = added; render(); }
}

// ---------- export ----------
function exportMenu(anchor) {
  if (!S.doc) return;
  const asset = S.o.asset();
  openMenu(anchor, L("ייצוא החומר", "Export the material"), [
    { icon: "🟦", label: L("Unity Shader Graph (URP Lit)", "Unity Shader Graph (URP Lit)"), hint: asset?.engine === "unity" ? L(`לפרויקט ${asset.projectName}, באישור`, `Into ${asset.projectName}, with approval`) : L("כקובץ .shadergraph", "As a .shadergraph file"), run: () => toUnity(asset?.engine === "unity" ? asset : null) },
    ...(asset?.engine === "unity" ? [{ icon: "⬇", label: L("הורד .shadergraph", "Download .shadergraph"), run: () => toUnity(null) }] : []),
    { icon: "🟪", label: L("חומר Unreal · בקרוב", "Unreal material · Coming next"), hint: L("דרך התוסף KesherAI Bridge", "Through the KesherAI Bridge plugin"), run: () => S.o.msg(L("ייצוא חומרים ל-Unreal מגיע בעדכון הבא (התוסף KesherAI Bridge).", "Unreal material export comes next (through the KesherAI Bridge plugin)."), false) },
  ]);
}
/** The Unity export: blocked with a list when nodes do not map; into the opened Unity project with approval, else a file. */
function toUnity(asset) {
  const name = (S.doc.name || S.o.partName() || "Material").replace(/[^\w\- ]/g, "").trim() || "Material";
  const r = exportShaderGraph(S.doc, { name });
  if (!r.ok) return blocked(r);
  const bytes = new TextEncoder().encode(r.text).buffer;
  if (asset) return S.o.saveToProject(asset, "shadergraph", async () => bytes);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([bytes], { type: "application/json" }));
  a.download = `${name}.shadergraph`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  S.o.msg(L("נשמר כ-.shadergraph: שים אותו תחת Assets/ בפרויקט Unity (URP).", "Saved as .shadergraph: put it under Assets/ in a Unity (URP) project."));
}
/** Why the export cannot go: the nodes Shader Graph does not have (each with what to use), and the graph's problems. */
function blocked(r) {
  document.querySelector(".md-dialog")?.remove();
  const d = document.createElement("dialog");
  d.className = "md-dialog";
  const h = document.createElement("h3");
  h.textContent = L("אי אפשר לייצא ל-Unity עדיין", "Cannot export to Unity yet");
  const p = document.createElement("p");
  p.className = "muted small";
  p.textContent = r.unsupported.length ? L("הנודים האלה לא קיימים ב-Shader Graph. החלף אותם, ואז ייצא שוב:", "These nodes are not in Shader Graph. Replace them, then export again:") : L("בגרף יש בעיות:", "The graph has problems:");
  const ul = document.createElement("ul");
  for (const u of r.unsupported) {
    const li = document.createElement("li");
    const b = document.createElement("b"); b.textContent = `${he ? u.he : u.title} (${u.node})`;
    const why = document.createElement("div"); why.className = "muted small"; why.textContent = he ? u.why.he : u.why.en;
    li.append(b, why);
    ul.append(li);
  }
  for (const i of r.issues) { const li = document.createElement("li"); li.textContent = he ? i.he : i.en; ul.append(li); }
  const acts = document.createElement("div");
  acts.className = "row";
  const first = r.unsupported[0]?.node ?? r.issues[0]?.node;
  if (first) { const b = document.createElement("button"); b.type = "button"; b.className = "primary"; b.textContent = L("הראה את הראשון", "Show the first"); b.onclick = () => { d.close(); S.selected = first; render(); centre(first); }; acts.append(b); }
  const x = document.createElement("button"); x.type = "button"; x.textContent = L("סגור", "Close"); x.onclick = () => d.close();
  acts.append(x);
  d.append(h, p, ul, acts);
  d.addEventListener("close", () => d.remove());
  document.body.append(d);
  d.showModal();
}
function centre(id) {
  const n = S.doc.nodes.find((x) => x.id === id), c = $("mdCanvas");
  if (!n) return;
  S.view.x = c.clientWidth / 2 - (n.x + W / 2) * S.view.z;
  S.view.y = c.clientHeight / 2 - (n.y + 40) * S.view.z;
  place();
}
