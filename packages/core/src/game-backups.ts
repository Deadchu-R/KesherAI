import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** Source-save backups (`game-backups/<engine>/`) older than this are removed. */
export const BACKUP_DAYS = 30;
/** All backups together are kept under this size (the oldest go first). */
export const BACKUP_MAX_BYTES = 500 * 1024 * 1024;

/**
 * Prunes the old-text backups the Source view writes before each save, like checkpoints: none older than `days`,
 * then the oldest removed until the total fits `maxBytes`. Never throws (a file in use is left for the next time).
 *
 * @param root - The `game-backups` folder (one sub-folder per engine).
 * @param o.days - Age limit in days.
 * @param o.maxBytes - Total size limit.
 * @param o.now - The clock (tests).
 * @returns How many files were removed.
 */
export async function pruneGameBackups(root: string, o: { days?: number; maxBytes?: number; now?: number } = {}): Promise<number> {
  const now = o.now ?? Date.now();
  const cutoff = now - (o.days ?? BACKUP_DAYS) * 86_400_000;
  const files: Array<{ path: string; size: number; time: number }> = [];
  for (const engine of await readdir(root).catch(() => [] as string[])) {
    for (const name of await readdir(join(root, engine)).catch(() => [] as string[])) {
      const path = join(root, engine, name);
      const st = await stat(path).catch(() => undefined);
      if (st?.isFile()) files.push({ path, size: st.size, time: st.mtimeMs });
    }
  }
  files.sort((a, b) => a.time - b.time);
  let total = files.reduce((n, f) => n + f.size, 0);
  let removed = 0;
  for (const f of files) {
    if (f.time >= cutoff && total <= (o.maxBytes ?? BACKUP_MAX_BYTES)) break;
    if (await rm(f.path, { force: true }).then(() => true, () => false)) {
      total -= f.size;
      removed++;
    }
  }
  return removed;
}
