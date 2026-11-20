/**
 * The design doc's canvas (Claude's design-doc artifact, `project/canvas.json`) and its boards, without any I/O:
 * the `.dc.html` board around a shot, which boards changed since the last render, and the canvas after a render
 * (new boards in new rows below everything, changed boards updated in place, the "newest" notes moved to them).
 *
 * Roee's rules for the doc (docs/HANDOFF.md "The design doc"): no glow behind the newest board, no auto-zoom, and no
 * note may cover a design. The newest note sits above its board when that space is free, otherwise beside it.
 */

/** A board's place on the canvas, as the artifact keeps it. */
export interface CanvasBoard {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
}

/** A note (sticky or title) on the canvas. */
export interface CanvasNote {
  x: number;
  y: number;
  w: number;
  text: string;
  fill?: string;
  size?: string;
  bold?: boolean;
  kind?: string;
  maxW?: number;
}

/** The parts of canvas.json this code reads and writes; every other key is kept as it is. */
export interface Canvas {
  boards: Record<string, CanvasBoard>;
  order: string[];
  notes: Record<string, CanvasNote>;
  noteOrder: string[];
  [key: string]: unknown;
}

/** One rendered board, as the render keeps it (design-out/state.json). */
export interface RenderedBoard {
  title: string;
  group: string;
  viewport: "desktop" | "phone";
  w: number;
  h: number;
  /** sha256 of the PNG: a board changed when this (or its title) did. */
  hash: string;
  /** When the picture last changed (ISO). */
  changedAt: string;
}

/** What changed between two renders. */
export interface RenderDiff {
  added: string[];
  changed: string[];
  same: string[];
  /** Boards in the last render that have no scenario any more (kept on the canvas; the Design page hides them). */
  removed: string[];
}

/** The width a board takes on the canvas: computer boards 1200 px, phone boards 390 px (as the doc has them). */
export const BOARD_WIDTH = { desktop: 1200, phone: 390 } as const;
/** The room kept beside each board for its notes (as design_marks.py lays rows out). */
export const SIDE_ROOM = 40 + 260 + 80;
/** How far the newest note sits above its board, and the height it is taken to have. */
const NOTE_PAD = 28;
const NOTE_ABOVE = 340;
const NOTE_H = 300;
/** Space between rows of new boards: room for the group title and the newest note above each row. */
const ROW_GAP = 900;

/** An empty canvas, for a design-out folder that has no copy of the doc's canvas yet. */
export function emptyCanvas(): Canvas {
  return { v: 3, title: "KesherAI — design", attachments: [], boards: {}, createdOnFiles: { at: new Date(0).toISOString(), v: 1 }, designSystems: [], launch: { view: "canvas" }, noteOrder: [], notes: {}, order: [], pages: [] };
}

/**
 * Reads canvas.json text and makes sure the parts this code uses are there.
 * @param text The file's text (or empty for a new canvas).
 * @returns The canvas.
 * @throws When the text is not a canvas object.
 */
export function readCanvas(text: string): Canvas {
  if (!text.trim()) return emptyCanvas();
  const c = JSON.parse(text) as Partial<Canvas>;
  if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error("canvas.json is not an object");
  return { ...c, boards: c.boards ?? {}, order: c.order ?? [], notes: c.notes ?? {}, noteOrder: c.noteOrder ?? [] } as Canvas;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The `.dc.html` board for one shot, in the format of the design doc's picture boards (shotboard.py).
 * @param title The board's title.
 * @param w The board's width on the canvas.
 * @param h The board's height on the canvas.
 * @param pngBase64 The shot, base64.
 * @param locale The board's language (sets the page direction).
 * @returns The whole HTML file.
 */
export function boardHtml(title: string, w: number, h: number, pngBase64: string, locale: "he" | "en" = "he"): string {
  const t = esc(title);
  const dir = locale === "he" ? "rtl" : "ltr";
  return `<!doctype html>\n<html lang="${locale}" dir="${dir}"><head><meta charset="utf-8"><title>${t}</title><script src="./support.js"></script></head>\n`
    + `<body><x-dc><helmet><style>body{margin:0;background:#121213}</style></helmet>`
    + `<div class="b" style="width:${w}px;height:${h}px;position:relative;overflow:hidden"><img src="data:image/png;base64,${pngBase64}" style="width:${w}px;height:${h}px;display:block" alt="${t}"></div></x-dc>`
    + `<script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":${w},"height":${h}}}'>class Component extends DCLogic { renderVals() { return {}; } }</script></body></html>`;
}

/**
 * Compares this render with the last one.
 * @param before The boards of the last render (state.json).
 * @param now This render's boards.
 * @returns Which boards are new, changed (picture or title), the same, or no longer rendered.
 */
export function diffRenders(before: Record<string, RenderedBoard>, now: Record<string, Pick<RenderedBoard, "hash" | "title">>): RenderDiff {
  const d: RenderDiff = { added: [], changed: [], same: [], removed: [] };
  for (const [name, b] of Object.entries(now)) {
    const old = before[name];
    if (!old) d.added.push(name);
    else if (old.hash !== b.hash || old.title !== b.title) d.changed.push(name);
    else d.same.push(name);
  }
  d.removed = Object.keys(before).filter((n) => !(n in now));
  return d;
}

interface Rect { x: number; y: number; w: number; h: number }
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Where a note for a board goes so it covers no design: above the board when that is free, else beside it
 * (the side room every row keeps), else below it.
 * @param c The canvas.
 * @param name The board.
 * @param h The note's height.
 * @returns The note's x, y and width.
 */
export function notePlace(c: Canvas, name: string, h = NOTE_H): { x: number; y: number; w: number } {
  const b = c.boards[name]!;
  const others = Object.entries(c.boards).filter(([n]) => n !== name).map(([, o]) => o);
  const free = (r: Rect) => !others.some((o) => overlaps(r, o));
  const above = { x: b.x - NOTE_PAD, y: b.y - NOTE_PAD - NOTE_ABOVE, w: b.w + 2 * NOTE_PAD, h };
  if (free(above)) return { x: above.x, y: above.y, w: above.w };
  const beside = { x: b.x + b.w + 40, y: b.y, w: 260, h };
  if (free(beside)) return { x: beside.x, y: beside.y, w: beside.w };
  return { x: b.x, y: b.y + b.h + 40, w: Math.max(260, b.w) };
}

/** One board to put on the canvas after a render. */
export interface MergeBoard {
  name: string;
  title: string;
  group: string;
  w: number;
  h: number;
}

/**
 * The canvas after a render: boards that are on it already keep their place (new size and title); new boards go
 * in new rows below everything, one row per group (computer boards first, then phone), with the group's title.
 * When anything is new or changed, the "newest" notes move to exactly those boards; otherwise they stay.
 * @param canvas The canvas before (not changed).
 * @param boards Every rendered board, in render order.
 * @param diff Which of them are new or changed.
 * @param notes Roee's note per board (from the Design page), shown beside the board.
 * @returns The new canvas.
 */
export function mergeCanvas(canvas: Canvas, boards: MergeBoard[], diff: Pick<RenderDiff, "added" | "changed">, notes: Record<string, string> = {}): Canvas {
  const c: Canvas = { ...canvas, boards: { ...canvas.boards }, order: [...canvas.order], notes: { ...canvas.notes }, noteOrder: [...canvas.noteOrder] };
  const fresh = boards.filter((b) => !c.boards[b.name]);
  for (const b of boards) {
    const old = c.boards[b.name];
    if (old) c.boards[b.name] = { ...old, w: b.w, h: b.h, title: b.title };
  }
  // New rows, below everything already on the canvas.
  const bottom = () => Math.max(0, ...Object.values(c.boards).map((b) => b.y + b.h));
  const groups = [...new Set(fresh.map((b) => b.group))];
  for (const g of groups) {
    const y = bottom() + ROW_GAP;
    let x = 0;
    const row = fresh.filter((b) => b.group === g);
    for (const b of [...row.filter((r) => r.w > BOARD_WIDTH.phone), ...row.filter((r) => r.w <= BOARD_WIDTH.phone)]) {
      c.boards[b.name] = { x, y, w: b.w, h: b.h, title: b.title };
      if (!c.order.includes(b.name)) c.order.push(b.name);
      x += b.w + SIDE_ROOM;
    }
    const id = `dg-${g}`;
    if (!c.notes[id]) {
      c.notes[id] = { x: 0, y: y - NOTE_ABOVE - NOTE_PAD - 260, w: 240, maxW: Math.max(1820, x), text: g, kind: "title1" };
      c.noteOrder.push(id);
    }
  }
  // The newest notes: only on this render's new and changed boards (one marker per change, asked 2026-11-16).
  const marked = [...diff.added, ...diff.changed].filter((n) => c.boards[n]);
  if (marked.length) {
    for (const k of Object.keys(c.notes)) if (k.startsWith("mk-")) delete c.notes[k];
    c.noteOrder = c.noteOrder.filter((k) => !k.startsWith("mk-"));
    marked.forEach((n, i) => {
      const label = `${diff.added.includes(n) ? "חדש" : "עודכן"}: ${c.boards[n]!.title}`;
      c.notes[`mk-newest${i}`] = { ...notePlace(c, n), text: `🆕 הכי חדש · ${label}`, fill: "orange", size: "xl", bold: true };
      c.noteOrder.push(`mk-newest${i}`);
    });
  }
  return applyBoardNotes(c, notes);
}

/** The canvas id of a board's note from the Design page. */
const noteId = (name: string) => `dn-${name.replace(/\.dc\.html$/, "")}`;

/**
 * Puts Roee's per-board notes (Design page) on the canvas, beside or under their boards; removes cleared ones.
 * @param canvas The canvas (not changed).
 * @param notes The note per board name; an empty text removes the note.
 * @returns The new canvas.
 */
export function applyBoardNotes(canvas: Canvas, notes: Record<string, string>): Canvas {
  const c: Canvas = { ...canvas, notes: { ...canvas.notes }, noteOrder: [...canvas.noteOrder] };
  for (const [name, text] of Object.entries(notes)) {
    const id = noteId(name);
    if (!text.trim() || !c.boards[name]) {
      delete c.notes[id];
      c.noteOrder = c.noteOrder.filter((k) => k !== id);
      continue;
    }
    // In the side room every row keeps, below the place a newest note beside the board would take.
    const b = c.boards[name]!;
    const at = { x: b.x + b.w + 40, y: b.y + NOTE_H + 20, w: 260 };
    c.notes[id] = { ...at, text: `💬 ${text.trim()}` };
    if (!c.noteOrder.includes(id)) c.noteOrder.push(id);
  }
  return c;
}
