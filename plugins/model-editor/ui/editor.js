// KesherAI's 3D editor, stage 1 (docs/RESEARCH_LOG.md → "The 3D editor's screen"): the chat's model in three.js, its
// parts as a list, each part's material, measurements, light setups, versions, and a GLB back to the chat. A plugin page
// with no build step (three.js is vendored in ui/vendor/three/); it talks to KesherAI only through window.kesher.
/* global window, document, addEventListener, requestAnimationFrame, setTimeout, clearTimeout, ResizeObserver, FileReader, Blob, URL */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const $ = (id) => document.getElementById(id);
const kesher = window.kesher;
const HE = {
  export: "ייצוא GLB", toChat: "שלח לצ'אט", empty: "פתח מודל מצ'אט: \"עריכה בעורך התלת ממד\" בתצוגה שלו.", partsH: "חלקים", noPart: "בחר חלק",
  color: "צבע", rough: "חספוס", metal: "מתכתיות", hide: "הסתר", show: "הצג", frameBtn: "מסגר (F)", soon: "בקרוב: לסמן חלק ו\"מה לעשות כאן?\" עם מודלי התלת ממד.",
  keep: "＋ שמור גרסה", lStudio: "סטודיו", lSun: "שמש", lEvening: "ערב", paintS: "חומר", frameS: "מסגור", undoS: "ביטול", keepS: "גרסה",
  toChatH: "שליחה לצ'אט", toChatMsg: "הודעה איתו (לא חובה)", cancel: "ביטול", send: "שלח", keysH: "קיצורים (כמו ב-Blender)", close: "סגור",
  loading: "טוען את המודל…", sending: "שולח…", tris: "משולשים", parts: "חלקים", size: "גודל", version: "גרסה", unnamed: "חלק",
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
let meshes = []; // [{ mesh, name }]
let chosen = -1;
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
    model.traverse((o) => { if (o.isMesh) { o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone(); meshes.push({ mesh: o, name: o.name || `${T("unnamed", "Part")} ${meshes.length + 1}` }); } });
    // The floor under the model, scaled to it.
    const box = new THREE.Box3().setFromObject(model);
    const s = box.getSize(new THREE.Vector3());
    grid.scale.setScalar(Math.max(s.x, s.z, 0.1) / 3);
    grid.position.y = box.min.y;
    $("empty").hidden = true;
    frame(model);
    renderParts();
    stats();
  } catch (e) { msg(e.message || "The model could not be read.", true); } finally { busy(""); }
}

// ---------- parts and the chosen one ----------
const matOf = (m) => (Array.isArray(m.material) ? m.material[0] : m.material);
function tris(obj) { let n = 0; obj.traverse((o) => { if (o.isMesh) { const g = o.geometry; n += (g.index ? g.index.count : g.attributes.position.count) / 3; } }); return Math.round(n); }
function stats() { $("stats").textContent = model ? `${meshes.length} ${T("parts", "parts")} · ${tris(model).toLocaleString()} ${T("tris", "triangles")}` : ""; }
function renderParts() {
  $("partList").replaceChildren(...meshes.map((p, i) => {
    const li = document.createElement("li");
    li.className = `${i === chosen ? "on" : ""}${p.mesh.visible ? "" : " off"}`;
    const eye = document.createElement("button");
    eye.textContent = p.mesh.visible ? "👁" : "◌";
    eye.title = p.mesh.visible ? T("hide", "Hide") : T("show", "Show");
    eye.onclick = (e) => { e.stopPropagation(); remember(); p.mesh.visible = !p.mesh.visible; renderParts(); };
    const n = document.createElement("span");
    n.dir = "auto";
    n.textContent = p.name;
    li.append(eye, n);
    li.onclick = () => choose(i);
    return li;
  }));
}
let glow = null;
function choose(i) {
  chosen = i;
  glow?.removeFromParent(); glow = null;
  const p = meshes[i];
  renderParts();
  $("partName").textContent = p ? p.name : T("noPart", "Choose a part");
  if (!p) return;
  // The chosen part is outlined by a box (Blender's orange outline, simply).
  glow = new THREE.BoxHelper(p.mesh, 0xffa040);
  scene.add(glow);
  const m = matOf(p.mesh);
  if (m?.color) $("color").value = `#${m.color.getHexString()}`;
  $("rough").value = Math.round((m?.roughness ?? 0.5) * 100);
  $("metal").value = Math.round((m?.metalness ?? 0) * 100);
  const s = new THREE.Box3().setFromObject(p.mesh).getSize(new THREE.Vector3());
  $("size").textContent = `${T("size", "Size")}: ${[s.x, s.y, s.z].map((v) => v.toFixed(3)).join(" × ")} · ${tris(p.mesh).toLocaleString()} ${T("tris", "triangles")}`;
  $("hidePart").textContent = p.mesh.visible ? T("hide", "Hide") : T("show", "Show");
}
// A click in the view chooses the part under it (a drag turns the view instead).
let down = null;
renderer.domElement.addEventListener("pointerdown", (e) => (down = [e.clientX, e.clientY]));
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || !model) return;
  const r = renderer.domElement.getBoundingClientRect();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = ray.intersectObjects(meshes.filter((p) => p.mesh.visible).map((p) => p.mesh), false)[0];
  choose(hit ? meshes.findIndex((p) => p.mesh === hit.object) : -1);
});

// ---------- changes, undo and versions ----------
/** The state of every part (material and visibility), to undo to or keep as a version. */
const snap = () => meshes.map(({ mesh }) => { const m = matOf(mesh); return { v: mesh.visible, c: m?.color?.getHex(), r: m?.roughness, mt: m?.metalness }; });
function apply(s) { s.forEach((x, i) => { const { mesh } = meshes[i]; const m = matOf(mesh); mesh.visible = x.v; if (m?.color && x.c !== undefined) m.color.setHex(x.c); if (m && x.r !== undefined) m.roughness = x.r; if (m && x.mt !== undefined) m.metalness = x.mt; }); renderParts(); choose(chosen); }
function remember() { undoStack.push(snap()); if (undoStack.length > 100) undoStack.shift(); $("undo").disabled = false; }
function undo() { if (undoStack.length) apply(undoStack.pop()); $("undo").disabled = !undoStack.length; }
let editing = false;
const material = (fn) => () => {
  const p = meshes[chosen];
  if (!p) return;
  if (!editing) { remember(); editing = true; }
  fn(matOf(p.mesh));
};
$("color").oninput = material((m) => m.color?.set($("color").value));
$("rough").oninput = material((m) => { if ("roughness" in m) m.roughness = $("rough").value / 100; });
$("metal").oninput = material((m) => { if ("metalness" in m) m.metalness = $("metal").value / 100; });
["color", "rough", "metal"].forEach((id) => ($(id).onchange = () => (editing = false)));
$("hidePart").onclick = () => { const p = meshes[chosen]; if (!p) return; remember(); p.mesh.visible = !p.mesh.visible; choose(chosen); };
$("frame").onclick = () => frame(meshes[chosen]?.mesh ?? model ?? scene);
function keepVersion() {
  if (!model) return;
  if (glow) glow.visible = false;
  renderer.render(scene, camera);
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
let wire = false;
function toggleWire() { wire = !wire; $("wire").classList.toggle("on", wire); meshes.forEach(({ mesh }) => [].concat(mesh.material).forEach((m) => (m.wireframe = wire))); }
$("wire").onclick = toggleWire;

// ---------- out: GLB, the chat ----------
async function glb() {
  glow?.removeFromParent();
  try {
    const out = await new GLTFExporter().parseAsync(model, { binary: true, onlyVisible: true });
    return new Blob([out], { type: "model/gltf-binary" });
  } finally { if (glow) scene.add(glow); }
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
const KEYS = [["F", "kF", "Frame the chosen part"], ["Home", "kHome", "The whole model"], ["H", "kH", "Hide the part"], ["Alt+H", "kAltH", "Show all"], ["W", "kW", "Wireframe"], ["Ctrl+Z", "kUndo", "Undo"]];
function showKeys() {
  $("keysTable").replaceChildren(...KEYS.map(([k, key, en]) => { const tr = document.createElement("tr"); const a = document.createElement("td"); const kbd = document.createElement("kbd"); kbd.textContent = k; a.append(kbd); const b = document.createElement("td"); b.textContent = T(key, en); tr.append(a, b); return tr; }));
  $("keysDialog").showModal();
}
$("keysBtn").onclick = showKeys;
addEventListener("keydown", (e) => {
  if (e.target.closest?.("input, textarea, select, dialog")) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); return undo(); }
  if (e.ctrlKey || e.metaKey) return;
  if (e.altKey && k === "h") { remember(); meshes.forEach(({ mesh }) => (mesh.visible = true)); renderParts(); return; }
  const map = { f: () => $("frame").click(), home: () => model && frame(model), h: () => $("hidePart").click(), w: toggleWire, "?": showKeys };
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
kesher.call("info").then((i) => {
  he = i.locale === "he";
  if (he) { document.documentElement.dir = "rtl"; document.querySelectorAll("[data-t]").forEach((el) => (el.textContent = T(el.dataset.t, el.textContent))); }
}).catch(() => undefined);
open();
