import { useState } from "react";
import { getLocale, he$ } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

interface Rect { x: number; y: number; w: number; h: number }

/**
 * The whole graph in small, in a corner of a graph editor (like Unity's and ComfyUI's minimap): nodes as dots, groups
 * as frames, and the part on screen as a box. Click or drag in it to go there (a finger too). It can be folded away
 * (remembered); on a phone it starts folded so it never covers the graph.
 *
 * @param props.boxes - The nodes where they are drawn (canvas units).
 * @param props.notes - Groups / comment boxes.
 * @param props.bounds - The graph's extent.
 * @param props.view - The canvas's pan and zoom.
 * @param props.frame - The canvas's element (its size).
 * @param props.onPan - Moves the view (the new x, y offsets).
 */
export function Minimap({ boxes, notes, bounds, view, frame, onPan }: { boxes: Rect[]; notes: Rect[]; bounds: Rect; view: { k: number; x: number; y: number }; frame: HTMLElement | null; onPan: (x: number, y: number) => void }) {
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem("kesher-graph-minimap");
      return v ? v === "1" : window.innerWidth > 600;
    } catch {
      return true;
    }
  });
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem("kesher-graph-minimap", open ? "0" : "1");
    } catch {
      /* this page only */
    }
  };
  const W = 160;
  const H = 110;
  const fw = frame?.clientWidth ?? 0;
  const fh = frame?.clientHeight ?? 0;
  // The screen's part of the graph, in canvas units.
  const seen = { x: -view.x / view.k, y: -view.y / view.k, w: fw / view.k, h: fh / view.k };
  const all = { x: Math.min(bounds.x, seen.x), y: Math.min(bounds.y, seen.y), w: 0, h: 0 };
  all.w = Math.max(bounds.x + bounds.w, seen.x + seen.w) - all.x;
  all.h = Math.max(bounds.y + bounds.h, seen.y + seen.h) - all.y;
  const s = Math.min(W / Math.max(1, all.w), H / Math.max(1, all.h));
  const to = (r: Rect) => ({ x: (r.x - all.x) * s, y: (r.y - all.y) * s, width: Math.max(2, r.w * s), height: Math.max(2, r.h * s) });
  const go = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const wx = (e.clientX - r.left) / s + all.x;
    const wy = (e.clientY - r.top) / s + all.y;
    onPan(fw / 2 - wx * view.k, fh / 2 - wy * view.k);
  };
  if (!open) {
    return (
      <button type="button" className="bp-minimap-toggle" onPointerDown={(e) => e.stopPropagation()} onClick={toggle} aria-label={L("הצג מפה קטנה", "Show minimap")} title={L("מפה קטנה", "Minimap")}>
        ▣
      </button>
    );
  }
  return (
    <div className="bp-minimap" onPointerDown={(e) => e.stopPropagation()}>
      <svg
        width={W}
        height={H}
        role="img"
        aria-label={L("מפה קטנה של הגרף: לחצו כדי לעבור", "Graph minimap: tap to go there")}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          go(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons) go(e);
        }}
      >
        {notes.map((n, i) => <rect key={`n${i}`} {...to(n)} className="bp-minimap-note" />)}
        {boxes.map((b, i) => <rect key={i} {...to(b)} className="bp-minimap-node" />)}
        {fw > 0 && <rect {...to(seen)} className="bp-minimap-view" />}
      </svg>
      <button type="button" className="icon-btn" onClick={toggle} aria-label={L("הסתר מפה קטנה", "Hide minimap")}>✕</button>
    </div>
  );
}
