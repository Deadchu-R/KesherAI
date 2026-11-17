// The phone app's side menu, on every screen, on the right (for one hand):
// chats on this phone, the chat on your computer, the phone's models, web
// search, your computers, updates, language.
// Open it with ☰, or swipe in from the right edge. Like Apple's menus you can
// also press ☰ and keep your finger down, slide to an item (it lights up) and
// let go to open it.
/* global requestAnimationFrame, cancelAnimationFrame, window, document, localStorage, sessionStorage, location, MutationObserver, navigator, addEventListener, innerWidth, URL, URLSearchParams, Event, setInterval, setTimeout, fetch, AbortSignal */
(() => {
  const lang = localStorage.getItem("lang") || (navigator.language.startsWith("he") ? "he" : "en");
  const he = lang === "he";
  const T = (h, e) => (he ? (globalThis.kesherHebrew ? globalThis.kesherHebrew(h) : h) : e);
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

  // The home-screen widget's buttons open the phone's own screens (no computer needed), from any screen of the app.
  const WIDGET = { "#/phone/new": "local.html?new=1", "#/phone/live": "local.html?new=1&live=1", "#/phone/study": "local.html?tab=study", "#/phone/chats": "local.html?tab=chats" };
  const notify = window.Capacitor?.Plugins?.KesherNotify;
  const fromWidget = () => notify?.takeOpenPhone?.().then((r) => { const to = r && WIDGET[r.path]; if (to) location.href = to; }, () => undefined);
  void fromWidget();
  notify?.addListener?.("openPhone", () => void fromWidget());

  const css = document.createElement("style");
  css.textContent = `
    .kd-btn { position: fixed; bottom: max(18px, env(safe-area-inset-bottom)); right: 16px; z-index: 50; width: 56px; height: 56px; min-height: 56px; padding: 0; border-radius: 18px; border: 1px solid var(--border); background: rgb(31 31 34 / 0.86); backdrop-filter: blur(14px); color: var(--text); font-size: 22px; box-shadow: 0 10px 30px rgb(0 0 0 / .45); touch-action: none; }
    .kd-bar-btn { flex: none; width: 40px; height: 40px; display: grid; place-items: center; border: 0; border-radius: 10px; background: transparent; color: var(--text, #ededee); }
    .kd-bar-btn:active { background: rgb(255 255 255 / 0.08); }
    .kd-scrim { position: fixed; inset: 0; z-index: 60; background: rgb(0 0 0 / 0.35); opacity: 0; pointer-events: none; transition: opacity .16s; }
    /* Like the remote's menu: a panel under the top bar, at its start, above the bottom bar (not a full-height drawer). */
    .kd-panel { position: fixed; top: var(--kd-top, 64px); bottom: var(--kd-bottom, 12px); right: 12px; left: auto; z-index: 61; width: min(330px, calc(100vw - 72px)); display: flex; flex-direction: column; gap: 0; padding: 8px; background: #1e1e21; border: 1px solid #2c2d33; border-radius: 18px; box-shadow: 0 16px 40px rgb(0 0 0 / .5); opacity: 0; transform: translateY(-6px) scale(.98); transform-origin: top right; pointer-events: none; transition: opacity .16s, transform .16s cubic-bezier(.2,.9,.25,1); overflow-y: auto; overscroll-behavior: contain; touch-action: pan-y; }
    .kd-open .kd-scrim { opacity: 1; pointer-events: auto; }
    .kd-open .kd-panel { opacity: 1; transform: none; pointer-events: auto; }
    @media (prefers-reduced-motion: reduce) { .kd-panel { transition: opacity .1s; transform: none; } }
    /* The top bar already has the brand and the phone/computer switch. */
    .kd-in-bar .kd-brand, .kd-in-bar .kd-seg { display: none; }
    .kd-brand { display: flex; gap: 10px; align-items: center; font-size: 17px; font-weight: 500; padding: 6px 8px 8px; }
    .kd-brand .kd-state { margin-inline-start: auto; font-size: 12px; font-weight: 400; color: #f0b37e; }
    .kd-brand .kd-state.on { color: #7fd6a4; }
    .kd-seg { display: flex; background: #121213; border: 1px solid #2a2a2e; border-radius: 12px; padding: 3px; gap: 2px; margin: 2px 0 8px; }
    .kd-seg a { flex: 1; display: grid; place-items: center; height: 38px; border-radius: 9px; color: #c9c9ce; font-size: 14px; text-decoration: none; }
    .kd-seg a.on { background: #2e2e3a; color: var(--text); font-weight: 500; }
    /* Groups are parted by a line, like the remote's menu; the group's name stays small under it. */
    .kd-head { font-size: 12px; color: var(--muted); padding: 10px 12px 2px; margin: 6px 4px 0; border-top: 1px solid #2c2d33; }
    .kd-item { display: flex; align-items: center; gap: 14px; width: 100%; min-height: 48px; padding: 0 12px; border: 0; border-radius: 12px; background: transparent; color: var(--text, #ededee); font-size: 16px; text-align: start; text-decoration: none; transition: background .08s, transform .08s, color .08s; user-select: none; -webkit-user-select: none; }
    .kd-item:active { background: rgb(255 255 255 / 0.06); }
    .kd-item.on { background: #2a2a33; font-weight: 500; }
    .kd-item.kd-new { margin-bottom: 0; }
    .kd-ico svg { display: block; margin: 0 auto; stroke: #a9a9b0; }
    .kd-item.on .kd-ico svg { stroke: var(--accent); }
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
    .kd-foot { margin-top: auto; padding-top: 8px; }
    .kd-pcs { flex: none; display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; padding: 0 2px 8px; }
    .kd-pcs a { flex: none; display: inline-flex; align-items: center; height: 36px; padding: 0 12px; border-radius: 18px; border: 1px solid #2a2a2e; color: #c9c9ce; font-size: 13px; text-decoration: none; white-space: nowrap; }
    .kd-pcs a.on { border-color: var(--accent); color: var(--text); background: #2a2a33; }`;
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

  const brand = Object.assign(document.createElement("div"), { className: "kd-brand", innerHTML: `<img src="icon.svg" width="28" height="28" alt="" /> KesherAI <span class="kd-state"></span>` });
  const onPc = sessionStorage.getItem("kesherai-pc-ok") === "1";
  brand.querySelector(".kd-state").textContent = onPc ? T("● המחשב מחובר", "● Computer connected") : T("○ בטלפון", "○ On the phone");
  brand.querySelector(".kd-state").classList.toggle("on", onPc);
  panel.append(brand);
  // Where it runs, like the remote's menu: the computer (the saved one, or connecting one) or the phone.
  const seg = Object.assign(document.createElement("div"), { className: "kd-seg" });
  seg.setAttribute("role", "tablist");
  seg.innerHTML = `<a role="tab"></a><a role="tab"></a>`;
  const [segPc, segPhone] = seg.querySelectorAll("a");
  segPc.textContent = T("במחשב", "On the computer");
  segPc.href = saved ? "index.html" : "index.html?switch=1";
  segPhone.textContent = T("בטלפון", "On the phone");
  segPhone.href = "local.html";
  (here === "local.html" ? segPhone : segPc).classList.add("on");
  panel.append(seg);
  // The computers, as tabs at the top (asked 2026-11-16, like the computer's top bar): the one in use is marked; another
  // opens that computer (index.html?use=N tries its saved addresses). Only with two or more saved computers.
  if (computers.length > 1) {
    const inUse = (() => { try { return new URL(saved || "").searchParams.get("token") || ""; } catch { return ""; } })();
    const tabs = Object.assign(document.createElement("div"), { className: "kd-pcs" });
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", T("המחשבים שלי", "My computers"));
    computers.forEach((c, i) => {
      const a = document.createElement("a");
      a.setAttribute("role", "tab");
      const on = !!inUse && c.token === inUse && here !== "local.html";
      a.className = on ? "on" : "";
      a.setAttribute("aria-selected", String(on));
      a.href = `index.html?use=${i}`;
      a.textContent = c.name || T("מחשב", "Computer");
      a.dir = "auto";
      a.addEventListener("click", close);
      tabs.append(a);
    });
    panel.append(tabs);
  }
  const lastModel = localStorage.getItem("kesherai-phone-model");
  item("＋", T("צ'אט חדש", "New chat"), "", "local.html?new=1", "kd-new");
  item("⌂", T("בית", "Home"), "", "local.html", here === "local.html" && !params.toString() ? "on" : "");
  // The parts that work on the phone (the ones she keeps on in Settings), then what goes through the computer.
  head(T("בטלפון", "On the phone"));
  const parts = { study: true, voice: true, images: true, health: true, api: true, ...read("kesherai-phone-parts", {}) };
  const PHONE = [["study", "🎓", T("לימודים", "Study")], ["voice", "🎙", T("שיחה קולית", "Voice")], ["images", "🖼", T("תמונות", "Pictures")], ["health", "🩺", T("בריאות", "Health")], ["api", "🌐", T("דרך האינטרנט", "Online")]];
  for (const [id, icon, name] of PHONE) if (parts[id]) item(icon, name, "", `local.html?tab=${id}`, params.get("tab") === id ? "on" : "");
  head(T("דרך המחשב", "Through the computer"));
  if (!saved) item("🖥", T("להתחבר למחשב", "Connect to a computer"), T("קוד, מודלים גדולים, סריקות", "Code, big models, scans"), "index.html?switch=1");
  if (saved) {
    let host = saved;
    try {
      host = new URL(saved).host;
    } catch {
      // keep the raw text
    }
    item("🖥", T("הצ'אט במחשב", "Chat on my computer"), host, "index.html");
    // When the computer's KesherAI is stuck: restart it from here, then connect again by itself.
    const rs = document.createElement("button");
    rs.type = "button";
    rs.className = "kd-item";
    rs.innerHTML = `<span class="kd-ico" aria-hidden="true">🔄</span><span><span class="kd-label"></span><small></small></span>`;
    rs.querySelector(".kd-label").textContent = T("הפעל מחדש את KesherAI במחשב", "Restart KesherAI on the computer");
    rs.onclick = async () => {
      const small = rs.querySelector("small");
      try {
        const u = new URL(saved);
        const token = u.searchParams.get("token") || "";
        const r = await fetch(`${u.origin}/api/system/restart?token=${encodeURIComponent(token)}`, { method: "POST", signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error(((await r.json().catch(() => ({}))).error) || String(r.status));
        small.textContent = T("מפעיל מחדש… אתחבר שוב בעוד רגע", "Restarting… connecting again in a moment");
        setTimeout(() => { location.href = "index.html"; }, 15000);
      } catch (e) {
        small.textContent = T("המחשב לא ענה: ", "The computer did not answer: ") + (e.message || e);
      }
    };
    add(rs);
  }

  // Updates before the chats (asked for 2026-11-16: it was lost at the bottom under a long list).
  item("⬆", T("בדיקת עדכונים", "Check for updates"), "", here === "local.html" || !localStorage.getItem("kesherai-server") ? "local.html?tab=settings" : "index.html?switch=1&update=1");
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
  item("📱", T("מודלים בטלפון ו-API", "Models on this phone and API"), "", "local.html?tab=chat", params.get("tab") === "chat" ? "on" : "");
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
  // App lock (F14): the phone's own fingerprint, face or screen lock opens KesherAI (after a minute away).
  const LLM = window.Capacitor?.Plugins?.KesherLlm;
  if (LLM?.lockState) {
    const lock = document.createElement("button");
    lock.type = "button";
    lock.className = "kd-item";
    const paintLock = async () => {
      const st = await LLM.lockState().catch(() => ({ on: false, available: false }));
      lock.innerHTML = `<span class="kd-ico" aria-hidden="true">🔒</span><span><span class="kd-label"></span><small></small></span><span class="kd-switch ${st.on ? "on" : ""}" aria-hidden="true"></span>`;
      lock.querySelector(".kd-label").textContent = T("נעילה בטביעת אצבע", "Fingerprint lock");
      lock.querySelector("small").textContent = !st.available ? T("צריך נעילת מסך בטלפון", "Needs a screen lock on the phone") : st.on ? T("פועל: נפתח בטביעת אצבע", "On: opens with your fingerprint") : T("כבוי", "Off");
      lock.setAttribute("aria-pressed", String(!!st.on));
      lock.disabled = !st.available;
      lock.dataset.on = st.on ? "1" : "0";
    };
    lock.onclick = async () => {
      try {
        // Turning it on or off needs the lock itself first, so someone else holding the phone cannot turn it off.
        await LLM.unlock();
        await LLM.setLock({ on: lock.dataset.on !== "1" });
      } catch {
        /* cancelled */
      }
      void paintLock();
    };
    void paintLock();
    add(lock);
  }
  item("🔗", T("המחשבים שלי", "My computers"), computers.length ? T(`${computers.length} שמורים`, `${computers.length} saved`) : "", "index.html?switch=1", here === "index.html" ? "on" : "");
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

  // The design doc's line icons instead of colour emoji (same set as the bottom bar).
  const SVG = (d) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICONS = {
    "＋": '<path d="M12 5v14M5 12h14"/>',
    "⌂": '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
    "🎓": '<path d="M22 10 12 5 2 10l10 5 10-5z"/><path d="M6 12v5c3 2 9 2 12 0v-5"/>',
    "🎙": '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    "🖼": '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
    "🩺": '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z"/>',
    "🌐": '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    "🖥": '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    "🔄": '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    "💬": '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    "📱": '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
    "🔒": '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    "🔗": '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    "⬆": '<path d="M12 19V5M6 11l6-6 6 6"/>',
  };
  const lineIcons = () => panel.querySelectorAll(".kd-ico").forEach((i) => { const d = ICONS[i.textContent.trim()]; if (d) i.innerHTML = SVG(d); });
  lineIcons();
  // Rows drawn again later (web search, lock) keep the line icons.
  new MutationObserver(lineIcons).observe(panel, { childList: true, subtree: true });
  document.body.append(root);

  // ---------- press ☰, slide, let go (Apple-style); a tap just opens ----------
  const itemAt = (x, y) => document.elementFromPoint(x, y)?.closest?.("[data-kd]") ?? null;
  const pressAndSlide = (button) => {
    button.style.touchAction = "none";
    button.style.userSelect = "none";
    button.setAttribute("draggable", "false");
    let active = null;
    // Holding the finger near the menu's top or bottom edge scrolls it (faster closer to the edge), like iOS.
    const EDGE = 64;
    const scroll = () => {
      if (!active) return;
      const r = panel.getBoundingClientRect();
      const { lx: x, ly: y } = active;
      const down = y - (r.bottom - EDGE);
      const up = r.top + EDGE - y;
      const step = down > 0 ? Math.min(18, 2 + down / 4) : up > 0 ? -Math.min(18, 2 + up / 4) : 0;
      if (step && x >= r.left - 40 && x <= r.right + 40) {
        const before = panel.scrollTop;
        panel.scrollTop += step;
        if (panel.scrollTop !== before) track(x, y);
      }
      active.raf = requestAnimationFrame(scroll);
    };
    const begin = (x, y) => {
      active = { x, y, lx: x, ly: y, moved: false, wasOpen: isOpen() };
      open();
      active.raf = requestAnimationFrame(scroll);
    };
    const track = (x, y) => {
      if (!active) return;
      active.lx = x;
      active.ly = y;
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
      const { moved, wasOpen, raf } = active;
      cancelAnimationFrame(raf);
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

  // One menu button in the top bar of every screen, at its start (like the computer's and the remote's top bar).
  // A page with no top bar keeps the floating button (above a chat's message box).
  const own = document.getElementById("menu");
  if (own) own.hidden = true;
  const bar = document.querySelector("body > header, .wbar");
  const b = Object.assign(document.createElement("button"), { className: bar ? "kd-bar-btn" : "kd-btn", type: "button" });
  b.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10"/></svg>';
  b.setAttribute("aria-label", T("תפריט", "Menu"));
  b.title = T("תפריט", "Menu");
  pressAndSlide(b);
  if (bar) {
    bar.prepend(b);
    // The panel opens under the bar and stops above the bottom bar.
    root.classList.add("kd-in-bar");
    const fit = () => {
      document.documentElement.style.setProperty("--kd-top", `${Math.round(bar.getBoundingClientRect().bottom + 6)}px`);
      const tabs = document.getElementById("appTabs");
      document.documentElement.style.setProperty("--kd-bottom", `${tabs && !tabs.hidden ? Math.round(document.documentElement.clientHeight - tabs.getBoundingClientRect().top + 8) : 12}px`);
    };
    fit();
    addEventListener("resize", fit);
    b.addEventListener("pointerdown", fit, true);
  }
  else {
    document.body.append(b);
    const place = () => {
      const foot = document.getElementById("chatFoot");
      const h = foot && !foot.hidden ? foot.getBoundingClientRect().height : 0;
      b.style.bottom = h ? `${h + 12}px` : "";
    };
    place();
    setInterval(place, 400);
  }

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
    // Files: the chat on the phone (the computer's page takes them when the last chat was there, above).
    const text = [s.subject, s.text].filter(Boolean).join("\n");
    if (text) sessionStorage.setItem("kesherai-shared-text", text);
    // Pictures and files shared from another app (a screenshot, a photo of a page): the phone's chat takes them, with
    // the lens's quick actions (explain, translate, summarize, text) — the phone's own "screen lens".
    if (s.files?.length) sessionStorage.setItem("kesherai-shared-files", JSON.stringify(s.files.slice(0, 10)));
    const target = s.action === "new" ? "local.html?new=1" : s.action === "talk" ? "local.html?chat=1&talk=1" : s.action === "photo" ? "local.html?chat=1&photo=1" : "local.html?chat=1";
    location.href = target;
  };
  if (Share) {
    void toPhone();
    Share.addListener("shared", () => void toPhone());
  }
})();
