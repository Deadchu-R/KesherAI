import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HelperRuns, SavedHelperRun } from "./helper-runs.js";

/**
 * Helper runs on disk (docs/RESEARCH_LOG.md, "Gap list: agents and chat-first", step 2): one JSON file per chat in
 * the data folder (`helper-runs/<chat id>.json`, never in the project or the logs), written soon after each change
 * of a run (a step, its state, its report) and each step of its conversation. After a restart the ended runs show
 * again ("finished while you were away"), and the ones that were going come back paused and continue by themselves.
 */

/** Wait after a change before writing, so a burst of steps is one write. */
const WRITE_DELAY_MS = 400;
/** A chat's file bigger than this keeps its runs but drops the conversations (they start again from the task). */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** A build run's whole diff is kept in its own file (`diffs/<chat id>.<run id>.diff`), up to this size. */
const MAX_DIFF_BYTES = 5 * 1024 * 1024;
/** A run id that is safe as a file name. */
const SAFE_RUN = /^[\w-]{1,40}$/;
/** A chat id that is safe as a file name. */
const SAFE_ID = /^[\w-]{1,100}$/;

/** The saved runs of every chat. */
export class HelperStore {
  private readonly due = new Map<string, NodeJS.Timeout>();
  private writes: Promise<void> = Promise.resolve();

  /**
   * @param dir - The folder for the files (in the data folder).
   * @param runs - The runs to save.
   */
  constructor(
    private readonly dir: string,
    private readonly runs: HelperRuns,
  ) {}

  /** Saves a chat's runs whenever they change (until the process ends). */
  watch(): void {
    const soon = (chatId: string) => this.soon(chatId);
    this.runs.on("change", soon);
    this.runs.on("save", soon);
  }

  /**
   * Reads every chat's saved runs.
   *
   * @returns The runs (files that cannot be read are skipped).
   */
  async load(): Promise<SavedHelperRun[]> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const out: SavedHelperRun[] = [];
    for (const name of names) {
      const chatId = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!SAFE_ID.test(chatId)) continue;
      try {
        const list = JSON.parse(await readFile(join(this.dir, name), "utf8")) as unknown;
        if (!Array.isArray(list)) continue;
        for (const s of list) {
          if (!isSaved(s, chatId)) continue;
          // A cut card diff means the whole one is in its file (a missing file leaves the card's copy).
          if (s.info.diff && s.info.diff.length >= 30_000 && SAFE_RUN.test(s.info.id)) {
            const full = await readFile(this.diffFile(chatId, s.info.id), "utf8").catch(() => "");
            if (full) s.fullDiff = full;
          }
          out.push(s);
        }
      } catch {
        // A broken file (a write cut by a crash) is left out; the next write replaces it.
      }
    }
    return out;
  }

  /**
   * Writes a chat's runs after a short wait (one write for a burst of changes).
   *
   * @param chatId - The chat.
   */
  soon(chatId: string): void {
    if (!SAFE_ID.test(chatId) || this.due.has(chatId)) return;
    const t = setTimeout(() => {
      this.due.delete(chatId);
      void this.write(chatId);
    }, WRITE_DELAY_MS);
    t.unref?.();
    this.due.set(chatId, t);
  }

  /** Writes every waiting change now (on close, and in tests). */
  async flush(): Promise<void> {
    const ids = [...this.due.keys()];
    for (const id of ids) {
      clearTimeout(this.due.get(id));
      this.due.delete(id);
      void this.write(id);
    }
    await this.writes;
  }

  /** The file of a run's whole diff. */
  private diffFile(chatId: string, runId: string): string {
    return join(this.dir, "diffs", `${chatId}.${runId}.diff`);
  }

  /** Writes the chat's whole diffs that are not on disk yet, and removes the files of runs that are gone (pruned with the run). */
  private async syncDiffs(chatId: string): Promise<void> {
    const diffs = this.runs.fullDiffs(chatId);
    const folder = join(this.dir, "diffs");
    for (const name of await readdir(folder).catch(() => [] as string[])) {
      const m = /^([\w-]{1,100})\.([\w-]{1,40})\.diff$/.exec(name);
      if (m && m[1] === chatId && !diffs.has(m[2]!)) await rm(join(folder, name), { force: true });
    }
    for (const [id, diff] of diffs) {
      if (!SAFE_RUN.test(id)) continue;
      const file = this.diffFile(chatId, id);
      if (await stat(file).then(() => true, () => false)) continue;
      await mkdir(folder, { recursive: true });
      await writeFile(`${file}.tmp`, diff.slice(0, MAX_DIFF_BYTES), "utf8");
      await rename(`${file}.tmp`, file);
    }
  }

  /** Writes one chat's file (one write at a time; a new file is renamed over the old one, so a crash never leaves half). */
  write(chatId: string): Promise<void> {
    this.writes = this.writes.then(async () => {
      const file = join(this.dir, `${chatId}.json`);
      const list = this.runs.saved(chatId);
      try {
        await this.syncDiffs(chatId);
        if (!list.length) {
          await rm(file, { force: true });
          return;
        }
        let text = JSON.stringify(list);
        if (text.length > MAX_FILE_BYTES) text = JSON.stringify(list.map(({ transcript: _, ...s }) => s));
        await mkdir(this.dir, { recursive: true });
        await writeFile(`${file}.tmp`, text, "utf8");
        await rename(`${file}.tmp`, file);
      } catch (err) {
        console.warn(`[helpers] could not save the helper runs: ${(err as Error).message}`);
      }
    });
    return this.writes;
  }
}

/** Whether a value read from disk is a saved run of this chat. */
function isSaved(s: unknown, chatId: string): s is SavedHelperRun {
  if (!s || typeof s !== "object") return false;
  const r = s as Partial<SavedHelperRun>;
  const i = r.info;
  return r.chatId === chatId && !!i && typeof i.id === "string" && typeof i.state === "string" && typeof i.title === "string" && typeof i.kind === "string" && Array.isArray(i.steps) && typeof r.timeMs === "number" && (r.transcript === undefined || Array.isArray(r.transcript)) && (r.notes === undefined || (Array.isArray(r.notes) && r.notes.every((n) => typeof n === "string")));
}
