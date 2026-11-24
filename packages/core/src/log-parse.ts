/**
 * The smart log reader's parser (Roee, 2026-11-24; research: RESEARCH_LOG "Smart log reader"). Turns a log's text
 * into entries with a time, a level, a category and a message, the way lnav and Unreal's Output Log read them:
 * - Unreal: `[2026.11.24-10.00.00:123][ 42]LogBlueprint: Error: message` (and `LogInit: Display: …` without a time);
 * - ISO-time logs: `2026-11-24T10:00:00.000Z message`, `2026-11-24 10:00:00,123 - name - ERROR - message`;
 * - JSON lines: `{"at": "…", "level": "error", "kind": "server", "message": "…"}` (KesherAI's faults and usage logs);
 * - anything else: one entry per line, its level guessed from words such as "error" or "warning".
 * A stack trace stays with the line it belongs to (indented lines, `at …`, `File "…"`, Unity's `(at Assets/x.cs:12)`).
 */

/** The four levels every source is mapped to. */
export type LogLevel = "error" | "warning" | "info" | "debug";

/** All levels, worst first. */
export const LOG_LEVELS: readonly LogLevel[] = ["error", "warning", "info", "debug"];

/** One parsed entry: a line and the lines that belong to it. */
export interface LogEntry {
  /** Its first line's number in the text read (1-based). */
  n: number;
  /** When it was written (ms since 1970), when the line says. */
  t?: number;
  level: LogLevel;
  /** The category or logger (Unreal's `LogBlueprint`, a JSON line's `kind`), when there is one. */
  cat?: string;
  /** The message, without the time, level and category. */
  msg: string;
  /** Lines that belong to it (a stack trace), at most {@link MAX_EXTRA_LINES}. */
  extra?: string[];
}

/** The most continuation lines kept with one entry (a longer trace is cut, with a line saying how many were left). */
export const MAX_EXTRA_LINES = 60;
/** The longest message kept (a minified JSON blob on one line is cut). */
export const MAX_MESSAGE_CHARS = 4000;

const UNREAL_TIMED = /^\[(\d{4})\.(\d\d)\.(\d\d)-(\d\d)\.(\d\d)\.(\d\d):(\d{3})\]\[\s*\d+\](.*)$/;
const UNREAL_BODY = /^(Log\w+|PIE|Cmd|LogTemp):\s+(?:(Fatal|Error|Warning|Display|Log|Verbose|VeryVerbose):\s+)?(.*)$/;
const ISO_TIME = /^\[?(\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d{1,9})?(?:Z|[+-]\d\d:?\d\d)?)\]?\s*(.*)$/;
/** A level word at the start of the rest of the line: `ERROR msg`, `[warn] msg`, `E: msg`, `- name - ERROR - msg`. */
const LEVEL_HEAD = /^(?:-\s+([\w.\-/]+)\s+-\s+)?[[(<]?(FATAL|CRITICAL|ERROR|ERR|WARNING|WARN|INFO|NOTICE|DEBUG|TRACE|VERBOSE)[\])>]?(?::\s*|\s+-\s+|\s+|$)(.*)$/i;
/** A single level letter counts only with a clear mark: `E: msg`, `[W] msg` (so "I think" is not a level). */
const LEVEL_LETTER = /^(?:([EWID]):\s+|\[([EWID])\]\s*)(.*)$/;
const CONTINUATION = /^(?:\s+\S|\s*at [\w$.<>[\]/\\:-]+|\s*Caused by:|\s*\.\.\. \d+ more|Traceback \(most recent call last\)|\s*File ".*", line \d+)/;
/** Unity's stack frames: `Foo.Bar () (at Assets/Foo.cs:12)` and `UnityEngine.Debug:Log (object)`. */
const UNITY_FRAME = /(?:\(at [^)]+:\d+\)\s*$)|^[\w.<>`+]+:[\w<>`.]+ ?\([^)]*\)\s*$/;
const ERROR_WORDS = /\w+(?:exception|error)\b|\b(?:error|errors?:|exception|fatal|panic|traceback|unhandled|crash(?:ed)?|failed|failure|assert(?:ion)? failed)\b/i;
const WARNING_WORDS = /\b(?:warn(?:ing)?|deprecated)\b/i;

/**
 * Maps a level word from any log to one of the four levels.
 *
 * @param word - E.g. `Error`, `WARN`, `Display`, `50` (pino's numbers), `E`.
 * @returns The level, or undefined when the word is not one.
 */
export function levelOf(word: string | number | undefined): LogLevel | undefined {
  if (word === undefined || word === null) return undefined;
  if (typeof word === "number") return word >= 50 ? "error" : word >= 40 ? "warning" : word >= 30 ? "info" : "debug";
  const w = String(word).trim().toLowerCase();
  if (/^\d+$/.test(w)) return levelOf(Number(w));
  if (["fatal", "critical", "crit", "error", "err", "e", "severe", "alert", "emerg", "emergency"].includes(w)) return "error";
  if (["warning", "warn", "w"].includes(w)) return "warning";
  if (["info", "information", "notice", "display", "log", "i", "message"].includes(w)) return "info";
  if (["debug", "trace", "verbose", "veryverbose", "d", "fine", "finer"].includes(w)) return "debug";
  return undefined;
}

/** A level from the words in a message, for lines that do not name one. */
function guessLevel(text: string): LogLevel {
  if (ERROR_WORDS.test(text) && !/\b0 errors?\b|\bno errors?\b|\bwithout errors?\b/i.test(text)) return "error";
  if (WARNING_WORDS.test(text) && !/\b0 warnings?\b|\bno warnings?\b/i.test(text)) return "warning";
  return "info";
}

const cut = (s: string) => (s.length > MAX_MESSAGE_CHARS ? `${s.slice(0, MAX_MESSAGE_CHARS)}…` : s);

/** A time string as ms since 1970 (`2026-11-24 10:00:00,123` too), or undefined. */
function timeOf(s: string): number | undefined {
  const t = Date.parse(s.replace(" ", "T").replace(",", "."));
  return Number.isFinite(t) ? t : undefined;
}

/** A JSON line's entry, or undefined when the line is not a JSON object. */
function parseJsonLine(line: string): Omit<LogEntry, "n"> | undefined {
  if (!line.startsWith("{") || !line.endsWith("}")) return undefined;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return undefined;
  const pick = (...keys: string[]) => keys.map((k) => o[k]).find((v) => v !== undefined && v !== null && v !== "");
  const when = pick("at", "time", "ts", "timestamp", "@t", "date");
  const t = typeof when === "number" ? (when < 1e12 ? when * 1000 : when) : typeof when === "string" ? timeOf(when) : undefined;
  const rawMsg = pick("message", "msg", "text", "@m", "@mt", "event", "summary");
  const cat = pick("kind", "source", "logger", "category", "where", "name", "executor");
  const msg = typeof rawMsg === "string" ? rawMsg : JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k]) => !["at", "time", "ts", "timestamp", "level"].includes(k))));
  const lvlRaw = pick("level", "severity", "lvl", "@l", "status");
  const level = levelOf(lvlRaw as string | number | undefined) ?? (o.ok === false || o.error ? "error" : guessLevel(msg));
  return { ...(t !== undefined ? { t } : {}), level, ...(typeof cat === "string" && cat.length <= 80 ? { cat } : {}), msg: cut(msg) };
}

/** The level, category and message of the text after a line's time (or of a line without one). */
function parseBody(body: string): { level?: LogLevel; cat?: string; msg: string } {
  const ue = UNREAL_BODY.exec(body);
  if (ue) return { cat: ue[1]!, level: ue[2] ? levelOf(ue[2])! : guessLevel(ue[3]!), msg: ue[3]! };
  const lv = LEVEL_HEAD.exec(body);
  if (lv) return { level: levelOf(lv[2])!, ...(lv[1] ? { cat: lv[1] } : {}), msg: lv[3]! };
  const letter = LEVEL_LETTER.exec(body);
  if (letter) return { level: levelOf(letter[1] ?? letter[2])!, msg: letter[3]! };
  return { msg: body };
}

/**
 * Parses a log's text into entries.
 *
 * @param text - The text read (from the end of the file; the caller drops a partial first line).
 * @param opts.firstLine - The number of the first line (default 1).
 * @param opts.maxEntries - Keep at most this many (the newest), default 200 000.
 * @returns The entries, oldest first.
 */
export function parseLog(text: string, opts: { firstLine?: number; maxEntries?: number } = {}): LogEntry[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const out: LogEntry[] = [];
  const first = opts.firstLine ?? 1;
  let last: LogEntry | undefined;
  let dropped = 0;
  const attach = (line: string) => {
    const extra = (last!.extra ??= []);
    if (extra.length < MAX_EXTRA_LINES) extra.push(cut(line));
    else dropped++;
  };
  const close = () => {
    if (last && dropped) last.extra!.push(`… ${dropped} more lines`);
    dropped = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const n = first + i;
    let entry: LogEntry | undefined;
    const ue = UNREAL_TIMED.exec(line);
    if (ue) {
      // Unreal writes its times in UTC unless the project says otherwise.
      const t = Date.UTC(+ue[1]!, +ue[2]! - 1, +ue[3]!, +ue[4]!, +ue[5]!, +ue[6]!, +ue[7]!);
      const b = parseBody(ue[8]!);
      entry = { n, t, level: b.level ?? guessLevel(b.msg), ...(b.cat ? { cat: b.cat } : {}), msg: cut(b.msg) };
    } else {
      const js = parseJsonLine(line.trim());
      if (js) entry = { n, ...js };
      else {
        const iso = ISO_TIME.exec(line);
        const t = iso ? timeOf(iso[1]!) : undefined;
        if (iso && t !== undefined) {
          const b = parseBody(iso[2]!);
          entry = { n, t, level: b.level ?? guessLevel(b.msg), ...(b.cat ? { cat: b.cat } : {}), msg: cut(b.msg) };
        } else if (last && (CONTINUATION.test(line) || UNITY_FRAME.test(line) || (last.t !== undefined && parseBody(line.trim()).level === undefined && !UNREAL_BODY.test(line)))) {
          // A stack trace or a message's next line: kept with the entry above (in a log whose lines have times, a
          // line without one belongs to the line before it).
          attach(line);
          continue;
        } else {
          const b = parseBody(line.trim());
          entry = { n, level: b.level ?? guessLevel(b.msg), ...(b.cat ? { cat: b.cat } : {}), msg: cut(b.msg) };
        }
      }
    }
    close();
    out.push(entry);
    last = entry;
  }
  close();
  const max = opts.maxEntries ?? 200_000;
  return out.length > max ? out.slice(-max) : out;
}

/**
 * The time each entry is taken to have for filters: its own, else the one before it (lines without a time between
 * timed lines were written then).
 *
 * @param entries - Parsed entries, oldest first.
 * @returns One time (or undefined before the first timed line) per entry.
 */
export function carriedTimes(entries: readonly LogEntry[]): Array<number | undefined> {
  let t: number | undefined;
  return entries.map((e) => (t = e.t ?? t));
}
