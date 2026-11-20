import { lazy, Suspense, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { withToken } from "./api";
import { Diff } from "./ChatCards";
import { diffCounts, stepZoom, type CanvasItem } from "./chat/canvas-items";
import { PBR_ORDER } from "./chat/result-actions";
import { getLocale, he$ } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
// The lit sphere loads three.js, so only when a PBR set is open.
const PbrSphere = lazy(() => import("./PbrSphere"));

/*
 * The side canvas (design ChatCanvas): the panel beside the chat that documents use (ArtifactPanel.tsx), for heavy
 * results too, as ChatGPT's canvas and the gallery of ComfyUI frontends do it. A picture: zoom (buttons, wheel, two
 * fingers), pan, the chat's other pictures as its history, and Compare with a slider. A PBR set: each map in a grid
 * and a lit sphere wearing them. A diff: the file's versions in this chat. Pictures come from the server's asset
 * links (with the app key), so the phone connected to the PC shows the same.
 */

const asset = (id: string) => withToken(`/api/assets/${id}`);

/** Each PBR map's name. */
const MAP_NAME: Record<string, [string, string]> = {
  albedo: ["צבע בסיס", "Albedo"],
  normal: ["נורמל", "Normal"],
  roughness: ["חספוס", "Roughness"],
  smoothness: ["חלקות", "Smoothness"],
  metallic: ["מתכתיות", "Metallic"],
  ao: ["הצללה (AO)", "AO"],
  height: ["גובה", "Height"],
};

/**
 * The side canvas's content: its bar and the view for the item's kind.
 *
 * @param props.item - What to show.
 * @param props.full - Whether the panel is full screen; `onFull` switches it.
 * @param props.onClose - Closes the panel ("Back to chat" on the phone).
 */
export function CanvasPanel({ item, full, onFull, onClose }: { item: CanvasItem; full: boolean; onFull: () => void; onClose: () => void }) {
  const title = item.kind === "image" ? L("תמונה", "Picture") : item.kind === "pbr" ? `${item.title} · PBR` : item.title;
  return (
    <>
      <div className="artifact-bar">
        <button type="button" className="ghost artifact-back" onClick={onClose}>‹ {L("חזרה לצ'אט", "Back to chat")}</button>
        <strong className="grow" dir="auto">{title}</strong>
        <button type="button" className="ghost" title={L("מסך מלא", "Full screen")} aria-label={L("מסך מלא", "Full screen")} aria-pressed={full} onClick={onFull}>⛶</button>
        <button type="button" className="ghost artifact-close" title={L("סגור", "Close")} aria-label={L("סגור", "Close")} onClick={onClose}>✕</button>
      </div>
      {item.kind === "image" ? <ImageCanvas key={item.assetId} item={item} /> : item.kind === "pbr" ? <PbrCanvas item={item} /> : <DiffCanvas key={item.title} item={item} />}
    </>
  );
}

/** A picture to zoom, pan and compare, with the chat's pictures as its history. */
function ImageCanvas({ item }: { item: Extract<CanvasItem, { kind: "image" }> }) {
  const [id, setId] = useState(item.assetId);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [other, setOther] = useState<string | null>(null);
  const [split, setSplit] = useState(50);
  const stage = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef(0);
  const at = item.history.indexOf(id);
  const fit = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };
  // The wheel zooms (not the page): a passive listener cannot stop the page from scrolling.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((z) => stepZoom(z, e.deltaY < 0 ? 1 : -1));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const was = pointers.current.get(e.pointerId);
    if (!was) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const all = [...pointers.current.values()];
    if (all.length === 2) {
      // Two fingers: the change in their distance zooms.
      const d = Math.hypot(all[0]!.x - all[1]!.x, all[0]!.y - all[1]!.y);
      if (pinch.current) setZoom((z) => Math.min(16, Math.max(0.1, z * (d / pinch.current))));
      pinch.current = d;
      return;
    }
    setPan((p) => ({ x: p.x + e.clientX - was.x, y: p.y + e.clientY - was.y }));
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    pinch.current = 0;
  };
  const show = (next: string) => {
    setId(next);
    if (other === next) setOther(null);
  };
  const transform = { transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` };
  return (
    <div className="canvas-image">
      <div className="canvas-tools row wrap">
        <button type="button" className="ghost" aria-label={L("הקטנה", "Zoom out")} title={L("הקטנה", "Zoom out")} onClick={() => setZoom((z) => stepZoom(z, -1))}>−</button>
        <span className="small muted canvas-zoom" aria-live="polite">{Math.round(zoom * 100)}%</span>
        <button type="button" className="ghost" aria-label={L("הגדלה", "Zoom in")} title={L("הגדלה", "Zoom in")} onClick={() => setZoom((z) => stepZoom(z, 1))}>+</button>
        <button type="button" className="ghost small" onClick={fit}>{L("התאמה", "Fit")}</button>
        <button type="button" className="ghost small" onClick={() => setZoom(1 / Math.max(1, devicePixelRatio))}>1:1</button>
        <span className="grow" />
        {item.history.length > 1 && (
          <button type="button" className={`chip-text${other ? " on" : ""}`} aria-pressed={!!other} onClick={() => setOther(other ? null : item.history[at > 0 ? at - 1 : 1] ?? null)}>
            ⇆ {L("השוואה", "Compare")}
          </button>
        )}
        <a className="chip-text" href={asset(id)} download={`kesher-image-${id.slice(0, 8)}.png`}>⤓ {L("הורדה", "Download")}</a>
      </div>
      <div ref={stage} className="canvas-stage" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onDoubleClick={fit}>
        <img src={asset(id)} alt={L("התמונה", "The picture")} style={transform} draggable={false} />
        {other && <img className="canvas-over" src={asset(other)} alt={L("התמונה להשוואה", "The picture to compare")} style={{ ...transform, clipPath: `inset(0 0 0 ${split}%)` }} draggable={false} />}
      </div>
      {other && (
        <label className="canvas-split small">
          <span>{L("השוואה: גרירה מזיזה את הקו", "Compare: drag to move the line")}</span>
          <input type="range" dir="ltr" min={0} max={100} value={split} onChange={(e) => setSplit(Number(e.target.value))} aria-label={L("מיקום קו ההשוואה", "Where the compare line is")} />
        </label>
      )}
      {item.history.length > 1 && (
        <div className="canvas-history" role="list" aria-label={L("היסטוריית התמונות בצ'אט", "Pictures in this chat")}>
          {item.history.map((h, i) => (
            <button
              key={h}
              type="button"
              role="listitem"
              className={`canvas-thumb${h === id ? " on" : ""}${h === other ? " other" : ""}`}
              aria-label={L(`תמונה ${i + 1}`, `Picture ${i + 1}`)}
              aria-current={h === id}
              onClick={() => (other ? (h === id ? undefined : setOther(h)) : show(h))}
            >
              <img src={asset(h)} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {other && <p className="muted small canvas-hint">{L("במצב השוואה, לחיצה על תמונה בהיסטוריה בוחרת את השנייה.", "While comparing, a picture in the history picks the second one.")}</p>}
    </div>
  );
}

/** A PBR map set: each map in a grid, and a lit sphere wearing them. */
function PbrCanvas({ item }: { item: Extract<CanvasItem, { kind: "pbr" }> }) {
  const maps = PBR_ORDER.filter((k) => item.maps[k]);
  return (
    <div className="canvas-pbr">
      <Suspense fallback={<p className="muted small">…</p>}><PbrSphere maps={item.maps} /></Suspense>
      <div className="pbr-grid">
        {maps.map((k) => (
          <figure key={k}>
            <a href={asset(item.maps[k]!)} target="_blank" rel="noreferrer"><img src={asset(item.maps[k]!)} alt={L(MAP_NAME[k]![0], MAP_NAME[k]![1])} loading="lazy" /></a>
            <figcaption className="small">{L(MAP_NAME[k]![0], MAP_NAME[k]![1])}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

/** A code diff, with the file's other diffs in this chat as versions. */
function DiffCanvas({ item }: { item: Extract<CanvasItem, { kind: "diff" }> }) {
  const [at, setAt] = useState(item.current);
  const diff = item.versions[at] ?? "";
  const { added, removed } = diffCounts(diff);
  return (
    <div className="canvas-diff">
      <div className="canvas-tools row wrap">
        {item.versions.length > 1 && (
          <select value={at} onChange={(e) => setAt(Number(e.target.value))} aria-label={L("גרסה", "Version")}>
            {item.versions.map((_, i) => <option key={i} value={i}>{L(`שינוי ${i + 1} מתוך ${item.versions.length}`, `Change ${i + 1} of ${item.versions.length}`)}</option>)}
          </select>
        )}
        <span className="small"><span className="diff-add">+{added}</span> <span className="diff-del">−{removed}</span></span>
        <span className="grow" />
        <button type="button" className="chip-text" onClick={() => void navigator.clipboard?.writeText(diff)}>⧉ {L("העתקה", "Copy")}</button>
      </div>
      <div className="canvas-diff-body"><Diff diff={diff} /></div>
    </div>
  );
}
