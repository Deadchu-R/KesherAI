/**
 * The smart log reader (Roee, 2026-11-24; research: RESEARCH_LOG "Smart log reader"). Read-only adapters for every
 * log KesherAI knows about, each read from its end with a size limit, parsed (log-parse.ts), searched
 * (log-search.ts) and grouped into patterns (log-patterns.ts). The user's labels on patterns, the files they added and
 * the patterns seen at their last look are kept in `logs/log-reader.json` in KesherAI's data folder.
 *
 * Sources: KesherAI's own log and faults, the usage log (when its file exists), the task inbox's and self-work's runs,
 * the engines' logs (llama.cpp, ComfyUI, the image engine), the found Unreal projects' editor logs, Unity's Editor.log
 * and Player.log files, and files the user adds (inside the home folder only, never key or password files).
 */
import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import { carriedTimes, parseLog, type LogEntry, type LogLevel } from "./log-parse.js";
import { groupPatterns, PATTERN_LABELS, templateMatches, type LogPattern, type PatternLabel } from "./log-patterns.js";
import { searchEntries, type LogQuery, type LogSearchResult } from "./log-search.js";
import { findProjectLog } from "./unreal-log.js";
import { editorLogPath } from "./unity-compile.js";

/** At most this much is read from the end of one log. */
export const READ_BYTES = 16 * 1024 * 1024;
/** A file larger than this cannot be added (a disk image or a database is not a log). */
export const MAX_ADDED_FILE_BYTES = 4 * 1024 ** 3;
/** The most files a user can add. */
export const MAX_ADDED_FILES = 40;
/** The most pattern ids remembered per source for "new since last look". */
const SEEN_MAX = 4000;

/** Where a source comes from (the page groups them so). */
export type LogSourceGroup = "kesher" | "agents" | "engines" | "unreal" | "unity" | "added";

/** A source as the page lists it. Paths are never sent: only a name, a group and the file's size and time. */
export interface LogSourceInfo {
  id: string;
  name: string;
  nameHe: string;
  group: LogSourceGroup;
  size?: number;
  modified?: number;
  /** An added file: the user can remove it from the list. */
  removable?: boolean;
}

/** What a source gives when read. */
export interface LogText {
  text: string;
  /** Older text was not read (the file is larger than {@link READ_BYTES}). */
  truncated: boolean;
}

/** One adapter. */
export interface LogSource {
  info: LogSourceInfo;
  /** A short key that changes when the content changes (size and time for a file), for the parse cache. */
  version: () => Promise<string>;
  read: () => Promise<LogText | undefined>;
}

/** What the reader needs from the server (injected, so it can be tested). */
export interface LogReaderDeps {
  /** KesherAI's data folder. */
  root: string;
  /** The user's home folder (added files must be inside it). */
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** The built-in engine's last lines (llama-server's output, in memory). */
  engineLog?: () => string[];
  /** ComfyUI's last lines (in memory). */
  comfyLog?: () => string[];
  /** The image engine's last-run log file. */
  sdLogFile?: () => string | undefined;
  /** The Unreal projects found on this computer. */
  unrealProjects?: () => Promise<Array<{ path: string; name: string }>>;
  now?: () => number;
}

interface SavedLabel {
  source: string;
  id: string;
  template: string;
  level: LogLevel;
  cat?: string;
  label: PatternLabel;
  at: number;
}

interface Store {
  files: Array<{ id: string; path: string }>;
  labels: SavedLabel[];
  seen: Record<string, string[]>;
}

/**
 * Reads the end of a file.
 *
 * @param file - The file.
 * @param max - The most bytes read (from the end).
 * @returns The text (a partial first line dropped when it starts in the middle) and whether older text was left out.
 */
export async function readTail(file: string, max = READ_BYTES): Promise<LogText> {
  const st = await stat(file);
  const start = Math.max(0, st.size - max);
  const handle = await open(file, "r");
  try {
    const buf = Buffer.alloc(st.size - start);
    const { bytesRead } = await handle.read(buf, 0, buf.length, start);
    let text = buf.subarray(0, bytesRead).toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return { text, truncated: start > 0 };
  } finally {
    await handle.close();
  }
}

/**
 * Whether a path is inside a folder (the same folder counts), on the given system's rules (Windows: any case, either
 * slash).
 *
 * @param folder - The folder.
 * @param file - The path to check (already resolved, no links).
 * @param platform - The system (default this one).
 */
export function isInside(folder: string, file: string, platform: NodeJS.Platform = process.platform): boolean {
    const p = platform === "win32" ? path.win32 : path.posix;
    const fix = (s: string) => (platform === "win32" ? s.toLowerCase() : s);
    const rel = p.relative(fix(p.resolve(folder)), fix(p.resolve(file)));
    return rel === "" || (!rel.startsWith("..") && !p.isAbsolute(rel));
  }
  
  /** A file path found in a log line, with optional line and column numbers. */
  export interface FileLink {
    /** The matched text in the original line. */
    match: string;
    /** The absolute path (resolved on Windows or POSIX). */
    file: string;
    /** The line number, when present. */
    line?: number;
    /** The column number, when present. */
    col?: number;
  }
  
  /**
   * Finds file paths in a log line and parses them into structured links. Supports:
   * - POSIX: `/home/user/file.ts:10` or `/home/user/file.ts:10:5`
   * - Windows: `C:\Users\me\file.cs(10,5)` or `C:/Users/me/file.cs:10`
   * - Relative paths are ignored (must be absolute to open safely).
   *
   * @param line - The log line text.
   * @returns An array of file links found, in order of appearance.
   */
  export function parseFileLinks(line: string): FileLink[] {
    const out: FileLink[] = [];
    // Match absolute POSIX paths with optional :line or :line:col
    const posixRe = /(\/[^\s:*?"<>|]+?)(?::(\d+)(?::(\d+))?)?(?=[)\]\s,;:'"`]|$)/g;
    // Match Windows drive-letter paths with (line,col) or :line or :line:col
    const winRe = /([A-Za-z]:\\[^\s:*?"<>|]+?)(?:\((\d+),(\d+)\)|:(\d+)(?::(\d+))?)?(?=[)\]\s,;:'"`]|$)/g;
    let m: RegExpExecArray | null;
    while ((m = posixRe.exec(line))) {
      const file = m[1];
      if (!file || !file.includes(".")) continue; // skip bare dirs
      out.push({ match: m[0], file, line: m[2] ? Number(m[2]) : undefined, col: m[3] ? Number(m[3]) : undefined });
    }
    while ((m = winRe.exec(line))) {
      const file = m[1];
      if (!file || !file.includes(".")) continue;
      const ln = m[2] ? Number(m[2]) : m[4] ? Number(m[4]) : undefined;
      const cl = m[3] ? Number(m[3]) : m[5] ? Number(m[5]) : undefined;
      out.push({ match: m[0], file, line: ln, col: cl });
    }
    // Sort by position in the original line to preserve order
    out.sort((a, b) => line.indexOf(a.match) - line.indexOf(b.match));
    return out;
  }
  
  /** File names never read: keys, passwords and settings that hold secrets. */
const SECRET_NAME = /(^\.env(\..*)?$)|(^id_[a-z0-9]+$)|\.(pem|key|p12|pfx|kdbx|keystore|jks)$|credential|secret|password|token|cookies?(\.sqlite)?$/i;

/**
 * Checks a file the user wants to add as a log source.
 *
 * @param file - The path typed on the computer.
 * @param home - The home folder.
 * @param platform - The system.
 * @returns The real path (links resolved).
 * @throws Error saying why it cannot be added (outside home, missing, a folder, a key file, too large, not text).
 */
export async function checkAddedFile(file: string, home: string, platform: NodeJS.Platform = process.platform): Promise<string> {
  const p = platform === "win32" ? path.win32 : path.posix;
  if (!file.trim() || !p.isAbsolute(file.trim())) throw new Error("Give the log file's full path.");
  const real = await realpath(file.trim()).catch(() => undefined);
  if (!real) throw new Error("No such file.");
  const realHome = await realpath(home).catch(() => home);
  if (!isInside(realHome, real, platform)) throw new Error("Only files inside your home folder can be added.");
  if (SECRET_NAME.test(p.basename(real))) throw new Error("This looks like a key or password file; it is never read.");
  const st = await stat(real);
  if (!st.isFile()) throw new Error("That is a folder, not a file.");
  if (st.size > MAX_ADDED_FILE_BYTES) throw new Error("The file is larger than 4 GB; this is not a log.");
  const handle = await open(real, "r");
  try {
    const head = Buffer.alloc(Math.min(4096, st.size));
    await handle.read(head, 0, head.length, 0);
    // UTF-16 logs (some Windows tools) have a BOM; other NUL bytes mean a binary file.
    const utf16 = head[0] === 0xff && head[1] === 0xfe;
    if (!utf16 && head.includes(0)) throw new Error("This is not a text file.");
  } finally {
    await handle.close();
  }
  return real;
}

/** A short id from a path or name (never the path itself, so ids can be shown and logged). */
const idOf = (prefix: string, key: string) => `${prefix}-${createHash("sha1").update(key).digest("hex").slice(0, 10)}`;

/** The text of an in-memory log (the version is its length and last line). */
function memorySource(info: LogSourceInfo, lines: () => string[]): LogSource {
  return {
    info,
    version: async () => {
      const l = lines();
      return `${l.length}:${createHash("sha1").update(l.slice(-3).join("\n")).digest("hex").slice(0, 8)}`;
    },
    read: async () => {
      const l = lines();
      return l.length ? { text: l.join("\n"), truncated: false } : undefined;
    },
  };
}

/** A file read from its end. */
async function fileSource(info: Omit<LogSourceInfo, "size" | "modified">, file: string, opts: { always?: boolean } = {}): Promise<LogSource | undefined> {
  const st = await stat(file).catch(() => undefined);
  if (!st?.isFile() && !opts.always) return undefined;
  return {
    info: { ...info, ...(st?.isFile() ? { size: st.size, modified: st.mtimeMs } : {}) },
    version: async () => {
      const s = await stat(file).catch(() => undefined);
      return s ? `${s.size}:${s.mtimeMs}` : "none";
    },
    read: async () => (await stat(file).catch(() => undefined))?.isFile() ? readTail(file) : undefined,
  };
}

/** A JSON file turned into JSON lines (the task inbox and self-work keep their runs in one JSON file). */
async function jsonSource(info: Omit<LogSourceInfo, "size" | "modified">, file: string, toLines: (data: unknown) => string[]): Promise<LogSource | undefined> {
  const st = await stat(file).catch(() => undefined);
  if (!st?.isFile()) return undefined;
  return {
    info: { ...info, size: st.size, modified: st.mtimeMs },
    version: async () => {
      const s = await stat(file).catch(() => undefined);
      return s ? `${s.size}:${s.mtimeMs}` : "none";
    },
    read: async () => {
      const data = JSON.parse(await readFile(file, "utf8").catch(() => "null")) as unknown;
      const lines = toLines(data);
      return lines.length ? { text: lines.join("\n"), truncated: false } : undefined;
    },
  };
}

type Json = Record<string, unknown>;
const line = (at: number | undefined, level: LogLevel, kind: string, message: string) => JSON.stringify({ at: at ? new Date(at).toISOString() : undefined, level, kind, message });
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown, max = 300) => (typeof v === "string" ? v.replace(/\s+/g, " ").slice(0, max) : "");

/**
 * The task inbox's runs as log lines: when each task started and how it ended, and the checks that failed.
 *
 * @param data - The contents of task-inbox.json.
 * @returns JSON lines, oldest first.
 */
export function inboxRunLines(data: unknown): string[] {
  const tasks = (data as { tasks?: unknown })?.tasks;
  if (!Array.isArray(tasks)) return [];
  const out: Array<[number, string]> = [];
  for (const raw of tasks as Json[]) {
    const id = str(raw.id, 60);
    const title = str(raw.title, 160);
    const by = str(raw.runBy, 30);
    const started = num(raw.startedAt);
    const ended = num(raw.endedAt);
    if (started) out.push([started, line(started, "info", "inbox", `${id} started on ${by || "?"}: ${title}`)]);
    if (ended) {
      const status = str(raw.status, 30);
      const level: LogLevel = status === "failed" ? "error" : ["partial", "skipped", "declined", "deferred-quota"].includes(status) ? "warning" : "info";
      const why = str(raw.note) || str(raw.summary);
      out.push([ended, line(ended, level, "inbox", `${id} ${status}: ${title}${why ? ` — ${why}` : ""}`)]);
      for (const c of Array.isArray(raw.checks) ? (raw.checks as Json[]) : []) {
        if (c.ok === false) out.push([ended, line(ended, "warning", "inbox", `${id} check failed: ${str(c.name, 80)} — ${str(c.note)}`)]);
      }
    }
  }
  return out.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
}

/**
 * The usage log's JSON lines (usage-log.ts) made readable: the event, task, model, reason and numbers in the message,
 * the executor as the category, and "suggestion" read as info.
 *
 * @param text - Lines of a usage-YYYY-MM-DD.jsonl file.
 * @returns JSON lines for the parser.
 */
export function usageLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let o: Json;
    try {
      o = JSON.parse(raw) as Json;
    } catch {
      continue;
    }
    if (!o || typeof o !== "object") continue;
    const nums = o.numbers && typeof o.numbers === "object" ? Object.entries(o.numbers as Record<string, unknown>).filter(([, v]) => typeof v === "number").map(([k, v]) => `${k}=${String(v)}`).join(" ") : "";
    const level: LogLevel = o.level === "error" ? "error" : o.level === "warning" ? "warning" : "info";
    const msg = [str(o.event, 30), str(o.task, 60), o.model ? `(${str(o.model, 80)})` : ""].filter(Boolean).join(" ") + (o.why ? `: ${str(o.why)}` : "") + (nums ? ` [${nums}]` : "") + (o.level === "suggestion" ? " (suggestion)" : "");
    out.push(JSON.stringify({ at: num(o.at) ? new Date(o.at as number).toISOString() : undefined, level, kind: str(o.executor, 40) || "usage", message: msg }));
  }
  return out;
}

/**
 * Self-work's run as log lines: its start, every item done or skipped, and how it ended.
 *
 * @param data - The contents of self-work.json (one run).
 * @returns JSON lines, oldest first.
 */
export function selfWorkLines(data: unknown): string[] {
  const r = data as Json | null;
  if (!r || typeof r !== "object") return [];
  const out: Array<[number, string]> = [];
  const started = num(r.startedAt);
  if (started) out.push([started, line(started, "info", "self-work", `started: ${str(r.goal, 200)}`)]);
  for (const it of Array.isArray(r.items) ? (r.items as Json[]) : []) {
    const at = num(it.at);
    if (at) out.push([at, line(at, "info", "self-work", `item done: ${str(it.text, 200)}${it.commit ? ` (${str(it.commit, 12)})` : ""}`)]);
  }
  for (const it of Array.isArray(r.skipped) ? (r.skipped as Json[]) : []) {
    const at = num(it.at);
    if (at) out.push([at, line(at, "warning", "self-work", `item skipped: ${str(it.why, 300)}`)]);
  }
  const status = str(r.status, 20);
  if (status && status !== "running") {
    const at = Math.max(started ?? 0, ...out.map((x) => x[0]));
    out.push([at, line(at || undefined, status === "failed" || status === "blocked" ? "error" : status === "stopped" ? "warning" : "info", "self-work", `${status}${r.note ? `: ${str(r.note)}` : ""}`)]);
  }
  return out.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
}

/**
 * Unity players' logs (`Player.log`) of games run on this computer: `<company>/<product>/Player.log` under Unity's
 * folder for the system (LocalLow on Windows).
 *
 * @param platform - The system.
 * @param env - The environment.
 * @param home - The home folder.
 * @returns Up to 20 logs, newest first.
 */
export async function unityPlayerLogs(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<Array<{ file: string; name: string; modified: number }>> {
  const base = platform === "win32" ? join(env.USERPROFILE || home, "AppData", "LocalLow") : platform === "darwin" ? join(home, "Library", "Logs") : join(home, ".config", "unity3d");
  const found: Array<{ file: string; name: string; modified: number }> = [];
  const companies = (await readdir(base, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).slice(0, 200);
  for (const c of companies) {
    const products = (await readdir(join(base, c.name), { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).slice(0, 50);
    for (const p of products) {
      const file = join(base, c.name, p.name, "Player.log");
      const st = await stat(file).catch(() => undefined);
      if (st?.isFile()) found.push({ file, name: p.name, modified: st.mtimeMs });
    }
  }
  return found.sort((a, b) => b.modified - a.modified).slice(0, 20);
}

/** The reader: its sources, a small parse cache, and the user's labels. */
export class LogReader {
  private readonly cache = new Map<string, { version: string; entries: LogEntry[]; truncated: boolean }>();
  private store: Store | undefined;
  private saving: Promise<void> = Promise.resolve();

  /** @param deps - Where KesherAI's files are, and the engines' in-memory logs. */
  constructor(private readonly deps: LogReaderDeps) {}

  private get file(): string {
    return join(this.deps.root, "logs", "log-reader.json");
  }

  private async load(): Promise<Store> {
    if (this.store) return this.store;
    let s: Partial<Store> = {};
    try {
      s = JSON.parse(await readFile(this.file, "utf8")) as Partial<Store>;
    } catch {
      // No file yet, or a damaged one: start again.
    }
    this.store = { files: Array.isArray(s.files) ? s.files : [], labels: Array.isArray(s.labels) ? s.labels : [], seen: s.seen && typeof s.seen === "object" ? s.seen : {} };
    return this.store;
  }

  private save(): Promise<void> {
    const data = JSON.stringify(this.store, null, 1);
    this.saving = this.saving.then(async () => {
      await mkdir(join(this.deps.root, "logs"), { recursive: true });
      await writeFile(this.file, data);
    }).catch(() => undefined);
    return this.saving;
  }

  /** Every source there is now (files that do not exist are left out). */
  async sources(): Promise<LogSource[]> {
    const { root } = this.deps;
    const logs = join(root, "logs");
    const out: Array<LogSource | undefined> = [];
    out.push(await fileSource({ id: "kesher-main", name: "KesherAI log", nameHe: "היומן של KesherAI", group: "kesher" }, join(logs, "main.log"), { always: true }));
    out.push(await fileSource({ id: "kesher-faults", name: "KesherAI faults", nameHe: "התקלות של KesherAI", group: "kesher" }, join(logs, "faults.jsonl")));
    // The usage log (usage-log.ts: one file a day in usage-log/): today's file, its lines made readable.
    const usageDir = join(root, "usage-log");
    const usageFile = (await readdir(usageDir).catch(() => [] as string[])).filter((f) => /^usage-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().at(-1);
    if (usageFile) {
      const s = await fileSource({ id: "usage", name: "Usage log", nameHe: "יומן השימוש", group: "kesher" }, join(usageDir, usageFile));
      if (s) out.push({ ...s, read: async () => {
        const t = await s.read();
        return t && { ...t, text: usageLines(t.text).join("\n") };
      } });
    }
    const updates = (await readdir(logs).catch(() => [] as string[])).filter((f) => /^update-.*\.log$/.test(f)).sort().at(-1);
    if (updates) out.push(await fileSource({ id: "kesher-update", name: "Last update", nameHe: "העדכון האחרון", group: "kesher" }, join(logs, updates)));
    out.push(await jsonSource({ id: "inbox-runs", name: "Task inbox runs", nameHe: "הרצות תיבת המשימות", group: "agents" }, join(root, "task-inbox.json"), inboxRunLines));
    out.push(await jsonSource({ id: "self-work", name: "Self-work", nameHe: "עבודה עצמית", group: "agents" }, join(root, "self-work.json"), selfWorkLines));
    if (this.deps.engineLog) out.push(memorySource({ id: "engine-llama", name: "Chat engine (llama.cpp)", nameHe: "מנוע הצ'אט (llama.cpp)", group: "engines" }, this.deps.engineLog));
    if (this.deps.comfyLog) out.push(memorySource({ id: "engine-comfy", name: "ComfyUI", nameHe: "ComfyUI", group: "engines" }, this.deps.comfyLog));
    const sd = this.deps.sdLogFile?.();
    if (sd) out.push(await fileSource({ id: "engine-sd", name: "Image engine (last run)", nameHe: "מנוע התמונות (הרצה אחרונה)", group: "engines" }, sd));
    out.push(await fileSource({ id: "unity-cli", name: "Unity (KesherAI's runs)", nameHe: "Unity (הרצות של KesherAI)", group: "unity" }, join(logs, "unity-cli.log")));
    for (const p of (await this.deps.unrealProjects?.().catch(() => [])) ?? []) {
      const log = await findProjectLog(p.path, p.name).catch(() => undefined);
      if (log) out.push(await fileSource({ id: idOf("unreal", p.path), name: `Unreal · ${p.name}`, nameHe: `Unreal · ${p.name}`, group: "unreal" }, join(p.path, "Saved", "Logs", log.file)));
    }
    const platform = this.deps.platform ?? process.platform;
    const env = this.deps.env ?? process.env;
    const home = this.deps.home ?? homedir();
    out.push(await fileSource({ id: "unity-editor", name: "Unity Editor", nameHe: "עורך Unity", group: "unity" }, editorLogPath(platform, env, home)));
    for (const p of await unityPlayerLogs(platform, env, home)) out.push(await fileSource({ id: idOf("unity-player", p.file), name: `Unity player · ${p.name}`, nameHe: `משחק Unity · ${p.name}`, group: "unity" }, p.file));
    for (const f of (await this.load()).files) {
      const s = await fileSource({ id: f.id, name: path.basename(f.path), nameHe: path.basename(f.path), group: "added", removable: true }, f.path, { always: true });
      out.push(s);
    }
    return out.filter((s): s is LogSource => !!s);
  }

  /** The sources' list for the page. */
  async list(): Promise<LogSourceInfo[]> {
    return (await this.sources()).map((s) => s.info);
  }

  private async source(id: string): Promise<LogSource> {
    const s = (await this.sources()).find((x) => x.info.id === id);
    if (!s) throw Object.assign(new Error("No such log source."), { statusCode: 404 });
    return s;
  }

  /**
   * A source's entries, parsed once per change (the last few are cached).
   *
   * @param id - The source's id.
   */
  async entries(id: string): Promise<{ source: LogSourceInfo; entries: LogEntry[]; truncated: boolean }> {
    const s = await this.source(id);
    const version = await s.version();
    const hit = this.cache.get(id);
    if (hit && hit.version === version) return { source: s.info, entries: hit.entries, truncated: hit.truncated };
    const text = await s.read();
    const entries = text ? parseLog(text.text) : [];
    const truncated = !!text?.truncated;
    this.cache.delete(id);
    this.cache.set(id, { version, entries, truncated });
    while (this.cache.size > 6) this.cache.delete(this.cache.keys().next().value!);
    return { source: s.info, entries, truncated };
  }

  /**
   * Searches a source.
   *
   * @param id - The source's id.
   * @param q - The query (log-search.ts).
   */
  async search(id: string, q: LogQuery): Promise<LogSearchResult & { source: LogSourceInfo; total: number; readTruncated: boolean; cats: string[] }> {
    const { source, entries, truncated } = await this.entries(id);
    const cats = [...new Set(entries.map((e) => e.cat).filter((c): c is string => !!c))].sort().slice(0, 200);
    return { ...searchEntries(entries, q), source, total: entries.length, readTruncated: truncated, cats };
  }

  /**
   * A source's patterns, with the user's labels applied and the ones not seen at the last look marked new. The
   * call is the look: the patterns returned are remembered as seen (the first look marks none as new).
   *
   * @param id - The source's id.
   * @param opts.levels - Only these levels.
   * @param opts.since - Only lines from this time (ms).
   * @param opts.look - Remember these patterns as seen (default true).
   */
  async patterns(id: string, opts: { levels?: readonly LogLevel[]; since?: number; look?: boolean } = {}): Promise<{ source: LogSourceInfo; patterns: LogPattern[]; total: number; readTruncated: boolean }> {
    const { source, entries, truncated } = await this.entries(id);
    let list = entries;
    let times = carriedTimes(entries);
    if (opts.levels?.length || opts.since !== undefined) {
      const keep = entries.map((e, i) => (!opts.levels?.length || opts.levels.includes(e.level)) && (opts.since === undefined || (times[i] ?? -1) >= opts.since));
      list = entries.filter((_, i) => keep[i]);
      times = times.filter((_, i) => keep[i]);
    }
    const patterns = groupPatterns(id, list, times);
    const store = await this.load();
    const labels = store.labels.filter((l) => l.source === id);
    const seen = store.seen[id];
    const seenSet = new Set(seen ?? []);
    for (const p of patterns) {
      const l = labels.find((x) => x.id === p.id) ?? labels.find((x) => x.level === p.level && (x.cat ?? "") === (p.cat ?? "") && templateMatches(x.template, p.template));
      if (l) p.label = l.label;
      if (seen && !seenSet.has(p.id)) p.isNew = true;
    }
    if (opts.look !== false) {
      store.seen[id] = [...new Set([...(seen ?? []), ...patterns.map((p) => p.id)])].slice(-SEEN_MAX);
      void this.save();
    }
    return { source, patterns, total: list.length, readTruncated: truncated };
  }

  /**
   * One pattern and its lines (with their stack traces).
   *
   * @param id - The source's id.
   * @param patternId - The pattern's id.
   * @param limit - The most lines (the newest).
   */
  async patternLines(id: string, patternId: string, limit = 50): Promise<{ pattern: LogPattern; entries: LogEntry[] } | undefined> {
    const { patterns } = await this.patterns(id, { look: false });
    const pattern = patterns.find((p) => p.id === patternId);
    if (!pattern) return undefined;
    const { entries } = await this.entries(id);
    const want = new Set(pattern.lines.slice(-Math.max(1, Math.min(200, limit))));
    return { pattern, entries: entries.filter((e) => want.has(e.n)) };
  }

  /**
   * Sets or clears a pattern's label (kept and applied the next time, also when the template grows more `<*>`).
   *
   * @param id - The source's id.
   * @param patternId - The pattern's id.
   * @param label - The label, or null to clear it.
   * @returns False when the pattern is not in the source now.
   */
  async setLabel(id: string, patternId: string, label: PatternLabel | null): Promise<boolean> {
    if (label !== null && !PATTERN_LABELS.includes(label)) throw Object.assign(new Error("Unknown label."), { statusCode: 400 });
    const { patterns } = await this.patterns(id, { look: false });
    const p = patterns.find((x) => x.id === patternId);
    if (!p) return false;
    const store = await this.load();
    store.labels = store.labels.filter((l) => !(l.source === id && (l.id === p.id || (l.level === p.level && (l.cat ?? "") === (p.cat ?? "") && templateMatches(l.template, p.template)))));
    if (label) store.labels.push({ source: id, id: p.id, template: p.template, level: p.level, ...(p.cat ? { cat: p.cat } : {}), label, at: (this.deps.now ?? Date.now)() });
    store.labels = store.labels.slice(-2000);
    await this.save();
    return true;
  }

  /**
   * Adds a file as a source (the caller allows this only on the computer itself).
   *
   * @param file - Its full path.
   * @returns The new source's info.
   */
  async addFile(file: string): Promise<LogSourceInfo> {
    const real = await checkAddedFile(file, this.deps.home ?? homedir(), this.deps.platform ?? process.platform);
    const store = await this.load();
    const id = idOf("file", real);
    if (!store.files.some((f) => f.id === id)) {
      if (store.files.length >= MAX_ADDED_FILES) throw new Error(`At most ${MAX_ADDED_FILES} files can be added; remove one first.`);
      store.files.push({ id, path: real });
      await this.save();
    }
    return (await this.source(id)).info;
  }

  /**
   * Removes an added file from the list (the file itself is not touched).
   *
   * @param id - The source's id.
   * @returns Whether it was in the list.
   */
  async removeFile(id: string): Promise<boolean> {
    const store = await this.load();
    const before = store.files.length;
    store.files = store.files.filter((f) => f.id !== id);
    if (store.files.length === before) return false;
    store.labels = store.labels.filter((l) => l.source !== id);
    delete store.seen[id];
    this.cache.delete(id);
    await this.save();
    return true;
  }

  /**
   * The error patterns of the last hour across the sources written to in that hour, for "summarize the errors".
   *
   * @param ms - How far back (default one hour).
   * @returns Up to 25 patterns (not the ignored ones) with their source's name.
   */
  async recentErrors(ms = 3_600_000): Promise<Array<LogPattern & { sourceName: string }>> {
    const since = (this.deps.now ?? Date.now)() - ms;
    const out: Array<LogPattern & { sourceName: string }> = [];
    for (const s of await this.sources()) {
      if (s.info.modified !== undefined && s.info.modified < since) continue;
      const { patterns } = await this.patterns(s.info.id, { levels: ["error"], since, look: false }).catch(() => ({ patterns: [] as LogPattern[] }));
      out.push(...patterns.filter((p) => p.label !== "ignore").map((p) => ({ ...p, sourceName: s.info.name })));
    }
    return out.sort((a, b) => b.count - a.count).slice(0, 25);
  }
}

const SYSTEM_HE = "אתה עוזר למפתח להבין יומנים (לוגים). ענה בעברית, קצר וברור: מה זה אומר, הסיבה הסבירה, מה לבדוק או לתקן, והאם זה בטוח להתעלם. אל תמציא פרטים שלא בשורות.";
const SYSTEM_EN = "You help a developer understand logs. Answer in English, short and clear: what it means, the likely cause, what to check or fix, and whether it is safe to ignore. Do not invent details that are not in the lines.";

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}\n…` : s);
const when = (t?: number) => (t ? new Date(t).toISOString().replace("T", " ").slice(0, 19) : "?");

/**
 * The model's instructions and question for "Explain this pattern".
 *
 * @param sourceName - The log's name.
 * @param p - The pattern.
 * @param lines - A few of its lines (newest last), with their stack traces.
 * @param he - Answer in Hebrew.
 */
export function explainPrompt(sourceName: string, p: LogPattern, lines: readonly LogEntry[], he: boolean): { system: string; user: string } {
  const shown = lines.slice(-5).map((e) => [e.msg, ...(e.extra ?? []).slice(0, 25)].join("\n"));
  const user = [
    `Log: ${sourceName}`,
    `Pattern (${p.level}${p.cat ? `, ${p.cat}` : ""}): ${p.template}`,
    `Seen ${p.count} times, first ${when(p.first)}, last ${when(p.last)}${p.rising ? ", rising" : ""}.`,
    "Examples:",
    clip(shown.join("\n---\n"), 6000),
  ].join("\n");
  return { system: he ? SYSTEM_HE : SYSTEM_EN, user };
}

/**
 * The model's instructions and question for "Summarize the errors of the last hour".
 *
 * @param list - The error patterns (log-reader recentErrors).
 * @param he - Answer in Hebrew.
 */
export function summaryPrompt(list: ReadonlyArray<LogPattern & { sourceName: string }>, he: boolean): { system: string; user: string } {
  const rows = list.map((p) => `- [${p.sourceName}] ×${p.count}${p.rising ? " (rising)" : ""}${p.label ? ` (marked ${p.label})` : ""}: ${clip(p.sample, 300)}`);
  const ask = he ? "סכם את השגיאות האלה מהשעה האחרונה: מה החשוב ביותר, מה קשור למה, ומה לעשות קודם. עד 8 שורות." : "Summarize these errors from the last hour: what matters most, what is related, and what to do first. At most 8 lines.";
  return { system: he ? SYSTEM_HE : SYSTEM_EN, user: `${ask}\n\n${clip(rows.join("\n"), 8000)}` };
}

/** A log entry tagged with its source name, for merged views. */
export interface MergedLogEntry extends LogEntry {
  /** The log source this entry came from. */
  sourceName: string;
}

/**
 * Merges parsed log entries from multiple sources into one time-ordered list.
 * Entries without a timestamp are placed at the end, preserving their relative order.
 *
 * @param sources - Map of source name to its parsed log entries.
 * @returns The merged entries, sorted by timestamp ascending.
 */
export function mergeLogs(sources: ReadonlyMap<string, readonly LogEntry[]>): MergedLogEntry[] {
  const all: MergedLogEntry[] = [];
  for (const [name, entries] of sources) {
    for (const e of entries) {
      all.push({ ...e, sourceName: name });
    }
  }
  all.sort((a, b) => {
    if (a.t === undefined && b.t === undefined) return 0;
    if (a.t === undefined) return 1;
    if (b.t === undefined) return -1;
    return a.t - b.t;
  });
  return all;
}
