// KesherAI's 3D editor, stage 1 (docs/RESEARCH_LOG.md → "The 3D editor's screen"): the chat's model in three.js, its
// parts as a list, each part's material, measurements, light setups, versions, and a GLB back to the chat. A plugin page
// with no build step (three.js is vendored in ui/vendor/three/); it talks to KesherAI only through window.kesher.
/* global window, document, Image, addEventListener, requestAnimationFrame, setTimeout, clearTimeout, ResizeObserver, FileReader, Blob, URL */
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
  texH: "טקסטורה (צבע בסיס)", noTex: "אין טקסטורה", texEdit: "✎ עריכה בעורך התמונות", texNew: "＋ טקסטורה חדשה", texRemove: "✕", texSent: "פותח את הטקסטורה בעורך התמונות…", texBack: "הטקסטורה חזרה מעורך התמונות", needMesh: "בחר חלק עם צורה", noUv: "לחלק הזה אין UV, אז אין קווים מנחים",
  splitH: "✂ חלוקה לחלקים…", sLoose: "לפי חלקים נפרדים", sMaterial: "לפי חומר", sAi: "לפי משמעות (AI)…", splitDone: (n) => `חולק ל-${n} חלקים`, splitNone: "החלק הזה הוא כבר חתיכה אחת",
  piece: "חתיכה",
  pickFaces: "🎯 בחירה בלחיצה", angle: "זווית", separate: "הפרד", pickHint: "לחץ על המודל: הבחירה מתפשטת עד פינה חדה. Shift מוסיף.", picked: (n) => `נבחרו ${n} משולשים`, separated: "הבחירה הפכה לחלק משלה",
  texPromptPh: "✨ טקסטורה ממילים: עץ אלון ישן, קטיפה אדומה…", texAi: "✨", texMaking: "מודל התמונות מצייר טקסטורה… (במחשב)", texDone: "הטקסטורה החדשה על החלק", needWords: "כתוב איזו טקסטורה",
  partsInstalling: "מנוע החלקים עוד יורד; נסה שוב כשיסיים.", partsWorking: "מחלק לפי משמעות במחשב… (P3-SAM, יכול לקחת דקה)", partsReady: "מנוע החלקים מוכן: בחר חלק ו'לפי משמעות (AI)' שוב.", partsFailed: "ההתקנה של מנוע החלקים נעצרה", partsInstalling2: "מוריד את מנוע החלקים…",
  modsH: "מודיפיירים", addMod: "＋ הוספה…", mMirror: "מראה", mArray: "מערך", mSmooth: "הצללה חלקה", axis: "ציר", count: "כמות", gap: "רווח", on: "פעיל", up: "למעלה", remove: "הסר",
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
    // Back from the image editor: the new texture into the slot it was made for.
    if (input.back?.data && /^\d+:map$/.test(input.back.slot)) {
      const mesh = meshes.filter((p) => !isGenerated(p.mesh))[Number(input.back.slot.split(":")[0])]?.mesh;
      if (mesh) { await setTexture(mesh, input.back.data); msg(T("texBack", "The texture came back from the image editor")); setTimeout(() => choose(mesh), 0); }
    }
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
  // A click on a piece a modifier made chooses the object it belongs to.
  renderParts();
}
function tris(obj) { let n = 0; obj.traverse((o) => { if (o.isMesh) { const g = o.geometry; n += (g.index ? g.index.count : g.attributes.position.count) / 3; } }); return Math.round(n); }
const isGenerated = (o) => { for (let x = o; x; x = x.parent) if (x.userData.generated) return true; return false; };
function stats() { $("stats").textContent = model ? `${meshes.filter((p) => !isGenerated(p.mesh)).length} ${T("parts", "parts")} · ${tris(model).toLocaleString()} ${T("tris", "triangles")}` : ""; }
/** Groups that hold a single mesh and nothing else are shown as that mesh (files often wrap each mesh in a node). */
const shown = (o) => (o.children.length === 1 && !o.isMesh && o.children[0].isMesh && !o.children[0].children.length ? o.children[0] : o);
function renderParts() {
  nodes = [];
  const walk = (o, depth) => { for (const c of o.children) { if (c.userData.generated) continue; const s2 = shown(c); nodes.push({ obj: s2, depth }); if (!folded.has(s2.uuid)) walk(s2, depth + 1); } };
  if (model) walk(model, 0);
  $("partList").replaceChildren(...nodes.map(({ obj, depth }) => {
    const li = document.createElement("li");
    li.className = `${obj === chosen ? "on" : ""}${obj.visible ? "" : " off"}`;
    li.style.paddingInlineStart = `${6 + depth * 14}px`;
    const tw = document.createElement("span");
    tw.className = "tw";
    const kids = obj.children.filter((c) => !c.userData.generated).length;
    tw.textContent = kids ? (folded.has(obj.uuid) ? "▸" : "▾") : "";
    tw.onclick = (e) => { e.stopPropagation(); if (folded.has(obj.uuid)) folded.delete(obj.uuid); else folded.add(obj.uuid); renderParts(); };
    const eye = document.createElement("button");
    eye.textContent = obj.visible ? "👁" : "◌";
    eye.title = obj.visible ? T("hide", "Hide") : T("show", "Show");
    eye.onclick = (e) => { e.stopPropagation(); remember(); obj.visible = !obj.visible; renderParts(); };
    const n = document.createElement("span");
    n.dir = "auto";
    n.textContent = `${kids && !obj.isMesh ? `${label(obj)} (${kids})` : label(obj)}${obj.userData.mods?.some((m) => m.on) ? " ⚙" : ""}`;
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
  if (!chosen) { document.querySelectorAll("[data-ch]").forEach((inp) => (inp.value = "")); $("size").textContent = ""; renderMods(); return; }
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
  renderMods();
  showTexture();
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
  const hit = ray.intersectObjects(meshes.filter((p) => p.mesh.visible && (!picking || !isGenerated(p.mesh))).map((p) => p.mesh), false)[0];
  if (picking) { if (hit && hit.faceIndex !== undefined) pickAt(hit.object, hit.faceIndex, e.shiftKey); else { picked = null; showPicked(); } return; }
  let o = hit?.object ?? null;
  while (o && o.parent && (o.userData.generated || o.parent.userData.generated)) o = o.parent;
  if (o?.name === "⚙ modifiers") o = o.parent;
  choose(o);
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

// ---------- modifiers: generated from the object, never changing it (3ds Max's stack, Blender's modifiers) ----------
/** What each modifier adds or changes, in the stack's order; the results live in a child group named "⚙ modifiers". */
const MOD_NAMES = { mirror: ["mMirror", "Mirror"], array: ["mArray", "Array"], smooth: ["mSmooth", "Smooth shading"] };
function applyMods(obj) {
  obj.getObjectByName("⚙ modifiers")?.removeFromParent();
  const mods = (obj.userData.mods ?? []).filter((m) => m.on);
  // Shading first: it changes the object's own normals (and is undone by turning it off).
  obj.traverse((o) => { if (o.isMesh && o.name !== "⚙ modifiers") [].concat(o.material).forEach((m) => { m.flatShading = !mods.some((x) => x.kind === "smooth") && !!o.userData.wasFlat; m.needsUpdate = true; }); });
  const gen = mods.filter((m) => m.kind !== "smooth");
  if (!gen.length) return;
  const out = new THREE.Group();
  out.name = "⚙ modifiers";
  out.userData.generated = true;
  // Each modifier works on what the ones before it made (the object itself first).
  let copies = [obj];
  const base = () => { const c = obj.clone(); c.getObjectByName("⚙ modifiers")?.removeFromParent(); c.position.set(0, 0, 0); c.rotation.set(0, 0, 0); c.scale.set(1, 1, 1); return c; };
  const box = new THREE.Box3();
  obj.traverse((o) => { if (o.isMesh) { o.geometry.computeBoundingBox(); box.union(o.geometry.boundingBox); } });
  const size = box.getSize(new THREE.Vector3());
  for (const m of gen) {
    const made = [];
    for (const src of copies) {
      if (m.kind === "mirror") {
        const c = src === obj ? base() : src.clone();
        c.scale[m.axis] *= -1;
        // About the object's own centre plane (Blender's Mirror about the origin).
        c.position[m.axis] = src === obj ? 0 : -src.position[m.axis];
        made.push(c);
      } else if (m.kind === "array") {
        for (let i = 1; i < m.count; i++) {
          const c = src === obj ? base() : src.clone();
          c.position[m.axis] = (src === obj ? 0 : src.position[m.axis]) + i * (size[m.axis] + m.gap);
          made.push(c);
        }
      }
    }
    made.forEach((c) => { c.userData.generated = true; out.add(c); });
    copies = [...copies, ...made];
  }
  obj.add(out);
}
function renderMods() {
  const box = $("mods");
  if (!chosen) return box.replaceChildren();
  const mods = chosen.userData.mods ?? [];
  box.replaceChildren(...mods.map((m, i) => {
    const li = document.createElement("li");
    li.className = m.on ? "" : "off";
    const head = document.createElement("div");
    head.className = "head";
    const name = document.createElement("b");
    name.textContent = T(...MOD_NAMES[m.kind]);
    const mk = (txt, title, fn) => { const b = document.createElement("button"); b.textContent = txt; b.title = title; b.onclick = () => { remember(); fn(); applyMods(chosen); renderMods(); stats(); }; return b; };
    head.append(name, mk(m.on ? "👁" : "◌", T("on", "On"), () => (m.on = !m.on)), mk("↑", T("up", "Up"), () => { if (i) [mods[i - 1], mods[i]] = [mods[i], mods[i - 1]]; }), mk("✕", T("remove", "Remove"), () => mods.splice(i, 1)));
    li.append(head);
    const field = (key, labelText, el) => { const l = document.createElement("label"); l.append(labelText, el); el.onchange = () => { remember(); m[key] = el.type === "number" ? Number(el.value) : el.value; applyMods(chosen); stats(); }; li.append(l); };
    if (m.kind !== "smooth") {
      const ax = document.createElement("select");
      ["x", "y", "z"].forEach((a) => { const o = document.createElement("option"); o.value = a; o.textContent = a.toUpperCase(); ax.append(o); });
      ax.value = m.axis;
      field("axis", T("axis", "Axis"), ax);
    }
    if (m.kind === "array") {
      const n = document.createElement("input"); n.type = "number"; n.min = "2"; n.max = "50"; n.value = String(m.count);
      field("count", T("count", "Count"), n);
      const g = document.createElement("input"); g.type = "number"; g.step = "0.01"; g.value = String(m.gap);
      field("gap", T("gap", "Gap"), g);
    }
    return li;
  }));
}
$("addMod").onchange = () => {
  const kind = $("addMod").value;
  $("addMod").value = "";
  if (!chosen || !kind) return;
  remember();
  chosen.traverse((o) => { if (o.isMesh && o.userData.wasFlat === undefined) o.userData.wasFlat = !![].concat(o.material)[0]?.flatShading; });
  (chosen.userData.mods ??= []).push(kind === "array" ? { kind, on: true, axis: "x", count: 3, gap: 0.05 } : kind === "mirror" ? { kind, on: true, axis: "x" } : { kind, on: true });
  applyMods(chosen);
  renderMods();
  stats();
};

// ---------- textures: the base colour map, edited in the image editor (a hand-off with the way back) ----------
/** The mesh a texture belongs to: the chosen one, or the first mesh in the chosen group. */
const meshOfChosen = () => (chosen?.isMesh ? chosen : chosen?.getObjectByProperty("isMesh", true)) ?? null;
/** A stable name for a mesh across saving and opening again: its place among the file's meshes. */
const slotOf = (mesh) => `${meshes.filter((p) => !isGenerated(p.mesh)).findIndex((p) => p.mesh === mesh)}:map`;
function texCanvas(mesh, size) {
  const c = document.createElement("canvas");
  const m = matOf(mesh);
  const img = m?.map?.image;
  c.width = img?.width || size;
  c.height = img?.height || size;
  const g = c.getContext("2d");
  if (img) g.drawImage(img, 0, 0, c.width, c.height);
  else { g.fillStyle = `#${(m?.color ?? new THREE.Color(0xcccccc)).getHexString()}`; g.fillRect(0, 0, c.width, c.height); }
  return c;
}
/** The UV layout as white lines on a clear picture: the guide layer (Maya's UV snapshot). */
function uvGuide(mesh, w, h) {
  const uv = mesh.geometry.attributes.uv;
  if (!uv) return null;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.strokeStyle = "rgba(255,255,255,0.9)";
  g.lineWidth = Math.max(1, w / 1024);
  const idx = mesh.geometry.index;
  const n = idx ? idx.count : uv.count;
  const at = (i) => { const k = idx ? idx.getX(i) : i; return [uv.getX(k) * w, (1 - uv.getY(k)) * h]; };
  g.beginPath();
  for (let i = 0; i + 2 < n; i += 3) { const [a, b, d] = [at(i), at(i + 1), at(i + 2)]; g.moveTo(...a); g.lineTo(...b); g.lineTo(...d); g.closePath(); }
  g.stroke();
  return c;
}
function showTexture() {
  const mesh = meshOfChosen();
  const map = mesh && matOf(mesh)?.map;
  $("texThumb").hidden = !map;
  if (map?.image) { const c = texCanvas(mesh, 128); $("texThumb").src = c.toDataURL("image/png"); $("texInfo").textContent = `${map.image.width}×${map.image.height}`; }
  else $("texInfo").textContent = T("noTex", "No texture");
  $("texRemove").disabled = !map;
}
async function editTexture(fresh) {
  const mesh = meshOfChosen();
  if (!mesh) return msg(T("needMesh", "Choose a part with a shape"), true);
  const size = 1024;
  const tex = fresh ? (() => { const c = document.createElement("canvas"); c.width = c.height = size; const g = c.getContext("2d"); g.fillStyle = `#${(matOf(mesh)?.color ?? new THREE.Color(0xffffff)).getHexString()}`; g.fillRect(0, 0, size, size); return c; })() : texCanvas(mesh, size);
  const guide = uvGuide(mesh, tex.width, tex.height);
  if (!guide) msg(T("noUv", "This part has no UVs, so there are no guide lines"));
  busy(T("texSent", "Opening the texture in the image editor…"));
  try {
    const working = await new Promise((resolve) => glb().then((b) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(b); }));
    const part = (label(mesh) || "part").replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 40);
    await kesher.call("editor.handoff", { to: "image-editor", data: tex.toDataURL("image/png"), name: `${part}-texture.png`, slot: slotOf(mesh), ...(guide ? { guide: guide.toDataURL("image/png"), guideName: `${part}-uv.png` } : {}), working, workingName: `${base().replace(/-edited$/, "")}-working.glb` });
  } catch (e) { msg(e.message, true); } finally { busy(""); }
}
/** A picture as the mesh's base colour map (glTF's way: not flipped, sRGB), the colour set to white so it shows true. */
async function setTexture(mesh, dataUrl) {
  const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = dataUrl; });
  const t = new THREE.Texture(img);
  t.flipY = false;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  [].concat(mesh.material).forEach((m) => { m.map = t; m.color?.set(0xffffff); m.needsUpdate = true; });
}
// A texture from words with the picture model on the computer (Meshy's and Tripo's "retexture", simply): seamless,
// so it repeats over the part without seams.
$("texAi").onclick = async () => {
  const mesh = meshOfChosen();
  const words = $("texPrompt").value.trim();
  if (!mesh) return msg(T("needMesh", "Choose a part with a shape"), true);
  if (!words) return msg(T("needWords", "Write which texture"), true);
  busy(T("texMaking", "The picture model is painting a texture… (on your computer)"));
  try {
    const [url] = await kesher.call("image.generate", { prompt: `${words}, seamless tileable texture, flat even lighting, top-down, no shadows, high detail`, width: 1024, height: 1024 });
    remember();
    await setTexture(mesh, url);
    showTexture();
    msg(T("texDone", "The new texture is on the part"));
  } catch (e) { msg(e.message, true); } finally { busy(""); }
};
$("texEdit").onclick = () => editTexture(false);
$("texNew").onclick = () => editTexture(true);
$("texRemove").onclick = () => { const mesh = meshOfChosen(); if (!mesh) return; remember(); [].concat(mesh.material).forEach((m) => { m.map = null; m.needsUpdate = true; }); showTexture(); };

// ---------- split into parts (Blender's Separate by loose parts / by material), so each can get its own texture ----------
/** The triangles of a mesh in groups that share no vertex position (each loose piece), by union-find. */
function loosePieces(geo) {
  const pos = geo.attributes.position, idx = geo.index;
  const n = idx ? idx.count : pos.count;
  const key = (k) => `${pos.getX(k).toFixed(5)},${pos.getY(k).toFixed(5)},${pos.getZ(k).toFixed(5)}`;
  // Vertices at the same place are one (a seam in UVs or normals still joins the piece).
  const id = new Map(), at = new Int32Array(pos.count);
  for (let k = 0; k < pos.count; k++) { const s2 = key(k); if (!id.has(s2)) id.set(s2, id.size); at[k] = id.get(s2); }
  const parent = new Int32Array(id.size).map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a; };
  const v = (i) => at[idx ? idx.getX(i) : i];
  for (let i = 0; i + 2 < n; i += 3) { const a = find(v(i)); parent[find(v(i + 1))] = a; parent[find(v(i + 2))] = a; }
  const groups = new Map();
  for (let i = 0; i + 2 < n; i += 3) { const r = find(v(i)); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); }
  return [...groups.values()];
}
/** A new geometry with only these triangles (every attribute kept: UVs, normals, colours). */
function subGeometry(geo, tris) {
  const idx = geo.index, out = new THREE.BufferGeometry();
  const src = (i) => (idx ? idx.getX(i) : i);
  for (const [name, attr] of Object.entries(geo.attributes)) {
    const arr = new attr.array.constructor(tris.length * 3 * attr.itemSize);
    let o = 0;
    for (const t of tris) for (let j = 0; j < 3; j++) { const k = src(t + j); for (let c = 0; c < attr.itemSize; c++) arr[o++] = attr.array[k * attr.itemSize + c]; }
    out.setAttribute(name, new THREE.BufferAttribute(arr, attr.itemSize, attr.normalized));
  }
  return out;
}
function splitChosen(how) {
  const mesh = meshOfChosen();
  if (!mesh) return msg(T("needMesh", "Choose a part with a shape"), true);
  if (how === "ai") return splitByMeaning(mesh);
  const geo = mesh.geometry;
  let groups;
  if (how === "material" && Array.isArray(mesh.material) && geo.groups.length > 1) {
    groups = geo.groups.map((g) => { const t = []; for (let i = g.start; i < g.start + g.count; i += 3) t.push(i); return { tris: t, mat: mesh.material[g.materialIndex] }; });
  } else groups = loosePieces(geo).map((tris) => ({ tris, mat: matOf(mesh) }));
  if (groups.length < 2) return msg(T("splitNone", "This part is one piece already"));
  separateInto(mesh, groups);
}
/** A mesh becomes a group of meshes, one for each set of triangles (its place, materials and names kept). */
function separateInto(mesh, groups) {
  remember();
  const holder = new THREE.Group();
  holder.name = label(mesh);
  holder.position.copy(mesh.position); holder.quaternion.copy(mesh.quaternion); holder.scale.copy(mesh.scale);
  groups.forEach((g, i) => {
    const m = new THREE.Mesh(subGeometry(mesh.geometry, g.tris), g.mat.clone());
    m.name = `${label(mesh)} · ${T("piece", "piece")} ${i + 1}`;
    holder.add(m);
  });
  mesh.parent.add(holder);
  mesh.removeFromParent();
  rebuild();
  choose(holder);
  stats();
  msg(he ? HE.splitDone(groups.length) : `Split into ${groups.length} parts`);
}
/** Split by meaning with P3-SAM on the computer: the mesh goes in world space, each triangle's part comes back. */
async function splitByMeaning(mesh) {
  const st = await kesher.call("model.parts.status").catch(() => null);
  if (!st?.installed) {
    if (st?.phase === "installing") return msg(T("partsInstalling", "The parts engine is still downloading; try again when it is done."));
    if (await kesher.call("model.parts.setup").catch((e) => msg(e.message, true))) watchSetup();
    return;
  }
  busy(T("partsWorking", "Splitting by meaning on your computer… (P3-SAM, can take a minute)"));
  try {
    // One mesh, as it sits in the world, so the centres that come back are in the same place as ours.
    const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    const tmp = new THREE.Mesh(g, new THREE.MeshStandardMaterial());
    const out = await new GLTFExporter().parseAsync(tmp, { binary: true });
    const data = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(new Blob([out])); });
    const faces = await kesher.call("model.parts.segment", { data });
    // Each of our triangles takes the part of the nearest centre that came back (a grid makes it quick).
    const cell = new THREE.Box3().setFromObject(tmp).getSize(new THREE.Vector3()).length() / 64 || 1;
    const grid = new Map();
    const k = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    for (const f of faces) { const key = k(f[0], f[1], f[2]); if (!grid.has(key)) grid.set(key, []); grid.get(key).push(f); }
    const pos = g.attributes.position, idx = g.index, n = idx ? idx.count : pos.count;
    const byPart = new Map();
    const v = new THREE.Vector3();
    for (let t = 0; t + 2 < n; t += 3) {
      let cx = 0, cy = 0, cz = 0;
      for (let j = 0; j < 3; j++) { const q = idx ? idx.getX(t + j) : t + j; v.fromBufferAttribute(pos, q); cx += v.x / 3; cy += v.y / 3; cz += v.z / 3; }
      let best = -1, bd = Infinity;
      const [gx, gy, gz] = [Math.floor(cx / cell), Math.floor(cy / cell), Math.floor(cz / cell)];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (const f of grid.get(`${gx + dx},${gy + dy},${gz + dz}`) ?? []) {
        const d = (f[0] - cx) ** 2 + (f[1] - cy) ** 2 + (f[2] - cz) ** 2;
        if (d < bd) { bd = d; best = f[3]; }
      }
      if (!byPart.has(best)) byPart.set(best, []);
      byPart.get(best).push(t);
    }
    const groups = [...byPart.entries()].sort((a, b) => a[0] - b[0]).map(([, tris]) => ({ tris, mat: matOf(mesh) }));
    if (groups.length < 2) return msg(T("splitNone", "This part is one piece already"));
    separateInto(mesh, groups);
  } catch (e) { msg(e.message, true); } finally { busy(""); }
}
/** While the parts engine downloads, its progress in the status line, and "ready" when it is. */
function watchSetup() {
  const tick = async () => {
    const st = await kesher.call("model.parts.status").catch(() => null);
    if (st?.installed && !st.phase) return msg(T("partsReady", "The parts engine is ready: choose a part and 'By meaning (AI)' again."));
    if (st?.phase === "error") return msg(`${T("partsFailed", "Setting up the parts engine stopped")}: ${st.message ?? ""}`, true);
    msg(`${T("partsInstalling2", "Downloading the parts engine…")} ${st?.log?.at(-1)?.slice(0, 80) ?? ""}`);
    setTimeout(tick, 4000);
  };
  tick();
}
$("split").onchange = () => { const how = $("split").value; $("split").value = ""; if (how) splitChosen(how); };

// ---------- choose by click: the faces linked under the click, until the surface turns (Blender's Select Linked) ----------
let picking = false;
let picked = null; // { mesh, tris: Set of triangle starts }
let pickOverlay = null;
/** Each triangle's neighbours across a shared edge (by position, so UV seams still join). */
function neighbours(geo) {
  if (geo.userData.nb) return geo.userData.nb;
  const pos = geo.attributes.position, idx = geo.index, n = idx ? idx.count : pos.count;
  const key = (k) => `${pos.getX(k).toFixed(5)},${pos.getY(k).toFixed(5)},${pos.getZ(k).toFixed(5)}`;
  const vid = (i) => key(idx ? idx.getX(i) : i);
  const edges = new Map(), nb = new Map(), normal = new Map();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const at = (i, v) => { const k = idx ? idx.getX(i) : i; return v.set(pos.getX(k), pos.getY(k), pos.getZ(k)); };
  for (let t = 0; t + 2 < n; t += 3) {
    normal.set(t, new THREE.Triangle(at(t, a), at(t + 1, b), at(t + 2, c)).getNormal(new THREE.Vector3()));
    nb.set(t, []);
    const v = [vid(t), vid(t + 1), vid(t + 2)];
    for (const [x, y] of [[v[0], v[1]], [v[1], v[2]], [v[2], v[0]]]) {
      const e = x < y ? `${x}|${y}` : `${y}|${x}`;
      if (!edges.has(e)) edges.set(e, []);
      edges.get(e).push(t);
    }
  }
  for (const ts of edges.values()) for (const t of ts) for (const u of ts) if (t !== u) nb.get(t).push(u);
  geo.userData.nb = { nb, normal };
  return geo.userData.nb;
}
function pickAt(mesh, faceIndex, add) {
  const { nb, normal } = neighbours(mesh.geometry);
  const start = faceIndex * 3, limit = Math.cos(THREE.MathUtils.degToRad(Number($("pickAngle").value)));
  const set = add && picked?.mesh === mesh ? picked.tris : new Set();
  const queue = [start];
  set.add(start);
  while (queue.length) {
    const t = queue.pop();
    for (const u of nb.get(t) ?? []) if (!set.has(u) && normal.get(t).dot(normal.get(u)) >= limit) { set.add(u); queue.push(u); }
  }
  picked = { mesh, tris: set };
  showPicked();
}
function showPicked() {
  pickOverlay?.removeFromParent();
  pickOverlay = null;
  $("pickRow").hidden = !picked;
  if (!picked) return;
  pickOverlay = new THREE.Mesh(subGeometry(picked.mesh.geometry, [...picked.tris]), new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.55, depthTest: false }));
  pickOverlay.userData.generated = true;
  picked.mesh.add(pickOverlay);
  $("pickInfo").textContent = he ? HE.picked(picked.tris.size) : `${picked.tris.size} triangles chosen`;
}
$("pickFaces").onclick = () => {
  picking = !picking;
  $("pickFaces").classList.toggle("on", picking);
  if (picking) msg(T("pickHint", "Click the model: the choice spreads until a sharp corner. Shift adds.")); else { picked = null; showPicked(); }
};
/** The chosen faces become a part of their own (Blender's Separate → Selection), the rest stays. */
$("separate").onclick = () => {
  if (!picked) return;
  const { mesh, tris } = picked;
  const all = [];
  const n = mesh.geometry.index ? mesh.geometry.index.count : mesh.geometry.attributes.position.count;
  for (let t = 0; t + 2 < n; t += 3) all.push(t);
  const rest = all.filter((t) => !tris.has(t));
  if (!rest.length) return msg(T("splitNone", "This part is one piece already"));
  remember();
  picked = null; showPicked();
  const part = new THREE.Mesh(subGeometry(mesh.geometry, [...tris]), [].concat(mesh.material)[0].clone());
  part.name = `${label(mesh)} · ${T("piece", "piece")}`;
  part.position.copy(mesh.position); part.quaternion.copy(mesh.quaternion); part.scale.copy(mesh.scale);
  const keep = new THREE.Mesh(subGeometry(mesh.geometry, rest), [].concat(mesh.material)[0]);
  keep.name = label(mesh);
  keep.position.copy(mesh.position); keep.quaternion.copy(mesh.quaternion); keep.scale.copy(mesh.scale);
  const parent = mesh.parent;
  parent.add(keep, part);
  mesh.removeFromParent();
  rebuild(); choose(part); stats();
  msg(T("separated", "The choice became a part of its own"));
};

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
    if (o === model || o.userData.generated) return;
    const m = o.isMesh ? matOf(o) : null;
    out.push({ o, parent: o.parent, i: o.parent.children.indexOf(o), p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone(), v: o.visible, c: m?.color?.getHex(), r: m?.roughness, mt: m?.metalness, mods: o.userData.mods ? JSON.parse(JSON.stringify(o.userData.mods)) : undefined });
  });
  return out;
}
function apply(state) {
  const keep = new Set(state.map((x) => x.o));
  // What is not in the state (a duplicate made after it) goes; what was deleted comes back to its place.
  const extra = [];
  model.traverse((o) => { if (o !== model && !keep.has(o) && !o.userData.generated) extra.push(o); });
  extra.forEach((o) => o.removeFromParent());
  for (const x of state) {
    if (x.o.parent !== x.parent) x.parent.add(x.o);
    x.o.position.copy(x.p); x.o.quaternion.copy(x.q); x.o.scale.copy(x.s); x.o.visible = x.v;
    const m = x.o.isMesh ? matOf(x.o) : null;
    if (m?.color && x.c !== undefined) m.color.setHex(x.c);
    if (m && x.r !== undefined) m.roughness = x.r;
    if (m && x.mt !== undefined) m.metalness = x.mt;
    if (x.mods || x.o.userData.mods) { x.o.userData.mods = x.mods; applyMods(x.o); }
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
  if (he) { document.documentElement.dir = "rtl"; document.querySelectorAll("[data-t]").forEach((el) => (el.textContent = T(el.dataset.t, el.textContent))); document.querySelectorAll("[data-tp]").forEach((el) => (el.placeholder = T(el.dataset.tp, el.placeholder))); }
}).catch(() => undefined);
open();
