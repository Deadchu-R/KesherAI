// The phone app's side menu, on every screen, on the right (for one hand):
// chats on this phone, the chat on your computer, the phone's models, web
// search, your computers, updates, language.
// Open it with ☰, or swipe in from the right edge. Like Apple's menus you can
// also press ☰ and keep your finger down, slide to an item (it lights up) and
// let go to open it.
/* global window, document, localStorage, location, navigator, addEventListener, innerWidth, URL, URLSearchParams, Event, setInterval */
(() => {
  const lang = localStorage.getItem("lang") || (navigator.language.startsWith("he") ? "he" : "en");
  const he = lang === "he";
  const T = (h, e) => (he ? h : e);
  const read = (k, d) => {
    try {
      return JSON.parse(localStorage.getItem(k) || "") ?? d;
    } catch {
      return d;
    }
  };
  const saved = localStorage.getItem("kesherai-server");
  const computers = read("kesherai-computers", []);
  const chats = read("kesherai-phone-chats", []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const params = new URLSearchParams(location.search);
  const here = location.pathname.split("/").pop() || "index.html";

  const css = document.createElement("style");
  css.textContent = `
    .kd-btn { position: fixed; bottom: max(18px, env(safe-area-inset-bottom)); right: 16px; z-index: 50; width: 56px; height: 56px; min-height: 56px; padding: 0; border-radius: 18px; border: 1px solid var(--border); background: rgb(31 31 34 / 0.86); backdrop-filter: blur(14px); color: var(--text); font-size: 22px; box-shadow: 0 10px 30px rgb(0 0 0 / .45); touch-action: none; }
    .kd-scrim { position: fixed; inset: 0; z-index: 60; background: rgb(0 0 0 / 0.45); opacity: 0; pointer-events: none; transition: opacity .2s; }
    .kd-panel { position: fixed; top: 0; bottom: 0; right: 0; left: auto; z-index: 61; width: min(330px, 86vw); display: flex; flex-direction: column; gap: 2px; padding: max(18px, env(safe-area-inset-top)) 10px max(18px, env(safe-area-inset-bottom)); background: rgb(24 24 26 / 0.94); backdrop-filter: blur(22px) saturate(150%); border-left: 1px solid var(--border); transform: translateX(100%); transition: transform .26s cubic-bezier(.2,.9,.25,1); overflow-y: auto; touch-action: pan-y; }
    .kd-open .kd-scrim { opacity: 1; pointer-events: auto; }
    .kd-open .kd-panel { transform: none; }
    .kd-brand { display: flex; gap: 10px; align-items: center; font-size: 18px; font-weight: 500; padding: 4px 8px 12px; }
    .kd-head { font-size: 12px; color: var(--muted); padding: 12px 10px 4px; }
    .kd-item { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 48px; padding: 0 12px; border: 0; border-radius: 12px; background: transparent; color: var(--text); font-size: 15.5px; text-align: start; text-decoration: none; transition: background .08s, transform .08s, color .08s; user-select: none; -webkit-user-select: none; }
    .kd-item.on { background: var(--raised); }
    .kd-item.hot { background: var(--accent); color: var(--accent-ink); transform: scale(1.02); }
    .kd-item.hot small { color: inherit; opacity: .75; }
    .kd-item small { display: block; color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .kd-item > span:nth-child(2) { min-width: 0; flex: 1; }
    .kd-label { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .kd-ico { width: 24px; text-align: center; flex: none; }
    .kd-switch { margin-inline-start: auto; width: 40px; height: 24px; border-radius: 12px; background: var(--raised); position: relative; flex: none; transition: background .15s; }
    .kd-switch::after { content: ""; position: absolute; top: 3px; inset-inline-start: 3px; width: 18px; height: 18px; border-radius: 50%; background: var(--text); transition: inset-inline-start .15s; }
    .kd-switch.on { background: var(--accent); }
    .kd-switch.on::after { inset-inline-start: 19px; background: var(--accent-ink); }
    .kd-foot { margin-top: auto; padding-top: 8px; }`;
  document.head.append(css);

  const root = document.createElement("div");
  root.innerHTML = `<div class="kd-scrim"></div><nav class="kd-panel" aria-label="${T("תפריט", "Menu")}"></nav>`;
  const panel = root.querySelector(".kd-panel");
  const scrim = root.querySelector(".kd-scrim");
  const isOpen = () => document.body.classList.contains("kd-open");
  const open = () => document.body.classList.add("kd-open");
  const close = () => {
    document.body.classList.remove("kd-open");
    panel.querySelectorAll(".hot").forEach((x) => x.classList.remove("hot"));
  };
  scrim.onclick = close;

  const add = (el) => {
    el.dataset.kd = "1";
    panel.append(el);
    return el;
  };
  const item = (icon, label, sub, href, cls = "") => {
    const a = document.createElement("a");
    a.className = `kd-item ${cls}`;
    a.href = href;
    a.innerHTML = `<span class="kd-ico" aria-hidden="true"></span><span><span class="kd-label"></span>${sub ? "<small></small>" : ""}</span>`;
    a.querySelector(".kd-ico").textContent = icon;
    a.querySelector(".kd-label").textContent = label;
    a.querySelector(".kd-label").dir = "auto";
    if (sub) a.querySelector("small").textContent = sub;
    a.addEventListener("click", close);
    return add(a);
  };
  const head = (text) => panel.append(Object.assign(document.createElement("div"), { className: "kd-head", textContent: text }));

  panel.append(Object.assign(document.createElement("div"), { className: "kd-brand", innerHTML: `<img src="icon.svg" width="28" height="28" alt="" /> KesherAI` }));
  const lastModel = localStorage.getItem("kesherai-phone-model");
  item("＋", T("צ'אט חדש בטלפון", "New chat on this phone"), "", "local.html?new=1");
  if (saved) {
    let host = saved;
    try {
      host = new URL(saved).host;
    } catch {
      // keep the raw text
    }
    item("🖥", T("הצ'אט במחשב", "Chat on my computer"), host, "index.html");
  }

  // The phone's chats, newest first.
  if (chats.length) {
    head(T("צ'אטים בטלפון", "Chats on this phone"));
    for (const c of chats.slice(0, 12)) {
      const on = here === "local.html" && params.get("c") === c.id;
      item("💬", c.title || T("צ'אט", "Chat"), c.name || "", `local.html?c=${encodeURIComponent(c.id)}`, on ? "on" : "");
    }
  } else if (lastModel) {
    item("💬", T("הצ'אט בטלפון", "Chat on this phone"), T("ממשיך מאיפה שעצרת", "Pick up where you left off"), "local.html?chat=1");
  }

  head(T("עוד", "More"));
  item("📱", T("מודלים בטלפון ו-API", "Models on this phone and API"), "", "local.html", here === "local.html" && !params.has("c") ? "on" : "");
  // Web search for phone chats (the 🌐 button in the chat does the same).
  const web = document.createElement("button");
  web.type = "button";
  web.className = "kd-item";
  const paintWeb = () => {
    const on = localStorage.getItem("kesherai-phone-web") === "1";
    web.innerHTML = `<span class="kd-ico" aria-hidden="true">🌐</span><span><span class="kd-label"></span><small></small></span><span class="kd-switch ${on ? "on" : ""}" aria-hidden="true"></span>`;
    web.querySelector(".kd-label").textContent = T("חיפוש באינטרנט", "Search the web");
    web.querySelector("small").textContent = on ? T("פועל: כל הודעה מחפשת קודם", "On: each message searches first") : T("כבוי", "Off");
    web.setAttribute("aria-pressed", String(on));
  };
  web.onclick = () => {
    localStorage.setItem("kesherai-phone-web", localStorage.getItem("kesherai-phone-web") === "1" ? "0" : "1");
    paintWeb();
    window.dispatchEvent(new Event("kesher-web-changed"));
  };
  paintWeb();
  add(web);
  item("🔗", T("המחשבים שלי", "My computers"), computers.length ? T(`${computers.length} שמורים`, `${computers.length} saved`) : "", "index.html?switch=1", here === "index.html" ? "on" : "");
  item("⬆", T("בדוק עדכונים", "Check for updates"), "", "index.html?switch=1&update=1");
  const foot = document.createElement("div");
  foot.className = "kd-foot";
  panel.append(foot);
  const langBtn = document.createElement("button");
  langBtn.type = "button";
  langBtn.className = "kd-item";
  langBtn.dataset.kd = "1";
  langBtn.innerHTML = `<span class="kd-ico" aria-hidden="true">Aא</span><span>${he ? "English" : "עברית"}</span>`;
  langBtn.onclick = () => {
    localStorage.setItem("lang", he ? "en" : "he");
    location.reload();
  };
  foot.append(langBtn);
  document.body.append(root);

  // ---------- press ☰, slide, let go (Apple-style); a tap just opens ----------
  const itemAt = (x, y) => document.elementFromPoint(x, y)?.closest?.("[data-kd]") ?? null;
  const pressAndSlide = (button) => {
    button.style.touchAction = "none";
    button.style.userSelect = "none";
    button.setAttribute("draggable", "false");
    let active = null;
    const begin = (x, y) => {
      active = { x, y, moved: false, wasOpen: isOpen() };
      open();
    };
    const track = (x, y) => {
      if (!active) return;
      if (Math.hypot(x - active.x, y - active.y) > 8) active.moved = true;
      const hit = itemAt(x, y);
      panel.querySelectorAll(".hot").forEach((el) => el !== hit && el.classList.remove("hot"));
      if (hit && !hit.classList.contains("hot")) {
        hit.classList.add("hot");
        navigator.vibrate?.(8);
      }
    };
    const end = (x, y) => {
      if (!active) return;
      const { moved, wasOpen } = active;
      active = null;
      const hit = moved ? itemAt(x, y) : null;
      panel.querySelectorAll(".hot").forEach((el) => el.classList.remove("hot"));
      if (hit) hit.click();
      else if (!moved && wasOpen) close();
    };
    // Touch: the finger stays on the screen while sliding into the menu (the browser must not scroll or cancel it).
    button.addEventListener("touchstart", (e) => { e.preventDefault(); const t = e.touches[0]; begin(t.clientX, t.clientY); }, { passive: false });
    addEventListener("touchmove", (e) => { if (!active) return; e.preventDefault(); const t = e.touches[0]; track(t.clientX, t.clientY); }, { passive: false });
    addEventListener("touchend", (e) => { const t = e.changedTouches[0]; end(t.clientX, t.clientY); });
    // Mouse (and pens): the same with the button held.
    button.addEventListener("mousedown", (e) => { if (e.button === 0) { e.preventDefault(); begin(e.clientX, e.clientY); } });
    addEventListener("mousemove", (e) => track(e.clientX, e.clientY));
    addEventListener("mouseup", (e) => end(e.clientX, e.clientY));
    // Keyboard.
    button.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  };

  // One ☰ on every screen, at the bottom right (thumb reach); it sits above a chat's message box.
  const own = document.getElementById("menu");
  if (own) own.hidden = true;
  const b = Object.assign(document.createElement("button"), { className: "kd-btn", type: "button", textContent: "☰" });
  b.setAttribute("aria-label", T("תפריט", "Menu"));
  document.body.append(b);
  pressAndSlide(b);
  const place = () => {
    const foot = document.getElementById("chatFoot");
    const h = foot && !foot.hidden ? foot.getBoundingClientRect().height : 0;
    b.style.bottom = h ? `${h + 12}px` : "";
  };
  place();
  setInterval(place, 400);

  // Swipe in from the right edge to open, swipe right to close.
  let sx = -1, sy = 0;
  addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    sx = innerWidth - t.clientX < 26 || isOpen() ? t.clientX : -1;
    sy = t.clientY;
  }, { passive: true });
  addEventListener("touchend", (e) => {
    if (sx < 0) return;
    const t = e.changedTouches[0];
    const dx = sx - t.clientX; // > 0: moved left (opening from the right edge)
    if (Math.abs(t.clientY - sy) < 60) {
      if (dx > 50 && !isOpen()) open();
      else if (dx < -50 && isOpen()) close();
    }
    sx = -1;
  }, { passive: true });
  addEventListener("keydown", (e) => e.key === "Escape" && close());
  window.kesherDrawer = { open, close };

  // ---------- "Share → KesherAI" and the home-screen widget, on the phone's own screens ----------
  // When the last chat was with a computer, the computer's page takes them (it opens after connecting).
  const Share = window.Capacitor?.Plugins?.KesherShare;
  if (here === "local.html") localStorage.setItem("kesherai-last-mode", "phone");
  const toPhone = async () => {
    const lastComputer = localStorage.getItem("kesherai-last-mode") === "computer" && (saved || computers.length);
    if (here === "index.html" && lastComputer) return;
    const s = await Share.take().catch(() => ({}));
    if (!s || (!s.text && !s.subject && !s.action && !s.files?.length)) return;
    const text = [s.subject, s.text].filter(Boolean).join("\n");
    if (text) sessionStorage.setItem("kesherai-shared-text", text);
    const target = s.action === "new" ? "local.html?new=1" : s.action === "talk" ? "local.html?chat=1&talk=1" : s.action === "photo" ? "local.html?chat=1&photo=1" : "local.html?chat=1";
    location.href = target;
  };
  if (Share) {
    void toPhone();
    Share.addListener("shared", () => void toPhone());
  }
})();
