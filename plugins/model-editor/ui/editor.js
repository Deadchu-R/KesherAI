// KesherAI's 3D editor, stage 1 (docs/RESEARCH_LOG.md → "The 3D editor's screen"): the chat's model in three.js, its
// parts as a list, each part's material, measurements, light setups, versions, and a GLB back to the chat. A plugin page
// with no build step (three.js is vendored in ui/vendor/three/); it talks to KesherAI only through window.kesher.
/* global window, document, Image, addEventListener, requestAnimationFrame, setTimeout, clearTimeout, ResizeObserver, FileReader, Blob, URL, setInterval, atob, confirm, TextDecoder, File, MediaRecorder, performance, fetch, setInterval, clearInterval */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { SimplifyModifier } from "three/addons/modifiers/SimplifyModifier.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { openMenu, pickDevice, pickMedia, setHebrew, takeMedia, uploadMedia } from "./add-media.js";

const $ = (id) => document.getElementById(id);
const kesher = window.kesher;
const HE = {
  editIn: "✎ ערוך ב…", editInT: "פותח את העורך השני; \"חזרה ל…\" שם מחזירה אותך", editTex: "ערוך טקסטורה בעורך התמונות", editTexHint: "החלק שנבחר, וחוזר לחומר שלו",
  addB: "＋ הוסף", addS: "הוסף", addAt: "נכנס למרכז התצוגה, נבחר", fromDevice: "מהמחשב / מהטלפון", fromChat: "מהקבצים של הצ׳אט", fromBank: "מבנק היצירות", dragToo: "גם גרירה", aCube: "קובייה", aSphere: "כדור", aCylinder: "גליל", aCone: "חרוט", aPlane: "מישור", aTorus: "טבעת", aLight: "אור", aCamera: "מצלמה", aRef: "תמונת רפרנס", aRefHint: "מאחורי המודל, לא נשמרת", aWords: "מודל ממילים, צורה בלבד", aWordsHint: "Hunyuan3D 2, מהיר יותר", aWordsColour: "מודל ממילים, עם צבעים", aWordsColourHint: "TRELLIS.2, במחשב שלך", aFromPic: "מודל מתמונה, עם צבעים", aFromPicHint: "חפץ אחד בתמונה", wordsPainting: "בונה וצובע את המודל… (כמה דקות, במחשב שלך)", added: (n) => `נוסף: ${n}`, notModel: "אפשר להוסיף כאן מודל (GLB, GLTF, FBX, OBJ) או תמונה", wordsDrawing: "מצייר את החפץ… (דקה-שתיים)", wordsModelling: "הופך את התמונה למודל… (כמה דקות, במחשב שלך)", wordsDownload: "מודל התלת-ממד עוד לא במחשב הזה. להוריד אותו עכשיו?", wordsPicKept: "התמונה בקבצי הצ׳אט; אפשר ליצור ממנה מודל אחר כך", wordsDownloading: "מודל התלת-ממד יורד (בעיגול ההורדות); נסה שוב כשיסתיים. התמונה בקבצי הצ׳אט.", needChat: "פתח את עורך התלת-ממד מצ׳אט כדי ליצור כאן מודל", wordsAsk: "מה לבנות? (למשל: כיסא עץ עתיק)", wordsSent: "ביקשתי מהצ׳אט. כשהמודל מוכן (כמה דקות), הוסף אותו מ״מהקבצים של הצ׳אט״.", scene: "סצנה",
  export: "ייצוא GLB", toChat: "שלח לצ'אט", empty: "פתח מודל מצ'אט: \"עריכה בעורך התלת ממד\" בתצוגה שלו.", partsH: "חלקים", noPart: "בחר חלק",
  color: "צבע", rough: "חספוס", metal: "מתכתיות", hide: "הסתר", show: "הצג", frameBtn: "מסגר (F)", isoBtn: "בודד (/)", kShot: "תמונה של התצוגה", follow: "לעקוב אחרי", unfollow: "להפסיק לעקוב", paintAsk: "איך הוא צריך להיראות? (עץ אלון ישן עם פליז, קטיפה אדומה שחוקה…)", painting: "צובע אותו מארבעה צדדים… (כמה דקות, במחשב שלך)", paintDownload: "לצביעה צריך את Stable Diffusion 1.5 ו-ControlNet עומק, שעוד לא במחשב הזה. להוריד אותם עכשיו?", painted: "העותק הצבוע לצד המקור (אפשר להסתיר כל אחד ב-👁)", noRecord: "הדפדפן הזה לא יכול להקליט את התצוגה", turning: "מקליט סיבוב סביב המודל…", turnH: "סרטון סיבוב, לצ׳אט", sec: "שנ׳", turnView: "בגודל התצוגה", turnSaved: "סרטון הסיבוב נשמר בקבצי הצ׳אט (ובבנק)", shotSaved: "התמונה נשמרה בקבצי הצ׳אט (ובבנק)", kIso: "רק החלק הנבחר (שוב: הכל)", soon: "בקרוב: לסמן חלק ו\"מה לעשות כאן?\" עם מודלי התלת ממד.",
  keep: "＋ שמור גרסה", lStudio: "סטודיו", lSun: "שמש", lEvening: "ערב", paintS: "חומר", frameS: "מסגור", undoS: "ביטול", keepS: "גרסה",
  toChatH: "שליחה לצ'אט", toChatMsg: "הודעה איתו (לא חובה)", cancel: "ביטול", send: "שלח", keysH: "קיצורים (כמו ב-Blender)", close: "סגור",
  loading: "טוען את המודל…", sending: "שולח…", tris: "משולשים", parts: "חלקים", size: "גודל", version: "גרסה", unnamed: "חלק",
  sceneH: "מבנה הסצנה", cMove: "מיקום", cRotate: "סיבוב°", cScale: "גודל", dup: "שכפל", del: "מחק", vFront: "חזית", vRight: "ימין", vTop: "עליון", vPersp: "פרספקטיבה",
  kMove: "הזזה / סיבוב / שינוי גודל", kAxis: "נעילה לציר (אחרי מקש הכלי)", kDup: "שכפול", kDel: "מחיקה", kViews: "חזית / ימין / עליון", kShade: "תיל / מוצק / חומר", kSnap: "הצמדה", kEsc: "ביטול בחירה",
  texH: "טקסטורה", toUnity: "שמור ל-Unity", standInUnity: "תחליף של סצנת Unity: מזיזים, ואז \"שמור ל-Unity\"; Unity מכניס את זה כשהסצנה פתוחה", unityQueued: "מחכה ל-Unity", unityHow: "Unity מכניס את זה כשהסצנה פתוחה (Ctrl+Z אחד)", toGodot: "שמור לסצנה", standIn: "תחליף של סצנת Godot: מזיזים, ואז \"שמור לסצנה\" (כש-Godot סגור)", noMoves: "עוד לא זז כלום", savingScene: "שומר לסצנה…", clash: "אלה זזו גם ב-Godot:", keepMine: "לשמור את ההזזות שלך?", sceneSaved: "נשמר לסצנה", notFound: "לא נמצאו", quadT: "ארבעה מבטים (Alt+W)", blender: "פתח ב-Blender", fromBlender: "⟲ להביא מ-Blender", toBlender: "פותח ב-Blender…", noBlender: "Blender לא מותקן במחשב (blender.org, חינם).", inBlender: "נפתח ב-Blender. שמור שם (Ctrl+S) והוא חוזר לכאן.", fromBlenderDone: "המודל חזר מ-Blender", taskPh: "מה לעשות עם החלק? (עץ אלון ישן, אדום מבריק, פצל אותו…)", taskThinking: "מבין מה לעשות…", tColour: "המראה", tTexture: "טקסטורה", tHide: "הוסתר", tDup: "עותק", tSplit: "פיצול", tDone: "בוצע", tNone: "לא ברור מה לעשות; נסה צבע, חומר או \"פצל אותו\"", stop: "עצור", paint: "🖌 ציור על המודל", paintColorL: "צבע המכחול", paintSizeL: "גודל", paintHint: "צייר על המודל; גרירה מחוץ לו מסובבת את המבט", madeUv: "לחלק הזה לא היו UV: נוצרו (הטלת קופסה)", texKindL: "סוג הטקסטורה", kMap: "צבע", kRough: "חספוס", kNormal: "נורמל (בליטות)", texDerive: "◐ ליצור מטקסטורת הצבע", noColorTex: "אין לחלק טקסטורת צבע ליצור ממנה", derived: "נוצר מטקסטורת הצבע", noTex: "אין טקסטורה", texEdit: "✎ עריכה בעורך התמונות", texNew: "＋ טקסטורה חדשה", texRemove: "✕", texSent: "פותח את הטקסטורה בעורך התמונות…", texBack: "הטקסטורה חזרה מעורך התמונות", needMesh: "בחר חלק עם צורה", noUv: "לחלק הזה אין UV, אז אין קווים מנחים",
  splitH: "✂ חלוקה לחלקים…", sLoose: "לפי חלקים נפרדים", sMaterial: "לפי חומר", sAi: "לפי משמעות (AI)…", splitDone: (n) => `חולק ל-${n} חלקים`, splitNone: "החלק הזה הוא כבר חתיכה אחת",
  piece: "חתיכה",
  inGodot: "בסצנה הפתוחה ב-Godot (Ctrl+Z אחד; שומרים שם)", movedThere: "זזו גם ב-Godot, נשארו כמו שם",
  searchPh: "🔍 חיפוש…", lock: "נעל", unlock: "שחרר", aModel: "מודל", aPicture: "תמונה", aScript: "סקריפט", aScene: "סצנה", aPlaced: "הוצב",
  toUnreal: "שמור לרמה", standInUnreal: "תחליף של רמת Unreal: מזיזים, ואז \"שמור לרמה\"", standInUnrealKept: "הרמה כפי שנקראה לאחרונה (Unreal סגור): מזיזים, ואז \"שמור לרמה\"",
  readOnly: "ממשק וילדים של פריפאב: עורכים ב-Unity", readOnlyTile: "טיילמאפים: עורכים ב-Unity", inactiveB: "◌ כבויים", inactiveT: "הצג אובייקטים שכבויים ב-Unity", uiLayerB: "▣ ממשק", uiLayerT: "הצג או הסתר את שכבת הממשק (Canvas)",
  unrealMoved: "זז ב-Unreal", unrealSaved: "נשמר", unrealClash: "זזו גם ב-Unreal, נשארו כמו שם",
  pickFaces: "🎯 בחירה בלחיצה", angle: "זווית", separate: "הפרד", pickHint: "לחץ על המודל: הבחירה מתפשטת עד פינה חדה. Shift מוסיף.", picked: (n) => `נבחרו ${n} משולשים`, separated: "הבחירה הפכה לחלק משלה",
  texPromptPh: "✨ טקסטורה ממילים: עץ אלון ישן, קטיפה אדומה…", texAi: "✨", texMaking: "מודל התמונות מצייר טקסטורה… (במחשב)", texDone: "הטקסטורה החדשה על החלק", needWords: "כתוב איזו טקסטורה",
  partsInstalling: "מנוע החלקים עוד יורד; נסה שוב כשיסיים.", partsWorking: "מחלק לפי משמעות במחשב… (P3-SAM, יכול לקחת דקה)", partsReady: "מנוע החלקים מוכן: בחר חלק ו'לפי משמעות (AI)' שוב.", partsFailed: "ההתקנה של מנוע החלקים נעצרה", partsInstalling2: "מוריד את מנוע החלקים…",
  modsH: "מודיפיירים", addMod: "＋ הוספה…", mMirror: "מראה", mArray: "מערך", mSmooth: "הצללה חלקה", axis: "ציר", count: "כמות", gap: "רווח", on: "פעיל", up: "למעלה", remove: "הסר",
  kF: "מסגור החלק הנבחר", kHome: "כל המודל", kH: "הסתרת החלק", kAltH: "הצגת הכל", kW: "תיל (wireframe)", kUndo: "ביטול", tooBig: "המודל גדול מ-50MB",
  stopFollow: "הפסק", following: "עוקב אחרי", guestMark: "(אורח)", guestWait: "מחכה שהבעלים יפתח את הסצנה הזאת… תצטרף לבד כשהוא בפנים.", guestFull: "יש כבר שישה אורחים בסצנה. נסה שוב עוד מעט.", guestOnly: "אורחים רק מסתכלים ועוקבים: שום דבר לא זז מכאן.",
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
let isolated = null; // Isolate's memory: every object's visibility before it, or null (see isolate())
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
  camera.aspect = quad ? w / Math.max(1, h) : w / Math.max(1, h);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(host);
// ---------- four views (3ds Max's and Maya's default layout): Top, Front, Left and the perspective ----------
// The three flat views look at the same point as the perspective one and frame what is there; turning and picking
// stay in each view; a double-click on a view makes it the only one (Max's Alt+W), and the button brings the four back.
let quad = false;
const flat = { top: new THREE.OrthographicCamera(), front: new THREE.OrthographicCamera(), left: new THREE.OrthographicCamera() };
const QUADS = [["top", 0, 1], ["front", 1, 1], ["left", 0, 0], ["persp", 1, 0]]; // name, column, row (from the bottom)
function aimFlat() {
  const t = controls.target;
  const box = model ? new THREE.Box3().setFromObject(model) : null;
  const span = (box ? box.getSize(new THREE.Vector3()).length() : 2) * 0.65 || 1;
  const w = host.clientWidth / 2, h = host.clientHeight / 2, a = w / Math.max(1, h);
  for (const [k, cam] of Object.entries(flat)) {
    Object.assign(cam, { left: -span * a, right: span * a, top: span, bottom: -span, near: -span * 20, far: span * 20 });
    cam.position.copy(t).add(new THREE.Vector3(...{ top: [0, 1, 0], front: [0, 0, 1], left: [-1, 0, 0] }[k]).multiplyScalar(span * 4));
    if (k === "top") cam.up.set(0, 0, -1); else cam.up.set(0, 1, 0);
    cam.lookAt(t);
    cam.updateProjectionMatrix();
  }
}
/** Which view a point on the canvas is in, its camera, and the point in that view (−1…1). */
function viewAt(e) {
  const r = renderer.domElement.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  if (!quad) return { name: "persp", cam: camera, ndc: new THREE.Vector2(x * 2 - 1, -y * 2 + 1) };
  const col = x < 0.5 ? 0 : 1, row = y < 0.5 ? 1 : 0;
  const q = QUADS.find(([, c, rr]) => c === col && rr === row);
  const lx = (x - col * 0.5) * 2, ly = (y - (1 - row) * 0.5) * 2;
  return { name: q[0], cam: q[0] === "persp" ? camera : flat[q[0]], ndc: new THREE.Vector2(lx * 2 - 1, -ly * 2 + 1) };
}
/** A ray from a pointer event, through whichever view it is in. */
function rayAt(e) {
  const v = viewAt(e);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(v.ndc, v.cam);
  return ray;
}
function setQuad(on) {
  quad = on;
  $("quad").classList.toggle("on", quad);
  // The gizmo is drawn and dragged in the perspective view only; it hides while four views show (move by numbers).
  gizmo.enabled = !quad;
  gizmo.getHelper().visible = !quad && !!gizmo.object;
  resize();
}
(function loop() {
  controls.update();
  if (!quad) renderer.render(scene, camera);
  else {
    aimFlat();
    gizmo.getHelper().visible = false;
    const w = host.clientWidth / 2, h = host.clientHeight / 2;
    renderer.setScissorTest(true);
    for (const [k, col, row] of QUADS) {
      renderer.setViewport(col * w, row * h, w, h);
      renderer.setScissor(col * w, row * h, w, h);
      renderer.render(scene, k === "persp" ? camera : flat[k]);
    }
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, host.clientWidth, host.clientHeight);
  }
  requestAnimationFrame(loop);
})();

// ---------- open ----------
/**
 * The box around what is visible and drawn: hidden objects, invisible stand-in holders and anything under a scale of 0
 * (Unity's collapsed objects) are left out; when nothing is left, the whole object's box.
 */
function contentBox(obj) {
  const box = new THREE.Box3();
  obj.updateWorldMatrix(true, true);
  const walk = (o) => {
    if (!o.visible || o.scale.x === 0 || o.scale.y === 0 || o.scale.z === 0) return;
    if ((o.isMesh || o.isLine) && o.geometry && !(Array.isArray(o.material) ? false : o.material?.visible === false)) {
      // An instanced mesh (a Tilemap's cells): the box of all its instances.
      if (o.isInstancedMesh) { if (!o.boundingBox) o.computeBoundingBox(); box.union(o.boundingBox.clone().applyMatrix4(o.matrixWorld)); }
      else { if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld)); }
    }
    o.children.forEach(walk);
  };
  walk(obj);
  return box.isEmpty() ? new THREE.Box3().setFromObject(obj) : box;
}
function frame(obj, given) {
  const box = given ?? contentBox(obj);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3()).length() || 1, center = box.getCenter(new THREE.Vector3());
  controls.target.copy(center);
  // 2D: straight on, from far with a narrow lens, so it reads as flat (as the engines' 2D views).
  // The 2D grid sits under the scene (Godot's origin is a corner, not the middle), the 3D one at the origin.
  grid.position.set(flat2d ? Math.round(center.x) : 0, flat2d ? Math.round(center.y) : 0, flat2d ? -0.01 : 0);
  // 2D: the box fits the view (its width or its height, whichever is tighter), as an orthographic camera fits it.
  const s3 = box.getSize(new THREE.Vector3()), tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const dist = Math.max(s3.y / 2 / tan, s3.x / 2 / (tan * (camera.aspect || 1)), 0.05) * 1.1 + s3.z / 2;
  if (flat2d) camera.position.copy(center).add(new THREE.Vector3(0, 0, dist));
  else camera.position.copy(center).add(new THREE.Vector3(0.6, 0.45, 0.8).multiplyScalar(size * 1.2));
  camera.near = size / 200; camera.far = Math.max(size * 50, flat2d ? dist * 4 : 0); camera.updateProjectionMatrix();
}
// ---------- 2D and 3D (the engines' 2D view: flat, straight on, pan and zoom only) ----------
let flat2d = false;
function set2D(on) {
  flat2d = on;
  camera.fov = on ? 8 : 45;
  camera.up.set(0, 1, 0);
  controls.enableRotate = !on;
  // One finger / the left button pans in 2D (nothing to turn); the wheel and two fingers zoom.
  controls.mouseButtons.LEFT = on ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
  controls.touches.ONE = on ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE;
  grid.rotation.x = on ? Math.PI / 2 : 0;
  gizmo.showZ = !on;
  $("dim2").classList.toggle("on", on);
  $("dim3").classList.toggle("on", !on);
  if (model) frame(model);
  camera.updateProjectionMatrix();
}
/** Puts a GLB in the scene in place of the model there (from the chat, or back from Blender). */
async function load(bytes) {
  const gltf = await new Promise((resolve, reject) => new GLTFLoader().parse(bytes, "", resolve, reject));
  if (model) { choose(null); model.removeFromParent(); }
  model = gltf.scene; isolated = null; $("isolate").classList.remove("on");
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
}
// ---------- together (Unity Studio's real-time collaboration): who else has this scene open ----------
// Everyone with the same engine scene open on this KesherAI (this computer, the phone, other paired devices) sees each
// other's colour, camera (a cone with the name) and selection (outlined in their colour); a chip at the top follows
// that person's view. Moves still go back to the engine as before; this shows who is where.
const tab = Math.random().toString(36).slice(2, 12);
let together = null; // the beat's timer while a stand-in is open
let following = null; // the id of the person whose view this one follows
// A guest of a shared project ("read" or "edit", from editor.input): look and follow, and with "edit" select; never move
// or save. The host lets such a page reach only the scene, its models and the room (plugins.tsx guestCall).
let guestRole = null;
const others = new Map(); // id → { member, marker, boxes }
/** An object's id in its engine (Godot's node path, Unity's and Unreal's ids). */
const idOf = (o) => o?.userData.godot?.path ?? o?.userData.unity?.id ?? o?.userData.unreal?.id;
/** The object with this id in the scene. */
function byId(id) {
  let found = null;
  model?.traverse((o) => { if (!found && idOf(o) === id) found = o; });
  return found;
}
/** A person's camera: a cone in their colour pointing where they look, with their name above it. */
function cameraMarker(member) {
  const g = new THREE.Group();
  g.userData.generated = true;
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1, 4), new THREE.MeshBasicMaterial({ color: member.colour, wireframe: true }));
  cone.rotation.x = Math.PI / 2;
  g.add(cone);
  const c = document.createElement("canvas");
  c.width = 256; c.height = 64;
  const x = c.getContext("2d");
  x.fillStyle = member.colour; x.font = "bold 34px Heebo, Arial, sans-serif"; x.textAlign = "center"; x.textBaseline = "middle";
  x.fillText(member.name, 128, 32);
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
  label.scale.set(2, 0.5, 1);
  label.position.y = 0.9;
  g.add(label);
  scene.add(g);
  return g;
}
/** A person's name as shown: guests marked "(guest)". */
const nameOf = (member) => (member.guest ? `${member.name} ${T("guestMark", "(guest)")}` : member.name);
/** The chips at the top: one per person, in their colour (a guest ringed dashed); a click follows their view (again: stops). */
function drawPeople() {
  const box = $("people");
  box.hidden = !others.size;
  box.replaceChildren(...[...others.values()].map(({ member }) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `person${following === member.id ? " on" : ""}${member.guest ? " guest" : ""}`;
    b.style.background = member.colour;
    b.textContent = [...member.name][0] ?? "?";
    b.title = following === member.id ? T("unfollow", "Stop following") : `${T("follow", "Follow")}: ${nameOf(member)}`;
    b.setAttribute("aria-label", b.title);
    b.onclick = () => { following = following === member.id ? null : member.id; drawPeople(); };
    return b;
  }));
  // "Following X · Stop", in their colour.
  const f = following && others.get(following)?.member;
  $("followBar").hidden = !f;
  if (f) {
    $("followBar").style.setProperty("--follow", f.colour);
    $("followName").textContent = `${T("following", "Following")} ${nameOf(f)}`;
  }
}
$("followStop").onclick = () => { following = null; drawPeople(); };
async function beat() {
  if (document.hidden || !model) return;
  const chosenId = idOf(chosen) ?? (() => { for (let o = chosen; o; o = o.parent) if (idOf(o)) return idOf(o); return undefined; })();
  let r;
  try {
    r = await kesher.call("room.beat", { tab, camera: { p: camera.position.toArray(), t: controls.target.toArray(), fov: camera.fov }, selection: chosenId && guestRole !== "read" ? [chosenId] : [] });
  } catch { return; }
  // A guest: waiting for the owner, or the scene is full (the room is empty for them meanwhile).
  if (guestRole) {
    $("guestNote").hidden = !(r?.waiting || r?.full);
    $("guestNote").textContent = r?.full ? T("guestFull", "There are six guests in this scene already. Try again soon.") : T("guestWait", "Waiting for the owner to open this scene… you join by yourself when they are in.");
  }
  const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3()).length() || 1;
  const here = new Set();
  for (const m of r?.others ?? []) {
    here.add(m.id);
    let o = others.get(m.id);
    if (!o) { o = { member: m, marker: cameraMarker(m), boxes: [] }; others.set(m.id, o); }
    o.member = m;
    o.marker.visible = !!m.camera && following !== m.id;
    if (m.camera) {
      o.marker.position.fromArray(m.camera.p);
      o.marker.lookAt(new THREE.Vector3().fromArray(m.camera.t));
      o.marker.scale.setScalar(size * 0.04);
    }
    o.boxes.forEach((b) => b.removeFromParent());
    o.boxes = m.selection.map(byId).filter(Boolean).map((obj) => { const h = new THREE.BoxHelper(obj, m.colour); h.userData.generated = true; scene.add(h); return h; });
    if (following === m.id && m.camera) {
      camera.position.fromArray(m.camera.p);
      controls.target.fromArray(m.camera.t);
      if (Math.abs(camera.fov - m.camera.fov) > 0.5) { camera.fov = m.camera.fov; camera.updateProjectionMatrix(); }
    }
  }
  for (const [id, o] of others) if (!here.has(id)) { o.marker.removeFromParent(); o.boxes.forEach((b) => b.removeFromParent()); others.delete(id); if (following === id) following = null; }
  drawPeople();
}
/** Starts showing who else is here (called when a scene stand-in opens). */
function startTogether() {
  if (guestRole) msg(T("guestOnly", "Guests look and follow only: nothing moves from here."));
  clearInterval(together);
  together = setInterval(() => void beat(), 1000);
  void beat();
}
// Turning the view by hand stops following.
controls.addEventListener("start", () => { if (following) { following = null; drawPeople(); } });
addEventListener("pagehide", () => { if (together) void kesher.call("room.leave", { tab }).catch(() => undefined); });
// A guest whose tab is hidden leaves the room at once (no stale camera for the others; saves the phone's battery and
// data) and comes back with the next beat when it shows again.
document.addEventListener("visibilitychange", () => {
  if (!guestRole || !together) return;
  if (document.hidden) void kesher.call("room.leave", { tab }).catch(() => undefined);
  else void beat();
});
/** Guest mode: the tools that change, save or send anything go away (editor.css "body.guest"); the view stays. The
 *  guest page's own bar says "Guest" and the role. */
function enterGuest(role) {
  guestRole = role === "edit" ? "edit" : "read";
  document.body.classList.add("guest");
  $("editIn").hidden = true; // a guest cannot hand the shared model to another editor
}

// ---------- a Godot scene without Godot (SceneStandIn board): a stand-in of its nodes, moved here, saved back ----------
/** Godot writes a Transform3D's basis row by row, then the origin. */
const fromGodot = (b, o) => new THREE.Matrix4().set(b[0], b[1], b[2], o[0], b[3], b[4], b[5], o[1], b[6], b[7], b[8], o[2], 0, 0, 0, 1);
const toGodot = (m) => { const e = m.elements; return [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10], e[12], e[13], e[14]]; };
const PX = 64; // 2D: pixels per unit, so a 2D scene sits flat at a sensible size
/** Each node as something to see and move: a box (a light as a small sun, a camera as a cone), in Godot's tree. */
function loadStandIn(nodes) {
  if (model) { choose(null); model.removeFromParent(); }
  const root = new THREE.Group();
  root.name = nodes[0]?.name || "Scene";
  root.userData.godot = { path: "." };
  const byPath = new Map([[".", root]]);
  const mat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.7, transparent: true, opacity: 0.85 });
  for (const n of nodes.slice(1)) {
    const parent = byPath.get(n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : ".") ?? root;
    const t = n.type ?? (n.instance ? "instance" : "");
    // The real shape where the scene says it: Godot's own meshes at their sizes; a model file is loaded below; a node
    // with nothing to show (a group, a marker) is a small grey cube, so it can still be found and moved.
    const real = shapeGeo(n.shape);
    const geo = real ?? (/Light/.test(t) ? new THREE.SphereGeometry(0.12, 12, 8) : /Camera/.test(t) ? new THREE.ConeGeometry(0.15, 0.3, 12).rotateX(-Math.PI / 2) : n.model || n.scene || /MeshInstance/.test(t) ? new THREE.BoxGeometry(0.5, 0.5, 0.5) : new THREE.BoxGeometry(0.15, 0.15, 0.15));
    const o = new THREE.Mesh(geo, mat(real ? 0xc8ccd6 : /Light/.test(t) ? 0xffd25a : /Camera/.test(t) ? 0x6aa8ff : n.instance ? 0xb48cff : 0x8a8e99));
    o.name = n.name;
    if (n.transform) {
      fromGodot(n.transform.basis, n.transform.origin).decompose(o.position, o.quaternion, o.scale);
      o.userData.godot = { path: n.path, from: [...n.transform.basis, ...n.transform.origin] };
    } else if (n.position2d || /2D$|^Sprite|^Node2D|^Control/.test(t)) {
      const p2 = n.position2d ?? [0, 0];
      o.position.set(p2[0] / PX, -p2[1] / PX, 0);
      if (n.rotation2d) o.rotation.z = -n.rotation2d;
      if (n.scale2d) o.scale.set(n.scale2d[0], n.scale2d[1], 1);
      o.userData.godot = { path: n.path, from: p2, is2d: true, rot: n.rotation2d ?? 0, scl: n.scale2d ?? [1, 1] };
    } else o.userData.godot = { path: n.path };
    // Nodes of a scene placed in this one: shown for the shape, never saved (they belong to that other file).
    if (n.inner) o.userData.godot = { path: n.path, inner: true };
    // The outliner: its kind, and what is attached to it (Godot's Inspector: the node's type, its mesh or model, its
    // picture, its collision shape, its script, the scene it places).
    o.userData.icon = iconOf(t);
    o.userData.attached = [
      t && [iconOf(t), t, n.shape ? n.shape.kind : ""],
      n.model && ["🔷", n.model.split("/").pop(), T("aModel", "model")],
      n.texture && ["🖼", n.texture.split("/").pop(), T("aPicture", "picture")],
      n.collision && ["🧱", n.collision, ""],
      n.script && ["📜", n.script.split("/").pop(), T("aScript", "script")],
      n.scene && ["🎬", n.scene.split("/").pop(), T("aScene", "scene")],
    ].filter(Boolean);
    parent.add(o);
    byPath.set(n.path, o);
    if (n.model) void showModel(o, n.model);
    if (n.texture) void showSprite(o, n.texture, PX);
  }
  is2dScene = !nodes.some((n) => n.transform) && nodes.some((n) => n.position2d || /2D$/.test(n.type ?? ""));
  model = root; isolated = null; $("isolate").classList.remove("on");
  scene.add(model);
  meshes = [];
  rebuild();
  $("empty").hidden = true;
  // No chat here: the scene is where it goes back to.
  $("toGodot").hidden = false;
  $("toChat").hidden = true;
  msg(T("standIn", "A stand-in of the Godot scene: move things, then \"Save to the scene\" (with Godot closed)"));
}
/** An icon for a node / GameObject / actor by its kind, as the engines' outliners show one. */
function iconOf(kind = "") {
  return /Light/i.test(kind) ? "💡" : /Camera/i.test(kind) ? "🎥" : /Sprite|Texture/i.test(kind) ? "🖼" : /Collision|Collider|Shape/i.test(kind) ? "🧱" : /Audio|Sound/i.test(kind) ? "🔊" : /Player|Character/i.test(kind) ? "🧍" : /Anim/i.test(kind) ? "🎞" : /Script|MonoBehaviour|\.cs$|\.gd$/i.test(kind) ? "📜" : /TileMap|Tilemap|Grid/i.test(kind) ? "🗺" : /Blueprint/i.test(kind) ? "📘" : /Mesh|Model|instance/i.test(kind) ? "🔷" : /Rigid|Body/i.test(kind) ? "⚙" : /Canvas|Control|UI/i.test(kind) ? "🔲" : "▫";
}
let is2dScene = false;
/** A 2D sprite's picture, drawn on a flat plane at its size in pixels (centred, as Godot and Unity draw it). */
async function showSprite(o, path, pixelsPerUnit) {
  try {
    const bytes = await kesher.call("standin.asset", { path });
    const url = URL.createObjectURL(new Blob([bytes], { type: /\.svg$/i.test(path) ? "image/svg+xml" : "image/png" }));
    const tex = await new THREE.TextureLoader().loadAsync(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter; // pixel art stays sharp
    const w = tex.image.width / pixelsPerUnit, h = tex.image.height / pixelsPerUnit;
    const sprite = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide }));
    sprite.userData.generated = true;
    o.material = new THREE.MeshBasicMaterial({ visible: false });
    o.add(sprite);
  } catch (e) {
    msg(`${path}: ${e.message}`, true);
  }
}
/** Godot's built-in meshes as three.js shapes, at the same sizes (Godot's capsule height includes its two caps). */
function shapeGeo(s) {
  if (!s) return null;
  const [x = 1, y = 1, z = 1] = s.size ?? [];
  switch (s.kind) {
    case "box": return new THREE.BoxGeometry(x, y, z);
    case "sphere": return new THREE.SphereGeometry(s.radius, 24, 12).scale(1, (s.height ?? 2 * s.radius) / (2 * s.radius), 1);
    case "cylinder": return new THREE.CylinderGeometry(s.topRadius, s.bottomRadius, s.height, 24);
    case "capsule": return new THREE.CapsuleGeometry(s.radius, Math.max(0, s.height - 2 * s.radius), 6, 16);
    case "plane": return new THREE.PlaneGeometry(x, y).rotateX(-Math.PI / 2);
    case "prism": { const g = new THREE.CylinderGeometry(0, 0.5, 1, 3, 1).rotateY(Math.PI / 6); g.scale(x, y, z); return g; }
    case "torus": return new THREE.TorusGeometry((s.innerRadius + s.outerRadius) / 2, (s.outerRadius - s.innerRadius) / 2, 12, 32).rotateX(Math.PI / 2);
    default: return null;
  }
}
// The models the scene uses, loaded once each (a tree placed 40 times is read once) and kept light: a heavy one is
// simplified to about 50 000 triangles, which is enough to see where things are.
const MAX_TRIS = 50000;
const modelCache = new Map();
async function loadModel(path) {
  if (!modelCache.has(path)) {
    modelCache.set(path, (async () => {
      const bytes = await kesher.call("standin.asset", { path });
      // glTF / GLB (Godot, Unity with glTFast), FBX and OBJ (Unity's usual models).
      const shape = /\.fbx$/i.test(path) ? new FBXLoader().parse(bytes, "")
        : /\.obj$/i.test(path) ? new OBJLoader().parse(new TextDecoder().decode(bytes))
        : (await new Promise((resolve, reject) => new GLTFLoader().parse(bytes, "", resolve, reject))).scene;
      const all = [];
      shape.traverse((m) => { if (m.isMesh) all.push(m); });
      const total = all.reduce((a, m) => a + tris(m), 0);
      if (total > MAX_TRIS) {
        const keep = MAX_TRIS / total;
        for (const m of all) {
          const g = m.geometry.index ? m.geometry : mergeVertices(m.geometry);
          const remove = Math.floor(g.attributes.position.count * (1 - keep));
          if (remove > 0) m.geometry = new SimplifyModifier().modify(g, remove);
        }
      }
      // One quiet material, so the scene reads as shapes and stays quick (no textures to load).
      const look = new THREE.MeshStandardMaterial({ color: 0xc8ccd6, roughness: 0.8 });
      for (const m of all) {
        m.material = look;
        if (!m.geometry.attributes.normal) m.geometry.computeVertexNormals();
      }
      // An FBX in centimetres (most exporters): Unity shows it in metres, so does the stand-in.
      const size = new THREE.Box3().setFromObject(shape).getSize(new THREE.Vector3());
      if (/\.fbx$/i.test(path) && Math.max(size.x, size.y, size.z) > 30) shape.scale.multiplyScalar(0.01);
      return shape;
    })());
  }
  return modelCache.get(path);
}
async function showModel(o, path, turn = false) {
  try {
    const shape = (await loadModel(path)).clone(true);
    // Unity turns a model to its left-handed space (x mirrored) and the stand-in turns the scene back (z mirrored):
    // together, half a turn about the up axis.
    if (turn) shape.rotation.y = Math.PI;
    shape.traverse((c) => (c.userData.generated = true));
    shape.userData.generated = true;
    // The box was only standing in: the node keeps its place and takes the model's look.
    o.material = new THREE.MeshBasicMaterial({ visible: false });
    o.add(shape);
    stats();
  } catch (e) {
    msg(`${path}: ${e.message}`, true);
  }
}
/** The nodes that moved, as Godot wants them, with what they were (to see whether they moved in Godot too). */
function godotChanges() {
  const out = [];
  model?.traverse((o) => {
    const g = o.userData.godot;
    if (!g || g.path === "." || g.inner) return;
    o.updateMatrix();
    if (g.is2d) {
      const p = [Math.round(o.position.x * PX * 1000) / 1000, Math.round(-o.position.y * PX * 1000) / 1000];
      // Turned or resized in 2D too: Godot's rotation (radians, clockwise on screen) and scale.
      const rot = Math.round(-o.rotation.z * 1e6) / 1e6, scl = [Math.round(o.scale.x * 1e6) / 1e6, Math.round(o.scale.y * 1e6) / 1e6];
      const moved = Math.abs(p[0] - g.from[0]) > 1e-3 || Math.abs(p[1] - g.from[1]) > 1e-3;
      const turned = Math.abs(rot - g.rot) > 1e-5, resized = scl.some((x, i) => Math.abs(x - g.scl[i]) > 1e-5);
      if (moved || turned || resized) out.push({ path: g.path, from: g.from, position2d: p, ...(turned ? { rotation2d: rot } : {}), ...(resized ? { scale2d: scl } : {}) });
      return;
    }
    const now = toGodot(o.matrix).map((x) => Math.round(x * 1e6) / 1e6);
    const was = g.from ?? [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    if (now.some((x, i) => Math.abs(x - was[i]) > 1e-4)) out.push({ path: g.path, ...(g.from ? { from: g.from } : {}), transform: { basis: now.slice(0, 9), origin: now.slice(9) } });
  });
  return out;
}
$("toGodot").onclick = async () => {
  const changes = godotChanges();
  if (!changes.length) return msg(T("noMoves", "Nothing moved yet"));
  busy(T("savingScene", "Saving into the scene…"));
  try {
    let r = await kesher.call("godot.saveScene", { changes });
    if (r.code === "conflict" && confirm(`${T("clash", "These moved in Godot too:")} ${r.conflicts.join(", ")}. ${T("keepMine", "Keep your moves?")}`)) r = await kesher.call("godot.saveScene", { changes, keep: "mine" });
    if (r.ok) {
      // What is in the file now is the new "before".
      model.traverse((o) => { const g = o.userData.godot; if (!g || g.path === ".") return; if (g.is2d) { g.from = [o.position.x * PX, -o.position.y * PX]; g.rot = -o.rotation.z; g.scl = [o.scale.x, o.scale.y]; } else g.from = toGodot(o.matrix); });
      // Godot open: the moves went into its open scene (one Ctrl+Z there), and she saves them there.
      const where = r.inEditor ? T("inGodot", "In Godot's open scene (one Ctrl+Z; save it there)") : T("sceneSaved", "Saved into the scene");
      msg(`${where}: ${r.written}${r.missing?.length ? ` · ${T("notFound", "not found")}: ${r.missing.join(", ")}` : ""}${r.conflicts?.length ? ` · ${T("movedThere", "moved in Godot too, left as there")}: ${r.conflicts.join(", ")}` : ""}`, !!r.conflicts?.length);
    } else msg(r.error, true);
  } catch (e) { msg(e.message, true); } finally { busy(""); }
};
// ---------- a Unity scene without Unity: the same stand-in, Unity's left-handed space turned to ours and back ----------
// Unity: x right, y up, z forward (left-handed); here z points back: z and the quaternion's x and y change sign.
const fromUnity = (p, q) => ({ p: new THREE.Vector3(p[0], p[1], -p[2]), q: new THREE.Quaternion(-q[0], -q[1], q[2], q[3]) });
const toUnity = (o) => ({ position: [o.position.x, o.position.y, -o.position.z], rotation: [-o.quaternion.x, -o.quaternion.y, o.quaternion.z, o.quaternion.w], scale: [o.scale.x, o.scale.y, o.scale.z] });
// Off in Unity (m_IsActive 0): hidden unless "Inactive" is on (Unity's Scene view hides them too).
let showInactive = false;
/** The Unity stand-in's objects that are off in Unity, shown or hidden. */
function applyInactive() {
  model?.traverse((o) => { if (o.userData.inactive) o.visible = showInactive && !(o.userData.uiRoot && !showUi); });
  $("inactive").classList.toggle("on", showInactive);
  $("inactive").setAttribute("aria-pressed", String(showInactive));
  renderParts();
}
$("inactive").onclick = () => { showInactive = !showInactive; applyInactive(); };
// The UI layer (the scene's canvases) is on by default and can be hidden to see the game itself.
let showUi = true;
function applyUiLayer() {
  model?.traverse((o) => { if (o.userData.uiRoot) o.visible = showUi && !(o.userData.inactive && !showInactive); });
  $("uiLayer").classList.toggle("on", showUi);
  $("uiLayer").setAttribute("aria-pressed", String(showUi));
}
$("uiLayer").onclick = () => { showUi = !showUi; applyUiLayer(); };
/** Textures by picture, shared by every sprite and tile cut from it. */
const unityTextures = new Map();
function unityTexture(path) {
  if (!unityTextures.has(path)) {
    unityTextures.set(path, kesher.call("standin.asset", { path }).then(async (bytes) => {
      const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
      try {
        const tex = await new THREE.TextureLoader().loadAsync(url);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.magFilter = THREE.NearestFilter; // pixel art stays sharp
        return tex;
      } finally { URL.revokeObjectURL(url); }
    }));
  }
  return unityTextures.get(path);
}
/** A flat quad for one sprite of a picture: its rect's size in units around its pivot, its UVs on that rect. */
function spriteGeo(tex, s, size) {
  const W = tex.image.width, H = tex.image.height;
  const [x, y, w, h] = s.rect ?? [0, 0, W, H];
  const ppu = s.ppu || 100;
  const [sw, sh] = size ?? [w / ppu, h / ppu];
  const [px, py] = s.pivot ?? [0.5, 0.5];
  const g = new THREE.PlaneGeometry(sw, sh).translate((0.5 - px) * sw, (0.5 - py) * sh, 0);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (x + uv.getX(i) * w) / W, (y + uv.getY(i) * h) / H);
  return g;
}
/**
 * A SpriteRenderer: its sprite cut from the picture by the .meta's rect (a sheet's sprite), at its pixels per unit and
 * pivot (a sliced / tiled one at its drawn size), tinted, flipped, drawn in its sorting order.
 */
async function showUnitySprite(o, path, s) {
  try {
    const tex = await unityTexture(path);
    const m = new THREE.Mesh(spriteGeo(tex, s, s.size), new THREE.MeshBasicMaterial({ map: tex, color: unityColor(s.color), opacity: s.color?.[3] ?? 1, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    m.scale.set(s.flip?.[0] ? -1 : 1, s.flip?.[1] ? -1 : 1, 1);
    m.renderOrder = o.userData.sortRank ?? 1;
    m.userData.generated = true;
    o.material = new THREE.MeshBasicMaterial({ visible: false });
    o.add(m);
  } catch (e) {
    msg(`${path}: ${e.message}`, true);
  }
}
/** A Tilemap's cells: one instanced quad per sprite, each cell at its grid place (anchor in the cell), tinted. Read only. */
async function showTilemap(o, t) {
  o.material = new THREE.MeshBasicMaterial({ visible: false });
  const cells = new Map();
  for (let i = 0; i < t.tiles.length; i += 4) { const k = t.tiles[i + 2]; if (!cells.has(k)) cells.set(k, []); cells.get(k).push(i); }
  for (const [k, list] of cells) {
    const s = t.sprites[k];
    if (!s?.path) continue;
    try {
      const tex = await unityTexture(s.path);
      const im = new THREE.InstancedMesh(spriteGeo(tex, s), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide }), list.length);
      const at = new THREE.Matrix4();
      list.forEach((i, n) => {
        at.makeTranslation((t.tiles[i] + t.anchor[0]) * t.cell[0], (t.tiles[i + 1] + t.anchor[1]) * t.cell[1], 0);
        im.setMatrixAt(n, at);
        im.setColorAt(n, unityColor(t.colors[t.tiles[i + 3]] ?? [1, 1, 1]));
      });
      im.computeBoundingBox();
      im.computeBoundingSphere();
      im.renderOrder = o.userData.sortRank ?? 1;
      im.userData.generated = true;
      o.add(im);
    } catch (e) {
      msg(`${s.path}: ${e.message}`, true);
    }
  }
  stats();
}
/** A SpriteShape: its spline's outline (the filled shape is made by Unity). */
function shapeLine(sh) {
  const pts = sh.points.map(([x, y]) => new THREE.Vector3(x, y, 0));
  const line = new (sh.closed ? THREE.LineLoop : THREE.Line)(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x7ee08a }));
  line.userData.generated = true;
  return line;
}
/** Unity's colours are sRGB (0–1). */
const unityColor = ([r, g, b] = [1, 1, 1]) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
/**
 * A uGUI object (RectTransform): a flat rect of its size around its pivot, drawn in the Hierarchy's order over the
 * scene (as a Screen Space canvas draws). An Image shows its colour and sprite; a text is drawn on a canvas texture.
 */
function uiNode(u) {
  const [w, h] = u.ui.size, [px, py] = u.ui.pivot;
  const geo = new THREE.PlaneGeometry(Math.max(Math.abs(w), 1e-3), Math.max(Math.abs(h), 1e-3)).translate((0.5 - px) * w, (0.5 - py) * h, 0);
  const o = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: unityColor(u.ui.color), transparent: true, opacity: u.ui.color?.[3] ?? 1, side: THREE.DoubleSide, depthTest: false, depthWrite: false, visible: !!u.ui.color && !u.ui.image }));
  // UI draws over the 2D world (sprites and tilemaps take 1 … 99 999).
  o.renderOrder = 100000 + u.ui.order * 2;
  o.userData.uiOrder = o.renderOrder;
  if (u.ui.image) void showUiImage(o, u.ui.image);
  if (u.ui.text?.value.trim()) o.add(uiText(u.ui.text, w, h, px, py, o.renderOrder + 1));
  if (u.ui.canvas) o.userData.uiRoot = true;
  return o;
}
/** An Image's sprite (its whole picture; a 9-sliced one is stretched), tinted by its colour. */
async function showUiImage(o, path) {
  try {
    const bytes = await kesher.call("standin.asset", { path });
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    const tex = await new THREE.TextureLoader().loadAsync(url);
    URL.revokeObjectURL(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    o.material.map = tex;
    o.material.visible = true;
    o.material.needsUpdate = true;
  } catch (e) {
    msg(`${path}: ${e.message}`, true);
  }
}
/**
 * A TextMeshPro / Text label: its words wrapped in its rect's width at its font size (in the rect's own units, so a
 * 36 label in a 400 × 80 rect is 36 of 80 high, whatever the world's scale) and colour. Auto size takes the biggest size
 * between its minimum and maximum that fits the rect. Text taller than its rect overflows it as TMP does (from the top,
 * the middle or the bottom, by its alignment). Drawn on a canvas texture sharp for its size (at most 2048 px a side).
 */
function uiText(t, w, h, px, py, order) {
  const W = Math.max(Math.abs(w), 1e-3), H = Math.max(Math.abs(h), 1e-3);
  const k = Math.max(1e-3, Math.min(4, 2048 / Math.max(W, H), Math.sqrt(2e6 / (W * H))));
  const meas = document.createElement("canvas").getContext("2d");
  meas.direction = /[֐-׿؀-ۿ]/.test(t.value) ? "rtl" : "ltr";
  const lay = (size) => {
    meas.font = `${size * k}px system-ui, "Segoe UI", Arial, sans-serif`;
    const lines = [];
    for (const para of t.value.split("\n")) {
      let line = "";
      if (t.wrap === false) { lines.push(para); continue; }
      for (const word of para.split(/(\s+)/)) {
        const next = line + word;
        if (line.trim() && meas.measureText(next).width > W * k) { lines.push(line.trimEnd()); line = word.trimStart(); } else line = next;
      }
      lines.push(line);
    }
    return lines;
  };
  const fits = (size, lines) => lines.length * size * 1.2 <= H && lines.every((l) => meas.measureText(l).width <= W * k);
  let size = t.size, lines = lay(size);
  if (t.auto) {
    const lo = Math.max(t.min ?? 1e-3, 1e-3);
    size = Math.max(t.max ?? t.size, lo);
    lines = lay(size);
    while (size > lo && !fits(size, lines)) lines = lay((size = Math.max(lo, size * 0.92)));
  }
  const lh = size * 1.2, total = lines.length * lh, tall = Math.max(H, total);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.min(2048, Math.round(W * k))); c.height = Math.max(1, Math.min(2048, Math.round(tall * k)));
  const ctx = c.getContext("2d");
  ctx.direction = meas.direction;
  ctx.font = `${size * k}px system-ui, "Segoe UI", Arial, sans-serif`;
  // The text block's top inside the canvas: the canvas is as tall as the taller of the rect and the text.
  const top = t.valign === "top" ? 0 : t.valign === "bottom" ? tall - total : (tall - total) / 2;
  ctx.fillStyle = `rgba(${t.color.slice(0, 3).map((v) => Math.round(v * 255)).join(",")},${t.color[3] ?? 1})`;
  ctx.textBaseline = "middle";
  ctx.textAlign = t.align;
  const x = t.align === "center" ? c.width / 2 : t.align === "right" ? c.width : 0;
  lines.forEach((l, i) => ctx.fillText(l, x, (top + lh * (i + 0.5)) * k));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  // The plane's edge meets the rect's on the side the text hangs from.
  const rectTop = (1 - py) * H, rectBottom = -py * H;
  const midY = t.valign === "top" ? rectTop - tall / 2 : t.valign === "bottom" ? rectBottom + tall / 2 : (rectTop + rectBottom) / 2;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(W, tall).translate((0.5 - px) * W, midY, 0), new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
  m.renderOrder = order;
  m.userData.uiOrder = order;
  m.userData.generated = true;
  return m;
}
function loadUnityStandIn(objects, view, canvas) {
  if (model) { choose(null); model.removeFromParent(); }
  const root = new THREE.Group();
  root.name = "Scene";
  const byId = new Map();
  const mat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.7, transparent: true, opacity: 0.85 });
  // Unity's built-in meshes at their sizes (a cylinder and a capsule are 2 high, a plane 10 × 10, a quad faces you).
  const sorted = [];
  const builtin = { cube: () => new THREE.BoxGeometry(1, 1, 1), sphere: () => new THREE.SphereGeometry(0.5, 24, 12), cylinder: () => new THREE.CylinderGeometry(0.5, 0.5, 2, 24), capsule: () => new THREE.CapsuleGeometry(0.5, 1, 6, 16), plane: () => new THREE.PlaneGeometry(10, 10).rotateX(-Math.PI / 2), quad: () => new THREE.PlaneGeometry(1, 1) };
  for (const u of objects) {
    let o;
    if (u.ui) o = uiNode(u);
    else {
      const real = u.look?.builtin && builtin[u.look.builtin]?.();
      const geo = real ?? (u.model ? new THREE.BoxGeometry(0.5, 0.5, 0.5) : new THREE.BoxGeometry(0.15, 0.15, 0.15));
      o = new THREE.Mesh(geo, real ? new THREE.MeshStandardMaterial({ color: 0xc8ccd6, roughness: 0.8, side: u.look.builtin === "quad" || u.look.builtin === "plane" ? THREE.DoubleSide : THREE.FrontSide }) : mat(u.prefab ? 0xb48cff : /light/i.test(u.name) ? 0xffd25a : /camera/i.test(u.name) ? 0x6aa8ff : 0x8a8e99));
    }
    o.name = u.name;
    const { p, q } = fromUnity(u.position, u.rotation);
    o.position.copy(p); o.quaternion.copy(q); o.scale.set(...u.scale);
    o.userData.unity = { id: u.id, name: u.name, from: { position: u.position, rotation: u.rotation, scale: u.scale } };
    // UI (laid out by anchors) and a placed prefab's inner objects are not moved from here (their moves would be wrong).
    if (u.readOnly) o.userData.readOnly = u.readOnly;
    if (u.active === false) { o.userData.inactive = true; o.visible = showInactive; }
    byId.set(u.id, o);
    if (u.model) void showModel(o, u.model, true);
    if (u.sprite && u.spriteInfo) void showUnitySprite(o, u.sprite, u.spriteInfo);
    else if (u.sprite) void showSprite(o, u.sprite, 100);
    if (u.tilemap) void showTilemap(o, u.tilemap);
    if (u.shape) o.add(shapeLine(u.shape));
    if (u.spriteInfo || u.tilemap) sorted.push({ o, sort: u.tilemap?.sort ?? u.spriteInfo.sort, z: u.position[2] });
    // The outliner: Unity's Inspector, its components in order (a script by its file's name).
    o.userData.icon = iconOf(u.components?.find((c) => c !== "Transform" && c !== "MeshFilter" && c !== "MeshRenderer") ?? (u.model || u.look ? "Mesh" : ""));
    o.userData.attached = [["↔", u.ui ? "RectTransform" : "Transform", u.ui ? u.ui.size.map((v) => Math.round(v)).join(" × ") : ""], ...(u.components ?? []).map((c) => [iconOf(c), c, c === "MeshFilter" && u.look?.builtin ? u.look.builtin : ""]), ...(u.model ? [["🔷", u.model.split("/").pop(), u.prefab ? T("aPlaced", "placed") : ""]] : []), ...(u.ui?.text?.value ? [["🔤", u.ui.text.value.slice(0, 60), ""]] : [])];
  }
  // Parents after all are made (the file need not list a parent first).
  for (const u of objects) (byId.get(u.parent) ?? root).add(byId.get(u.id));
  // 2D draw order: sorting layer, then order in layer, then farther (Unity's larger z) first; not by depth.
  sorted.sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1] || b.z - a.z).forEach((s, i) => (s.o.userData.sortRank = 1 + i));
  // A 2D scene: sprites or UI, and no 3D meshes or models (the server says; older servers: the same rule here).
  is2dScene = view ? view === "2d" : objects.some((u) => u.ui || u.components?.includes("SpriteRenderer")) && !objects.some((u) => u.model || u.components?.includes("MeshFilter"));
  // A Screen Space canvas is its own panel at its pixel scale, fitted over the game's box (not in world units).
  if (canvas) {
    for (const u of objects) {
      const o = byId.get(u.id);
      if (u.ui?.canvas !== "screen" || o.parent !== root) continue;
      o.position.set(canvas.center[0], canvas.center[1], 0);
      o.scale.setScalar(canvas.scale);
    }
  }
  $("uiLayer").hidden = !objects.some((u) => u.ui?.canvas);
  showUi = true;
  $("uiLayer").classList.toggle("on", true);
  $("uiLayer").setAttribute("aria-pressed", "true");
  $("uiLayer").title = T("uiLayerT", "Show or hide the UI layer (canvases)");
  $("inactive").hidden = !objects.some((u) => u.active === false);
  $("inactive").classList.toggle("on", showInactive);
  $("inactive").title = T("inactiveT", "Show the objects that are off in Unity");
  model = root; isolated = null; $("isolate").classList.remove("on");
  scene.add(model);
  meshes = [];
  rebuild();
  $("empty").hidden = true;
  $("toGodot").hidden = false;
  $("toGodot").textContent = T("toUnity", "Save for Unity");
  $("toChat").hidden = true;
  $("toGodot").onclick = saveUnity;
  msg(T("standInUnity", "A stand-in of the Unity scene: move things, then \"Save for Unity\"; Unity takes them in when the scene is open"));
}
/** The box the server found around what is visible (Unity's space), in ours: the first view frames it. */
function unityBounds(b) {
  if (!b?.min || !b?.max) return null;
  return new THREE.Box3(new THREE.Vector3(b.min[0], b.min[1], -b.max[2]), new THREE.Vector3(b.max[0], b.max[1], -b.min[2]));
}
// ---------- an Unreal level without Unreal ----------
// Unreal: centimetres, Z up, left-handed; three.js: metres, Y up, right-handed. Swapping Y and Z does both turns, and
// is its own inverse (the same mapping goes back).
const fromUnreal = (p, q, s) => ({ p: new THREE.Vector3(p[0], p[2], p[1]).multiplyScalar(0.01), q: new THREE.Quaternion(-q[0], -q[2], -q[1], q[3]), s: new THREE.Vector3(s[0], s[2], s[1]) });
function toUnreal(o) {
  const p = o.position, q = o.quaternion, s = o.scale;
  return { position: [p.x * 100, p.z * 100, p.y * 100], rotation: [-q.x, -q.z, -q.y, q.w], scale: [s.x, s.z, s.y] };
}
const unrealMeshes = new Map();
/** A static mesh's shape (its lightest LOD, from the Bridge plugin), once per mesh; too heavy: its bounds as a box. */
function unrealMesh(path) {
  if (!unrealMeshes.has(path)) {
    unrealMeshes.set(path, kesher.call("standin.asset", { path }).then((r) => {
      if (r.corners) {
        const bin = atob(r.corners);
        const f = new Float32Array(bin.length / 4);
        const v = new DataView(new Uint8Array([...bin].map((c) => c.charCodeAt(0))).buffer);
        for (let i = 0; i < f.length; i++) f[i] = v.getFloat32(i * 4, true);
        // Each corner to three.js, and each triangle's winding turned (the swap mirrors).
        const out = new Float32Array(f.length);
        for (let t = 0; t < f.length; t += 9) {
          for (const [k, from] of [[0, 0], [1, 2], [2, 1]]) {
            out[t + k * 3] = f[t + from * 3] * 0.01;
            out[t + k * 3 + 1] = f[t + from * 3 + 2] * 0.01;
            out[t + k * 3 + 2] = f[t + from * 3 + 1] * 0.01;
          }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(out, 3));
        g.computeVertexNormals();
        return g;
      }
      const [a, b] = [fromUnreal(r.min, [0, 0, 0, 1], [1, 1, 1]).p, fromUnreal(r.max, [0, 0, 0, 1], [1, 1, 1]).p];
      const size = b.clone().sub(a);
      return new THREE.BoxGeometry(Math.abs(size.x), Math.abs(size.y), Math.abs(size.z)).translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    }));
  }
  return unrealMeshes.get(path);
}
function loadUnrealStandIn(u) {
  if (model) { choose(null); model.removeFromParent(); }
  const root = new THREE.Group();
  root.name = "Level";
  const byId = new Map();
  // Both sides: a mesh's winding is not always what the mirror makes of it, and a shape seen from inside still reads.
  const look = new THREE.MeshStandardMaterial({ color: 0xc8ccd6, roughness: 0.8, side: THREE.DoubleSide });
  for (const a of u.actors) {
    const marker = /Light/.test(a.class) ? 0xffd25a : /Camera|PlayerStart/.test(a.class) ? 0x6aa8ff : 0x8a8e99;
    const o = new THREE.Mesh(a.mesh ? new THREE.BoxGeometry(0.5, 0.5, 0.5) : new THREE.BoxGeometry(0.15, 0.15, 0.15), a.mesh ? new THREE.MeshBasicMaterial({ visible: false }) : new THREE.MeshStandardMaterial({ color: marker }));
    o.name = a.name || a.id;
    const t = fromUnreal(a.position, a.rotation, a.scale);
    o.position.copy(t.p); o.quaternion.copy(t.q); o.scale.copy(t.s);
    o.userData.unreal = { id: a.id, from: { position: a.position, rotation: a.rotation }, scale: a.scale };
    // The outliner: Unreal's Details, its components (and its Blueprint).
    o.userData.icon = iconOf(a.components?.find((c) => c.startsWith("Blueprint:")) ? "Blueprint" : a.class);
    o.userData.attached = (a.components ?? []).map((c) => (c.startsWith("Blueprint:") ? ["📘", c.slice(10), "Blueprint"] : [iconOf(c), c, c === "StaticMeshComponent" && a.mesh ? a.mesh.split("/").pop().split(".")[0] : ""]));
    byId.set(a.id, o);
    if (a.mesh) {
      void unrealMesh(a.mesh).then((g) => {
        const m = new THREE.Mesh(g, look);
        m.userData.generated = true;
        if (a.meshAt) { const at = fromUnreal(a.meshAt.position, a.meshAt.rotation, a.meshAt.scale); m.position.copy(at.p); m.quaternion.copy(at.q); m.scale.copy(at.s); }
        o.add(m);
        stats();
      }, (e) => msg(`${a.mesh}: ${e.message}`, true));
    }
  }
  // The Outliner's folders (not saved: only a way to find things), then each actor under its parent or its folder.
  const folders = new Map();
  const folder = (path) => {
    if (!path) return root;
    if (!folders.has(path)) {
      const g = new THREE.Group();
      g.name = path.split("/").pop();
      g.userData.icon = "📁";
      folders.set(path, g);
      folder(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "").add(g);
    }
    return folders.get(path);
  };
  for (const a of u.actors) (byId.get(a.parent) ?? folder(a.folder)).add(byId.get(a.id));
  is2dScene = u.actors.some((a) => /^Paper/.test(a.class)) && !u.actors.some((a) => a.mesh && !/^Paper/.test(a.class));
  model = root; isolated = null; $("isolate").classList.remove("on");
  scene.add(model);
  rebuild();
  $("empty").hidden = true;
  $("toGodot").hidden = false;
  $("toGodot").textContent = T("toUnreal", "Save to the level");
  $("toChat").hidden = true;
  $("toGodot").onclick = saveUnreal;
  msg(u.cached ? T("standInUnrealKept", "The level as last read (Unreal is closed): move things, then \"Save to the level\"") : T("standInUnreal", "A stand-in of the Unreal level: move things, then \"Save to the level\""));
}
async function saveUnreal() {
  const moves = [];
  model?.traverse((o) => {
    const u = o.userData.unreal;
    if (!u) return;
    const to = toUnreal(o);
    const moved = to.position.some((x, i) => Math.abs(x - u.from.position[i]) > 0.05) || new THREE.Quaternion(...to.rotation).angleTo(new THREE.Quaternion(...u.from.rotation)) > 2e-3 || to.scale.some((x, i) => Math.abs(x - u.scale[i]) > 1e-4);
    if (moved) moves.push({ id: u.id, from: u.from, to });
  });
  if (!moves.length) return msg(T("noMoves", "Nothing moved yet"));
  busy(T("savingScene", "Saving into the scene…"));
  try {
    const r = await kesher.call("unreal.saveLevel", { moves });
    model.traverse((o) => { if (o.userData.unreal) { const t = toUnreal(o); o.userData.unreal.from = { position: t.position, rotation: t.rotation }; o.userData.unreal.scale = t.scale; } });
    msg(`${T("unrealMoved", "Moved in Unreal")}: ${r.moved}${r.saved ? ` · ${T("unrealSaved", "saved")}` : ""}${r.clashes?.length ? ` · ${T("unrealClash", "moved in Unreal too, left as they are")}: ${r.clashes.join(", ")}` : ""}`, !!r.clashes?.length);
  } catch (e) { msg(e.message, true); } finally { busy(""); }
}
async function saveUnity() {
  const moves = [];
  model?.traverse((o) => {
    const u = o.userData.unity;
    // UI and a prefab's inner objects are never queued (their YAML is not a plain Transform move).
    if (!u || o.userData.readOnly) return;
    const to = toUnity(o);
    const moved = to.position.some((x, i) => Math.abs(x - u.from.position[i]) > 1e-4) || to.scale.some((x, i) => Math.abs(x - u.from.scale[i]) > 1e-4) || new THREE.Quaternion(...to.rotation).angleTo(new THREE.Quaternion(...u.from.rotation)) > 2e-3;
    if (moved) moves.push({ id: u.id, name: u.name, from: u.from, to });
  });
  if (!moves.length) return msg(T("noMoves", "Nothing moved yet"));
  busy(T("savingScene", "Saving into the scene…"));
  try {
    const r = await kesher.call("unity.saveScene", { moves });
    model.traverse((o) => { if (o.userData.unity) o.userData.unity.from = toUnity(o); });
    msg(`${T("unityQueued", "Waiting for Unity")}: ${r.queued} · ${T("unityHow", "Unity takes them in when the scene is open (one Ctrl+Z)")}`);
  } catch (e) { msg(e.message, true); } finally { busy(""); }
}
async function open() {
  busy(T("loading", "Loading the model…"));
  try {
    const input = await kesher.call("editor.input");
    if (input?.guest) enterGuest(input.guest.role);
    if (input?.unity) {
      name = input.name; $("name").textContent = name;
      loadUnityStandIn(input.unity.objects, input.unity.view, input.unity.canvas);
      set2D(is2dScene);
      // The first view frames what is visible (the server's box: inactive and scale-0 objects left out).
      const box = unityBounds(input.unity.bounds);
      if (box) frame(model, box);
      $("dims").hidden = false; stats(); startTogether(); return;
    }
    if (input?.unreal) { name = input.name; $("name").textContent = name; loadUnrealStandIn(input.unreal); set2D(is2dScene); $("dims").hidden = false; stats(); startTogether(); return; }
    if (input?.godot) { name = input.name; $("name").textContent = name; loadStandIn(input.godot.nodes); set2D(is2dScene); $("dims").hidden = false; stats(); startTogether(); return; }
    if (!input?.bytes) return;
    name = input.name;
    $("name").textContent = name;
    await load(input.bytes);
    // Back from the image editor: the new texture into the slot it was made for.
    const back = /^(\d+):(map|roughnessMap|normalMap)$/.exec(input.back?.data ? input.back.slot : "");
    if (back) {
      const mesh = meshes.filter((p) => !isGenerated(p.mesh))[Number(back[1])]?.mesh;
      $("texKind").value = back[2];
      if (mesh) { await setTexture(mesh, input.back.data, back[2]); msg(T("texBack", "The texture came back from the image editor")); setTimeout(() => choose(mesh), 0); }
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
const shown = (o) => (o.children.length === 1 && !o.isMesh && o.children[0].isMesh && !o.children[0].children.length && !o.children[0].userData.generated ? o.children[0] : o);
function renderParts() {
  nodes = [];
  // The outliner's search: what matches, with the way down to it (as the engines' Hierarchy search shows it).
  const q = ($("partSearch")?.value ?? "").trim().toLowerCase();
  const hit = (o) => !q || label(o).toLowerCase().includes(q) || (o.userData.attached ?? []).some((a) => String(a[1]).toLowerCase().includes(q)) || o.children.some((c) => !c.userData.generated && hit(shown(c)));
  const walk = (o, depth) => { for (const c of o.children) { if (c.userData.generated) continue; const s2 = shown(c); if (!hit(s2)) continue; nodes.push({ obj: s2, depth }); if (!folded.has(s2.uuid) || q) walk(s2, depth + 1); } };
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
    n.className = "nm";
    n.textContent = `${kids && !obj.isMesh ? `${label(obj)} (${kids})` : label(obj)}${obj.userData.mods?.some((m) => m.on) ? " ⚙" : ""}`;
    const ic = document.createElement("span");
    ic.className = "ic";
    ic.textContent = obj.userData.icon ?? "";
    // The lock (Unity's and Unreal's): a locked object is not chosen by a click in the view, nor moved.
    const lock = document.createElement("button");
    lock.textContent = obj.userData.locked ? "🔒" : "🔓";
    lock.title = obj.userData.locked ? T("unlock", "Unlock") : T("lock", "Lock");
    lock.onclick = (e) => { e.stopPropagation(); obj.userData.locked = !obj.userData.locked; if (obj.userData.locked && chosen === obj) gizmo.detach(); renderParts(); };
    // UI and a prefab's inner objects: a fixed lock (they are edited in Unity).
    const ro = document.createElement("span");
    ro.className = "ro";
    ro.textContent = "🔒";
    ro.title = obj.userData.readOnly === "tilemap" ? T("readOnlyTile", "Tilemaps: edit in Unity") : T("readOnly", "UI and prefab children: edit in Unity");
    ro.setAttribute("aria-label", ro.title);
    li.append(tw, ic, n, eye, ...(obj.userData.readOnly ? [ro] : obj.userData.icon !== undefined ? [lock] : []));
    li.onclick = () => choose(obj);
    // A double-click frames it (Blender's and Unity's outliner).
    li.ondblclick = () => { choose(obj); frame(obj); };
    if (obj !== chosen || !obj.userData.attached?.length) return [li];
    // What is attached to the chosen one, under it (the Inspector's components, read only here).
    const att = document.createElement("li");
    att.className = "attached";
    att.style.marginInlineStart = `${20 + depth * 14}px`;
    att.replaceChildren(...obj.userData.attached.map(([i, a, d]) => { const r = document.createElement("div"); r.dir = "ltr"; r.textContent = `${i} ${a}${d ? ` · ${d}` : ""}`; return r; }));
    return [li, att];
  }).flat());
}
let glow = null;
function choose(obj) {
  chosen = obj ?? null;
  $("taskbar").hidden = !chosen;
  glow?.removeFromParent(); glow = null;
  gizmo.detach();
  renderParts();
  $("partName").textContent = chosen ? label(chosen) : T("noPart", "Choose a part");
  if (!chosen) { document.querySelectorAll("[data-ch]").forEach((inp) => (inp.value = "")); $("size").textContent = ""; renderMods(); return; }
  // The chosen object is outlined by a box (Blender's orange outline, simply) and gets the gizmo.
  glow = new THREE.BoxHelper(chosen, 0xffa040);
  scene.add(glow);
  if (!chosen.userData.locked && !chosen.userData.readOnly && !guestRole) gizmo.attach(chosen);
  if (chosen.userData.readOnly) msg(chosen.userData.readOnly === "tilemap" ? T("readOnlyTile", "Tilemaps: edit in Unity") : T("readOnly", "UI and prefab children: edit in Unity"));
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
    if (!chosen || chosen.userData.readOnly) return showChannels();
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
  const ray = rayAt(e);
  const hits = ray.intersectObjects(meshes.filter((p) => p.mesh.visible && (!picking || !isGenerated(p.mesh))).map((p) => p.mesh), false);
  // UI draws over the scene in its own order: the topmost drawn UI rect under the pointer wins.
  const ui = hits.filter((h) => h.object.userData.uiOrder !== undefined && h.object.material?.visible !== false);
  const hit = picking || !ui.length ? hits[0] : ui.reduce((a, b) => (b.object.userData.uiOrder > a.object.userData.uiOrder ? b : a));
  if (picking) { if (hit && hit.faceIndex !== undefined) pickAt(hit.object, hit.faceIndex, e.shiftKey); else { picked = null; showPicked(); } return; }
  let o = hit?.object ?? null;
  while (o && o.parent && (o.userData.generated || o.parent.userData.generated)) o = o.parent;
  if (o?.name === "⚙ modifiers") o = o.parent;
  // A locked object (the outliner's lock) is passed through: what is behind it can be chosen.
  for (let x = o; x; x = x.parent) if (x.userData.locked) return;
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
$("quad").onclick = () => setQuad(!quad);
$("dim2").onclick = () => set2D(true);
$("dim3").onclick = () => set2D(false);
$("partSearch").oninput = () => renderParts();
// Escape clears the search (as the engines' Hierarchy search does).
$("partSearch").addEventListener("keydown", (e) => { if (e.key === "Escape" && $("partSearch").value) { e.stopPropagation(); $("partSearch").value = ""; renderParts(); } });
// A double-click on one of the four views: that view alone (Max's Alt+W).
renderer.domElement.addEventListener("dblclick", (e) => {
  if (!quad) return;
  const v = viewAt(e).name;
  setQuad(false);
  view(v === "left" ? "right" : v);
  if (v === "left") camera.position.x = 2 * controls.target.x - camera.position.x;
});
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

// ---------- textures: glTF's PBR slots (colour, roughness, normal), each edited in the image editor (a hand-off with the way back) ----------
/** The slots, as glTF and Blender's Principled BSDF: colour is sRGB; roughness and normal are data (linear). */
const kind = () => $("texKind").value;
/** The mesh a texture belongs to: the chosen one, or the first mesh in the chosen group. */
const meshOfChosen = () => (chosen?.isMesh ? chosen : chosen?.getObjectByProperty("isMesh", true)) ?? null;
/** A stable name for a mesh's slot across saving and opening again: its place among the file's meshes, and the slot. */
const slotOf = (mesh, k = kind()) => `${meshes.filter((p) => !isGenerated(p.mesh)).findIndex((p) => p.mesh === mesh)}:${k}`;
/** An empty slot's starting picture: the part's colour; middle roughness (or the part's); a flat normal (pointing out). */
function blankFill(mesh, k) {
  const m = matOf(mesh);
  if (k === "roughnessMap") { const v = Math.round((m?.roughness ?? 0.5) * 255); return `rgb(${v},${v},${v})`; }
  if (k === "normalMap") return "rgb(128,128,255)";
  return `#${(m?.color ?? new THREE.Color(0xcccccc)).getHexString()}`;
}
function texCanvas(mesh, size, k = kind(), fresh = false) {
  const c = document.createElement("canvas");
  const img = fresh ? null : matOf(mesh)?.[k]?.image;
  // A tiny texture (a 2×2 colour from an exporter) grows to the asked size, so it can be painted and edited.
  const k2 = img && img.width < size ? size / img.width : 1;
  c.width = img ? Math.round(img.width * k2) : size;
  c.height = img ? Math.round(img.height * k2) : size;
  const g = c.getContext("2d");
  if (img) g.drawImage(img, 0, 0, c.width, c.height);
  else { g.fillStyle = blankFill(mesh, k); g.fillRect(0, 0, c.width, c.height); }
  return c;
}
/**
 * UVs for a part that has none, so it can be textured and painted (Blender's Cube Projection, simply): each triangle is
 * laid flat on the side of the box it faces most, and the six sides sit side by side in a 3×2 grid, so none overlap.
 * The shape is unchanged; only its corners are split where sides meet.
 *
 * @param mesh - A mesh without UVs.
 * @returns Whether UVs were made.
 */
function ensureUV(mesh) {
  if (mesh.geometry.attributes.uv) return false;
  const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
  g.computeBoundingBox();
  const b = g.boundingBox, size = b.getSize(new THREE.Vector3()), span = Math.max(size.x, size.y, size.z) || 1;
  const pos = g.attributes.position, uv = new Float32Array(pos.count * 2);
  const a = new THREE.Vector3(), c = new THREE.Vector3(), d = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i + 2 < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i); c.fromBufferAttribute(pos, i + 1); d.fromBufferAttribute(pos, i + 2);
    n.subVectors(c, a).cross(d.clone().sub(a));
    const ax = Math.abs(n.x) >= Math.abs(n.y) && Math.abs(n.x) >= Math.abs(n.z) ? 0 : Math.abs(n.y) >= Math.abs(n.z) ? 1 : 2;
    const side = ax * 2 + ((ax === 0 ? n.x : ax === 1 ? n.y : n.z) < 0 ? 1 : 0);
    const cx = (side % 3) / 3, cy = Math.floor(side / 3) / 2;
    for (let k = 0; k < 3; k++) {
      const v = [a, c, d][k];
      const [p, q] = ax === 0 ? [v.z - b.min.z, v.y - b.min.y] : ax === 1 ? [v.x - b.min.x, v.z - b.min.z] : [v.x - b.min.x, v.y - b.min.y];
      // A small margin inside each cell, so the brush and filtering do not bleed into the next side.
      uv[(i + k) * 2] = cx + (0.02 + 0.96 * (p / span)) / 3;
      uv[(i + k) * 2 + 1] = cy + (0.02 + 0.96 * (1 - q / span)) / 2;
    }
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  mesh.geometry = g;
  msg(T("madeUv", "This part had no UVs: made them (box projection)"));
  return true;
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
  const map = mesh && matOf(mesh)?.[kind()];
  $("texThumb").hidden = !map;
  if (map?.image) { const c = texCanvas(mesh, 128); $("texThumb").src = c.toDataURL("image/png"); $("texInfo").textContent = `${map.image.width}×${map.image.height}`; }
  else $("texInfo").textContent = T("noTex", "No texture");
  $("texRemove").disabled = !map;
  // Roughness and normal can be made from the colour texture (Materialize's and Substance's "from base colour").
  $("texDerive").hidden = kind() === "map";
}
$("texKind").onchange = showTexture;
/** "Edit in…" (editor-handoff.ts): the chosen part's texture goes to the picture editor (installed first when missing). */
$("editIn").onclick = () => openMenu($("editIn"), T("editInT", "Opens the other editor; \"Return to…\" there brings you back"), [
  { icon: "🖌", label: T("editTex", "Edit texture in the picture editor"), hint: T("editTexHint", "the chosen part, comes back to its material"), run: () => void editTexture(false) },
]);
async function editTexture(fresh) {
  const mesh = meshOfChosen();
  if (!mesh) return msg(T("needMesh", "Choose a part with a shape"), true);
  const k = kind();
  ensureUV(mesh);
  const tex = texCanvas(mesh, 1024, k, fresh);
  const guide = uvGuide(mesh, tex.width, tex.height);
  if (!guide) msg(T("noUv", "This part has no UVs, so there are no guide lines"));
  busy(T("texSent", "Opening the texture in the image editor…"));
  try {
    const working = await new Promise((resolve) => glb().then((b) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(b); }));
    const part = (label(mesh) || "part").replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 40);
    const suffix = { map: "texture", roughnessMap: "roughness", normalMap: "normal" }[k];
    await kesher.call("editor.handoff", { to: "image-editor", data: tex.toDataURL("image/png"), name: `${part}-${suffix}.png`, slot: slotOf(mesh, k), ...(guide ? { guide: guide.toDataURL("image/png"), guideName: `${part}-uv.png` } : {}), working, workingName: `${base().replace(/-edited$/, "")}-working.glb` });
  } catch (e) { msg(e.message, true); } finally { busy(""); }
}
/**
 * A picture into one of the mesh's slots, glTF's way: not flipped; colour in sRGB (and the colour set to white so it shows
 * true); roughness and normal as data. A roughness map multiplies the roughness value, so that goes to 1.
 */
async function setTexture(mesh, dataUrl, k = "map") {
  const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = dataUrl; });
  const t = new THREE.Texture(img);
  t.flipY = false;
  t.colorSpace = k === "map" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  [].concat(mesh.material).forEach((m) => {
    m[k] = t;
    if (k === "map") m.color?.set(0xffffff);
    if (k === "roughnessMap" && "roughness" in m) m.roughness = 1;
    m.needsUpdate = true;
  });
}
/**
 * Roughness or normal from a colour picture (as Materialize and Substance's "from base colour"): its brightness read as
 * height. Roughness: darker (cracks, grain) is rougher. Normal: the slope of the height (Sobel), as an OpenGL normal map.
 *
 * @param img - The colour texture.
 * @param k - "roughnessMap" or "normalMap".
 * @returns The new picture.
 */
function derive(img, k) {
  const w = img.width, h = img.height;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0, w, h);
  const src = g.getImageData(0, 0, w, h), d = src.data;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
  const out = g.createImageData(w, h), o = out.data;
  if (k === "roughnessMap") {
    // Spread to 0.35–0.95, so it never turns into a mirror or into chalk.
    for (let i = 0; i < w * h; i++) { const v = Math.round((0.95 - lum[i] * 0.6) * 255); o[i * 4] = o[i * 4 + 1] = o[i * 4 + 2] = v; o[i * 4 + 3] = 255; }
  } else {
    // Wraps at the edges, so a seamless colour gives a seamless normal.
    const at = (x, y) => lum[((y + h) % h) * w + ((x + w) % w)];
    const strength = 2;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -dx * strength, ny = dy * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const i = (y * w + x) * 4;
      o[i] = Math.round((nx * 0.5 + 0.5) * 255); o[i + 1] = Math.round((ny * 0.5 + 0.5) * 255); o[i + 2] = Math.round((nz * 0.5 + 0.5) * 255); o[i + 3] = 255;
    }
  }
  g.putImageData(out, 0, 0);
  return c;
}
$("texDerive").onclick = async () => {
  const mesh = meshOfChosen();
  if (!mesh) return msg(T("needMesh", "Choose a part with a shape"), true);
  const img = matOf(mesh)?.map?.image;
  if (!img) return msg(T("noColorTex", "This part has no colour texture to make it from"), true);
  remember();
  await setTexture(mesh, derive(img, kind()).toDataURL("image/png"), kind());
  showTexture();
  msg(T("derived", "Made from the colour texture"));
};
// A texture from words with the picture model on the computer (Meshy's and Tripo's "retexture", simply): seamless,
// so it repeats over the part without seams. For roughness and normal: a colour texture first, then made from it.
$("texAi").onclick = async () => {
  const mesh = meshOfChosen();
  const words = $("texPrompt").value.trim();
  if (!mesh) return msg(T("needMesh", "Choose a part with a shape"), true);
  if (!words) return msg(T("needWords", "Write which texture"), true);
  busy(T("texMaking", "The picture model is painting a texture… (on your computer)"));
  try {
    const [url] = await kesher.call("image.generate", { prompt: `${words}, seamless tileable texture, flat even lighting, top-down, no shadows, high detail`, width: 1024, height: 1024 });
    remember();
    const k = kind();
    if (k === "map") await setTexture(mesh, url);
    else {
      const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
      await setTexture(mesh, derive(img, k).toDataURL("image/png"), k);
    }
    showTexture();
    msg(T("texDone", "The new texture is on the part"));
  } catch (e) { msg(e.message, true); } finally { busy(""); }
};
// Painting on the model (Blender's Texture Paint, Substance Painter's brush, simply): the brush draws into the chosen
// slot's texture where it touches the surface, through the surface's UVs. Each stroke starts on a new copy of the
// texture, so undo brings back the one before.
let painting = false, stroke = null;
function paintRay(e) {
  const ray = rayAt(e);
  return ray.intersectObjects(meshes.filter((p) => p.mesh.visible && !isGenerated(p.mesh)).map((p) => p.mesh), false)[0];
}
function startStroke(mesh) {
  ensureUV(mesh);
  remember();
  const k = kind();
  const c = texCanvas(mesh, 1024, k);
  const t = new THREE.CanvasTexture(c);
  t.flipY = false;
  t.colorSpace = k === "map" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  [].concat(mesh.material).forEach((m) => {
    if (k === "map" && !m.map) m.color?.set(0xffffff);
    if (k === "roughnessMap" && !m.roughnessMap && "roughness" in m) m.roughness = 1;
    m[k] = t;
    m.needsUpdate = true;
  });
  return { mesh, t, g: c.getContext("2d"), w: c.width, h: c.height, last: null };
}
/** The brush's colour for the slot: the colour as is; for roughness its brightness (light = rough); for normal, flat. */
function brushColour() {
  const hex = $("paintColor").value;
  if (kind() === "map") return hex;
  if (kind() === "normalMap") return "rgb(128,128,255)";
  const n = parseInt(hex.slice(1), 16), v = Math.round(0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255));
  return `rgb(${v},${v},${v})`;
}
function dab(hit) {
  if (!stroke || hit?.object !== stroke.mesh || !hit.uv) { if (stroke) stroke.last = null; return; }
  const u = ((hit.uv.x % 1) + 1) % 1, v = ((hit.uv.y % 1) + 1) % 1;
  const x = u * stroke.w, y = v * stroke.h, size = (+$("paintSize").value / 100) * stroke.w * 0.08;
  const g = stroke.g;
  g.fillStyle = g.strokeStyle = brushColour();
  g.lineCap = "round";
  g.lineWidth = size * 2;
  // Joined to the last dab when it is near (not across a UV seam), so a quick stroke has no gaps.
  if (stroke.last && Math.hypot(x - stroke.last[0], y - stroke.last[1]) < stroke.w * 0.1) { g.beginPath(); g.moveTo(...stroke.last); g.lineTo(x, y); g.stroke(); }
  g.beginPath(); g.arc(x, y, size, 0, Math.PI * 2); g.fill();
  stroke.last = [x, y];
  stroke.t.needsUpdate = true;
}
// Before the view's own handlers (capture), so a stroke on the model does not also turn the view.
renderer.domElement.addEventListener("pointerdown", (e) => {
  if (!painting || !model) return;
  const hit = paintRay(e);
  if (!hit) return;
  e.stopImmediatePropagation();
  stroke = startStroke(hit.object);
  if (!stroke) return;
  renderer.domElement.setPointerCapture(e.pointerId);
  dab(hit);
}, { capture: true });
renderer.domElement.addEventListener("pointermove", (e) => { if (painting && stroke) { e.stopImmediatePropagation(); dab(paintRay(e)); } }, { capture: true });
const endStroke = () => { if (!stroke) return; stroke = null; showTexture(); };
renderer.domElement.addEventListener("pointerup", (e) => { if (painting && stroke) { e.stopImmediatePropagation(); endStroke(); } }, { capture: true });
renderer.domElement.addEventListener("pointercancel", endStroke);
$("paint").onclick = () => {
  painting = !painting;
  $("paint").classList.toggle("on", painting);
  $("paintTools").hidden = !painting;
  if (painting && picking) $("pickFaces").click();
  if (painting) msg(T("paintHint", "Paint on the model; drag off it to turn the view"));
};
$("texEdit").onclick = () => editTexture(false);
$("texNew").onclick = () => editTexture(true);
$("texRemove").onclick = () => {
  const mesh = meshOfChosen();
  if (!mesh) return;
  remember();
  const k = kind();
  [].concat(mesh.material).forEach((m) => { m[k] = null; if (k === "roughnessMap" && "roughness" in m) m.roughness = 0.5; m.needsUpdate = true; });
  showTexture();
};

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
    $("busyStop").hidden = false;
    const faces = await kesher.call("model.parts.segment", { data }).finally(() => ($("busyStop").hidden = true));
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
// ---------- the part's task bar: words → the editor's own tools ----------
/** The words' plan, from the chat model, else from simple rules (colour words, shiny / matte, split, wood…). */
async function planOf(words) {
  const ask = [
    { role: "system", content: 'You turn a request about one part of a 3D model into JSON only, no other text: {"color":"#rrggbb" or null,"roughness":0..1 or null,"metalness":0..1 or null,"texture":"a short English description of a seamless material texture" or null,"split":"meaning"|"loose"|null,"hide":true|false,"duplicate":true|false}. Shiny/glossy: roughness 0.15; matte: 0.9; metal/chrome/gold: metalness 1. A material (wood, marble, fabric, rust…) is a texture. The request may be in Hebrew.' },
    { role: "user", content: words },
  ];
  try {
    const text = await kesher.call("chat", { messages: ask, temperature: 0 });
    const j = JSON.parse(String(text).replace(/^[^{]*/, "").replace(/[^}]*$/, ""));
    if (j && typeof j === "object") return j;
  } catch { /* no chat model, or it did not answer JSON: the rules below */ }
  const w = words.toLowerCase();
  const plan = {};
  const COLOURS = { red: "#c0392b", אדום: "#c0392b", blue: "#2e6fd8", כחול: "#2e6fd8", green: "#2e9e57", ירוק: "#2e9e57", yellow: "#f1c40f", צהוב: "#f1c40f", black: "#111111", שחור: "#111111", white: "#f4f4f4", לבן: "#f4f4f4", orange: "#e67e22", כתום: "#e67e22", purple: "#8e44ad", סגול: "#8e44ad", pink: "#e98aa9", ורוד: "#e98aa9", grey: "#888888", gray: "#888888", אפור: "#888888", gold: "#d4af37", זהב: "#d4af37" };
  for (const [k, v] of Object.entries(COLOURS)) if (w.includes(k)) plan.color = v;
  if (/shiny|glossy|מבריק|polish/.test(w)) plan.roughness = 0.15;
  if (/matte|מט( |$)|rough|מחוספס/.test(w)) plan.roughness = 0.9;
  if (/metal|chrome|gold|מתכת|כרום|זהב/.test(w)) plan.metalness = 1;
  if (/split|פצל|חלק(ים)?/.test(w)) plan.split = "meaning";
  if (/hide|הסתר/.test(w)) plan.hide = true;
  if (/duplicate|copy|שכפל/.test(w)) plan.duplicate = true;
  if (!Object.keys(plan).length) plan.texture = words;
  return plan;
}
$("taskbar").onsubmit = async (e) => {
  e.preventDefault();
  const words = $("taskIn").value.trim();
  if (!words || !chosen) return;
  busy(T("taskThinking", "Working out what to do…"));
  let plan;
  try { plan = await planOf(words); } finally { busy(""); }
  const did = [];
  if (plan.color || typeof plan.roughness === "number" || typeof plan.metalness === "number") {
    remember();
    chosen.traverse((o) => {
      if (!o.isMesh) return;
      const m = matOf(o);
      if (plan.color && /^#[0-9a-f]{6}$/i.test(plan.color)) { m.color?.set(plan.color); if (m.map) m.map = null; }
      if (typeof plan.roughness === "number" && "roughness" in m) m.roughness = Math.min(1, Math.max(0, plan.roughness));
      if (typeof plan.metalness === "number" && "metalness" in m) m.metalness = Math.min(1, Math.max(0, plan.metalness));
      m.needsUpdate = true;
    });
    did.push(T("tColour", "the look"));
    choose(chosen);
  }
  if (plan.texture) { $("texKind").value = "map"; $("texPrompt").value = String(plan.texture).slice(0, 200); $("texAi").click(); did.push(T("tTexture", "a texture")); }
  if (plan.hide) { $("hidePart").click(); did.push(T("tHide", "hidden")); }
  if (plan.duplicate) { duplicate(); did.push(T("tDup", "a copy")); }
  if (plan.split === "meaning" || plan.split === "loose") { splitChosen(plan.split === "meaning" ? "ai" : "loose"); did.push(T("tSplit", "split")); }
  msg(did.length ? `${T("tDone", "Done")}: ${did.join(", ")}` : T("tNone", "Not sure what to do; try a colour, a material or \"split it\""), !did.length);
  if (did.length) $("taskIn").value = "";
};
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
  if (picking && painting) $("paint").click();
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
    out.push({ o, parent: o.parent, i: o.parent.children.indexOf(o), p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone(), v: o.visible, c: m?.color?.getHex(), r: m?.roughness, mt: m?.metalness, maps: m ? [m.map, m.roughnessMap, m.normalMap] : undefined, mods: o.userData.mods ? JSON.parse(JSON.stringify(o.userData.mods)) : undefined });
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
    // Textures too: each change (and each paint stroke) works on a new copy, so the one kept here is as it was.
    if (m && x.maps) { [m.map, m.roughnessMap, m.normalMap] = x.maps; m.needsUpdate = true; }
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
// Isolate (Blender's Local View, "/"; Maya's Isolate Select): only the chosen part shows, framed; again brings the rest
// back as it was. A way of looking, not an edit, so it is not in Undo.
function isolate() {
  if (isolated) {
    for (const [o, v] of isolated) o.visible = v;
    isolated = null;
  } else {
    if (!chosen || !model) return;
    isolated = new Map();
    const keep = new Set();
    chosen.traverse((o) => keep.add(o));
    for (let o = chosen; o; o = o.parent) keep.add(o);
    model.traverse((o) => { isolated.set(o, o.visible); if (!keep.has(o) && o.isMesh) o.visible = false; });
    frame(chosen);
  }
  $("isolate").classList.toggle("on", !!isolated);
  renderParts();
}
$("isolate").onclick = isolate;
$("hidePart").onclick = () => { if (!chosen) return; remember(); chosen.visible = !chosen.visible; choose(chosen); };
$("frame").onclick = () => frame(chosen ?? model ?? scene);
/**
 * A picture of this view (Blender's F12 Render, Spline's Export Image): twice the screen's sharpness, see-through where
 * there is no model (for a game's icons or a page), without the grid, the gizmo, the chosen part's box or reference
 * pictures. It goes into the chat (and so the bank), or is downloaded when the editor has no chat.
 */
async function viewPicture() {
  if (!model) return;
  const hidden = [grid, gizmo.getHelper(), glow].filter((o) => o?.visible);
  model.traverse((o) => { if (o.userData.reference && o.visible) hidden.push(o); });
  hidden.forEach((o) => (o.visible = false));
  const ratio = renderer.getPixelRatio();
  renderer.setPixelRatio(Math.min(4, ratio * 2));
  renderer.render(scene, camera);
  const blob = await new Promise((resolve) => renderer.domElement.toBlob(resolve, "image/png"));
  renderer.setPixelRatio(ratio);
  hidden.forEach((o) => (o.visible = true));
  renderer.render(scene, camera);
  const file = `${(name || "model").replace(/\.[^.]+$/, "")}-view-${Date.now().toString(36)}.png`;
  try {
    const { uploadMedia } = await import("./add-media.js");
    const { path } = await uploadMedia(new File([blob], file, { type: "image/png" }));
    if (path) return msg(T("shotSaved", "The picture is in the chat's files (and the bank)"));
  } catch { /* no chat: download it below */ }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = file;
  a.click();
}
$("shot").onclick = () => void viewPicture();
/**
 * Paint this model by words (StableProjectorz's projection painting, in ComfyUI on this computer): the model as it is
 * goes into the chat's files, is seen from four sides, each side drawn to its shape (Stable Diffusion 1.5 + ControlNet
 * depth) and baked onto it as its colour texture; the painted copy lands beside it (the original stays, to compare).
 */
async function paintThisModel() {
  if (!model) return;
  const look = window.prompt(T("paintAsk", "How should it look? (old oak with brass, worn red velvet…)"));
  if (!look?.trim()) return;
  let shown = false;
  const say = (t) => { if (shown) busy(""); shown = !!t; if (t) busy(t); };
  try {
    say(T("sending", "Sending…"));
    const { path } = await uploadMedia(new File([await glb()], `${base()}.glb`, { type: "model/gltf-binary" }));
    if (!path) throw new Error(T("needChat", "Open the 3D editor from a chat to make a model here"));
    say(T("painting", "Painting it from four sides… (a few minutes, on your computer)"));
    let r = await kesher.call("model.paint", { model: path, look: look.trim() });
    if (r.needGb) {
      say("");
      if (!window.confirm(`${T("paintDownload", "Painting needs Stable Diffusion 1.5 and ControlNet depth, not on this computer yet. Download them now?")} (${r.needGb} GB)`)) return;
      r = await kesher.call("model.paint", { model: path, look: look.trim(), download: true });
    }
    if (r.downloading) return msg(T("wordsDownloading", "The 3D model is downloading (see the downloads circle); try again when it is done. The picture is in the chat's files."));
    const bytes = await kesher.call("media.bytes", { id: `chat:${r.path}` });
    await addFile(r.path.split("/").pop(), bytes);
    msg(T("painted", "The painted copy is beside the original (hide either with 👁)"));
  } catch (e) { msg(e.message || String(e), true); } finally { say(""); }
}
$("paint").onclick = () => void paintThisModel();
/**
 * A turntable video (as Sketchfab and ArtStation show a model): the camera goes once around the model at its height and
 * distance, recorded from the view (WebM, 30 fps, without the grid and helpers), into the chat.
 *
 * @param seconds - How long one turn takes (6, 12 or 20).
 * @param hd - Recorded at 1920×1080 (16:9) instead of the view's own size.
 */
let turning = false;
async function turntable(seconds = 6, hd = false) {
  if (!model || turning || quad) return;
  if (typeof MediaRecorder === "undefined") return msg(T("noRecord", "This browser cannot record the view"), true);
  turning = true;
  const hidden = [grid, gizmo.getHelper(), glow].filter((o) => o?.visible);
  model.traverse((o) => { if (o.userData.reference && o.visible) hidden.push(o); });
  hidden.forEach((o) => (o.visible = false));
  controls.enabled = false;
  const was = camera.position.clone(), t0 = controls.target.clone();
  const off = was.clone().sub(t0), r = Math.hypot(off.x, off.z), a0 = Math.atan2(off.z, off.x);
  const ratio = renderer.getPixelRatio();
  if (hd) {
    renderer.setPixelRatio(1);
    renderer.setSize(1920, 1080, false);
    camera.aspect = 16 / 9;
    camera.updateProjectionMatrix();
  }
  const type = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "video/webm";
  const rec = new MediaRecorder(renderer.domElement.captureStream(30), { mimeType: type, videoBitsPerSecond: 6_000_000 });
  const parts = [];
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  const done = new Promise((resolve) => (rec.onstop = resolve));
  msg(`${T("turning", "Recording a turn around the model…")} (${seconds}s)`);
  rec.start();
  const start = performance.now();
  await new Promise((resolve) => {
    const step = () => {
      const k = Math.min(1, (performance.now() - start) / (seconds * 1000)), a = a0 + k * Math.PI * 2;
      camera.position.set(t0.x + r * Math.cos(a), was.y, t0.z + r * Math.sin(a));
      camera.lookAt(t0);
      if (k < 1) requestAnimationFrame(step); else resolve();
    };
    step();
  });
  rec.stop();
  await done;
  camera.position.copy(was);
  camera.lookAt(t0);
  if (hd) { renderer.setPixelRatio(ratio); resize(); }
  controls.enabled = true;
  hidden.forEach((o) => (o.visible = true));
  turning = false;
  const blob = new Blob(parts, { type: "video/webm" });
  const file = `${(name || "model").replace(/\.[^.]+$/, "")}-turntable-${Date.now().toString(36)}.webm`;
  try {
    const { uploadMedia } = await import("./add-media.js");
    const { path } = await uploadMedia(new File([blob], file, { type: "video/webm" }));
    if (path) return msg(T("turnSaved", "The turntable video is in the chat's files (and the bank)"));
  } catch { /* no chat: download it below */ }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = file;
  a.click();
}
// The 🎞 button's choices: how long the turn takes, and the view's size or Full HD.
$("turn").onclick = () => {
  setHebrew(he);
  openMenu($("turn"), T("turnH", "A turntable video, into the chat"), [6, 12, 20].flatMap((sec) => [
    { icon: "🎞", label: `${sec} ${T("sec", "s")} · ${T("turnView", "the view's size")}`, run: () => void turntable(sec, false) },
    { icon: "🖥", label: `${sec} ${T("sec", "s")} · 1080p`, hint: "16:9", run: () => void turntable(sec, true) },
  ]));
};
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
// ---------- Blender round trip (as the image editor's Affinity one): open it there, and each save comes back ----------
let linked = null; // { name, mtime } of the GLB Blender has
$("blender").onclick = async () => {
  if (!model) return;
  const file = `${base().replace(/[^\w .()-]/g, "_") || "model"}.glb`;
  busy(T("toBlender", "Opening in Blender…"));
  try {
    const data = await new Promise((resolve) => glb().then((b) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(b); }));
    const w = await kesher.call("files.write", { name: file, data });
    const r = await kesher.call("files.openInBlender", { name: file });
    if (r.app !== "blender") return msg(T("noBlender", "Blender is not on this computer (blender.org, free)."), true);
    linked = { name: file, mtime: w.mtime };
    msg(T("inBlender", "Opened in Blender. Save there (Ctrl+S) and it comes back here."));
  } catch (e) { msg(e.message, true); } finally { busy(""); }
};
setInterval(async () => {
  if (!linked) return;
  const st = await kesher.call("files.stat", { name: linked.name }).catch(() => null);
  if (st && st.mtime > linked.mtime + 500) $("fromBlender").hidden = false;
}, 2000);
$("fromBlender").onclick = async () => {
  if (!linked) return;
  busy(T("loading", "Loading the model…"));
  try {
    const f = await kesher.call("files.read", { name: linked.name });
    // A version of how it was first, so the Blender changes can be undone from the strip.
    keepVersion();
    const bin = atob(String(f.data).split(",")[1] ?? "");
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await load(bytes.buffer);
    frame(model);
    stats();
    linked.mtime = f.mtime;
    $("fromBlender").hidden = true;
    msg(T("fromBlenderDone", "The model came back from Blender"));
  } catch (e) { msg(e.message, true); } finally { busy(""); }
};

async function glb() {
  glow?.removeFromParent();
  scene.overrideMaterial = null;
  try {
    // Reference pictures are for modelling only (Blender's reference images): hidden while the model is written.
    const refs = [];
    model.traverse((o) => { if (o.userData.reference && o.visible) { refs.push(o); o.visible = false; } });
    try {
      const out = await new GLTFExporter().parseAsync(model, { binary: true, onlyVisible: true });
      return new Blob([out], { type: "model/gltf-binary" });
    } finally { refs.forEach((o) => (o.visible = true)); }
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
  ["1 / 3 / 7", "kViews", "Front / right / top"], ["4 / 5 / 6", "kShade", "Wireframe / solid / material"], ["Shift+S", "kSnap", "Snapping"], ["/", "kIso", "Isolate the chosen part (again: show all)"], ["F12", "kShot", "A picture of this view"], ["Esc", "kEsc", "Let go"], ["Ctrl+Z", "kUndo", "Undo"],
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
  // A guest only looks: the view's keys, nothing that edits.
  if (guestRole && (e.ctrlKey || e.metaKey || e.altKey || (e.shiftKey && k !== "?") || !["f", "/", "home", "a", "escape", "1", "3", "7", "4", "5", "6", "?"].includes(k))) return;
  if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); return undo(); }
  if ((e.ctrlKey || e.metaKey) && k === "d" && !blender) { e.preventDefault(); return duplicate(); }
  if (e.ctrlKey || e.metaKey) return;
  if (e.altKey && k === "w") { e.preventDefault(); return setQuad(!quad); }
  if (e.altKey && k === "h") { remember(); model?.traverse((o) => (o.visible = true)); renderParts(); return; }
  if (e.shiftKey && k === "d" && blender) { e.preventDefault(); return duplicate(); }
  if (e.shiftKey && k === "s") { e.preventDefault(); return toggleSnap(); }
  const tools = blender ? { g: "translate", r: "rotate", s: "scale" } : { w: "translate", e: "rotate", r: "scale" };
  if (tools[k]) { e.preventDefault(); setMode(tools[k]); lastTool = true; return; }
  // X / Y / Z right after a tool's key lock its axis; in Blender X alone deletes.
  if (["x", "y", "z"].includes(k) && lastTool) { e.preventDefault(); lockAxis(k); return; }
  lastTool = false;
  const map = {
    f: () => $("frame").click(), "/": isolate, home: () => model && frame(model), a: () => model && frame(model), h: () => $("hidePart").click(),
    delete: remove, ...(blender ? { x: remove } : {}), escape: () => choose(null),
    f12: () => void viewPicture(), 1: () => view("front"), 3: () => view("right"), 7: () => view("top"), 4: () => shade("wire"), 5: () => shade("solid"), 6: () => shade("material"), "?": showKeys,
  };
  if (map[k]) { e.preventDefault(); map[k](); }
});
document.querySelectorAll(".phonebar [data-do]").forEach((b) => (b.onclick = () => {
  const d = b.dataset.do, app = $("app");
  if (d === "parts" || d === "inspector") { const on = app.classList.contains(`sheet-${d}`); app.classList.remove("sheet-parts", "sheet-inspector"); if (!on) app.classList.add(`sheet-${d}`); }
  else ({ frame: () => $("frame").click(), undo, keep: keepVersion, add: () => addMenu(b) })[d]();
}));

// ---------- ＋ Add (RESEARCH_LOG "Adding files and objects to the editors"): a model or a picture from the device,
// this chat or the bank, and Blender's Shift+A shapes, a light and a camera, at the middle of the view ----------
/** The scene to add into: the open model, or a new empty one. */
function ensureScene() {
  if (model) return model;
  model = new THREE.Group();
  model.name = T("scene", "Scene");
  scene.add(model);
  $("empty").hidden = true;
  return model;
}
/** A size that fits the view: about a fifth of what the camera sees. */
const fitSize = () => Math.max(0.05, camera.position.distanceTo(controls.target) * 0.2);
const ADDED = (label) => (he ? HE.added(label) : `Added: ${label}`);
function addShape(kind) {
  const u = fitSize();
  const geo = { cube: () => new THREE.BoxGeometry(u, u, u), sphere: () => new THREE.SphereGeometry(u / 2, 32, 16), cylinder: () => new THREE.CylinderGeometry(u / 2, u / 2, u, 32), cone: () => new THREE.ConeGeometry(u / 2, u, 32), plane: () => new THREE.PlaneGeometry(u * 2, u * 2).rotateX(-Math.PI / 2), torus: () => new THREE.TorusGeometry(u / 2, u / 6, 16, 48) }[kind]();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xcfd3dc, roughness: 0.6 }));
  addAndSay(mesh, T(`a${kind[0].toUpperCase()}${kind.slice(1)}`, kind[0].toUpperCase() + kind.slice(1)));
}
function addAndSay(obj, label) {
  const root = ensureScene();
  remember();
  obj.name = label;
  root.add(obj);
  obj.position.copy(root.worldToLocal(controls.target.clone()));
  rebuild();
  choose(obj);
  stats();
  msg(ADDED(label));
}
/** A light (exported to GLB as a light) with a small bulb to click and move. */
function addLight() {
  const light = new THREE.PointLight(0xffffff, 3, 0, 2);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(fitSize() * 0.12, 16, 8), new THREE.MeshBasicMaterial({ color: 0xffe27a }));
  bulb.userData.generated = true;
  light.add(bulb);
  light.userData.icon = "💡";
  addAndSay(light, T("aLight", "Light"));
  light.position.y += fitSize();
}
/** A camera (exported to GLB as a camera) with its frustum drawn. */
function addCamera() {
  const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.05, 10);
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.4, 0.8).scale(fitSize() * 0.4, fitSize() * 0.4, fitSize() * 0.4), new THREE.MeshBasicMaterial({ color: 0x8fa2ff, wireframe: true }));
  body.userData.generated = true;
  cam.add(body);
  cam.userData.icon = "🎥";
  addAndSay(cam, T("aCamera", "Camera"));
  cam.position.z += fitSize() * 2;
}
/**
 * A reference picture (Blender's reference image): half see-through, standing behind the middle of the view, locked so
 * clicks go to the model, and left out of what is saved and exported.
 */
async function addReference(fileName, bytes) {
  const tex = await new THREE.TextureLoader().loadAsync(URL.createObjectURL(new Blob([bytes])));
  tex.colorSpace = THREE.SRGBColorSpace;
  const u = fitSize() * 4, a = tex.image.width / tex.image.height || 1;
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(a >= 1 ? u : u * a, a >= 1 ? u / a : u), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }));
  panel.userData.reference = true;
  panel.userData.locked = true;
  panel.userData.icon = "🖼";
  panel.renderOrder = -1;
  addAndSay(panel, `${T("aRef", "Reference")}: ${fileName.replace(/\.[^.]+$/, "")}`);
  panel.position.z -= fitSize() * 1.5;
  gizmo.detach();
}
/** A model or a picture's bytes, added: a model as it is, a picture on a flat panel in its proportions. */
async function addFile(fileName, bytes) {
  if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(fileName)) {
    const url = URL.createObjectURL(new Blob([bytes]));
    const tex = await new THREE.TextureLoader().loadAsync(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    const u = fitSize() * 2, a = tex.image.width / tex.image.height || 1;
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(a >= 1 ? u : u * a, a >= 1 ? u / a : u), new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.9 }));
    addAndSay(panel, fileName.replace(/\.[^.]+$/, ""));
    return;
  }
  if (!/\.(glb|gltf|fbx|obj)$/i.test(fileName)) throw new Error(T("notModel", "A model (GLB, GLTF, FBX, OBJ) or a picture can be added here"));
  const shape = /\.fbx$/i.test(fileName) ? new FBXLoader().parse(bytes, "")
    : /\.obj$/i.test(fileName) ? new OBJLoader().parse(new TextDecoder().decode(bytes))
    : (await new Promise((resolve, reject) => new GLTFLoader().parse(bytes, "", resolve, reject))).scene;
  shape.traverse((o) => { if (o.isMesh) o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone(); });
  // Scaled to the view (a model in centimetres would be huge), standing on the point the view looks at.
  const box = new THREE.Box3().setFromObject(shape);
  const s = box.getSize(new THREE.Vector3());
  const big = Math.max(s.x, s.y, s.z) || 1;
  const holder = new THREE.Group();
  const k = (fitSize() * 2.5) / big;
  shape.scale.multiplyScalar(k);
  shape.position.set(-(box.min.x + s.x / 2) * k, -box.min.y * k, -(box.min.z + s.z / 2) * k);
  holder.add(shape);
  addAndSay(holder, fileName.replace(/\.[^.]+$/, ""));
}
async function addFrom(from) {
  try {
    if (from === "device" || from === "reference") {
      for (const f of await pickDevice(from === "reference" ? "image/*" : ".glb,.gltf,.fbx,.obj,image/*")) {
        busy(T("loading", "Loading the model…"));
        // A reference stays here only (it is not part of the model); a model or a picture goes into the chat too.
        try { if (from === "reference") await addReference(f.name, await f.arrayBuffer()); else { const { bytes } = await uploadMedia(f); await addFile(f.name, bytes); } } finally { busy(""); }
      }
      return;
    }
    const it = await pickMedia(from, ["model", "image"]);
    if (!it) return;
    busy(T("loading", "Loading the model…"));
    try { const { bytes } = await takeMedia(it); await addFile(it.name, bytes); } finally { busy(""); }
  } catch (e) { msg(e.message, true); }
}
/**
 * A model from words, without the chat (Meshy's and Tripo's text-to-3D, as two steps): the picture model draws the
 * object alone on a plain background, then it becomes a model on this computer (makeModel).
 *
 * @param colours - Painted with its colours and materials (TRELLIS.2) instead of the shape only (Hunyuan3D 2).
 */
async function addFromWords(colours) {
  const words = window.prompt(T("wordsAsk", "What to make? (an old wooden chair…)"));
  if (!words?.trim()) return;
  // busy() counts its callers: one at a time here.
  let shown = false;
  const say = (t) => { if (shown) busy(""); shown = !!t; if (t) busy(t); };
  try {
    say(T("wordsDrawing", "Drawing the object… (a minute or two)"));
    const [url] = await kesher.call("image.generate", { prompt: `${words.trim()}, a single object, whole and centered, three-quarter view, plain white background, soft even studio light, no shadow, no text`, width: 1024, height: 1024 });
    if (!url) throw new Error("No picture came back.");
    const blob = await (await fetch(url)).blob();
    const { path } = await uploadMedia(new File([blob], `${words.trim().slice(0, 30).replace(/[^\p{L}\p{N}]+/gu, "-")}-${Date.now().toString(36)}.png`, { type: "image/png" }));
    await makeModel(path, colours, say);
  } catch (e) { msg(e.message || String(e), true); } finally { say(""); }
}
/** A model from a picture of one object (from the computer or the phone), with its colours. */
async function addFromPicture() {
  const [f] = await pickDevice("image/*", false);
  if (!f) return;
  let shown = false;
  const say = (t) => { if (shown) busy(""); shown = !!t; if (t) busy(t); };
  try {
    const { path } = await uploadMedia(f);
    await makeModel(path, true, say);
  } catch (e) { msg(e.message || String(e), true); } finally { say(""); }
}
/**
 * A picture in this chat turned into a model that lands in the view: with colours (TRELLIS.2, PBR) or the shape only
 * (Hunyuan3D 2). The first time, the model downloads after a yes (its size is shown).
 */
async function makeModel(path, colours, say) {
  if (!path) throw new Error(T("needChat", "Open the 3D editor from a chat to make a model here"));
  say(colours ? T("wordsPainting", "Building and painting the model… (several minutes, on your computer)") : T("wordsModelling", "Turning the picture into a model… (a few minutes, on your computer)"));
  let r = await kesher.call("model.fromPicture", { image: path, colours });
  if (r.needGb) {
    say("");
    const which = colours ? "TRELLIS.2" : "Hunyuan3D 2";
    if (!window.confirm(`${T("wordsDownload", "The 3D model is not on this computer yet. Download it now?")} (${which}, ${r.needGb} GB)`)) return msg(T("wordsPicKept", "The picture is in the chat's files; make the model later from it"));
    r = await kesher.call("model.fromPicture", { image: path, colours, download: true });
  }
  if (r.downloading) return msg(T("wordsDownloading", "The 3D model is downloading (see the downloads circle); try again when it is done. The picture is in the chat's files."));
  const bytes = await kesher.call("media.bytes", { id: `chat:${r.path}` });
  await addFile(r.path.split("/").pop(), bytes);
}
function addMenu(anchor) {
  openMenu(anchor, T("addAt", "Lands in the middle of the view, chosen"), [
    { icon: "💻", label: T("fromDevice", "From the computer / phone"), hint: T("dragToo", "drag in too"), run: () => addFrom("device") },
    { icon: "💬", label: T("fromChat", "From this chat's files"), run: () => addFrom("chat") },
    { icon: "🗂", label: T("fromBank", "From everything made"), run: () => addFrom("bank") },
    "-",
    ...["cube", "sphere", "cylinder", "cone", "plane", "torus"].map((k) => ({ icon: { cube: "⬛", sphere: "⚪", cylinder: "🛢", cone: "🔺", plane: "▭", torus: "◯" }[k], label: T(`a${k[0].toUpperCase()}${k.slice(1)}`, k[0].toUpperCase() + k.slice(1)), run: () => addShape(k) })),
    { icon: "💡", label: T("aLight", "Light"), run: addLight },
    { icon: "🎥", label: T("aCamera", "Camera"), run: addCamera },
    { icon: "🖼", label: T("aRef", "Reference picture"), hint: T("aRefHint", "behind the model, not exported"), run: () => addFrom("reference") },
    "-",
    { icon: "🎨", label: T("aWordsColour", "A model from words, with colours"), hint: T("aWordsColourHint", "TRELLIS.2, on your computer"), run: () => void addFromWords(true) },
    { icon: "✨", label: T("aWords", "A model from words, shape only"), hint: T("aWordsHint", "Hunyuan3D 2, faster"), run: () => void addFromWords(false) },
    { icon: "🖼", label: T("aFromPic", "A model from a picture, with colours"), hint: T("aFromPicHint", "one object in the picture"), run: () => void addFromPicture() },
  ]);
}
$("addBtn").onclick = () => addMenu($("addBtn"));
// A model or a picture dropped on the view is added too (Spline, Blender).
host.addEventListener("dragover", (e) => { if ([...(e.dataTransfer?.items ?? [])].some((i) => i.kind === "file")) e.preventDefault(); });
host.addEventListener("drop", async (e) => {
  const files = [...(e.dataTransfer?.files ?? [])];
  if (!files.length || guestRole) return;
  e.preventDefault();
  for (const f of files) {
    busy(T("loading", "Loading the model…"));
    try { const { bytes } = await uploadMedia(f); await addFile(f.name, bytes); } catch (err) { msg(err.message, true); } finally { busy(""); }
  }
});
let busyCount = 0;
$("busyStop").onclick = () => kesher.call("model.parts.cancel").catch(() => undefined);
function busy(text) { busyCount = Math.max(0, busyCount + (text ? 1 : -1)); $("busy").hidden = busyCount <= 0; if (text) $("busyText").textContent = text; }
let msgTimer;
function msg(text, error) { const m = $("msg"); m.textContent = text; m.className = `status show${error ? " error" : ""}`; clearTimeout(msgTimer); msgTimer = setTimeout(() => (m.className = "status"), error ? 6000 : 3500); }
kesher.call("storage.get", { key: "keymap" }).then((v) => { if (v === "blender" || v === "maya") $("keymap").value = v; }).catch(() => undefined);
$("keymap").onchange = () => kesher.call("storage.set", { key: "keymap", value: $("keymap").value }).catch(() => undefined);
kesher.call("info").then((i) => {
  he = i.locale === "he";
  setHebrew(he);
  if (he) { document.documentElement.dir = "rtl"; document.querySelectorAll("[data-t]").forEach((el) => (el.textContent = T(el.dataset.t, el.textContent))); document.querySelectorAll("[data-tp]").forEach((el) => (el.placeholder = T(el.dataset.tp, el.placeholder))); document.querySelectorAll("[data-ta]").forEach((el) => el.setAttribute("aria-label", T(el.dataset.ta, el.getAttribute("aria-label")))); }
}).catch(() => undefined);
open();
