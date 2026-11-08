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
    new: "חדש…", open: "פתח תמונה…", openProject: "פתח פרויקט…", saveProject: "שמור פרויקט", export: "ייצא PNG", fit: "התאם",
    brushH: "מברשת", hardness: "קשיחות", flow: "אטימות", selectionH: "בחירה", selAll: "הכל", selNone: "בטל", selInvert: "הפוך", clear: "נקה",
    aiH: "AI (מודל התמונות שלך)", promptPh: "תאר מה לצייר…", aiLayer: "שכבה חדשה ממילים", aiInpaint: "צייר מחדש את הבחירה", strength: "כמה לשנות", aiUpscale: "הגדל פי 4",
    filtersH: "פילטרים (לשכבה הפעילה)", apply: "החל", layersH: "שכבות", layerOpacity: "אטימות שכבה",
    newH: "תמונה חדשה", width: "רוחב", height: "גובה", whiteBg: "רקע לבן", cancel: "ביטול", create: "צור",
    background: "רקע", layer: "שכבה", aiWorking: "המודל מצייר… (זה יכול לקחת דקה)", upscaling: "מגדיל…", needSelection: "קודם בחר אזור (מלבן, אליפסה או לאסו).", needPrompt: "כתוב מה לצייר.",
    saved: "נשמר", done: "מוכן", noLayer: "אין שכבה פעילה",
    pPhoto: "צילום", pPixel: "פיקסלים", pAi: "AI", openAffinity: "פתח ב-Affinity", size: "גודל", toAi: "צייר מחדש עם AI…", tolerance: "סבילות",
    tColor: "צבע", tAdjust: "התאמות", tAi: "AI", tLayers: "שכבות", tHistory: "היסטוריה", adjustHint: "לשכבה הפעילה, בתוך הבחירה.",
    affinityChanged: "נשמר ב-Affinity.", bringBack: "החזר כשכבה", affinityOpened: "נפתח ב-Affinity. כשתסיים: File ← Export ← PNG, ושמור באותו שם (החלף).", affinityDefault: "Affinity לא נמצא במחשב, אז הקובץ נפתח בתוכנה הרגילה לתמונות.", affinityRemote: "Affinity נפתח במחשב, לא בטלפון.",
    mFile: "קובץ", mEdit: "עריכה", mSelect: "בחירה", mLayer: "שכבה", mFilter: "פילטר", mAi: "AI", mView: "תצוגה",
    undo: "בטל", redo: "בצע שוב", newLayer: "שכבה חדשה", duplicate: "שכפל שכבה", mergeDown: "מזג למטה", deleteLayer: "מחק שכבה", flattenAll: "שטח תמונה", zoomIn: "הגדל תצוגה", zoomOut: "הקטן תצוגה", actual: "גודל אמיתי",
    hMove: "גרור כדי להזיז את השכבה הפעילה.", hHand: "גרור כדי להזיז את התצוגה. גלגלת: זום.", hPicker: "לחץ על התמונה כדי לקחת צבע.",
    hBrush: "מברשת", hEraser: "מחק", hFill: "דלי", hNew: "חדש", hOpenPic: "פתיחת תמונה", hFilter: "פילטר", hAiLayer: "שכבה מ-AI", hInpaint: "ציור מחדש ב-AI", hUpscale: "הגדלה", hClear: "ניקוי", hMove2: "הזזה", hLayerProps: "מאפייני שכבה", hFromAffinity: "חזר מ-Affinity",
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

  // ---------- undo ----------
  const undoStack = [];
  const redoStack = [];
  function snapshot() {
    return {
      w: doc.w, h: doc.h, active: doc.active,
      layers: doc.layers.map((l) => ({ ...l, data: l.ctx.getImageData(0, 0, l.canvas.width, l.canvas.height) })),
    };
  }
  function restore(s) {
    doc.w = s.w;
    doc.h = s.h;
    doc.active = s.active;
    doc.layers = s.layers.map((l) => {
      const c = document.createElement("canvas");
      c.width = l.data.width;
      c.height = l.data.height;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.putImageData(l.data, 0, 0);
      return { id: l.id, name: l.name, canvas: c, ctx, visible: l.visible, opacity: l.opacity, blend: l.blend, x: l.x, y: l.y };
    });
    renderLayers();
    draw();
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
      vctx.drawImage(l.canvas, l.x, l.y);
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
        vctx.stroke(draftPath ?? selection.path);
      }
      vctx.setLineDash([]);
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
  let drag = null;
  let spaceDown = false;
  function setTool(t) {
    tool = t;
    document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === t));
    // The context bar shows this tool's options (Photoshop's options bar).
    document.querySelectorAll(".ctx").forEach((c) => c.classList.toggle("show", c.dataset.for.split(" ").includes(t)));
    $("ctxTool").textContent = document.querySelector(`[data-tool="${t}"]`)?.textContent ?? "";
    $("ctxHint").textContent = t === "move" ? T("hMove", "Drag to move the active layer.") : t === "hand" ? T("hHand", "Drag to move the view. Wheel: zoom.") : t === "picker" ? T("hPicker", "Click the picture to take its color.") : "";
    stage.style.cursor = t === "hand" ? "grab" : t === "move" ? "move" : "crosshair";
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
      const c = document.createElement("canvas");
      c.width = doc.w;
      c.height = doc.h;
      strokePreview = { canvas: c, ctx: c.getContext("2d") };
      stroke(p, p);
    } else if (t === "move" && l) {
      remember(T("hMove2", "Move"));
      drag.lx = l.x;
      drag.ly = l.y;
    } else if (t === "fill" && l) floodFill(l, p.x, p.y, $("color").value);
    else if (t === "picker") pick(p);
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
    } else if (drag.t === "picker") pick(p);
    drag.last = p;
  });
  view.addEventListener("pointerup", () => {
    if (!drag) return;
    if (drag.t === "brush" || drag.t === "eraser") commitStroke();
    if ((drag.t === "rect" || drag.t === "ellipse" || drag.t === "lasso") && draftPath) {
      if (drag.t === "lasso") draftPath.closePath();
      selection = Math.hypot(drag.last.x - drag.start.x, drag.last.y - drag.start.y) > 2 || drag.t === "lasso" ? { path: draftPath, inverted: false } : null;
      draftPath = null;
      draw();
    }
    if (drag.t === "move") renderLayers();
    drag = null;
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
      row.append(thumb, name, eye, up, down, del);
      row.onclick = () => { doc.active = i; renderLayers(); };
      box.append(row);
    });
    const l = active();
    if (l) {
      $("blend").value = l.blend;
      $("layerOpacity").value = String(Math.round(l.opacity * 100));
    }
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
  $("dupLayer").onclick = () => {
    const l = active();
    if (!l) return;
    remember(T("duplicate", "Duplicate layer"));
    const c = makeLayer(`${l.name} copy`, l.canvas.width, l.canvas.height);
    c.ctx.drawImage(l.canvas, 0, 0);
    Object.assign(c, { opacity: l.opacity, blend: l.blend, x: l.x, y: l.y });
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
    below.ctx.drawImage(top.canvas, top.x - below.x, top.y - below.y);
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
      if (!l.visible) continue;
      x.globalAlpha = l.opacity;
      x.globalCompositeOperation = l.blend;
      x.drawImage(l.canvas, l.x, l.y);
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
  function isEmpty(l) {
    const d = l.ctx.getImageData(0, 0, l.canvas.width, l.canvas.height).data;
    for (let i = 3; i < d.length; i += 64) if (d[i] && !(d[i - 3] === 255 && d[i - 2] === 255 && d[i - 1] === 255)) return false;
    return true;
  }
  const exportPng = () => flatten().toBlob((b) => download(`${docName}.png`, b), "image/png");
  const saveProject = () => {
    const project = { kesherImage: 1, w: doc.w, h: doc.h, active: doc.active, layers: doc.layers.map((l) => ({ name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend, x: l.x, y: l.y, png: l.canvas.toDataURL("image/png") })) };
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
    const map = { b: "brush", e: "eraser", m: "rect", l: "lasso", v: "move", g: "fill", i: "picker", h: "hand" };
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
      ["openProject", "Open project…", "", () => $("projectFile").click()],
      "-",
      ["saveProject", "Save project", "Ctrl+S", () => saveProject()],
      ["export", "Export PNG", "Ctrl+Shift+E", () => exportPng()],
      "-",
      ["openAffinity", "Open in Affinity", "", () => openInAffinity()],
    ]],
    ["mEdit", "Edit", [
      ["undo", "Undo", "Ctrl+Z", undo],
      ["redo", "Redo", "Ctrl+Y", redo],
      "-",
      ["clear", "Clear", "Del", clearSelection],
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
      "-",
      ["deleteLayer", "Delete layer", "", () => $("delLayer").click()],
    ]],
    ["mFilter", "Filter", [...$("filter").options].map((o) => [null, o.textContent, "", () => { $("filter").value = o.value; topTab("adjust"); }])],
    ["mAi", "AI", [
      ["aiLayer", "New layer from words", "", () => { setPersona("ai"); $("prompt").focus(); }],
      ["aiInpaint", "Repaint the selection", "", () => { setPersona("ai"); $("prompt").focus(); }],
      ["aiUpscale", "Enlarge ×4", "", () => $("aiUpscale").click()],
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
    const map = { n: () => (e.shiftKey ? $("addLayer").click() : $("newDialog").showModal()), o: () => $("file").click(), s: saveProject, j: () => $("dupLayer").click(), e: () => (e.shiftKey ? exportPng() : $("mergeDown").click()), 0: fit, 1: () => zoomBy(1 / cam.scale), "=": () => zoomBy(1.25), "+": () => zoomBy(1.25), "-": () => zoomBy(0.8), i: () => (e.shiftKey ? $("selInvert").click() : undefined) };
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
})();
