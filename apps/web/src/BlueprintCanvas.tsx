import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

export interface Pin { name: string; label?: string; dir: "in" | "out"; type: string; default?: string; links?: string[] }
export interface GNode { id: string; title: string; class: string; x: number; y: number; comment?: string; pins: Pin[] }
interface Action { title: string; category: string; type: string; function?: string; event?: string; variable?: string; name?: string }
type Op = Record<string, unknown>;

/** Pin colors as in Unreal, so the picture reads the same. */
export function pinColor(type: string): string {
  const t = type.split(":")[0]!.toLowerCase();
  return (
    { exec: "#f2f2f2", bool: "#9b1c1c", boolean: "#9b1c1c", single: "#9ee35a", int32: "#2ad3ba", vector3: "#f2c94c", vector2: "#f2c94c", gameobject: "#2d8bf0", transform: "#2d8bf0", real: "#9ee35a", float: "#9ee35a", double: "#9ee35a", int: "#2ad3ba", int64: "#2ad3ba", byte: "#0b6e5e", string: "#e93fe1", name: "#b38cf0", text: "#e8839b", object: "#2d8bf0", class: "#5d00c9", struct: "#1355b8", interface: "#f0f0a8", softobject: "#9edcff" } as Record<string, string>
  )[t] ?? "#9aa0a6";
}

const W = 230;
const HEAD = 26;
const ROW = 19;
/** Unreal units → picture units. */
const SCALE = 0.7;

interface Box { n: GNode; x: number; y: number; h: number; ins: Pin[]; outs: Pin[] }
type Drag =
  | { kind: "pan"; sx: number; sy: number; moved: boolean; right: boolean }
  | { kind: "move"; sx: number; sy: number; moved: boolean }
  | { kind: "marquee"; sx: number; sy: number; ex: number; ey: number; add: boolean }
  | { kind: "wire"; node: string; pin: string; dir: "in" | "out"; type: string; ax: number; ay: number; ex: number; ey: number };
interface Menu { left: number; top: number; wx: number; wy: number; from?: { node: string; pin: string; dir: "in" | "out"; type: string } }

/**
 * The Blueprint editor in the page, working like Unreal's graph editor
 * (researched first: Unreal's Blueprint editor and React Flow):
 * - right-drag pans; right-click (long-press on a phone) opens "All Actions"
 *   with a search, and the chosen node goes where you clicked;
 * - left-drag a node moves it (all selected ones); left-drag on empty space
 *   draws a selection box (Ctrl/Shift adds); one finger on a phone pans;
 * - drag from a pin to another pin connects them; drag to empty space opens
 *   the menu and connects the new node; Alt+click a pin breaks its links;
 * - wheel or pinch zooms; Home fits the graph; Delete removes the selected
 *   nodes; Ctrl+Z / Ctrl+Y undo and redo in the editor itself; Ctrl+F
 *   searches the nodes (Enter: next);
 * Each change goes to the editor at once (one undo step there).
 * Without `editable` (Unity, or the editor closed) it only looks: pan, zoom, search.
 */
export function BlueprintCanvas({ nodes, path, graph, editable, unity = false, onChanged, flash, onSelect }: { nodes: GNode[]; path: string; graph: string; editable: boolean; unity?: boolean; onChanged: () => void; flash?: { id: string; n: number }; onSelect?: (ids: Set<string>) => void }) {
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({});
  useEffect(() => setMoved({}), [nodes]);
  const layout = useMemo(() => {
    if (!nodes.length) return null;
    const boxes: Box[] = nodes.map((n) => {
      const ins = n.pins.filter((p) => p.dir === "in");
      const outs = n.pins.filter((p) => p.dir === "out");
      return { n, x: n.x * SCALE, y: n.y * SCALE, h: HEAD + Math.max(ins.length, outs.length, 1) * ROW + 8, ins, outs };
    });
    // Nodes on top of each other move right until clear, so every node and pin can be read.
    const hit = (a: Box, b: Box) => a.x < b.x + W + 12 && b.x < a.x + W + 12 && a.y < b.y + b.h + 12 && b.y < a.y + a.h + 12;
    for (let i = 1; i < boxes.length; i++) {
      for (let guard = 0; guard < 50; guard++) {
        const other = boxes.slice(0, i).find((b) => hit(b, boxes[i]!));
        if (!other) break;
        boxes[i]!.x = other.x + W + 40;
      }
    }
    return boxes;
  }, [nodes]);
  const boxes = useMemo(() => (layout ?? []).map((b) => (moved[b.n.id] ? { ...b, ...moved[b.n.id] } : b)), [layout, moved]);
  const pinAt = useMemo(() => {
    const at = new Map<string, { x: number; y: number }>();
    for (const b of boxes) {
      b.ins.forEach((p, i) => at.set(`${b.n.id}:${p.name}`, { x: b.x, y: b.y + HEAD + i * ROW + ROW / 2 }));
      b.outs.forEach((p, i) => at.set(`${b.n.id}:${p.name}`, { x: b.x + W, y: b.y + HEAD + i * ROW + ROW / 2 }));
    }
    return at;
  }, [boxes]);
  const bounds = useMemo(() => {
    if (!boxes.length) return { x: 0, y: 0, w: 1, h: 1 };
    const x = Math.min(...boxes.map((b) => b.x)) - 30;
    const y = Math.min(...boxes.map((b) => b.y)) - 30;
    return { x, y, w: Math.max(...boxes.map((b) => b.x + W)) + 30 - x, h: Math.max(...boxes.map((b) => b.y + b.h)) + 30 - y };
  }, [boxes]);

  const frame = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<Drag | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [find, setFind] = useState<{ q: string; i: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [flashing, setFlashing] = useState<string | undefined>();
  useEffect(() => onSelect?.(selected), [selected]);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; k: number } | null>(null);
  const press = useRef<number | undefined>(undefined);

  const fit = () => {
    const el = frame.current;
    if (!el || !layout) return;
    const r = el.getBoundingClientRect();
    const k = Math.min(1.5, Math.max(0.15, Math.min(r.width / bounds.w, r.height / bounds.h)));
    setView({ k, x: (r.width - bounds.w * k) / 2 - bounds.x * k, y: (r.height - bounds.h * k) / 2 - bounds.y * k });
  };
  useEffect(fit, [layout]);
  const zoomAt = (factor: number, cx?: number, cy?: number) =>
    setView((v) => {
      const r = frame.current?.getBoundingClientRect();
      const px = cx ?? (r ? r.width / 2 : 0);
      const py = cy ?? (r ? r.height / 2 : 0);
      const k = Math.min(3, Math.max(0.1, v.k * factor));
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
    });
  const center = (b: Box) => {
    const r = frame.current?.getBoundingClientRect();
    if (!r) return;
    setView((v) => ({ ...v, x: r.width / 2 - (b.x + W / 2) * v.k, y: r.height / 2 - (b.y + b.h / 2) * v.k }));
  };
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [layout]);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = frame.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const world = (p: { x: number; y: number }) => ({ x: (p.x - view.x) / view.k, y: (p.y - view.y) / view.k });

  /** Sends operations to the editor (one undo step there) and reads the graph again. */
  const apply = async (ops: Op[]): Promise<Array<{ ok: boolean; error?: string; node?: string }>> => {
    setBusy(true);
    try {
      const r = await api<{ results: Array<{ ok: boolean; error?: string; node?: string }>; failed: number }>("/api/unreal/apply", { method: "POST", body: { path, graph, ops } });
      r.results.filter((x) => !x.ok).forEach((x) => toast(`⚠ ${x.error ?? ""}`));
      onChanged();
      return r.results;
    } catch (e) {
      toast((e as Error).message);
      return [];
    } finally {
      setBusy(false);
    }
  };
  const undo = (redo: boolean) => void api(`/api/unreal/${redo ? "redo" : "undo"}`, { method: "POST" }).then(onChanged, (e: Error) => toast(e.message));

  const openMenu = (p: { x: number; y: number }, from?: Menu["from"]) => {
    if (!editable) return;
    const r = frame.current!.getBoundingClientRect();
    const w = world(p);
    setMenu({ left: Math.min(p.x, Math.max(0, r.width - 300)), top: Math.min(p.y, Math.max(0, r.height - 330)), wx: w.x, wy: w.y, ...(from ? { from } : {}) });
  };

  const down = (e: React.PointerEvent) => {
    if (menu && !(e.target as Element).closest(".bp-menu")) setMenu(null);
    if ((e.target as Element).closest(".bp-menu, .ue-zoom, .bp-find")) return;
    frame.current?.focus();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { d: Math.hypot(a!.x - b!.x, a!.y - b!.y), k: view.k };
      clearTimeout(press.current);
      setDrag(null);
      return;
    }
    const el = e.target as Element;
    const pinEl = el.closest("[data-pin]") as HTMLElement | SVGElement | null;
    const nodeEl = el.closest("[data-node]") as HTMLElement | SVGElement | null;
    const touch = e.pointerType === "touch";
    // Long-press on a phone = right-click.
    if (touch && editable) {
      const at = p;
      press.current = window.setTimeout(() => {
        setDrag(null);
        openMenu(at);
      }, 550);
    }
    if (e.button === 2) return setDrag({ kind: "pan", sx: p.x, sy: p.y, moved: false, right: true });
    if (pinEl && editable) {
      const d = pinEl.dataset;
      if (e.altKey) {
        void apply([{ op: "disconnect", node: d.node, pin: d.pin }]);
        return;
      }
      const a = pinAt.get(`${d.node}:${d.pin}`)!;
      return setDrag({ kind: "wire", node: d.node!, pin: d.pin!, dir: d.dir as "in" | "out", type: d.type!, ax: a.x, ay: a.y, ex: a.x, ey: a.y });
    }
    if (nodeEl) {
      const id = nodeEl.dataset.node!;
      if (e.ctrlKey || e.shiftKey) setSelected((s) => new Set(s.has(id) ? [...s].filter((x) => x !== id) : [...s, id]));
      else if (!selected.has(id)) setSelected(new Set([id]));
      if (editable) return setDrag({ kind: "move", sx: p.x, sy: p.y, moved: false });
      return setDrag({ kind: "pan", sx: p.x, sy: p.y, moved: false, right: false });
    }
    if (touch || !editable) return setDrag({ kind: "pan", sx: p.x, sy: p.y, moved: false, right: false });
    setDrag({ kind: "marquee", sx: p.x, sy: p.y, ex: p.x, ey: p.y, add: e.ctrlKey || e.shiftKey });
  };
  const move = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const now = local(e);
    pointers.current.set(e.pointerId, now);
    if (Math.hypot(now.x - prev.x, now.y - prev.y) > 2) clearTimeout(press.current);
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      const target = Math.min(3, Math.max(0.1, (pinch.current.k * d) / Math.max(1, pinch.current.d)));
      zoomAt(target / view.k, (a!.x + b!.x) / 2, (a!.y + b!.y) / 2);
      return;
    }
    if (!drag) return;
    if (drag.kind === "pan") {
      if (Math.hypot(now.x - drag.sx, now.y - drag.sy) > 4) drag.moved = true;
      setView((v) => ({ ...v, x: v.x + now.x - prev.x, y: v.y + now.y - prev.y }));
    } else if (drag.kind === "move") {
      drag.moved = true;
      const dx = (now.x - prev.x) / view.k;
      const dy = (now.y - prev.y) / view.k;
      setMoved((m) => {
        const out = { ...m };
        for (const b of boxes) if (selected.has(b.n.id)) out[b.n.id] = { x: b.x + dx, y: b.y + dy };
        return out;
      });
    } else if (drag.kind === "marquee") setDrag({ ...drag, ex: now.x, ey: now.y });
    else if (drag.kind === "wire") {
      const w = world(now);
      setDrag({ ...drag, ex: w.x, ey: w.y });
    }
  };
  const up = (e: React.PointerEvent) => {
    clearTimeout(press.current);
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const d = drag;
    setDrag(null);
    if (!d) return;
    const p = local(e);
    if (d.kind === "pan") {
      if (d.right && !d.moved) openMenu(p);
      else if (!d.moved && !d.right && e.pointerType !== "touch") setSelected(new Set());
    } else if (d.kind === "move" && d.moved) {
      const ops = boxes.filter((b) => selected.has(b.n.id)).map((b) => ({ op: "move", node: b.n.id, x: Math.round(b.x / SCALE), y: Math.round(b.y / SCALE) }));
      if (ops.length) void apply(ops);
    } else if (d.kind === "marquee") {
      const a = world({ x: Math.min(d.sx, d.ex), y: Math.min(d.sy, d.ey) });
      const z = world({ x: Math.max(d.sx, d.ex), y: Math.max(d.sy, d.ey) });
      const inside = boxes.filter((b) => b.x < z.x && b.x + W > a.x && b.y < z.y && b.y + b.h > a.y).map((b) => b.n.id);
      setSelected((s) => new Set(d.add ? [...s, ...inside] : inside));
    } else if (d.kind === "wire") {
      const target = (document.elementFromPoint(e.clientX, e.clientY) as Element | null)?.closest("[data-pin]") as SVGElement | null;
      if (target?.dataset.node && target.dataset.node !== d.node) {
        const t = target.dataset;
        if (t.dir === d.dir) return toast(L("חברו יציאה לכניסה.", "Connect an output to an input."));
        const from = d.dir === "out" ? { node: d.node, pin: d.pin } : { node: t.node, pin: t.pin };
        const to = d.dir === "out" ? { node: t.node, pin: t.pin } : { node: d.node, pin: d.pin };
        void apply([{ op: "connect", from, to }]);
      } else if (!target) openMenu(p, { node: d.node, pin: d.pin, dir: d.dir, type: d.type });
    }
  };

  /** Adds the chosen node where the menu opened; from a dragged pin, connects it too (like Unreal). */
  const add = async (a: Action) => {
    if (!menu) return;
    const m = menu;
    setMenu(null);
    const op: Op = { op: "add", type: a.type, ref: "$n", x: Math.round(m.wx / SCALE), y: Math.round(m.wy / SCALE) };
    if (a.function) op.function = a.function;
    if (a.event) op.event = a.event;
    if (a.variable) op.variable = a.variable;
    if (a.type === "custom_event") {
      const name = prompt(L("שם האירוע:", "Event name:"), "NewEvent");
      if (!name) return;
      op.name = name.replace(/[^\w]/g, "") || "NewEvent";
    }
    const res = await apply([op]);
    const made = res[0]?.node;
    if (!m.from || !made) return;
    // The new node's pins: read it and connect the first that fits (exec to exec, else a data pin the other way).
    try {
      const g = await api<{ graph: { graphs: Array<{ name: string; nodes: GNode[] }> } }>(`/api/unreal/graph?path=${encodeURIComponent(path)}`);
      const n = (g.graph.graphs.find((x) => x.name === graph) ?? g.graph.graphs[0])?.nodes.find((x) => x.id === made);
      const want = m.from.dir === "out" ? "in" : "out";
      const pin = n?.pins.find((p) => p.dir === want && (p.type === "exec") === (m.from!.type === "exec") && (m.from!.type === "exec" || p.type.split(":")[0] === m.from!.type.split(":")[0])) ?? n?.pins.find((p) => p.dir === want && (p.type === "exec") === (m.from!.type === "exec"));
      if (!pin) return;
      const from = m.from.dir === "out" ? { node: m.from.node, pin: m.from.pin } : { node: made, pin: pin.name };
      const to = m.from.dir === "out" ? { node: made, pin: pin.name } : { node: m.from.node, pin: m.from.pin };
      await apply([{ op: "connect", from, to }]);
    } catch {
      // the node is there; the user can connect it by hand
    }
  };

  const keys = (e: React.KeyboardEvent) => {
    if ((e.target as Element).closest("input")) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "f") {
      e.preventDefault();
      setFind({ q: "", i: 0 });
    } else if (e.key === "Home") {
      e.preventDefault();
      fit();
    } else if (e.key === "Escape") {
      setMenu(null);
      setFind(null);
      setSelected(new Set());
    } else if (!editable) return;
    else if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undo(e.shiftKey);
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      undo(true);
    } else if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelected(new Set(boxes.map((b) => b.n.id)));
    } else if ((e.key === "Delete" || e.key === "Backspace") && selected.size) {
      e.preventDefault();
      void apply([...selected].map((id) => ({ op: "delete", node: id })));
      setSelected(new Set());
    }
  };

  // A line clicked in the code view: its node blinks and comes to the middle.
  useEffect(() => {
    if (!flash) return;
    const b = boxes.find((x) => x.n.id === flash.id);
    if (!b) return;
    center(b);
    setSelected(new Set([flash.id]));
    setFlashing(flash.id);
    const t = setTimeout(() => setFlashing(undefined), 2400);
    return () => clearTimeout(t);
  }, [flash?.n]);

  const matches = find?.q.trim() ? boxes.filter((b) => `${b.n.title} ${b.n.comment ?? ""} ${b.n.pins.map((p) => `${p.label ?? p.name} ${p.default ?? ""}`).join(" ")}`.toLowerCase().includes(find.q.trim().toLowerCase())) : [];
  const current = matches.length ? matches[find!.i % matches.length] : undefined;
  useEffect(() => {
    if (current) center(current);
  }, [current?.n.id]);

  if (!layout) return <p className="muted ue-empty">{L("הגרף ריק.", "This graph is empty.")}</p>;
  const links: Array<{ d: string; color: string }> = [];
  for (const b of boxes) {
    for (const p of b.outs) {
      const a = pinAt.get(`${b.n.id}:${p.name}`)!;
      for (const l of p.links ?? []) {
        const z = pinAt.get(l);
        if (!z) continue;
        const dx = Math.max(40, Math.abs(z.x - a.x) / 2);
        links.push({ d: `M${a.x},${a.y} C${a.x + dx},${a.y} ${z.x - dx},${z.y} ${z.x},${z.y}`, color: pinColor(p.type) });
      }
    }
  }
  const pinRow = (n: GNode, p: Pin, i: number, x: number, y: number, side: "in" | "out") => {
    const cx = side === "in" ? x : x + W;
    const cy = y + HEAD + i * ROW + ROW / 2;
    return (
      <g key={`${side}${i}`}>
        <circle cx={cx} cy={cy} r={p.type === "exec" ? 4.5 : 4} fill={p.links?.length ? pinColor(p.type) : "none"} stroke={pinColor(p.type)} strokeWidth={1.6} />
        {/* A bigger, invisible target, so a finger can grab the pin too. */}
        <circle cx={cx} cy={cy} r={10} fill="transparent" data-pin={p.name} data-node={n.id} data-dir={p.dir} data-type={p.type} className={editable ? "bp-pin" : undefined} />
        <text x={side === "in" ? x + 10 : x + W - 10} y={cy + 4} textAnchor={side === "in" ? "start" : "end"} className="ue-pin">
          {p.type === "exec" && !p.label ? "" : p.label ?? p.name}
          {side === "in" && p.default !== undefined && !p.links?.length ? ` = ${p.default.length > 18 ? `${p.default.slice(0, 18)}…` : p.default}` : ""}
        </text>
      </g>
    );
  };
  const wire = drag?.kind === "wire" ? drag : undefined;
  const box = drag?.kind === "marquee" ? drag : undefined;
  return (
    <div
      className={`ue-frame${editable ? " editable" : ""}`}
      ref={frame}
      tabIndex={0}
      aria-label={unity ? L("גרף Script Graph", "Script Graph") : L("עורך Blueprint", "Blueprint editor")}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={keys}
      onDoubleClick={(e) => !(e.target as Element).closest("[data-node], .bp-menu, .ue-zoom, .bp-find") && fit()}
    >
      <svg className="ue-graph" width="100%" height="100%" role="img">
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {links.map((l, i) => <path key={i} d={l.d} stroke={l.color} strokeWidth={2} fill="none" opacity={0.85} />)}
          {wire && <path d={`M${wire.ax},${wire.ay} C${wire.ax + (wire.dir === "out" ? 60 : -60)},${wire.ay} ${wire.ex + (wire.dir === "out" ? -60 : 60)},${wire.ey} ${wire.ex},${wire.ey}`} stroke={pinColor(wire.type)} strokeWidth={2} fill="none" strokeDasharray="5 4" />}
          {boxes.map((b) => {
            const head = /Event/.test(b.n.class) ? "#7a1f1f" : /CallFunction/.test(b.n.class) ? "#1f4f7a" : /Variable/.test(b.n.class) ? "#2c5a2c" : "#3a3a44";
            const on = selected.has(b.n.id);
            const found = current?.n.id === b.n.id ? "#f2c94c" : matches.some((m) => m.n.id === b.n.id) ? "#8a7a3a" : undefined;
            return (
              <g key={b.n.id} data-node={b.n.id} className="bp-node">
                {b.n.comment && <text x={b.x} y={b.y - 6} className="ue-comment">💬 {b.n.comment.length > 40 ? `${b.n.comment.slice(0, 40)}…` : b.n.comment}</text>}
                <rect x={b.x} y={b.y} width={W} height={b.h} rx={7} fill="#1b1c20" stroke={found ?? (on ? "#f0a830" : "#000")} strokeWidth={found || on ? 2.5 : 1} opacity={0.96} />
                {flashing === b.n.id && <rect x={b.x - 5} y={b.y - 5} width={W + 10} height={b.h + 10} rx={10} fill="none" stroke="#ffd34d" strokeWidth={3} className="bp-flash" />}
                <path d={`M${b.x},${b.y + 7} a7,7 0 0 1 7,-7 h${W - 14} a7,7 0 0 1 7,7 v${HEAD - 7} h-${W} z`} fill={head} />
                <text x={b.x + 9} y={b.y + 17} className="ue-title">{b.n.title.split("\n")[0]!.slice(0, 30)}</text>
                {b.ins.map((p, i) => pinRow(b.n, p, i, b.x, b.y, "in"))}
                {b.outs.map((p, i) => pinRow(b.n, p, i, b.x, b.y, "out"))}
              </g>
            );
          })}
        </g>
        {box && <rect x={Math.min(box.sx, box.ex)} y={Math.min(box.sy, box.ey)} width={Math.abs(box.ex - box.sx)} height={Math.abs(box.ey - box.sy)} fill="rgb(240 168 48 / 0.08)" stroke="#f0a830" strokeDasharray="4 3" />}
      </svg>
      <div className="ue-zoom">
        <button type="button" onClick={() => zoomAt(1.25)} aria-label={L("הגדל", "Zoom in")} title={L("הגדל", "Zoom in")}>+</button>
        <button type="button" onClick={() => zoomAt(0.8)} aria-label={L("הקטן", "Zoom out")} title={L("הקטן", "Zoom out")}>−</button>
        <button type="button" onClick={fit} aria-label={L("הכל במסך (Home)", "Fit (Home)")} title={L("הכל במסך (Home)", "Fit (Home)")}>⤢</button>
        <button type="button" onClick={() => setFind(find ? null : { q: "", i: 0 })} aria-label={L("חיפוש (Ctrl+F)", "Find (Ctrl+F)")} title={L("חיפוש (Ctrl+F)", "Find (Ctrl+F)")}>⌕</button>
        {editable && (
          <>
            <button type="button" onClick={() => undo(false)} aria-label={L("ביטול (Ctrl+Z)", "Undo (Ctrl+Z)")} title={L("ביטול (Ctrl+Z)", "Undo (Ctrl+Z)")}>↶</button>
            <button type="button" onClick={() => undo(true)} aria-label={L("חזרה (Ctrl+Y)", "Redo (Ctrl+Y)")} title={L("חזרה (Ctrl+Y)", "Redo (Ctrl+Y)")}>↷</button>
            <button type="button" onClick={() => { const r = frame.current!.getBoundingClientRect(); openMenu({ x: r.width / 2 - 140, y: 40 }); }} aria-label={L("הוספת נוד", "Add a node")} title={L("הוספת נוד (קליק ימני)", "Add a node (right-click)")}>⊕</button>
            {selected.size > 0 && <button type="button" onClick={() => { void apply([...selected].map((id) => ({ op: "delete", node: id }))); setSelected(new Set()); }} aria-label={L("מחיקת הנבחרים (Delete)", "Delete selected (Delete)")} title={L("מחיקת הנבחרים (Delete)", "Delete selected (Delete)")}>🗑</button>}
          </>
        )}
        <span className="muted small">{busy ? "…" : `${Math.round(view.k * 100)}%`}</span>
      </div>
      {find && (
        <div className="bp-find row">
          <input
            autoFocus
            dir="auto"
            value={find.q}
            placeholder={L("חיפוש בגרף…", "Find in graph…")}
            onChange={(e) => setFind({ q: e.target.value, i: 0 })}
            onKeyDown={(e) => {
              if (e.key === "Enter") setFind({ ...find, i: find.i + (e.shiftKey ? matches.length - 1 : 1) });
              if (e.key === "Escape") setFind(null);
            }}
          />
          <span className="muted small">{matches.length ? `${(find.i % matches.length) + 1}/${matches.length}` : find.q ? "0" : ""}</span>
          <button type="button" onClick={() => setFind(null)} aria-label={L("סגור", "Close")}>✕</button>
        </div>
      )}
      {menu && <ActionMenu path={path} menu={menu} onPick={(a) => void add(a)} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** Unreal's "All Actions for this Blueprint": a search over the nodes the editor can add. */
function ActionMenu({ path, menu, onPick, onClose }: { path: string; menu: Menu; onPick: (a: Action) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Action[] | null>(null);
  const [i, setI] = useState(0);
  useEffect(() => {
    let alive = true;
    const id = setTimeout(() => {
      void api<{ actions: Action[] }>(`/api/unreal/actions?path=${encodeURIComponent(path)}&q=${encodeURIComponent(q)}`).then(
        (r) => {
          if (!alive) return;
          setItems(r.actions);
          setI(0);
        },
        (e: Error) => {
          if (!alive) return;
          setItems([]);
          toast(e.message);
        },
      );
    }, 180);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [q]);
  return (
    <div className="bp-menu" style={{ left: menu.left, top: menu.top }} role="dialog" aria-label={L("כל הפעולות", "All actions")} onPointerDown={(e) => e.stopPropagation()}>
      <div className="row">
        <strong className="grow small">{menu.from ? L(`מ-${menu.from.pin}`, `From ${menu.from.pin}`) : L("כל הפעולות ל-Blueprint הזה", "All Actions for this Blueprint")}</strong>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={L("סגור", "Close")}>✕</button>
      </div>
      <input
        autoFocus
        dir="auto"
        value={q}
        placeholder={L("חיפוש נוד (למשל Print String)", "Search (e.g. Print String)")}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (!items?.length) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setI((x) => Math.min(items.length - 1, x + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setI((x) => Math.max(0, x - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            onPick(items[i]!);
          } else if (e.key === "Escape") onClose();
        }}
      />
      <ul>
        {items === null && <li className="muted small">{L("טוען…", "Loading…")}</li>}
        {items?.length === 0 && <li className="muted small">{L("אין תוצאות.", "Nothing found.")}</li>}
        {items?.map((a, k) => (
          <li key={`${a.type}${a.function ?? a.event ?? a.variable ?? a.title}`}>
            <button type="button" className={k === i ? "on" : ""} onClick={() => onPick(a)} onMouseEnter={() => setI(k)}>
              <span dir="ltr">{a.title}</span>
              {a.category && <span className="muted small" dir="ltr">{a.category}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
