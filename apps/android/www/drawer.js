// The phone app's side menu, on every screen: back to the chat (on this phone
// or on your computer), the phone's models, your computers, updates, language.
// Open it with the ☰ button or by swiping in from the screen's edge.
/* global window, document, localStorage, location, navigator, addEventListener, innerWidth, URL */
(() => {
  const lang = localStorage.getItem("lang") || (navigator.language.startsWith("he") ? "he" : "en");
  const he = lang === "he";
  const T = (h, e) => (he ? h : e);
  const saved = localStorage.getItem("kesherai-server");
  const lastModel = localStorage.getItem("kesherai-phone-model");
  const computers = (() => {
    try {
      return JSON.parse(localStorage.getItem("kesherai-computers") || "[]");
    } catch {
      return [];
    }
  })();
  const here = location.pathname.split("/").pop() || "index.html";

  const css = document.createElement("style");
  css.textContent = `
    .kd-btn { position: fixed; top: max(10px, env(safe-area-inset-top)); inset-inline-start: 10px; z-index: 50; width: 44px; height: 44px; min-height: 44px; padding: 0; border-radius: 12px; border: 1px solid var(--border); background: rgb(24 24 26 / 0.8); backdrop-filter: blur(12px); color: var(--text); font-size: 20px; }
    body.kd-has-header .kd-btn { display: none; }
    .kd-scrim { position: fixed; inset: 0; z-index: 60; background: rgb(0 0 0 / 0.5); opacity: 0; pointer-events: none; transition: opacity .2s; }
    .kd-panel { position: fixed; top: 0; bottom: 0; inset-inline-start: 0; z-index: 61; width: min(320px, 84vw); display: flex; flex-direction: column; gap: 4px; padding: max(18px, env(safe-area-inset-top)) 12px max(18px, env(safe-area-inset-bottom)); background: var(--panel); border-inline-end: 1px solid var(--border); transform: translateX(${he ? "100%" : "-100%"}); transition: transform .24s cubic-bezier(.2,.8,.2,1); overflow-y: auto; }
    .kd-open .kd-scrim { opacity: 1; pointer-events: auto; }
    .kd-open .kd-panel { transform: none; }
    .kd-brand { display: flex; gap: 10px; align-items: center; font-size: 18px; font-weight: 500; padding: 4px 8px 14px; }
    .kd-head { font-size: 12px; color: var(--muted); padding: 12px 10px 4px; }
    .kd-item { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 48px; padding: 0 12px; border: 0; border-radius: 12px; background: transparent; color: var(--text); font-size: 15.5px; text-align: start; text-decoration: none; }
    .kd-item:active, .kd-item.on { background: var(--raised); }
    .kd-item.primary { background: var(--accent); color: var(--accent-ink); font-weight: 500; }
    .kd-item small { display: block; color: var(--muted); font-size: 12px; direction: ltr; }
    .kd-item.primary small { color: inherit; opacity: .7; }
    .kd-ico { width: 24px; text-align: center; flex: none; }
    .kd-foot { margin-top: auto; }`;
  document.head.append(css);

  const root = document.createElement("div");
  root.innerHTML = `<div class="kd-scrim"></div><nav class="kd-panel" aria-label="${T("תפריט", "Menu")}"></nav>`;
  const panel = root.querySelector(".kd-panel");
  const scrim = root.querySelector(".kd-scrim");
  const open = () => document.body.classList.add("kd-open");
  const close = () => document.body.classList.remove("kd-open");
  scrim.onclick = close;

  const item = (icon, label, sub, href, cls = "") => {
    const a = document.createElement("a");
    a.className = `kd-item ${cls}`;
    a.href = href;
    a.innerHTML = `<span class="kd-ico" aria-hidden="true"></span><span><span class="kd-label"></span>${sub ? "<small></small>" : ""}</span>`;
    a.querySelector(".kd-ico").textContent = icon;
    a.querySelector(".kd-label").textContent = label;
    if (sub) a.querySelector("small").textContent = sub;
    a.onclick = close;
    panel.append(a);
    return a;
  };
  const head = (text) => panel.append(Object.assign(document.createElement("div"), { className: "kd-head", textContent: text }));

  panel.append(Object.assign(document.createElement("div"), { className: "kd-brand", innerHTML: `<img src="icon.svg" width="28" height="28" alt="" /> KesherAI` }));
  // Back to the chat: the phone's own model if one was used, and the computer if one is saved.
  if (lastModel) item("💬", T("הצ'אט בטלפון", "Chat on this phone"), T("ממשיך מאיפה שעצרת", "Pick up where you left off"), "local.html?chat=1", here === "local.html" ? "on" : "primary");
  if (saved) {
    let host = saved;
    try {
      host = new URL(saved).host;
    } catch {
      // keep the raw text
    }
    item("🖥", T("הצ'אט במחשב", "Chat on my computer"), host, "index.html", lastModel ? "" : "primary");
  }
  head(T("עוד", "More"));
  item("📱", T("מודלים בטלפון", "Models on this phone"), "", "local.html", here === "local.html" && !lastModel ? "on" : "");
  item("🔗", T("המחשבים שלי", "My computers"), computers.length ? T(`${computers.length} שמורים`, `${computers.length} saved`) : "", "index.html?switch=1", here === "index.html" ? "on" : "");
  item("⬆", T("בדוק עדכונים", "Check for updates"), "", "index.html?switch=1&update=1");
  const foot = document.createElement("div");
  foot.className = "kd-foot";
  panel.append(foot);
  const langBtn = document.createElement("button");
  langBtn.type = "button";
  langBtn.className = "kd-item";
  langBtn.innerHTML = `<span class="kd-ico" aria-hidden="true">🌐</span><span>${he ? "English" : "עברית"}</span>`;
  langBtn.onclick = () => {
    localStorage.setItem("lang", he ? "en" : "he");
    location.reload();
  };
  foot.append(langBtn);
  document.body.append(root);

  // The ☰ button: screens with their own header put a button with id "menu"; others get a floating one.
  const own = document.getElementById("menu");
  if (own) {
    own.hidden = false;
    own.onclick = open;
  } else {
    const b = Object.assign(document.createElement("button"), { className: "kd-btn", type: "button", textContent: "☰" });
    b.setAttribute("aria-label", T("תפריט", "Menu"));
    b.onclick = open;
    document.body.append(b);
  }

  // Swipe in from the start edge to open, swipe back to close.
  let sx = -1, sy = 0;
  addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    const fromEdge = he ? innerWidth - t.clientX < 24 : t.clientX < 24;
    sx = fromEdge || document.body.classList.contains("kd-open") ? t.clientX : -1;
    sy = t.clientY;
  }, { passive: true });
  addEventListener("touchend", (e) => {
    if (sx < 0) return;
    const t = e.changedTouches[0];
    const dx = (t.clientX - sx) * (he ? -1 : 1);
    if (Math.abs(t.clientY - sy) > 60) return;
    if (dx > 50) open();
    else if (dx < -50) close();
    sx = -1;
  }, { passive: true });
  addEventListener("keydown", (e) => e.key === "Escape" && close());
  window.kesherDrawer = { open, close };
})();
