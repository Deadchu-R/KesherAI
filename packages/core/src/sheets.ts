/**
 * Sheets (design SheetEditor): KesherAI's own spreadsheets, cells as typed (formulas computed by @kesher/shared's own
 * parser, never run as code), edited by her in the grid and by the model through the "sheet" tool; every change tells
 * the open pages; the last 20 versions are kept.
 */
import { EventEmitter } from "node:events";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { replaceFile } from "./replace-file.js";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentTool } from "@kesher/agent";
import { MAX_COLS, MAX_ROWS, addr, cleanCells, describeSheet, parseRef, type Sheet } from "@kesher/shared";

const ID = /^[\w-]{1,80}$/;
/** Cells at most (a sheet stays light to send and compute). */
const MAX_CELLS = 50_000;
const fit = (n: unknown, lo: number, hi: number, d: number) => Math.max(lo, Math.min(hi, Math.round(Number(n)) || d));
/** The grid grows to hold every cell it has. */
function grow(s: Sheet): void {
  for (const a of Object.keys(s.cells)) {
    const p = parseRef(a)!;
    s.cols = Math.max(s.cols, p.c + 1);
    s.rows = Math.max(s.rows, p.r + 1);
  }
}

/** The sheets. */
export class SheetStore extends EventEmitter {
  private writes = Promise.resolve();

  /** @param dir - Where the files are. */
  constructor(private readonly dir: string) {
    super();
    this.setMaxListeners(100);
  }

  private file(id: string): string {
    if (!ID.test(id)) throw Object.assign(new Error("Bad sheet id."), { statusCode: 400 });
    return join(this.dir, `${id}.json`);
  }

  /** Every sheet, newest first (without the cells). */
  async list(): Promise<Array<{ id: string; title: string; cells: number; convId?: string; updatedAt: string }>> {
    const names = (await readdir(this.dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
    const all = await Promise.all(names.map((n) => this.get(n.slice(0, -5)).catch(() => undefined)));
    return all
      .filter((d): d is Sheet => !!d)
      .map((d) => ({ id: d.id, title: d.title, cells: Object.keys(d.cells).length, ...(d.convId ? { convId: d.convId } : {}), updatedAt: d.updatedAt }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** One sheet, or undefined. */
  async get(id: string): Promise<Sheet | undefined> {
    const text = await readFile(this.file(id), "utf8").catch(() => undefined);
    return text ? (JSON.parse(text) as Sheet) : undefined;
  }

  /** A new sheet (a chat's own when convId is given; its existing one is returned). */
  async create(p: { title: string; cells?: unknown; convId?: string }): Promise<Sheet> {
    const id = p.convId ? `chat-${p.convId}` : randomUUID();
    const had = p.convId ? await this.get(id) : undefined;
    if (had) return had;
    const s: Sheet = { id, title: p.title.trim().slice(0, 160) || "Sheet", cells: cleanCells(p.cells, MAX_CELLS), cols: 8, rows: 30, ...(p.convId ? { convId: p.convId } : {}), rev: 0, updatedAt: new Date().toISOString() };
    grow(s);
    await this.write(s);
    return s;
  }

  /** Changes a sheet under its lock (keeping the version before), saves it and tells the open pages. */
  async update(id: string, fn: (s: Sheet) => void): Promise<Sheet> {
    let out!: Sheet;
    const run = this.writes.then(async () => {
      const s = await this.get(id);
      if (!s) throw Object.assign(new Error("No such sheet."), { statusCode: 404 });
      const before = { rev: s.rev, at: s.updatedAt, title: s.title, cells: { ...s.cells }, cols: s.cols, rows: s.rows };
      fn(s);
      if (Object.keys(s.cells).length > MAX_CELLS) throw Object.assign(new Error(`A sheet holds at most ${MAX_CELLS} cells.`), { statusCode: 413 });
      grow(s);
      s.cols = Math.min(MAX_COLS, s.cols);
      s.rows = Math.min(MAX_ROWS, s.rows);
      // Typing makes one version a minute, not one per cell.
      const last = s.versions?.at(-1);
      if (!last || Date.parse(before.at) - Date.parse(last.at) > 60_000) s.versions = [...(s.versions ?? []), before].slice(-20);
      s.rev++;
      s.updatedAt = new Date().toISOString();
      await this.write(s);
      out = s;
    });
    this.writes = run.catch(() => undefined);
    await run;
    this.emit(`change:${id}`, out.rev);
    return out;
  }

  /** The open page's save: the cells it changed (empty text clears a cell), from the revision it started at. */
  save(id: string, p: { title?: unknown; changes?: unknown; cols?: unknown; rows?: unknown; rev: number }): Promise<Sheet> {
    const raw = p.changes && typeof p.changes === "object" ? (p.changes as Record<string, unknown>) : {};
    return this.update(id, (s) => {
      if (p.rev !== s.rev) throw Object.assign(new Error("The sheet changed; load it and save again."), { statusCode: 409 });
      setCells(s, raw);
      if (typeof p.title === "string" && p.title.trim()) s.title = p.title.trim().slice(0, 160);
      if (p.cols !== undefined) s.cols = fit(p.cols, 1, MAX_COLS, s.cols);
      if (p.rows !== undefined) s.rows = fit(p.rows, 1, MAX_ROWS, s.rows);
    });
  }

  /** Back to an earlier version. */
  restore(id: string, rev: number): Promise<Sheet> {
    return this.update(id, (s) => {
      const v = s.versions?.find((x) => x.rev === rev);
      if (!v) throw Object.assign(new Error("No such version."), { statusCode: 404 });
      Object.assign(s, { title: v.title, cells: v.cells, cols: v.cols, rows: v.rows });
    });
  }

  /** Deletes a sheet. */
  async remove(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
    this.emit(`change:${id}`, -1);
  }

  private async write(s: Sheet): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = this.file(s.id);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(s), { mode: 0o600 });
    await replaceFile(tmp, file);
  }
}

/** Sets cells (address → text; empty or null clears), ignoring addresses outside the grid. */
function setCells(s: Sheet, raw: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(raw).slice(0, MAX_CELLS)) {
    const p = parseRef(k);
    if (!p) continue;
    const a = addr(p.c, p.r);
    if (v === null || v === undefined || v === "") delete s.cells[a];
    else if (typeof v === "string" || typeof v === "number") s.cells[a] = String(v).replace(/\r/g, "").slice(0, 2000);
  }
}

const stores = new Map<string, SheetStore>();

/** The one sheet store of a data folder (the routes and the chats' tool share it). */
export function sheetStoreFor(dir: string): SheetStore {
  let s = stores.get(dir);
  if (!s) stores.set(dir, (s = new SheetStore(dir)));
  return s;
}

/**
 * The chat's "sheet" tool: makes and edits the chat's own spreadsheet (or one she names by id), which she sees and
 * edits in KesherAI.
 *
 * @param store - The sheets.
 * @param convId - The chat.
 * @param title - The chat's title.
 */
export function sheetTools(store: SheetStore, convId: string, title: () => string): AgentTool[] {
  const own = async (t?: string, other?: unknown) => {
    if (typeof other === "string" && other && other !== `chat-${convId}`) {
      const s = await store.get(other).catch(() => undefined);
      if (!s) throw new Error(`No sheet "${other}".`);
      return s;
    }
    return (await store.get(`chat-${convId}`)) ?? store.create({ title: t || title() || "Sheet", convId });
  };
  return [
    {
      risk: "read",
      spec: {
        name: "sheet",
        description:
          "This chat's spreadsheet, which the user sees and edits in KesherAI (no Excel needed): use it for tables to calculate, track or sort (budgets, grades, schedules, lists). Cells by address (A1, B2…); a value starting with = is a formula: + - * / ^, A1:B9 ranges, SUM AVERAGE MIN MAX COUNT COUNTA ROUND ABS SQRT IF AND OR NOT LEN UPPER LOWER CONCAT, comparisons, & joins text. action 'read' shows every cell (formulas with their values). 'set' writes cells: cells = {\"A1\": \"Course\", \"B2\": \"=SUM(B3:B9)\"}; an empty string clears one. 'write' replaces all cells (and title). Put headers in row 1. Write in the user's language. Read first when the user may have edited it. id: another sheet's id (when the user names one, as in #/sheets/<id>); leave it out for this chat's own.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["read", "set", "write"] },
            id: { type: "string" },
            title: { type: "string" },
            cells: { type: "object", description: "Address → text or formula." },
          },
          required: ["action"],
        },
      },
      async run(input) {
        const action = String(input.action ?? "read");
        const s = await own(typeof input.title === "string" ? input.title : undefined, input.id);
        if (action === "read") return { output: describeSheet(s) };
        const cells = input.cells && typeof input.cells === "object" ? (input.cells as Record<string, unknown>) : {};
        if (!Object.keys(cells).length) throw new Error("Give the cells.");
        const saved = await store.update(s.id, (x) => {
          if (action === "write") {
            x.cells = cleanCells(cells, MAX_CELLS);
            if (typeof input.title === "string" && input.title.trim()) x.title = input.title.trim().slice(0, 160);
          } else if (action === "set") setCells(x, cells);
          else throw new Error(`Unknown action "${action}".`);
        });
        return { output: `Saved. The user sees it at #/sheets/${saved.id}.\n${describeSheet(saved).slice(0, 6000)}` };
      },
    },
  ];
}
