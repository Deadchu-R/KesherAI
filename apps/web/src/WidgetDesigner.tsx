import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";
import { toast } from "./library";
import { Select } from "./ui/Select";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface WNode { name: string; class: string; props?: Record<string, string | number>; slot?: Record<string, string | number | boolean>; children?: WNode[] }
type Op = Record<string, unknown>;

/** The design size UMG lays out against (DPI scale 1). */
const DW = 1920;
const DH = 1080;

/** "(R=1.0,G=0.5,B=0,A=1)" or "(SpecifiedColor=(R=…))" → a CSS color. */
function color(v: unknown): string | undefined {
  const m = /R=([\d.]+),G=([\d.]+),B=([\d.]+)(?:,A=([\d.]+))?/.exec(String(v ?? ""));
  if (!m) return undefined;
  // Linear (UMG's FLinearColor) to screen, roughly: a gamma of 2.2.
  const c = (x: string) => Math.round(255 * Math.min(1, Math.pow(Number(x), 1 / 2.2)));
  return `rgba(${c(m[1]!)},${c(m[2]!)},${c(m[3]!)},${m[4] ?? 1})`;
}
/** An FText as Unreal exports it (NSLOCTEXT("ns","key","Hello"), INVTEXT("Hi") or "Hi") → the words. */
function text(v: unknown): string {
  const s = String(v ?? "");
  const all = [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!);
  return (all.at(-1) ?? s).replace(/\\"/g, '"').replace(/\\n/g, "\n");
}
/** "(Left=8,Top=4,Right=8,Bottom=4)" → CSS padding (UMG order is left top right bottom). */
function padding(v: unknown): string | undefined {
  const s = String(v ?? "");
  const n = (k: string) => Number(new RegExp(`${k}=([\\d.-]+)`).exec(s)?.[1] ?? 0);
  return /Left=|Top=/.test(s) ? `${n("Top")}px ${n("Right")}px ${n("Bottom")}px ${n("Left")}px` : undefined;
}
const align = (v: unknown) => (/Center/.test(String(v)) ? "center" : /Right|Bottom/.test(String(v)) ? "flex-end" : /Fill/.test(String(v)) ? "stretch" : /Left|Top/.test(String(v)) ? "flex-start" : undefined);

function find(root: WNode | undefined, name: string): WNode | undefined {
  if (!root) return undefined;
  if (root.name === name) return root;
  for (const c of root.children ?? []) {
    const f = find(c, name);
    if (f) return f;
  }
  return undefined;
}
function parentOf(root: WNode | undefined, name: string): WNode | undefined {
  for (const c of root?.children ?? []) {
    if (c.name === name) return root;
    const f = parentOf(c, name);
    if (f) return f;
  }
  return undefined;
}

/**
 * The Widget Blueprint's Designer, like UMG's: the screen as it will look
 * (Canvas Panel positions and anchors, boxes, overlays, borders, buttons,
 * text, images, progress bars), the Hierarchy, and Details for the chosen
 * widget. Drag a widget in a Canvas Panel to move it; change its text,
 * size, colors or slot in Details; or say the change in words. Every change
 * goes to the editor at once (one undo step there).
 */
export function WidgetDesigner({ path, editable, model }: { path: string; editable: boolean; model?: string }) {
  const [root, setRoot] = useState<WNode | undefined>();
  const [error, setError] = useState("");
  const [sel, setSel] = useState<string>("");
  const [ask, setAsk] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const stage = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.4);
  const load = () =>
    void api<{ root?: WNode }>(`/api/unreal/widget?path=${encodeURIComponent(path)}`).then(
      (r) => {
        setRoot(r.root);
        setError("");
      },
      (e: Error) => setError(e.message),
    );
  useEffect(load, [path]);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const fit = () => setScale(Math.max(0.1, el.clientWidth / DW));
    fit();
    const o = new ResizeObserver(fit);
    o.observe(el);
    return () => o.disconnect();
  }, []);

  const apply = async (ops: Op[]) => {
    setBusy(true);
    try {
      const r = await api<{ results: Array<{ ok: boolean; error?: string }> }>("/api/unreal/widget/apply", { method: "POST", body: { path, ops } });
      r.results.filter((x) => !x.ok).forEach((x) => toast(`⚠ ${x.error ?? ""}`));
      load();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const editInWords = async () => {
    if (!ask.trim()) return;
    setBusy(true);
    setNote("");
    try {
      const r = await api<{ note: string; result?: { results: Array<{ ok: boolean; error?: string }> } }>("/api/unreal/widget/edit", { method: "POST", body: { path, request: ask, ...(sel ? { selected: sel } : {}), ...(model ? { model } : {}) } });
      setNote([r.note, ...(r.result?.results.filter((x) => !x.ok).map((x) => `⚠ ${x.error ?? ""}`) ?? [])].filter(Boolean).join("\n"));
      setAsk("");
      load();
    } catch (e) {
      setNote(`⛔ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // Moving a widget in a Canvas Panel: drag, then one "slot.position" change on release.
  const drag = useRef<{ name: string; sx: number; sy: number; x: number; y: number } | null>(null);
  const [offset, setOffset] = useState<{ name: string; dx: number; dy: number } | null>(null);
  const downOn = (e: React.PointerEvent, w: WNode) => {
    e.stopPropagation();
    setSel(w.name);
    if (!editable || !w.slot || !("x" in w.slot)) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    drag.current = { name: w.name, sx: e.clientX, sy: e.clientY, x: Number(w.slot.x), y: Number(w.slot.y) };
  };
  const moveOn = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setOffset({ name: d.name, dx: (e.clientX - d.sx) / scale, dy: (e.clientY - d.sy) / scale });
  };
  const upOn = () => {
    const d = drag.current;
    drag.current = null;
    if (d && offset && offset.name === d.name && Math.hypot(offset.dx, offset.dy) > 2) void apply([{ op: "set", widget: d.name, property: "slot.position", value: `${Math.round(d.x + offset.dx)},${Math.round(d.y + offset.dy)}` }]);
    setOffset(null);
  };

  // The class of the panel being drawn (a box's slot alignment depends on its direction).
  let parentClass = "";
  const render = (w: WNode, inCanvas: boolean): React.ReactNode => {
    const p = w.props ?? {};
    const s = w.slot ?? {};
    const style: React.CSSProperties = {};
    if (inCanvas && "x" in s) {
      const dx = offset?.name === w.name ? offset.dx : 0;
      const dy = offset?.name === w.name ? offset.dy : 0;
      const [a0x, a1x, a0y, a1y] = [Number(s.anchorMinX), Number(s.anchorMaxX), Number(s.anchorMinY), Number(s.anchorMaxY)];
      const [x, y, ww, hh] = [Number(s.x) + dx, Number(s.y) + dy, Number(s.w), Number(s.h)];
      style.position = "absolute";
      style.left = `calc(${a0x * 100}% + ${x}px)`;
      style.top = `calc(${a0y * 100}% + ${y}px)`;
      if (a0x === a1x) {
        if (!s.autoSize) style.width = ww;
        style.translate = `${-Number(s.alignX) * 100}% ${-Number(s.alignY) * 100}%`;
      } else style.width = `calc(${(a1x - a0x) * 100}% - ${x + ww}px)`;
      if (a0y === a1y) {
        if (!s.autoSize) style.height = hh;
      } else style.height = `calc(${(a1y - a0y) * 100}% - ${y + hh}px)`;
      style.zIndex = Number(s.z) || undefined;
    } else {
      const pad = padding(s.Padding);
      if (pad) style.margin = pad;
      const h = align(s.HorizontalAlignment);
      const v = align(s.VerticalAlignment);
      if (/HorizontalBox/.test(parentClass)) style.alignSelf = v ?? undefined;
      else if (/VerticalBox|ScrollBox/.test(parentClass)) style.alignSelf = h ?? undefined;
      else {
        // Border, Button, Overlay, Size Box (a grid here): each side on its own.
        if (h) style.justifySelf = h === "flex-start" ? "start" : h === "flex-end" ? "end" : h;
        if (v) style.alignSelf = v === "flex-start" ? "start" : v === "flex-end" ? "end" : v;
      }
      if (/SizeRule=Fill/.test(String(s.Size ?? ""))) style.flex = `${Number(/Value=([\d.]+)/.exec(String(s.Size))?.[1] ?? 1)} 1 0`;
    }
    if (p.Visibility === "Collapsed") return null;
    if (p.Visibility === "Hidden") style.visibility = "hidden";
    if (p.RenderOpacity !== undefined && Number(p.RenderOpacity) !== 1) style.opacity = Number(p.RenderOpacity);
    const kids = w.children ?? [];
    let body: React.ReactNode = null;
    let cls = "wd-w";
    const c = w.class;
    const prevParent = parentClass;
    parentClass = c;
    if (/CanvasPanel/.test(c)) {
      cls += " wd-canvas";
      body = kids.map((k) => render(k, true));
    } else if (/HorizontalBox|WrapBox/.test(c)) {
      cls += " wd-hbox";
      body = kids.map((k) => render(k, false));
    } else if (/VerticalBox|ScrollBox/.test(c)) {
      cls += " wd-vbox";
      body = kids.map((k) => render(k, false));
    } else if (/Overlay|GridPanel|UniformGridPanel/.test(c)) {
      cls += " wd-overlay";
      body = kids.map((k) => render(k, false));
    } else if (/TextBlock|RichTextBlock|EditableText/.test(c)) {
      cls += " wd-text";
      style.color = color(p.ColorAndOpacity) ?? "#fff";
      style.fontSize = Number(p.fontSize) || 24;
      style.textAlign = /Center/.test(String(p.Justification)) ? "center" : /Right/.test(String(p.Justification)) ? "right" : "left";
      body = text(p.Text) || w.name;
    } else if (/Image/.test(c)) {
      cls += " wd-image";
      style.background = color(p.ColorAndOpacity) ?? color(p.BrushColor) ?? "#ffffff";
      const size = /ImageSize=\(X=([\d.]+),Y=([\d.]+)\)/.exec(String(p.Brush ?? ""));
      if (size && !style.width) {
        style.minWidth = Number(size[1]);
        style.minHeight = Number(size[2]);
      }
      body = /ResourceObject=(?!None)/.test(String(p.Brush ?? "")) ? <span className="wd-pic">🖼</span> : null;
    } else if (/ProgressBar/.test(c)) {
      cls += " wd-progress";
      body = <span style={{ width: `${Math.round(Number(p.Percent ?? 0) * 100)}%`, background: color(p.FillColorAndOpacity) ?? "#2d8bf0" }} />;
    } else if (/Button/.test(c)) {
      cls += " wd-button";
      const bg = color(p.BackgroundColor);
      if (bg) style.background = bg;
      body = kids.map((k) => render(k, false));
    } else if (/Border/.test(c)) {
      cls += " wd-border";
      style.background = color(p.BrushColor) ?? "rgba(255,255,255,0.08)";
      const pad = padding(p.Padding);
      if (pad) style.padding = pad;
      body = kids.map((k) => render(k, false));
    } else if (/SizeBox/.test(c)) {
      if (Number(p.WidthOverride)) style.width = Number(p.WidthOverride);
      if (Number(p.HeightOverride)) style.height = Number(p.HeightOverride);
      cls += " wd-overlay";
      body = kids.map((k) => render(k, false));
    } else if (/Spacer/.test(c)) cls += " wd-spacer";
    else {
      cls += " wd-other";
      body = kids.length ? kids.map((k) => render(k, false)) : <span className="wd-tag">{c}</span>;
    }
    parentClass = prevParent;
    return (
      <div key={w.name} className={`${cls}${sel === w.name ? " sel" : ""}`} style={style} title={`${w.name} (${c})`} onPointerDown={(e) => downOn(e, w)} onPointerMove={moveOn} onPointerUp={upOn}>
        {body}
      </div>
    );
  };

  const chosen = useMemo(() => (sel ? find(root, sel) : undefined), [root, sel]);
  const parent = useMemo(() => (sel ? parentOf(root, sel) : undefined), [root, sel]);
  const tree = (w: WNode, depth: number): React.ReactNode => (
    <li key={w.name}>
      <button type="button" className={sel === w.name ? "on" : ""} style={{ paddingInlineStart: 8 + depth * 14 }} onClick={() => setSel(w.name)}>
        <span dir="ltr">{w.name}</span> <span className="muted small">{w.class}</span>
      </button>
      {(w.children ?? []).length > 0 && <ul>{w.children!.map((k) => tree(k, depth + 1))}</ul>}
    </li>
  );

  if (error) return <p className="error small">{error}</p>;
  return (
    <div className="wd">
      <div className="wd-stage" ref={stage} onPointerDown={() => setSel("")}>
        <div className="wd-screen" style={{ width: DW, height: DH, transform: `scale(${scale})` }}>
          {root ? render(root, false) : <p className="muted wd-empty">{L("אין עדיין ווידג'טים. אפשר לבקש במילים, למשל: מסך פתיחה עם כותרת וכפתור התחל.", "No widgets yet. Ask in words, e.g. a start screen with a title and a Start button.")}</p>}
        </div>
      </div>
      <div className="wd-side">
        <section>
          <h3 className="small">{L("היררכיה", "Hierarchy")}</h3>
          <ul className="wd-tree">{root && tree(root, 0)}</ul>
        </section>
        {chosen && (
          <Details key={chosen.name} w={chosen} parentClass={parent?.class} editable={editable} onApply={(ops) => void apply(ops)} />
        )}
        <form className="row wd-ask" onSubmit={(e) => { e.preventDefault(); void editInWords(); }}>
          <input className="grow" dir="auto" value={ask} disabled={!editable || busy} onChange={(e) => setAsk(e.target.value)} placeholder={chosen ? L(`מה לשנות ב-${chosen.name}?`, `What to change in ${chosen.name}?`) : L("✨ מה לשנות? למשל: כפתור התחל כחול באמצע", "✨ What to change? e.g. a blue Start button in the middle")} />
          <button type="submit" className="primary" disabled={!editable || busy || !ask.trim()}>{busy ? "…" : "✨"}</button>
        </form>
        {note && <p className="small" dir="auto" style={{ whiteSpace: "pre-wrap" }}>{note}</p>}
        {editable && <FigmaImport path={path} parent={chosen && /Panel|Box|Overlay|Border|SizeBox/.test(chosen.class) ? chosen.name : ""} onDone={load} />}
      </div>
    </div>
  );
}

/** Details for one widget: the fields people change most, each sent to the editor when it changes. */
function Details({ w, parentClass, editable, onApply }: { w: WNode; parentClass?: string; editable: boolean; onApply: (ops: Op[]) => void }) {
  const p = w.props ?? {};
  const s = w.slot ?? {};
  const set = (property: string, value: string) => onApply([{ op: "set", widget: w.name, property, value }]);
  const field = (label: string, value: string, onDone: (v: string) => void, type = "text") => (
    <label className="wd-field">
      <span className="small muted">{label}</span>
      <input type={type} dir="ltr" defaultValue={value} disabled={!editable} onBlur={(e) => e.target.value !== value && onDone(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
    </label>
  );
  const hex = (v: unknown) => {
    const m = /R=([\d.]+),G=([\d.]+),B=([\d.]+)/.exec(String(v ?? ""));
    if (!m) return "#ffffff";
    const c = (x: string) => Math.round(255 * Math.min(1, Math.pow(Number(x), 1 / 2.2))).toString(16).padStart(2, "0");
    return `#${c(m[1]!)}${c(m[2]!)}${c(m[3]!)}`;
  };
  const linear = (h: string) => {
    const c = (i: number) => Math.pow(parseInt(h.slice(i, i + 2), 16) / 255, 2.2).toFixed(4);
    return `(R=${c(1)},G=${c(3)},B=${c(5)},A=1.0)`;
  };
  const colorField = (label: string, prop: string, wrap?: (v: string) => string) => (
    <label className="wd-field">
      <span className="small muted">{label}</span>
      <input type="color" defaultValue={hex(p[prop])} disabled={!editable} onChange={(e) => set(prop, wrap ? wrap(linear(e.target.value)) : linear(e.target.value))} />
    </label>
  );
  return (
    <section className="wd-details">
      <h3 className="small" dir="ltr">{w.name} <span className="muted">{w.class}</span></h3>
      {"Text" in p && field(L("טקסט", "Text"), text(p.Text), (v) => set("Text", v))}
      {"fontSize" in p && field(L("גודל גופן", "Font size"), String(p.fontSize), (v) => set("fontSize", v), "number")}
      {"ColorAndOpacity" in p && /Text/.test(w.class) && colorField(L("צבע", "Color"), "ColorAndOpacity", (v) => `(SpecifiedColor=${v},ColorUseRule=UseColor_Specified)`)}
      {"ColorAndOpacity" in p && /Image/.test(w.class) && colorField(L("צבע", "Color"), "ColorAndOpacity")}
      {"BrushColor" in p && colorField(L("צבע רקע", "Background"), "BrushColor")}
      {"BackgroundColor" in p && colorField(L("צבע הכפתור", "Button color"), "BackgroundColor")}
      {"x" in s && (
        <>
          {field(L("מיקום (x,y)", "Position (x,y)"), `${s.x},${s.y}`, (v) => set("slot.position", v))}
          {field(L("גודל (רוחב,גובה)", "Size (w,h)"), `${s.w},${s.h}`, (v) => set("slot.size", v))}
          {field(L("עוגנים (minX,minY,maxX,maxY)", "Anchors (minX,minY,maxX,maxY)"), `${s.anchorMinX},${s.anchorMinY},${s.anchorMaxX},${s.anchorMaxY}`, (v) => set("slot.anchors", v))}
          {field(L("יישור (x,y)", "Alignment (x,y)"), `${s.alignX},${s.alignY}`, (v) => set("slot.alignment", v))}
        </>
      )}
      {"Padding" in s && field(L("ריווח (Padding)", "Padding"), String(s.Padding), (v) => set("slot.Padding", v))}
      {"HorizontalAlignment" in s && field(L("יישור אופקי", "Horizontal alignment"), String(s.HorizontalAlignment), (v) => set("slot.HorizontalAlignment", v))}
      {"VerticalAlignment" in s && field(L("יישור אנכי", "Vertical alignment"), String(s.VerticalAlignment), (v) => set("slot.VerticalAlignment", v))}
      {editable && (
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          {/Panel|Box|Overlay|Border|Button|SizeBox/.test(w.class) && (
            <Select defaultValue="" onChange={(e) => { if (e.target.value) onApply([{ op: "add", class: e.target.value, parent: w.name }]); e.target.value = ""; }} aria-label={L("הוספת ווידג'ט בתוכו", "Add a widget inside")}>
              <option value="">{L("+ הוסף בתוכו…", "+ Add inside…")}</option>
              {["TextBlock", "Image", "Button", "Border", "CanvasPanel", "HorizontalBox", "VerticalBox", "Overlay", "SizeBox", "ProgressBar", "Spacer"].map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          )}
          {parentClass && <button type="button" onClick={() => onApply([{ op: "remove", widget: w.name }])}>{L("מחק", "Delete")}</button>}
        </div>
      )}
    </section>
  );
}

/**
 * Figma → Unreal: the link of a Figma frame becomes widgets inside the chosen
 * panel (auto layout as boxes, text, colours, positions). Uses the Figma
 * token saved in Settings → Appearance.
 */
function FigmaImport({ path, parent, onDone }: { path: string; parent: string; onDone: () => void }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    void api<{ connected: boolean }>("/api/figma").then((r) => setConnected(r.connected), () => setConnected(false));
  }, []);
  const go = async () => {
    setBusy(true);
    setMsg("");
    try {
      const r = await api<{ added: number; notes: string[]; result: { failed: number; results: Array<{ ok: boolean; error?: string }> } }>("/api/unreal/widget/figma", { method: "POST", body: { path, link, ...(parent ? { parent } : {}) } });
      setMsg([L(`נוספו ${r.added} ווידג'טים מ-Figma.`, `Added ${r.added} widgets from Figma.`), ...r.notes.slice(0, 6), ...r.result.results.filter((x) => !x.ok).slice(0, 4).map((x) => `⚠ ${x.error ?? ""}`)].join("\n"));
      setLink("");
      onDone();
    } catch (e) {
      setMsg(`⛔ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  if (connected === null) return null;
  return (
    <section className="wd-details">
      <h3 className="small">{L("ייבוא מ-Figma", "Import from Figma")}</h3>
      {!connected ? (
        <p className="small muted">{L("חברו את Figma בהגדרות ← מראה ← Figma (טוקן גישה אישי), ואז הדביקו כאן קישור למסגרת.", "Connect Figma in Settings → Appearance → Figma (a personal access token), then paste a frame's link here.")} <a href="#/settings/appearance">{L("להגדרות", "Settings")}</a></p>
      ) : (
        <form className="row wd-ask" onSubmit={(e) => { e.preventDefault(); void go(); }}>
          <input className="grow" dir="ltr" value={link} onChange={(e) => setLink(e.target.value)} placeholder={L("קישור למסגרת ב-Figma", "Link to a Figma frame")} />
          <button type="submit" disabled={busy || !link.trim()}>{busy ? "…" : L("ייבא", "Import")}</button>
        </form>
      )}
      {connected && <p className="small muted">{parent ? L(`ייכנס לתוך ${parent}.`, `Goes into ${parent}.`) : L("בחרו בהיררכיה את הפאנל שהעיצוב ייכנס אליו (או ריק: יהיה השורש).", "Pick the panel it goes into in the Hierarchy (empty Blueprint: it becomes the root).")} {L("ב-Figma: קליק ימני על המסגרת ← Copy link to selection.", "In Figma: right-click the frame → Copy link to selection.")}</p>}
      {msg && <p className="small" dir="auto" style={{ whiteSpace: "pre-wrap" }}>{msg}</p>}
    </section>
  );
}
