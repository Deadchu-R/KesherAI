import { useEffect, useRef, useState } from "react";
import { api, withToken } from "../api";
import { getLocale, he$ } from "../i18n";
import { desktop, toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
type Action = "ask" | "search" | "translate" | "summarize" | "text";
const ACTIONS: Array<[Action, string, string, string]> = [
  ["ask", "✨", "לשאול", "Ask"],
  ["search", "🔎", "לחפש", "Search"],
  ["translate", "🌐", "לתרגם", "Translate"],
  ["summarize", "📝", "לסכם", "Summarize"],
  ["text", "📋", "להעתיק טקסט", "Copy text"],
];
type Box = { x: number; y: number; w: number; h: number };

/** Where the picture really is on the page ("contain" leaves bars beside it). */
function shown(img: HTMLImageElement): Box & { left: number; top: number; width: number; height: number } {
  const r = img.getBoundingClientRect();
  const fill = getComputedStyle(img).objectFit === "fill";
  const k = fill ? 1 : Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
  const width = fill ? r.width : img.naturalWidth * k;
  const height = fill ? r.height : img.naturalHeight * k;
  const left = r.left + (r.width - width) / 2;
  const top = r.top + (r.height - height) / 2;
  return { x: left, y: top, w: width, h: height, left, top, width, height };
}

/** A PNG (base64) of a part of the picture, in the picture's own pixels. */
function crop(img: HTMLImageElement, marked: Box): { data: string; box: Box; sx: number; sy: number } {
  const r = shown(img);
  // Only the part over the picture (not the bars beside it).
  const x = Math.max(marked.x, r.x);
  const y = Math.max(marked.y, r.y);
  const box = { x, y, w: Math.max(1, Math.min(marked.x + marked.w, r.x + r.w) - x), h: Math.max(1, Math.min(marked.y + marked.h, r.y + r.h) - y) };
  const sx = img.naturalWidth / r.width;
  const sy = img.naturalHeight / r.height;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(box.w * sx));
  c.height = Math.max(1, Math.round(box.h * sy));
  c.getContext("2d")!.drawImage(img, (box.x - r.left) * sx, (box.y - r.top) * sy, c.width, c.height, 0, 0, c.width, c.height);
  return { data: c.toDataURL("image/png").split(",")[1]!, box, sx, sy };
}

/**
 * The screen lens (#/lens/<id>, design ScreenLens): the frozen screen (from the key, in its own window over the whole
 * screen) or a picture she chose (#/lens, on the phone too); drag to mark a part, then ask, search, translate,
 * summarize or copy its text; the answer shows beside it, with "continue in chat". Esc closes.
 */
export function LensPage({ id }: { id?: string }) {
  const overlay = /[?&]overlay=1/.test(location.hash);
  // From the browser extension: the part she marked on the page is the whole picture.
  const all = /[?&]all=1/.test(location.hash);
  const [shot, setShot] = useState(id);
  const [box, setBox] = useState<Box | null>(null);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState<Action | "">("");
  const [result, setResult] = useState<{ action: Action; text: string } | null>(null);
  // A translation drawn over the picture, line by line (Windows' OCR found where each line is).
  const [over, setOver] = useState<Array<{ t: string; left: number; top: number; width: number; height: number }>>([]);
  const [question, setQuestion] = useState("");
  const img = useRef<HTMLImageElement>(null);
  const he = getLocale() === "he";
  const close = () => {
    if (overlay) void desktop()?.lens?.("close");
    else history.back();
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && (box ? (setBox(null), setResult(null)) : close());
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  });
  const pick = async (f: File) => {
    // Any picture becomes a PNG (the lens works on PNG parts).
    const url = URL.createObjectURL(f);
    const im = new Image();
    im.src = url;
    await im.decode();
    const c = document.createElement("canvas");
    const scale = Math.min(1, 2560 / Math.max(im.naturalWidth, im.naturalHeight));
    c.width = Math.round(im.naturalWidth * scale);
    c.height = Math.round(im.naturalHeight * scale);
    c.getContext("2d")!.drawImage(im, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    try {
      const r = await api<{ id: string }>("/api/lens/shot", { method: "POST", body: { data: c.toDataURL("image/png").split(",")[1] } });
      setShot(r.id);
      setBox(null);
      setResult(null);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const part = () => (img.current && box ? crop(img.current, box).data : "");
  const act = async (action: Action) => {
    if (!img.current || !box) return;
    const cut = crop(img.current, box);
    setBusy(action);
    setResult(null);
    setOver([]);
    try {
      const r = await api<{ text: string; ocr?: string; lines?: Array<{ t: string; x: number; y: number; w: number; h: number }> }>("/api/lens/act", { method: "POST", body: { image: cut.data, action, question, he } });
      // Windows has no Hebrew text recognition yet: the model read it (slower); say once how to add it.
      const tipped = () => { try { const v = sessionStorage.getItem("lens-ocr-tip"); sessionStorage.setItem("lens-ocr-tip", "1"); return !!v; } catch { return false; } };
      if (r.ocr === "no-language" && !tipped()) {
        toast(L("לזיהוי טקסט מהיר בעברית: הגדרות Windows ← זמן ושפה ← שפה ← עברית ← אפשרויות ← זיהוי תווים אופטי (OCR) ← הורדה.", "For fast Hebrew text recognition: Windows Settings → Time & language → Language → Hebrew → Options → Optical character recognition → Download."));
      }
      setResult({ action, text: r.text });
      if (r.lines?.length) setOver(r.lines.map((l) => ({ t: l.t, left: cut.box.x + l.x / cut.sx, top: cut.box.y + l.y / cut.sy, width: l.w / cut.sx, height: l.h / cut.sy })));
      if (action === "text") void navigator.clipboard.writeText(r.text).then(() => toast(L("הטקסט הועתק", "Text copied")), () => undefined);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const toChat = async () => {
    const image = part();
    if (!image) return;
    setBusy("ask");
    try {
      const r = await api<{ id: string }>("/api/lens/chat", { method: "POST", body: { image, action: result?.action ?? "ask", question, he } });
      if (overlay) void desktop()?.lens?.("open", `#/c/${r.id}`);
      else location.hash = `#/c/${r.id}`;
    } catch (e) {
      toast((e as Error).message);
      setBusy("");
    }
  };
  if (!shot)
    return (
      <main className="page lens-pick">
        <h1>🔍 {L("עדשה", "Lens")}</h1>
        <p className="muted">{L("בוחרים צילום מסך או תמונה, מסמנים חלק, ושואלים, מחפשים, מתרגמים או מסכמים. במחשב: Ctrl+Alt+L מכל מקום.", "Choose a screenshot or a picture, mark a part, then ask, search, translate or summarize. On the computer: Ctrl+Alt+L from anywhere.")}</p>
        <label className="button primary">{L("בחירת תמונה", "Choose a picture")}<input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void pick(f); }} /></label>
      </main>
    );
  const down = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(".lens-bar, .lens-card")) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ x: e.clientX, y: e.clientY });
    setOver([]);
    setBox({ x: e.clientX, y: e.clientY, w: 0, h: 0 });
    setResult(null);
  };
  const moveTo = (e: React.PointerEvent) => drag && setBox({ x: Math.min(drag.x, e.clientX), y: Math.min(drag.y, e.clientY), w: Math.abs(e.clientX - drag.x), h: Math.abs(e.clientY - drag.y) });
  const up = () => {
    setDrag(null);
    // A tap (no drag) marks the whole picture.
    if (box && (box.w < 8 || box.h < 8) && img.current) {
      const r = shown(img.current);
      setBox({ x: r.x, y: r.y, w: r.w, h: r.h });
    }
  };
  const below = box ? Math.min(box.y + box.h + 8, innerHeight - 220) : 0;
  const left = box ? Math.max(8, Math.min(box.x, innerWidth - 420)) : 0;
  return (
    <div className={`lens${overlay ? " overlay" : ""}`} onPointerDown={down} onPointerMove={moveTo} onPointerUp={up}>
      <img ref={img} src={withToken(`/api/lens/shot/${shot}`)} alt="" draggable={false} onLoad={() => { if (all && img.current) { const r = shown(img.current); setBox({ x: r.x, y: r.y, w: r.w, h: r.h }); } }} onError={() => { toast(L("התמונה כבר לא שמורה. לחצי שוב על המקש.", "The picture is gone. Press the key again.")); setShot(undefined); }} />
      {box && <div className="lens-box" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} />}
      {over.map((o, i) => <div key={i} className="lens-over" dir="auto" style={{ left: o.left, top: o.top, minWidth: o.width, height: Math.max(14, o.height), fontSize: Math.max(10, Math.min(28, o.height * 0.8)) }}>{o.t}</div>)}
      {!box && <div className="lens-hint chip">{L("גוררים כדי לסמן · נגיעה = כל התמונה · Esc לסגירה", "Drag to mark · a tap = the whole picture · Esc to close")}</div>}
      <button type="button" className="lens-close ghost" onClick={close} aria-label={L("סגירה", "Close")}>✕</button>
      {box && !drag && box.w >= 8 && (
        <div className="lens-bar" style={{ left, top: below }} dir={he ? "rtl" : "ltr"}>
          <input dir="auto" value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void act("ask")} placeholder={L("שאלה על החלק המסומן (לא חובה)", "A question about it (optional)")} aria-label={L("שאלה", "Question")} />
          <div className="row">
            {ACTIONS.map(([a, icon, h, en]) => <button key={a} type="button" className={a === "ask" ? "primary small" : "small"} disabled={!!busy} onClick={() => void act(a)}>{busy === a ? "…" : icon} {L(h, en)}</button>)}
          </div>
          {result && (
            <div className="lens-card card" aria-live="polite">
              <div className="lens-text" dir="auto">{result.text}</div>
              <div className="row">
                <button type="button" className="small" onClick={() => void navigator.clipboard.writeText(result.text).then(() => toast(L("הועתק", "Copied")))}>{L("להעתיק", "Copy")}</button>
                <button type="button" className="small" disabled={!!busy} onClick={() => void toChat()}>{L("להמשיך בצ'אט", "Continue in chat")} ›</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
