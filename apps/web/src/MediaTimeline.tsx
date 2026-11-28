import { useEffect, useRef, useState } from "react";
import type { MediaEdit } from "@kesher/shared";
import { withToken } from "./api";
import { clockText, spriteCell, type PrepInfo } from "./media-surface";
import { clipAt, clipLen, dropIndex, editLen, fitPps, moveClip, snap, snapPoints, starts, tickStep, timeToX, trimEnd, xToTime, zoomBy, type View } from "./media-timeline";

/*
 * The phone editor's timeline (design PhoneMediaEditor): ONE Canvas 2D with the ruler, the main track (thumbnails from
 * the PC's sprite), the sound lane (from the PC's peaks) and the fixed centre playhead; Pointer Events for the
 * gestures. All the arithmetic is in media-timeline.ts; this file only draws and turns touches into calls to it. The
 * time axis is always left to right (a time axis is, in Hebrew too), whatever the page's direction.
 */

const RULER = 22;
const TRACK_Y = 26;
const TRACK_H = 58;
const LANE_Y = 90;
const LANE_H = 36;
/** The canvas' height in CSS px. */
export const TIMELINE_H = LANE_Y + LANE_H + 6;
/** The touch area of a trim handle (px each side of the edge) and the press-and-hold time for a reorder (ms). */
const HANDLE_HIT = 22;
const HOLD_MS = 450;

/** What the timeline shows and tells its owner. */
export interface TimelineProps {
  edit: MediaEdit;
  /** The playhead, in timeline seconds. */
  at: number;
  pps: number;
  selected: number;
  info: PrepInfo;
  peaks?: Uint8Array | undefined;
  label: string;
  onSeek: (t: number) => void;
  onSelect: (i: number) => void;
  onZoom: (pps: number) => void;
  /** A drag changed the edit: `commit` is true once, when the finger lifts (that is the undo step). */
  onChange: (edit: MediaEdit, commit: boolean) => void;
}

/** A finger's job from the moment it went down. */
type Drag =
  | { kind: "pan"; x: number; t: number; moved: boolean; at: number }
  | { kind: "trim"; i: number; side: "start" | "end"; hit?: number | undefined }
  | { kind: "lift"; i: number; x: number; to: number }
  | { kind: "pinch"; d: number; pps: number };

const tick = (): void => void navigator.vibrate?.(8);

/**
 * Draws the timeline and handles its gestures: drag scrubs, pinch zooms, double-tap fits, tap selects a clip, the
 * handles of the selected clip trim (snapping, with a haptic tick), press-and-hold then drag reorders.
 *
 * @param p - See {@link TimelineProps}.
 */
export function MediaTimeline(p: TimelineProps) {
  const box = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [sheet, setSheet] = useState(0);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<Drag | undefined>(undefined);
  const hold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastTap = useRef({ at: 0, x: 0 });
  const latest = useRef(p);
  latest.current = p;
  /** The sprite as an image (loaded once; `sheet` changes when it arrives so the canvas redraws). */
  const sprite = useRef<HTMLImageElement | undefined>(undefined);
  const spriteUrl = p.info.ready.sprite ? `/api/media/${p.info.id}/sprite` : "";
  useEffect(() => {
    if (!spriteUrl) return;
    let dead = false;
    const img = new Image();
    img.onload = () => {
      if (dead) return;
      sprite.current = img;
      setSheet((n) => n + 1);
    };
    img.src = withToken(spriteUrl);
    return () => {
      dead = true;
    };
  }, [spriteUrl]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  /** Which lifted clip and where, while a reorder is in progress (drawn on top; also read by the draw). */
  const [lift, setLift] = useState<{ i: number; x: number; to: number } | undefined>();

  useEffect(() => {
    const c = cv.current;
    if (!c || !width) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(width * dpr);
    c.height = Math.round(TIMELINE_H * dpr);
    const g = c.getContext("2d");
    if (!g) return;
    g.scale(dpr, dpr);
    const css = getComputedStyle(c);
    const accent = css.getPropertyValue("--accent").trim() || "#98a3ff";
    const dim = css.getPropertyValue("--muted").trim() || "#94949c";
    const panel = css.getPropertyValue("--panel-2").trim() || "#1f1f22";
    const text = css.getPropertyValue("--text").trim() || "#ededee";
    const v: View = { pps: p.pps, width };
    const st = starts(p.edit);
    const x = (t: number): number => timeToX(v, p.at, t);
    g.font = "11px system-ui, sans-serif";
    g.textBaseline = "middle";

    // Ruler: a tick about every 60 px, the label in m:ss.
    const step = tickStep(p.pps);
    g.fillStyle = dim;
    g.strokeStyle = dim;
    g.lineWidth = 1;
    const t0 = Math.max(0, Math.floor(xToTime(v, p.at, 0) / step) * step);
    for (let t = t0; x(t) < width + 40; t += step) {
      const px = Math.round(x(t)) + 0.5;
      g.beginPath();
      g.moveTo(px, RULER - 7);
      g.lineTo(px, RULER);
      g.stroke();
      g.fillText(clockText(t), px + 3, 9);
    }

    p.edit.video.forEach((clip, i) => {
      const x0 = x(st[i]!), x1 = x(st[i]! + clipLen(clip));
      if (x1 < -4 || x0 > width + 4) return;
      const dragged = lift?.i === i;
      g.save();
      g.globalAlpha = dragged ? 0.35 : 1;
      g.beginPath();
      g.roundRect(x0 + 1, TRACK_Y, Math.max(2, x1 - x0 - 2), TRACK_H, 6);
      g.clip();
      g.fillStyle = panel;
      g.fillRect(x0, TRACK_Y, x1 - x0, TRACK_H);
      // Thumbnails: tiles 16:9 across the clip, each the sprite frame of the time at its middle.
      const img = sprite.current;
      if (img && p.info.sprite) {
        const s = p.info.sprite;
        const tw = TRACK_H * (s.w / s.h);
        for (let k = Math.floor(Math.max(0, -x0) / tw); x0 + k * tw < Math.min(x1, width); k++) {
          const tl = (k * tw + tw / 2) / p.pps;
          const { col, row } = spriteCell(s, clip.from + tl * (clip.speed ?? 1));
          g.drawImage(img, col * s.w, row * s.h, s.w, s.h, x0 + k * tw, TRACK_Y, tw, TRACK_H);
        }
      }
      g.restore();
      // The lane: the sound of this stretch, from the PC's peaks.
      if (p.peaks && p.info.peaks) {
        const pk = p.info.peaks;
        const perSec = pk.rate / pk.perColumn;
        const mid = LANE_Y + LANE_H / 2;
        g.fillStyle = i === p.selected ? accent : dim;
        g.globalAlpha = dragged ? 0.3 : 0.9;
        for (let px = Math.max(0, Math.floor(x0)); px < Math.min(width, x1); px += 2) {
          const a = clip.from + ((px - x0) / p.pps) * (clip.speed ?? 1);
          const b = a + (2 / p.pps) * (clip.speed ?? 1);
          const i0 = Math.max(0, Math.floor(a * perSec)), i1 = Math.min(pk.columns, Math.max(i0 + 1, Math.ceil(b * perSec)));
          let lo = 255, hi = 0;
          for (let k = i0; k < i1; k++) {
            lo = Math.min(lo, p.peaks[k * 2]!);
            hi = Math.max(hi, p.peaks[k * 2 + 1]!);
          }
          if (hi < lo) continue;
          const top = mid - (Math.max(0, hi - 128) / 128) * (LANE_H / 2);
          const bot = mid + (Math.max(0, 128 - lo) / 128) * (LANE_H / 2);
          g.fillRect(px, top, 1.4, Math.max(1.5, bot - top));
        }
        g.globalAlpha = 1;
      }
      // Edges between clips and the selection with its two handles.
      g.strokeStyle = i === p.selected ? accent : "rgb(255 255 255 / 0.18)";
      g.lineWidth = i === p.selected ? 2 : 1;
      g.beginPath();
      g.roundRect(x0 + 1, TRACK_Y, Math.max(2, x1 - x0 - 2), TRACK_H, 6);
      g.stroke();
      if (i === p.selected && !dragged) {
        g.fillStyle = accent;
        for (const hx of [x0 + 1, x1 - 9]) {
          g.beginPath();
          g.roundRect(hx, TRACK_Y + 8, 8, TRACK_H - 16, 3);
          g.fill();
        }
      }
      if (clip.speed || clip.volume !== undefined || clip.into) {
        g.fillStyle = text;
        g.fillText([clip.speed ? `${clip.speed}×` : "", clip.volume !== undefined ? `${Math.round(clip.volume * 100)}%` : "", clip.into ? "◢" : ""].filter(Boolean).join(" "), x0 + 6, TRACK_Y + 10);
      }
    });

    // A lifted clip follows the finger; a line shows where it will land.
    if (lift) {
      const clip = p.edit.video[lift.i]!;
      const w = clipLen(clip) * p.pps;
      g.fillStyle = accent;
      g.globalAlpha = 0.55;
      g.beginPath();
      g.roundRect(lift.x - w / 2, TRACK_Y - 4, Math.max(8, w), TRACK_H + 8, 6);
      g.fill();
      g.globalAlpha = 1;
      const rest = p.edit.video.filter((_, k) => k !== lift.i);
      let edge = 0;
      for (let k = 0; k < lift.to; k++) edge += clipLen(rest[k]!);
      g.fillStyle = text;
      g.fillRect(x(edge) - 1, TRACK_Y - 6, 3, TRACK_H + 12);
    }

    // The fixed centre playhead.
    g.fillStyle = text;
    g.fillRect(width / 2 - 1, RULER - 4, 2, TIMELINE_H - RULER + 4);
    g.beginPath();
    g.moveTo(width / 2 - 6, RULER - 10);
    g.lineTo(width / 2 + 6, RULER - 10);
    g.lineTo(width / 2, RULER - 2);
    g.fill();
  }, [p.edit, p.at, p.pps, p.selected, p.peaks, p.info, width, sheet, lift]);

  const local = (e: React.PointerEvent): { x: number; y: number } => {
    const r = box.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e: React.PointerEvent): void => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const pt = local(e);
    pointers.current.set(e.pointerId, pt);
    const q = latest.current;
    const v: View = { pps: q.pps, width };
    if (pointers.current.size === 2) {
      clearTimeout(hold.current);
      const [a, b] = [...pointers.current.values()];
      drag.current = { kind: "pinch", d: Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1, pps: q.pps };
      setLift(undefined);
      return;
    }
    const st = starts(q.edit);
    // A handle of the selected clip (a 44 px wide touch area on each edge).
    const sel = q.edit.video[q.selected];
    if (sel && pt.y >= TRACK_Y - 8 && pt.y <= TRACK_Y + TRACK_H + 8) {
      const x0 = timeToX(v, q.at, st[q.selected]!), x1 = timeToX(v, q.at, st[q.selected]! + clipLen(sel));
      const d0 = Math.abs(pt.x - x0), d1 = Math.abs(pt.x - x1);
      if (Math.min(d0, d1) <= HANDLE_HIT) {
        drag.current = { kind: "trim", i: q.selected, side: d0 <= d1 ? "start" : "end" };
        return;
      }
    }
    drag.current = { kind: "pan", x: pt.x, t: q.at, moved: false, at: Date.now() };
    // Press and hold on a clip lifts it for reordering.
    const i = pt.y >= TRACK_Y && pt.y <= TRACK_Y + TRACK_H ? clipAt(q.edit, xToTime(v, q.at, pt.x)) : -1;
    const t = xToTime(v, q.at, pt.x);
    if (i >= 0 && t >= 0 && t <= editLen(q.edit) && q.edit.video.length > 1) {
      hold.current = setTimeout(() => {
        const d = drag.current;
        if (d?.kind !== "pan" || d.moved) return;
        tick();
        q.onSelect(i);
        drag.current = { kind: "lift", i, x: pt.x, to: i };
        setLift({ i, x: pt.x, to: i });
      }, HOLD_MS);
    }
  };

  const onMove = (e: React.PointerEvent): void => {
    if (!pointers.current.has(e.pointerId)) return;
    const pt = local(e);
    pointers.current.set(e.pointerId, pt);
    const d = drag.current;
    const q = latest.current;
    const v: View = { pps: q.pps, width };
    if (!d) return;
    if (d.kind === "pinch" && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      q.onZoom(zoomBy(d.pps, (Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1) / d.d));
    } else if (d.kind === "pan") {
      if (Math.abs(pt.x - d.x) > 6) {
        d.moved = true;
        clearTimeout(hold.current);
      }
      if (d.moved) q.onSeek(Math.min(editLen(q.edit), Math.max(0, d.t - (pt.x - d.x) / q.pps)));
    } else if (d.kind === "trim") {
      const clip = q.edit.video[d.i]!;
      const own = starts(q.edit)[d.i]!;
      const pts = snapPoints(q.edit, q.at).filter((s) => Math.abs(s - own) > 1e-6 && Math.abs(s - (own + clipLen(clip))) > 1e-6);
      const raw = xToTime(v, q.at, pt.x);
      const s = snap(raw, pts, q.pps);
      if (s.hit !== undefined && s.hit !== d.hit) tick();
      d.hit = s.hit;
      q.onChange(trimEnd(q.edit, d.i, d.side, s.t, q.info.duration ?? Infinity), false);
    } else if (d.kind === "lift") {
      const to = dropIndex(q.edit, d.i, xToTime(v, q.at, pt.x));
      if (to !== d.to) tick();
      drag.current = { ...d, x: pt.x, to };
      setLift({ i: d.i, x: pt.x, to });
    }
  };

  const onUp = (e: React.PointerEvent): void => {
    const pt = local(e);
    pointers.current.delete(e.pointerId);
    clearTimeout(hold.current);
    const d = drag.current;
    const q = latest.current;
    if (!d) return;
    if (d.kind === "pinch") {
      if (pointers.current.size < 2) drag.current = undefined;
      return;
    }
    drag.current = undefined;
    if (d.kind === "trim") q.onChange(q.edit, true);
    else if (d.kind === "lift") {
      setLift(undefined);
      q.onChange(moveClip(q.edit, d.i, d.to), true);
      q.onSelect(d.to);
    } else if (!d.moved) {
      // A tap: twice quickly fits the whole edit; once selects the clip under it (or none).
      const now = Date.now();
      if (now - lastTap.current.at < 320 && Math.abs(pt.x - lastTap.current.x) < 24) {
        lastTap.current = { at: 0, x: 0 };
        q.onZoom(fitPps(editLen(q.edit), width));
        q.onSeek(editLen(q.edit) / 2);
        return;
      }
      lastTap.current = { at: now, x: pt.x };
      const t = xToTime({ pps: q.pps, width }, q.at, pt.x);
      q.onSelect(pt.y >= TRACK_Y - 4 && pt.y <= LANE_Y + LANE_H && t >= 0 && t <= editLen(q.edit) ? clipAt(q.edit, t) : -1);
    }
  };

  return (
    <div ref={box} className="me-timeline" dir="ltr" role="group" aria-label={p.label} style={{ height: TIMELINE_H }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      <canvas ref={cv} style={{ width: "100%", height: TIMELINE_H }} />
    </div>
  );
}
