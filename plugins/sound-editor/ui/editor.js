// KesherAI's sound editor, stage 1 (docs/RESEARCH_LOG.md → "The sound editor's screen"): the sound decoded in the page,
// a waveform with a selection, edits on the samples (cut, keep, silence, fades, gain, normalize) with undo, the
// transcript from whisper, and a WAV sent back to the chat. A plugin page with no build step: it talks to KesherAI
// only through window.kesher (kesher.js).
/* global confirm, navigator, window, OfflineAudioContext, document, kesher, Blob, URL, AudioContext, requestAnimationFrame, addEventListener, setTimeout, clearTimeout, ResizeObserver, FileReader, devicePixelRatio */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);

  const HE = {
    musicWords: "מוזיקה ממילים", musicWordsHint: "דרך הצ׳אט", musicAsk: "איזו מוזיקה? (למשל: פופ שמח עם גיטרה, 40 שניות)", musicSent: "ביקשתי מהצ׳אט. כשהשיר מוכן (כמה דקות), הוסף אותו מ״מהקבצים של הצ׳אט״.", trackHere: "לערוץ משלו", trackVol: "עוצמה", trackHint: "אפשר להזיז ולהשתיק", trackN: (n) => `ערוץ ${n}`, mute: "השתק", unmute: "בטל השתקה", mergeT: "מזג לצליל", removeT: "הסר את הערוץ", dragT: "גרירה: מתי הוא מתחיל",
    addB: "＋ הוסף", addS: "הוסף", addAt: "נכנס במקום הסמן", fromDevice: "מהמחשב / מהטלפון", fromChat: "מהקבצים של הצ׳אט", fromBank: "מבנק היצירות", dragToo: "גם גרירה", recHere: "הקלטה כאן", micToo: "מהמיקרופון", voiceWords: "קול ממילים", howH: "איך להכניס?", insertHere: "להכניס במקום הסמן", insertHint: "השאר זז קדימה", mixHere: "לערבב מעל, מהסמן", mixHint: "האורך לא משתנה", addedSound: (n) => `נוסף: ${n}`,
    kHomeEnd: "התחלה / סוף",
    export: "ייצוא WAV", toChat: "שלח לצ'אט", empty: "פתח צליל מצ'אט: \"עריכה בעורך הסאונד\" בתצוגה שלו.",
    cut: "✂ מחיקה", keep: "השאר רק את זה", silence: "השתקה", fadeIn: "◢ דהייה פנימה", fadeOut: "◣ דהייה החוצה", reverse: "⇄ הפוך", speedL: "מהירות", speedHint: "גבוה ומהיר יותר, או נמוך ואיטי יותר", louder: "‎+3 dB", quieter: "‎−3 dB", normalize: "נרמול", clean: "🧹 ניקוי רעש", cleaning: "מנקה רעש…", cleanedSel: "הרעש נוקה (נלמד מהקטע שבחרת)", cleanedAuto: "הרעש נוקה (נלמד מהרגעים השקטים)",
    hint: "גרירה לבחירה · Space נגן · Delete מחיקה · Ctrl+A הכל · Esc ביטול בחירה",
    transcriptH: "תמלול", transcribe: "תמלל", transcriptHint: "לחיצה על שורה בוחרת אותה; ✂ חותך אותה. Whisper רץ במחשב שלך.",
    playS: "נגן", cutS: "חיתוך", fadeS: "דהייה", volS: "חזק יותר", wordsS: "מילים",
    toChatH: "שליחה לצ'אט", toChatMsg: "הודעה איתו (לא חובה)", cancel: "ביטול", send: "שלח", keysH: "קיצורים (כמו ב-Audition)", close: "סגור",
    toVideo: "↩ חזרה לווידאו", fromVideo: "הסאונד של הווידאו. כשתסיים: \"חזרה לווידאו\".", lengthChanged: "האורך השתנה, אז הסאונד לא יתאים לווידאו בדיוק. להמשיך?", backing: "מחזיר לווידאו…",
    rec: "הקלטה", stopRec: "עצור", toInst: "🎻 לכלי נגינה…", instH: "לכלי נגינה", snapKey: "לסולם", snapBeat: "על הקצב", octave: "אוקטבה", listen: "האזנה", origVol: "המקור",
    instMix: "ערבב מעל הסאונד", withChords: "אקורדים מתחת", cPiano: "פסנתר", cGuitar: "גיטרה", cStrings: "כלי קשת", cChoir: "מקהלה", instReplace: "החלף בכלי", instS: "כלי", instHint: "זמזם או שרוק צלילים נפרדים (\"טה טה\" עוזר); ביטבוקס הופך לתופים. הכלים: FluidR3 (CC BY 3.0, Frank Wen).",
    found: (n) => `נמצאו ${n} תווים`, hitsFound: (n) => `נמצאו ${n} מכות`, none: "לא נמצאו תווים ברורים. נסה לזמזם חזק וברור יותר.", rendering: "מנגן את הכלי…", countIn: "ספירה…", recording: "מקליט… (R או עצור)", micNo: "אין גישה למיקרופון",
    keyName: (k) => `לסולם: ${k}`,
    toVoice: "🗣 בקול אחר…", voiceH: "בקול אחר", voiceText: "מה להגיד (מהשורה שנבחרה, או לכתוב)", voicePick: "הקול", voiceNone: "אין עדיין קולות: צור קול משלך בקול ← \"קול משלך\", או הפעל את הקול הטבעי בהגדרות ← דיבור.",
    voiceInsert: "הכנס בראש הניגון", voiceReplace: "החלף את הבחירה", speaking: "הקול מדבר… (במחשב)", clone: "הקול שלך", kokoro: "טבעי (אנגלית)",
    emptyRec: "פתח צליל מצ'אט, או לחץ ● הקלטה וזמזם או שרוק.",
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

  // More tracks (Audacity's and Descript's lanes): a sound added "on a track of its own" stays apart, moved and
  // muted freely, and is mixed in only when played, exported or merged. [{ id, name, samples, at, muted }]
  let layers = [];
  let nextLayer = 1;
  /** The sound with its tracks mixed in (what is played and exported). */
  function mixed() {
    const live = layers.filter((l) => !l.muted);
    if (!live.length) return chans;
    const n = Math.max(length(), ...live.map((l) => l.at + l.samples[0].length));
    return chans.map((c, i) => {
      const out = new Float32Array(n);
      out.set(c);
      for (const l of live) { const x = l.samples[Math.min(i, l.samples.length - 1)], g = l.gain ?? 1; for (let j = 0; j < x.length; j++) out[l.at + j] += x[j] * g; }
      for (let j = 0; j < n; j++) out[j] = Math.max(-1, Math.min(1, out[j]));
      return out;
    });
  }
  function remember() {
    undoStack.push(chans.map((c) => c.slice()));
    if (undoStack.length > 20) undoStack.shift();
    redoStack.length = 0;
  }
  function undo() { if (undoStack.length) { redoStack.push(chans); chans = undoStack.pop(); after(); } }
  function redo() { if (redoStack.length) { undoStack.push(chans); chans = redoStack.pop(); after(); } }
  function after() {
    renderLayers();
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
    // Audacity's Reverse: the selection played backwards.
    reverse() { if (!need()) return; remember(); const [a, b] = sel; chans.forEach((c) => c.subarray(a, b).reverse()); after(); },
    louder() { gain(Math.pow(10, 3 / 20)); },
    quieter() { gain(Math.pow(10, -3 / 20)); },
    normalize() {
      const [a, b] = sel ?? [0, length()];
      let peak = 0;
      chans.forEach((c) => { for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(c[i])); });
      if (peak > 0) gainRange(a, b, Math.pow(10, -1 / 20) / peak);
    },
    // Noise clean-up (Audacity's Noise Reduction, in one step): a short selection is the noise to learn; with none (or
    // a long one), the quietest moments are. The whole sound is cleaned, as the noise runs under all of it.
    clean() {
      if (!length()) return;
      const fromSel = sel && sel[1] - sel[0] < length() * 0.6 && sel[1] - sel[0] > rate * 0.1;
      busy(T("cleaning", "Cleaning the noise…"));
      // After the busy sign is painted; a minute of sound takes about a second.
      setTimeout(() => {
        try {
          remember();
          chans = chans.map((c) => window.KClean.clean(c, fromSel ? window.KClean.profile(c, sel[0], sel[1]) : window.KClean.profile(c)));
          after();
          msg(fromSel ? T("cleanedSel", "The noise is cleaned (learned from your selection)") : T("cleanedAuto", "The noise is cleaned (learned from the quiet moments)"));
        } catch (e) { msg(e.message, true); } finally { busy(""); }
      }, 30);
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
    const all = mixed();
    const buf = ctx.createBuffer(all.length, all[0].length, rate);
    all.forEach((c, i) => buf.copyToChannel(c, i));
    src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const [a, b] = sel ?? [head >= all[0].length - 10 ? 0 : head, all[0].length];
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
  let laneView = "";
  function draw() {
    // The tracks' lanes follow the wave's zoom and scroll (rebuilt only when those change, not on every frame).
    if (layers.length && laneView !== `${view.start}|${view.perPx}`) { laneView = `${view.start}|${view.perPx}`; renderLayers(); }
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
    const all = mixed();
    const n = all[0]?.length ?? 0, ch = all.length, bytes = 44 + n * ch * 2;
    const buf = new ArrayBuffer(bytes), v = new DataView(buf);
    const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, "RIFF"); v.setUint32(4, bytes - 8, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * ch * 2, true);
    let o = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const s = Math.max(-1, Math.min(1, all[c][i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
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

  // ---------- record (R): a count-in of four clicks, then the microphone into a new sound ----------
  let recording = null;
  let recordInto = false;
  async function record() {
    if (recording) return recording.stop();
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); } catch { return msg(T("micNo", "No access to the microphone"), true); }
    ctx ??= new AudioContext();
    await ctx.resume();
    // Four clicks at the tempo of the instrument dialog, so the notes land on the beat.
    const beat = 60 / Math.max(40, Math.min(220, +$("bpm").value || 100));
    msg(T("countIn", "Counting in…"));
    for (let i = 0; i < 4; i++) {
      const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + i * beat;
      o.frequency.value = i ? 1000 : 1500; g.gain.setValueAtTime(0.3, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.06);
    }
    await new Promise((r) => setTimeout(r, 4 * beat * 1000));
    const srcNode = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const pieces = [];
    proc.onaudioprocess = (e) => pieces.push(e.inputBuffer.getChannelData(0).slice());
    srcNode.connect(proc).connect(ctx.destination);
    $("rec").classList.add("on");
    msg(T("recording", "Recording… (R or stop)"));
    recording = {
      stop() {
        proc.disconnect(); srcNode.disconnect(); stream.getTracks().forEach((t) => t.stop());
        $("rec").classList.remove("on");
        recording = null;
        const n = pieces.reduce((s, p) => s + p.length, 0);
        if (!n) return;
        const mono = new Float32Array(n);
        let o = 0;
        for (const p of pieces) { mono.set(p, o); o += p.length; }
        // Into the open sound at the playhead (Audacity records into the cursor), or a new sound.
        if (length() && recordInto) {
          recordInto = false;
          const at = Math.min(head, length());
          void resampled(mono, ctx.sampleRate).then((v) => { putAt(v, at, false); msg(addedMsg("🎙")); });
          return;
        }
        remember();
        rate = ctx.sampleRate;
        chans = [mono];
        parts = [];
        name = "recording.wav";
        $("name").textContent = name;
        $("empty").hidden = true;
        sel = null; head = 0; firstLength = length();
        fitZoom(); after();
      },
    };
  }
  $("rec").onclick = record;

  // ---------- to an instrument (design HumToInstrument) ----------
  const K = window.KInstrument;
  let inst = "violin";
  let found = { notes: [], hits: [], key: null, from: 0, to: 0 };
  /** The notes as they will be played: the switches applied. */
  function shaped() {
    let ns = found.notes;
    if ($("snapKey").checked && found.key) ns = K.toKey(ns, found.key);
    if ($("snapBeat").checked) ns = K.toBeat(ns, 30 / Math.max(40, +$("bpm").value || 100));
    const oct = +$("octave").value;
    return ns.map((n) => ({ ...n, midi: n.midi + oct }));
  }
  function drawRoll() {
    const c = $("roll"), w = c.clientWidth, h = c.clientHeight, d = devicePixelRatio || 1;
    c.width = w * d; c.height = h * d;
    const g = c.getContext("2d");
    g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, w, h);
    const dur = secs(found.to - found.from) || 1;
    if (inst === "drums") {
      const rows = { hat: 0.2, snare: 0.5, kick: 0.8 };
      g.fillStyle = "#f5d36b";
      found.hits.forEach((x) => g.fillRect((x.start / dur) * w, rows[x.kind] * h - 6, 6, 12));
      g.fillStyle = "#9b9fa8"; g.font = "11px system-ui";
      Object.entries(rows).forEach(([k, y]) => g.fillText(k, 4, y * h - 8));
      return;
    }
    const ns = shaped();
    if (!ns.length) return;
    const lo = Math.min(...ns.map((n) => n.midi)) - 2, hi = Math.max(...ns.map((n) => n.midi)) + 2, row = h / (hi - lo + 1);
    g.fillStyle = "#26272b";
    for (let m = lo; m <= hi; m++) if ([1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12)) g.fillRect(0, (hi - m) * row, w, row);
    g.fillStyle = "#8fa2ff";
    ns.forEach((n) => g.fillRect((n.start / dur) * w, (hi - n.midi) * row + 1, Math.max(3, ((n.end - n.start) / dur) * w - 1), Math.max(3, row - 2)));
    g.fillStyle = "#9b9fa8"; g.font = "10px system-ui";
    for (let m = lo; m <= hi; m++) if (m % 12 === 0) g.fillText(K.noteName(m), 2, (hi - m) * row + row - 2);
  }
  function renderGallery() {
    $("gallery").replaceChildren(...K.INSTRUMENTS.map(([id, icon, h, en]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = id === inst ? "on" : "";
      const i = document.createElement("b");
      i.textContent = icon;
      b.append(i, document.createTextNode(he ? h : en));
      b.onclick = () => { inst = id; renderGallery(); showFound(); drawRoll(); };
      return b;
    }));
  }
  function showFound() {
    const names = ["דו", "רה♭", "רה", "מי♭", "מי", "פה", "סול♭", "סול", "לה♭", "לה", "סי♭", "סי"];
    const en = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"];
    if (found.key) $("keyLabel").textContent = he ? HE.keyName(`${names[found.key.root]} ${found.key.minor ? "מינור" : "מז'ור"}`) : `To the key: ${en[found.key.root]} ${found.key.minor ? "minor" : "major"}`;
    $("instFound").textContent = inst === "drums" ? (he ? HE.hitsFound(found.hits.length) : `${found.hits.length} hits found`) : (he ? HE.found(found.notes.length) : `${found.notes.length} notes found`);
  }
  $("toInst").onclick = () => {
    if (!length()) return;
    stop();
    const [a, b] = sel ?? [0, length()];
    // One voice: the channels averaged.
    const mono = new Float32Array(b - a);
    chans.forEach((c) => { for (let i = 0; i < mono.length; i++) mono[i] += c[a + i] / chans.length; });
    const ns = K.notes(mono, rate);
    found = { notes: ns, hits: K.hits(mono, rate), key: ns.length ? K.keyOf(ns) : null, from: a, to: b };
    if (!ns.length && !found.hits.length) return msg(T("none", "No clear notes found. Try humming louder and clearer."), true);
    renderGallery();
    showFound();
    $("instDialog").showModal();
    requestAnimationFrame(drawRoll);
  };
  ["snapKey", "snapBeat", "bpm", "octave"].forEach((id) => ($(id).onchange = drawRoll));
  /** The stretch as the instrument plays it (mono samples). */
  const played = async () => {
    const n = found.to - found.from;
    if (inst === "drums") return K.renderDrums(found.hits, rate, n);
    const melody = shaped();
    const out = await K.render(melody, inst, rate, n);
    // Chords under the melody, a bar (four beats at the tempo) each, in the instrument chosen for them.
    if ($("withChords").checked && found.key) {
      const bar = 240 / Math.max(40, +$("bpm").value || 100);
      const under = await K.render(K.chords(melody, found.key, bar, n / rate), $("chordInst").value, rate, n);
      for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, out[i] + under[i] * 0.7));
    }
    return out;
  };
  let previewSrc = null;
  $("instPreview").onclick = async () => {
    if (previewSrc) { previewSrc.stop(); previewSrc = null; return; }
    busy(T("rendering", "Playing the instrument…"));
    try {
      const out = await played();
      const k = +$("origVol").value / 100;
      const buf = ctx.createBuffer(1, out.length, rate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < out.length; i++) { let o = 0; chans.forEach((c) => (o += c[found.from + i] / chans.length)); d[i] = Math.max(-1, Math.min(1, out[i] + o * k)); }
      previewSrc = ctx.createBufferSource();
      previewSrc.buffer = buf;
      previewSrc.connect(ctx.destination);
      previewSrc.onended = () => (previewSrc = null);
      previewSrc.start();
    } catch (e) { msg(e.message, true); } finally { busy(""); }
  };
  /** Puts the instrument into the sound: instead of the stretch, or mixed over it (with the original's volume). */
  async function apply(mix) {
    previewSrc?.stop(); previewSrc = null;
    busy(T("rendering", "Playing the instrument…"));
    try {
      const out = await played();
      const k = mix ? 1 : +$("origVol").value / 100;
      remember();
      chans.forEach((c) => { for (let i = 0; i < out.length; i++) c[found.from + i] = Math.max(-1, Math.min(1, out[i] + c[found.from + i] * k)); });
      $("instDialog").close();
      after();
    } catch (e) { msg(e.message, true); } finally { busy(""); }
  }
  $("instReplace").onclick = () => apply(false);
  $("instMix").onclick = () => apply(true);

  // ---------- in another voice: the words said again by a cloned or a natural voice ----------
  let said = null; // { text, voice, samples } of the last thing said, so Listen then Replace does not say it twice
  async function say() {
    const text = $("voiceText").value.trim(), voice = $("voicePick").value;
    if (said && said.text === text && said.voice === voice) return said.samples;
    busy(T("speaking", "The voice is speaking… (on your computer)"));
    try {
      const bytes = await kesher.call("sound.say", { voice, text });
      ctx ??= new AudioContext();
      const a = await ctx.decodeAudioData(bytes);
      // At the editor's rate and channels, so it can go straight into the sound.
      const off = new OfflineAudioContext(chans.length || 1, Math.ceil(a.duration * (length() ? rate : a.sampleRate)), length() ? rate : a.sampleRate);
      const src = off.createBufferSource();
      src.buffer = a;
      src.connect(off.destination);
      src.start();
      const r = await off.startRendering();
      said = { text, voice, samples: Array.from({ length: r.numberOfChannels }, (_, i) => r.getChannelData(i)), rate: r.sampleRate };
      return said.samples;
    } finally { busy(""); }
  }
  $("toVoice").onclick = async () => {
    const line = sel && parts.find((p) => Math.abs(p.start * rate - sel[0]) < rate * 0.3);
    if (line) $("voiceText").value = line.text;
    const voices = await kesher.call("sound.voices").catch(() => []);
    $("voicePick").replaceChildren(...voices.map((v) => { const o = document.createElement("option"); o.value = v.id; o.textContent = `${v.name} · ${T(v.kind, v.kind)}`; return o; }));
    $("voiceNone").hidden = voices.length > 0;
    ["voiceListen", "voiceInsert", "voiceReplace"].forEach((id) => ($(id).disabled = !voices.length));
    $("voiceDialog").showModal();
  };
  $("voiceListen").onclick = async () => {
    try {
      const out = await say();
      const buf = ctx.createBuffer(out.length, out[0].length, said.rate);
      out.forEach((c, i) => buf.copyToChannel(c, i));
      const src = ctx.createBufferSource();
      src.buffer = buf; src.connect(ctx.destination); src.start();
    } catch (e) { msg(e.message, true); }
  };
  /** Puts the words into the sound: instead of the selection (or at the playhead), the rest moving to make room. */
  async function putVoice(replace) {
    try {
      const out = await say();
      if (!length()) { rate = said.rate; chans = out.map((c) => c.slice()); }
      else {
        remember();
        const [a, b] = replace && sel ? sel : [head, head];
        chans = chans.map((c, i) => { const v = out[Math.min(i, out.length - 1)]; const n = new Float32Array(c.length - (b - a) + v.length); n.set(c.subarray(0, a)); n.set(v, a); n.set(c.subarray(b), a + v.length); return n; });
        sel = [a, a + out[0].length];
      }
      $("empty").hidden = true;
      $("voiceDialog").close();
      after();
    } catch (e) { msg(e.message, true); }
  }
  $("voiceReplace").onclick = () => putVoice(true);
  $("voiceInsert").onclick = () => putVoice(false);


  // ---------- ＋ Add (RESEARCH_LOG "Adding files and objects to the editors"): a sound from the device, this chat or
  // the bank, recorded here, or a voice from words, put in at the playhead (the rest moves on) or mixed over it ----------
  const TT = (k, en) => (he && HE[k] !== undefined ? HE[k] : en);
  const addedMsg = (n) => (he ? HE.addedSound(n) : `Added: ${n}`);
  /** Samples at the editor's rate and channel count (a sound of another rate or mono / stereo fits in). */
  async function resampled(mono, fromRate) {
    const outRate = length() ? rate : fromRate;
    const off = new OfflineAudioContext(chans.length || 1, Math.max(1, Math.ceil((mono.length / fromRate) * outRate)), outRate);
    const buf = off.createBuffer(1, mono.length, fromRate);
    buf.copyToChannel(mono, 0);
    const src = off.createBufferSource();
    src.buffer = buf; src.connect(off.destination); src.start();
    const r = await off.startRendering();
    return Array.from({ length: r.numberOfChannels }, (_, i) => r.getChannelData(i));
  }
  async function decoded(bytes) {
    ctx ??= new AudioContext();
    const a = await ctx.decodeAudioData(bytes.slice(0));
    const outRate = length() ? rate : a.sampleRate;
    const off = new OfflineAudioContext(chans.length || Math.min(2, a.numberOfChannels), Math.max(1, Math.ceil(a.duration * outRate)), outRate);
    const src = off.createBufferSource();
    src.buffer = a; src.connect(off.destination); src.start();
    const r = await off.startRendering();
    return { samples: Array.from({ length: r.numberOfChannels }, (_, i) => r.getChannelData(i)), rate: r.sampleRate };
  }
  /** Puts samples in at a point: inserted (the rest moves on) or mixed over (the length stays, unless it runs past the end). */
  function putAt(v, at, mix) {
    remember();
    chans = chans.map((c, i) => {
      const x = v[Math.min(i, v.length - 1)];
      if (!mix) { const n = new Float32Array(c.length + x.length); n.set(c.subarray(0, at)); n.set(x, at); n.set(c.subarray(at), at + x.length); return n; }
      const n = new Float32Array(Math.max(c.length, at + x.length));
      n.set(c);
      for (let j = 0; j < x.length; j++) n[at + j] = Math.max(-1, Math.min(1, n[at + j] + x[j]));
      return n;
    });
    sel = [at, at + v[0].length];
    $("empty").hidden = true;
    after();
  }
  async function addBytes(fileName, bytes, anchor) {
    const d = await decoded(bytes);
    if (!length()) {
      remember();
      rate = d.rate; chans = d.samples.map((c) => c.slice()); parts = [];
      name = fileName; $("name").textContent = name; $("empty").hidden = true;
      sel = null; head = 0; firstLength = length();
      fitZoom(); after();
      return;
    }
    const at = Math.min(head, length());
    const am = await import("./add-media.js");
    am.openMenu(anchor, TT("howH", "How should it go in?"), [
      { icon: "⇥", label: TT("insertHere", "Insert at the playhead"), hint: TT("insertHint", "the rest moves on"), run: () => { putAt(d.samples, at, false); msg(addedMsg(fileName)); } },
      { icon: "⇅", label: TT("mixHere", "Mix over, from the playhead"), hint: TT("mixHint", "the length stays"), run: () => { putAt(d.samples, at, true); msg(addedMsg(fileName)); } },
      { icon: "☰", label: TT("trackHere", "On a track of its own"), hint: TT("trackHint", "move it and mute it freely"), run: () => { layers.push({ id: nextLayer++, name: fileName, samples: d.samples, at, muted: false }); after(); msg(addedMsg(fileName)); } },
    ]);
  }
  async function addFrom(from, anchor) {
    const am = await import("./add-media.js");
    try {
      if (from === "device") {
        const [f] = await am.pickDevice("audio/*,video/*,.mp3,.wav,.m4a,.flac,.ogg,.opus", false);
        if (!f) return;
        busy(T("loading", "Loading the sound…"));
        try { const { bytes } = await am.uploadMedia(f); await addBytes(f.name, bytes, anchor); } finally { busy(""); }
        return;
      }
      const it = await am.pickMedia(from, ["audio", "video"]);
      if (!it) return;
      busy(T("loading", "Loading the sound…"));
      try { const { bytes } = await am.takeMedia(it); await addBytes(it.name, bytes, anchor); } finally { busy(""); }
    } catch (e) { msg(e.message || String(e), true); }
  }
  /** Music from words: the chat makes it with its song model (ACE-Step), and it comes back through "From this chat". */
  async function musicFromWords() {
    const words = window.prompt(TT("musicAsk", "What music? (happy pop with a guitar, 40 seconds…)"));
    if (!words?.trim()) return;
    try {
      await kesher.call("chat.ask", { text: `Make music: ${words.trim()}. Use make_music.` });
      msg(TT("musicSent", "Asked the chat. When the song is ready (a few minutes), add it from \"From this chat\"."));
    } catch (e) { msg(e.message || String(e), true); }
  }
  async function addMenu(anchor) {
    const am = await import("./add-media.js");
    am.setHebrew(he);
    am.openMenu(anchor, TT("addAt", "Goes in at the playhead"), [
      { icon: "💻", label: TT("fromDevice", "From the computer / phone"), hint: TT("dragToo", "drag in too"), run: () => addFrom("device", anchor) },
      { icon: "💬", label: TT("fromChat", "From this chat's files"), run: () => addFrom("chat", anchor) },
      { icon: "🗂", label: TT("fromBank", "From everything made"), run: () => addFrom("bank", anchor) },
      "-",
      { icon: "⏺", label: TT("recHere", "Record here"), hint: TT("micToo", "from the microphone"), run: () => { recordInto = true; record(); } },
      { icon: "🗣", label: TT("voiceWords", "A voice from words"), run: () => $("toVoice").click() },
      { icon: "🎵", label: TT("musicWords", "Music from words"), hint: TT("musicWordsHint", "through the chat"), run: () => void musicFromWords() },
    ]);
  }
  $("addBtn").onclick = () => addMenu($("addBtn"));
  /** The tracks' lanes under the wave, in the wave's own scale: drag a bar to move it, mute, merge or remove it. */
  function renderLayers() {
    const box = $("layers");
    if (!box) return;
    box.hidden = !layers.length;
    box.replaceChildren(...layers.map((l, k) => {
      const row = document.createElement("div");
      row.className = `layer${l.muted ? " muted" : ""}`;
      const bar = document.createElement("div");
      bar.className = "layer-bar";
      bar.textContent = `☰ ${he ? HE.trackN(k + 2) : `Track ${k + 2}`} · ${l.name}`;
      bar.title = TT("dragT", "Drag: when it starts");
      bar.style.left = `${(l.at - view.start) / view.perPx}px`;
      bar.style.width = `${Math.max(6, l.samples[0].length / view.perPx)}px`;
      bar.onpointerdown = (e) => {
        bar.setPointerCapture(e.pointerId);
        const x0 = e.clientX, a0 = l.at;
        bar.onpointermove = (ev) => { l.at = Math.max(0, Math.round(a0 + (ev.clientX - x0) * view.perPx)); bar.style.left = `${(l.at - view.start) / view.perPx}px`; };
        bar.onpointerup = () => { bar.onpointermove = null; };
      };
      const tools = document.createElement("span");
      tools.className = "layer-tools";
      const b = (txt, title, fn) => { const x = document.createElement("button"); x.textContent = txt; x.title = title; x.setAttribute("aria-label", title); x.onclick = fn; return x; };
      // Its volume (0–150 %), as Audacity's track gain.
      const vol = document.createElement("input");
      vol.type = "range"; vol.min = "0"; vol.max = "150"; vol.value = String(Math.round((l.gain ?? 1) * 100));
      vol.className = "layer-vol";
      vol.title = `${TT("trackVol", "Volume")} ${vol.value}%`;
      vol.setAttribute("aria-label", TT("trackVol", "Volume"));
      vol.oninput = () => { l.gain = Number(vol.value) / 100; vol.title = `${TT("trackVol", "Volume")} ${vol.value}%`; };
      vol.onpointerdown = (e) => e.stopPropagation();
      tools.append(
        vol,
        b(l.muted ? "🔇" : "🔊", l.muted ? TT("unmute", "Unmute") : TT("mute", "Mute"), () => { l.muted = !l.muted; renderLayers(); }),
        b("⤓", TT("mergeT", "Merge into the sound"), () => { putAt(l.samples.map((c) => c.map((v) => v * (l.gain ?? 1))), Math.min(l.at, length()), true); layers = layers.filter((x) => x !== l); after(); }),
        b("✕", TT("removeT", "Remove the track"), () => { layers = layers.filter((x) => x !== l); after(); }),
      );
      row.append(bar, tools);
      return row;
    }));
  }
  $("wrap").addEventListener("dragover", (e) => { if ([...(e.dataTransfer?.items ?? [])].some((i) => i.kind === "file")) e.preventDefault(); });
  $("wrap").addEventListener("drop", async (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    e.preventDefault();
    const am = await import("./add-media.js");
    busy(T("loading", "Loading the sound…"));
    try { const { bytes } = await am.uploadMedia(f); await addBytes(f.name, bytes, $("addBtn")); } catch (err) { msg(err.message || String(err), true); } finally { busy(""); }
  });

  // ---------- open ----------
  let busyCount = 0;
  function busy(text) { busyCount = Math.max(0, busyCount + (text ? 1 : -1)); $("busy").hidden = busyCount <= 0; if (text) $("busyText").textContent = text; }
  let msgTimer;
  function msg(text, error) { const m = $("msg"); m.textContent = text; m.className = `status show${error ? " error" : ""}`; clearTimeout(msgTimer); msgTimer = setTimeout(() => (m.className = "status"), error ? 6000 : 3500); }
  async function open() {
    busy(T("loading", "Loading the sound…"));
    try {
      const input = await kesher.call("editor.input");
      if (!input?.bytes) { $("empty").textContent = T("emptyRec", "Open a sound from a chat, or press ● Record and hum or whistle."); return; }
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
  /**
   * Audacity's Change Speed: the selection played k times as fast (higher and shorter, like a faster tape), by
   * reading its samples at k steps (linear between two). The words after it move with the sound.
   *
   * @param k - 0.5 to 2.
   */
  function changeSpeed(k) {
    if (!need()) return;
    remember();
    const [a, b] = sel;
    const n = Math.max(1, Math.round((b - a) / k));
    chans = chans.map((c) => {
      const out = new Float32Array(c.length - (b - a) + n);
      out.set(c.subarray(0, a));
      for (let i = 0; i < n; i++) {
        const x = a + i * k, j = Math.floor(x), f = x - j;
        out[a + i] = c[Math.min(j, b - 1)] * (1 - f) + c[Math.min(j + 1, b - 1)] * f;
      }
      out.set(c.subarray(b), a + n);
      return out;
    });
    const sa = secs(a), sb = secs(b), d = secs(b - a) - secs(n);
    parts = parts.flatMap((p) => (p.end <= sa ? [p] : p.start >= sb ? [{ ...p, start: p.start - d, end: p.end - d }] : [{ ...p, start: sa + (Math.max(p.start, sa) - sa) / k, end: sa + (Math.min(p.end, sb) - sa) / k }]));
    sel = [a, a + n];
    after();
  }
  $("speed").onchange = () => { const k = Number($("speed").value); $("speed").value = "1"; if (k !== 1) changeSpeed(k); };
  Object.keys(ops).forEach((k) => ($(k).onclick = ops[k]));
  $("undo").onclick = undo; $("redo").onclick = redo; $("play").onclick = play;
  $("zoomIn").onclick = () => zoomBy(1.5); $("zoomOut").onclick = () => zoomBy(1 / 1.5);
  document.querySelectorAll(".phonebar [data-do]").forEach((b) => (b.onclick = () => (b.dataset.do === "play" ? play() : b.dataset.do === "add" ? addMenu(b) : b.dataset.do === "words" ? $("app").classList.toggle("sheet") : b.dataset.do === "inst" ? $("toInst").click() : ops[b.dataset.do]())));
  const KEYS = [["Space", "kPlay", "Play / pause (the selection, if any)"], ["Delete", "kCut", "Delete the selection"], ["Ctrl+A", "kAll", "Select all"], ["Esc", "kEsc", "Let go of the selection"], ["Ctrl+Z / Ctrl+Y", "kUndo", "Undo / redo"], ["+ / −", "kZoom", "Zoom"], ["← / →", "kMove", "The playhead a second back / on"], ["Home / End", "kHomeEnd", "The start / the end"], ["R", "rec", "Record"]];
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
    const map = { " ": play, delete: ops.cut, backspace: ops.cut, escape: () => { sel = null; draw(); }, "+": () => zoomBy(1.5), "=": () => zoomBy(1.5), "-": () => zoomBy(1 / 1.5), arrowleft: () => { head = Math.max(0, head - rate); draw(); }, arrowright: () => { head = Math.min(length(), head + rate); draw(); }, home: () => { head = 0; draw(); }, end: () => { head = length(); draw(); }, "?": showKeys, r: record };
    if (map[k]) { e.preventDefault(); map[k](); }
  });
  new ResizeObserver(() => draw()).observe(wrap);
  kesher.call("info").then((i) => {
    he = i.locale === "he";
    if (he) { document.documentElement.dir = "rtl"; document.querySelectorAll("[data-t]").forEach((el) => (el.textContent = T(el.dataset.t, el.textContent))); $("speedBox").title = T("speedHint", "Higher and faster, or lower and slower"); }
    draw();
  }).catch(() => undefined);
  open();
})();
