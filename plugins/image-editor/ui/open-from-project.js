/* global window, document, setTimeout, IntersectionObserver, URL, Blob */
// "Open from project" (WORK_LIST "Editors pull assets from Unity and Unreal projects", Roee 2026-11-22): pick a Unity or
// Unreal project found on the computer, browse its assets of this editor's kinds (search, folders, thumbnails of small
// pictures), open one; then "Save to project" puts the edited file back (over the original or as a new asset next to
// it) after an approval card, and only the computer can approve (from the phone it waits for it). Unreal assets are
// exported by the KesherAI Bridge plugin in the background. Each editor has its own copy of this file.

const kesher = window.kesher;
const ICON = { model: "🧊", image: "🖼", audio: "🎵", video: "🎬" };
const size = (n) => (n > 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

let he = false;
/** Hebrew or English for this module's words. */
export function setHebrew(on) { he = on; }
const T = (h, e) => (he ? h : e);

const css = `
.op-pick{border:1px solid #33343a;border-radius:14px;background:#1a1a1d;color:#ededee;padding:0;width:min(640px,calc(100vw - 16px));max-height:calc(100vh - 24px);font:14px system-ui,sans-serif}
.op-pick::backdrop{background:#0008}
.op-pick header{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 12px;border-bottom:1px solid #2a2a2e}
.op-pick header b{flex:1;min-width:120px}
.op-pick select,.op-pick input{height:34px;border-radius:8px;border:1px solid #33343a;background:#121213;color:inherit;padding:0 8px;min-width:0;font:inherit}
.op-pick .op-row{display:flex;gap:8px;padding:8px 12px;flex-wrap:wrap}
.op-pick .op-row input{flex:1 1 160px}.op-pick .op-row select{flex:1 1 140px;max-width:100%}
.op-pick .op-note{margin:0 12px 6px;padding:8px 10px;border-radius:9px;background:#2a2412;color:#f0c674;font-size:13px}
.op-pick .op-note:empty{display:none}
.op-pick ul{list-style:none;margin:0;padding:6px 8px 10px;overflow:auto;max-height:calc(100vh - 230px)}
.op-pick li button{display:flex;width:100%;gap:10px;align-items:center;padding:7px 8px;border:0;border-radius:9px;background:none;color:inherit;font:inherit;text-align:start;cursor:pointer;min-height:48px}
.op-pick li button:hover,.op-pick li button:focus-visible{background:#2a2d3e;outline:none}
.op-pick .op-th{width:40px;height:40px;flex:none;border-radius:6px;background:#121213 center/cover no-repeat;display:grid;place-items:center;font-size:20px}
.op-pick .op-n{flex:1;min-width:0;display:flex;flex-direction:column}
.op-pick .op-n span,.op-pick .op-n small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.op-pick small{color:#8d8d95;font-size:12px}
.op-pick .op-busy{padding:22px 14px;text-align:center;color:#c9c9cf}
.op-save{position:fixed;z-index:55;inset-inline-start:50%;bottom:14px;transform:translateX(-50%);display:flex;gap:6px;align-items:center;max-width:calc(100vw - 16px);padding:6px 6px 6px 12px;border-radius:999px;background:#1e1e22;border:1px solid #33343a;box-shadow:0 8px 24px #0008;color:#ededee;font:13px system-ui,sans-serif}
[dir=rtl] .op-save{transform:translateX(50%)}
@media (max-width:700px){.op-save{bottom:auto;top:104px}}
.op-save span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.op-save button,.op-card button{border:0;border-radius:999px;padding:8px 12px;min-height:36px;background:#3b4bd8;color:#fff;font:inherit;cursor:pointer;white-space:nowrap}
.op-save button.x{background:none;color:#8d8d95;padding:8px}
.op-card{border:1px solid #33343a;border-radius:14px;background:#1a1a1d;color:#ededee;width:min(440px,calc(100vw - 24px));font:14px system-ui,sans-serif;padding:16px}
.op-card::backdrop{background:#0008}
.op-card h3{margin:0 0 8px;font-size:16px}
.op-card p{margin:6px 0;color:#c9c9cf;overflow-wrap:anywhere}
.op-card code{direction:ltr;unicode-bidi:embed;color:#ededee}
.op-card .op-acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.op-card button.ghost{background:#2a2a2e;color:#ededee}
`;
let styled = false;
function style() {
  if (styled) return;
  styled = true;
  const s = document.createElement("style");
  s.textContent = css;
  document.head.append(s);
}
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const folderOf = (p) => p.split("/").slice(0, -1).join("/");
const oldPlugin = () => T("עדכן את התוסף כדי לפתוח את זה (KesherAI Bridge 0.1.33 ומעלה: עמוד Unreal ← עדכון התוסף).", "Update the plugin to open this (KesherAI Bridge 0.1.33+: the Unreal page → Update the plugin).");

/**
 * The project asset browser: a project, then its assets of these kinds; the chosen one is read (an Unreal asset is
 * exported by the plugin first, which can take a minute the first time).
 *
 * @param kinds - The kinds this editor takes ("model", "image", "audio", "video").
 * @returns `{ name, format, bytes }` or, for a Unity prefab, `{ name, prefab }` (its objects), each with `asset`
 *   (`{ engine, project, projectName, path, ext, className }`, for "Save to project"); undefined when closed.
 */
export async function openFromProject(kinds) {
  style();
  const projects = await kesher.call("project.list").catch(() => []);
  return new Promise((resolve) => {
    const d = el("dialog", "op-pick");
    d.setAttribute("aria-label", T("פתיחה מפרויקט משחק", "Open from a game project"));
    const head = el("header");
    const title = el("b", "", `🎮 ${T("פתיחה מפרויקט משחק", "Open from a game project")}`);
    const close = el("button", "", "✕");
    close.type = "button";
    close.setAttribute("aria-label", T("סגור", "Close"));
    close.style.cssText = "border:0;background:none;color:inherit;font-size:18px;min-width:40px;min-height:40px;cursor:pointer";
    head.append(title, close);
    const row = el("div", "op-row");
    const pick = el("select");
    pick.setAttribute("aria-label", T("פרויקט", "Project"));
    const q = el("input");
    q.type = "search";
    q.placeholder = T("חיפוש…", "Search…");
    q.setAttribute("aria-label", T("חיפוש", "Search"));
    const folder = el("select");
    folder.setAttribute("aria-label", T("תיקייה", "Folder"));
    row.append(pick, q, folder);
    const note = el("p", "op-note");
    const ul = el("ul");
    d.append(head, row, note, ul);
    let items = [];
    let project = null;
    let done = false;
    let loadingId = 0;
    const finish = (v) => { if (done) return; done = true; observer.disconnect(); d.close(); d.remove(); resolve(v); };
    const busyLine = (text) => { ul.replaceChildren(el("li", "op-busy", text)); };

    if (!projects.length) {
      pick.hidden = q.hidden = folder.hidden = true;
      busyLine(T("לא נמצאו פרויקטים של Unity או Unreal במחשב. פתח פרויקט פעם אחת במנוע שלו.", "No Unity or Unreal projects were found on the computer. Open a project once in its engine."));
    }
    for (const p of projects) {
      const o = el("option", "", `${p.engine === "unity" ? "Unity" : "Unreal"} · ${p.name}`);
      o.value = `${p.engine}|${p.path}`;
      pick.append(o);
    }

    // Thumbnails of small pictures, read when their row comes into view, one at a time.
    const waiting = [];
    let reading = false;
    const readNext = async () => {
      if (reading || !waiting.length) return;
      reading = true;
      const { box, it, proj } = waiting.shift();
      try {
        const r = await kesher.call("project.read", { engine: proj.engine, project: proj.path, path: it.path });
        if (proj === project && r.bytes) {
          box.style.backgroundImage = `url(${URL.createObjectURL(new Blob([r.bytes]))})`;
          box.textContent = "";
        }
      } catch { /* the icon stays */ }
      reading = false;
      void readNext();
    };
    const observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        observer.unobserve(e.target);
        const it = e.target._item;
        if (it?.thumb) { waiting.push({ box: e.target, it, proj: project }); void readNext(); }
      }
    }, { root: ul });

    const draw = () => {
      ul.replaceChildren();
      observer.disconnect();
      waiting.length = 0;
      const words = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const f = folder.value;
      const shown = items.filter((it) => (!f || it.path.startsWith(`${f}/`)) && words.every((w) => it.path.toLowerCase().includes(w))).slice(0, 400);
      if (!shown.length) { busyLine(items.length ? T("לא נמצא", "Nothing found") : T("אין כאן נכסים מהסוג הזה", "No assets of this kind here")); return; }
      for (const it of shown) {
        const li = el("li");
        const b = el("button");
        b.type = "button";
        const th = el("span", "op-th", it.prefab ? "🧩" : ICON[it.kind] ?? "📄");
        th._item = it;
        const n = el("span", "op-n");
        const nm = el("span", "", it.name);
        nm.dir = "auto";
        const sub = el("small", "", `${folderOf(it.path)} · ${it.prefab ? T("פריפאב", "prefab") : it.className ?? it.ext.toUpperCase()} · ${size(it.size)}`);
        sub.dir = "ltr";
        n.append(nm, sub);
        b.append(th, n);
        b.title = it.path;
        b.onclick = () => void choose(it);
        li.append(b);
        ul.append(li);
        if (it.thumb) observer.observe(th);
      }
    };

    const load = async () => {
      const [engine, ...rest] = pick.value.split("|");
      const proj = projects.find((p) => p.engine === engine && p.path === rest.join("|"));
      if (!proj) return;
      project = proj;
      void kesher.call("storage.set", { key: "projectAssets.last", value: pick.value }).catch(() => undefined);
      items = [];
      note.textContent = proj.engine !== "unreal" ? "" : proj.canExport ? T("נכסי Unreal נקראים עם Unreal ברקע (בפעם הראשונה עד דקה או שתיים).", "Unreal assets are read with Unreal in the background (the first time takes up to a minute or two).") : oldPlugin();
      busyLine(T("קורא את הנכסים…", "Reading the assets…"));
      const id = ++loadingId;
      try {
        const r = await kesher.call("project.assets", { engine: proj.engine, project: proj.path, kinds });
        if (id !== loadingId) return;
        items = r.items ?? [];
        if (r.partial) note.textContent = `${note.textContent ? `${note.textContent} ` : ""}${T("פרויקט גדול: מוצג חלק מהנכסים. חפש בשם כדי לצמצם.", "A big project: some assets are shown. Search by name to narrow it.")}`;
        const folders = [...new Set(items.map((it) => folderOf(it.path)))].sort();
        folder.replaceChildren(el("option", "", T("כל התיקיות", "All folders")), ...folders.map((f) => { const o = el("option", "", f); o.value = f; return o; }));
        folder.firstChild.value = "";
        draw();
      } catch (e) {
        if (id === loadingId) busyLine(e.message || String(e));
      }
    };

    const choose = async (it) => {
      const proj = project;
      if (proj.engine === "unreal" && it.export && !proj.canExport) { note.textContent = oldPlugin(); return; }
      busyLine(proj.engine === "unreal" && it.export ? T("קורא עם Unreal ברקע… (בפעם הראשונה זה לוקח עד דקה או שתיים)", "Reading with Unreal in the background… (the first time takes up to a minute or two)") : T("פותח…", "Opening…"));
      row.inert = true;
      try {
        const r = await kesher.call("project.read", { engine: proj.engine, project: proj.path, path: it.path });
        const asset = { engine: proj.engine, project: proj.path, projectName: proj.name, path: it.path, ext: it.ext, kind: it.kind, ...(it.className ? { className: it.className } : {}) };
        finish(r.prefab ? { name: it.name, prefab: r.prefab, asset } : { name: `${it.name}.${r.format || it.ext}`, format: r.format || it.ext, bytes: r.bytes, asset });
      } catch (e) {
        row.inert = false;
        busyLine(e.code === "plugin-old" ? oldPlugin() : e.message || String(e));
      }
    };

    pick.onchange = () => void load();
    q.oninput = draw;
    folder.onchange = draw;
    close.onclick = () => finish(undefined);
    d.addEventListener("close", () => finish(undefined));
    document.body.append(d);
    d.showModal();
    if (projects.length) {
      kesher.call("storage.get", { key: "projectAssets.last" }).catch(() => undefined).then((last) => {
        if (last && projects.some((p) => `${p.engine}|${p.path}` === last)) pick.value = last;
        void load();
        q.focus();
      });
    }
  });
}

let bar = null;

/**
 * Shows "Save to project" for an asset opened from a project (one at a time; opening something else replaces it).
 *
 * @param asset - From openFromProject.
 * @param format - What this editor saves ("glb", "png" or "wav").
 * @param make - Makes the file: `async () => ArrayBuffer`.
 */
export function offerSave(asset, format, make) {
  style();
  bar?.remove();
  bar = el("div", "op-save");
  bar.setAttribute("role", "region");
  bar.setAttribute("aria-label", T("שמירה לפרויקט", "Save to project"));
  const label = el("span", "", `🎮 ${asset.projectName} · ${asset.path.split("/").pop()}`);
  label.dir = "auto";
  const save = el("button", "", T("שמור לפרויקט", "Save to project"));
  save.type = "button";
  const x = el("button", "x", "✕");
  x.type = "button";
  x.setAttribute("aria-label", T("הסתר", "Hide"));
  x.onclick = () => { bar?.remove(); bar = null; };
  save.onclick = () => void saveCard(asset, format, make);
  bar.append(label, save, x);
  document.body.append(bar);
}

/** Removes "Save to project" (the editor opened something that is not from a project). */
export function clearSave() { bar?.remove(); bar = null; }

/**
 * The save's approval card: over the original (when the format allows) or a new asset; the file is sent, then the
 * card says where it goes and that a checkpoint is kept, and the computer approves it (the phone waits for it).
 */
async function saveCard(asset, format, make) {
  const canReplace = !asset.prefab && (asset.engine === "unreal" || asset.ext === format);
  const d = el("dialog", "op-card");
  const h = el("h3", "", T("שמירה לפרויקט", "Save to project"));
  const p = el("p");
  const acts = el("div", "op-acts");
  d.append(h, p, acts);
  document.body.append(d);
  const button = (text, run, ghost) => { const b = el("button", ghost ? "ghost" : "", text); b.type = "button"; b.onclick = run; acts.append(b); return b; };
  const end = () => { d.close(); d.remove(); };
  d.addEventListener("close", () => d.remove());
  const step1 = () => {
    acts.replaceChildren();
    p.replaceChildren(document.createTextNode(`${asset.projectName}: `), el("code", "", asset.path));
    if (!canReplace) p.append(el("br"), document.createTextNode(T(`העורך שומר ${format.toUpperCase()}, אז זה יישמר כנכס חדש ליד המקורי.`, `This editor saves ${format.toUpperCase()}, so it goes in as a new asset next to the original.`)));
    if (canReplace) button(T("שמור מעל המקורי", "Save over the original"), () => void send("replace"));
    button(T("שמור כנכס חדש", "Save as new asset"), () => void send("new"), canReplace);
    button(T("ביטול", "Cancel"), end, true);
  };
  const send = async (mode) => {
    acts.replaceChildren();
    p.textContent = T("שולח…", "Sending…");
    try {
      const bytes = await make();
      const r = await kesher.call("project.save", { engine: asset.engine, project: asset.project, path: asset.path, mode, bytes });
      card(r.save, r.canApprove);
    } catch (e) { p.textContent = e.message || String(e); button(T("סגור", "Close"), end, true); }
  };
  const card = (s, canApprove) => {
    acts.replaceChildren();
    p.replaceChildren(
      document.createTextNode(s.mode === "replace" ? T("כותב מעל: ", "Writes over: ") : T("נכס חדש: ", "New asset: ")), el("code", "", s.target), el("br"),
      document.createTextNode(`${T("נקודת שחזור של מה שיש שם נשמרת קודם (פרויקטי משחק ← נקודות שחזור).", "A checkpoint of what is there is kept first (Game projects → Checkpoints).")} ${asset.engine === "unreal" ? T("Unreal מייבא אותו ברקע.", "Unreal imports it in the background.") : T("Unity יטען אותו כשיחזור לפוקוס; קובצי ה-.meta והחומרים לא משתנים.", "Unity reimports it when it gets focus; .meta files and materials are not touched.")}`),
    );
    if (canApprove) {
      button(T("אשר ושמור", "Approve and save"), async () => {
        acts.replaceChildren();
        p.textContent = asset.engine === "unreal" ? T("מייבא עם Unreal ברקע…", "Importing with Unreal in the background…") : T("שומר…", "Saving…");
        try { result((await kesher.call("project.approve", { id: s.id })).save); } catch (e) { p.textContent = e.message || String(e); button(T("סגור", "Close"), end, true); }
      });
      button(T("בטל", "Discard"), async () => { await kesher.call("project.discard", { id: s.id }).catch(() => undefined); end(); }, true);
      return;
    }
    // From the phone: the computer approves; this card follows the save until it is done.
    p.append(el("br"), el("b", "", T("מחכה לאישור במחשב (פרויקטי משחק).", "Waiting for the computer to approve (Game projects).")));
    button(T("בטל את השמירה", "Discard the save"), async () => { await kesher.call("project.discard", { id: s.id }).catch(() => undefined); end(); }, true);
    const poll = async () => {
      if (!d.isConnected) return;
      const r = await kesher.call("project.saveStatus", { id: s.id }).catch(() => null);
      if (r?.save && r.save.state !== "pending" && r.save.state !== "working") return result(r.save);
      setTimeout(poll, 3000);
    };
    setTimeout(poll, 3000);
  };
  const result = (s) => {
    acts.replaceChildren();
    p.textContent = s.state === "done" ? T(`נשמר: ${s.target}`, `Saved: ${s.target}`) : s.state === "discarded" ? T("השמירה בוטלה.", "The save was discarded.") : `${T("השמירה נכשלה", "The save failed")}: ${/Unknown command: asset_/.test(s.error ?? "") ? oldPlugin() : s.error ?? ""}`;
    button(T("סגור", "Close"), end);
  };
  step1();
  d.showModal();
}
