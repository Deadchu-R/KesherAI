/**
 * The Unreal Editor's own log for a project, read by KesherAI (2026-11-23): the editor writes
 * `Saved/Logs/<ProjectName>.log` while it runs (older runs are renamed with a date), so a fault such as
 * "the plugin never connected" can be found from the log without anyone opening Unreal's Output Log.
 */
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** At most this much is read, from the end of the file (a long editor session writes tens of megabytes). */
export const LOG_READ_BYTES = 2 * 1024 * 1024;
/** The most lines one request returns. */
export const LOG_MAX_LINES = 2000;
/** Lines returned when the request does not say. */
export const LOG_DEFAULT_LINES = 400;

/** The end of a project's editor log. */
export interface UnrealLogTail {
  /** The log's file name inside Saved/Logs (never the full path). */
  file: string;
  /** When the log was last written (ms since 1970). */
  modified: number;
  /** Its size in bytes. */
  size: number;
  /** The last lines (after the filter), oldest first. */
  lines: string[];
  /** True when the file is larger than what was read, so older lines were not looked at. */
  truncated: boolean;
}

/**
 * Finds the log to read in a project's Saved/Logs folder: `<name>.log` (the current or last run), else the newest
 * `*.log` there (a project renamed since, or a backup such as `<name>-backup-2026.11.23-10.00.00.log`).
 *
 * @param projectDir - The project folder (the one with the .uproject).
 * @param name - The project's name (the .uproject's file name without the extension).
 * @returns The log's file name and its stats, or undefined when the project has no log yet.
 */
export async function findProjectLog(projectDir: string, name: string): Promise<{ file: string; size: number; modified: number } | undefined> {
  const dir = join(projectDir, "Saved", "Logs");
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.toLowerCase().endsWith(".log"));
  const withStats = (
    await Promise.all(
      files.map(async (f) => {
        const st = await stat(join(dir, f)).catch(() => undefined);
        return st?.isFile() ? { file: f, size: st.size, modified: st.mtimeMs } : undefined;
      }),
    )
  ).filter((x): x is { file: string; size: number; modified: number } => !!x);
  const own = withStats.find((f) => f.file.toLowerCase() === `${name.toLowerCase()}.log`);
  return own ?? withStats.sort((a, b) => b.modified - a.modified)[0];
}

/**
 * Reads the end of a project's editor log.
 *
 * @param projectDir - The project folder; the caller must take it from the list of known projects (never a path
 *   from a request), since the log's name is the only part chosen here.
 * @param name - The project's name.
 * @param opts - `lines`: how many of the last lines (1 to {@link LOG_MAX_LINES}, default {@link LOG_DEFAULT_LINES});
 *   `grep`: only lines that contain this text (case-insensitive, plain text, not a pattern).
 * @returns The tail, or undefined when the project has no log yet.
 */
export async function tailProjectLog(projectDir: string, name: string, opts: { lines?: number; grep?: string } = {}): Promise<UnrealLogTail | undefined> {
  const log = await findProjectLog(projectDir, name);
  if (!log) return undefined;
  const want = Math.min(LOG_MAX_LINES, Math.max(1, Math.floor(Number(opts.lines) || LOG_DEFAULT_LINES)));
  const start = Math.max(0, log.size - LOG_READ_BYTES);
  const handle = await open(join(projectDir, "Saved", "Logs", log.file), "r");
  let text: string;
  try {
    const buf = Buffer.alloc(log.size - start);
    const { bytesRead } = await handle.read(buf, 0, buf.length, start);
    text = buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
  let lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (start > 0) lines.shift(); // read from the middle of a line: that partial line is dropped
  if (lines.at(-1) === "") lines.pop();
  const grep = opts.grep?.trim().toLowerCase();
  if (grep) lines = lines.filter((l) => l.toLowerCase().includes(grep));
  return { file: log.file, modified: log.modified, size: log.size, lines: lines.slice(-want), truncated: start > 0 };
}
