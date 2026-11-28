/**
 * The phone video editor's plain logic (design PhoneMediaEditor, PhoneMediaExport): time to pixel mapping, snapping,
 * and the edits to a `MediaEdit` (split, trim, delete, reorder, speed, volume), an undo history and the export size
 * estimate. No React, no canvas, no network, so it is tested on its own (`media-timeline.test.ts`); the canvas and the
 * sheets in `MediaEditor.tsx` only call it. Every function returns a NEW edit and leaves the one it was given alone.
 */
import type { MediaClip, MediaEdit } from "@kesher/shared";

/** The shortest a clip may be after a split or a trim, in seconds. */
export const MIN_CLIP = 0.1;

/** How far (px) a dragged handle must come to a snap point before it jumps to it. */
export const SNAP_PX = 10;

/** The timeline's zoom limits, in pixels per second. */
export const PPS_MIN = 0.5;
export const PPS_MAX = 400;

/** A clip's length on the timeline (after its speed). */
export const clipLen = (c: MediaClip): number => (c.to - c.from) / (c.speed ?? 1);

/** The whole edit's length on the timeline (clips laid end to end; a transition's overlap is not subtracted). */
export const editLen = (e: MediaEdit): number => e.video.reduce((n, c) => n + clipLen(c), 0);

/** Where each clip starts on the timeline. */
export function starts(e: MediaEdit): number[] {
  let t = 0;
  return e.video.map((c) => {
    const at = t;
    t += clipLen(c);
    return at;
  });
}

/** An edit that plays a whole file, once (the editor's first state). */
export const wholeFile = (duration: number): MediaEdit => ({ v: 1, video: [{ src: 0, from: 0, to: Math.max(MIN_CLIP, duration) }], lanes: [] });

/** Which clip holds the timeline time `t` (the last one for the very end), or -1 for an empty edit. */
export function clipAt(e: MediaEdit, t: number): number {
  const st = starts(e);
  for (let i = e.video.length - 1; i >= 0; i--) if (t >= st[i]! - 1e-9) return i;
  return e.video.length ? 0 : -1;
}

/**
 * Where a timeline time is in the source file (what the viewer must show).
 *
 * @param e - The edit.
 * @param t - Timeline seconds.
 * @returns The clip's index and the time in its source file, or undefined for an empty edit.
 */
export function locate(e: MediaEdit, t: number): { index: number; src: number; time: number } | undefined {
  const i = clipAt(e, t);
  if (i < 0) return undefined;
  const c = e.video[i]!;
  const local = Math.min(clipLen(c), Math.max(0, t - starts(e)[i]!));
  return { index: i, src: c.src, time: Math.round((c.from + local * (c.speed ?? 1)) * 1000) / 1000 };
}

/** The timeline's view: the playhead sits in the middle of `width` px and `pps` pixels are one second. */
export interface View {
  pps: number;
  width: number;
}

/** The x (px) of timeline time `t` when the playhead is at `at`. */
export const timeToX = (v: View, at: number, t: number): number => v.width / 2 + (t - at) * v.pps;

/** The timeline time under x (px) when the playhead is at `at`. */
export const xToTime = (v: View, at: number, x: number): number => at + (x - v.width / 2) / v.pps;

/** The zoom that shows `total` seconds across the width (with a margin), within the limits. */
export const fitPps = (total: number, width: number): number => Math.min(PPS_MAX, Math.max(PPS_MIN, (width * 0.8) / Math.max(total, MIN_CLIP)));

/** A new zoom after a pinch that changed the finger distance by `scale`. */
export const zoomBy = (pps: number, scale: number): number => Math.min(PPS_MAX, Math.max(PPS_MIN, pps * scale));

/** Seconds between ruler ticks so they stay about 60 px apart: the first of 1, 2, 5, 10, ... that is wide enough. */
export function tickStep(pps: number): number {
  const want = 60 / pps;
  for (const s of [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600]) if (s >= want) return s;
  return 3600;
}

/** The moments a handle or the playhead snaps to: every clip's edges, the playhead and the start. */
export function snapPoints(e: MediaEdit, playhead: number): number[] {
  const st = starts(e);
  const pts = [0, playhead];
  e.video.forEach((c, i) => pts.push(st[i]!, st[i]! + clipLen(c)));
  return pts;
}

/**
 * Snaps a time to the nearest point within {@link SNAP_PX} pixels.
 *
 * @param t - The time wanted.
 * @param points - From {@link snapPoints}, minus any that belong to the thing being dragged.
 * @param pps - The zoom.
 * @returns The time, and the point it snapped to (for the haptic tick), if any.
 */
export function snap(t: number, points: readonly number[], pps: number): { t: number; hit?: number } {
  let best: number | undefined;
  for (const p of points) if (Math.abs(p - t) * pps <= SNAP_PX && (best === undefined || Math.abs(p - t) < Math.abs(best - t))) best = p;
  return best === undefined ? { t } : { t: best, hit: best };
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/** The edit with clip `i` replaced by `c`. */
const withClip = (e: MediaEdit, i: number, ...c: MediaClip[]): MediaEdit => ({ ...e, video: [...e.video.slice(0, i), ...c, ...e.video.slice(i + 1)] });

/**
 * Splits the clip under the playhead in two (the way the Split button does). Nothing happens when either piece would
 * be shorter than {@link MIN_CLIP}. The second piece comes in with a plain cut.
 *
 * @param e - The edit.
 * @param t - The playhead, in timeline seconds.
 * @returns The new edit and the index of the second piece, or undefined when it cannot be split there.
 */
export function splitAt(e: MediaEdit, t: number): { edit: MediaEdit; index: number } | undefined {
  const i = clipAt(e, t);
  if (i < 0) return undefined;
  const c = e.video[i]!;
  const local = t - starts(e)[i]!;
  if (local < MIN_CLIP || clipLen(c) - local < MIN_CLIP) return undefined;
  const mid = r3(c.from + local * (c.speed ?? 1));
  const { into: _into, ...rest } = c;
  return { edit: withClip(e, i, { ...c, to: mid }, { ...rest, from: mid }), index: i + 1 };
}

/** Removes clip `i`; the last clip cannot be removed (an edit is never empty). */
export const removeClip = (e: MediaEdit, i: number): MediaEdit | undefined => (e.video.length > 1 && e.video[i] ? withClip(e, i) : undefined);

/**
 * Trims one end of clip `i` to a timeline time. The start moves the clip's `from`, the end its `to`; the clip stays at
 * least {@link MIN_CLIP} long and inside the source (`limit` seconds, when known).
 *
 * @param e - The edit.
 * @param i - The clip.
 * @param side - Which end.
 * @param t - Where the handle is, in timeline seconds.
 * @param limit - The source file's length.
 */
export function trimEnd(e: MediaEdit, i: number, side: "start" | "end", t: number, limit = Infinity): MediaEdit {
  const c = e.video[i];
  if (!c) return e;
  const speed = c.speed ?? 1;
  const at = starts(e)[i]!;
  if (side === "start") {
    const from = r3(Math.min(c.to - MIN_CLIP * speed, Math.max(0, c.from + (t - at) * speed)));
    return withClip(e, i, { ...c, from });
  }
  const to = r3(Math.max(c.from + MIN_CLIP * speed, Math.min(limit, c.from + (t - at) * speed)));
  return withClip(e, i, { ...c, to });
}

/** Moves clip `from` to place `to` (both indexes in the list). */
export function moveClip(e: MediaEdit, from: number, to: number): MediaEdit {
  if (from === to || !e.video[from] || to < 0 || to >= e.video.length) return e;
  const v = [...e.video];
  v.splice(to, 0, v.splice(from, 1)[0]!);
  return { ...e, video: v };
}

/**
 * The place a dragged clip would take: the index whose middle the drag's time has passed.
 *
 * @param e - The edit (with the dragged clip still in place).
 * @param from - The dragged clip.
 * @param t - The time under the finger.
 */
export function dropIndex(e: MediaEdit, from: number, t: number): number {
  const rest = e.video.filter((_, i) => i !== from);
  let at = 0;
  for (let k = 0; k < rest.length; k++) {
    const len = clipLen(rest[k]!);
    if (t < at + len / 2) return k;
    at += len;
  }
  return rest.length;
}

/** Sets a clip's speed (0.25 to 4) and/or volume (0 to 2); the default values are left out, as `checkMediaEdit` does. */
export function setClip(e: MediaEdit, i: number, patch: { speed?: number; volume?: number }): MediaEdit {
  const c = e.video[i];
  if (!c) return e;
  const next: MediaClip = { ...c };
  if (patch.speed !== undefined) {
    const s = Math.round(Math.min(4, Math.max(0.25, patch.speed)) * 100) / 100;
    if (s === 1) delete next.speed;
    else next.speed = s;
  }
  if (patch.volume !== undefined) {
    const v = Math.round(Math.min(2, Math.max(0, patch.volume)) * 100) / 100;
    if (v === 1) delete next.volume;
    else next.volume = v;
  }
  return withClip(e, i, next);
}

/** Sets how clip `i` comes in: a fade of `seconds` (0 is a plain cut). The first clip has nothing before it. */
export function setTransition(e: MediaEdit, i: number, seconds: number): MediaEdit {
  const c = e.video[i];
  if (!c || i === 0) return e;
  const { into: _old, ...rest } = c;
  return withClip(e, i, seconds > 0 ? { ...rest, into: { kind: "fade", seconds: Math.round(Math.min(1.5, Math.max(0.1, seconds)) * 10) / 10 } } : rest);
}

/** An undo history: the edits before, now and after. */
export interface History<T> {
  past: T[];
  now: T;
  future: T[];
}

/** The most steps kept for undo. */
export const HISTORY_MAX = 100;

/** A history that starts at `now`. */
export const history = <T>(now: T): History<T> => ({ past: [], now, future: [] });

/** A new step; the redo steps are dropped, and a step equal to the present one is not kept. */
export function push<T>(h: History<T>, next: T): History<T> {
  if (JSON.stringify(next) === JSON.stringify(h.now)) return h;
  return { past: [...h.past, h.now].slice(-HISTORY_MAX), now: next, future: [] };
}

/** One step back (the same history when there is none). */
export const undo = <T>(h: History<T>): History<T> => (h.past.length ? { past: h.past.slice(0, -1), now: h.past.at(-1)!, future: [h.now, ...h.future] } : h);

/** One step forward (the same history when there is none). */
export const redo = <T>(h: History<T>): History<T> => (h.future.length ? { past: [...h.past, h.now], now: h.future[0]!, future: h.future.slice(1) } : h);

/** The export sheet's look. */
export interface ExportChoice {
  height: 720 | 1080;
  fps: 24 | 30 | 60;
  quality: "low" | "medium" | "high";
}

/** Video bit rate (kbit/s) at 30 fps by height and quality: what x264 at the sheet's CRF (30, 25, 20) makes on ordinary footage. */
const KBPS: Record<ExportChoice["quality"], Record<ExportChoice["height"], number>> = {
  low: { 720: 1200, 1080: 2400 },
  medium: { 720: 2500, 1080: 5000 },
  high: { 720: 5000, 1080: 9000 },
};

/**
 * A rough size of the export in bytes (video at the quality's rate scaled by the frame rate, plus 160 kbit/s of sound).
 * Shown with "about"; the real file depends on the footage.
 *
 * @param seconds - The edit's length.
 * @param c - The sheet's choice.
 */
export function estimateBytes(seconds: number, c: ExportChoice): number {
  const kbps = KBPS[c.quality][c.height] * (c.fps / 30) ** 0.8 + 160;
  return Math.round((Math.max(0, seconds) * kbps * 1000) / 8);
}

/** A size as "12 MB" / "1.4 GB". */
export function sizeText(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
