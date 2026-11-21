// KesherAI's image editor: layers, brushes, selections, filters, and the
// local picture model (new layer from words, repaint a selection, enlarge).
// A plugin page with no build step: it talks to KesherAI only through
// window.kesher (kesher.js). Read it as an example of an app plugin.
/* global window, document, kesher, Image, Path2D, Blob, URL, requestAnimationFrame, addEventListener, devicePixelRatio, ResizeObserver, setInterval, setTimeout, innerWidth, PointerEvent, removeEventListener */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);

  // ---------- words (English / Hebrew) ----------
  const HE = {
    editIn: "ערוך ב…", editInT: "פותח את העורך השני; \"חזרה ל…\" שם מחזירה אותך", make3d: "צור מודל תלת ממד מזה", make3dHint: "חפץ אחד, במחשב שלך", making3d: "יוצר את מודל התלת ממד… (כמה דקות, במחשב שלך)", model3dDownloading: "מודל התלת ממד בהורדה (עיגול ההורדות); נסה שוב כשיסתיים.",
    new: "חדש…", open: "פתח תמונה…", placeChat: "הוסף מהקבצים של הצ׳אט…", placeBank: "הוסף מבנק היצירות…", hPlace: "הוספת תמונה", openProject: "פתח פרויקט…", saveProject: "שמור פרויקט", export: "ייצא PNG", fit: "התאם",
    brushH: "מברשת", hardness: "קשיחות", flow: "אטימות", selectionH: "בחירה", selAll: "הכל", selNone: "בטל", selInvert: "הפוך", clear: "נקה",
    aiH: "AI (מודל התמונות שלך)", promptPh: "תאר מה לצייר…", aiLayer: "שכבה חדשה ממילים", aiInpaint: "צייר מחדש את הבחירה", strength: "כמה לשנות", aiUpscale: "הגדל פי 4", aiNoBg: "✂ הסרת רקע", aiExpand: "⤢ הרחבה ב-AI", expandAll: "‎+25% מכל הצדדים", expandSame: "התמונה כבר בצורה הזאת", hExpand: "הרחבה", expandLayer: "הקצוות שהורחבו", tapSel: "🎯 בחירה בהקשה", tapWorking: "מחפש את האובייקט… (Segment Anything במחשב)", tapNone: "לא נמצא שם כלום; הקש באמצע האובייקט", tapDone: "נבחר. Shift והקשה מוסיפים; שורת המשימות עובדת עליו.", maskH: "מסכה", maskApply: "החל", maskInvert: "הפוך", maskDelete: "מחק", hMask: "הוספת מסכה", hMaskApply: "החלת מסכה", hMaskInvert: "היפוך מסכה", hMaskDelete: "מחיקת מסכה", maskThumb: "המסכה: לבן מראה, שקוף מסתיר. הקש כדי לצייר עליה", maskHint: "מציירים עכשיו על המסכה: המכחול מראה, המחק מסתיר. הקש על התמונה הקטנה כדי לחזור לצייר על השכבה.", noBgWorking: "מסיר את הרקע… (BiRefNet במחשב)", noBgSetup: "מתקין את מסיר הרקע… (פעם אחת)", noBgLayer: "בלי רקע", hNoBg: "הסרת רקע",
    filtersH: "פילטרים (לשכבה הפעילה)", apply: "החל", layersH: "שכבות", layerOpacity: "אטימות שכבה",
    newH: "תמונה חדשה", width: "רוחב", height: "גובה", whiteBg: "רקע לבן", cancel: "ביטול", create: "צור",
    background: "רקע", layer: "שכבה", aiWorking: "המודל מצייר… (זה יכול לקחת דקה)", upscaling: "מגדיל…", needSelection: "קודם בחר אזור (מלבן, אליפסה או לאסו).", needPrompt: "כתוב מה לצייר.",
    saved: "נשמר", done: "מוכן", noLayer: "אין שכבה פעילה",
    pPhoto: "צילום", pPixel: "פיקסלים", pAi: "AI", openAffinity: "פתח ב-Affinity", size: "גודל", toAi: "צייר מחדש עם AI…", tolerance: "סבילות",
    tColor: "צבע", tAdjust: "התאמות", tAi: "AI", tLayers: "שכבות", tHistory: "היסטוריה", adjustHint: "לשכבה הפעילה, בתוך הבחירה.",
    affinityChanged: "נשמר ב-Affinity.", bringBack: "החזר כשכבה", affinityOpened: "נפתח ב-Affinity. כשתסיים: File ← Export ← PNG, ושמור באותו שם (החלף).", affinityDefault: "Affinity לא נמצא במחשב, אז הקובץ נפתח בתוכנה הרגילה לתמונות.", affinityRemote: "Affinity נפתח במחשב, לא בטלפון.",
    hCrop: "חיתוך", h_cw: "סיבוב 90° עם השעון", h_ccw: "סיבוב 90° נגד השעון", h_h: "היפוך התמונה לרוחב", h_v: "היפוך התמונה לגובה", h_lh: "היפוך השכבה לרוחב", h_lv: "היפוך השכבה לגובה", crop: "חיתוך", ratio: "יחס", cropHint: "גרור מסגרת. Enter מחיל, Esc מבטל.", apply2: "החל", free: "חופשי",
    uvGuide: "קווי UV (מדריך, לא נשמר)", paintLayer: "ציור", "back_model-editor": "חזרה למודל", fromModel: "הטקסטורה של המודל. כשתסיים: \"חזרה למודל\".",
    taskPh: "מה לעשות כאן? (ריק = מילוי שמתאים לסביבה)", pSelect: "בחירה", keysH: "קיצורים (כמו בפוטושופ)", close: "סגור",
    toChat: "שלח לצ'אט", toChatH: "שליחה לצ'אט", toChatMsg: "הודעה איתה (לא חובה)", toChatPh: "למשל: תעשה את השמיים חמים יותר", send: "שלח", sending: "שולח…", fromChat: "נפתח מהצ'אט",
    mFile: "קובץ", mEdit: "עריכה", mSelect: "בחירה", mLayer: "שכבה", mFilter: "פילטר", mAi: "AI", mView: "תצוגה",
    undo: "בטל", redo: "בצע שוב", newLayer: "שכבה חדשה", duplicate: "שכפל שכבה", mergeDown: "מזג למטה", deleteLayer: "מחק שכבה", flattenAll: "שטח תמונה", zoomIn: "הגדל תצוגה", zoomOut: "הקטן תצוגה", actual: "גודל אמיתי",
    hMove: "גרור כדי להזיז את השכבה הפעילה.", hHand: "גרור כדי להזיז את התצוגה. גלגלת: זום.", hPicker: "לחץ על התמונה כדי לקחת צבע.",
    hBrush: "מברשת", hText: "טקסט", textType: "כתוב כאן · Ctrl+Enter שומר · Esc מבטל", sizeH: "גודל התמונה…", sizeT: "גודל התמונה", sizeLock: "שמור על הפרופורציות", hShape: "צורה", s_rect: "מלבן", s_ellipse: "אליפסה", s_line: "קו", s_arrow: "חץ", shapeFill: "מלא", shapeWidth: "עובי", shapeHint: "גרירה מציירת · Shift: ריבוע, עיגול, 45°", textAsk: "המילים (\\n לשורה חדשה):", textSize: "גודל", textFont: "גופן", fSans: "רגיל", fSerif: "סריף", fMono: "מונו", fDisplay: "כותרת", textBold: "מודגש", textOutline: "קו מתאר", textHint: "לחיצה על התמונה: טקסט חדש · על טקסט: שינוי", hEraser: "מחק", hFill: "דלי", hNew: "חדש", hOpenPic: "פתיחת תמונה", hFilter: "פילטר", hAiLayer: "שכבה מ-AI", hInpaint: "ציור מחדש ב-AI", hUpscale: "הגדלה", hClear: "ניקוי", hMove2: "הזזה", hLayerProps: "מאפייני שכבה", hFromAffinity: "חזר מ-Affinity",
  };
  let he = false;
  const T = (k, en) => (he && HE[k]) || en;

  // ---------- document ----------
  const doc = { w: 1024, h: 1024, layers: [], active: 0 };
  let selection = null; // { path: Path2D, inverted: boolean } or null
  let nextId = 1;
  let docName = "picture";

  function makeLayer(name, w = doc.w, h = doc.h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return { id: nextId++, name, canvas: c, ctx: c.getContext("2d", { willReadFrequently: true }), visible: true, opacity: 1, blend: "source-over", x: 0, y: 0 };
  }
  const active = () => doc.layers[doc.active];
  // ---------- layer masks (Photoshop's): where the mask is clear, the layer is hidden; painting on it hides or shows ----------
  // The mask is a canvas of the layer's size whose alpha is how much shows (opaque white: all of it).
  let onMask = false; // the brush paints on the active layer's mask instead of its pixels
  function makeMask(l, fromSelection) {
    const m = document.createElement("canvas");
    m.width = l.canvas.width;
    m.height = l.canvas.height;
    const g = m.getContext("2d", { willReadFrequently: true });
    if (fromSelection) {
      // The selection's white becomes what shows: its brightness as the mask's alpha.
      g.drawImage(selectionMask(), -l.x, -l.y);
      const d = g.getImageData(0, 0, m.width, m.height);
      for (let i = 0; i < d.data.length; i += 4) { d.data[i + 3] = d.data[i]; d.data[i] = d.data[i + 1] = d.data[i + 2] = 255; }
      g.putImageData(d, 0, 0);
    } else { g.fillStyle = "#fff"; g.fillRect(0, 0, m.width, m.height); }
    return m;
  }
  /** What a layer shows: its pixels, cut by its mask when it has one. */
  function shown(l) {
    if (!l.mask) return l.canvas;
    const c = document.createElement("canvas");
    c.width = l.canvas.width;
    c.height = l.canvas.height;
    const g = c.getContext("2d");
    g.drawImage(l.canvas, 0, 0);
    g.globalCompositeOperation = "destination-in";
    g.drawImage(l.mask, 0, 0);
    return c;
  }
  const copyCanvas = (src) => { const c = document.createElement("canvas"); c.width = src.width; c.height = src.height; c.getContext("2d", { willReadFrequently: true }).drawImage(src, 0, 0); return c; };

  // ---------- undo ----------
  const undoStack = [];
  const redoStack = [];
  function snapshot() {
    return {
      w: doc.w, h: doc.h, active: doc.active,
      layers: doc.layers.map((l) => ({ ...l, data: l.ctx.getImageData(0, 0, l.canvas.width, l.canvas.height), mask: l.mask ? copyCanvas(l.mask) : undefined, text: l.text ? { ...l.text } : undefined })),
    };
  }
  function restore(s) {
    // A crop or a turn changed the picture's size: fit it in view again.
    const resized = doc.w !== s.w || doc.h !== s.h;
    doc.w = s.w;
    doc.h = s.h;
    doc.active = s.active;
    doc.layers = s.layers.map((l) => {
      const c = document.createElement("canvas");
      c.width = l.data.width;
      c.height = l.data.height;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.putImageData(l.data, 0, 0);
      return { id: l.id, name: l.name, canvas: c, ctx, visible: l.visible, opacity: l.opacity, blend: l.blend, x: l.x, y: l.y, ...(l.guide ? { guide: true } : {}), ...(l.mask ? { mask: copyCanvas(l.mask) } : {}), ...(l.text ? { text: { ...l.text } } : {}) };
    });
    renderLayers();
    if (resized) fit(); else draw();
  }
  // History (Photoshop's History panel): each step keeps the state before it and its name.
  function remember(label = "Edit") {
    const s = snapshot();
    s.label = label;
    undoStack.push(s);
    if (undoStack.length > 30) undoStack.shift();
    redoStack.length = 0;
    renderHistory();
  }
  function undo() {
    if (!undoStack.length) return;
    const prev = undoStack.pop();
    const now = snapshot();
    now.label = prev.label;
    redoStack.push(now);
    restore(prev);
    renderHistory();
  }
  function redo() {
    if (!redoStack.length) return;
    const next = redoStack.pop();
    const now = snapshot();
    now.label = next.label;
    undoStack.push(now);
    restore(next);
    renderHistory();
  }
  function renderHistory() {
    const ol = $("history");
    if (!ol) return;
    ol.textContent = "";
    const add = (text, cls, onclick) => {
      const li = document.createElement("li");
      li.textContent = text;
      li.className = cls;
      li.onclick = onclick;
      ol.append(li);
    };
    add(T("hNew", "New"), undoStack.length ? "" : "now", () => { while (undoStack.length) undo(); });
    undoStack.forEach((st, i) => add(st.label, i === undoStack.length - 1 ? "now" : "", () => { while (undoStack.length > i + 1) undo(); }));
    [...redoStack].reverse().forEach((st, i) => add(st.label, "future", () => { for (let k = 0; k <= i; k++) redo(); }));
  }

  // ---------- view ----------
  const stage = $("stage");
  const view = $("view");
  const vctx = view.getContext("2d");
  const cam = { scale: 1, x: 0, y: 0 };
  let checker;
  function resize() {
    const r = stage.getBoundingClientRect();
    view.width = Math.round(r.width * devicePixelRatio);
    view.height = Math.round(r.height * devicePixelRatio);
    view.style.width = `${r.width}px`;
    view.style.height = `${r.height}px`;
    draw();
  }
  function fit() {
    const r = stage.getBoundingClientRect();
    cam.scale = Math.min((r.width - 40) / doc.w, (r.height - 40) / doc.h, 4);
    cam.x = (r.width - doc.w * cam.scale) / 2;
    cam.y = (r.height - doc.h * cam.scale) / 2;
    draw();
  }
  const toDoc = (e) => {
    const r = view.getBoundingClientRect();
    return { x: (e.clientX - r.left - cam.x) / cam.scale, y: (e.clientY - r.top - cam.y) / cam.scale };
  };
  let ants = 0;
  function draw() {
    $("taskbar").hidden = !selection;
    const d = devicePixelRatio;
    vctx.setTransform(1, 0, 0, 1, 0, 0);
    vctx.fillStyle = "#111214";
    vctx.fillRect(0, 0, view.width, view.height);
    vctx.setTransform(d * cam.scale, 0, 0, d * cam.scale, d * cam.x, d * cam.y);
    if (!checker) {
      const c = document.createElement("canvas");
      c.width = c.height = 16;
      const x = c.getContext("2d");
      x.fillStyle = "#3a3a3a";
      x.fillRect(0, 0, 16, 16);
      x.fillStyle = "#2b2b2b";
      x.fillRect(0, 0, 8, 8);
      x.fillRect(8, 8, 8, 8);
      checker = vctx.createPattern(c, "repeat");
    }
    vctx.fillStyle = checker;
    vctx.fillRect(0, 0, doc.w, doc.h);
    vctx.imageSmoothingEnabled = cam.scale < 2;
    for (const l of doc.layers) {
      if (!l.visible) continue;
      vctx.globalAlpha = l.opacity;
      vctx.globalCompositeOperation = l.blend;
      vctx.drawImage(shown(l), l.x, l.y);
    }
    vctx.globalAlpha = 1;
    vctx.globalCompositeOperation = "source-over";
    if (strokePreview) vctx.drawImage(strokePreview.canvas, 0, 0);
    if (selection || draftPath) {
      vctx.lineWidth = 1 / cam.scale;
      vctx.setLineDash([5 / cam.scale, 5 / cam.scale]);
      for (const [color, offset] of [["#000", 0], ["#fff", 5]]) {
        vctx.strokeStyle = color;
        vctx.lineDashOffset = (ants + offset) / cam.scale;
        vctx.stroke(draftPath ?? selection.outline ?? selection.path);
      }
      vctx.setLineDash([]);
    }
    if (cropBox) {
      // Crop (Photoshop's C): what goes is dimmed, the kept part has a frame and thirds.
      const { x, y, w, h } = cropBox;
      vctx.fillStyle = "rgba(0,0,0,0.55)";
      vctx.fillRect(0, 0, doc.w, y);
      vctx.fillRect(0, y + h, doc.w, doc.h - y - h);
      vctx.fillRect(0, y, x, h);
      vctx.fillRect(x + w, y, doc.w - x - w, h);
      vctx.strokeStyle = "#fff";
      vctx.lineWidth = 1.5 / cam.scale;
      vctx.strokeRect(x, y, w, h);
      vctx.lineWidth = 0.75 / cam.scale;
      vctx.beginPath();
      for (const k of [1, 2]) { vctx.moveTo(x + (w * k) / 3, y); vctx.lineTo(x + (w * k) / 3, y + h); vctx.moveTo(x, y + (h * k) / 3); vctx.lineTo(x + w, y + (h * k) / 3); }
      vctx.stroke();
    }
    $("zoomInfo").textContent = `${Math.round(cam.scale * 100)}%`;
  }
  setInterval(() => {
    if (!selection) return;
    ants = (ants + 1) % 10;
    draw();
  }, 120);

  // ---------- selection helpers ----------
  function selectionMask(w = doc.w, h = doc.h) {
    // White where selected, black elsewhere (what the picture model repaints).
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const x = c.getContext("2d");
    x.fillStyle = selection?.inverted ? "#fff" : "#000";
    x.fillRect(0, 0, w, h);
    if (selection) {
      x.fillStyle = selection.inverted ? "#000" : "#fff";
      x.fill(selection.path);
    }
    return c;
  }
  function clipToSelection(ctx, layer) {
    if (!selection) return;
    ctx.translate(-layer.x, -layer.y);
    if (selection.inverted) {
      const p = new Path2D();
      p.rect(-1e5, -1e5, 2e5, 2e5);
      p.addPath(selection.path);
      ctx.clip(p, "evenodd");
    } else ctx.clip(selection.path);
    ctx.translate(layer.x, layer.y);
  }


  // ---------- tools ----------
  let tool = "brush";
  let strokePreview = null;
  let draftPath = null;
  let cropBox = null; // { x, y, w, h } while cropping
  let drag = null;
  let spaceDown = false;
  function setTool(t) {
    tool = t;
    document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === t));
    // The phone bar shows it too, whether it was chosen there or by a key.
    const phone = t === "rect" || t === "lasso" ? "select" : t === "brush" || t === "crop" || t === "text" || t === "shape" ? t : "";
    document.querySelectorAll(".phonebar [data-phone]").forEach((x) => x.classList.toggle("on", !!phone && x.dataset.phone === phone));
    // The context bar shows this tool's options (Photoshop's options bar).
    document.querySelectorAll(".ctx").forEach((c) => c.classList.toggle("show", c.dataset.for.split(" ").includes(t)));
    $("ctxTool").textContent = document.querySelector(`[data-tool="${t}"]`)?.textContent ?? "";
    $("ctxHint").textContent = t === "move" ? T("hMove", "Drag to move the active layer.") : t === "hand" ? T("hHand", "Drag to move the view. Wheel: zoom.") : t === "picker" ? T("hPicker", "Click the picture to take its color.") : "";
    stage.style.cursor = t === "hand" ? "grab" : t === "move" ? "move" : t === "text" ? "text" : "crosshair";
  }
  document.querySelectorAll("[data-tool]").forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));

  function brushDab(ctx, x, y, size, color, hardness) {
    const r = size / 2;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(Math.max(0.01, Math.min(0.99, hardness)), color);
    g.addColorStop(1, color + "00");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  function stroke(from, to) {
    const size = +$("size").value;
    const color = $("color").value;
    const hard = +$("hardness").value / 100;
    const ctx = strokePreview.ctx;
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const step = Math.max(1, size / 6);
    for (let i = 0; i <= dist; i += step) {
      const t = dist ? i / dist : 0;
      brushDab(ctx, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, size, tool === "eraser" ? "#ff5a5a" : color, hard);
    }
    draw();
  }
  function commitStroke() {
    const l = active();
    if (!l || !strokePreview) return;
    remember(tool === "eraser" ? T("hEraser", "Eraser") : T("hBrush", "Brush"));
    if (onMask && l.mask) {
      // On a mask: the brush shows (white) and the eraser hides, as black and white paint on Photoshop's mask.
      const g = l.mask.getContext("2d", { willReadFrequently: true });
      g.save();
      clipToSelection(g, l);
      g.globalAlpha = +$("flow").value / 100;
      g.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
      g.drawImage(strokePreview.canvas, -l.x, -l.y);
      g.restore();
      strokePreview = null;
      renderLayers();
      draw();
      return;
    }
    const ctx = l.ctx;
    ctx.save();
    clipToSelection(ctx, l);
    ctx.globalAlpha = +$("flow").value / 100;
    ctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
    ctx.drawImage(strokePreview.canvas, -l.x, -l.y);
    ctx.restore();
    strokePreview = null;
    renderLayers();
    draw();
  }

  function floodFill(l, px, py, hex) {
    remember(T("hFill", "Fill"));
    const { width: w, height: h } = l.canvas;
    const x0 = Math.floor(px - l.x), y0 = Math.floor(py - l.y);
    if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return;
    const img = l.ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const at = (x, y) => (y * w + x) * 4;
    const s = at(x0, y0);
    const target = [d[s], d[s + 1], d[s + 2], d[s + 3]];
    const fill = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255];
    const near = (i) => Math.abs(d[i] - target[0]) + Math.abs(d[i + 1] - target[1]) + Math.abs(d[i + 2] - target[2]) + Math.abs(d[i + 3] - target[3]) <= +$("tolerance").value * 1.5;
    const mask = selection ? selectionMask().getContext("2d").getImageData(0, 0, doc.w, doc.h).data : null;
    const inSel = (x, y) => !mask || mask[((y + l.y) * doc.w + (x + l.x)) * 4] > 127;
    const seen = new Uint8Array(w * h);
    const stack = [[x0, y0]];
    while (stack.length) {
      const [x, y] = stack.pop();
      if (x < 0 || y < 0 || x >= w || y >= h || seen[y * w + x]) continue;
      seen[y * w + x] = 1;
      const i = at(x, y);
      if (!near(i) || !inSel(x, y)) continue;
      d[i] = fill[0]; d[i + 1] = fill[1]; d[i + 2] = fill[2]; d[i + 3] = fill[3];
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    l.ctx.putImageData(img, 0, 0);
    renderLayers();
    draw();
  }

  view.addEventListener("pointerdown", (e) => {
    view.setPointerCapture(e.pointerId);
    const p = toDoc(e);
    const t = spaceDown || e.button === 1 ? "hand" : tool;
    const l = active();
    drag = { t, start: p, last: p, sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y, points: [p] };
    if (t === "brush" || t === "eraser") {
      if (!l) return msg(T("noLayer", "No active layer"));
      delete l.text; // painted on: from now on it is pixels (Photoshop's Rasterize Type)
      const c = document.createElement("canvas");
      c.width = doc.w;
      c.height = doc.h;
      strokePreview = { canvas: c, ctx: c.getContext("2d") };
      stroke(p, p);
    } else if (t === "move" && l) {
      remember(T("hMove2", "Move"));
      drag.lx = l.x;
      drag.ly = l.y;
    } else if (t === "fill" && l) { delete l.text; floodFill(l, p.x, p.y, $("color").value); }
    else if (t === "text") { drag = null; e.preventDefault(); textAt(p); }
    else if (t === "shape") {
      const c = document.createElement("canvas");
      c.width = doc.w;
      c.height = doc.h;
      strokePreview = { canvas: c, ctx: c.getContext("2d") };
    }
    else if (t === "picker") pick(p);
    else if (t === "tapsel") tapSelect(p, e.shiftKey);
  });
  view.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const p = toDoc(e);
    const l = active();
    if (drag.t === "hand") {
      cam.x = drag.cx + e.clientX - drag.sx;
      cam.y = drag.cy + e.clientY - drag.sy;
      draw();
    } else if (drag.t === "brush" || drag.t === "eraser") {
      stroke(drag.last, p);
    } else if (drag.t === "move" && l) {
      l.x = Math.round(drag.lx + p.x - drag.start.x);
      l.y = Math.round(drag.ly + p.y - drag.start.y);
      draw();
    } else if (drag.t === "rect" || drag.t === "ellipse") {
      const x = Math.min(drag.start.x, p.x), y = Math.min(drag.start.y, p.y), w = Math.abs(p.x - drag.start.x), h = Math.abs(p.y - drag.start.y);
      draftPath = new Path2D();
      if (drag.t === "rect") draftPath.rect(x, y, w, h);
      else draftPath.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      draw();
    } else if (drag.t === "lasso") {
      drag.points.push(p);
      draftPath = new Path2D();
      drag.points.forEach((q, i) => (i ? draftPath.lineTo(q.x, q.y) : draftPath.moveTo(q.x, q.y)));
      draw();
    } else if (drag.t === "crop") {
      cropBox = cropRect(drag.start, p);
      draw();
    } else if (drag.t === "shape") {
      drag.end = e.shiftKey ? constrain(drag.start, p) : p;
      const g = strokePreview.ctx;
      g.clearRect(0, 0, doc.w, doc.h);
      drawShape(g, drag.start, drag.end);
      draw();
    } else if (drag.t === "picker") pick(p);
    drag.last = p;
  });
  view.addEventListener("pointerup", () => {
    if (!drag) return;
    if (drag.t === "brush" || drag.t === "eraser") commitStroke();
    if (drag.t === "shape") commitShape();
    if ((drag.t === "rect" || drag.t === "ellipse" || drag.t === "lasso") && draftPath) {
      if (drag.t === "lasso") draftPath.closePath();
      selection = Math.hypot(drag.last.x - drag.start.x, drag.last.y - drag.start.y) > 2 || drag.t === "lasso" ? { path: draftPath, inverted: false } : null;
      draftPath = null;
      draw();
    }
    if (drag.t === "move") renderLayers();
    drag = null;
  });
  // ---------- crop ----------
  /** The box from where the drag started to here, inside the picture, in the chosen ratio. */
  function cropRect(a, b) {
    const r = $("cropRatio").value;
    let w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    if (r !== "free") {
      const [rw, rh] = r.split(":").map(Number);
      if (w / h > rw / rh) w = (h * rw) / rh; else h = (w * rh) / rw;
    }
    const x = Math.max(0, Math.min(b.x < a.x ? a.x - w : a.x, doc.w)), y = Math.max(0, Math.min(b.y < a.y ? a.y - h : a.y, doc.h));
    return { x: Math.round(x), y: Math.round(y), w: Math.round(Math.min(w, doc.w - x)), h: Math.round(Math.min(h, doc.h - y)) };
  }
  function applyCrop() {
    if (!cropBox || cropBox.w < 2 || cropBox.h < 2) return;
    remember(T("hCrop", "Crop"));
    const { x, y, w, h } = cropBox;
    for (const l of doc.layers) {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(l.canvas, l.x - x, l.y - y);
      if (l.mask) { const m = document.createElement("canvas"); m.width = w; m.height = h; m.getContext("2d", { willReadFrequently: true }).drawImage(l.mask, l.x - x, l.y - y); l.mask = m; }
      Object.assign(l, { canvas: c, ctx, x: 0, y: 0 });
      delete l.text;
    }
    doc.w = w;
    doc.h = h;
    cropBox = null;
    selection = null;
    renderLayers();
    fit();
  }
  // ---------- shapes (Photoshop's Shape tool, U): a rectangle, an ellipse, a line or an arrow, each on a new layer ----------
  /** With Shift: a square or circle, or a line at a multiple of 45°. */
  function constrain(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    if ($("shapeKind").value === "line" || $("shapeKind").value === "arrow") {
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
      return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
    }
    const d = Math.max(Math.abs(dx), Math.abs(dy));
    return { x: a.x + Math.sign(dx || 1) * d, y: a.y + Math.sign(dy || 1) * d };
  }
  /** Draws the chosen shape from a to b in the chosen colour (filled, or as an outline of the chosen width). */
  function drawShape(g, a, b) {
    const kind = $("shapeKind").value, fill = $("shapeFill").checked, w = Math.max(1, +$("shapeWidth").value || 8);
    g.save();
    g.fillStyle = g.strokeStyle = $("color").value;
    g.lineWidth = w;
    g.lineCap = g.lineJoin = "round";
    g.beginPath();
    if (kind === "rect") g.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    else if (kind === "ellipse") g.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
    else {
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
      if (kind === "arrow") {
        // The head: two short strokes back from the tip, as long as four times the width (at least 14 px).
        const ang = Math.atan2(b.y - a.y, b.x - a.x), head = Math.max(14, w * 4);
        g.beginPath();
        g.moveTo(b.x - head * Math.cos(ang - 0.45), b.y - head * Math.sin(ang - 0.45));
        g.lineTo(b.x, b.y);
        g.lineTo(b.x - head * Math.cos(ang + 0.45), b.y - head * Math.sin(ang + 0.45));
        if (fill) { g.closePath(); g.fill(); } else g.stroke();
      }
      g.restore();
      return;
    }
    if (fill) g.fill(); else g.stroke();
    g.restore();
  }
  /** Lets go of a shape: it goes on a new layer above the active one (a click without a drag draws nothing). */
  function commitShape() {
    const end = drag.end;
    strokePreview = null;
    if (!end || Math.hypot(end.x - drag.start.x, end.y - drag.start.y) < 2) return draw();
    remember(T("hShape", "Shape"));
    const kind = $("shapeKind").value;
    const l = makeLayer(T(`s_${kind}`, kind));
    drawShape(l.ctx, drag.start, end);
    addLayer(l);
  }

  // ---------- text (Photoshop's Type tool, T) ----------
  // A text layer keeps its words and look (l.text), so it can be changed later: click it with the Text tool, or change
  // the bar's size, font, bold or outline while it is the active layer. Painting, a filter, a turn or a crop make it
  // pixels (as Photoshop's Rasterize Type).
  const FONTS = { sans: "Heebo, Arial, sans-serif", serif: "'Frank Ruhl Libre', Georgia, serif", mono: "'JetBrains Mono', monospace", display: "Impact, 'Arial Black', sans-serif" };
  /** Draws a text layer's words on its canvas (lines split at "\n"; right to left when it has Hebrew). */
  function drawText(l) {
    const t = l.text;
    const g = l.ctx;
    g.clearRect(0, 0, l.canvas.width, l.canvas.height);
    g.font = `${t.bold ? 700 : 400} ${t.size}px ${FONTS[t.font] ?? FONTS.sans}`;
    g.textBaseline = "top";
    const rtl = /[\u0590-\u05FF\u0600-\u06FF]/.test(t.value);
    g.direction = rtl ? "rtl" : "ltr";
    g.textAlign = rtl ? "right" : "left";
    t.value.split("\n").forEach((line, i) => {
      const y = t.y + i * t.size * 1.2;
      if (t.outline) { g.lineJoin = "round"; g.lineWidth = Math.max(2, t.size / 10); g.strokeStyle = t.color === "#000000" ? "#ffffff" : "#000000"; g.strokeText(line, t.x, y); }
      g.fillStyle = t.color;
      g.fillText(line, t.x, y);
    });
  }
  /** The text bar's look, as a text layer keeps it. */
  const textLook = () => ({ size: +$("textSize").value, font: $("textFont").value, bold: $("textBold").checked, outline: $("textOutline").checked, color: $("color").value });
  /** The Text tool's click: on the active text layer's words it changes them, elsewhere it starts a new text layer. */
  /**
   * The Text tool's click: on the active text layer's words it edits them, elsewhere it starts a new text layer. A box
   * opens by the words (Canva's and Photoshop's typing on the picture): what is typed shows on the picture at once;
   * Enter is a new line, Ctrl+Enter or a click elsewhere keeps it, Esc puts it back as it was. One Undo step.
   */
  function textAt(p) {
    const l = active();
    const t = l?.text;
    const onIt = t && (() => { const lx = p.x - l.x, ly = p.y - l.y, lines = t.value.split("\n"), w = Math.max(...lines.map((x) => x.length)) * t.size * 0.6; const left = /[֐-׿]/.test(t.value) ? t.x - w : t.x; return lx >= left && lx <= left + w && ly >= t.y && ly <= t.y + lines.length * t.size * 1.2; })();
    remember(T("hText", "Text"));
    let layer = l;
    const before = onIt ? t.value : "";
    const beforeName = layer?.name;
    if (!onIt) {
      layer = makeLayer("T");
      layer.text = { value: "", x: Math.round(p.x), y: Math.round(p.y), ...textLook() };
      addLayer(layer);
    }
    const box = document.createElement("textarea");
    box.className = "text-edit";
    box.dir = "auto";
    box.rows = 2;
    box.value = before;
    box.placeholder = T("textType", "Type here · Ctrl+Enter keeps · Esc cancels");
    // Under the words (so they show while typing), kept inside the view.
    const lines = Math.max(1, before.split("\n").length);
    const sx = cam.x + (layer.x + layer.text.x) * cam.scale, sy = cam.y + (layer.y + layer.text.y + layer.text.size * 1.2 * lines) * cam.scale + 8;
    box.style.left = `${Math.max(8, Math.min(sx - 130, stage.clientWidth - 268))}px`;
    box.style.top = `${Math.max(8, Math.min(sy, stage.clientHeight - 90))}px`;
    stage.append(box);
    const show = () => {
      layer.text.value = box.value;
      layer.name = `T ${box.value.split("\n")[0].slice(0, 24)}`;
      drawText(layer);
      draw();
    };
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      box.remove();
      if (!keep) {
        // Back as it was, and the Undo step taken for it dropped.
        undoStack.pop();
        if (onIt) { layer.text.value = before; layer.name = beforeName; drawText(layer); }
        else doc.layers.splice(doc.layers.indexOf(layer), 1);
      } else if (!layer.text.value.trim()) doc.layers.splice(doc.layers.indexOf(layer), 1);
      const at = doc.layers.indexOf(layer);
      doc.active = Math.max(0, Math.min(at >= 0 ? at : doc.active - 1, doc.layers.length - 1));
      renderLayers();
      draw();
    };
    box.addEventListener("input", show);
    box.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(true); }
    });
    box.addEventListener("blur", () => finish(true));
    box.focus();
  }
  // Changing the bar while a text layer is active changes that text (one Undo step per change).
  for (const id of ["textSize", "textFont", "textBold", "textOutline"]) {
    $(id).addEventListener("change", () => {
      const l = active();
      if (!l?.text) return;
      remember(T("hText", "Text"));
      Object.assign(l.text, textLook());
      drawText(l);
      draw();
    });
  }
  $("color").addEventListener("change", () => { const l = active(); if (tool === "text" && l?.text) { remember(T("hText", "Text")); l.text.color = $("color").value; drawText(l); draw(); } });

  // ---------- picture size (Photoshop's Image Size): every layer and mask scaled, high-quality smoothing ----------
  function openSize() {
    $("sizeW").value = String(doc.w);
    $("sizeH").value = String(doc.h);
    $("sizeDialog").showModal();
  }
  const ratio = () => doc.w / doc.h;
  $("sizeW").addEventListener("input", () => { if ($("sizeLock").checked) $("sizeH").value = String(Math.max(1, Math.round(+$("sizeW").value / ratio()))); });
  $("sizeH").addEventListener("input", () => { if ($("sizeLock").checked) $("sizeW").value = String(Math.max(1, Math.round(+$("sizeH").value * ratio()))); });
  document.querySelectorAll("#sizeDialog [data-pct]").forEach((b) => (b.onclick = () => { const k = +b.dataset.pct / 100; $("sizeW").value = String(Math.round(doc.w * k)); $("sizeH").value = String(Math.round(doc.h * k)); }));
  $("sizeDialog").addEventListener("close", () => {
    if ($("sizeDialog").returnValue !== "ok") return;
    const w = Math.max(16, Math.min(8192, Math.round(+$("sizeW").value))), h = Math.max(16, Math.min(8192, Math.round(+$("sizeH").value)));
    if (!w || !h || (w === doc.w && h === doc.h)) return;
    remember(T("sizeT", "Picture size"));
    const kx = w / doc.w, ky = h / doc.h;
    const scaled = (src) => {
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(src.width * kx));
      c.height = Math.max(1, Math.round(src.height * ky));
      const g = c.getContext("2d", { willReadFrequently: true });
      g.imageSmoothingQuality = "high";
      g.drawImage(src, 0, 0, c.width, c.height);
      return { c, g };
    };
    for (const l of doc.layers) {
      const { c, g } = scaled(l.canvas);
      if (l.mask) l.mask = scaled(l.mask).c;
      Object.assign(l, { canvas: c, ctx: g, x: Math.round(l.x * kx), y: Math.round(l.y * ky) });
      // A text layer keeps its words, at the new size.
      if (l.text) { Object.assign(l.text, { x: Math.round(l.text.x * kx), y: Math.round(l.text.y * ky), size: Math.max(4, Math.round(l.text.size * Math.min(kx, ky))) }); drawText(l); }
    }
    doc.w = w;
    doc.h = h;
    selection = null;
    renderLayers();
    fit();
  });

  // ---------- rotate and flip (Photoshop's Image → Image Rotation, and Edit → Transform → Flip for one layer) ----------
  /**
   * Turns or mirrors the whole picture: every layer (and its mask) is drawn at its place on the picture, then through
   * the turn, so layers stay where they were relative to each other.
   *
   * @param how - "cw" or "ccw" (a quarter turn), "h" or "v" (a mirror).
   */
  function turnImage(how) {
    remember(T(`h_${how}`, "Rotate"));
    const quarter = how === "cw" || how === "ccw";
    const w = quarter ? doc.h : doc.w, h = quarter ? doc.w : doc.h;
    const through = (src, x, y) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d", { willReadFrequently: true });
      if (how === "cw") g.setTransform(0, 1, -1, 0, w, 0);
      else if (how === "ccw") g.setTransform(0, -1, 1, 0, 0, h);
      else if (how === "h") g.setTransform(-1, 0, 0, 1, w, 0);
      else g.setTransform(1, 0, 0, -1, 0, h);
      g.drawImage(src, x, y);
      g.setTransform(1, 0, 0, 1, 0, 0);
      return { c, g };
    };
    for (const l of doc.layers) {
      const { c, g } = through(l.canvas, l.x, l.y);
      if (l.mask) l.mask = through(l.mask, l.x, l.y).c;
      Object.assign(l, { canvas: c, ctx: g, x: 0, y: 0 });
      delete l.text;
    }
    doc.w = w;
    doc.h = h;
    selection = null;
    renderLayers();
    fit();
  }
  /** Mirrors only the active layer, in its own box (it stays where it is). */
  function flipLayer(dir) {
    const l = active();
    if (!l) return;
    remember(T(`h_l${dir}`, "Flip layer"));
    const mirror = (src) => {
      const c = document.createElement("canvas");
      c.width = src.width;
      c.height = src.height;
      const g = c.getContext("2d", { willReadFrequently: true });
      if (dir === "h") g.setTransform(-1, 0, 0, 1, c.width, 0); else g.setTransform(1, 0, 0, -1, 0, c.height);
      g.drawImage(src, 0, 0);
      g.setTransform(1, 0, 0, 1, 0, 0);
      return { c, g };
    };
    const { c, g } = mirror(l.canvas);
    if (l.mask) l.mask = mirror(l.mask).c;
    Object.assign(l, { canvas: c, ctx: g });
    delete l.text;
    renderLayers();
    draw();
  }
  const cancelCrop = () => { cropBox = null; draw(); };
  $("cropApply").onclick = applyCrop;
  $("cropCancel").onclick = cancelCrop;
  addEventListener("keydown", (e) => {
    if (!cropBox || e.target.closest?.("input, textarea")) return;
    if (e.key === "Enter") { e.preventDefault(); applyCrop(); }
    if (e.key === "Escape") cancelCrop();
  });

  view.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = view.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const k = Math.exp(-e.deltaY * 0.0015);
    const s = Math.min(32, Math.max(0.05, cam.scale * k));
    cam.x = mx - ((mx - cam.x) * s) / cam.scale;
    cam.y = my - ((my - cam.y) * s) / cam.scale;
    cam.scale = s;
    draw();
  }, { passive: false });

  function pick(p) {
    const flat = flatten();
    const d = flat.getContext("2d").getImageData(Math.max(0, Math.min(doc.w - 1, Math.floor(p.x))), Math.max(0, Math.min(doc.h - 1, Math.floor(p.y))), 1, 1).data;
    $("color").value = `#${[d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }

  // ---------- layers ----------
  function renderLayers() {
    const box = $("layers");
    box.textContent = "";
    [...doc.layers].reverse().forEach((l) => {
      const i = doc.layers.indexOf(l);
      const row = document.createElement("div");
      row.className = `layer${i === doc.active ? " active" : ""}`;
      const thumb = document.createElement("canvas");
      thumb.width = 80;
      thumb.height = 60;
      thumb.getContext("2d").drawImage(l.canvas, 0, 0, 80, 60);
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = l.name;
      name.title = l.name;
      name.ondblclick = () => {
        const n = window.prompt(T("layer", "Layer"), l.name);
        if (n) { l.name = n; renderLayers(); }
      };
      const eye = document.createElement("button");
      eye.textContent = l.visible ? "👁" : "–";
      eye.onclick = (e) => { e.stopPropagation(); l.visible = !l.visible; renderLayers(); draw(); };
      const up = document.createElement("button");
      up.textContent = "▲";
      up.onclick = (e) => { e.stopPropagation(); move(i, 1); };
      const down = document.createElement("button");
      down.textContent = "▼";
      down.onclick = (e) => { e.stopPropagation(); move(i, -1); };
      const del = document.createElement("button");
      del.textContent = "✕";
      del.onclick = (e) => { e.stopPropagation(); if (doc.layers.length > 1) { remember(T("deleteLayer", "Delete layer")); doc.layers.splice(i, 1); doc.active = Math.min(doc.active, doc.layers.length - 1); renderLayers(); draw(); } };
      const parts = [thumb];
      if (l.mask) {
        // The mask's own thumbnail: tap it to paint on the mask, tap the picture to paint on the pixels.
        const mt = document.createElement("canvas");
        mt.width = 80;
        mt.height = 60;
        const g = mt.getContext("2d");
        g.fillStyle = "#000";
        g.fillRect(0, 0, 80, 60);
        g.drawImage(l.mask, 0, 0, 80, 60);
        mt.className = `mask${i === doc.active && onMask ? " target" : ""}`;
        mt.title = T("maskThumb", "The mask: white shows, clear hides. Tap to paint on it");
        mt.onclick = (e) => { e.stopPropagation(); doc.active = i; onMask = true; renderLayers(); };
        thumb.onclick = (e) => { e.stopPropagation(); doc.active = i; onMask = false; renderLayers(); };
        if (i === doc.active && !onMask) thumb.classList.add("target");
        parts.push(mt);
      }
      row.append(...parts, name, eye, up, down, del);
      row.onclick = () => { if (doc.active !== i) onMask = false; doc.active = i; renderLayers(); };
      box.append(row);
    });
    const l = active();
    if (l) {
      $("blend").value = l.blend;
      $("layerOpacity").value = String(Math.round(l.opacity * 100));
    }
    $("maskTools").hidden = !l?.mask;
    $("docInfo").textContent = `${doc.w} × ${doc.h}`;
  }
  function move(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= doc.layers.length) return;
    remember(T("hLayerProps", "Layer order"));
    [doc.layers[i], doc.layers[j]] = [doc.layers[j], doc.layers[i]];
    doc.active = j;
    renderLayers();
    draw();
  }
  function addLayer(l, at = doc.active + 1) {
    doc.layers.splice(at, 0, l);
    doc.active = at;
    renderLayers();
    draw();
  }
  $("addLayer").onclick = () => { remember(T("newLayer", "New layer")); addLayer(makeLayer(`${T("layer", "Layer")} ${doc.layers.length + 1}`)); };
  // Add a mask: from the selection when there is one (only it shows), else showing all; a second press removes it.
  $("maskLayer").onclick = () => {
    const l = active();
    if (!l) return;
    if (l.mask) { onMask = true; renderLayers(); return; }
    remember(T("hMask", "Add mask"));
    l.mask = makeMask(l, !!selection);
    onMask = true;
    renderLayers();
    draw();
    msg(T("maskHint", "Painting on the mask now: the brush shows, the eraser hides. Tap the picture thumbnail to paint on it again."));
  };
  /** The active layer's mask tools: apply it into the pixels, invert it, or delete it. */
  function maskDo(what) {
    const l = active();
    if (!l?.mask) return;
    if (what === "apply") {
      remember(T("hMaskApply", "Apply mask"));
      const c = shown(l);
      l.ctx.clearRect(0, 0, l.canvas.width, l.canvas.height);
      l.ctx.drawImage(c, 0, 0);
      delete l.mask;
    } else if (what === "invert") {
      remember(T("hMaskInvert", "Invert mask"));
      const g = l.mask.getContext("2d", { willReadFrequently: true });
      const d = g.getImageData(0, 0, l.mask.width, l.mask.height);
      for (let i = 3; i < d.data.length; i += 4) { d.data[i] = 255 - d.data[i]; d.data[i - 1] = d.data[i - 2] = d.data[i - 3] = 255; }
      g.putImageData(d, 0, 0);
    } else {
      remember(T("hMaskDelete", "Delete mask"));
      delete l.mask;
    }
    if (!l.mask) onMask = false;
    renderLayers();
    draw();
  }
  $("maskApply").onclick = () => maskDo("apply");
  $("maskInvert").onclick = () => maskDo("invert");
  $("maskDelete").onclick = () => maskDo("delete");

  $("dupLayer").onclick = () => {
    const l = active();
    if (!l) return;
    remember(T("duplicate", "Duplicate layer"));
    const c = makeLayer(`${l.name} copy`, l.canvas.width, l.canvas.height);
    c.ctx.drawImage(l.canvas, 0, 0);
    Object.assign(c, { opacity: l.opacity, blend: l.blend, x: l.x, y: l.y, ...(l.mask ? { mask: copyCanvas(l.mask) } : {}) });
    addLayer(c);
  };
  $("mergeDown").onclick = () => {
    const i = doc.active;
    if (i < 1) return;
    remember(T("mergeDown", "Merge down"));
    const top = doc.layers[i], below = doc.layers[i - 1];
    below.ctx.save();
    below.ctx.globalAlpha = top.opacity;
    below.ctx.globalCompositeOperation = top.blend;
    below.ctx.drawImage(shown(top), top.x - below.x, top.y - below.y);
    below.ctx.restore();
    doc.layers.splice(i, 1);
    doc.active = i - 1;
    renderLayers();
    draw();
  };
  $("blend").onchange = () => { const l = active(); if (l) { remember(T("hLayerProps", "Layer properties")); l.blend = $("blend").value; draw(); } };
  $("layerOpacity").oninput = () => { const l = active(); if (l) { l.opacity = +$("layerOpacity").value / 100; draw(); } };
  $("layerOpacity").onpointerdown = () => remember(T("hLayerProps", "Layer properties"));

  // ---------- selection buttons ----------
  $("selAll").onclick = () => { const p = new Path2D(); p.rect(0, 0, doc.w, doc.h); selection = { path: p, inverted: false }; draw(); };
  $("selNone").onclick = () => { selection = null; draw(); };
  $("selInvert").onclick = () => { if (selection) { selection.inverted = !selection.inverted; draw(); } };
  $("selClear").onclick = clearSelection;
  $("selToAi").onclick = () => { setPersona("ai"); $("prompt").focus(); };
  $("delLayer").onclick = () => {
    if (doc.layers.length < 2) return;
    remember(T("deleteLayer", "Delete layer"));
    doc.layers.splice(doc.active, 1);
    doc.active = Math.min(doc.active, doc.layers.length - 1);
    renderLayers();
    draw();
  };
  function clearSelection() {
    const l = active();
    if (!l) return;
    remember(T("hClear", "Clear"));
    l.ctx.save();
    if (selection) {
      clipToSelection(l.ctx, l);
      l.ctx.clearRect(-1e5, -1e5, 2e5, 2e5);
    } else l.ctx.clearRect(0, 0, l.canvas.width, l.canvas.height);
    l.ctx.restore();
    renderLayers();
    draw();
  }

  // ---------- filters ----------
  function sharpen(ctx, w, h, amount) {
    const src = ctx.getImageData(0, 0, w, h);
    const out = ctx.createImageData(w, h);
    const s = src.data, o = out.data, k = amount;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v = (dx, dy) => s[((Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))) * 4) + c];
        o[i + c] = v(0, 0) * (1 + 4 * k) - k * (v(1, 0) + v(-1, 0) + v(0, 1) + v(0, -1));
      }
      o[i + 3] = s[i + 3];
    }
    ctx.putImageData(out, 0, 0);
  }
  $("applyFilter").onclick = () => {
    const l = active();
    if (!l) return;
    remember(`${T("hFilter", "Filter")}: ${$("filter").selectedOptions[0].textContent}`);
    delete l.text;
    const f = $("filter").value;
    const a = +$("amount").value;
    const tmp = document.createElement("canvas");
    tmp.width = l.canvas.width;
    tmp.height = l.canvas.height;
    const t = tmp.getContext("2d", { willReadFrequently: true });
    if (f === "sharpen") {
      t.drawImage(l.canvas, 0, 0);
      sharpen(t, tmp.width, tmp.height, a / 200);
    } else {
      const css = { brightness: `brightness(${a}%)`, contrast: `contrast(${a}%)`, saturate: `saturate(${a}%)`, "hue-rotate": `hue-rotate(${Math.round(a * 1.8)}deg)`, blur: `blur(${(a / 20).toFixed(1)}px)`, grayscale: `grayscale(${Math.min(100, a)}%)`, sepia: `sepia(${Math.min(100, a)}%)`, invert: `invert(${Math.min(100, a)}%)` }[f];
      t.filter = css;
      t.drawImage(l.canvas, 0, 0);
    }
    l.ctx.save();
    clipToSelection(l.ctx, l);
    l.ctx.clearRect(-1e5, -1e5, 2e5, 2e5);
    l.ctx.drawImage(tmp, 0, 0);
    l.ctx.restore();
    renderLayers();
    draw();
  };

  // ---------- files ----------
  function flatten() {
    const c = document.createElement("canvas");
    c.width = doc.w;
    c.height = doc.h;
    const x = c.getContext("2d", { willReadFrequently: true });
    for (const l of doc.layers) {
      // A guide (a model's UV layout) is shown while painting and never goes into the picture.
      if (!l.visible || l.guide) continue;
      x.globalAlpha = l.opacity;
      x.globalCompositeOperation = l.blend;
      x.drawImage(shown(l), l.x, l.y);
    }
    return c;
  }
  function download(name, blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const loadImage = (src) => new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error("The picture could not be read.")); img.src = src; });
  function newDoc(w, h, white) {
    doc.w = w;
    doc.h = h;
    doc.layers = [];
    const bg = makeLayer(T("background", "Background"));
    if (white) { bg.ctx.fillStyle = "#fff"; bg.ctx.fillRect(0, 0, w, h); }
    doc.layers.push(bg);
    doc.active = 0;
    selection = null;
    undoStack.length = redoStack.length = 0;
    renderLayers();
    fit();
  }
  $("newDialog").addEventListener("close", () => {
    if ($("newDialog").returnValue === "ok") newDoc(Math.max(16, Math.min(8192, +$("newW").value)), Math.max(16, Math.min(8192, +$("newH").value)), $("newWhite").checked);
  });
  $("file").onchange = async () => {
    const f = $("file").files[0];
    if (!f) return;
    const img = await loadImage(URL.createObjectURL(f));
    if (!doc.layers.some((l) => !isEmpty(l))) {
      docName = f.name.replace(/\.[^.]+$/, "");
      $("docTab").textContent = f.name;
      newDoc(img.naturalWidth, img.naturalHeight, false);
      doc.layers[0].name = f.name;
      doc.layers[0].ctx.drawImage(img, 0, 0);
    } else {
      remember(T("hOpenPic", "Open picture"));
      const l = makeLayer(f.name);
      l.ctx.drawImage(img, 0, 0);
      addLayer(l);
    }
    renderLayers();
    draw();
    $("file").value = "";
  };
  /**
   * A picture from this chat or from the bank as a new layer (Photoshop's "Place"), centred and fitted inside the
   * picture; into an empty document it becomes the document, as Open does.
   */
  async function placeFrom(from) {
    try {
      const am = await import("./add-media.js");
      am.setHebrew(he);
      const it = await am.pickMedia(from, ["image"]);
      if (!it) return;
      const bytes = await kesher.call("media.bytes", { id: it.id });
      const img = await loadImage(URL.createObjectURL(new Blob([bytes])));
      if (!doc.layers.some((l) => !isEmpty(l))) {
        docName = it.name.replace(/\.[^.]+$/, "");
        $("docTab").textContent = it.name;
        newDoc(img.naturalWidth, img.naturalHeight, false);
        doc.layers[0].name = it.name;
        doc.layers[0].ctx.drawImage(img, 0, 0);
      } else {
        remember(T("hPlace", "Place picture"));
        const l = makeLayer(it.name);
        const k = Math.min(1, doc.w / img.naturalWidth, doc.h / img.naturalHeight);
        const w = img.naturalWidth * k, h = img.naturalHeight * k;
        l.ctx.drawImage(img, (doc.w - w) / 2, (doc.h - h) / 2, w, h);
        addLayer(l);
      }
      renderLayers();
      draw();
    } catch (e) { msg(e.message || String(e), true); }
  }
  function isEmpty(l) {
    const d = l.ctx.getImageData(0, 0, l.canvas.width, l.canvas.height).data;
    for (let i = 3; i < d.length; i += 64) if (d[i] && !(d[i - 3] === 255 && d[i - 2] === 255 && d[i - 1] === 255)) return false;
    return true;
  }
  const exportPng = () => flatten().toBlob((b) => download(`${docName}.png`, b), "image/png");
  const saveProject = () => {
    const project = { kesherImage: 1, w: doc.w, h: doc.h, active: doc.active, layers: doc.layers.map((l) => ({ name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend, x: l.x, y: l.y, ...(l.text ? { text: l.text } : {}), png: l.canvas.toDataURL("image/png") })) };
    download(`${docName}.kesherimg`, new Blob([JSON.stringify(project)], { type: "application/json" }));
    msg(T("saved", "Saved"));
  };
  $("projectFile").onchange = async () => {
    const f = $("projectFile").files[0];
    if (!f) return;
    try {
      const p = JSON.parse(await f.text());
      if (p.kesherImage !== 1) throw new Error("Not an image editor project.");
      doc.w = p.w;
      doc.h = p.h;
      doc.layers = [];
      for (const s of p.layers) {
        const img = await loadImage(s.png);
        const l = makeLayer(s.name, img.naturalWidth, img.naturalHeight);
        l.ctx.drawImage(img, 0, 0);
        Object.assign(l, { visible: s.visible, opacity: s.opacity, blend: s.blend, x: s.x, y: s.y });
        if (s.text && typeof s.text.value === "string") l.text = { ...s.text };
        doc.layers.push(l);
      }
      doc.active = Math.min(p.active, doc.layers.length - 1);
      undoStack.length = redoStack.length = 0;
      selection = null;
      renderLayers();
      fit();
    } catch (e) {
      msg(e.message, true);
    }
    $("projectFile").value = "";
  };

  // ---------- AI: the local picture model ----------
  const snap = (v) => Math.max(256, Math.min(1536, Math.round(v / 64) * 64));
  function busy(text) {
    $("busy").classList.toggle("show", !!text);
    $("busyText").textContent = text || "";
  }
  async function ai(work) {
    busy(T("aiWorking", "The model is painting… (this can take a minute)"));
    try {
      await work();
      msg(T("done", "Done"));
    } catch (e) {
      msg(e.message, true);
    } finally {
      busy("");
    }
  }
  /** A picture at another size, as a data: URL. */
  function scaled(src, w, h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const x = c.getContext("2d");
    x.drawImage(src, 0, 0, w, h);
    return c.toDataURL("image/png");
  }
  $("aiLayer").onclick = () => {
    const prompt = $("prompt").value.trim();
    if (!prompt) return msg(T("needPrompt", "Write what to paint."), true);
    ai(async () => {
      const [url] = await kesher.call("image.generate", { prompt, width: snap(doc.w), height: snap(doc.h) });
      const img = await loadImage(url);
      remember(T("hAiLayer", "AI layer"));
      const l = makeLayer(prompt.slice(0, 40));
      l.ctx.drawImage(img, 0, 0, doc.w, doc.h);
      addLayer(l);
    });
  };
  $("aiInpaint").onclick = () => {
    const prompt = $("prompt").value.trim();
    if (!selection) return msg(T("needSelection", "Select an area first (rectangle, ellipse or lasso)."), true);
    if (!prompt) return msg(T("needPrompt", "Write what to paint."), true);
    ai(async () => {
      // The model sees the whole picture and repaints only the white part of the mask.
      const w = snap(doc.w), h = snap(doc.h);
      const [url] = await kesher.call("image.edit", { prompt, image: scaled(flatten(), w, h), mask: scaled(selectionMask(), w, h), strength: +$("strength").value / 100 });
      const img = await loadImage(url);
      remember(T("hInpaint", "AI repaint"));
      const l = makeLayer(prompt.slice(0, 40));
      l.ctx.save();
      clipToSelection(l.ctx, l);
      l.ctx.drawImage(img, 0, 0, doc.w, doc.h);
      l.ctx.restore();
      addLayer(l, doc.layers.length);
    });
  };
  // Generative Expand (Photoshop's, and Firefly's / Canva's Magic Expand): the canvas grows to the shape asked for, the
  // picture stays in the middle, and the picture model paints only the new edges (a mask of them), blended back below.
  $("aiExpand").onclick = () => {
    const to = $("expandTo").value;
    let W = doc.w, H = doc.h;
    if (to === "all") { W = Math.round(doc.w * 1.25); H = Math.round(doc.h * 1.25); }
    else {
      const [a, b] = to.split(":").map(Number);
      if (doc.w / doc.h < a / b) W = Math.round((doc.h * a) / b); else H = Math.round((doc.w * b) / a);
    }
    if (W === doc.w && H === doc.h) return msg(T("expandSame", "The picture is that shape already"), true);
    ai(async () => {
      const dx = Math.round((W - doc.w) / 2), dy = Math.round((H - doc.h) / 2);
      // The picture as it is, in the middle of the new size, and the mask: white where there is nothing yet.
      const big = document.createElement("canvas");
      big.width = W; big.height = H;
      big.getContext("2d").drawImage(flatten(), dx, dy);
      const mask = document.createElement("canvas");
      mask.width = W; mask.height = H;
      const mg = mask.getContext("2d");
      mg.fillStyle = "#fff"; mg.fillRect(0, 0, W, H);
      // A few pixels of overlap into the picture, so the seam is painted over too.
      const o = Math.max(4, Math.round(Math.min(doc.w, doc.h) * 0.02));
      mg.fillStyle = "#000"; mg.fillRect(dx + o, dy + o, doc.w - 2 * o, doc.h - 2 * o);
      const k = Math.min(1, 1536 / Math.max(W, H));
      const w = snap(W * k), h = snap(H * k);
      const [url] = await kesher.call("image.edit", { prompt: $("prompt").value.trim() || "continue the picture naturally beyond its edges, same style, light and perspective", image: scaled(big, w, h), mask: scaled(mask, w, h), strength: 1 });
      const img = await loadImage(url);
      remember(T("hExpand", "Expand"));
      for (const l of doc.layers) { l.x += dx; l.y += dy; }
      doc.w = W; doc.h = H;
      // The painted edges as a layer under everything, so the picture's own layers stay as they were.
      const l = makeLayer(T("expandLayer", "Expanded edges"));
      l.ctx.drawImage(img, 0, 0, W, H);
      doc.layers.unshift(l);
      doc.active = Math.min(doc.layers.length - 1, doc.active + 1);
      renderLayers();
      fit();
    });
  };
  $("aiUpscale").onclick = () =>
    ai(async () => {
      busy(T("upscaling", "Enlarging…"));
      const url = await kesher.call("image.upscale", { image: flatten().toDataURL("image/png") });
      const img = await loadImage(url);
      remember(T("hUpscale", "Enlarge"));
      newDoc(img.naturalWidth, img.naturalHeight, false);
      doc.layers[0].name = "×4";
      doc.layers[0].ctx.drawImage(img, 0, 0);
      renderLayers();
      fit();
    });

  /**
   * A mask picture as a selection: the white parts, traced row by row into rectangles (at most 512 across, so the
   * path stays small), joined with what was selected when `add`.
   */
  function maskToSelection(img, add) {
    const k = Math.min(1, 512 / Math.max(doc.w, doc.h));
    const w = Math.max(1, Math.round(doc.w * k)), h = Math.max(1, Math.round(doc.h * k));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    // White, and opaque (a cut-out's clear parts are not selected).
    const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] > 127 && d[(y * w + x) * 4] > 127;
    const keep = add && selection && !selection.inverted;
    const path = keep ? new Path2D(selection.path) : new Path2D();
    // The marching ants go round the edge only (not round every row), so the outline is drawn from the cells' edges.
    const outline = keep ? new Path2D(selection.outline ?? selection.path) : new Path2D();
    let any = false;
    for (let y = 0; y < h; y++) {
      let x = 0;
      while (x < w) {
        while (x < w && !on(x, y)) x++;
        const x0 = x;
        while (x < w && on(x, y)) x++;
        if (x > x0) { path.rect(x0 / k, y / k, (x - x0) / k, 1 / k + 0.5); any = true; }
      }
      // Horizontal edges above this row, joined where they run on.
      for (let x2 = 0; x2 < w; ) {
        if (on(x2, y) === on(x2, y - 1)) { x2++; continue; }
        const s0 = x2;
        while (x2 < w && on(x2, y) !== on(x2, y - 1)) x2++;
        outline.moveTo(s0 / k, y / k); outline.lineTo(x2 / k, y / k);
      }
    }
    // Vertical edges, column by column.
    for (let x = 0; x <= w; x++) {
      for (let y = 0; y < h; ) {
        if (on(x, y) === on(x - 1, y)) { y++; continue; }
        const s0 = y;
        while (y < h && on(x, y) !== on(x - 1, y)) y++;
        outline.moveTo(x / k, s0 / k); outline.lineTo(x / k, y / k);
      }
    }
    // The bottom edge of the last row.
    for (let x2 = 0; x2 < w; x2++) if (on(x2, h - 1)) { outline.moveTo(x2 / k, h / k); outline.lineTo((x2 + 1) / k, h / k); }
    return any ? { path, outline } : null;
  }

  // Select an object by tapping it (Photoshop's Object Selection, Segment Anything): SAM on the computer, through the
  // background remover's engine; Shift adds to the selection.
  async function tapSelect(p, add) {
    try {
      if (!(await bgReady())) return;
      busy(T("tapWorking", "Finding the object… (Segment Anything on your computer)"));
      const url = await kesher.call("image.bg.remove", { data: flatten().toDataURL("image/png"), model: "sam", point: [Math.round(p.x), Math.round(p.y)], mask: true });
      const found = maskToSelection(await loadImage(url), add);
      if (!found) return msg(T("tapNone", "Nothing found there; tap the middle of the object"), true);
      selection = { ...found, inverted: false };
      draw();
      msg(T("tapDone", "Selected. Shift+tap adds more; the task bar works on it."));
    } catch (e) { msg(e.message, true); } finally { busy(""); }
  }
  // Remove background (Photoshop's and Canva's): rembg + BiRefNet on the computer, set up the first time (asks first).
  // The cut-out goes in a new layer above, and the original is hidden, not deleted, so nothing is lost.
  async function bgReady() {
    let s = await kesher.call("image.bg.status");
    if (s.installed) return true;
    if (s.phase !== "installing" && !(await kesher.call("image.bg.setup"))) return false;
    busy(T("noBgSetup", "Setting up the background remover… (once)"));
    try {
      for (;;) {
        await new Promise((r) => setTimeout(r, 3000));
        s = await kesher.call("image.bg.status");
        if (s.installed && s.phase !== "installing") return true;
        if (s.phase === "error") throw new Error(s.message || "The setup stopped.");
        if (s.log?.length) $("busyText").textContent = `${T("noBgSetup", "Setting up the background remover… (once)")} ${s.log[s.log.length - 1].slice(0, 80)}`;
      }
    } finally { busy(""); }
  }
  $("aiNoBg").onclick = async () => {
    const src = active();
    if (!src) return;
    try {
      if (!(await bgReady())) return;
      busy(T("noBgWorking", "Removing the background… (BiRefNet on your computer)"));
      const img = await loadImage(await kesher.call("image.bg.remove", { data: src.canvas.toDataURL("image/png") }));
      remember(T("hNoBg", "Remove background"));
      const l = makeLayer(`${src.name} · ${T("noBgLayer", "no background")}`);
      Object.assign(l, { x: src.x, y: src.y, opacity: src.opacity, blend: src.blend });
      l.ctx.drawImage(img, 0, 0, l.canvas.width, l.canvas.height);
      src.visible = false;
      addLayer(l, doc.active + 1);
      msg(T("done", "Done"));
    } catch (e) { msg(e.message, true); } finally { busy(""); }
  };

  // ---------- keys, status ----------
  function msg(text, error) {
    const m = $("msg");
    m.textContent = text;
    m.className = error ? "err" : "";
  }
  addEventListener("keydown", (e) => {
    if (e.target instanceof window.HTMLInputElement || e.target instanceof window.HTMLTextAreaElement) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); redo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === "a") { e.preventDefault(); $("selAll").click(); return; }
    if ((e.ctrlKey || e.metaKey) && k === "d") { e.preventDefault(); $("selNone").click(); return; }
    if (k === " ") { spaceDown = true; stage.style.cursor = "grab"; e.preventDefault(); return; }
    if (k === "delete" || k === "backspace") return clearSelection();
    const map = { u: "shape", t: "text", c: "crop", b: "brush", e: "eraser", m: "rect", l: "lasso", v: "move", g: "fill", i: "picker", h: "hand" };
    if (map[k]) setTool(map[k]);
    if (k === "[") $("size").value = String(Math.max(1, +$("size").value - 5));
    if (k === "]") $("size").value = String(+$("size").value + 5);
    $("sizeOut").textContent = $("size").value;
  });
  addEventListener("keyup", (e) => { if (e.key === " ") { spaceDown = false; setTool(tool); } });
  $("size").oninput = () => ($("sizeOut").textContent = $("size").value);
  $("fit").onclick = fit;


  // ---------- colors: swatches (X swaps), the Color panel and recent colors ----------
  const recent = [];
  function setColor(hex) {
    $("color").value = hex;
    $("colorBig").value = hex;
  }
  function rememberColor(hex) {
    const i = recent.indexOf(hex);
    if (i >= 0) recent.splice(i, 1);
    recent.unshift(hex);
    recent.length = Math.min(recent.length, 18);
    const box = $("recent");
    box.textContent = "";
    for (const c of recent) {
      const b = document.createElement("button");
      b.style.background = c;
      b.title = c;
      b.onclick = () => setColor(c);
      box.append(b);
    }
  }
  $("color").oninput = () => ($("colorBig").value = $("color").value);
  $("colorBig").oninput = () => ($("color").value = $("colorBig").value);
  $("color").onchange = $("colorBig").onchange = () => rememberColor($("color").value);
  $("swap").onclick = () => { const a = $("color").value; setColor($("color2").value); $("color2").value = a; };

  // ---------- docked panels: tabs ----------
  document.querySelectorAll(".panel").forEach((panel) => {
    panel.querySelectorAll(".tabs [data-tab]").forEach((b) => {
      b.onclick = () => {
        panel.querySelectorAll(".tabs [data-tab]").forEach((x) => x.classList.toggle("on", x === b));
        panel.querySelectorAll(".tabpage[data-page]").forEach((p) => (p.hidden = p.dataset.page !== b.dataset.tab));
      };
    });
  });

  // ---------- personas (Affinity): Photo, Pixel, AI ----------
  function setPersona(p) {
    $("app").className = `app persona-${p}`;
    document.querySelectorAll("[data-persona]").forEach((b) => b.classList.toggle("on", b.dataset.persona === p));
    if (p === "pixel" && !["brush", "eraser", "fill", "picker", "hand"].includes(tool)) setTool("brush");
    if (p === "ai" && ["brush", "eraser", "fill"].includes(tool)) setTool("lasso");
    kesher.call("storage.set", { key: "persona", value: p }).catch(() => undefined);
  }
  document.querySelectorAll("[data-persona]").forEach((b) => (b.onclick = () => setPersona(b.dataset.persona)));

  // ---------- menus, press-and-slide like Apple's: press a menu, slide to an item, let go ----------
  const MENUS = () => [
    ["mFile", "File", [
      ["new", "New…", "Ctrl+N", () => $("newDialog").showModal()],
      ["open", "Open picture…", "Ctrl+O", () => $("file").click()],
      ["placeChat", "Place from this chat…", "", () => void placeFrom("chat")],
      ["placeBank", "Place from everything made…", "", () => void placeFrom("bank")],
      ["openProject", "Open project…", "", () => $("projectFile").click()],
      "-",
      ["saveProject", "Save project", "Ctrl+S", () => saveProject()],
      ["export", "Export PNG", "Ctrl+Shift+E", () => exportPng()],
      ...(fromChat ? [["toChat", "Send to the chat", "Ctrl+Enter", sendToChat]] : []),
      "-",
      ["openAffinity", "Open in Affinity", "", () => openInAffinity()],
    ]],
    ["mEdit", "Edit", [
      ["undo", "Undo", "Ctrl+Z", undo],
      ["redo", "Redo", "Ctrl+Y", redo],
      "-",
      ["clear", "Clear", "Del", clearSelection],
      "-",
      ["sizeH", "Picture size…", "Alt+Ctrl+I", openSize],
      ["h_cw", "Rotate 90° clockwise", "", () => turnImage("cw")],
      ["h_ccw", "Rotate 90° counter-clockwise", "", () => turnImage("ccw")],
      ["h_h", "Flip picture horizontally", "", () => turnImage("h")],
      ["h_v", "Flip picture vertically", "", () => turnImage("v")],
    ]],
    ["mSelect", "Select", [
      ["selAll", "Select all", "Ctrl+A", () => $("selAll").click()],
      ["selNone", "Deselect", "Ctrl+D", () => $("selNone").click()],
      ["selInvert", "Invert", "Ctrl+Shift+I", () => $("selInvert").click()],
    ]],
    ["mLayer", "Layer", [
      ["newLayer", "New layer", "Ctrl+Shift+N", () => $("addLayer").click()],
      ["duplicate", "Duplicate layer", "Ctrl+J", () => $("dupLayer").click()],
      ["mergeDown", "Merge down", "Ctrl+E", () => $("mergeDown").click()],
      ["flattenAll", "Flatten image", "", flattenAll],
      ["h_lh", "Flip layer horizontally", "", () => flipLayer("h")],
      ["h_lv", "Flip layer vertically", "", () => flipLayer("v")],
      "-",
      ["deleteLayer", "Delete layer", "", () => $("delLayer").click()],
    ]],
    ["mFilter", "Filter", [...$("filter").options].map((o) => [null, o.textContent, "", () => { $("filter").value = o.value; topTab("adjust"); }])],
    ["mAi", "AI", [
      ["aiLayer", "New layer from words", "", () => { setPersona("ai"); $("prompt").focus(); }],
      ["aiInpaint", "Repaint the selection", "", () => { setPersona("ai"); $("prompt").focus(); }],
      ["aiUpscale", "Enlarge ×4", "", () => $("aiUpscale").click()],
      ["aiNoBg", "Remove background", "", () => $("aiNoBg").click()],
    ]],
    ["mView", "View", [
      ["zoomIn", "Zoom in", "Ctrl++", () => zoomBy(1.25)],
      ["zoomOut", "Zoom out", "Ctrl+-", () => zoomBy(0.8)],
      ["fit", "Fit", "Ctrl+0", fit],
      ["actual", "Actual size", "Ctrl+1", () => zoomBy(1 / cam.scale)],
    ]],
  ];
  function topTab(name) {
    document.querySelector(`[data-panel="top"] [data-tab="${name}"]`)?.click();
  }
  function zoomBy(k) {
    const r = view.getBoundingClientRect();
    const mx = r.width / 2, my = r.height / 2;
    const s = Math.min(32, Math.max(0.05, cam.scale * k));
    cam.x = mx - ((mx - cam.x) * s) / cam.scale;
    cam.y = my - ((my - cam.y) * s) / cam.scale;
    cam.scale = s;
    draw();
  }
  function flattenAll() {
    if (doc.layers.length < 2) return;
    remember(T("flattenAll", "Flatten image"));
    const flat = flatten();
    const l = makeLayer(T("background", "Background"));
    l.ctx.drawImage(flat, 0, 0);
    doc.layers = [l];
    doc.active = 0;
    renderLayers();
    draw();
  }
  let pop = null;
  function closeMenu() {
    pop?.remove();
    pop = null;
    document.querySelectorAll(".menu-btn.open").forEach((b) => b.classList.remove("open"));
  }
  function buildMenus() {
    const bar = $("menus");
    bar.textContent = "";
    for (const [key, en, items] of MENUS()) {
      const b = document.createElement("button");
      b.className = "menu-btn";
      b.textContent = T(key, en);
      const openMenu = () => {
        closeMenu();
        b.classList.add("open");
        pop = document.createElement("div");
        pop.className = "menu-pop";
        pop.setAttribute("role", "menu");
        for (const it of items) {
          if (it === "-") { pop.append(document.createElement("hr")); continue; }
          const [k, label, keys, run] = it;
          const item = document.createElement("button");
          item.setAttribute("role", "menuitem");
          const name = document.createElement("span");
          name.textContent = k ? T(k, label) : label;
          const kbd = document.createElement("kbd");
          kbd.textContent = keys;
          item.append(name, kbd);
          item.onclick = () => { closeMenu(); run(); };
          pop.append(item);
        }
        const r = b.getBoundingClientRect();
        pop.style.top = `${r.bottom + 2}px`;
        if (he) pop.style.right = `${innerWidth - r.right}px`;
        else pop.style.left = `${r.left}px`;
        document.body.append(pop);
      };
      // Press and slide: the menu opens on press; letting go over an item runs it.
      b.onpointerdown = (e) => {
        e.preventDefault();
        if (b.classList.contains("open")) return closeMenu();
        openMenu();
        const move = (ev) => {
          const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".menu-pop button");
          pop?.querySelectorAll("button").forEach((x) => x.classList.toggle("hot", x === el));
          const other = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".menu-btn");
          if (other && other !== b && !other.classList.contains("open")) other.dispatchEvent(new PointerEvent("pointerenter"));
        };
        const up = (ev) => {
          removeEventListener("pointermove", move);
          removeEventListener("pointerup", up);
          const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".menu-pop button");
          if (el) el.click();
        };
        addEventListener("pointermove", move);
        addEventListener("pointerup", up);
      };
      // While a menu is open, moving to another title opens that one (like a desktop menu bar).
      b.onpointerenter = () => { if (pop && !b.classList.contains("open")) openMenu(); };
      bar.append(b);
    }
  }
  addEventListener("pointerdown", (e) => { if (pop && !e.target.closest?.(".menu-pop, .menu-btn")) closeMenu(); });
  addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (e.altKey && k === "i") { e.preventDefault(); return openSize(); }
    const map = { n: () => (e.shiftKey ? $("addLayer").click() : $("newDialog").showModal()), o: () => $("file").click(), s: saveProject, j: () => $("dupLayer").click(), e: () => (e.shiftKey ? exportPng() : $("mergeDown").click()), 0: fit, 1: () => zoomBy(1 / cam.scale), "=": () => zoomBy(1.25), "+": () => zoomBy(1.25), "-": () => zoomBy(0.8), i: () => (e.shiftKey ? $("selInvert").click() : undefined), enter: () => fromChat && ($("chatDialog").open ? $("chatDialog").close("ok") : sendToChat()) };
    if (map[k]) { e.preventDefault(); map[k](); }
  });

  // ---------- Affinity: open the picture there, bring the exported file back ----------
  let linked = null; // { name, mtime }
  async function openInAffinity() {
    const name = `${docName.replace(/[^\w .()-]/g, "_") || "picture"}.png`;
    try {
      const w = await kesher.call("files.write", { name, data: flatten().toDataURL("image/png") });
      const r = await kesher.call("files.openInAffinity", { name });
      linked = { name, mtime: w.mtime };
      msg(r.app === "affinity" ? T("affinityOpened", "Opened in Affinity. When you are done: File → Export → PNG, and save over the same file.") : T("affinityDefault", "Affinity is not on this computer, so the file opened in the usual picture app."));
    } catch (e) {
      msg(e.message, true);
    }
  }
  $("affinity").onclick = openInAffinity;
  setInterval(async () => {
    if (!linked) return;
    const st = await kesher.call("files.stat", { name: linked.name }).catch(() => null);
    if (st && st.mtime > linked.mtime + 500) $("linked").hidden = false;
  }, 2000);
  $("bringBack").onclick = async () => {
    if (!linked) return;
    try {
      const f = await kesher.call("files.read", { name: linked.name });
      const img = await loadImage(f.data);
      remember(T("hFromAffinity", "From Affinity"));
      const l = makeLayer(`Affinity · ${linked.name}`, img.naturalWidth, img.naturalHeight);
      l.ctx.drawImage(img, 0, 0);
      addLayer(l, doc.layers.length);
      linked.mtime = f.mtime;
      $("linked").hidden = true;
    } catch (e) {
      msg(e.message, true);
    }
  };

  // ---------- the chat the picture came from ("Edit" on a chat's picture) ----------
  let fromChat = null; // { conversationId, path, name } when opened from a chat
  async function openFromChat() {
    const input = await kesher.call("editor.input").catch(() => null);
    if (!input?.data) return;
    fromChat = input;
    void showEditIn();
    const img = await loadImage(input.data);
    docName = input.name.replace(/\.[^.]+$/, "") || "picture";
    $("docTab").textContent = input.name;
    newDoc(img.naturalWidth, img.naturalHeight, false);
    doc.layers[0].name = input.name;
    doc.layers[0].ctx.drawImage(img, 0, 0);
    // From another editor (a 3D model's texture): its UV layout as a guide layer on top, and the way back.
    if (input.guide) {
      const g = await loadImage(input.guide);
      const l = makeLayer(T("uvGuide", "UV guide (not saved)"));
      l.ctx.drawImage(g, 0, 0, doc.w, doc.h);
      l.opacity = 0.6;
      l.guide = true;
      doc.layers.push(l);
      // Painting goes on a layer of its own between the texture and the guide.
      const paint = makeLayer(T("paintLayer", "Paint"));
      doc.layers.splice(1, 0, paint);
      doc.active = 1;
    }
    renderLayers();
    draw();
    if (input.returnTo) {
      $("toBack").hidden = false;
      $("toBack").querySelector("b").textContent = T(`back_${input.returnTo.plugin}`, input.returnTo.plugin === "model-editor" ? "Back to the 3D model" : "Back");
      msg(T("fromModel", "The model's texture. When you are done: \"Back to the 3D model\"."));
    } else {
      $("toChat").hidden = false;
      msg(T("fromChat", "Opened from the chat"));
    }
  }
  /**
   * "Edit in…" (the editors' hand-off, editor-handoff.ts): only entries whose tool exists on this computer are shown;
   * "Make a 3D model from this" needs a picture-to-3D flow, so without one the whole button stays hidden.
   */
  async function showEditIn() {
    const caps = await kesher.call("editor.capabilities").catch(() => ({}));
    if (!caps.image3d) return;
    $("editIn").hidden = false;
    $("editIn").onclick = async () => {
      const am = await import("./add-media.js");
      am.setHebrew(he);
      am.openMenu($("editIn"), T("editInT", "Opens the other editor; \"Return to…\" there brings you back"), [
        { icon: "🧊", label: T("make3d", "Make a 3D model from this"), hint: T("make3dHint", "one object, on your computer"), run: () => void make3d() },
      ]);
    };
  }
  /** The picture as it is now, turned into a 3D model that opens in the 3D editor, with "Return to the picture editor" there. */
  async function make3d() {
    busy(T("making3d", "Making the 3D model… (several minutes, on your computer)"));
    try {
      const r = await kesher.call("editor.make3d", { name: `${docName}-for-3d.png`, data: flatten().toDataURL("image/png") });
      if (r?.downloading) msg(T("model3dDownloading", "The 3D model is downloading (see the downloads circle); try again when it is done."));
    } catch (e) {
      msg(e.message, true);
    } finally {
      busy("");
    }
  }
  $("toBack").onclick = async () => {
    if (!fromChat?.returnTo) return;
    busy(T("sending", "Sending…"));
    try {
      await kesher.call("editor.handBack", { name: `${docName}-edited.png`, data: flatten().toDataURL("image/png") });
    } catch (e) {
      msg(e.message, true);
    } finally {
      busy("");
    }
  };
  function sendToChat() {
    if (!fromChat) return;
    $("chatThumb").src = flatten().toDataURL("image/png");
    $("chatDialog").showModal();
    $("chatText").focus();
  }
  $("toChat").onclick = sendToChat;
  $("chatDialog").addEventListener("close", async () => {
    if ($("chatDialog").returnValue !== "ok") return;
    busy(T("sending", "Sending…"));
    try {
      await kesher.call("chat.sendFile", { name: `${docName}-edited.png`, data: flatten().toDataURL("image/png"), text: $("chatText").value.trim() });
      $("chatText").value = "";
    } catch (e) {
      msg(e.message, true);
    } finally {
      busy("");
    }
  });

  // ---------- the task bar under the selection ----------
  // Empty means Photoshop's "Generative fill" with no words: fill the area so it matches what is around it.
  const FILL = "fill this area so it matches its surroundings seamlessly, same light and texture";
  $("taskbar").onsubmit = (e) => {
    e.preventDefault();
    $("prompt").value = $("taskPrompt").value.trim() || FILL;
    $("aiInpaint").click();
  };
  $("taskClear").onclick = () => clearSelection();
  $("taskDone").onclick = () => $("selNone").click();

  // ---------- phone: the bottom bar, and the dock as a sheet ----------
  const app = $("app");
  function sheet(name) {
    const open = app.classList.contains(`sheet-${name}`);
    app.classList.remove("sheet", "sheet-layers", "sheet-ai");
    if (!open) app.classList.add("sheet", `sheet-${name}`);
    document.querySelectorAll(".phonebar [data-sheet]").forEach((b) => b.classList.toggle("on", !open && b.dataset.sheet === name));
  }
  document.querySelectorAll(".phonebar [data-sheet]").forEach((b) => (b.onclick = () => sheet(b.dataset.sheet)));
  document.querySelectorAll(".phonebar [data-phone]").forEach((b) => (b.onclick = () => {
    const what = b.dataset.phone;
    if (what === "fit") return fit();
    // Select: rectangle, then lasso, then rectangle again.
    setTool(what === "select" ? (tool === "rect" ? "lasso" : "rect") : what === "crop" || what === "text" || what === "shape" ? what : "brush");
  }));

  // ---------- "?": the shortcuts ----------
  const KEYS = [["U", "hShape", "Shape (Shift: square, circle, 45°)"], ["T", "hText", "Text"], ["B", "hBrush", "Brush"], ["E", "hEraser", "Eraser"], ["M", "rect", "Rectangle selection"], ["L", "lasso", "Lasso"], ["V", "hMove2", "Move"], ["C", "crop", "Crop"], ["G", "hFill", "Fill"], ["I", "picker", "Color picker"], ["H / Space", "hand", "Pan"], ["[  ]", "size", "Size"], ["X", "swap", "Swap colors"], ["Ctrl+Z / Ctrl+Y", "undo", "Undo / redo"], ["Ctrl+A / Ctrl+D", "selAll", "Select all / deselect"], ["Ctrl+J", "duplicate", "Duplicate layer"], ["Ctrl+E", "mergeDown", "Merge down"], ["Ctrl+S", "saveProject", "Save project"], ["Ctrl+Shift+E", "export", "Export PNG"], ["Ctrl+0", "fit", "Fit"], ["Ctrl+Enter", "toChat", "Send to the chat"], ["Del", "clear", "Clear"]];
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
    if (e.key === "?" && !e.target.closest?.("input, textarea, select")) showKeys();
  });

  // ---------- start ----------
  buildMenus();
  renderHistory();
  kesher.call("storage.get", { key: "persona" }).then((p) => p && setPersona(p)).catch(() => undefined);
  kesher.call("info").then((i) => {
    he = i.locale === "he";
    if (!he) return;
    buildMenus();
    renderHistory();
    document.documentElement.dir = "rtl";
    document.querySelectorAll("[data-t]").forEach((el) => (el.textContent = T(el.dataset.t, el.textContent)));
    document.querySelectorAll("[data-tp]").forEach((el) => (el.placeholder = T(el.dataset.tp, el.placeholder)));
    const OPT = { brightness: "בהירות", contrast: "ניגודיות", saturate: "רוויה", "hue-rotate": "גוון", blur: "טשטוש", grayscale: "שחור-לבן", sepia: "ספיה", invert: "היפוך", sharpen: "חידוד", "source-over": "רגיל", multiply: "הכפלה", screen: "מסך", overlay: "שכבת-על", darken: "הכהיה", lighten: "הבהרה", "color-dodge": "הבהרת צבע", "color-burn": "צריבת צבע", "soft-light": "אור רך", difference: "הפרש", color: "צבע", luminosity: "בהירות אור" };
    document.querySelectorAll("#filter option, #blend option").forEach((o) => (o.textContent = OPT[o.value] ?? o.textContent));
    if (doc.layers[0]) doc.layers[0].name = T("background", "Background");
    renderLayers();
  }).catch(() => undefined);
  new ResizeObserver(resize).observe(stage);
  setTool("brush");
  newDoc(1024, 1024, true);
  requestAnimationFrame(() => { resize(); fit(); });
  openFromChat().then(() => fromChat && buildMenus()).catch((e) => msg(e.message, true));
})();
