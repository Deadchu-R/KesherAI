import { useEffect, useRef, useState } from "react";
import { getLocale } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

type Tool = "pen" | "arrow" | "box" | "pin" | "text";
type Mark =
  | { kind: "pen"; color: string; pts: Array<[number, number]> }
  | { kind: "arrow" | "box"; color: string; a: [number, number]; b: [number, number] }
  | { kind: "pin"; color: string; at: [number, number]; n: number; note: string }
  | { kind: "text"; color: string; at: [number, number]; text: string };

/** What the marked-up picture comes back as: the picture with the marks drawn in, and the numbered notes as text. */
export interface Annotated {
  png: Blob;
  notes: string[];
}

const COLORS = ["#ff3b30", "#ffd60a", "#34c759", "#0a84ff", "#ffffff"];

/**
 * Marks up a picture before it goes to the AI (researched first: Unity AI's
 * "Edit Screen Capture", Maestro's image annotator, agent "sketch" tools):
 * pen, arrow, box, numbered pins with a note each, and text, in a few
 * colours, with undo. The model gets the picture with the marks drawn in
 * plus the pins' notes as text ("1: move this here"), which reads better
 * than drawings alone. Works by finger: one finger draws, the buttons are
 * big enough to tap.
 *
 * @param props.src - The picture (an object URL or a link).
 * @param props.onDone - Gets the result; nothing when cancelled.
 */
export function Annotator({ src, onDone }: { src: string; onDone: (r: Annotated | null) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState("");
  const [tool, setTool] = useState<Tool>("pin");
  const [color, setColor] = useState(COLORS[0]!);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [draft, setDraft] = useState<Mark | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  // Text: tap where it goes, then type it in the box under the picture (no browser dialogs; Electron has none).
  const [textAt, setTextAt] = useState<[number, number] | null>(null);
  const [textValue, setTextValue] = useState("");

  useEffect(() => {
    const i = new Image();
    i.crossOrigin = "anonymous";
    i.onload = () => setImg(i);
    i.onerror = () => setError(L("לא הצלחתי לפתוח את התמונה.", "Could not open the picture."));
    i.src = src;
  }, [src]);

  // Line widths and font sizes follow the picture's size, so marks read the same on a phone photo and a 4K screen.
  const unit = img ? Math.max(2, Math.round(Math.max(img.naturalWidth, img.naturalHeight) / 400)) : 3;

  const draw = (ctx: CanvasRenderingContext2D, list: Mark[]) => {
    if (!img) return;
    ctx.drawImage(img, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const m of list) {
      ctx.strokeStyle = m.color;
      ctx.fillStyle = m.color;
      ctx.lineWidth = unit * 1.5;
      if (m.kind === "pen") {
        ctx.beginPath();
        m.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
      } else if (m.kind === "box") {
        ctx.strokeRect(Math.min(m.a[0], m.b[0]), Math.min(m.a[1], m.b[1]), Math.abs(m.b[0] - m.a[0]), Math.abs(m.b[1] - m.a[1]));
      } else if (m.kind === "arrow") {
        const [x1, y1] = m.a;
        const [x2, y2] = m.b;
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const head = unit * 7;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - head * Math.cos(ang - 0.45), y2 - head * Math.sin(ang - 0.45));
        ctx.lineTo(x2 - head * Math.cos(ang + 0.45), y2 - head * Math.sin(ang + 0.45));
        ctx.closePath();
        ctx.fill();
      } else if (m.kind === "pin") {
        const r = unit * 6;
        ctx.beginPath();
        ctx.arc(m.at[0], m.at[1], r, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = unit;
        ctx.strokeStyle = "#000";
        ctx.stroke();
        ctx.fillStyle = m.color === "#ffffff" || m.color === "#ffd60a" ? "#000" : "#fff";
        ctx.font = `bold ${Math.round(r * 1.2)}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(m.n), m.at[0], m.at[1] + 1);
      } else if (m.kind === "text" && m.text) {
        const size = unit * 9;
        ctx.font = `bold ${size}px system-ui, sans-serif`;
        ctx.textAlign = "start";
        ctx.textBaseline = "top";
        ctx.lineWidth = unit * 1.2;
        ctx.strokeStyle = "#000";
        ctx.strokeText(m.text, m.at[0], m.at[1]);
        ctx.fillText(m.text, m.at[0], m.at[1]);
      }
    }
  };

  useEffect(() => {
    const c = canvas.current;
    if (!c || !img) return;
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d");
    if (ctx) draw(ctx, draft ? [...marks, draft] : marks);
  }, [img, marks, draft]);

  const at = (e: React.PointerEvent): [number, number] => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * c.width, ((e.clientY - r.top) / r.height) * c.height];
  };
  const pins = marks.filter((m): m is Extract<Mark, { kind: "pin" }> => m.kind === "pin");
  const down = (e: React.PointerEvent) => {
    if (!img || busy) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = at(e);
    if (tool === "pin") {
      const n = pins.length + 1;
      setMarks((m) => [...m, { kind: "pin", color, at: p, n, note: "" }]);
      setEditing(marks.length);
    } else if (tool === "text") {
      setTextAt(p);
      setTextValue("");
    } else if (tool === "pen") setDraft({ kind: "pen", color, pts: [p] });
    else setDraft({ kind: tool, color, a: p, b: p });
  };
  const move = (e: React.PointerEvent) => {
    if (!draft) return;
    const p = at(e);
    setDraft(draft.kind === "pen" ? { ...draft, pts: [...draft.pts, p] } : draft.kind === "arrow" || draft.kind === "box" ? { ...draft, b: p } : draft);
  };
  const up = () => {
    if (!draft) return;
    const tiny = (draft.kind === "arrow" || draft.kind === "box") && Math.hypot(draft.b[0] - draft.a[0], draft.b[1] - draft.a[1]) < unit * 3;
    if (!tiny && !(draft.kind === "pen" && draft.pts.length < 2)) setMarks((m) => [...m, draft]);
    setDraft(null);
  };
  const undo = () => {
    setMarks((m) => m.slice(0, -1));
    setEditing(null);
  };
  const setNote = (i: number, note: string) => setMarks((m) => m.map((x, k) => (k === i && x.kind === "pin" ? { ...x, note } : x)));

  const save = () => {
    const c = canvas.current;
    if (!c || !img) return;
    setBusy(true);
    const ctx = c.getContext("2d");
    if (ctx) draw(ctx, marks);
    // Big screens are made smaller (at most 2000 px wide), so the picture stays light for the model.
    const scale = Math.min(1, 2000 / c.width);
    const out = document.createElement("canvas");
    out.width = Math.round(c.width * scale);
    out.height = Math.round(c.height * scale);
    out.getContext("2d")?.drawImage(c, 0, 0, out.width, out.height);
    out.toBlob((b) => {
      setBusy(false);
      if (!b) return setError(L("לא הצלחתי לשמור את התמונה.", "Could not save the picture."));
      onDone({ png: b, notes: pins.map((p) => `${p.n}: ${p.note.trim() || L("(בלי הערה)", "(no note)")}`) });
    }, "image/png");
  };

  const tools: Array<[Tool, string, string]> = [
    ["pin", "①", L("נעץ ממוספר עם הערה", "Numbered pin with a note")],
    ["arrow", "↗", L("חץ", "Arrow")],
    ["box", "▭", L("מסגרת", "Box")],
    ["pen", "✎", L("ציור חופשי", "Pen")],
    ["text", "T", L("טקסט", "Text")],
  ];
  return (
    <div className="annot" role="dialog" aria-modal="true" aria-label={L("סימון על התמונה", "Mark up the picture")}>
      <div className="annot-bar row">
        <div className="annot-tools row" role="toolbar" aria-label={L("כלים", "Tools")}>
          {tools.map(([t, icon, label]) => (
            <button key={t} type="button" className={tool === t ? "on" : ""} aria-pressed={tool === t} title={label} aria-label={label} onClick={() => setTool(t)}>{icon}</button>
          ))}
        </div>
        <div className="annot-colors row" role="radiogroup" aria-label={L("צבע", "Colour")}>
          {COLORS.map((c) => <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} className={color === c ? "on" : ""} style={{ background: c }} onClick={() => setColor(c)} />)}
        </div>
        <button type="button" onClick={undo} disabled={!marks.length} title={L("בטל", "Undo")} aria-label={L("בטל", "Undo")}>↶</button>
        <span className="grow" />
        <button type="button" onClick={() => onDone(null)}>{L("ביטול", "Cancel")}</button>
        <button type="button" className="primary" disabled={!img || busy} onClick={save}>{busy ? "…" : L("צרף לצ'אט", "Attach")}</button>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="annot-stage">
        {!img && !error && <p className="muted">…</p>}
        <canvas ref={canvas} className="annot-canvas" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} hidden={!img} />
      </div>
      {textAt && (
        <form className="row annot-text" onSubmit={(e) => { e.preventDefault(); const text = textValue.trim().slice(0, 80); if (text) setMarks((m) => [...m, { kind: "text", color, at: textAt, text }]); setTextAt(null); }}>
          <input className="grow" dir="auto" autoFocus value={textValue} onChange={(e) => setTextValue(e.target.value)} placeholder={L("הטקסט שיופיע על התמונה", "The text to put on the picture")} />
          <button type="submit" className="primary">{L("הוסף", "Add")}</button>
          <button type="button" onClick={() => setTextAt(null)}>✕</button>
        </form>
      )}
      {pins.length > 0 && (
        <ol className="annot-notes">
          {marks.map((m, i) => m.kind === "pin" && (
            <li key={i} className="row">
              <span className="annot-n" style={{ background: m.color }}>{m.n}</span>
              <input className="grow" dir="auto" autoFocus={editing === i} value={m.note} onChange={(e) => setNote(i, e.target.value)} placeholder={L("מה לעשות כאן? (למשל: להזיז ימינה, להגדיל)", "What to do here? (e.g. move it right, make it bigger)")} />
            </li>
          ))}
        </ol>
      )}
      <p className="muted small annot-hint">{L("① מסמן מקום עם הערה (הכי ברור למודל) · ↗ חץ · ▭ מסגרת · ✎ ציור · T טקסט", "① marks a spot with a note (clearest for the model) · ↗ arrow · ▭ box · ✎ pen · T text")}</p>
    </div>
  );
}
