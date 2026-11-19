// KesherAI's video editor, stage 1 (docs/RESEARCH_LOG.md → "The video editor's screen"): a magnetic main track of
// stretches of one source video, split / trim / delete / move with the keys editors know, played back as the edit,
// and exported by FFmpeg on the computer (video.cut). A plugin page with no build step: it talks to KesherAI only
// through window.kesher (kesher.js).
/* global fetch, File, window, performance, document, kesher, Blob, URL, requestAnimationFrame, addEventListener, setTimeout, clearTimeout, ResizeObserver */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);

  // ---------- words (English / Hebrew) ----------
  const HE = {
    addB: "＋ הוסף", addS: "הוסף", addAt: "נכנס במקום הסמן", fromDevice: "מהמחשב / מהטלפון", fromChat: "מהקבצים של הצ׳אט", fromBank: "מבנק היצירות", dragToo: "גם גרירה", picClip: "תמונה כקליפ", textOver: "טקסט על הסרטון", textHint: "מהסמן, 3 שנ׳", textAsk: "מה לכתוב?", textLane: "🔤 טקסט", textDrag: "גרירה: מתי הוא מופיע · לחיצה כפולה: עריכה", textStyle: "סגנון", sBox: "רקע כהה", sPlain: "קו מתאר", sBig: "גדול", pBottom: "למטה", pCenter: "באמצע", pTop: "למעלה", textDel: "מחיקת הטקסט", textPos: "מיקום", noMusicYet: "קודם בוחרים מוזיקה (מוזיקה בצד)", musicHere: "המוזיקה מתחילה כאן", kMusic: "מוזיקה מכאן", dip: "דהייה לשחור בין הקליפים", titleCard: "כרטיס כותרת", titleHint: "טקסט על רקע, 3 שנ׳", titleAsk: "מה לכתוב בכרטיס?", picHint: "5 שנ׳, מקצרים בקיצוץ", addedClip: (n) => `נוסף: ${n}`, needChat: "כדי להוסיף קליפים, פתח את עורך הווידאו מצ׳אט", startVideo: "התחל מסרטון: תמונה נכנסת אחרי שיש וידאו", cantPlay: "את הסרטון הזה אי אפשר לנגן כאן",
    export: "ייצוא", toChat: "שלח לצ'אט", empty: "פתח וידאו מצ'אט: \"עריכה בעורך הווידאו\" בתצוגה שלו.", clipH: "הקליפ הנבחר",
    split: "✂ פיצול", delete: "⌫ מחיקה", trimStart: "⇤ קיצוץ התחלה", trimEnd: "קיצוץ סוף ⇥", moveLeft: "◀ הזזה", moveRight: "הזזה ▶",
    soonH: "בקרוב", soon: "התמלול (מוחקים מילים כדי לחתוך), כתוביות מהדיבור, ו\"מה לעשות כאן?\" עם מודל הווידאו.",
    kHomeEnd: "התחלה / סוף", videoTrack: "וידאו", musicTrack: "🎵 מוזיקה", musicH: "🎵 מוזיקה", musicNone: "＋ מהצ'אט…", musicFile: "מהמכשיר…", musicVol: "עוצמה", fadeIn: "הופעה", fadeOut: "היעלמות", duck: "להנמיך כשמדברים", musicRemove: "✕", musicPickL: "מוזיקה מהצ'אט", musicAdding: "מוסיף את המוזיקה לצ'אט…", musicDrag: "גרירה: מאיפה המוזיקה מתחילה", noMusic: "אין קבצי שמע בצ'אט", hint: "Space נגן · J/K/L · S פיצול · Q/W קיצוץ · Delete · המסלול הראשי סוגר רווחים",
    splitS: "פיצול", trimS: "התחלה", trimE: "סוף", deleteS: "מחיקה", playS: "נגן",
    toChatH: "שליחה לצ'אט", toChatMsg: "הודעה איתו (לא חובה)", cancel: "ביטול", send: "שלח", keysH: "קיצורים (כמו ב-Premiere וב-CapCut)", close: "סגור",
    withCaptions: "כתוביות מהתמלול (קובץ srt. לצידו)", transcriptH: "תמלול", transcribe: "תמלל", transcriptHint: "לחיצה על שורה מעבירה אליה; ✂ חותך מהווידאו את מה שנאמר בה. Whisper רץ במחשב שלך.", wordsS: "מילים",
    transcribing: "מתמלל במחשב… (whisper)", burnCaptions: "וגם לצרוב אותן בתמונה (לטלפונים ולרשתות)", shape: "צורה", shapeKeep: "כמו שהיא", shape916: "9:16 (טלפון, רילס, טיקטוק)", shape11: "1:1 (ריבוע)", shape45: "4:5 (פוסט באינסטגרם)", shape169: "16:9 (רחב)", scenes: "🎬 פיצול במעברי שוט", findingScenes: "מחפש מעברי שוט… (FFmpeg במחשב)", noScenes: "לא נמצאו מעברי שוט", scenesDone: (n) => `פוצל ב-${n} מעברי שוט`, silences: (n) => `הסר ${n} שתיקות ארוכות`, noSilences: "אין שתיקות ארוכות",
    soundTrack: "סאונד", newSound: "סאונד חדש", openingSound: "מוציא את הסאונד לעורך הסאונד…", dbl: "לחיצה כפולה: עריכה בעורך הסאונד (כלי נגינה, קולות…)", replaced: "הסאונד הוחלף מעורך הסאונד",
    clip: "קליפ", of: "מתוך", length: "אורך", from: "מ-", cutting: "חותך במחשב… (FFmpeg)", saved: "נשמר בתיקיית הצ'אט:", tooShort: "קצר מדי לפיצול כאן",
    nothing: "אין קליפ מתחת לראש הניגון", summary: (n, len) => `${n} קליפים · ${len}`, loading: "טוען את הווידאו…",
    cutLine: "לחתוך את זה מהווידאו", kPlay: "נגן / עצור", kJkl: "אחורה 5 שנ׳ / עצור / קדימה (פעמיים = מהר)", kFrame: "פריים", kSec: "שנייה", kSplit: "פיצול בראש הניגון", kTrim: "קיצוץ ההתחלה / הסוף עד ראש הניגון", kDel: "מחיקת הקליפ (הרווח נסגר)", kUndo: "ביטול / ביצוע שוב", kZoom: "זום בציר הזמן", kMove: "הזזת הקליפ שמאלה / ימינה",
  };
  let he = false;
  const T = (k, en) => (he && HE[k]) || en;

  // ---------- the edit: stretches of the source, in order ----------
  const video = $("video");
  // The new sound from the sound editor plays in step with the video (which is muted then).
  const newAudio = document.createElement("audio");
  video.addEventListener("play", () => { if (soundPath) { newAudio.currentTime = video.currentTime; newAudio.playbackRate = video.playbackRate; newAudio.play().catch(() => undefined); } });
  video.addEventListener("pause", () => newAudio.pause());
  video.addEventListener("seeked", () => { if (soundPath) newAudio.currentTime = video.currentTime; });
  let source = null; // { name, duration }
  let clips = []; // [{ id, from, to, m? }] in seconds of their file (m: which of `media`; none = the opened video)
  // The files in the edit: [0] the video the editor opened, then the clips added with ＋ Add (videos, pictures).
  let media = []; // [{ path, kind: "video" | "image", url, duration, name }]
  const mOf = (c) => c?.m ?? 0;
  let loadedM = 0; // which file the <video> holds
  let switching = false;
  let lastT = 0;
  const still = document.createElement("img");
  still.className = "still";
  still.alt = "";
  still.hidden = true;
  video.after(still);
  /** Shows a file of the edit: a video in the player (loaded if it is another one), a picture over it. */
  async function setMedia(m) {
    const md = media[m];
    if (!md) return;
    if (md.kind === "image") { still.src = md.url; still.hidden = false; video.style.visibility = "hidden"; video.pause(); return; }
    still.hidden = true;
    video.style.visibility = "";
    if (loadedM !== m) {
      switching = true;
      loadedM = m;
      video.src = md.url;
      await new Promise((resolve) => { video.onloadedmetadata = resolve; video.onerror = resolve; });
      switching = false;
    }
    // The sound editor's new sound belongs to the opened video only.
    video.muted = m === 0 && !!soundPath;
    if (m !== 0) newAudio.pause();
  }
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
    clips.splice(i, 1, { ...c, id: nextId++, from: c.from, to: src }, { ...c, id: nextId++, from: src, to: c.to });
    chosen = i + 1;
    render();
  }
  /**
   * A clip for each shot: the video's shot changes (FFmpeg's scene score, on the computer) split the clips that hold
   * them, in source time, so it works after other edits too.
   */
  async function splitScenes() {
    busy(T("findingScenes", "Finding the shot changes… (FFmpeg on your computer)"));
    try {
      const times = await kesher.call("video.scenes", { threshold: 0.3 });
      let n = 0;
      const next = [];
      for (const c of clips) {
        if (mOf(c)) { next.push(c); continue; }
        let from = c.from;
        for (const t of times) if (t > from + 0.1 && t < c.to - 0.1) { next.push({ id: nextId++, from, to: t }); from = t; n++; }
        next.push(from === c.from ? c : { id: nextId++, from, to: c.to });
      }
      if (!n) return msg(T("noScenes", "No shot changes found"));
      remember();
      clips = next;
      after();
      msg(he ? HE.scenesDone(n) : `Split at ${n} shot changes`);
    } catch (e) { msg(e.message, true); } finally { busy(""); }
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
    const { i, src } = locate(now);
    const m = mOf(clips[i]);
    if (source && clips[i]) {
      if (media[m]?.kind === "image") void setMedia(m);
      else if (loadedM !== m || !still.hidden) void setMedia(m).then(() => { video.currentTime = src; });
      else if (Math.abs(video.currentTime - src) > 0.03) video.currentTime = src;
    }
    drawHead();
  }
  function play(on = !playing) {
    if (!source) return;
    playing = on;
    if (playing) {
      if (now >= total() - 0.05) seek(0);
      video.playbackRate = rate;
      lastT = performance.now();
      if (media[mOf(clips[locate(now).i])]?.kind !== "image") video.play().catch(() => (playing = false));
      requestAnimationFrame(tick);
    } else video.pause();
    $("play").textContent = playing ? "⏸" : "▶";
  }
  function tick() {
    if (!playing) return;
    if (switching) return requestAnimationFrame(tick);
    const { i, start } = locate(now);
    const c = clips[i];
    const t = performance.now();
    if (c) {
      const pic = media[mOf(c)]?.kind === "image";
      // A picture has no clock of its own: the edit's time moves on with the real one.
      if (pic) now += ((t - lastT) / 1000) * rate;
      if (pic ? now >= start + len(c) : video.currentTime >= c.to - 0.03) {
        // The end of this stretch: on to the next one (another file is loaded first), or stop at the end.
        if (i + 1 < clips.length) {
          const n = clips[i + 1];
          now = start + len(c);
          if (mOf(n) === mOf(c) && !pic) video.currentTime = n.from;
          else void setMedia(mOf(n)).then(() => { if (media[mOf(n)]?.kind !== "image") { video.currentTime = n.from; if (playing) video.play().catch(() => undefined); } });
        } else { now = total(); play(false); }
      } else if (!pic) now = start + Math.max(0, video.currentTime - c.from);
    }
    lastT = t;
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
      const md = media[mOf(c)];
      d.textContent = mOf(c) ? `${md?.kind === "image" ? "🖼" : "🎬"} ${md?.name ?? ""}` : `🎬 ${T("clip", "Clip")} ${i + 1}`;
      if (mOf(c)) d.classList.add("added");
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
    // The sound under each clip; double-click opens the video's sound in the sound editor (asked 2026-11-18).
    const sb = $("sounds");
    sb.style.width = box.style.width;
    sb.replaceChildren(...clips.map((c, i) => {
      const d = document.createElement("div");
      d.className = "clip snd";
      d.style.left = `${startOf(i) * zoom}px`;
      d.style.width = `${Math.max(4, len(c) * zoom - 2)}px`;
      d.textContent = mOf(c) ? (media[mOf(c)]?.kind === "image" ? "" : "〰") : soundPath ? `🔊 ${T("newSound", "New sound")}` : "〰〰〰";
      d.title = T("dbl", "Double-click: edit in the sound editor (instruments, voices…)");
      d.ondblclick = (e) => { e.stopPropagation(); openSound(); };
      return d;
    }));
    // The music lane: one bar from where it starts to the end of the edit (or of the music), dragged to move it.
    const ml = $("musicLane");
    ml.style.width = box.style.width;
    if (music) {
      const d = document.createElement("div");
      const m = musicSettings();
      d.className = "clip mus";
      d.style.left = `${music.start * zoom}px`;
      d.style.width = `${Math.max(4, Math.min(music.duration, total() - music.start) * zoom - 2)}px`;
      d.textContent = `🎵 ${music.name} · ${Math.round(m.volume * 100)}%${m.duck ? " · ⇣" : ""}`;
      d.title = T("musicDrag", "Drag: where the music starts");
      d.onpointerdown = (e) => {
        e.stopPropagation();
        d.setPointerCapture(e.pointerId);
        const x0 = e.clientX, s0 = music.start;
        d.onpointermove = (ev) => { music.start = Math.max(0, Math.min(total() - 0.5, s0 + (ev.clientX - x0) / zoom)); d.style.left = `${music.start * zoom}px`; };
        d.onpointerup = () => { d.onpointermove = null; render(); };
      };
      ml.replaceChildren(d);
    } else ml.replaceChildren();
    // The text lane: a bar per text, dragged to move it in time; a double-click edits its words.
    const tl = $("textLane");
    tl.style.width = box.style.width;
    tl.replaceChildren(...texts.map((t) => {
      const d = document.createElement("div");
      d.className = `clip txt${t.id === chosenText ? " on" : ""}`;
      d.style.left = `${t.start * zoom}px`;
      d.style.width = `${Math.max(4, (t.end - t.start) * zoom - 2)}px`;
      d.textContent = `🔤 ${t.text.replace(/\s+/g, " ")}`;
      d.dir = "auto";
      d.title = T("textDrag", "Drag: when it shows · double-click: edit");
      // Its end edge (the last 10 px, or the end handle) lengthens or shortens it; the rest moves it.
      const grip = document.createElement("span");
      grip.className = "txt-end";
      grip.setAttribute("aria-hidden", "true");
      d.append(grip);
      d.onpointerdown = (e) => {
        e.stopPropagation();
        chosenText = t.id;
        showTextTools();
        d.setPointerCapture(e.pointerId);
        const x0 = e.clientX, s0 = t.start, e0 = t.end, l0 = t.end - t.start;
        const r = d.getBoundingClientRect();
        const atEnd = e.target === grip || e.clientX > r.right - 10;
        d.onpointermove = atEnd
          ? (ev) => { t.end = Math.max(t.start + 0.3, Math.min(total(), e0 + (ev.clientX - x0) / zoom)); d.style.width = `${Math.max(4, (t.end - t.start) * zoom - 2)}px`; }
          : (ev) => { t.start = Math.max(0, Math.min(total() - 0.1, s0 + (ev.clientX - x0) / zoom)); t.end = Math.min(total(), t.start + l0); d.style.left = `${t.start * zoom}px`; };
        d.onpointerup = () => { d.onpointermove = null; void saveEdit(); render(); };
      };
      d.ondblclick = (e) => { e.stopPropagation(); const v = window.prompt(T("textAsk", "What should it say?"), t.text); if (v?.trim()) { t.text = v.trim(); textPics.delete(t.id); void saveEdit(); render(); } };
      return d;
    }));
    const c = clips[chosen];
    $("clipInfo").textContent = c ? `${T("clip", "Clip")} ${chosen + 1} ${T("of", "of")} ${clips.length} · ${T("length", "length")} ${fmt(len(c))} · ${T("from", "from ")}${fmt(c.from)}` : "";
    if (parts.length) renderTranscript();
    $("undo").disabled = !undoStack.length;
    $("redo").disabled = !redoStack.length;
    drawHead();
  }
  function drawHead() {
    const x = LAB + now * zoom;
    $("playhead").style.left = `${x}px`;
    $("time").textContent = `${fmt(now)} / ${fmt(total())}`;
    syncMusic(now, playing);
    syncText(now);
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

  // ---------- the transcript: what is said, and cutting it out (text-based editing, as Premiere and Descript) ----------
  let parts = []; // [{ start, end, text }] in seconds of the source
  /** Cuts a stretch of the source out of every clip it falls in (the rest of each clip stays, in its place). */
  function cutSource(a, b) {
    const next = [];
    for (const c of clips) {
      if (mOf(c) || b <= c.from || a >= c.to) { next.push(c); continue; }
      if (a - c.from >= 0.1) next.push({ id: nextId++, from: c.from, to: a });
      if (c.to - b >= 0.1) next.push({ id: nextId++, from: b, to: c.to });
    }
    if (next.length) clips = next;
  }
  /** Whether a stretch of the source is still in the edit. */
  const kept = (a, b) => clips.some((c) => !mOf(c) && c.from < b - 0.05 && c.to > a + 0.05);
  /** The edit's time of a moment of the source, if it is still in. */
  function editTimeOf(src) {
    let at = 0;
    for (const c of clips) {
      if (!mOf(c) && src >= c.from && src < c.to) return at + src - c.from;
      at += len(c);
    }
    return undefined;
  }
  /** Long pauses: between the pieces of speech, and before the first and after the last (over 1 second). */
  function silences() {
    if (!parts.length || !source) return [];
    const out = [];
    const edges = [{ end: 0 }, ...parts, { start: source.duration }];
    for (let i = 1; i < edges.length; i++) {
      const a = edges[i - 1].end + 0.25, b = edges[i].start - 0.25;
      if (b - a >= 1 && kept(a, b)) out.push([a, b]);
    }
    return out;
  }
  function renderTranscript() {
    const here = locate(now).src;
    $("transcript").replaceChildren(...parts.map((p) => {
      const li = document.createElement("li");
      const gone = !kept(p.start, p.end);
      li.className = `${gone ? "gone" : ""}${here >= p.start && here < p.end && !gone ? " here" : ""}`;
      const t = document.createElement("time");
      t.textContent = fmt(p.start).replace(/\.\d$/, "");
      const s = document.createElement("span");
      s.dir = "auto";
      s.textContent = p.text;
      li.append(t, s);
      if (!gone) {
        const cut = document.createElement("button");
        cut.textContent = "✂";
        cut.title = T("cutLine", "Cut this out of the video");
        cut.onclick = (e) => { e.stopPropagation(); remember(); cutSource(p.start, p.end); after(); };
        li.append(cut);
      }
      li.onclick = () => { const t2 = editTimeOf(p.start + 0.01); if (t2 !== undefined) seek(t2); };
      return li;
    }));
    const quiet = silences();
    const b = $("silences");
    b.hidden = !parts.length;
    b.disabled = !quiet.length;
    b.textContent = quiet.length ? (he ? HE.silences(quiet.length) : `Remove ${quiet.length} long silences`) : T("noSilences", "No long silences");
  }
  $("silences").onclick = () => {
    const quiet = silences();
    if (!quiet.length) return;
    remember();
    // From the end, so the earlier stretches keep their places.
    for (const [a, b] of quiet.reverse()) cutSource(a, b);
    after();
  };
  $("transcribe").onclick = async () => {
    busy(T("transcribing", "Transcribing on your computer… (whisper)"));
    try {
      parts = await kesher.call("video.transcript");
      renderTranscript();
    } catch (e) {
      msg(e.message, true);
    } finally {
      busy("");
    }
  };

  // ---------- the round trip with the sound editor ----------
  let soundPath = null; // a new sound from the sound editor, when the video came back with one
  // ---------- the music track ----------
  // { path, name, start (s of the edit), duration } and the settings in the inspector; heard with the preview, lowered
  // while a transcript line is spoken (the export does it properly, with FFmpeg's side-chain compressor).
  let music = null;
  // Text over the picture (CapCut's text track): [{ id, text, start, end, style: "box" | "plain" | "big", pos: "bottom" |
  // "center" | "top" }] in seconds of the edit. Each is drawn on a canvas (Hebrew and the font come out right), shown
  // over the player while it is on, and sent as a PNG of the frame's size to be laid over the exported video.
  let texts = [];
  let nextText = 1;
  let chosenText = null;
  const textPics = new Map();
  /** The frame's size: the opened video's own. */
  const frameSize = () => ({ w: media[0] && loadedM === 0 && video.videoWidth ? video.videoWidth : source?.w ?? 1920, h: media[0] && loadedM === 0 && video.videoHeight ? video.videoHeight : source?.h ?? 1080 });
  /** A text drawn on a clear frame, as a PNG data URL. */
  function textPic(t) {
    const { w, h } = frameSize();
    const key = `${t.text}|${t.style}|${t.pos}|${w}x${h}`;
    if (textPics.get(t.id)?.key === key) return textPics.get(t.id).url;
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    const size = Math.round(h / (t.style === "big" ? 8 : 17));
    g.font = `700 ${size}px Heebo, Arial, sans-serif`;
    g.textAlign = "center"; g.textBaseline = "middle";
    g.direction = /[\u0590-\u05FF\u0600-\u06FF]/.test(t.text) ? "rtl" : "ltr";
    const lines = [];
    for (const para of t.text.split("\n")) {
      let line = "";
      for (const word of para.split(/\s+/)) { const x = line ? `${line} ${word}` : word; if (g.measureText(x).width > w * 0.84 && line) { lines.push(line); line = word; } else line = x; }
      lines.push(line);
    }
    const lh = size * 1.3, block = lines.length * lh;
    const cy = t.pos === "top" ? h * 0.12 + block / 2 : t.pos === "center" ? h / 2 : h * 0.86 - block / 2;
    if (t.style === "box") {
      const bw = Math.min(w * 0.92, Math.max(...lines.map((l) => g.measureText(l).width)) + size * 1.2);
      g.fillStyle = "rgba(0,0,0,0.62)";
      g.beginPath();
      g.roundRect?.(w / 2 - bw / 2, cy - block / 2 - size * 0.35, bw, block + size * 0.7, size * 0.35);
      g.fill();
    }
    lines.forEach((l, i) => {
      const y = cy - block / 2 + lh * (i + 0.5);
      if (t.style !== "box") { g.lineWidth = size / 7; g.strokeStyle = "rgba(0,0,0,0.85)"; g.strokeText(l, w / 2, y); }
      g.fillStyle = "#fff";
      g.fillText(l, w / 2, y);
    });
    const url = c.toDataURL("image/png");
    textPics.set(t.id, { key, url });
    return url;
  }
  const textOver = document.createElement("img");
  textOver.className = "still text-over";
  textOver.alt = "";
  textOver.hidden = true;
  video.parentElement.append(textOver);
  /** Shows the text that is on at the playhead over the player. */
  function syncText(t) {
    const on = texts.filter((x) => t >= x.start && t < x.end).at(-1);
    textOver.hidden = !on;
    if (!on) return;
    textOver.src = textPic(on);
    // The same quarter-second fade in and out as the export.
    const d = Math.min(0.25, (on.end - on.start) / 3);
    textOver.style.opacity = String(Math.max(0, Math.min(1, (t - on.start) / d, (on.end - t) / d)));
  }
  const musicAudio = document.createElement("audio");
  const musicSettings = () => ({ volume: Number($("musicVol").value) / 100, fadeIn: Number($("fadeIn").value) || 0, fadeOut: Number($("fadeOut").value) || 0, duck: $("duck").checked });
  function musicLevel(t) {
    if (!music) return 0;
    const m = musicSettings(), rel = t - music.start, end = total() - music.start;
    if (rel < 0 || rel > end) return 0;
    let v = m.volume;
    if (m.fadeIn && rel < m.fadeIn) v *= rel / m.fadeIn;
    if (m.fadeOut && end - rel < m.fadeOut) v *= Math.max(0, end - rel) / m.fadeOut;
    // Someone speaking now (a transcript line under the playhead): lower, as the export's ducking does.
    if (m.duck && captions().some((c) => t >= c.start && t <= c.end)) v *= 0.3;
    return Math.min(1, v);
  }
  function syncMusic(t, playing) {
    if (!music) return;
    const rel = t - music.start;
    musicAudio.volume = musicLevel(t);
    if (rel < 0 || rel > musicAudio.duration) { musicAudio.pause(); return; }
    if (Math.abs(musicAudio.currentTime - rel) > 0.3) musicAudio.currentTime = rel;
    if (playing && musicAudio.paused) musicAudio.play().catch(() => undefined);
    if (!playing) musicAudio.pause();
  }
  async function setMusic(path) {
    busy(T("loading", "Loading…"));
    try {
      const bytes = await kesher.call("video.soundBytes", { path });
      musicAudio.src = URL.createObjectURL(new Blob([bytes]));
      await new Promise((res) => { musicAudio.onloadedmetadata = res; musicAudio.onerror = res; });
      music = { path, name: path.split("/").pop(), start: music?.start ?? 0, duration: musicAudio.duration || total() };
      $("musicTools").hidden = false;
      $("musicRemove").hidden = false;
      render();
    } catch (e) { msg(e.message, true); } finally { busy(""); }
  }
  async function listMusic() {
    try {
      const files = await kesher.call("video.sounds", {});
      const sel = $("musicPick");
      sel.replaceChildren(sel.options[0], ...files.map((f) => { const o = document.createElement("option"); o.value = f; o.textContent = f.split("/").pop(); return o; }));
      if (!files.length) sel.options[0].textContent = `${T("musicNone", "＋ From the chat…")} (${T("noMusic", "no sound files in the chat")})`;
    } catch { /* not opened from a chat */ }
  }
  $("musicPick").onchange = () => { if ($("musicPick").value) void setMusic($("musicPick").value); };
  $("musicFile").onclick = () => $("musicInput").click();
  $("musicInput").onchange = async () => {
    const f = $("musicInput").files?.[0];
    if (!f) return;
    busy(T("musicAdding", "Adding the music to the chat…"));
    try {
      const r = await kesher.call("video.addSound", { name: f.name, bytes: await f.arrayBuffer() });
      await listMusic();
      await setMusic(r.path);
    } catch (e) { msg(e.message, true); } finally { busy(""); $("musicInput").value = ""; }
  };
  $("musicRemove").onclick = () => { music = null; musicAudio.pause(); musicAudio.removeAttribute("src"); $("musicTools").hidden = true; $("musicRemove").hidden = true; $("musicPick").value = ""; render(); };
  for (const id of ["musicVol", "fadeIn", "fadeOut", "duck"]) $(id).oninput = () => { $("musicVolN").textContent = `${$("musicVol").value}%`; render(); };
  const editKey = () => `edit:${source?.path ?? ""}`;
  /** The edit is kept while she is in the sound editor, so coming back finds it as it was. */
  const saveEdit = () => kesher.call("storage.set", { key: editKey(), value: { clips, media: media.slice(1).map(({ path, kind, duration, name }) => ({ path, kind, duration, name })), texts, at: Date.now() } }).catch(() => undefined);
  async function openSound() {
    if (!source) return;
    play(false);
    await saveEdit();
    busy(T("openingSound", "Taking the sound out for the sound editor…"));
    try { await kesher.call("video.openSound"); } catch (e) { msg(e.message, true); } finally { busy(""); }
  }

  // ---------- open from the chat, export, send ----------

  // ---------- ＋ Add (RESEARCH_LOG "Adding files and objects to the editors"): a video or a picture from the device,
  // this chat or the bank, put into the edit at the playhead (CapCut's "+"), the clip there split around it ----------
  const addedMsg = (n) => (he ? HE.addedClip(n) : `Added: ${n}`);
  async function addClip(fileName, path, bytes) {
    if (!path) throw new Error(T("needChat", "To add clips, open the video editor from a chat"));
    const kind = /\.(png|jpe?g|webp|gif|bmp)$/i.test(fileName) ? "image" : "video";
    const url = URL.createObjectURL(new Blob([bytes]));
    let duration = 5;
    if (kind === "video") {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.src = url;
      duration = await new Promise((resolve, reject) => { v.onloadedmetadata = () => resolve(v.duration); v.onerror = () => reject(new Error(T("cantPlay", "This video cannot be played here"))); });
    }
    // An empty editor: the first video becomes the one it edits.
    if (!source) {
      if (kind === "image") throw new Error(T("startVideo", "Start with a video: a picture goes in once there is one"));
      $("empty").hidden = true;
      $("name").textContent = fileName;
      video.src = url;
      await new Promise((resolve) => { video.onloadedmetadata = resolve; video.onerror = resolve; });
      source = { name: fileName, path, duration };
      media = [{ path, kind, url, duration, name: fileName }];
      loadedM = 0;
      clips = [{ id: nextId++, from: 0, to: duration }];
      chosen = 0; fitZoom(); seek(0); void listMusic();
      return;
    }
    media.push({ path, kind, url, duration, name: fileName });
    const m = media.length - 1;
    remember();
    const { i, src } = locate(now);
    const c = clips[i];
    let at = clips.length;
    if (c && src - c.from >= 0.1 && c.to - src >= 0.1) { clips.splice(i, 1, { ...c, id: nextId++, to: src }, { ...c, id: nextId++, from: src }); at = i + 1; }
    else if (c) at = src - c.from < 0.1 ? i : i + 1;
    clips.splice(at, 0, { id: nextId++, from: 0, to: duration, m });
    chosen = at;
    now = startOf(at);
    after();
    void saveEdit();
    msg(addedMsg(fileName));
  }
  async function addFrom(from) {
    const am = await import("./add-media.js");
    try {
      if (from === "device" || from === "picture") {
        for (const f of await am.pickDevice(from === "picture" ? "image/*" : "video/*,image/*")) {
          busy(T("loading", "Loading the video…"));
          try { const { path, bytes } = await am.uploadMedia(f); await addClip(f.name, path, bytes); } finally { busy(""); }
        }
        return;
      }
      const it = await am.pickMedia(from, ["video", "image"]);
      if (!it) return;
      busy(T("loading", "Loading the video…"));
      try { const { path, bytes } = await am.takeMedia(it); await addClip(it.name, path, bytes); } finally { busy(""); }
    } catch (e) { msg(e.message || String(e), true); }
  }
  /** A title card (CapCut's text clip, simply): the words drawn on a dark frame of the video's size, added as a picture. */
  async function addTitle() {
    if (!source) return msg(T("startVideo", "Start with a video: a picture goes in once there is one"), true);
    const words = window.prompt(T("titleAsk", "What should the card say?"));
    if (!words?.trim()) return;
    const w = media[0] && loadedM === 0 && video.videoWidth ? video.videoWidth : 1920, h = loadedM === 0 && video.videoHeight ? video.videoHeight : 1080;
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    g.fillStyle = "#111114"; g.fillRect(0, 0, w, h);
    g.fillStyle = "#ffffff"; g.textAlign = "center"; g.textBaseline = "middle"; g.direction = /[\u0590-\u05FF]/.test(words) ? "rtl" : "ltr";
    // The words in lines that fit 80 % of the width, as big as fits.
    let size = Math.round(h / 8), lines = [];
    for (; size > 12; size -= 4) {
      g.font = `700 ${size}px Heebo, Arial, sans-serif`;
      lines = [];
      let line = "";
      for (const word of words.trim().split(/\s+/)) { const t = line ? `${line} ${word}` : word; if (g.measureText(t).width > w * 0.8 && line) { lines.push(line); line = word; } else line = t; }
      lines.push(line);
      if (lines.length * size * 1.3 < h * 0.7) break;
    }
    lines.forEach((l, i) => g.fillText(l, w / 2, h / 2 + (i - (lines.length - 1) / 2) * size * 1.3));
    const blob = await new Promise((resolve) => c.toBlob(resolve, "image/png"));
    const am = await import("./add-media.js");
    busy(T("loading", "Loading the video…"));
    try {
      const file = new File([blob], `title-${Date.now().toString(36)}.png`, { type: "image/png" });
      const { path, bytes } = await am.uploadMedia(file);
      await addClip(file.name, path, bytes);
      const last = clips[chosen];
      if (last && media[mOf(last)]?.kind === "image") { remember(); last.to = 3; after(); void saveEdit(); }
    } catch (e) { msg(e.message || String(e), true); } finally { busy(""); }
  }
  /** Text over the video from the playhead (3 s, a dark box low in the frame; change it in the inspector). */
  function addText() {
    if (!source) return msg(T("startVideo", "Start with a video: a picture goes in once there is one"), true);
    const words = window.prompt(T("textAsk", "What should it say?"));
    if (!words?.trim()) return;
    const start = Math.min(now, Math.max(0, total() - 0.5));
    const t = { id: nextText++, text: words.trim(), start, end: Math.min(total(), start + 3), style: "box", pos: "bottom" };
    texts.push(t);
    chosenText = t.id;
    showTextTools();
    void saveEdit();
    render();
  }
  /** The inspector's text tools for the chosen text: its look, its place, and delete. */
  function showTextTools() {
    const t = texts.find((x) => x.id === chosenText);
    $("textTools").hidden = !t;
    if (!t) return;
    $("textStyle").value = t.style;
    $("textPos").value = t.pos;
  }
  $("textStyle").onchange = () => { const t = texts.find((x) => x.id === chosenText); if (t) { t.style = $("textStyle").value; void saveEdit(); render(); } };
  $("textPos").onchange = () => { const t = texts.find((x) => x.id === chosenText); if (t) { t.pos = $("textPos").value; void saveEdit(); render(); } };
  $("textDel").onclick = () => { texts = texts.filter((x) => x.id !== chosenText); chosenText = null; showTextTools(); void saveEdit(); render(); };
  /** The texts for the export: each drawn at the frame's size and put in the chat's folder. */
  async function textPlan() {
    if (!texts.length) return {};
    const am = await import("./add-media.js");
    const out = [];
    for (const t of texts.filter((x) => x.end > x.start + 0.05)) {
      const blob = await (await fetch(textPic(t))).blob();
      const { path } = await am.uploadMedia(new File([blob], `text-${t.id}-${Date.now().toString(36)}.png`, { type: "image/png" }));
      if (!path) throw new Error(T("needChat", "To add clips, open the video editor from a chat"));
      out.push({ path, start: Math.round(t.start * 1000) / 1000, end: Math.round(t.end * 1000) / 1000 });
    }
    return { texts: out };
  }
  async function addMenu(anchor) {
    const am = await import("./add-media.js");
    am.setHebrew(he);
    am.openMenu(anchor, T("addAt", "Goes in at the playhead"), [
      { icon: "💻", label: T("fromDevice", "From the computer / phone"), hint: T("dragToo", "drag in too"), run: () => addFrom("device") },
      { icon: "💬", label: T("fromChat", "From this chat's files"), run: () => addFrom("chat") },
      { icon: "🗂", label: T("fromBank", "From everything made"), run: () => addFrom("bank") },
      "-",
      { icon: "🖼", label: T("picClip", "A picture as a clip"), hint: T("picHint", "5 s, shorten it with trim"), run: () => addFrom("picture") },
      { icon: "💬", label: T("textOver", "Text over the video"), hint: T("textHint", "from the playhead, 3 s"), run: addText },
      { icon: "🔤", label: T("titleCard", "A title card"), hint: T("titleHint", "words on a plain background, 3 s"), run: () => void addTitle() },
    ]);
  }
  $("addBtn").onclick = () => addMenu($("addBtn"));
  for (const zone of [$("tracks"), video.parentElement]) {
    zone.addEventListener("dragover", (e) => { if ([...(e.dataTransfer?.items ?? [])].some((i) => i.kind === "file")) e.preventDefault(); });
    zone.addEventListener("drop", async (e) => {
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      const am = await import("./add-media.js");
      for (const f of files) {
        busy(T("loading", "Loading the video…"));
        try { const { path, bytes } = await am.uploadMedia(f); await addClip(f.name, path, bytes); } catch (err) { msg(err.message || String(err), true); } finally { busy(""); }
      }
    });
  }
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
      source = { name: input.name, path: input.path, duration: video.duration };
      media = [{ path: input.path, kind: "video", url: video.src, duration: video.duration, name: input.name }];
      loadedM = 0;
      clips = [{ id: nextId++, from: 0, to: video.duration }];
      // Back from the sound editor: the edit as she left it (within a day), and the new sound playing instead.
      const kept = await kesher.call("storage.get", { key: editKey() }).catch(() => null);
      if (kept?.clips?.length && Date.now() - kept.at < 86_400_000 && kept.clips.every((c) => mOf(c) || c.to <= video.duration + 0.01)) {
        // The added files come back from the chat's folder; a clip whose file is gone is left out.
        const back = await Promise.all((kept.media ?? []).map(async (md) => {
          const bytes = await kesher.call("media.bytes", { id: `chat:${md.path}` }).catch(() => null);
          return bytes ? { ...md, url: URL.createObjectURL(new Blob([bytes])) } : null;
        }));
        media = [media[0], ...back.map((b) => b ?? { kind: "gone" })];
        clips = kept.clips.filter((c) => media[mOf(c)] && media[mOf(c)].kind !== "gone");
        texts = Array.isArray(kept.texts) ? kept.texts.filter((t) => typeof t?.text === "string") : [];
        nextText = Math.max(0, ...texts.map((t) => t.id)) + 1;
        if (!clips.length) clips = [{ id: 1, from: 0, to: video.duration }];
        nextId = Math.max(...clips.map((c) => c.id)) + 1;
      }
      if (input.sound && input.soundBytes) {
        soundPath = input.sound;
        newAudio.src = URL.createObjectURL(new Blob([input.soundBytes], { type: "audio/wav" }));
        video.muted = true;
        msg(T("replaced", "The sound was replaced from the sound editor"));
      }
      chosen = 0;
      fitZoom();
      seek(0);
      void listMusic();
    } catch (e) {
      msg(e.message, true);
    } finally {
      busy("");
    }
  }
  /** The transcript in the edit's times (what is still in, clip after clip): the captions of the cut. */
  function captions() {
    const out = [];
    let at = 0;
    for (const c of clips) {
      for (const p of mOf(c) ? [] : parts) {
        const a = Math.max(p.start, c.from), b = Math.min(p.end, c.to);
        if (b - a > 0.2) out.push({ start: at + a - c.from, end: at + b - c.from, text: p.text });
      }
      at += len(c);
    }
    return out;
  }
  /** The stretches and the added files for the export: each added file once, numbered in the order it is first used. */
  function cutPlan() {
    const used = [];
    const segments = clips.map((c) => {
      if (!mOf(c)) return { from: c.from, to: c.to };
      let k = used.indexOf(mOf(c));
      if (k < 0) k = used.push(mOf(c)) - 1;
      return { from: c.from, to: c.to, src: k + 1 };
    });
    return { segments, ...(used.length ? { clips: used.map((m) => ({ path: media[m].path })) } : {}) };
  }
  async function exportCut(send, text) {
    if (!source) return;
    play(false);
    busy(T("cutting", "Cutting on your computer… (FFmpeg)"));
    try {
      const withCaptions = parts.length > 0 && $("withCaptions").checked;
      const r = await kesher.call("video.cut", { ...cutPlan(), ...(await textPlan()), send, text, ...(withCaptions ? { captions: captions(), burn: $("burnCaptions").checked } : {}), ...($("shape").value ? { shape: $("shape").value } : {}), ...($("dip").checked ? { fade: 0.4 } : {}), ...(music ? { music: { path: music.path, start: music.start, ...musicSettings() } } : {}) });
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
    $("capRow").hidden = !parts.length;
    $("burnRow").hidden = !parts.length;
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
  $("scenes").onclick = splitScenes;
  $("delBtn").onclick = remove;
  $("trimStart").onclick = () => trim("start");
  $("trimEnd").onclick = () => trim("end");
  $("left").onclick = () => moveClip(-1);
  $("right").onclick = () => moveClip(1);
  $("zoomIn").onclick = () => zoomBy(1.4);
  $("zoomOut").onclick = () => zoomBy(1 / 1.4);
  document.querySelectorAll(".phonebar [data-do]").forEach((b) => (b.onclick = () => ({ split, delete: remove, trimStart: () => trim("start"), trimEnd: () => trim("end"), play: () => play(), add: () => addMenu(b), words: () => $("app").classList.toggle("sheet") })[b.dataset.do]()));

  const KEYS = [["Space", "kPlay", "Play / pause"], ["J / K / L", "kJkl", "Back 5 s / stop / forward (twice = faster)"], ["← / →", "kFrame", "A frame"], ["Home / End", "kHomeEnd", "The start / the end"], ["Shift+← / →", "kSec", "A second"], ["S", "kSplit", "Split at the playhead"], ["Q / W", "kTrim", "Trim the start / end to the playhead"], ["Delete", "kDel", "Delete the clip (the gap closes)"], ["Alt+← / →", "kMove", "Move the clip left / right"], ["Ctrl+Z / Ctrl+Y", "kUndo", "Undo / redo"], ["M", "kMusic", "The music starts at the playhead"], ["+ / −", "kZoom", "Zoom the timeline"]];
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
      home: () => seek(0),
      end: () => seek(total()),
      arrowleft: () => seek(now - (e.shiftKey ? 1 : frame)),
      arrowright: () => seek(now + (e.shiftKey ? 1 : frame)),
      s: split,
      q: () => trim("start"),
      w: () => trim("end"),
      // The music starts at the playhead (CapCut's "align to playhead").
      m: () => { if (!music) return msg(T("noMusicYet", "Choose music first (Music in the inspector)"), true); music.start = Math.max(0, Math.min(now, total() - 0.5)); render(); msg(T("musicHere", "The music starts here")); },
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
