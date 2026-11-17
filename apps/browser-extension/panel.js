// The side panel: KesherAI's own page from this computer, and "Ask about this page", which hands the page's text to
// it (only to the KesherAI page in this panel, by postMessage to its exact address).
const frame = document.getElementById("app");
let origin = "http://127.0.0.1:7420";
chrome.storage.local.get({ port: 7420 }).then((s) => {
  origin = `http://127.0.0.1:${Number(s.port) || 7420}`;
  frame.src = `${origin}/#/`;
});
const he = (navigator.language || "").startsWith("he");
if (he) {
  document.getElementById("ask").textContent = "📄 לשאול על הדף הזה";
  document.getElementById("home").textContent = "💬 צ'אט חדש";
  document.getElementById("clip").textContent = "🎓 לשמור לקורס";
  document.getElementById("lens").textContent = "🔍 עדשה";
  document.documentElement.dir = "rtl";
}
document.getElementById("home").onclick = () => (frame.src = `${origin}/#/`);
// The page in front: its title, address, text and anything selected on it (sites must be allowed in Firefox).
async function readTab() {
  try {
    if (chrome.permissions?.request) await chrome.permissions.request({ origins: ["<all_urls>"] });
  } catch {
    // already allowed
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || "")) return undefined;
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => ({ title: document.title, url: location.href, text: (document.body?.innerText || "").slice(0, 20000), selection: String(window.getSelection?.() || "").slice(0, 20000) }),
  });
  return res?.result;
}
document.getElementById("ask").onclick = async () => {
  const page = await readTab();
  if (page) frame.contentWindow.postMessage({ type: "kesher-page", ...page }, origin);
};
// "Save to course": KesherAI shows where to save it (design SaveToCourse).
document.getElementById("clip").onclick = async () => {
  const page = await readTab();
  if (page) frame.contentWindow.postMessage({ type: "kesher-clip", ...page }, origin);
};

// "🔍 Lens" (design ScreenLens): she drags a box over the page itself; that part of the visible tab goes to the
// KesherAI page in this panel (by postMessage to its exact address), which asks, searches, translates or summarizes it.
function markRegion(hebrew) {
  return new Promise((resolve) => {
    const cover = document.createElement("div");
    cover.style.cssText = "position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,.35)";
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;border:2px solid #a5b4ff;border-radius:6px;background:rgba(255,255,255,.08);box-shadow:0 0 0 9999px rgba(0,0,0,.25);display:none";
    const hint = document.createElement("div");
    hint.textContent = hebrew ? "גוררים כדי לסמן · Esc לביטול" : "Drag to mark · Esc to cancel";
    hint.style.cssText = "position:fixed;top:12px;left:50%;transform:translateX(-50%);background:#1d1d22;color:#fff;padding:6px 12px;border-radius:999px;font:14px system-ui";
    cover.append(box, hint);
    document.documentElement.append(cover);
    let start = null;
    const done = (r) => { cover.remove(); removeEventListener("keydown", key, true); resolve(r); };
    const key = (e) => { if (e.key === "Escape") { e.preventDefault(); done(null); } };
    addEventListener("keydown", key, true);
    cover.addEventListener("pointerdown", (e) => { start = { x: e.clientX, y: e.clientY }; cover.setPointerCapture(e.pointerId); box.style.display = "block"; });
    cover.addEventListener("pointermove", (e) => {
      if (!start) return;
      Object.assign(box.style, { left: `${Math.min(start.x, e.clientX)}px`, top: `${Math.min(start.y, e.clientY)}px`, width: `${Math.abs(e.clientX - start.x)}px`, height: `${Math.abs(e.clientY - start.y)}px` });
    });
    cover.addEventListener("pointerup", (e) => {
      if (!start) return;
      const r = { x: Math.min(start.x, e.clientX), y: Math.min(start.y, e.clientY), w: Math.abs(e.clientX - start.x), h: Math.abs(e.clientY - start.y) };
      // A tap marks the whole visible page.
      done(r.w < 8 || r.h < 8 ? { x: 0, y: 0, w: innerWidth, h: innerHeight, vw: innerWidth } : { ...r, vw: innerWidth });
    });
  });
}
document.getElementById("lens").onclick = async () => {
  await readTab();
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || "")) return;
  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: markRegion, args: [he] });
  const r = res?.result;
  if (!r) return;
  // The box is hidden again before the picture is taken.
  await new Promise((ok) => setTimeout(ok, 120));
  const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const bmp = await createImageBitmap(await (await fetch(shot)).blob());
  // The picture's pixels per page pixel (screen density and zoom).
  const k = bmp.width / (r.vw || bmp.width);
  const c = new OffscreenCanvas(Math.max(1, Math.round(r.w * k)), Math.max(1, Math.round(r.h * k)));
  c.getContext("2d").drawImage(bmp, r.x * k, r.y * k, c.width, c.height, 0, 0, c.width, c.height);
  const blob = await c.convertToBlob({ type: "image/png" });
  const b64 = await new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(",")[1]); fr.readAsDataURL(blob); });
  frame.contentWindow.postMessage({ type: "kesher-lens", image: b64 }, origin);
};
