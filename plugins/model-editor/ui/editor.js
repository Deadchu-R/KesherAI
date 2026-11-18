// KesherAI's 3D editor, stage 1 (docs/RESEARCH_LOG.md → "The 3D editor's screen"): the chat's model in three.js, its
// parts as a list, each part's material, measurements, light setups, versions, and a GLB back to the chat. A plugin page
// with no build step (three.js is vendored in ui/vendor/three/); it talks to KesherAI only through window.kesher.
/* global window, document, addEventListener, requestAnimationFrame, setTimeout, clearTimeout, ResizeObserver, FileReader, Blob, URL */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";

const $ = (id) => document.getElementById(id);
const kesher = window.kesher;
const HE = {
  export: "ייצוא GLB", toChat: "שלח לצ'אט", empty: "פתח מודל מצ'אט: \"עריכה בעורך התלת ממד\" בתצוגה שלו.", partsH: "חלקים", noPart: "בחר חלק",
  color: "צבע", rough: "חספוס", metal: "מתכתיות", hide: "הסתר", show: "הצג", frameBtn: "מסגר (F)", soon: "בקרוב: לסמן חלק ו\"מה לעשות כאן?\" עם מודלי התלת ממד.",
  keep: "＋ שמור גרסה", lStudio: "סטודיו", lSun: "שמש", lEvening: "ערב", paintS: "חומר", frameS: "מסגור", undoS: "ביטול", keepS: "גרסה",
  toChatH: "שליחה לצ'אט", toChatMsg: "הודעה איתו (לא חובה)", cancel: "ביטול", send: "שלח", keysH: "קיצורים (כמו ב-Blender)", close: "סגור",
  loading: "טוען את המודל…", sending: "שולח…", tris: "משולשים", parts: "חלקים", size: "גודל", version: "גרסה", unnamed: "חלק",
  sceneH: "מבנה הסצנה", cMove: "מיקום", cRotate: "סיבוב°", cScale: "גודל", dup: "שכפל", del: "מחק", vFront: "חזית", vRight: "ימין", vTop: "עליון", vPersp: "פרספקטיבה",
  kMove: "הזזה / סיבוב / שינוי גודל", kAxis: "נעילה לציר (אחרי מקש הכלי)", kDup: "שכפול", kDel: "מחיקה", kViews: "חזית / ימין / עליון", kShade: "תיל / מוצק / חומר", kSnap: "הצמדה", kEsc: "ביטול בחירה",
  kF: "מסגור החלק הנבחר", kHome: "כל המודל", kH: "הסתרת החלק", kAltH: "הצגת הכל", kW: "תיל (wireframe)", kUndo: "ביטול", tooBig: "המודל גדול מ-50MB",
};
let he = false;
const T = (k, en) => (he && HE[k]) || en;

// ---------- the scene ----------
const host = $("view");
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
host.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
camera.position.set(2, 1.5, 2.5);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
const grid = new THREE.GridHelper(10, 20, 0x444455, 0x2a2a33);
scene.add(grid);
const lights = new THREE.Group();
scene.add(lights);
/** Light setups: studio (soft, three lights), sun (one hard light and sky), evening (warm and low). */
function setLight(kind) {
  lights.clear();
  if (kind === "sun") {
    lights.add(new THREE.HemisphereLight(0xbfd8ff, 0x3a3020, 0.9));
    const d = new THREE.DirectionalLight(0xffffff, 2.6); d.position.set(4, 8, 3); lights.add(d);
  } else if (kind === "evening") {
    lights.add(new THREE.HemisphereLight(0x6070a0, 0x201010, 0.5));
    const d = new THREE.DirectionalLight(0xffa060, 2.2); d.position.set(-6, 2, 2); lights.add(d);
  } else {
    lights.add(new THREE.AmbientLight(0xffffff, 0.5));
    for (const [x, y, z, k] of [[3, 4, 3, 1.8], [-4, 2, 1, 0.8], [0, 3, -4, 1.0]]) { const d = new THREE.DirectionalLight(0xffffff, k); d.position.set(x, y, z); lights.add(d); }
  }
}
setLight("studio");

let model = null;
let meshes = []; // [{ mesh, name }]: every mesh, for picking and materials
let nodes = []; // [{ obj, depth }]: the scene tree as shown (Blender's Outliner)
const folded = new Set();
let chosen = null; // the chosen Object3D
let name = "model";
const undoStack = [];
const versions = [];

function resize() {
  const w = host.clientWidth, h = host.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(host);
(function loop() { controls.update(); renderer.render(scene, camera); requestAnimationFrame(loop); })();

// ---------- open ----------
function frame(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3()).length() || 1, center = box.getCenter(new THREE.Vector3());
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(0.6, 0.45, 0.8).multiplyScalar(size * 1.2));
  camera.near = size / 200; camera.far = size * 50; camera.updateProjectionMatrix();
}
async function open() {
  busy(T("loading", "Loading the model…"));
  try {
    const input = await kesher.call("editor.input");
    if (!input?.bytes) return;
    name = input.name;
    $("name").textContent = name;
    const gltf = await new Promise((resolve, reject) => new GLTFLoader().parse(input.bytes, "", resolve, reject));
    model = gltf.scene;
    scene.add(model);
    // Each mesh gets its own material, so changing one part does not change others that shared it.
    meshes = [];
    model.traverse((o) => { if (o.isMesh) o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone(); });
    rebuild();
    // The floor under the model, scaled to it.
    const box = new THREE.Box3().setFromObject(model);
    const s = box.getSize(new THREE.Vector3());
    grid.scale.setScalar(Math.max(s.x, s.z, 0.1) / 3);
    grid.position.y = box.min.y;
    $("empty").hidden = true;
    frame(model);
    stats();
  } catch (e) { msg(e.message || "The model could not be read.", true); } finally { busy(""); }
}

// ---------- the scene tree and the chosen object ----------
const matOf = (m) => (Array.isArray(m.material) ? m.material[0] : m.material);
const label = (o) => o.name || (o.isMesh ? T("unnamed", "Part") : "·");
/** The meshes and the tree again, after a change of structure (duplicate, delete, undo). */
function rebuild() {
  meshes = [];
  model?.traverse((o) => { if (o.isMesh) meshes.push({ mesh: o, name: label(o) }); });
  renderParts();
}
function tris(obj) { let n = 0; obj.traverse((o) => { if (o.isMesh) { const g = o.geometry; n += (g.index ? g.index.count : g.attributes.position.count) / 3; } }); return Math.round(n); }
function stats() { $("stats").textContent = model ? `${meshes.length} ${T("parts", "parts")} · ${tris(model).toLocaleString()} ${T("tris", "triangles")}` : ""; }
/** Groups that hold a single mesh and nothing else are shown as that mesh (files often wrap each mesh in a node). */
const shown = (o) => (o.children.length === 1 && !o.isMesh && o.children[0].isMesh && !o.children[0].children.length ? o.children[0] : o);
function renderParts() {
  nodes = [];
  const walk = (o, depth) => { for (const c of o.children) { const s2 = shown(c); nodes.push({ obj: s2, depth }); if (!folded.has(s2.uuid)) walk(s2, depth + 1); } };
  if (model) walk(model, 0);
  $("partList").replaceChildren(...nodes.map(({ obj, depth }) => {
    const li = document.createElement("li");
    li.className = `${obj === chosen ? "on" : ""}${obj.visible ? "" : " off"}`;
    li.style.paddingInlineStart = `${6 + depth * 14}px`;
    const tw = document.createElement("span");
    tw.className = "tw";
    tw.textContent = obj.children.length ? (folded.has(obj.uuid) ? "▸" : "▾") : "";
    tw.onclick = (e) => { e.stopPropagation(); if (folded.has(obj.uuid)) folded.delete(obj.uuid); else folded.add(obj.uuid); renderParts(); };
    const eye = document.createElement("button");
    eye.textContent = obj.visible ? "👁" : "◌";
    eye.title = obj.visible ? T("hide", "Hide") : T("show", "Show");
    eye.onclick = (e) => { e.stopPropagation(); remember(); obj.visible = !obj.visible; renderParts(); };
    const n = document.createElement("span");
    n.dir = "auto";
    n.textContent = obj.children.length && !obj.isMesh ? `${label(obj)} (${obj.children.length})` : label(obj);
    li.append(tw, eye, n);
    li.onclick = () => choose(obj);
    return li;
  }));
}
let glow = null;
function choose(obj) {
  chosen = obj ?? null;
  glow?.removeFromParent(); glow = null;
  gizmo.detach();
  renderParts();
  $("partName").textContent = chosen ? label(chosen) : T("noPart", "Choose a part");
  if (!chosen) { document.querySelectorAll("[data-ch]").forEach((inp) => (inp.value = "")); $("size").textContent = ""; return; }
  // The chosen object is outlined by a box (Blender's orange outline, simply) and gets the gizmo.
  glow = new THREE.BoxHelper(chosen, 0xffa040);
  scene.add(glow);
  gizmo.attach(chosen);
  const mesh = chosen.isMesh ? chosen : chosen.getObjectByProperty("isMesh", true);
  const m = mesh && matOf(mesh);
  if (m?.color) $("color").value = `#${m.color.getHexString()}`;
  $("rough").value = Math.round((m?.roughness ?? 0.5) * 100);
  $("metal").value = Math.round((m?.metalness ?? 0) * 100);
  showChannels();
  $("hidePart").textContent = chosen.visible ? T("hide", "Hide") : T("show", "Show");
}
/** The Channel Box: the chosen object's position, rotation (degrees) and scale, and its size. */
function showChannels() {
  document.querySelectorAll("[data-ch]").forEach((inp) => {
    if (document.activeElement === inp || !chosen) return;
    const [k, a] = inp.dataset.ch.split(".");
    const v = chosen[k][a];
    inp.value = k === "rotation" ? THREE.MathUtils.radToDeg(v).toFixed(1) : (+v.toFixed(4)).toString();
  });
  if (!chosen) return;
  const s2 = new THREE.Box3().setFromObject(chosen).getSize(new THREE.Vector3());
  $("size").textContent = `${T("size", "Size")}: ${[s2.x, s2.y, s2.z].map((v) => v.toFixed(3)).join(" × ")} · ${tris(chosen).toLocaleString()} ${T("tris", "triangles")}`;
  glow?.update();
}
document.querySelectorAll("[data-ch]").forEach((inp) => {
  inp.onchange = () => {
    if (!chosen) return;
    const v = Number(inp.value);
    if (!Number.isFinite(v)) return showChannels();
    remember();
    const [k, a] = inp.dataset.ch.split(".");
    chosen[k][a] = k === "rotation" ? THREE.MathUtils.degToRad(v) : v;
    showChannels();
  };
});

// ---------- the gizmo: move / rotate / scale, with axis lock and snapping ----------
const gizmo = new TransformControls(camera, renderer.domElement);
scene.add(gizmo.getHelper());
gizmo.addEventListener("dragging-changed", (e) => { controls.enabled = !e.value; if (e.value) remember(); else showChannels(); });
gizmo.addEventListener("objectChange", () => showChannels());
function setMode(mode) {
  gizmo.setMode(mode);
  gizmo.showX = gizmo.showY = gizmo.showZ = true;
  document.querySelectorAll("#modes [data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
}
document.querySelectorAll("#modes [data-mode]").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
let snapping = false;
function toggleSnap() {
  snapping = !snapping;
  $("snap").classList.toggle("on", snapping);
  const size = model ? new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3()).length() : 1;
  // A tenth of the model's size as the step (rounded to 1, 2 or 5 of a power of ten), 15° and 10% steps.
  const raw = size / 20, p = Math.pow(10, Math.floor(Math.log10(raw))), step = [1, 2, 5, 10].map((k) => k * p).find((x) => x >= raw);
  gizmo.setTranslationSnap(snapping ? step : null);
  gizmo.setRotationSnap(snapping ? THREE.MathUtils.degToRad(15) : null);
  gizmo.setScaleSnap(snapping ? 0.1 : null);
}
$("snap").onclick = toggleSnap;
/** Only one axis on the gizmo (Blender's G then X, as in all three tools). */
function lockAxis(a) { gizmo.showX = a === "x"; gizmo.showY = a === "y"; gizmo.showZ = a === "z"; }

// A click in the view chooses the part under it (a drag turns the view instead).
let down = null;
renderer.domElement.addEventListener("pointerdown", (e) => (down = [e.clientX, e.clientY]));
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || !model || gizmo.dragging || gizmo.axis) return;
  const r = renderer.domElement.getBoundingClientRect();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = ray.intersectObjects(meshes.filter((p) => p.mesh.visible).map((p) => p.mesh), false)[0];
  choose(hit ? hit.object : null);
});

// ---------- views (3ds Max's ViewCube faces, Blender's numpad) and shading (Maya's 4 / 5 / 6) ----------
function view(kind) {
  const target = chosen ?? model;
  if (!target) return;
  const box = new THREE.Box3().setFromObject(target);
  const size = box.getSize(new THREE.Vector3()).length() || 1, c = box.getCenter(new THREE.Vector3());
  const dir = { front: [0, 0, 1], right: [1, 0, 0], top: [0, 1, 0.0001], persp: [0.6, 0.45, 0.8] }[kind];
  controls.target.copy(c);
  camera.position.copy(c).add(new THREE.Vector3(...dir).normalize().multiplyScalar(size * 1.4));
}
document.querySelectorAll("[data-view]").forEach((b) => (b.onclick = () => view(b.dataset.view)));
const solidMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc8, roughness: 0.6, metalness: 0 });
function shade(kind) {
  scene.overrideMaterial = kind === "solid" ? solidMat : null;
  meshes.forEach(({ mesh }) => [].concat(mesh.material).forEach((m) => (m.wireframe = kind === "wire")));
  solidMat.wireframe = false;
  document.querySelectorAll("[data-shade]").forEach((b) => b.classList.toggle("on", b.dataset.shade === kind));
  $("wire").classList.toggle("on", kind === "wire");
}
document.querySelectorAll("[data-shade]").forEach((b) => (b.onclick = () => shade(b.dataset.shade)));

// ---------- duplicate and delete ----------
function duplicate() {
  if (!chosen || chosen === model) return;
  remember();
  const copy = chosen.clone();
  copy.traverse((o) => { if (o.isMesh) o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone(); });
  copy.name = `${label(chosen)} ⧉`;
  chosen.parent.add(copy);
  rebuild();
  choose(copy);
  stats();
}
function remove() {
  if (!chosen || chosen === model) return;
  remember();
  chosen.removeFromParent();
  choose(null);
  rebuild();
  stats();
}
$("dup").onclick = duplicate;
$("del").onclick = remove;

// ---------- changes, undo and versions ----------
/** The whole state: which objects are where in the tree, their transforms, visibility and materials (for undo and versions). */
function snap() {
  const out = [];
  model?.traverse((o) => {
    if (o === model) return;
    const m = o.isMesh ? matOf(o) : null;
    out.push({ o, parent: o.parent, i: o.parent.children.indexOf(o), p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone(), v: o.visible, c: m?.color?.getHex(), r: m?.roughness, mt: m?.metalness });
  });
  return out;
}
function apply(state) {
  const keep = new Set(state.map((x) => x.o));
  // What is not in the state (a duplicate made after it) goes; what was deleted comes back to its place.
  const extra = [];
  model.traverse((o) => { if (o !== model && !keep.has(o)) extra.push(o); });
  extra.forEach((o) => o.removeFromParent());
  for (const x of state) {
    if (x.o.parent !== x.parent) x.parent.add(x.o);
    x.o.position.copy(x.p); x.o.quaternion.copy(x.q); x.o.scale.copy(x.s); x.o.visible = x.v;
    const m = x.o.isMesh ? matOf(x.o) : null;
    if (m?.color && x.c !== undefined) m.color.setHex(x.c);
    if (m && x.r !== undefined) m.roughness = x.r;
    if (m && x.mt !== undefined) m.metalness = x.mt;
  }
  rebuild();
  choose(chosen && keep.has(chosen) ? chosen : null);
  stats();
}
function remember() { undoStack.push(snap()); if (undoStack.length > 100) undoStack.shift(); $("undo").disabled = false; }
function undo() { if (undoStack.length) apply(undoStack.pop()); $("undo").disabled = !undoStack.length; }
let editing = false;
/** A change to the chosen object's material: every mesh in it (a group's parts together). */
const material = (fn) => () => {
  if (!chosen) return;
  if (!editing) { remember(); editing = true; }
  chosen.traverse((o) => { if (o.isMesh) fn(matOf(o)); });
};
$("color").oninput = material((m) => m.color?.set($("color").value));
$("rough").oninput = material((m) => { if ("roughness" in m) m.roughness = $("rough").value / 100; });
$("metal").oninput = material((m) => { if ("metalness" in m) m.metalness = $("metal").value / 100; });
["color", "rough", "metal"].forEach((id) => ($(id).onchange = () => (editing = false)));
$("hidePart").onclick = () => { if (!chosen) return; remember(); chosen.visible = !chosen.visible; choose(chosen); };
$("frame").onclick = () => frame(chosen ?? model ?? scene);
function keepVersion() {
  if (!model) return;
  if (glow) glow.visible = false;
  gizmo.getHelper().visible = false;
  renderer.render(scene, camera);
  gizmo.getHelper().visible = true;
  const pic = renderer.domElement.toDataURL("image/jpeg", 0.7);
  if (glow) glow.visible = true;
  versions.push({ pic, state: snap() });
  $("strip").replaceChildren(...versions.map((v, i) => {
    const b = document.createElement("button");
    b.title = `${T("version", "Version")} ${i + 1}`;
    const img = document.createElement("img");
    img.src = v.pic;
    b.append(img);
    b.onclick = () => { remember(); apply(v.state); };
    return b;
  }));
}
$("keep").onclick = keepVersion;
$("undo").onclick = undo;
$("undo").disabled = true;
$("light").onchange = () => setLight($("light").value);
const toggleWire = () => shade($("wire").classList.contains("on") ? "material" : "wire");
$("wire").onclick = toggleWire;

// ---------- out: GLB, the chat ----------
async function glb() {
  glow?.removeFromParent();
  scene.overrideMaterial = null;
  try {
    const out = await new GLTFExporter().parseAsync(model, { binary: true, onlyVisible: true });
    return new Blob([out], { type: "model/gltf-binary" });
  } finally { if (glow) scene.add(glow); if (document.querySelector('[data-shade="solid"].on')) scene.overrideMaterial = solidMat; }
}
const base = () => name.replace(/\.[^.]+$/, "") + "-edited";
$("export").onclick = async () => { if (!model) return; const a = document.createElement("a"); a.href = URL.createObjectURL(await glb()); a.download = `${base()}.glb`; a.click(); };
$("toChat").onclick = () => { if (!model) return; renderer.render(scene, camera); $("chatThumb").src = renderer.domElement.toDataURL("image/jpeg", 0.7); $("chatDialog").showModal(); };
$("chatDialog").addEventListener("close", async () => {
  if ($("chatDialog").returnValue !== "ok") return;
  busy(T("sending", "Sending…"));
  try {
    const blob = await glb();
    if (blob.size > 50 * 1024 * 1024) throw new Error(T("tooBig", "The model is over 50 MB"));
    const data = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(blob); });
    await kesher.call("chat.sendFile", { name: `${base()}.glb`, data, text: $("chatText").value.trim() });
  } catch (e) { msg(e.message, true); } finally { busy(""); }
});

// ---------- keys, phone, words ----------
const KEYS = () => [
  [$("keymap").value === "blender" ? "G / R / S" : "W / E / R", "kMove", "Move / rotate / scale"], ["X / Y / Z", "kAxis", "Lock to an axis (after the tool's key)"],
  ["F", "kF", "Frame the chosen part"], ["Home / A", "kHome", "The whole model"], ["H", "kH", "Hide the part"], ["Alt+H", "kAltH", "Show all"],
  [$("keymap").value === "blender" ? "Shift+D" : "Ctrl+D", "kDup", "Duplicate"], [$("keymap").value === "blender" ? "X / Delete" : "Delete", "kDel", "Delete"],
  ["1 / 3 / 7", "kViews", "Front / right / top"], ["4 / 5 / 6", "kShade", "Wireframe / solid / material"], ["Shift+S", "kSnap", "Snapping"], ["Esc", "kEsc", "Let go"], ["Ctrl+Z", "kUndo", "Undo"],
];
function showKeys() {
  $("keysTable").replaceChildren(...KEYS().map(([k, key, en]) => { const tr = document.createElement("tr"); const a = document.createElement("td"); const kbd = document.createElement("kbd"); kbd.textContent = k; a.append(kbd); const b = document.createElement("td"); b.textContent = T(key, en); tr.append(a, b); return tr; }));
  $("keysDialog").showModal();
}
$("keysBtn").onclick = showKeys;
// Both key maps (asked: after Blender, 3ds Max and Maya): Maya / Max / Unreal's W E R, or Blender's G R S, X, Shift+D.
let lastTool = false;
addEventListener("keydown", (e) => {
  if (e.target.closest?.("input, textarea, select, dialog")) return;
  const k = e.key.toLowerCase(), blender = $("keymap").value === "blender";
  if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); return undo(); }
  if ((e.ctrlKey || e.metaKey) && k === "d" && !blender) { e.preventDefault(); return duplicate(); }
  if (e.ctrlKey || e.metaKey) return;
  if (e.altKey && k === "h") { remember(); model?.traverse((o) => (o.visible = true)); renderParts(); return; }
  if (e.shiftKey && k === "d" && blender) { e.preventDefault(); return duplicate(); }
  if (e.shiftKey && k === "s") { e.preventDefault(); return toggleSnap(); }
  const tools = blender ? { g: "translate", r: "rotate", s: "scale" } : { w: "translate", e: "rotate", r: "scale" };
  if (tools[k]) { e.preventDefault(); setMode(tools[k]); lastTool = true; return; }
  // X / Y / Z right after a tool's key lock its axis; in Blender X alone deletes.
  if (["x", "y", "z"].includes(k) && lastTool) { e.preventDefault(); lockAxis(k); return; }
  lastTool = false;
  const map = {
    f: () => $("frame").click(), home: () => model && frame(model), a: () => model && frame(model), h: () => $("hidePart").click(),
    delete: remove, ...(blender ? { x: remove } : {}), escape: () => choose(null),
    1: () => view("front"), 3: () => view("right"), 7: () => view("top"), 4: () => shade("wire"), 5: () => shade("solid"), 6: () => shade("material"), "?": showKeys,
  };
  if (map[k]) { e.preventDefault(); map[k](); }
});
document.querySelectorAll(".phonebar [data-do]").forEach((b) => (b.onclick = () => {
  const d = b.dataset.do, app = $("app");
  if (d === "parts" || d === "inspector") { const on = app.classList.contains(`sheet-${d}`); app.classList.remove("sheet-parts", "sheet-inspector"); if (!on) app.classList.add(`sheet-${d}`); }
  else ({ frame: () => $("frame").click(), undo, keep: keepVersion })[d]();
}));
let busyCount = 0;
function busy(text) { busyCount = Math.max(0, busyCount + (text ? 1 : -1)); $("busy").hidden = busyCount <= 0; if (text) $("busyText").textContent = text; }
let msgTimer;
function msg(text, error) { const m = $("msg"); m.textContent = text; m.className = `status show${error ? " error" : ""}`; clearTimeout(msgTimer); msgTimer = setTimeout(() => (m.className = "status"), error ? 6000 : 3500); }
kesher.call("storage.get", { key: "keymap" }).then((v) => { if (v === "blender" || v === "maya") $("keymap").value = v; }).catch(() => undefined);
$("keymap").onchange = () => kesher.call("storage.set", { key: "keymap", value: $("keymap").value }).catch(() => undefined);
kesher.call("info").then((i) => {
  he = i.locale === "he";
  if (he) { document.documentElement.dir = "rtl"; document.querySelectorAll("[data-t]").forEach((el) => (el.textContent = T(el.dataset.t, el.textContent))); }
}).catch(() => undefined);
open();
