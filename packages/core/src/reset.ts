import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Putting KesherAI back to how it was first installed — always with a
 * backup, never deleting:
 *
 * - **settings**: config.json moves to backups/; chats, models and files stay.
 *   The next start makes fresh settings (and a new remote token: devices
 *   pair again).
 * - **everything**: the whole data folder moves aside to `.<app>-backup-<time>`
 *   (downloaded models are kept, if asked), and the next start is like a first
 *   install. Done at the next start, before anything opens files there.
 *
 * Restoring: move the backup back (Settings shows where it is).
 */

/** What to reset. */
export type ResetKind = "settings" | "everything";

const MARK = "reset-pending.json";
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

/**
 * Settings back to default: moves config.json to backups/ (now; the running
 * server keeps its copy until it restarts).
 *
 * @param root - The data folder.
 * @returns Where the old settings went.
 */
export async function resetSettings(root: string): Promise<string> {
  const config = join(root, "config.json");
  const dir = join(root, "backups");
  await mkdir(dir, { recursive: true });
  const to = join(dir, `config-${stamp()}.json`);
  if (existsSync(config)) await rename(config, to);
  return to;
}

/**
 * Asks for a full reset at the next start (see {@link applyPendingReset}).
 *
 * @param root - The data folder.
 * @param keepModels - Keep downloaded models (they are big).
 */
export async function requestFullReset(root: string, keepModels: boolean): Promise<void> {
  await writeFile(join(root, MARK), JSON.stringify({ kind: "everything", keepModels, at: new Date().toISOString() }));
}

/**
 * Asks for settings to go back to default at the next start (the running
 * server would otherwise save its settings again before it stops).
 *
 * @param root - The data folder.
 */
export async function requestSettingsReset(root: string): Promise<void> {
  await writeFile(join(root, MARK), JSON.stringify({ kind: "settings", at: new Date().toISOString() }));
}

/** Cancels a full reset that has not happened yet. */
export async function cancelFullReset(root: string): Promise<void> {
  await rm(join(root, MARK), { force: true });
}

/** @returns Whether a full reset waits for the next start. */
export function fullResetPending(root: string): boolean {
  return existsSync(join(root, MARK));
}

/**
 * Runs at start, before the data folder is used: a full reset that was asked
 * for moves the folder aside (models back in, if kept).
 *
 * @param root - The data folder.
 * @returns Where the backup went (the old settings file, or the old folder), if a reset happened.
 */
export async function applyPendingReset(root: string): Promise<string | undefined> {
  const mark = join(root, MARK);
  if (!existsSync(mark)) return undefined;
  const req = JSON.parse(await readFile(mark, "utf8").catch(() => "{}")) as { kind?: ResetKind; keepModels?: boolean };
  await rm(mark, { force: true });
  if (req.kind === "settings") return resetSettings(root);
  const backup = join(dirname(root), `${basename(root)}-backup-${stamp()}`);
  await rename(root, backup);
  await mkdir(root, { recursive: true });
  if (req.keepModels !== false && existsSync(join(backup, "models"))) await rename(join(backup, "models"), join(root, "models"));
  return backup;
}

/**
 * @param root - The data folder.
 * @returns Earlier backups: settings files, and whole-folder backups next to it.
 */
export async function listBackups(root: string): Promise<{ settings: string[]; folders: string[] }> {
  const settings = (await readdir(join(root, "backups")).catch(() => [] as string[])).filter((f) => f.startsWith("config-")).map((f) => join(root, "backups", f));
  const folders = (await readdir(dirname(root)).catch(() => [] as string[])).filter((f) => f.startsWith(`${basename(root)}-backup-`)).map((f) => join(dirname(root), f));
  return { settings: settings.sort().reverse(), folders: folders.sort().reverse() };
}
