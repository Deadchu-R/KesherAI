/**
 * Canvases (an Excalidraw board the user and the model draw on together, like LM Studio's Canvas). Each one is a
 * JSON file: the Excalidraw elements the open page saved, and the model's additions not drawn yet. The model's
 * additions are Excalidraw "element skeletons" (a type, an id, a label, arrows bound by id): only the browser can
 * turn those into full elements (`convertToExcalidrawElements`), so the open page does it and saves the result.
 * Changes and deletions by the model are made on the saved elements here, with a higher `version`, so they win
 * when the page merges them with what the user is drawing.
 */
import { EventEmitter } from "node:events";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentTool } from "@kesher/agent";

/** One Excalidraw element as saved (only the fields KesherAI reads are typed). */
export interface CanvasElement {
  id: string;
  type: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  text?: string;
  originalText?: string;
  containerId?: string | null;
  isDeleted?: boolean;
  version?: number;
  versionNonce?: number;
  strokeColor?: string;
  backgroundColor?: string;
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
  boundElements?: Array<{ id: string; type: string }> | null;
  [key: string]: unknown;
}

/** A skeleton the model added (Excalidraw's Element Skeleton API), turned into elements by the open page. */
export interface CanvasSkeleton {
  type: "rectangle" | "ellipse" | "diamond" | "text" | "arrow";
  id: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  text?: string;
  label?: { text: string };
  start?: { id: string };
  end?: { id: string };
  strokeColor?: string;
  backgroundColor?: string;
}

/** A canvas file. */
export interface CanvasDoc {
  id: string;
  title: string;
  /** The chat it belongs to (none: made on the Canvas page). */
  convId?: string;
  elements: CanvasElement[];
  pending: CanvasSkeleton[];
  rev: number;
  updatedAt: string;
}

/** A canvas in the list. */
export interface CanvasSummary {
  id: string;
  title: string;
  convId?: string;
  shapes: number;
  updatedAt: string;
}

const ID = /^[\w-]{1,80}$/;
const MAX_ELEMENTS = 5000;
const MAX_BYTES = 5 * 1024 * 1024;

/** Colours a model may name, as Excalidraw's palette (stroke, fill). */
export const CANVAS_COLORS: Record<string, [string, string]> = {
  black: ["#1e1e1e", "transparent"],
  red: ["#e03131", "#ffc9c9"],
  green: ["#2f9e44", "#b2f2bb"],
  blue: ["#1971c2", "#a5d8ff"],
  yellow: ["#f08c00", "#ffec99"],
  purple: ["#6741d9", "#d0bfff"],
  gray: ["#495057", "#e9ecef"],
};

/** The canvases in one folder, with a change event per canvas (the open page follows it). */
export class CanvasStore extends EventEmitter {
  private writes = Promise.resolve();

  /** @param dir - Where the canvas files are. */
  constructor(private readonly dir: string) {
    super();
    this.setMaxListeners(100);
  }

  private file(id: string): string {
    if (!ID.test(id)) throw Object.assign(new Error("Bad canvas id."), { code: 400 });
    return join(this.dir, `${id}.json`);
  }

  /** @returns Every canvas, newest first. */
  async list(): Promise<CanvasSummary[]> {
    const names = (await readdir(this.dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
    const docs = await Promise.all(names.map((n) => this.get(n.slice(0, -5)).catch(() => undefined)));
    return docs
      .filter((d): d is CanvasDoc => !!d)
      .map((d) => ({ id: d.id, title: d.title, ...(d.convId ? { convId: d.convId } : {}), shapes: d.elements.filter((e) => !e.isDeleted && e.type !== "text" && e.type !== "arrow").length + d.pending.filter((p) => p.type !== "arrow").length, updatedAt: d.updatedAt }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * @param id - A canvas id.
   * @returns The canvas, or undefined.
   */
  async get(id: string): Promise<CanvasDoc | undefined> {
    const text = await readFile(this.file(id), "utf8").catch(() => undefined);
    if (!text) return undefined;
    const d = JSON.parse(text) as CanvasDoc;
    return { ...d, elements: d.elements ?? [], pending: d.pending ?? [], rev: d.rev ?? 0 };
  }

  /**
   * Makes a canvas: a chat's own (its id is the chat's) or a free one.
   *
   * @param title - Its name.
   * @param convId - The chat it belongs to.
   * @returns The new canvas, or the chat's existing one.
   */
  async create(title: string, convId?: string): Promise<CanvasDoc> {
    const id = convId ? `chat-${convId}` : randomUUID();
    const had = await this.get(id);
    if (had) return had;
    const doc: CanvasDoc = { id, title: title.slice(0, 120) || "Canvas", ...(convId ? { convId } : {}), elements: [], pending: [], rev: 0, updatedAt: new Date().toISOString() };
    await this.write(doc);
    return doc;
  }

  /**
   * Changes a canvas under its lock, then saves it and tells the open pages.
   *
   * @param id - The canvas.
   * @param fn - Changes the doc in place; may throw to refuse.
   * @returns The saved canvas.
   */
  async update(id: string, fn: (doc: CanvasDoc) => void): Promise<CanvasDoc> {
    let out!: CanvasDoc;
    const run = this.writes.then(async () => {
      const doc = await this.get(id);
      if (!doc) throw Object.assign(new Error("No such canvas."), { code: 404 });
      fn(doc);
      doc.rev++;
      doc.updatedAt = new Date().toISOString();
      if (doc.elements.length > MAX_ELEMENTS) throw Object.assign(new Error(`A canvas holds at most ${MAX_ELEMENTS} elements.`), { code: 413 });
      await this.write(doc);
      out = doc;
    });
    this.writes = run.catch(() => undefined);
    await run;
    this.emit(`change:${id}`, out.rev);
    return out;
  }

  /**
   * Saves what the open page drew: its elements, and which of the model's skeletons it has turned into elements.
   *
   * @param id - The canvas.
   * @param elements - All of the page's elements.
   * @param rev - The revision the page started from (an older one is refused: the page merges and tries again).
   * @param drawn - Skeleton ids the page has drawn.
   * @returns The saved canvas.
   */
  async save(id: string, elements: unknown, rev: number, drawn: string[] = []): Promise<CanvasDoc> {
    if (!Array.isArray(elements)) throw Object.assign(new Error("elements must be a list."), { code: 400 });
    if (Buffer.byteLength(JSON.stringify(elements)) > MAX_BYTES) throw Object.assign(new Error("This canvas is too big to save (5 MB)."), { code: 413 });
    const clean = elements.filter((e): e is CanvasElement => !!e && typeof e === "object" && typeof (e as CanvasElement).id === "string" && typeof (e as CanvasElement).type === "string");
    return this.update(id, (doc) => {
      if (rev !== doc.rev) throw Object.assign(new Error("The canvas changed; merge and save again."), { code: 409 });
      doc.elements = clean;
      const done = new Set(drawn);
      doc.pending = doc.pending.filter((p) => !done.has(p.id));
    });
  }

  /**
   * @param id - The canvas.
   * @param title - Its new name.
   * @returns The saved canvas.
   */
  rename(id: string, title: string): Promise<CanvasDoc> {
    return this.update(id, (doc) => void (doc.title = title.slice(0, 120) || doc.title));
  }

  /** @param id - The canvas to delete. */
  async remove(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
    this.emit(`change:${id}`, -1);
  }

  private async write(doc: CanvasDoc): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = this.file(doc.id);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(doc), { mode: 0o600 });
    await rename(tmp, file);
  }
}

/** What is on a canvas, in words the model reads: shapes with their ids and text, and the arrows between them. */
export function describeCanvas(doc: CanvasDoc): string {
  const live = doc.elements.filter((e) => !e.isDeleted);
  const textOf = new Map<string, string>();
  for (const e of live) if (e.type === "text" && e.containerId) textOf.set(e.containerId, String(e.text ?? ""));
  const lines: string[] = [];
  for (const e of live) {
    if (e.type === "arrow") {
      const from = e.startBinding?.elementId;
      const to = e.endBinding?.elementId;
      lines.push(`arrow ${e.id}: ${from ?? "?"} -> ${to ?? "?"}${textOf.get(e.id) ? ` "${textOf.get(e.id)}"` : ""}`);
    } else if (e.type === "text" && e.containerId) continue;
    else if (e.type === "text") lines.push(`text ${e.id} at ${Math.round(e.x ?? 0)},${Math.round(e.y ?? 0)}: "${e.text ?? ""}"`);
    else lines.push(`${e.type} ${e.id} at ${Math.round(e.x ?? 0)},${Math.round(e.y ?? 0)}${textOf.get(e.id) ? `: "${textOf.get(e.id)}"` : ""}`);
  }
  for (const p of doc.pending) {
    if (p.type === "arrow") lines.push(`arrow ${p.id}: ${p.start?.id} -> ${p.end?.id}${p.label ? ` "${p.label.text}"` : ""} (not drawn yet)`);
    else lines.push(`${p.type} ${p.id} at ${p.x},${p.y}: "${p.label?.text ?? p.text ?? ""}" (not drawn yet)`);
  }
  return lines.length ? `Canvas "${doc.title}" (${lines.length} items):\n${lines.join("\n")}` : `Canvas "${doc.title}" is empty.`;
}

/** The bottom of everything already on the canvas (new shapes go under it). */
function bottomOf(doc: CanvasDoc): number {
  let bottom = -Infinity;
  for (const e of doc.elements) if (!e.isDeleted && e.type !== "arrow") bottom = Math.max(bottom, (e.y ?? 0) + (e.height ?? 0));
  for (const p of doc.pending) if (p.type !== "arrow") bottom = Math.max(bottom, p.y + (p.height ?? 100));
  return Number.isFinite(bottom) ? bottom + 80 : 0;
}

/**
 * Places new shapes that came without a position as a top-to-bottom flowchart (it reads on a phone and keeps a long
 * chain from shrinking to a thin row): a shape an arrow points to goes one row under the shape it comes from (the
 * longest path decides), shapes in a row side by side. A shape that sits in the way of an arrow skipping rows moves
 * one column aside, so no arrow runs through it. Shapes with no arrows among the new ones form the first row.
 * Everything goes under what is already on the canvas.
 *
 * @param ids - The new shapes to place, in the order given.
 * @param arrows - Arrows between shapes (only those between two of `ids` count).
 * @param top - Where the first row goes.
 * @returns Each id's position.
 */
export function layoutShapes(ids: string[], arrows: Array<{ from: string; to: string }>, top: number): Map<string, { x: number; y: number }> {
  const set = new Set(ids);
  const edges = arrows.filter((a) => set.has(a.from) && set.has(a.to) && a.from !== a.to);
  const level = new Map(ids.map((id) => [id, 0]));
  // Longest path, at most ids.length rounds (a cycle stops growing there).
  for (let round = 0; round < ids.length; round++) {
    let moved = false;
    for (const e of edges) {
      const want = level.get(e.from)! + 1;
      if (want > level.get(e.to)! && want < ids.length) {
        level.set(e.to, want);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const cols = new Map<number, number>();
  const col = new Map<string, number>();
  for (const id of ids) {
    const row = level.get(id)!;
    const c = cols.get(row) ?? 0;
    cols.set(row, c + 1);
    col.set(id, c);
  }
  // An arrow skipping rows in a straight column would cross the shapes between: move those aside.
  for (const e of edges) {
    const [a, b] = [level.get(e.from)!, level.get(e.to)!];
    if (b - a < 2 || col.get(e.from) !== col.get(e.to)) continue;
    for (const id of ids) {
      const l = level.get(id)!;
      if (l > a && l < b && col.get(id) === col.get(e.from)) col.set(id, col.get(id)! + 1);
    }
  }
  return new Map(ids.map((id) => [id, { x: col.get(id)! * 280, y: top + level.get(id)! * 170 }]));
}

/** Where an arrow between two boxes starts and ends: on their edges, along the line between their centres. */
function edgePoints(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): { x: number; y: number; dx: number; dy: number } {
  const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  const exit = (w: number, h: number) => Math.min(dx ? w / 2 / Math.abs(dx) : Infinity, dy ? h / 2 / Math.abs(dy) : Infinity);
  const gap = 8 / Math.max(1, Math.hypot(dx, dy));
  const s = Math.min(0.5, exit(a.w, a.h) + gap);
  const t = Math.max(0.5, 1 - exit(b.w, b.h) - gap);
  return { x: ca.x + dx * s, y: ca.y + dy * s, dx: dx * (t - s), dy: dy * (t - s) };
}

const SHAPES = ["rectangle", "ellipse", "diamond", "note", "text"] as const;

/**
 * The model's `canvas` tool for one chat: read, add shapes and arrows, change text or colour, delete. Positions are
 * optional (KesherAI lays new shapes out in rows), so a small model only says what and how they connect.
 *
 * @param store - The canvases.
 * @param convId - The chat (its canvas is made on first use).
 * @param title - The chat's title, for a new canvas.
 * @returns The tool.
 */
export function canvasTools(store: CanvasStore, convId: string, title: () => string): AgentTool[] {
  const own = () => store.create(title() || "Canvas", convId);
  return [
    {
      risk: "read",
      spec: {
        name: "canvas",
        description:
          "This chat's Canvas: a whiteboard the user sees and edits with you (diagrams, flows, architecture, mockups, mind maps). action 'read' lists what is on it (ids, text, arrows). 'add' adds shapes (each with your own short id, a kind: rectangle, ellipse, diamond, note or text, and its text; x and y are optional: KesherAI lays shapes out as a top-to-bottom flowchart along your arrows) and arrows (from and to are shape ids, optional text). 'change' sets a shape's text or color. 'delete' removes shapes (and their arrows). Colors: black, red, green, blue, yellow, purple, gray. Read first when the user may have drawn on it.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["read", "add", "change", "delete"] },
            shapes: {
              type: "array",
              description: "For 'add': the shapes.",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", description: "A short id you choose, e.g. 'login'." },
                  kind: { type: "string", enum: [...SHAPES] },
                  text: { type: "string" },
                  color: { type: "string" },
                  x: { type: "number" },
                  y: { type: "number" },
                },
                required: ["id", "text"],
              },
            },
            arrows: {
              type: "array",
              description: "For 'add': arrows between shapes, by id.",
              items: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, text: { type: "string" } }, required: ["from", "to"] },
            },
            id: { type: "string", description: "For 'change': the shape." },
            text: { type: "string", description: "For 'change': its new text." },
            color: { type: "string", description: "For 'change': its new color." },
            ids: { type: "array", items: { type: "string" }, description: "For 'delete': the shapes." },
          },
          required: ["action"],
        },
      },
      async run(input) {
        const action = String(input.action ?? "read");
        const doc = await own();
        if (action === "read") return { output: describeCanvas(doc) };
        if (action === "add") {
          const shapes = Array.isArray(input.shapes) ? (input.shapes as Array<Record<string, unknown>>).slice(0, 60) : [];
          const arrows = Array.isArray(input.arrows) ? (input.arrows as Array<Record<string, unknown>>).slice(0, 120) : [];
          if (!shapes.length && !arrows.length) throw new Error("Give shapes or arrows to add.");
          const saved = await store.update(doc.id, (d) => {
            const taken = new Set([...d.elements.filter((e) => !e.isDeleted).map((e) => e.id), ...d.pending.map((p) => p.id)]);
            const unplaced = shapes.filter((s) => typeof s.x !== "number" || typeof s.y !== "number").map((s) => String(s.id ?? ""));
            const spots = layoutShapes(unplaced, arrows.map((a) => ({ from: String(a.from ?? ""), to: String(a.to ?? "") })), bottomOf(d));
            for (const s of shapes) {
              const id = String(s.id ?? "");
              if (!ID.test(id)) throw new Error(`Shape id "${id}": use letters, digits, - and _.`);
              if (taken.has(id)) throw new Error(`There is already a shape "${id}": use 'change', or another id.`);
              taken.add(id);
              const kind = SHAPES.includes(String(s.kind) as (typeof SHAPES)[number]) ? (String(s.kind) as (typeof SHAPES)[number]) : "rectangle";
              const at = typeof s.x === "number" && typeof s.y === "number" ? { x: s.x, y: s.y } : spots.get(id)!;
              const text = String(s.text ?? "").slice(0, 500);
              const [stroke, fill] = CANVAS_COLORS[String(s.color ?? "")] ?? (kind === "note" ? CANVAS_COLORS.yellow! : [undefined, undefined]);
              const colors = { ...(stroke ? { strokeColor: stroke } : {}), ...(fill && fill !== "transparent" ? { backgroundColor: fill } : {}) };
              if (kind === "text") d.pending.push({ type: "text", id, ...at, text, ...colors });
              else d.pending.push({ type: kind === "note" ? "rectangle" : kind, id, ...at, width: 200, height: 100, label: { text }, ...colors });
            }
            const where = new Map<string, { x: number; y: number; w: number; h: number }>();
            for (const e of d.elements) if (!e.isDeleted && e.type !== "arrow") where.set(e.id, { x: e.x ?? 0, y: e.y ?? 0, w: e.width ?? 200, h: e.height ?? 100 });
            for (const p of d.pending) if (p.type !== "arrow") where.set(p.id, { x: p.x, y: p.y, w: p.width ?? 200, h: p.height ?? 40 });
            for (const a of arrows) {
              const from = String(a.from ?? "");
              const to = String(a.to ?? "");
              if (!where.has(from) || !where.has(to)) throw new Error(`An arrow needs two shapes that exist: "${from}" -> "${to}".`);
              const line = edgePoints(where.get(from)!, where.get(to)!);
              const id = `${from}-to-${to}`.slice(0, 80).replace(/[^\w-]/g, "_");
              if (taken.has(id)) continue;
              taken.add(id);
              const text = a.text ? String(a.text).slice(0, 200) : "";
              d.pending.push({ type: "arrow", id, x: line.x, y: line.y, width: line.dx, height: line.dy, start: { id: from }, end: { id: to }, ...(text ? { label: { text } } : {}) });
            }
          });
          return { output: `Added. The user sees it on the canvas (it is drawn as soon as the canvas is open).\n${describeCanvas(saved)}` };
        }
        if (action === "change") {
          const id = String(input.id ?? "");
          const text = input.text === undefined ? undefined : String(input.text).slice(0, 500);
          const color = input.color === undefined ? undefined : CANVAS_COLORS[String(input.color)];
          if (input.color !== undefined && !color) throw new Error(`Unknown color: use ${Object.keys(CANVAS_COLORS).join(", ")}.`);
          await store.update(doc.id, (d) => {
            const p = d.pending.find((x) => x.id === id);
            if (p) {
              if (text !== undefined && p.type === "text") p.text = text;
              else if (text !== undefined) p.label = { text };
              if (color) Object.assign(p, { strokeColor: color[0], ...(color[1] !== "transparent" ? { backgroundColor: color[1] } : {}) });
              return;
            }
            const e = d.elements.find((x) => x.id === id && !x.isDeleted);
            if (!e) throw new Error(`No shape "${id}" on the canvas: 'read' it first.`);
            const bump = (x: CanvasElement) => Object.assign(x, { version: (x.version ?? 1) + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() });
            if (text !== undefined) {
              const label = e.type === "text" ? e : d.elements.find((x) => x.containerId === id && !x.isDeleted);
              if (!label) throw new Error(`"${id}" has no text to change.`);
              bump(Object.assign(label, { text, originalText: text }));
            }
            if (color) bump(Object.assign(e, { strokeColor: color[0], ...(color[1] !== "transparent" && e.type !== "text" ? { backgroundColor: color[1] } : {}) }));
          });
          return { output: `Changed "${id}".` };
        }
        if (action === "delete") {
          const ids = new Set((Array.isArray(input.ids) ? input.ids : [input.id]).map(String));
          await store.update(doc.id, (d) => {
            d.pending = d.pending.filter((p) => !ids.has(p.id) && !ids.has(p.start?.id ?? "") && !ids.has(p.end?.id ?? ""));
            for (const e of d.elements) {
              if (ids.has(e.id) || ids.has(e.containerId ?? "") || ids.has(e.startBinding?.elementId ?? "") || ids.has(e.endBinding?.elementId ?? "")) {
                Object.assign(e, { isDeleted: true, version: (e.version ?? 1) + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() });
              }
            }
          });
          return { output: `Deleted ${[...ids].join(", ")} (and their arrows).` };
        }
        throw new Error(`Unknown action "${action}": read, add, change or delete.`);
      },
    },
  ];
}
