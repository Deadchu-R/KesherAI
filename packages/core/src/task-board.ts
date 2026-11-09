import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The task board KesherAI's self-work agent and Claude share: one JSON file
 * on the user's own computer (KesherAI's data folder), never in git and never
 * on the internet. Each side reads it, claims a task before working on it,
 * marks it done with what it did, and can leave notes for the other. A claim
 * only succeeds when the task is still free, and every write carries the
 * board's revision, so two writers never overwrite each other's change.
 */

/** Who works on the board. */
export type BoardActor = "claude" | "kesher" | "roee";

/** One task: who has it, and what came of it. */
export interface BoardTask {
  id: string;
  title: string;
  /** Details, links, acceptance checks. */
  details?: string;
  status: "open" | "claimed" | "done" | "blocked";
  owner?: BoardActor;
  /** What was done (commit, files, how it was checked). */
  result?: string;
  priority: number;
  updatedAt: string;
  updatedBy: BoardActor;
}

/** A message on the board, from one side to the other. */
export interface BoardNote {
  at: string;
  from: BoardActor;
  text: string;
  task?: string;
}

/** The whole board. */
export interface Board {
  /** Goes up by one on every change. */
  rev: number;
  tasks: BoardTask[];
  notes: BoardNote[];
}

const ACTORS = new Set<BoardActor>(["claude", "kesher", "roee"]);

/** One change to the board. */
export type BoardChange =
  | { op: "add"; title: string; details?: string; priority?: number }
  | { op: "claim"; id: string }
  | { op: "release"; id: string }
  | { op: "done"; id: string; result: string }
  | { op: "block"; id: string; result: string }
  | { op: "reopen"; id: string }
  | { op: "edit"; id: string; title?: string; details?: string; priority?: number }
  | { op: "note"; text: string; task?: string };

/** The task board in a file. */
export class TaskBoard {
  private queue: Promise<unknown> = Promise.resolve();

  /** @param file - The board file (in KesherAI's data folder). */
  constructor(readonly file: string) {}

  /** The board as it is now (empty when there is none yet). */
  async read(): Promise<Board> {
    const raw = await readFile(this.file, "utf8").catch(() => "");
    if (!raw) return { rev: 0, tasks: [], notes: [] };
    try {
      const b = JSON.parse(raw) as Board;
      return { rev: Number(b.rev) || 0, tasks: Array.isArray(b.tasks) ? b.tasks : [], notes: Array.isArray(b.notes) ? b.notes : [] };
    } catch {
      return { rev: 0, tasks: [], notes: [] };
    }
  }

  /**
   * Applies changes, one writer at a time.
   *
   * @param by - Who makes them.
   * @param changes - The changes.
   * @param rev - The revision the writer read; when given and the board moved on, nothing changes (read again).
   * @returns The new board.
   */
  change(by: BoardActor, changes: BoardChange[], rev?: number): Promise<Board> {
    const run = this.queue.then(async () => {
      if (!ACTORS.has(by)) throw new Error("Unknown writer.");
      if (changes.length > 50) throw new Error("At most 50 changes at once.");
      const b = await this.read();
      if (rev !== undefined && rev !== b.rev) throw Object.assign(new Error(`The board changed (now revision ${b.rev}); read it again.`), { code: 409 });
      const now = new Date().toISOString();
      const find = (id: string) => {
        const t = b.tasks.find((x) => x.id === id);
        if (!t) throw new Error(`No task ${id}.`);
        return t;
      };
      const text = (s: unknown, max: number) => String(s ?? "").trim().slice(0, max);
      for (const c of changes) {
        switch (c.op) {
          case "add": {
            const title = text(c.title, 200);
            if (!title) throw new Error("A task needs a title.");
            const id = `t${(b.tasks.reduce((n, t) => Math.max(n, Number(t.id.slice(1)) || 0), 0) + 1)}`;
            b.tasks.push({ id, title, ...(c.details ? { details: text(c.details, 4000) } : {}), status: "open", priority: Number(c.priority) || 5, updatedAt: now, updatedBy: by });
            break;
          }
          case "claim": {
            const t = find(c.id);
            if (t.status === "claimed" && t.owner !== by) throw Object.assign(new Error(`${c.id} is already taken by ${t.owner}.`), { code: 409 });
            if (t.status === "done") throw new Error(`${c.id} is done.`);
            Object.assign(t, { status: "claimed", owner: by, updatedAt: now, updatedBy: by });
            break;
          }
          case "release": {
            const t = find(c.id);
            if (t.owner && t.owner !== by && by !== "roee") throw new Error(`${c.id} belongs to ${t.owner}.`);
            t.status = "open";
            delete t.owner;
            Object.assign(t, { updatedAt: now, updatedBy: by });
            break;
          }
          case "done":
          case "block": {
            const t = find(c.id);
            if (t.owner && t.owner !== by && by !== "roee") throw new Error(`${c.id} belongs to ${t.owner}.`);
            Object.assign(t, { status: c.op === "done" ? "done" : "blocked", owner: t.owner ?? by, result: text(c.result, 4000), updatedAt: now, updatedBy: by });
            break;
          }
          case "reopen": {
            const t = find(c.id);
            t.status = "open";
            delete t.owner;
            Object.assign(t, { updatedAt: now, updatedBy: by });
            break;
          }
          case "edit": {
            const t = find(c.id);
            if (c.title !== undefined) t.title = text(c.title, 200) || t.title;
            if (c.details !== undefined) t.details = text(c.details, 4000);
            if (c.priority !== undefined) t.priority = Number(c.priority) || t.priority;
            Object.assign(t, { updatedAt: now, updatedBy: by });
            break;
          }
          case "note": {
            const msg = text(c.text, 4000);
            if (!msg) throw new Error("An empty note.");
            b.notes.push({ at: now, from: by, text: msg, ...(c.task ? { task: text(c.task, 20) } : {}) });
            if (b.notes.length > 500) b.notes = b.notes.slice(-500);
            break;
          }
          default:
            throw new Error("Unknown change.");
        }
      }
      b.rev++;
      await mkdir(dirname(this.file), { recursive: true });
      // Write then rename, so a reader never sees half a file.
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(b, null, 2));
      await rename(tmp, this.file);
      return b;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

/** The board as short text for a model: open and taken tasks first, then the latest notes. */
export function boardText(b: Board, notes = 10): string {
  const order = { claimed: 0, open: 1, blocked: 2, done: 3 } as const;
  const tasks = [...b.tasks].sort((x, y) => order[x.status] - order[y.status] || x.priority - y.priority);
  const line = (t: BoardTask) => `${t.id} [${t.status}${t.owner ? `: ${t.owner}` : ""}] p${t.priority} ${t.title}${t.result ? ` — ${t.result.split("\n")[0]!.slice(0, 160)}` : ""}`;
  return [`Board revision ${b.rev}.`, ...tasks.filter((t) => t.status !== "done").map(line), ...(tasks.some((t) => t.status === "done") ? [`Done: ${tasks.filter((t) => t.status === "done").length} (latest: ${tasks.filter((t) => t.status === "done").slice(-3).map((t) => t.id).join(", ")})`] : []), ...(b.notes.length ? ["Notes:", ...b.notes.slice(-notes).map((n) => `${n.at.slice(0, 16)} ${n.from}${n.task ? ` (${n.task})` : ""}: ${n.text}`)] : [])].join("\n");
}
