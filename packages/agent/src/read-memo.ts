import { extname } from "node:path";
import { symbolsWithLines } from "./code-intel.js";

/**
 * Files at least this long get an outline (their symbols with line numbers) on a first read and in a repeat note, so
 * the model can jump to the part it needs instead of paging through the file (task inbox, 27.11: runs on big files
 * stopped as "re-reading the same large file each step").
 */
export const OUTLINE_MIN_LINES = 400;

/**
 * The smallest window a ranged read_file returns. Models that read 20-40 lines at a time page through a big file in
 * dozens of steps and lose their place (seen on the PC: "re-reading the same file at offset 30 and 117").
 */
export const MIN_READ_LINES = 80;

/**
 * A file's outline: the names it defines, each with its line, on one line each, at most `max`.
 *
 * @param text - The file's text.
 * @param path - Its path (the extension picks the language).
 * @param max - How many symbols at most.
 * @returns The outline block, or "" when the language is unknown or nothing was found.
 */
export function fileOutline(text: string, path: string, max = 80): string {
  const { symbols, lines } = symbolsWithLines(text, extname(path), max);
  if (!symbols.length) return "";
  const total = text.split(/\r?\n/).length;
  return [`Outline of ${path} (${total} lines; read a part with offset/limit):`, ...symbols.map((s, i) => `  L${lines[i]} ${s}`), ...(symbols.length >= max ? ["  … (more below)"] : [])].join("\n");
}

/** One read the agent made in this run. */
interface Seen {
  /** The step (tool call number in this session) it was made at. */
  step: number;
  /** Its tool call id (tool_output opens it again). */
  callId: string;
  /** The file's size and time then: a change makes the next read a real one. */
  size: number;
  mtimeMs: number;
}

/**
 * Remembers what read_file returned in one session, so an identical repeat of a read of an unchanged file is answered
 * with a short note (where the text already is, and the outline) instead of the whole text again. Models that lose
 * their place re-read the same big file each step and burn the run's request budget; the note breaks that loop while
 * `tool_output` still opens the earlier text when it is really needed.
 */
export class ReadMemo {
  private seen = new Map<string, Seen>();
  private step = 0;

  /** Counts one tool call (any tool), for the "at step N" in the note. */
  tick(): number {
    return ++this.step;
  }

  /**
   * The key of a read: the file and the range asked for (no range = the default first window).
   *
   * @param absPath - The resolved file.
   * @param input - read_file's arguments.
   */
  static key(absPath: string, input: Record<string, unknown>): string {
    const off = Math.max(1, Number(input.offset ?? 1) || 1);
    const lim = input.limit === undefined ? "" : String(Math.max(1, Number(input.limit) || 0));
    return `${absPath}#${off}:${lim}`;
  }

  /**
   * The note for a repeated identical read of an unchanged file, or undefined when the read should run.
   *
   * @param key - From {@link ReadMemo.key}.
   * @param file - The file's size and time now.
   * @param shown - Whether the earlier result is still in what the model reads in full (not pruned or shortened).
   * @param rel - The path as the model wrote it.
   * @param outlineOf - Makes the file's outline ("" for none); called only when a note is made.
   */
  async repeat(key: string, file: { size: number; mtimeMs: number }, shown: (callId: string) => boolean, rel: string, outlineOf: () => Promise<string>): Promise<string | undefined> {
    const was = this.seen.get(key);
    if (!was || was.size !== file.size || was.mtimeMs !== file.mtimeMs || !shown(was.callId)) return undefined;
    const outline = await outlineOf();
    return [
      `[KesherAI] Not read again: you already read exactly this part of ${rel} at step ${was.step} (result id "${was.callId}") and the file has not changed since. Its text is in that earlier result above.`,
      "Act on it now (edit_file, or read a DIFFERENT range, or search for a name), instead of reading the same part again.",
      `If you really need the text once more, call tool_output with id "${was.callId}".`,
      ...(outline ? ["", outline] : []),
    ].join("\n");
  }

  /**
   * Records a read that ran.
   *
   * @param key - From {@link ReadMemo.key}.
   * @param file - The file's size and time when it was read.
   * @param callId - The tool call's id.
   * @param step - The step it ran at ({@link ReadMemo.tick}).
   */
  record(key: string, file: { size: number; mtimeMs: number }, callId: string, step: number): void {
    this.seen.set(key, { step, callId, size: file.size, mtimeMs: file.mtimeMs });
  }
}
