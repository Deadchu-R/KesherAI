// KesherAI's video editor, stage 1 (docs/RESEARCH_LOG.md → "The video editor's screen"): a magnetic main track of
// stretches of one source video, split / trim / delete / move with the keys editors know, played back as the edit,
// and exported by FFmpeg on the computer (video.cut). A plugin page with no build step: it talks to KesherAI only
// through window.kesher (kesher.js).
/* global window, document, kesher, Blob, URL, requestAnimationFrame, addEventListener, setTimeout, clearTimeout, ResizeObserver */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);

  // ---------- words (English / Hebrew) ----------
  const HE = {
    export: "ייצוא", toChat: "שלח לצ'אט", empty: "פתח וידאו מצ'אט: \"עריכה בעורך הווידאו\" בתצוגה שלו.", clipH: "הקליפ הנבחר",
    split: "✂ פיצול", delete: "⌫ מחיקה", trimStart: "⇤ קיצוץ התחלה", trimEnd: "קיצוץ סוף ⇥", moveLeft: "◀ הזזה", moveRight: "הזזה ▶",
    soonH: "בקרוב", soon: "התמלול (מוחקים מילים כדי לחתוך), כתוביות מהדיבור, ו\"מה לעשות כאן?\" עם מודל הווידאו.",
    videoTrack: "וידאו", hint: "Space נגן · J/K/L · S פיצול · Q/W קיצוץ · Delete · המסלול הראשי סוגר רווחים",
    splitS: "פיצול", trimS: "התחלה", trimE: "סוף", deleteS: "מחיקה", playS: "נגן",
    toChatH: "שליחה לצ'אט", toChatMsg: "הודעה איתו (לא חובה)", cancel: "ביטול", send: "שלח", keysH: "קיצורים (כמו ב-Premiere וב-CapCut)", close: "סגור",
    clip: "קליפ", of: "מתוך", length: "אורך", from: "מ-", cutting: "חותך במחשב… (FFmpeg)", saved: "נשמר בתיקיית הצ'אט:", tooShort: "קצר מדי לפיצול כאן",
    nothing: "אין קליפ מתחת לראש הניגון", summary: (n, len) => `${n} קליפים · ${len}`, loading: "טוען את הווידאו…",
    kPlay: "נגן / עצור", kJkl: "אחורה 5 שנ׳ / עצור / קדימה (פעמיים = מהר)", kFrame: "פריים", kSec: "שנייה", kSplit: "פיצול בראש הניגון", kTrim: "קיצוץ ההתחלה / הסוף עד ראש הניגון", kDel: "מחיקת הקליפ (הרווח נסגר)", kUndo: "ביטול / ביצוע שוב", kZoom: "זום בציר הזמן", kMove: "הזזת הקליפ שמאלה / ימינה",
  };
  let he = false;
  const T = (k, en) => (he && HE[k]) || en;

  // ---------- the edit: stretches of the source, in order ----------
  const video = $("video");
  let source = null; // { name, duration }
  let clips = []; // [{ id, from, to }] in seconds of the source
  let chosen = -1;
  let now = 0; // the playhead, in seconds of the edit
  let nextId = 1;
  let zoom = 40; // px per second
  const undoStack = [];
  const redoStack = [];
  const LAB = 56; // the track label's width

  const len = (c) => c.to - c.from;
  const total = () => clips.reduce((s, c) => s + len(c), 0);
  /** Where the edit's time t is: which clip, and the time in the source. */
  function locate(t) {
    let at = 0;
    for (let i = 0; i < clips.length; i++) {
      const l = len(clips[i]);
      if (t < at + l || i === clips.length - 1) return { i, src: clips[i].from + Math.min(l, Math.max(0, t - at)), start: at };
      at += l;
    }
    return { i: -1, src: 0, start: 0 };
  }
  const startOf = (i) => clips.slice(0, i).reduce((s, c) => s + len(c), 0);
  const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

  function remember() {
    undoStack.push(JSON.stringify(clips));
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(clips));
    clips = JSON.parse(undoStack.pop());
    after();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(JSON.stringify(clips));
    clips = JSON.parse(redoStack.pop());
    after();
  }
  function after() {
    chosen = Math.min(chosen, clips.length - 1);
    now = Math.min(now, Math.max(0, total() - 0.01));
    seek(now);
    render();
  }

  // ---------- editing ----------
  function split() {
    const { i, src } = locate(now);
    const c = clips[i];
    if (!c || src - c.from < 0.1 || c.to - src < 0.1) return msg(T("tooShort", "Too short to split here"), true);
    remember();
    clips.splice(i, 1, { id: nextId++, from: c.from, to: src }, { id: nextId++, from: src, to: c.to });
    chosen = i + 1;
    render();
  }
  function remove() {
    const i = chosen >= 0 ? chosen : locate(now).i;
    if (i < 0 || clips.length <= 1) return;
    remember();
    clips.splice(i, 1);
    // The main track is magnetic: what came after moves up and the playhead goes to where the clip was.
    now = Math.min(startOf(i), Math.max(0, total() - 0.01));
    chosen = Math.min(i, clips.length - 1);
    after();
  }
  function trim(edge) {
    const { i, src, start } = locate(now);
    const c = clips[i];
    if (!c) return msg(T("nothing", "No clip under the playhead"), true);
    if (edge === "start" ? src - c.from < 0.05 || c.to - src < 0.1 : c.to - src < 0.05 || src - c.from < 0.1) return;
    remember();
    if (edge === "start") { c.from = src; now = start; } else c.to = src;
    chosen = i;
    after();
  }
  function moveClip(dir) {
    const i = chosen;
    const j = i + dir;
    if (i < 0 || j < 0 || j >= clips.length) return;
    remember();
    [clips[i], clips[j]] = [clips[j], clips[i]];
    chosen = j;
    now = startOf(j);
    after();
  }

  // ---------- playback: the edit, clip after clip ----------
  let playing = false;
  let rate = 1;
  function seek(t) {
    now = Math.max(0, Math.min(t, Math.max(0, total() - 0.001)));
    const { src } = locate(now);
    if (source && Math.abs(video.currentTime - src) > 0.03) video.currentTime = src;
    drawHead();
  }
  function play(on = !playing) {
    if (!source) return;
    playing = on;
    if (playing) {
      if (now >= total() - 0.05) seek(0);
      video.playbackRate = rate;
      video.play().catch(() => (playing = false));
      requestAnimationFrame(tick);
    } else video.pause();
    $("play").textContent = playing ? "⏸" : "▶";
  }
  function tick() {
    if (!playing) return;
    const { i, start } = locate(now);
    const c = clips[i];
    if (c) {
      if (video.currentTime >= c.to - 0.03) {
        // The end of this stretch: on to the next one, or stop at the end.
        if (i + 1 < clips.length) { now = start + len(c); video.currentTime = clips[i + 1].from; } else { now = total(); play(false); }
      } else now = start + Math.max(0, video.currentTime - c.from);
    }
    drawHead();
    requestAnimationFrame(tick);
  }

  // ---------- drawing ----------
  const tracks = $("tracks");
  function render() {
    const box = $("clips");
    box.style.width = `${total() * zoom + 40}px`;
    box.replaceChildren(...clips.map((c, i) => {
      const d = document.createElement("div");
      d.className = `clip${i === chosen ? " on" : ""}`;
      d.style.left = `${startOf(i) * zoom}px`;
      d.style.width = `${Math.max(4, len(c) * zoom - 2)}px`;
      d.textContent = `🎬 ${T("clip", "Clip")} ${i + 1}`;
      const s = document.createElement("small");
      s.textContent = `${fmt(c.from)}–${fmt(c.to)}`;
      d.append(s);
      d.onpointerdown = (e) => {
        e.stopPropagation();
        chosen = i;
        seek(startOf(i) + (e.clientX - d.getBoundingClientRect().left) / zoom);
        render();
      };
      return d;
    }));
    const c = clips[chosen];
    $("clipInfo").textContent = c ? `${T("clip", "Clip")} ${chosen + 1} ${T("of", "of")} ${clips.length} · ${T("length", "length")} ${fmt(len(c))} · ${T("from", "from ")}${fmt(c.from)}` : "";
    $("undo").disabled = !undoStack.length;
    $("redo").disabled = !redoStack.length;
    drawHead();
  }
  function drawHead() {
    const x = LAB + now * zoom;
    $("playhead").style.left = `${x}px`;
    $("time").textContent = `${fmt(now)} / ${fmt(total())}`;
    // Keep the playhead in view while playing (the phone's timeline follows it).
    if (x < tracks.scrollLeft + LAB || x > tracks.scrollLeft + tracks.clientWidth - 30) tracks.scrollLeft = x - tracks.clientWidth / 2;
    const all = total() || 1;
    const w = $("window");
    w.style.left = `${(tracks.scrollLeft / zoom / all) * 100}%`;
    w.style.width = `${Math.min(100, ((tracks.clientWidth - LAB) / zoom / all) * 100)}%`;
  }
  tracks.addEventListener("pointerdown", (e) => {
    const r = tracks.getBoundingClientRect();
    seek((e.clientX - r.left + tracks.scrollLeft - LAB) / zoom);
  });
  tracks.addEventListener("scroll", () => drawHead());
  $("overview").addEventListener("pointerdown", (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * total());
  });
  function fitZoom() {
    zoom = Math.max(2, Math.min(400, (tracks.clientWidth - LAB - 20) / Math.max(1, total())));
    render();
  }
  function zoomBy(k) {
    zoom = Math.max(2, Math.min(400, zoom * k));
    render();
  }

  // ---------- open from the chat, export, send ----------
  let busyCount = 0;
  function busy(text) {
    busyCount += text ? 1 : -1;
    $("busy").hidden = busyCount <= 0;
    if (text) $("busyText").textContent = text;
  }
  let msgTimer;
  function msg(text, error) {
    const m = $("msg");
    m.textContent = text;
    m.className = `status show${error ? " error" : ""}`;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => (m.className = "status"), error ? 6000 : 3500);
  }
  async function open() {
    busy(T("loading", "Loading the video…"));
    try {
      const input = await kesher.call("editor.input");
      if (!input?.bytes) return;
      $("empty").hidden = true;
      $("name").textContent = input.name;
      video.src = URL.createObjectURL(new Blob([input.bytes], { type: input.type }));
      await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = () => reject(new Error("The video could not be played here.")); });
      source = { name: input.name, duration: video.duration };
      clips = [{ id: nextId++, from: 0, to: video.duration }];
      chosen = 0;
      fitZoom();
      seek(0);
    } catch (e) {
      msg(e.message, true);
    } finally {
      busy("");
    }
  }
  async function exportCut(send, text) {
    if (!source) return;
    play(false);
    busy(T("cutting", "Cutting on your computer… (FFmpeg)"));
    try {
      const r = await kesher.call("video.cut", { segments: clips.map(({ from, to }) => ({ from, to })), send, text });
      if (!send) msg(`${T("saved", "Saved in the chat's folder:")} ${r.path}`);
    } catch (e) {
      msg(e.message, true);
    } finally {
      busy("");
    }
  }
  $("export").onclick = () => exportCut(false);
  $("toChat").onclick = () => {
    if (!source) return;
    $("chatSummary").textContent = HE.summary && he ? HE.summary(clips.length, fmt(total())) : `${clips.length} clips · ${fmt(total())}`;
    $("chatDialog").showModal();
  };
  $("chatDialog").addEventListener("close", () => {
    if ($("chatDialog").returnValue === "ok") exportCut(true, $("chatText").value.trim());
  });

  // ---------- buttons and keys ----------
  $("undo").onclick = undo;
  $("redo").onclick = redo;
  $("play").onclick = () => play();
  $("splitBtn").onclick = split;
  $("delBtn").onclick = remove;
  $("trimStart").onclick = () => trim("start");
  $("trimEnd").onclick = () => trim("end");
  $("left").onclick = () => moveClip(-1);
  $("right").onclick = () => moveClip(1);
  $("zoomIn").onclick = () => zoomBy(1.4);
  $("zoomOut").onclick = () => zoomBy(1 / 1.4);
  document.querySelectorAll(".phonebar [data-do]").forEach((b) => (b.onclick = () => ({ split, delete: remove, trimStart: () => trim("start"), trimEnd: () => trim("end"), play: () => play() })[b.dataset.do]()));

  const KEYS = [["Space", "kPlay", "Play / pause"], ["J / K / L", "kJkl", "Back 5 s / stop / forward (twice = faster)"], ["← / →", "kFrame", "A frame"], ["Shift+← / →", "kSec", "A second"], ["S", "kSplit", "Split at the playhead"], ["Q / W", "kTrim", "Trim the start / end to the playhead"], ["Delete", "kDel", "Delete the clip (the gap closes)"], ["Alt+← / →", "kMove", "Move the clip left / right"], ["Ctrl+Z / Ctrl+Y", "kUndo", "Undo / redo"], ["+ / −", "kZoom", "Zoom the timeline"]];
  function showKeys() {
    $("keysTable").replaceChildren(...KEYS.map(([k, key, en]) => {
      const tr = document.createElement("tr");
      const a = document.createElement("td");
      const kbd = document.createElement("kbd");
      kbd.textContent = k;
      a.append(kbd);
      const b = document.createElement("td");
      b.textContent = T(key, en);
      tr.append(a, b);
      return tr;
    }));
    $("keysDialog").showModal();
  }
  $("keysBtn").onclick = showKeys;
  addEventListener("keydown", (e) => {
    if (e.target.closest?.("input, textarea, dialog")) return;
    const k = e.key.toLowerCase();
    const frame = 1 / 30;
    if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
    if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); return redo(); }
    if (e.ctrlKey || e.metaKey) return;
    if (e.altKey && (k === "arrowleft" || k === "arrowright")) { e.preventDefault(); return moveClip(k === "arrowleft" ? -1 : 1); }
    const map = {
      " ": () => play(),
      k: () => { rate = 1; play(false); },
      l: () => { rate = playing && rate < 4 ? rate * 2 : 1; play(true); },
      j: () => seek(now - 5),
      arrowleft: () => seek(now - (e.shiftKey ? 1 : frame)),
      arrowright: () => seek(now + (e.shiftKey ? 1 : frame)),
      s: split,
      q: () => trim("start"),
      w: () => trim("end"),
      delete: remove,
      backspace: remove,
      "+": () => zoomBy(1.4),
      "=": () => zoomBy(1.4),
      "-": () => zoomBy(1 / 1.4),
      "?": showKeys,
    };
    if (map[k]) { e.preventDefault(); map[k](); }
  });

  // ---------- start ----------
  new ResizeObserver(() => drawHead()).observe(tracks);
  kesher.call("info").then((i) => {
    he = i.locale === "he";
    if (he) {
      document.documentElement.dir = "rtl";
      document.querySelectorAll("[data-t]").forEach((el) => (el.textContent = T(el.dataset.t, el.textContent)));
    }
    render();
  }).catch(() => undefined);
  render();
  open();
})();
