/* global window, document, addEventListener, crypto, File, URL, setTimeout */
// Opening files from the computer or the phone, the same in every editor (RESEARCH_LOG "editors open files"):
// an Open… button and Ctrl/Cmd+O, files dropped on the work area, the last 10 files opened, a type and size check
// with plain-words errors, a chunked copy into the chat's folder (so Recent can reopen it, and the PC has it when the
// page runs on the phone), and "Save as…". Each editor has its own copy of this file (a change goes into every copy);
// the editor passes what to do with the files. The pure parts (checks, recent list) have no browser needs.

/** What each editor kind may open: extensions, lower case. A model's `bin` and `mtl` ride along as parts. */
export const TYPES = {
  model: ["glb", "gltf", "fbx", "obj", "stl", "ply"],
  part: ["bin", "mtl"],
  image: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
  audio: ["wav", "mp3", "ogg", "opus", "flac", "m4a", "aac"],
  video: ["mp4", "webm", "mov", "m4v", "mkv"],
};
const MB = 1024 ** 2;
/** The largest file each kind may be, in bytes (what a page can hold; the server's own limit is 1 GB). */
export const LIMITS = { model: 300 * MB, part: 300 * MB, image: 100 * MB, audio: 300 * MB, video: 1024 * MB };
/** How many files Recent keeps. */
export const RECENT_MAX = 10;
const PIECE = 8 * MB;

let he = false;
const T = (h, e) => (he ? h : e);
const wired = new Set();

/**
 * Hebrew or English for this module's own words (buttons, menus, errors).
 *
 * @param on - True for Hebrew.
 */
export function setHebrew(on) {
  he = on;
  for (const fn of wired) fn();
}

/**
 * A file name's extension, lower case.
 *
 * @param name - The file name.
 * @returns The extension without the dot ("" when none).
 */
export function extOf(name) { return (/\.([^./\\]+)$/.exec(String(name))?.[1] ?? "").toLowerCase(); }

/**
 * Which kind a file name belongs to.
 *
 * @param name - The file name.
 * @returns `model`, `part`, `image`, `audio` or `video`; null for a type nobody here opens.
 */
export function kindOfName(name) {
  const e = extOf(name);
  return Object.keys(TYPES).find((k) => TYPES[k].includes(e)) ?? null;
}

/**
 * The `accept` list of a file picker.
 *
 * @param kinds - The kinds an editor opens.
 * @returns ".glb,.gltf,…".
 */
export function acceptOf(kinds) { return kinds.flatMap((k) => TYPES[k] ?? []).map((e) => `.${e}`).join(","); }

/**
 * Whether a file may be opened in an editor: its type is one the editor takes, it is not empty, not over its kind's limit.
 *
 * @param name - The file's name.
 * @param size - Its size in bytes.
 * @param kinds - The kinds the editor takes.
 * @returns `{ ok: true, kind }`, or `{ ok: false, why: "type" | "empty" | "big", kind?, limit? }`.
 */
export function checkOpen(name, size, kinds) {
  const kind = kindOfName(name);
  if (!kind || !kinds.includes(kind)) return { ok: false, why: "type" };
  if (!size) return { ok: false, why: "empty", kind };
  if (size > LIMITS[kind]) return { ok: false, why: "big", kind, limit: LIMITS[kind] };
  return { ok: true, kind };
}

/**
 * A refused file in plain words (Hebrew or English).
 *
 * @param check - From checkOpen.
 * @param name - The file's name.
 * @param kinds - The kinds the editor takes (named in the "wrong type" message).
 * @returns The sentence.
 */
export function explain(check, name, kinds) {
  if (check.why === "empty") return T(`הקובץ ${name} ריק`, `${name} is empty`);
  if (check.why === "big") return T(`${name} גדול מדי: עד ${Math.round(check.limit / MB)} MB`, `${name} is too big: up to ${Math.round(check.limit / MB)} MB`);
  const list = kinds.flatMap((k) => (k === "part" ? [] : TYPES[k])).map((e) => e.toUpperCase()).join(", ");
  return T(`אי אפשר לפתוח את ${name} כאן. סוגים נתמכים: ${list}`, `${name} cannot be opened here. Supported: ${list}`);
}

/**
 * The Recent list after opening one more: newest first, the same file (name and size) only once, at most 10.
 *
 * @param list - The list so far.
 * @param entry - `{ name, size, kind, at, files?, chat? }`.
 * @returns A new list.
 */
export function recentAdd(list, entry) {
  return [entry, ...list.filter((r) => !(r.name === entry.name && r.size === entry.size))].slice(0, RECENT_MAX);
}

/**
 * Reads a file with progress (a big file is read in slices, so the page can say how far it is).
 *
 * @param file - The File.
 * @param onProgress - Called with 0 to 1.
 * @returns The bytes.
 */
export async function readProgress(file, onProgress) {
  if (file.size <= 8 * MB || !file.stream) return file.arrayBuffer();
  const out = new Uint8Array(file.size);
  const reader = file.stream().getReader();
  let at = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.set(value, at);
    at += value.length;
    onProgress?.(at / file.size);
  }
  return out.buffer;
}

/** Shows a progress line in the editor's busy bar (its `#busyText`), when there is one. */
function showProgress(text) {
  const el = document.getElementById("busyText");
  if (el) el.textContent = text;
}

/**
 * Keeps a copy of a file in this chat's folder, in pieces of 8 MB (a phone's file reaches the computer this way, and
 * Recent can open it again). Without a chat, or when the upload fails, there is no copy and the file is used here only.
 *
 * @param file - The File.
 * @param onProgress - Called with 0 to 1.
 * @returns The path in the chat (`shared/name`), or undefined.
 */
export async function keepCopy(file, onProgress) {
  const kesher = window.kesher;
  const info = await kesher.call("info").catch(() => ({}));
  if (!info.conversationId) return undefined;
  const total = Math.max(1, Math.ceil(file.size / PIECE));
  const upload = crypto.randomUUID();
  try {
    for (let i = 0; i < total; i++) {
      const bytes = await file.slice(i * PIECE, (i + 1) * PIECE).arrayBuffer();
      const r = await kesher.call("media.uploadPiece", { name: file.name, upload, index: i, total, size: file.size, bytes });
      onProgress?.((i + 1) / total);
      if (r.done) return r.path;
    }
  } catch { /* no copy: the file is still open here */ }
  return undefined;
}

/**
 * The files of a drop, folders included (a glTF dropped with its folder brings its textures). Call it in the drop
 * event itself: the browser empties the drop's list after the first await.
 *
 * @param dt - The event's dataTransfer.
 * @returns The files, each with `relPath` (its path inside a dropped folder).
 */
export async function filesFromDrop(dt) {
  const entries = [...(dt.items ?? [])].filter((i) => i.kind === "file").map((i) => i.webkitGetAsEntry?.() ?? null);
  const plain = [...(dt.files ?? [])];
  if (!entries.length || entries.some((e) => !e)) return plain;
  const out = [];
  const walk = async (entry, dir) => {
    if (out.length > 400) return;
    if (entry.isFile) {
      const f = await new Promise((resolve, reject) => entry.file(resolve, reject));
      Object.defineProperty(f, "relPath", { value: `${dir}${f.name}` });
      out.push(f);
      return;
    }
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const e of batch) await walk(e, `${dir}${entry.name}/`);
    }
  };
  for (const e of entries) await walk(e, "");
  return out;
}

/**
 * Saves a file where the person chooses: the computer's "Save as" window where the browser has one, otherwise the
 * browser's download (on a phone: the Downloads folder).
 *
 * @param blob - The file's content.
 * @param name - The suggested name.
 * @returns `"saved"`, or `"cancelled"` when the window was closed.
 */
export async function saveAs(blob, name) {
  if (window.showSaveFilePicker) {
    try {
      const ext = `.${extOf(name)}`;
      const h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: name, accept: { [blob.type || "application/octet-stream"]: [ext] } }] });
      const w = await h.createWritable();
      await w.write(blob);
      await w.close();
      return "saved";
    } catch (e) {
      if (e?.name === "AbortError") return "cancelled";
      // Blocked inside a frame, or not allowed here: the download below.
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return "saved";
}

const css = `
.of-drop{position:fixed;z-index:70;pointer-events:none;border:2px dashed #7aa2ff;border-radius:14px;background:#10162acc;color:#ededee;display:none;align-items:center;justify-content:center;flex-direction:column;gap:6px;font:600 16px system-ui,sans-serif;text-align:center;padding:12px}
.of-drop small{font-weight:400;color:#b9c3e6;font-size:13px}
.of-drop.on{display:flex}
@media (max-width:520px){.of-label{display:none}}
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
 * Connects an editor to opening files: the Open… button, Ctrl/Cmd+O, a drop on the work area, the Recent button, and
 * the Save as… button. Everything it shows is Hebrew or English by {@link setHebrew}.
 *
 * @param o - `{ editor, kinds, target, openBtn, recentBtn?, saveBtn?, hasWork(), onOpen(files), onDrop?(files), dropHint?(), say(text, isError?), onSave?() }`.
 *   `onOpen(files, ctx)` replaces the work with the files (`ctx.read(file)` reads with progress; `ctx.keep(file)` copies into
 *   the chat); `onDrop` is for a drop on work that is already there (default: the same as onOpen); `say` shows a message;
 *   `hasWork()` is true when opening would replace something (then it is asked first).
 * @returns `{ pick(), recent(anchor), handle(files, replace), remember(file, files) }`.
 */
export function wireOpen(o) {
  style();
  const kesher = window.kesher;
  const accept = acceptOf(o.kinds);
  const labels = () => {
    for (const [btn, icon, label, title] of [
      [o.openBtn, "📂", T("פתח…", "Open…"), T("פתח קובץ מהמחשב או מהטלפון (Ctrl+O)", "Open a file from the computer or phone (Ctrl+O)")],
      [o.saveBtn, "⤓", T("שמור בשם…", "Save as…"), T("שמור בשם: לבחור איפה לשמור (בטלפון: להורדות)", "Save as: choose where (on a phone: Downloads)")],
    ]) {
      if (!btn) continue;
      btn.replaceChildren();
      const i = document.createElement("span");
      i.textContent = icon;
      i.setAttribute("aria-hidden", "true");
      const l = document.createElement("span");
      l.className = "of-label";
      l.textContent = ` ${label}`;
      btn.append(i, l);
      btn.title = title;
      btn.setAttribute("aria-label", label);
    }
    if (o.recentBtn) {
      o.recentBtn.textContent = "🕘";
      o.recentBtn.title = T("קבצים אחרונים", "Recent files");
      o.recentBtn.setAttribute("aria-label", T("קבצים אחרונים", "Recent files"));
    }
  };
  wired.add(labels);
  labels();

  /** The recent list from this editor's storage. */
  const load = async () => {
    const v = await kesher.call("storage.get", { key: "recent" }).catch(() => null);
    return Array.isArray(v) ? v.filter((r) => r && typeof r.name === "string") : [];
  };
  const ctx = {
    read: (file) => readProgress(file, (p) => showProgress(`${T("קורא", "Reading")} ${Math.round(p * 100)}%`)),
    keep: (file) => keepCopy(file, (p) => showProgress(`${T("מעתיק למחשב", "Copying to the computer")} ${Math.round(p * 100)}%`)),
  };

  /** Checks the files; says what was refused; returns the ones that may open. */
  const accepted = (files) => {
    const good = [];
    for (const f of files) {
      const c = checkOpen(f.name, f.size, o.kinds);
      if (c.ok) good.push(f);
      // A companion file (a glTF's .bin) that is not wanted is left out without a complaint when others came with it.
      else if (files.length === 1 || c.why !== "type") o.say(explain(c, f.name, o.kinds), true);
    }
    if (!good.length && files.length > 1) o.say(explain({ why: "type" }, files[0].name, o.kinds), true);
    return good;
  };

  const api = {
    /**
     * Opens the files: replaces the work (asking first when there is some) or, for a drop on existing work, `onDrop`.
     *
     * @param files - The Files.
     * @param replace - True for Open, false for a drop.
     */
    async handle(files, replace = true) {
      const good = accepted(files);
      if (!good.length) return;
      if (replace && o.hasWork?.() && !window.confirm(T("לפתוח קובץ אחר? העבודה הנוכחית תוחלף (אפשר לשמור קודם).", "Open another file? The current work is replaced (save it first if you need it)."))) return;
      try {
        await (replace || !o.onDrop ? o.onOpen : o.onDrop)(good, ctx);
        await api.remember(good);
      } catch (e) { o.say(e.message || String(e), true); }
    },
    /** Opens the browser's file window (on the phone: its file picker). */
    pick() {
      const i = document.createElement("input");
      i.type = "file";
      i.accept = accept;
      i.multiple = o.kinds.includes("model") || o.kinds.includes("image");
      i.onchange = () => void api.handle([...(i.files ?? [])], true);
      i.click();
    },
    /**
     * Notes the files in Recent and keeps copies in the chat for reopening (best effort, in the background).
     *
     * @param files - The files just opened (the first is the main one).
     */
    async remember(files) {
      const info = await kesher.call("info").catch(() => ({}));
      const main = files[0];
      const entry = { name: main.name, size: main.size, kind: kindOfName(main.name), at: Date.now(), chat: info.conversationId ?? null, files: [{ name: main.name }] };
      let list = recentAdd(await load(), entry);
      await kesher.call("storage.set", { key: "recent", value: list }).catch(() => undefined);
      // Copies, so Recent can open it again; a big file's copy does not hold up the editor.
      void (async () => {
        const kept = [];
        for (const f of files.slice(0, 40)) {
          const path = await keepCopy(f);
          if (!path) return;
          kept.push({ name: f.name, path, relPath: f.relPath ?? f.webkitRelativePath ?? undefined });
        }
        list = recentAdd(await load(), { ...entry, files: kept });
        await kesher.call("storage.set", { key: "recent", value: list }).catch(() => undefined);
      })();
    },
    /**
     * The Recent menu under a button: the last 10 files, newest first.
     *
     * @param anchor - The button.
     */
    async recent(anchor) {
      const { openMenu } = await import("./add-media.js");
      const list = await load();
      const info = await kesher.call("info").catch(() => ({}));
      const icon = { model: "🧊", image: "🖼", audio: "🎵", video: "🎬" };
      const items = list.map((r) => ({
        icon: icon[r.kind] ?? "📄",
        label: r.name,
        hint: r.files?.every((f) => f.path) && r.chat === (info.conversationId ?? null) && r.chat ? "" : T("לבחור שוב", "pick again"),
        run: () => void api.reopen(r, info),
      }));
      openMenu(anchor, list.length ? T("נפתחו לאחרונה", "Opened recently") : T("עוד לא נפתח כאן קובץ", "Nothing opened here yet"), items);
    },
    /** Opens a Recent entry again from its copy in this chat; without a copy, the file window opens. */
    async reopen(r, info) {
      if (!(r.files?.length && r.files.every((f) => f.path) && r.chat && r.chat === info.conversationId)) {
        o.say(T("הקובץ נפתח מהמחשב או מצ׳אט אחר: בחר אותו שוב", "This file came from the computer or another chat: choose it again"));
        return api.pick();
      }
      try {
        const files = [];
        for (const f of r.files) {
          const bytes = await kesher.call("media.bytes", { id: `chat:${f.path}` });
          const file = new File([bytes], f.name);
          if (f.relPath) Object.defineProperty(file, "relPath", { value: f.relPath });
          files.push(file);
        }
        await api.handle(files, true);
      } catch { o.say(T("הקובץ כבר לא בצ׳אט: בחר אותו שוב", "The copy is gone from this chat: choose the file again"), true); }
    },
  };

  o.openBtn.onclick = () => api.pick();
  if (o.recentBtn) o.recentBtn.onclick = () => void api.recent(o.recentBtn);
  if (o.saveBtn && o.onSave) o.saveBtn.onclick = () => void o.onSave();
  addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "o") {
      e.preventDefault();
      api.pick();
    }
  });

  // The drop target: a dashed frame over it while files are dragged in, and "open" or "add" said on it.
  const veil = document.createElement("div");
  veil.className = "of-drop";
  veil.setAttribute("role", "status");
  document.body.append(veil);
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  const hide = () => { depth = 0; veil.classList.remove("on"); };
  const show = () => {
    const r = o.target.getBoundingClientRect();
    Object.assign(veil.style, { left: `${r.left + 6}px`, top: `${r.top + 6}px`, width: `${r.width - 12}px`, height: `${r.height - 12}px` });
    const adds = o.hasWork?.() && o.onDrop;
    veil.replaceChildren();
    const b = document.createElement("span");
    b.textContent = adds ? T("שחרר כדי להוסיף", "Drop to add") : T("שחרר כדי לפתוח", "Drop to open");
    const s = document.createElement("small");
    s.textContent = o.dropHint?.() ?? "";
    veil.append(b, s);
    veil.classList.add("on");
  };
  o.target.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; depth++; show(); });
  o.target.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  o.target.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) hide(); });
  o.target.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    hide();
    if (o.canDrop && !o.canDrop()) return;
    const adds = o.hasWork?.() && o.onDrop;
    // Read the drop now: its list is empty after the first await.
    void filesFromDrop(e.dataTransfer).then((files) => api.handle(files, !adds));
  });
  return api;
}
