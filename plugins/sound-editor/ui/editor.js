// KesherAI's sound editor, stage 1 (docs/RESEARCH_LOG.md → "The sound editor's screen"): the sound decoded in the page,
// a waveform with a selection, edits on the samples (cut, keep, silence, fades, gain, normalize) with undo, the
// transcript from whisper, and a WAV sent back to the chat. A plugin page with no build step: it talks to KesherAI
// only through window.kesher (kesher.js).
/* global confirm, document, kesher, Blob, URL, AudioContext, requestAnimationFrame, addEventListener, setTimeout, clearTimeout, ResizeObserver, FileReader, devicePixelRatio */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);

  const HE = {
    export: "ייצוא WAV", toChat: "שלח לצ'אט", empty: "פתח צליל מצ'אט: \"עריכה בעורך הסאונד\" בתצוגה שלו.",
    cut: "✂ מחיקה", keep: "השאר רק את זה", silence: "השתקה", fadeIn: "◢ דהייה פנימה", fadeOut: "◣ דהייה החוצה", louder: "‎+3 dB", quieter: "‎−3 dB", normalize: "נרמול",
    hint: "גרירה לבחירה · Space נגן · Delete מחיקה · Ctrl+A הכל · Esc ביטול בחירה",
    transcriptH: "תמלול", transcribe: "תמלל", transcriptHint: "לחיצה על שורה בוחרת אותה; ✂ חותך אותה. Whisper רץ במחשב שלך.",
    playS: "נגן", cutS: "חיתוך", fadeS: "דהייה", volS: "חזק יותר", wordsS: "מילים",
    toChatH: "שליחה לצ'אט", toChatMsg: "הודעה איתו (לא חובה)", cancel: "ביטול", send: "שלח", keysH: "קיצורים (כמו ב-Audition)", close: "סגור",
    toVideo: "↩ חזרה לווידאו", fromVideo: "הסאונד של הווידאו. כשתסיים: \"חזרה לווידאו\".", lengthChanged: "האורך השתנה, אז הסאונד לא יתאים לווידאו בדיוק. להמשיך?", backing: "מחזיר לווידאו…",
    loading: "טוען את הצליל…", transcribing: "מתמלל במחשב… (whisper)", sending: "שולח…", needSel: "קודם בחר קטע (גרירה על הגל)", tooBig: "הקובץ גדול מ-50MB; ייצא קטע קצר יותר",
    silences: (n) => `הסר ${n} שתיקות ארוכות`, noSilences: "אין שתיקות ארוכות", cutLine: "לחתוך את השורה", sel: "בחירה",
    kPlay: "נגן / עצור (הבחירה, אם יש)", kCut: "מחיקת הבחירה", kAll: "בחירת הכל", kEsc: "ביטול הבחירה", kUndo: "ביטול / ביצוע שוב", kZoom: "זום", kMove: "ראש הניגון שנייה אחורה / קדימה",
  };
  let he = false;
  const T = (k, en) => (he && HE[k]) || en;

  // ---------- the sound: one Float32Array per channel ----------
  let ctx = null;
  let rate = 44100;
  let chans = []; // [Float32Array]
  let name = "sound";
  let sel = null; // [a, b] in samples, a < b
  let head = 0; // playhead, in samples
  let view = { start: 0, perPx: 1 }; // the first sample on screen, samples per CSS pixel
  const undoStack = [];
  const redoStack = [];
  const length = () => chans[0]?.length ?? 0;
  const secs = (n) => n / rate;
  const fmt = (n) => { const s = secs(n); return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`; };

  function remember() {
    undoStack.push(chans.map((c) => c.slice()));
    if (undoStack.length > 20) undoStack.shift();
    redoStack.length = 0;
  }
  function undo() { if (undoStack.length) { redoStack.push(chans); chans = undoStack.pop(); after(); } }
  function redo() { if (redoStack.length) { undoStack.push(chans); chans = redoStack.pop(); after(); } }
  function after() {
    head = Math.min(head, length());
    if (sel && (sel[1] > length() || sel[0] >= sel[1])) sel = null;
    draw();
    if (parts.length) renderTranscript();
  }
  const need = () => { if (!sel) { msg(T("needSel", "Select a stretch first (drag on the wave)"), true); return false; } return true; };

  // ---------- edits on the samples ----------
  function cutRange(a, b) {
    chans = chans.map((c) => { const n = new Float32Array(c.length - (b - a)); n.set(c.subarray(0, a)); n.set(c.subarray(b), a); return n; });
    // The words after the cut move up with the sound.
    const d = secs(b - a), sa = secs(a), sb = secs(b);
    parts = parts.flatMap((p) => (p.end <= sa ? [p] : p.start >= sb ? [{ ...p, start: p.start - d, end: p.end - d }] : []));
  }
  const ops = {
    cut() { if (!need()) return; remember(); cutRange(sel[0], sel[1]); head = sel[0]; sel = null; after(); },
    keep() {
      if (!need()) return;
      remember();
      const [a, b] = sel;
      chans = chans.map((c) => c.slice(a, b));
      parts = parts.flatMap((p) => (p.end <= secs(a) || p.start >= secs(b) ? [] : [{ ...p, start: Math.max(0, p.start - secs(a)), end: p.end - secs(a) }]));
      sel = null; head = 0; view.start = 0; fitZoom(); after();
    },
    silence() { if (!need()) return; remember(); chans.forEach((c) => c.fill(0, sel[0], sel[1])); after(); },
    fadeIn() { if (!need()) return; remember(); const [a, b] = sel; chans.forEach((c) => { for (let i = a; i < b; i++) c[i] *= (i - a) / (b - a); }); after(); },
    fadeOut() { if (!need()) return; remember(); const [a, b] = sel; chans.forEach((c) => { for (let i = a; i < b; i++) c[i] *= (b - i) / (b - a); }); after(); },
    louder() { gain(Math.pow(10, 3 / 20)); },
    quieter() { gain(Math.pow(10, -3 / 20)); },
    normalize() {
      const [a, b] = sel ?? [0, length()];
      let peak = 0;
      chans.forEach((c) => { for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(c[i])); });
      if (peak > 0) gainRange(a, b, Math.pow(10, -1 / 20) / peak);
    },
  };
  function gain(k) { const [a, b] = sel ?? [0, length()]; gainRange(a, b, k); }
  function gainRange(a, b, k) {
    remember();
    // Clipped at full scale, as an editor's gain is (the waveform shows it).
    chans.forEach((c) => { for (let i = a; i < b; i++) c[i] = Math.max(-1, Math.min(1, c[i] * k)); });
    after();
  }

  // ---------- playback ----------
  let src = null;
  let startedAt = 0, startedFrom = 0, endAt = 0;
  function play() {
    if (!length()) return;
    if (src) return stop();
    ctx ??= new AudioContext();
    const buf = ctx.createBuffer(chans.length, length(), rate);
    chans.forEach((c, i) => buf.copyToChannel(c, i));
    src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const [a, b] = sel ?? [head >= length() - 10 ? 0 : head, length()];
    startedFrom = a; endAt = b; startedAt = ctx.currentTime;
    src.start(0, secs(a), secs(b - a));
    src.onended = () => { src = null; $("play").textContent = "▶"; draw(); };
    $("play").textContent = "⏸";
    requestAnimationFrame(follow);
  }
  function stop() { src?.stop(); src = null; }
  function follow() {
    if (!src) return;
    head = Math.min(endAt, startedFrom + Math.round((ctx.currentTime - startedAt) * rate));
    // Keep the playhead on screen.
    const w = wrap.clientWidth;
    if ((head - view.start) / view.perPx > w - 20) view.start = head - (w / 3) * view.perPx;
    draw();
    requestAnimationFrame(follow);
  }

  // ---------- drawing: peaks per pixel, the selection, the playhead ----------
  const wrap = $("wrap");
  const canvas = $("canvas");
  function draw() {
    const w = wrap.clientWidth, h = wrap.clientHeight, d = devicePixelRatio || 1;
    canvas.width = w * d; canvas.height = h * d;
    const g = canvas.getContext("2d");
    g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, w, h);
    const n = length();
    $("time").textContent = `${fmt(head)} / ${fmt(n)}`;
    $("selInfo").textContent = sel ? `${T("sel", "selection")} ${fmt(sel[0])}–${fmt(sel[1])} (${(secs(sel[1] - sel[0])).toFixed(1)}s)` : "";
    $("undo").disabled = !undoStack.length;
    $("redo").disabled = !redoStack.length;
    if (!n) return;
    view.start = Math.max(0, Math.min(view.start, Math.max(0, n - w * view.perPx)));
    if (sel) {
      const x0 = (sel[0] - view.start) / view.perPx, x1 = (sel[1] - view.start) / view.perPx;
      g.fillStyle = "rgba(143, 162, 255, 0.28)";
      g.fillRect(x0, 0, x1 - x0, h);
    }
    // Each channel in its own band, min and max of the samples under each pixel.
    const band = h / chans.length;
    g.fillStyle = "#7fe0c0";
    chans.forEach((c, ci) => {
      const mid = band * ci + band / 2;
      for (let x = 0; x < w; x++) {
        const a = Math.floor(view.start + x * view.perPx), b = Math.min(n, Math.floor(view.start + (x + 1) * view.perPx));
        if (a >= n) break;
        let lo = 0, hi = 0;
        const step = Math.max(1, Math.floor((b - a) / 64));
        for (let i = a; i < Math.max(a + 1, b); i += step) { const v = c[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
        g.fillRect(x, mid - hi * band * 0.45, 1, Math.max(1, (hi - lo) * band * 0.45));
      }
    });
    // Words under the wave, where they are said.
    g.fillStyle = "rgba(230, 231, 234, 0.75)";
    g.font = "11px system-ui, sans-serif";
    for (const p of parts) {
      const x = (p.start * rate - view.start) / view.perPx;
      if (x > -200 && x < w) g.fillText(p.text.slice(0, 40), x + 2, h - 6);
    }
    const hx = (head - view.start) / view.perPx;
    g.fillStyle = "#ff6b6b";
    g.fillRect(hx, 0, 2, h);
    const win = $("window");
    win.style.left = `${(view.start / n) * 100}%`;
    win.style.width = `${Math.min(100, ((w * view.perPx) / n) * 100)}%`;
  }
  function fitZoom() { view.perPx = Math.max(1, length() / Math.max(100, wrap.clientWidth)); view.start = 0; draw(); }
  function zoomBy(k) {
    const center = sel ? (sel[0] + sel[1]) / 2 : head;
    view.perPx = Math.max(1, Math.min(length() / 100, view.perPx / k));
    view.start = center - (wrap.clientWidth / 2) * view.perPx;
    draw();
  }

  // ---------- selecting: drag on the wave; a tap moves the playhead ----------
  let drag = null;
  const sampleAt = (e) => Math.max(0, Math.min(length(), Math.round(view.start + (e.clientX - wrap.getBoundingClientRect().left) * view.perPx)));
  wrap.addEventListener("pointerdown", (e) => { if (!length()) return; wrap.setPointerCapture(e.pointerId); drag = sampleAt(e); head = drag; sel = null; draw(); });
  wrap.addEventListener("pointermove", (e) => { if (drag === null) return; const s = sampleAt(e); sel = Math.abs(s - drag) > 2 * view.perPx ? [Math.min(s, drag), Math.max(s, drag)] : null; draw(); });
  wrap.addEventListener("pointerup", () => { drag = null; });
  wrap.addEventListener("wheel", (e) => { e.preventDefault(); if (e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) zoomBy(e.deltaY < 0 ? 1.25 : 0.8); else { view.start += e.deltaX * view.perPx; draw(); } }, { passive: false });
  $("overview").addEventListener("pointerdown", (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    view.start = ((e.clientX - r.left) / r.width) * length() - (wrap.clientWidth / 2) * view.perPx;
    draw();
  });

  // ---------- the transcript ----------
  let parts = [];
  function silences() {
    const out = [];
    const edges = [{ end: 0 }, ...parts, { start: secs(length()) }];
    for (let i = 1; i < edges.length; i++) {
      const a = edges[i - 1].end + 0.25, b = edges[i].start - 0.25;
      if (b - a >= 1) out.push([Math.round(a * rate), Math.round(b * rate)]);
    }
    return out;
  }
  function renderTranscript() {
    $("transcript").replaceChildren(...parts.map((p) => {
      const li = document.createElement("li");
      const t = document.createElement("time");
      t.textContent = fmt(p.start * rate).replace(/\.\d$/, "");
      const s = document.createElement("span");
      s.dir = "auto";
      s.textContent = p.text;
      const cut = document.createElement("button");
      cut.textContent = "✂";
      cut.title = T("cutLine", "Cut this line");
      cut.onclick = (e) => { e.stopPropagation(); remember(); cutRange(Math.round(p.start * rate), Math.min(length(), Math.round(p.end * rate))); after(); };
      li.append(t, s, cut);
      li.onclick = () => { sel = [Math.round(p.start * rate), Math.min(length(), Math.round(p.end * rate))]; head = sel[0]; view.start = sel[0] - 40 * view.perPx; draw(); };
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
    for (const [a, b] of quiet.reverse()) cutRange(a, b);
    after();
  };
  $("transcribe").onclick = async () => {
    busy(T("transcribing", "Transcribing on your computer… (whisper)"));
    try { parts = await kesher.call("sound.transcript"); renderTranscript(); draw(); } catch (e) { msg(e.message, true); } finally { busy(""); }
  };

  // ---------- WAV out ----------
  function wav() {
    const n = length(), ch = chans.length, bytes = 44 + n * ch * 2;
    const buf = new ArrayBuffer(bytes), v = new DataView(buf);
    const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, "RIFF"); v.setUint32(4, bytes - 8, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * ch * 2, true);
    let o = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const s = Math.max(-1, Math.min(1, chans[c][i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
    return new Blob([buf], { type: "audio/wav" });
  }
  const base = () => name.replace(/\.[^.]+$/, "") + "-edited";
  $("export").onclick = () => { if (!length()) return; const a = document.createElement("a"); a.href = URL.createObjectURL(wav()); a.download = `${base()}.wav`; a.click(); };
  $("toChat").onclick = () => { if (!length()) return; $("chatSummary").textContent = `${base()}.wav · ${fmt(length())}`; $("chatDialog").showModal(); };
  $("chatDialog").addEventListener("close", async () => {
    if ($("chatDialog").returnValue !== "ok") return;
    const blob = wav();
    if (blob.size > 50 * 1024 * 1024) return msg(T("tooBig", "Over 50 MB; export a shorter stretch"), true);
    busy(T("sending", "Sending…"));
    try {
      const data = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(blob); });
      await kesher.call("chat.sendFile", { name: `${base()}.wav`, data, text: $("chatText").value.trim() });
    } catch (e) { msg(e.message, true); } finally { busy(""); }
  });

  // ---------- back to the video it came from (the video editor's sound track) ----------
  let firstLength = 0;
  $("toVideo").onclick = async () => {
    if (!length()) return;
    if (Math.abs(length() - firstLength) > rate * 0.05 && !confirm(T("lengthChanged", "The length changed, so the sound will not match the video exactly. Go on?"))) return;
    busy(T("backing", "Going back to the video…"));
    try {
      const data = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(wav()); });
      await kesher.call("sound.backToVideo", { name: `${base()}.wav`, data });
    } catch (e) { msg(e.message, true); } finally { busy(""); }
  };

  // ---------- open ----------
  let busyCount = 0;
  function busy(text) { busyCount = Math.max(0, busyCount + (text ? 1 : -1)); $("busy").hidden = busyCount <= 0; if (text) $("busyText").textContent = text; }
  let msgTimer;
  function msg(text, error) { const m = $("msg"); m.textContent = text; m.className = `status show${error ? " error" : ""}`; clearTimeout(msgTimer); msgTimer = setTimeout(() => (m.className = "status"), error ? 6000 : 3500); }
  async function open() {
    busy(T("loading", "Loading the sound…"));
    try {
      const input = await kesher.call("editor.input");
      if (!input?.bytes) return;
      name = input.name;
      $("name").textContent = input.name;
      ctx = new AudioContext();
      const audio = await ctx.decodeAudioData(input.bytes.slice(0));
      rate = audio.sampleRate;
      chans = Array.from({ length: Math.min(2, audio.numberOfChannels) }, (_, i) => audio.getChannelData(i).slice());
      $("empty").hidden = true;
      firstLength = length();
      if (input.returnVideo) { $("toVideo").hidden = false; $("toChat").classList.remove("primary"); msg(T("fromVideo", "The video's sound. When you are done: \"Back to the video\".")); }
      fitZoom();
    } catch (e) { msg(e.message || "The sound could not be read.", true); } finally { busy(""); }
  }

  // ---------- buttons and keys ----------
  Object.keys(ops).forEach((k) => ($(k).onclick = ops[k]));
  $("undo").onclick = undo; $("redo").onclick = redo; $("play").onclick = play;
  $("zoomIn").onclick = () => zoomBy(1.5); $("zoomOut").onclick = () => zoomBy(1 / 1.5);
  document.querySelectorAll(".phonebar [data-do]").forEach((b) => (b.onclick = () => (b.dataset.do === "play" ? play() : b.dataset.do === "words" ? $("app").classList.toggle("sheet") : ops[b.dataset.do]())));
  const KEYS = [["Space", "kPlay", "Play / pause (the selection, if any)"], ["Delete", "kCut", "Delete the selection"], ["Ctrl+A", "kAll", "Select all"], ["Esc", "kEsc", "Let go of the selection"], ["Ctrl+Z / Ctrl+Y", "kUndo", "Undo / redo"], ["+ / −", "kZoom", "Zoom"], ["← / →", "kMove", "The playhead a second back / on"]];
  function showKeys() {
    $("keysTable").replaceChildren(...KEYS.map(([k, key, en]) => { const tr = document.createElement("tr"); const a = document.createElement("td"); const kbd = document.createElement("kbd"); kbd.textContent = k; a.append(kbd); const b = document.createElement("td"); b.textContent = T(key, en); tr.append(a, b); return tr; }));
    $("keysDialog").showModal();
  }
  $("keysBtn").onclick = showKeys;
  addEventListener("keydown", (e) => {
    if (e.target.closest?.("input, textarea, dialog")) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
    if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); return redo(); }
    if ((e.ctrlKey || e.metaKey) && k === "a") { e.preventDefault(); sel = length() ? [0, length()] : null; return draw(); }
    if (e.ctrlKey || e.metaKey) return;
    const map = { " ": play, delete: ops.cut, backspace: ops.cut, escape: () => { sel = null; draw(); }, "+": () => zoomBy(1.5), "=": () => zoomBy(1.5), "-": () => zoomBy(1 / 1.5), arrowleft: () => { head = Math.max(0, head - rate); draw(); }, arrowright: () => { head = Math.min(length(), head + rate); draw(); }, "?": showKeys };
    if (map[k]) { e.preventDefault(); map[k](); }
  });
  new ResizeObserver(() => draw()).observe(wrap);
  kesher.call("info").then((i) => {
    he = i.locale === "he";
    if (he) { document.documentElement.dir = "rtl"; document.querySelectorAll("[data-t]").forEach((el) => (el.textContent = T(el.dataset.t, el.textContent))); }
    draw();
  }).catch(() => undefined);
  open();
})();
