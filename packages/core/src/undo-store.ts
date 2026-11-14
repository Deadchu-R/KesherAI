/**
 * The files each agent run changed, as they were before it, kept on disk for the run's receipt ("Undo all"), so the
 * button still works after the app restarts. One folder per conversation, one file per run; the newest 30 runs of a
 * conversation are kept, and a run whose files add up to more than 20 MB is kept in memory only.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunFiles, UndoStore } from "@kesher/agent";

const RUN = /^[a-f0-9-]{1,40}$/;
const KEEP = 30;
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * The undo store of one conversation.
 *
 * @param root - The folder for every conversation's runs.
 * @param conversation - The conversation's id.
 */
export function fileUndoStore(root: string, conversation: string): UndoStore {
  const dir = join(root, conversation.replace(/[^\w-]/g, "_"));
  const file = (run: string) => {
    if (!RUN.test(run)) throw new Error("Not a run id.");
    return join(dir, `${run}.json`);
  };
  return {
    async save(run, files) {
      const size = files.files.reduce((n, f) => n + (f.before?.length ?? 0), 0);
      if (size > MAX_BYTES) return;
      await mkdir(dir, { recursive: true });
      await writeFile(file(run), JSON.stringify(files), "utf8");
      // The oldest beyond the newest 30 go.
      const all = await Promise.all((await readdir(dir)).filter((f) => f.endsWith(".json")).map(async (f) => ({ f, t: (await stat(join(dir, f))).mtimeMs })));
      for (const old of all.sort((a, b) => b.t - a.t).slice(KEEP)) await rm(join(dir, old.f), { force: true });
    },
    async load(run) {
      const text = await readFile(file(run), "utf8").catch(() => undefined);
      if (!text) return undefined;
      const j = JSON.parse(text) as RunFiles;
      return Array.isArray(j.files) ? j : undefined;
    },
    async remove(run) {
      await rm(file(run), { force: true });
    },
  };
}
