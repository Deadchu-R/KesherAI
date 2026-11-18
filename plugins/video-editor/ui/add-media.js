/* global window, document, addEventListener, removeEventListener, innerWidth, innerHeight */
// The editors' "Add" (RESEARCH_LOG "Adding files and objects to the editors, and one bank of everything the AI made"):
// one menu with the same places in every editor: from the computer / phone, from this chat, from the bank of
// everything made, and the editor's own "create here" items. Each editor has its own copy of this file.

const kesher = window.kesher;
const ICON = { image: "🖼", video: "🎬", audio: "🎵", model: "🧊" };
const size = (n) => (n > 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

let he = false;
/** Hebrew or English for the menu's own words. */
export function setHebrew(on) { he = on; }
const T = (h, e) => (he ? h : e);

const css = `
.am-menu{position:fixed;z-index:60;min-width:230px;max-width:calc(100vw - 16px);background:#1e1e22;border:1px solid #33343a;border-radius:12px;padding:6px;box-shadow:0 12px 30px #0009;color:#ededee;font:14px system-ui,sans-serif}
.am-menu .am-t{color:#8d8d95;font-size:12px;padding:4px 10px 6px}
.am-menu button{display:flex;width:100%;align-items:center;gap:10px;padding:8px 10px;border:0;border-radius:8px;background:none;color:inherit;font:inherit;text-align:start;cursor:pointer}
.am-menu button:hover,.am-menu button:focus-visible{background:#2a2d3e;outline:none}
.am-menu small{color:#8d8d95;margin-inline-start:auto;font-size:12px}
.am-menu hr{border:0;height:1px;background:#2a2a2e;margin:5px 4px}
.am-pick{border:1px solid #33343a;border-radius:14px;background:#1a1a1d;color:#ededee;padding:0;width:min(560px,calc(100vw - 24px));max-height:min(620px,calc(100vh - 40px))}
.am-pick::backdrop{background:#0008}
.am-pick header{display:flex;gap:8px;align-items:center;padding:12px 14px;border-bottom:1px solid #2a2a2e}
.am-pick header input{flex:1;min-width:0;height:32px;border-radius:8px;border:1px solid #33343a;background:#121213;color:inherit;padding:0 10px}
.am-pick ul{list-style:none;margin:0;padding:8px;overflow:auto;max-height:calc(min(620px,100vh - 40px) - 60px)}
.am-pick li button{display:flex;width:100%;gap:10px;align-items:center;padding:9px 10px;border:0;border-radius:9px;background:none;color:inherit;font:inherit;text-align:start;cursor:pointer}
.am-pick li button:hover{background:#2a2d3e}
.am-pick li span.n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.am-pick li small{color:#8d8d95}
@media (pointer:coarse){.am-menu{left:0!important;right:0!important;bottom:0!important;top:auto!important;border-radius:18px 18px 0 0;max-width:none}.am-menu button{padding:12px}}
`;
let styled = false;
function style() {
  if (styled) return;
  styled = true;
  const s = document.createElement("style");
  s.textContent = css;
  document.head.append(s);
}

/**
 * Opens the Add menu under a button.
 *
 * @param anchor - The button it opens from.
 * @param title - The small line at its top (where the new thing lands).
 * @param items - `{ icon, label, hint?, run }`, or `"-"` for a line.
 */
export function openMenu(anchor, title, items) {
  style();
  document.querySelector(".am-menu")?.remove();
  const m = document.createElement("div");
  m.className = "am-menu";
  m.setAttribute("role", "menu");
  m.innerHTML = `<div class="am-t"></div>`;
  m.firstChild.textContent = title;
  for (const it of items) {
    if (it === "-") { m.append(document.createElement("hr")); continue; }
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.innerHTML = `<span></span><span></span><small></small>`;
    b.children[0].textContent = it.icon;
    b.children[1].textContent = it.label;
    b.children[2].textContent = it.hint ?? "";
    b.onclick = () => { m.remove(); it.run(); };
    m.append(b);
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const w = m.offsetWidth;
  m.style.top = `${Math.min(r.bottom + 6, innerHeight - m.offsetHeight - 8)}px`;
  m.style.left = `${Math.max(8, Math.min(document.dir === "rtl" ? r.right - w : r.left, innerWidth - w - 8))}px`;
  m.querySelector("button")?.focus();
  const close = (e) => { if (!m.contains(e.target) && e.target !== anchor) { m.remove(); removeEventListener("pointerdown", close, true); } };
  addEventListener("pointerdown", close, true);
  m.addEventListener("keydown", (e) => { if (e.key === "Escape") { m.remove(); anchor.focus(); } });
}

/**
 * A file from the computer or the phone.
 *
 * @param accept - The input's accept list.
 * @param multiple - Several at once.
 * @returns The chosen files (empty when none).
 */
export function pickDevice(accept, multiple = true) {
  return new Promise((resolve) => {
    const i = document.createElement("input");
    i.type = "file";
    i.accept = accept;
    i.multiple = multiple;
    i.onchange = () => resolve([...(i.files ?? [])]);
    i.addEventListener("cancel", () => resolve([]));
    i.click();
  });
}

/**
 * Chooses a file from this chat or from the bank (a list to search).
 *
 * @param from - `"chat"` or `"bank"`.
 * @param kinds - The kinds this editor takes (image, video, audio, model).
 * @returns `{ id, name, kind }`, or undefined when closed.
 */
export async function pickMedia(from, kinds) {
  style();
  const lists = await Promise.all(kinds.map((kind) => kesher.call("media.list", { from, kind }).catch(() => [])));
  const all = lists.flat().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return new Promise((resolve) => {
    const d = document.createElement("dialog");
    d.className = "am-pick";
    d.innerHTML = `<header><b></b><input type="search" /><button type="button">✕</button></header><ul></ul>`;
    d.querySelector("b").textContent = from === "bank" ? T("🗂 מבנק היצירות", "🗂 From everything made") : T("💬 מהקבצים של הצ׳אט", "💬 From this chat's files");
    const q = d.querySelector("input");
    q.placeholder = T("חיפוש…", "Search…");
    q.setAttribute("aria-label", T("חיפוש", "Search"));
    d.querySelector("header button").setAttribute("aria-label", T("סגור", "Close"));
    const ul = d.querySelector("ul");
    let done = false;
    const finish = (v) => { if (done) return; done = true; d.close(); d.remove(); resolve(v); };
    const draw = () => {
      ul.replaceChildren();
      const words = q.value.trim().toLowerCase();
      const shown = all.filter((x) => !words || `${x.name} ${x.prompt ?? ""} ${x.chat?.title ?? ""}`.toLowerCase().includes(words)).slice(0, 300);
      if (!shown.length) {
        const li = document.createElement("li");
        li.style.cssText = "padding:14px;color:#8d8d95";
        li.textContent = all.length ? T("לא נמצא", "Nothing found") : from === "bank" ? T("עוד אין כאן קבצים מהסוג הזה", "Nothing of this kind yet") : T("בצ׳אט הזה עוד אין קבצים מהסוג הזה", "This chat has no files of this kind yet");
        ul.append(li);
      }
      for (const x of shown) {
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button";
        b.innerHTML = `<span></span><span class="n" dir="auto"></span><small dir="auto"></small>`;
        b.children[0].textContent = ICON[x.kind] ?? "📄";
        b.children[1].textContent = x.name;
        b.children[1].title = x.prompt ?? x.name;
        b.children[2].textContent = `${size(x.size)}${x.chat ? ` · ${x.chat.title}` : ""}`;
        b.onclick = () => finish(x);
        li.append(b);
        ul.append(li);
      }
    };
    q.oninput = draw;
    d.querySelector("header button").onclick = () => finish(undefined);
    d.addEventListener("close", () => finish(undefined));
    document.body.append(d);
    draw();
    d.showModal();
    q.focus();
  });
}

/**
 * Brings a chosen item into this chat (a bank item is copied into its folder) and reads its bytes.
 *
 * @param item - From pickMedia.
 * @returns `{ path, bytes }`: its path in this chat and its bytes.
 */
export async function takeMedia(item) {
  // Opened without a chat: the bank's file is read as it is (nothing to copy it into).
  const info = await kesher.call("info").catch(() => ({}));
  if (!info.conversationId) return { path: undefined, bytes: await kesher.call("media.bytes", { id: item.id }) };
  const { path } = await kesher.call("media.take", { id: item.id });
  const bytes = await kesher.call("media.bytes", { id: `chat:${path}` });
  return { path, bytes };
}

/**
 * Puts a file from the device into this chat.
 *
 * @param file - The File.
 * @returns `{ path, bytes }`.
 */
export async function uploadMedia(file) {
  const bytes = await file.arrayBuffer();
  const info = await kesher.call("info").catch(() => ({}));
  // Opened without a chat: the file is used here only (there is no chat folder to keep it in).
  if (!info.conversationId) return { path: undefined, bytes };
  // The bridge transfers a copy, so the bytes stay readable here.
  const { path } = await kesher.call("media.upload", { name: file.name, bytes: bytes.slice(0) });
  return { path, bytes };
}
