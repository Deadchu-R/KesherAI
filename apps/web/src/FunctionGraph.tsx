import { useEffect, useMemo, useRef, useState, type ReactElement, type PointerEvent as RPointerEvent } from "react";
import type { GraphSpec } from "@kesher/shared";
import { getLocale, he$ } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

const COLORS = ["#a5b4ff", "#f0a830", "#7fd8a8", "#ff7a7a", "#c792ea", "#5fd3f3", "#e6c36a", "#f49ac1"];

/** A tidy grid step (1, 2 or 5 × 10ⁿ) for a span. */
function step(span: number): number {
  const raw = span / 8;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}
const label = (v: number) => String(Math.abs(v) < 1e-9 ? 0 : +v.toPrecision(4));

/** Guesses a y range from the curves over the x range (the middle 90% of values), when the block gives none. */
function autoY(spec: GraphSpec, vars: Record<string, number>, x: [number, number]): [number, number] {
  const ys: number[] = [];
  for (const { f } of spec.fns) for (let i = 0; i <= 200; i++) {
    const y = f(x[0] + ((x[1] - x[0]) * i) / 200, vars);
    if (Number.isFinite(y)) ys.push(y);
  }
  if (!ys.length) return [-10, 10];
  ys.sort((a, b) => a - b);
  let lo = ys[Math.floor(ys.length * 0.05)]!;
  let hi = ys[Math.ceil(ys.length * 0.95) - 1]!;
  if (hi - lo < 1e-6) [lo, hi] = [lo - 1, hi + 1];
  const pad = (hi - lo) * 0.15;
  return [lo - pad, hi + pad];
}

/**
 * A ```graph block drawn (design "FunctionGraph"): its functions in colour, sliders for its parameters, drag to move,
 * wheel or pinch to zoom, tap to read a value, ⟲ to go back.
 */
export function FunctionGraph({ spec }: { spec: GraphSpec }) {
  const [vars, setVars] = useState<Record<string, number>>(() => Object.fromEntries(spec.params.map((p) => [p.name, p.value])));
  const start = useMemo(() => ({ x: spec.x, y: spec.y ?? autoY(spec, Object.fromEntries(spec.params.map((p) => [p.name, p.value])), spec.x) }), [spec]);
  const [view, setView] = useState(start);
  const [probe, setProbe] = useState<{ i: number; x: number } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  // Drawn in screen pixels, so the numbers stay readable on a phone.
  const [W, setW] = useState(640);
  const H = Math.round(Math.max(220, Math.min(420, W * 0.6)));
  useEffect(() => {
    const el = svg.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => e && e.contentRect.width > 0 && setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const moved = useRef(false);

  const sx = (x: number) => ((x - view.x[0]) / (view.x[1] - view.x[0])) * W;
  const sy = (y: number) => H - ((y - view.y[0]) / (view.y[1] - view.y[0])) * H;
  const toLocal = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const zoom = (k: number, at: { x: number; y: number }) => {
    const cx = view.x[0] + (at.x / W) * (view.x[1] - view.x[0]);
    const cy = view.y[0] + ((H - at.y) / H) * (view.y[1] - view.y[0]);
    setView({ x: [cx + (view.x[0] - cx) * k, cx + (view.x[1] - cx) * k], y: [cy + (view.y[0] - cy) * k, cy + (view.y[1] - cy) * k] });
  };

  const paths = useMemo(() => spec.fns.map(({ f }) => {
    let d = "";
    let pen = false;
    let lastY = 0;
    const N = W * 1.5;
    const span = view.y[1] - view.y[0];
    for (let i = 0; i <= N; i++) {
      const x = view.x[0] + ((view.x[1] - view.x[0]) * i) / N;
      const y = f(x, vars);
      // Lift the pen where it is undefined, or at a jump through the whole view (an asymptote like tan or 1/x).
      if (!Number.isFinite(y) || (pen && Math.abs(y - lastY) > span * 2)) {
        pen = false;
        if (!Number.isFinite(y)) continue;
      }
      const py = Math.max(-H, Math.min(2 * H, sy(y)));
      d += `${pen ? "L" : "M"}${((i / N) * W).toFixed(1)},${py.toFixed(1)}`;
      pen = true;
      lastY = y;
    }
    return d;
  }), [spec, vars, view, W, H]);

  const gx = step(view.x[1] - view.x[0]);
  const gy = step(view.y[1] - view.y[0]);
  const lines: ReactElement[] = [];
  for (let v = Math.ceil(view.x[0] / gx) * gx; v <= view.x[1]; v += gx) {
    lines.push(<line key={`x${v}`} x1={sx(v)} x2={sx(v)} y1={0} y2={H} className="fg-grid" />);
    if (Math.abs(v) > gx / 2) lines.push(<text key={`tx${v}`} x={sx(v)} y={Math.min(H - 4, Math.max(12, sy(0) + 14))} className="fg-tick" textAnchor="middle">{label(v)}</text>);
  }
  for (let v = Math.ceil(view.y[0] / gy) * gy; v <= view.y[1]; v += gy) {
    lines.push(<line key={`y${v}`} y1={sy(v)} y2={sy(v)} x1={0} x2={W} className="fg-grid" />);
    if (Math.abs(v) > gy / 2) lines.push(<text key={`ty${v}`} y={sy(v) + 4} x={Math.min(W - 4, Math.max(4, sx(0) + 5))} className="fg-tick" textAnchor="start">{label(v)}</text>);
  }

  const down = (e: RPointerEvent<SVGSVGElement>) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, toLocal(e));
    moved.current = false;
  };
  const move = (e: RPointerEvent<SVGSVGElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const now = toLocal(e);
    const all = [...pointers.current.entries()];
    if (all.length === 2) {
      // Pinch: zoom by how the distance between the two fingers changed.
      const other = all.find(([id]) => id !== e.pointerId)![1];
      const before = Math.hypot(prev.x - other.x, prev.y - other.y);
      const after = Math.hypot(now.x - other.x, now.y - other.y);
      if (before > 4 && after > 4) zoom(before / after, { x: (now.x + other.x) / 2, y: (now.y + other.y) / 2 });
    } else {
      const dx = ((now.x - prev.x) / W) * (view.x[1] - view.x[0]);
      const dy = ((now.y - prev.y) / H) * (view.y[1] - view.y[0]);
      if (Math.abs(now.x - prev.x) + Math.abs(now.y - prev.y) > 1) moved.current = true;
      setView({ x: [view.x[0] - dx, view.x[1] - dx], y: [view.y[0] + dy, view.y[1] + dy] });
    }
    pointers.current.set(e.pointerId, now);
  };
  const up = (e: RPointerEvent<SVGSVGElement>) => {
    const at = pointers.current.get(e.pointerId);
    pointers.current.delete(e.pointerId);
    if (moved.current || !at) return;
    // A tap: the curve nearest the tap, at that x.
    const x = view.x[0] + (at.x / W) * (view.x[1] - view.x[0]);
    let best: { i: number; d: number } | null = null;
    spec.fns.forEach(({ f }, i) => {
      const y = f(x, vars);
      if (!Number.isFinite(y)) return;
      const d = Math.abs(sy(y) - at.y);
      if (!best || d < best.d) best = { i, d };
    });
    const b = best as { i: number; d: number } | null;
    setProbe(b && b.d < 40 ? { i: b.i, x } : null);
  };
  // The wheel zooms the graph, not the page: React's wheel listener is passive, so a native one.
  const zoomRef = useRef((_k: number, _e: WheelEvent) => {});
  zoomRef.current = (k, e) => zoom(k, toLocal(e));
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomRef.current(e.deltaY > 0 ? 1.15 : 1 / 1.15, e);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  const py = probe ? spec.fns[probe.i]?.f(probe.x, vars) : undefined;
  return (
    <figure className="fgraph" dir="ltr">
      <div className="fgraph-legend">
        {spec.fns.map((f, i) => <span key={i} className="fgraph-fn" style={{ borderColor: COLORS[i % COLORS.length], color: COLORS[i % COLORS.length] }}>{f.src}</span>)}
        <button type="button" className="fgraph-reset" title={L("חזרה לתצוגה המקורית", "Back to the first view")} onClick={() => { setView(start); setProbe(null); }}>⟲</button>
      </div>
      <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className="fgraph-svg" style={{ height: H }} role="img" aria-label={spec.fns.map((f) => f.src).join(", ")}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={(e) => pointers.current.delete(e.pointerId)}>
        {lines}
        <line x1={0} x2={W} y1={sy(0)} y2={sy(0)} className="fg-axis" />
        <line y1={0} y2={H} x1={sx(0)} x2={sx(0)} className="fg-axis" />
        {paths.map((d, i) => <path key={i} d={d} fill="none" stroke={COLORS[i % COLORS.length]} strokeWidth={2.5} strokeLinejoin="round" />)}
        {probe && py !== undefined && Number.isFinite(py) && (
          <g>
            <circle cx={sx(probe.x)} cy={sy(py)} r={5} fill={COLORS[probe.i % COLORS.length]} />
            <rect x={Math.min(W - 128, sx(probe.x) + 8)} y={Math.max(2, sy(py) - 32)} width={120} height={24} rx={6} className="fg-probe" stroke={COLORS[probe.i % COLORS.length]} />
            <text x={Math.min(W - 128, sx(probe.x) + 8) + 60} y={Math.max(2, sy(py) - 32) + 16} textAnchor="middle" className="fg-probe-text">x={label(probe.x)}, y={label(py)}</text>
          </g>
        )}
      </svg>
      {spec.params.length > 0 && (
        <div className="fgraph-params">
          {spec.params.map((p) => (
            <label key={p.name}>
              <b>{p.name}</b>
              <input type="range" min={p.min} max={p.max} step={(p.max - p.min) / 200} value={vars[p.name] ?? p.value} onChange={(e) => setVars({ ...vars, [p.name]: Number(e.target.value) })} />
              <output>{label(vars[p.name] ?? p.value)}</output>
            </label>
          ))}
        </div>
      )}
      <figcaption className="muted small" dir="auto">{L("גררי להזזה · גלגלת או צביטה לזום · הקשה על קו מראה את הערך", "Drag to move · wheel or pinch to zoom · tap a line to read its value")}</figcaption>
    </figure>
  );
}
