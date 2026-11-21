import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { appendFile, writeFile as writeText } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { batchFiles, engineChangedAt, nodeSig, sortForSync, unityAssetFile, type ClashChoice, type SyncBatch, type SyncReport } from "./game-sync.js";
import type { BlueprintJson, QueuedEdit } from "./unreal-bridge.js";
import { applyVsOps, COMMON_UNITS, diffVsGraphs, searchUnits, type VsDiff, type VsDoc, type VsOp, type VsResult, type VsUnit } from "@kesher/shared";

/** The file a graph's saved copy is kept in. */
const graphFile = (path: string) => `${createHash("sha256").update(path).digest("hex").slice(0, 24)}.json`;

/**
 * Whether two folders are the same project folder (case-insensitive on Windows).
 *
 * @param a - One folder.
 * @param b - The other.
 */
export const sameFolder = (a: string, b: string): boolean => (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

/** Reads a JSON file, or undefined when it is missing or broken. */
function readJsonFile<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Writes a JSON file, making its folder first. */
function writeJsonFile(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

/**
 * Unity through its own CLI (`unity`, from unity.com) and the project's
 * Pipeline package, with the KesherAI Bridge package's commands
 * (`kesher_list`, `kesher_graph`, `kesher_apply`, …).
 *
 * - **Unity open:** each call goes to the open editor
 *   (`unity command kesher_graph --path …`), in well under a second.
 * - **Unity closed:** the same command runs in a one-shot batch editor
 *   (`unity run <project> --command kesher_graph -- --path …`); slower, but
 *   the change is real and saved, with nothing waiting in a queue.
 *
 * KesherAI keeps the list of Unity projects the user added.
 */

/** The `unity` settings in config.json. */
export interface UnityConfig {
  /** Project folders the user added. */
  projects: string[];
  /** The one the page shows. */
  active?: string;
}

/** What running the CLI returned. */
export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `unity` with arguments (replaceable in tests). */
export type CliRunner = (args: string[], timeoutMs: number) => Promise<CliRun>;

let pathCache: { at: number; value: string } | undefined;
/**
 * PATH with the user's current PATH from the registry added (Windows): the
 * CLI's installer adds itself there, and KesherAI, started before, would not
 * see it until restarted. Read at most once a minute.
 */
export function freshPath(): string {
  const base = process.env.PATH ?? process.env.Path ?? "";
  if (process.platform !== "win32") return [join(homedir(), ".local", "bin"), join(homedir(), ".unity", "bin"), base].join(":");
  if (pathCache && Date.now() - pathCache.at < 60_000) return pathCache.value;
  let user = "";
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Environment", "/v", "Path"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    user = /Path\s+REG_(?:EXPAND_)?SZ\s+(.+)/i.exec(out)?.[1]?.trim() ?? "";
    user = user.replace(/%([^%]+)%/g, (_, v: string) => process.env[v] ?? `%${v}%`);
  } catch {
    // no user PATH
  }
  const seen = new Set(base.split(";").map((x) => x.toLowerCase()));
  // Where Unity's installer puts unity.exe (install.ps1: %LOCALAPPDATA%\Unity\bin, or UNITY_CLI_HOME\bin).
  const own = [process.env.UNITY_CLI_HOME ? join(process.env.UNITY_CLI_HOME, "bin") : "", process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Unity", "bin") : ""];
  const extra = [...user.split(";"), ...own].filter((x) => x && !seen.has(x.toLowerCase()));
  const value = [base, ...extra].filter(Boolean).join(";");
  pathCache = { at: Date.now(), value };
  return value;
}

/**
 * Opens a visible PowerShell window (Windows) running `command`, through
 * `start`, which always makes a new console even from a windowless app.
 * The command must not contain double quotes (callers pass fixed text).
 */
function openConsole(title: string, command: string): void {
  if (/["\r\n]/.test(command) || /["\r\n]/.test(title)) throw new Error("Bad console command.");
  spawn("cmd.exe", ["/d", "/s", "/c", `start "${title}" powershell.exe -NoProfile -NoExit -Command "${command}"`], { windowsVerbatimArguments: true, detached: true, stdio: "ignore", windowsHide: true }).unref();
}

/** Every CLI call is written here (when set), so the user can watch it live in a console window. */
let cliLogFile: string | undefined;
const logLine = (line: string) => {
  if (cliLogFile) void appendFile(cliLogFile, `${line}\n`).catch(() => undefined);
};
const shown = (args: string[]) => args.map((a) => (a.length > 160 ? `${a.slice(0, 160)}…(${a.length} chars)` : /\s/.test(a) ? `"${a}"` : a)).join(" ");

const realRunner: CliRunner = (args, timeoutMs) => {
  const started = Date.now();
  const at = new Date().toLocaleTimeString();
  // Quick checks (version, editor list) are not shown: the page asks them every few seconds.
  const quiet = args[0] === "--version" || (args[0] === "editors" && args[1] === "--installed") || (args[0] === "status" && args.includes("--format"));
  if (!quiet) logLine(`\n[${at}] > unity ${shown(args)}   (running…)`);
  return realRun(args, timeoutMs).then((r) => {
    if (quiet) return r;
    const out = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.trim();
    // One block per finished command, so commands running at the same time do not mix.
    logLine(`[${at}] < unity ${shown(args.slice(0, 3))} …\n${out.length > 3000 ? `${out.slice(0, 3000)}\n… (${out.length - 3000} more characters)` : out}\n[exit ${r.code}, ${((Date.now() - started) / 1000).toFixed(1)} s]`);
    return r;
  });
};

const realRun: CliRunner = (args, timeoutMs) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      const PATH = freshPath();
      child = spawn("unity", ["--no-banner", "--non-interactive", ...args], { windowsHide: true, env: { ...process.env, PATH, ...(process.platform === "win32" ? { Path: PATH } : {}), UNITY_NO_AGENT_HINTS: "1", UNITY_NO_UPDATE_CHECK: "1" } });
    } catch (err) {
      return resolve({ code: -1, stdout: "", stderr: (err as Error).message });
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: (err as NodeJS.ErrnoException).code === "ENOENT" ? "ENOENT" : err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });

/** Reads the value our command returned, from `--result-only` JSON or a batch run's ndjson. */
export function readResult(stdout: string): unknown {
  const unwrap = (v: unknown): unknown => (typeof v === "string" && /^\s*[{[]/.test(v) ? JSON.parse(v) : v);
  const text = stdout.trim();
  try {
    const whole = JSON.parse(text) as unknown;
    if (!(whole && typeof whole === "object" && (whole as { type?: unknown }).type === "result")) return unwrap(whole);
  } catch {
    // ndjson: the editor's own log lines, then a terminal {"type":"result"} frame
  }
  const frames = text
    .split(/\r?\n/)
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  const result = [...frames].reverse().find((f) => f.type === "result") ?? frames.at(-1);
  if (!result) throw new Error("Unity's CLI answered nothing readable.");
  if (result.success === false) {
    const e = (result.errors as Array<{ message?: string }> | undefined)?.[0];
    throw new Error(e?.message ?? "Unity's CLI reported a failure.");
  }
  const data = (result.data ?? result.result ?? result) as Record<string, unknown> | string;
  if (typeof data === "string") return unwrap(data);
  return unwrap(data.result ?? data.value ?? data);
}

/** The waits between `unity status` checks while the Editor reloads (about a minute in all). */
const RELOAD_WAITS = [1000, 2000, 4000, 8000, 15_000, 15_000, 15_000];

/**
 * Whether a failed Editor command means "busy, try again": the Editor was reloading its scripts, compiling or
 * starting (the CLI's exit 17 UNAVAILABLE, a streamed command's 102, or EDITOR_NOT_READY).
 *
 * @param r - The run.
 */
export function isReloading(r: CliRun): boolean {
  if (r.code === 0) return false;
  if (r.code === 17 || r.code === 102) return true;
  return /EDITOR_NOT_READY|"UNAVAILABLE"|domain reload|is (re)?loading|is compiling|reloading (its )?(scripts|assemblies|the domain)/i.test(`${r.stdout}\n${r.stderr}`);
}

/** An error from the CLI's JSON envelope, in plain words. */
function failure(run: CliRun): Error {
  if (run.stderr === "ENOENT") return new Error("Unity's CLI is not installed. Install it once (Windows PowerShell: irm https://unity.com/install.ps1 | iex), then try again.");
  try {
    const j = JSON.parse(run.stdout) as { errors?: Array<{ code?: string; message?: string }> };
    const e = j.errors?.[0];
    if (e?.code === "REMOTE_COMMAND_FAILED" || /kesher_/.test(e?.message ?? "")) return Object.assign(new Error("This project does not have the KesherAI Bridge package yet: press “Add to a project…”."), { statusCode: 409 }); // a state the page explains, not a fault
    if (e?.message) return new Error(e.message);
  } catch {
    // not JSON
  }
  return new Error((run.stderr || run.stdout).trim().split(/\r?\n/).slice(-3).join(" ") || `Unity's CLI stopped (code ${run.code}).`);
}

/** Editor versions anywhere in `unity editors` JSON (its shape changed between CLI versions). */
export function editorVersions(stdout: string): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 6 || !v) return;
    if (typeof v === "string") {
      if (/^\d{4}\.\d+\.\d+[abfp]\d+$/.test(v)) out.add(v);
      return;
    }
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    if (typeof v === "object") for (const [k, x] of Object.entries(v)) if (k !== "errors" && k !== "warnings") walk(x, depth + 1);
  };
  try {
    walk(JSON.parse(stdout), 0);
  } catch {
    for (const m of stdout.matchAll(/\b(\d{4}\.\d+\.\d+[abfp]\d+)\b/g)) out.add(m[1]!);
  }
  return [...out].sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
}

/** From a TEMPLATE_NOT_FOUND answer's list of templates the editor offers, the best one for 2D or 3D. */
export function closestTemplate(stdout: string, kind: "2d" | "3d"): string | undefined {
  let offered: string[] = [];
  try {
    const j = JSON.parse(stdout) as { data?: { offered?: unknown }; errors?: Array<{ data?: { offered?: unknown } }> };
    const list = j.data?.offered ?? j.errors?.[0]?.data?.offered;
    if (Array.isArray(list)) offered = list.map((x) => (typeof x === "string" ? x : String((x as { id?: unknown })?.id ?? ""))).filter((x) => /^com\.unity\.template\.[\w.-]+$/.test(x));
  } catch {
    offered = [...stdout.matchAll(/com\.unity\.template\.[\w.-]+/g)].map((m) => m[0]);
  }
  const prefs = kind === "2d" ? [/universal-2d/, /urp.*2d|2d.*urp/, /\.2d$/, /2d/] : [/urp-blank/, /universal|urp/, /\.3d$/, /3d/];
  for (const p of prefs) {
    const hit = offered.find((t) => p.test(t));
    if (hit) return hit;
  }
  return undefined;
}

/** Unity projects through the CLI. Same calls as the Unreal bridge, so the page is shared. */
export class UnityCli {
  private statusCache?: { at: number; ready: boolean; project?: string };
  /** Whether the CLI is installed (checked at most once a minute: the page asks every few seconds). */
  private cliCache?: { at: number; found: boolean };
  private editorsCache?: { at: number; list: string[] };

  /**
   * @param config - The `unity` config section.
   * @param save - Persists it.
   * @param run - Runs the CLI.
   */
  constructor(
    private readonly config: UnityConfig,
    private readonly save: () => Promise<void>,
    private readonly run: CliRunner = realRunner,
    private readonly dataDir?: string,
  ) {}

  /** The project folder the page shows (for the chat's Unity tools). */
  get activeProject(): string | undefined {
    return this.path;
  }

  /** Whether a folder is one of the Unity projects the user added (case-insensitive on Windows). */
  hasProject(folder: string): boolean {
    const norm = (x: string) => (process.platform === "win32" ? resolve(x).toLowerCase() : resolve(x));
    return this.config.projects.some((p) => norm(p) === norm(folder));
  }

  /** Whether the CLI was found the last time it was checked (checks again in the background once a minute). */
  cliKnown(): boolean {
    if (!this.cliCache || Date.now() - this.cliCache.at > 60_000) {
      const at = Date.now();
      this.cliCache ??= { at, found: false };
      void this.run(["--version"], 10_000).then((r) => (this.cliCache = { at, found: r.code === 0 }), () => undefined);
    }
    return this.cliCache.found;
  }

  /**
   * Runs the CLI with arguments as given (never a shell), for the chat's Unity tools.
   *
   * @throws Error in plain words when it fails.
   */
  async cli(args: string[], timeoutMs: number): Promise<string> {
    const r = await this.run(args, timeoutMs);
    if (r.code !== 0) throw failure(r);
    this.statusCache = undefined;
    return r.stdout;
  }

  /**
   * Runs the CLI and returns its exit code and output as they are (for commands
   * whose failure carries data, like `recompile` with compile errors).
   */
  async cliRaw(args: string[], timeoutMs: number): Promise<CliRun> {
    const r = await this.run(args, timeoutMs);
    if (r.stderr === "ENOENT") throw failure(r);
    this.statusCache = undefined;
    return r;
  }

  /** Whether a command is waiting for the Editor to finish a reload or compile (the chip says so). */
  reloading = false;
  /** Waits between checks while the Editor reloads (replaced in tests). */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Runs an Editor command; when it lands while the Editor reloads its scripts or compiles (exit 17 or 102,
   * EDITOR_NOT_READY), waits for `unity status` to say it is ready (checks after 1, 2, 4, 8, 15, 15, 15 s: about a
   * minute) and runs it once more, instead of failing.
   *
   * @param args - The CLI's arguments (never a shell).
   * @param timeoutMs - For each run.
   */
  async cliRawReady(args: string[], timeoutMs: number): Promise<CliRun> {
    const first = await this.cliRaw(args, timeoutMs);
    const path = this.path;
    if (!isReloading(first) || !path) return first;
    this.reloading = true;
    try {
      for (const wait of RELOAD_WAITS) {
        await this.sleep(wait);
        const st = await this.run(["status", "--project-path", path, "--format", "json"], 15_000).catch(() => undefined);
        if (st?.code === 0 && /"success"\s*:\s*true/.test(st.stdout)) break;
      }
    } finally {
      this.reloading = false;
    }
    return this.cliRaw(args, timeoutMs);
  }

  /**
   * {@link cliRawReady} that returns the output, like {@link cli}.
   *
   * @throws Error in plain words when it fails.
   */
  async cliReady(args: string[], timeoutMs: number): Promise<string> {
    const r = await this.cliRawReady(args, timeoutMs);
    if (r.code !== 0) throw failure(r);
    return r.stdout;
  }

  /** The CLI's plain-words error for a failed run. */
  explain(r: CliRun): string {
    return failure(r).message;
  }

  /** @returns The project the page shows. */
  async project(): Promise<string | undefined> {
    const p = this.config.active && this.config.projects.includes(this.config.active) ? this.config.active : this.config.projects[0];
    return p ? basename(p) : undefined;
  }

  private get path(): string | undefined {
    return this.config.active && this.config.projects.includes(this.config.active) ? this.config.active : this.config.projects[0];
  }

  /**
   * Adds a project folder (and makes it the one shown).
   *
   * @param folder - The folder with Assets/ and Packages/.
   */
  async addProject(folder: string): Promise<void> {
    if (!existsSync(join(folder, "Assets"))) throw new Error("That is not a Unity project folder.");
    if (!this.config.projects.includes(folder)) this.config.projects.push(folder);
    this.config.active = folder;
    this.statusCache = undefined;
    await this.save();
  }

  /** Whether an editor has the project open and ready (checked at most every 4 seconds). */
  async editorReady(folder?: string): Promise<boolean> {
    const path = folder ?? this.path;
    if (!path) return false;
    if (this.statusCache && this.statusCache.project === path && Date.now() - this.statusCache.at < 4000) return this.statusCache.ready;
    const r = await this.run(["status", "--project-path", path, "--format", "json"], 15_000);
    let ready = false;
    try {
      ready = (JSON.parse(r.stdout) as { success?: boolean }).success === true;
    } catch {
      ready = false;
    }
    this.statusCache = { at: Date.now(), ready, project: path };
    return ready;
  }

  /** @returns Whether the open editor answers (for the page's 🟢). */
  get connected(): boolean {
    return !!this.statusCache?.ready && this.statusCache.project === this.path;
  }

  /**
   * Runs one KesherAI Bridge command: in the open editor, else in a batch editor.
   *
   * @param cmd - list, graph, apply, compile, save, open.
   * @param args - Its arguments (ops are sent as JSON text).
   * @param timeoutMs - How long to wait (a batch run boots Unity; give it minutes).
   * @returns The command's result.
   * @throws Error when no project was added, the CLI is missing, or the command fails.
   */
  async request<T = unknown>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    return this.requestIn(this.path, cmd, args, timeoutMs);
  }

  /** {@link request} in a given project folder (a sync of a project that is not the one shown). */
  private async requestIn<T = unknown>(path: string | undefined, cmd: string, args: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    if (!path) throw new Error("Add a Unity project first.");
    const name = `kesher_${cmd === "compile" ? "check" : cmd}`;
    const flags = Object.entries(args).flatMap(([k, v]) => (v === undefined || v === "" ? [] : [`--${k}`, typeof v === "string" ? v : JSON.stringify(v)]));
    const warm = await this.editorReady(path);
    const run = warm
      ? await this.run(["command", name, ...flags, "--project-path", path, "--result-only", "--timeout", String(Math.ceil(timeoutMs / 1000))], timeoutMs + 5000)
      : await this.run(["run", path, "--command", name, "--format", "ndjson", "--", ...flags], Math.max(timeoutMs, 600_000));
    if (run.code !== 0) throw failure(run);
    const value = readResult(run.stdout) as T & { error?: string };
    if (value && typeof value === "object" && typeof value.error === "string") throw new Error(value.error);
    return value;
  }

  /**
   * When something last changed in the open editor (package 0.2.5), for the page's live view. Never starts a
   * batch Unity: with the editor closed, or an older package, 0.
   */
  async changedAt(): Promise<number> {
    const path = this.path;
    if (!path) return 0;
    // One process: `unity command` answers only from an open editor (it fails at once otherwise, never starting a
    // batch Unity), so asking `unity status` first would only double the processes every 5 s (scan 52).
    const run = await this.run(["command", "kesher_changed", "--project-path", path, "--result-only", "--timeout", "8"], 12_000);
    if (run.code !== 0) return 0;
    try {
      return Number((readResult(run.stdout) as { changedAt?: number }).changedAt) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * The project's graphs. With Unity closed, the list saved the last time it was read opens at once (no batch Unity
   * boot); `fresh` reads it again anyway.
   *
   * @param fresh - Read from Unity even when a saved list exists.
   */
  async list(fresh = false): Promise<{ blueprints: Array<{ path: string; name: string; parent?: string }>; offline: boolean; project?: string; savedAt?: string }> {
    const project = await this.project();
    const folder = this.path;
    if (!project || !folder) return { blueprints: [], offline: true };
    const file = this.cacheDir(folder) && join(this.cacheDir(folder)!, "list.json");
    const warm = await this.editorReady();
    if (!warm && !fresh && file) {
      const saved = readJsonFile<{ blueprints: Array<{ path: string; name: string; parent?: string }>; savedAt: string }>(file);
      if (saved) return { blueprints: saved.blueprints, offline: true, project, savedAt: saved.savedAt };
    }
    const r = await this.request<{ blueprints: Array<{ path: string; name: string; parent?: string }> }>("list");
    const blueprints = [...r.blueprints].sort((a, b) => a.name.localeCompare(b.name));
    const savedAt = new Date().toISOString();
    if (file) writeJsonFile(file, { blueprints, savedAt });
    return { blueprints, offline: !this.connected, project, savedAt };
  }

  /**
   * One graph. Every graph read is saved here (like Unreal's saved Blueprints), so with Unity closed the Visual
   * Scripting page opens it at once as an offline copy, unless Unity saved its file after the copy was made (then it
   * is read again in a batch Unity).
   *
   * @param path - Where the graph lives.
   * @returns The graph, whether it came without the open editor, and when the copy was read from Unity.
   */
  async graph(path: string): Promise<{ graph: BlueprintJson; offline: boolean; savedAt?: string; cached?: boolean; pending?: number }> {
    const folder = this.path;
    const file = folder && this.cacheDir(folder) ? join(this.cacheDir(folder)!, "graphs", graphFile(path)) : undefined;
    const warm = await this.editorReady();
    if (!warm && file && folder) {
      const saved = readJsonFile<{ graph: BlueprintJson; savedAt: string }>(file);
      const changed = saved ? await engineChangedAt({ baseAt: saved.savedAt } as QueuedEdit, unityAssetFile(folder, path)) : undefined;
      if (saved && !changed) return { ...(await this.withPending(folder, path, saved.graph)), offline: true, savedAt: saved.savedAt, cached: true };
    }
    const graph = await this.request<BlueprintJson>("graph", { path });
    const savedAt = new Date().toISOString();
    if (file) writeJsonFile(file, { graph, savedAt });
    return { ...(folder && !warm ? await this.withPending(folder, path, graph) : { graph }), offline: !warm, savedAt };
  }

  /**
   * The graph with the changes still waiting for Unity applied on top (shared/unity-vs.ts), so an edit made with Unity
   * closed shows at once instead of only after the sync.
   */
  private async withPending(folder: string, path: string, graph: BlueprintJson): Promise<{ graph: BlueprintJson; pending?: number }> {
    const mine = (await this.queue()).filter((q) => !q.kind && q.path === path && sameFolder(q.project, folder));
    if (!mine.length) return { graph };
    let doc = graph as unknown as VsDoc;
    for (const q of mine) doc = applyVsOps(doc, q.graph, q.ops as VsOp[]).doc;
    return { graph: doc as unknown as BlueprintJson, pending: mine.length };
  }

  /**
   * Queues a change made on the page with Unity closed. It is first applied to the copy shown (with what is already
   * waiting), so the page gets real answers: operations Unity would refuse (a wire between types that do not fit, a
   * missing port) answer with the error and are not queued. Added elements get an id here ("new-…") that later
   * changes can use; it is also their `ref`, and the waiting changes of a graph sync in one apply, so Unity knows it.
   *
   * @param path - The graph.
   * @param graph - The tab.
   * @param ops - The operations.
   * @returns One result per operation, and how many were queued.
   */
  async enqueueEdit(path: string, graph: string, ops: VsOp[]): Promise<{ queued: boolean; results: VsResult[]; failed: number }> {
    const folder = this.path;
    if (!folder || !this.dataDir) throw new Error("Add a Unity project first.");
    const saved = readJsonFile<{ graph: BlueprintJson }>(join(this.cacheDir(folder)!, "graphs", graphFile(path)));
    if (!saved) throw new Error("Open this graph once with Unity open (or press Sync now) so KesherAI has a copy to change.");
    const named = withTempIds(ops);
    const { graph: shown } = await this.withPending(folder, path, saved.graph);
    const { results } = applyVsOps(shown as unknown as VsDoc, graph, named);
    const ok = named.filter((_, i) => results[i]!.ok);
    if (ok.length) {
      await this.enqueue({ project: folder, path, graph, ops: ok, request: "Changed on the Visual Scripting page" });
      this.redoStack.delete(`${folder}|${path}`);
    }
    return { queued: ok.length > 0, results, failed: results.filter((r) => !r.ok).length };
  }

  /** Changes taken back with Undo while Unity was closed, per project and graph (Redo puts them back). */
  private readonly redoStack = new Map<string, QueuedEdit[]>();

  /**
   * Undo / Redo with Unity closed: takes back the graph's last waiting change, or puts the last one taken back again.
   *
   * @param path - The graph.
   * @param redo - Redo instead of undo.
   * @returns Whether there was one.
   */
  async undoQueued(path: string, redo = false): Promise<boolean> {
    const folder = this.path;
    if (!folder) return false;
    const k = `${folder}|${path}`;
    const stack = this.redoStack.get(k) ?? [];
    const all = await this.queue();
    if (redo) {
      const back = stack.pop();
      if (!back) return false;
      all.push(back);
      this.writeQueue(all);
      return true;
    }
    const i = all.map((q, n) => ({ q, n })).filter(({ q }) => !q.kind && !q.clash && q.path === path && sameFolder(q.project, folder)).pop()?.n;
    if (i === undefined) return false;
    stack.push(...all.splice(i, 1));
    this.redoStack.set(k, stack.slice(-50));
    this.writeQueue(all);
    return true;
  }

  /**
   * "Sync on open": compares the saved copy of a graph with Unity's graph now. With Unity open, Unity is asked (the
   * saved copy is not replaced; the page offers Refresh); with it closed, only whether Unity saved the graph's file
   * after the copy was read.
   *
   * @param path - The graph.
   * @returns Whether they are the same, what differs, and whether Unity was asked.
   */
  async checkSaved(path: string): Promise<{ editor: boolean; same: boolean; stale?: boolean; diff?: VsDiff; savedAt?: string; pending: number }> {
    const folder = this.path;
    const file = folder && this.cacheDir(folder) ? join(this.cacheDir(folder)!, "graphs", graphFile(path)) : undefined;
    const saved = file ? readJsonFile<{ graph: BlueprintJson; savedAt: string }>(file) : undefined;
    const pending = folder ? (await this.queue()).filter((q) => !q.kind && q.path === path && sameFolder(q.project, folder)).length : 0;
    if (!folder || !saved) return { editor: false, same: true, pending };
    if (!(await this.editorReady())) {
      const changed = await engineChangedAt({ baseAt: saved.savedAt } as QueuedEdit, unityAssetFile(folder, path));
      return { editor: false, same: !changed, ...(changed ? { stale: true } : {}), savedAt: saved.savedAt, pending };
    }
    const now = await this.request<BlueprintJson>("graph", { path });
    const diff = diffVsGraphs(saved.graph as unknown as VsDoc, now as unknown as VsDoc);
    return { editor: true, same: diff.same, diff, savedAt: saved.savedAt, pending };
  }

  /**
   * The node palette: Unity's own list when the editor is open (every answer is kept), else the kept list with the
   * common units, searched here.
   *
   * @param path - The graph (Unity lists the units for it).
   * @param query - The words typed.
   * @returns The matches, and whether they came without Unity.
   */
  async actions(path: string, query: string): Promise<{ actions: VsUnit[]; offline: boolean }> {
    const folder = this.path;
    const file = folder && this.cacheDir(folder) ? join(this.cacheDir(folder)!, "units.json") : undefined;
    const kept = (file && readJsonFile<VsUnit[]>(file)) || [];
    if (await this.editorReady()) {
      const r = await this.request<{ actions: VsUnit[] }>("actions", { path, query }, 30_000);
      if (file && Array.isArray(r.actions)) {
        const seen = new Set(kept.map((u) => `${u.type}|${u.title}|${u.function ?? ""}`));
        const add = r.actions.filter((u) => u && typeof u.title === "string" && !seen.has(`${u.type}|${u.title}|${u.function ?? ""}`));
        if (add.length) writeJsonFile(file, [...kept, ...add].slice(-5000));
      }
      return { actions: r.actions, offline: false };
    }
    return { actions: searchUnits([...kept, ...COMMON_UNITS], query), offline: true };
  }

  /** Where saved graphs of a project are kept (undefined without a data folder: tests, nothing saved). */
  private cacheDir(folder: string): string | undefined {
    if (!this.dataDir) return undefined;
    const id = createHash("sha256").update(process.platform === "win32" ? resolve(folder).toLowerCase() : resolve(folder)).digest("hex").slice(0, 12);
    return join(this.dataDir, `${basename(folder).replace(/[^\w.-]+/g, "_").slice(0, 60)}-${id}`);
  }

  /** Which of the packages the chat needs the project has: Unity's Pipeline (the CLI talks to the Editor through it) and KesherAI's bridge (graphs). */
  packagesOf(folder: string): { pipeline: boolean; bridge: boolean } {
    try {
      const deps = (JSON.parse(readFileSync(join(folder, "Packages", "manifest.json"), "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {};
      return { pipeline: "com.unity.pipeline" in deps, bridge: "com.kesherai.bridge" in deps || existsSync(join(folder, "Packages", "com.kesherai.bridge")) };
    } catch {
      return { pipeline: false, bridge: false };
    }
  }

  /** The page's status. */
  async status(): Promise<{ connected: boolean; editor?: { project: string; engine: string; bridge: string }; projects: string[]; queued: number; offline?: boolean; cli: boolean; reloading?: boolean; active?: string; packages?: { pipeline: boolean; bridge: boolean } }> {
    if (!this.cliCache || Date.now() - this.cliCache.at > 60_000) this.cliCache = { at: Date.now(), found: (await this.run(["--version"], 10_000)).code === 0 };
    const found = this.cliCache.found;
    const ready = found ? await this.editorReady() : false;
    const path = this.path;
    const waiting = path ? (await this.queue()).filter((q) => sameFolder(q.project, path)) : [];
    const queuedHere = waiting.length;
    // Unity just opened with changes waiting: they go in now (like Unreal applying its queue when the editor connects).
    if (ready && path && waiting.some((q) => !q.clash && q.decision !== "skip") && !this.syncing.has(path)) this.scheduleSync(path, 1000);
    return {
      connected: ready,
      ...(ready && path ? { editor: { project: basename(path), engine: "", bridge: "" } } : {}),
      projects: this.config.projects,
      queued: path ? queuedHere : 0,
      // Changes made with Unity closed wait in KesherAI's queue and sync in one batch run (offline editing).
      ...(this.dataDir ? { offline: true } : {}),
      cli: found,
      ...(this.reloading ? { reloading: true } : {}),
      ...(path ? { active: path, packages: this.packagesOf(path) } : {}),
    };
  }

  // With Unity open, changes run at once in it. With Unity closed they wait here and sync together in one batch
  // Unity run, a few seconds after the last one (RESEARCH_LOG "Gap list: engine work without the engine open", step 2).

  /** @returns Changes waiting for Unity (all projects; `project` is the project folder). */
  async queue(): Promise<QueuedEdit[]> {
    return (this.dataDir && readJsonFile<QueuedEdit[]>(join(this.dataDir, "queue.json"))) || [];
  }

  private writeQueue(q: QueuedEdit[]): void {
    if (this.dataDir) writeJsonFile(join(this.dataDir, "queue.json"), q);
  }

  /**
   * Removes a waiting change.
   *
   * @param id - Its id.
   * @returns Whether it was there.
   */
  async unqueue(id: string): Promise<boolean> {
    const q = await this.queue();
    const left = q.filter((x) => x.id !== id);
    this.writeQueue(left);
    return left.length !== q.length;
  }

  /** Whether changes can wait for Unity here (a data folder and a project). */
  get canQueue(): boolean {
    return !!this.dataDir && !!this.path;
  }

  /**
   * Keeps a change made with Unity closed, with the saved copy it was made on (for the clash check).
   *
   * @param edit - The change; `project` is the project folder.
   * @returns It, with its id.
   */
  async enqueue(edit: Omit<QueuedEdit, "id" | "at">): Promise<QueuedEdit> {
    if (!this.dataDir) throw new Error("Unity changes run at once through the CLI.");
    const dir = this.cacheDir(edit.project);
    const saved = dir ? readJsonFile<{ graph: BlueprintJson; savedAt: string }>(join(dir, "graphs", graphFile(edit.path))) : undefined;
    const item: QueuedEdit = { ...(saved ? { baseAt: saved.savedAt, baseSig: nodeSig(saved.graph) } : {}), ...edit, id: randomUUID(), at: new Date().toISOString() };
    const q = await this.queue();
    q.push(item);
    this.writeQueue(q);
    return item;
  }

  /** Where each project's sync stands (by folder), for the pages. */
  readonly syncState = new Map<string, { running: boolean; lastAt?: string; lastError?: string }>();
  private readonly syncing = new Map<string, Promise<{ applied: number; failed: number }>>();
  private readonly syncTimers = new Map<string, NodeJS.Timeout>();
  /** Called when a sync ends (the Game projects page notifies on a failure or a clash). */
  onSync?: (r: SyncReport) => void;
  /** Called before a batch of queued changes is applied, to keep their files first (a checkpoint). */
  beforeSync?: (b: SyncBatch) => Promise<void>;

  /**
   * Syncs a project's waiting changes a moment after the last one.
   *
   * @param folder - The project folder (default: the one shown).
   * @param delayMs - Quiet time first.
   */
  scheduleSync(folder = this.path, delayMs = 8000): void {
    if (!folder) return;
    clearTimeout(this.syncTimers.get(folder));
    const t = setTimeout(() => {
      this.syncTimers.delete(folder);
      void this.syncNow(folder).catch(() => undefined);
    }, delayMs);
    t.unref?.();
    this.syncTimers.set(folder, t);
  }

  /**
   * Applies a project's waiting changes now, all in one Unity run (`kesher_batch`, package 0.2.10+; an older package
   * gets one run per change). Changes that clash with an edit saved in Unity are held for Roee's choice.
   *
   * @param folder - The project folder (default: the one shown).
   * @returns How many went in and how many failed (those stay waiting).
   */
  async syncNow(folder = this.path): Promise<{ applied: number; failed: number }> {
    if (!folder) throw new Error("Add a Unity project first.");
    const running = this.syncing.get(folder);
    if (running) return running;
    let clashes = 0;
    const job = (async () => {
      this.syncState.set(folder, { running: true, ...(this.syncState.get(folder)?.lastAt ? { lastAt: this.syncState.get(folder)!.lastAt } : {}) });
      const all = await this.queue();
      const { apply, newClashes } = await sortForSync(all.filter((q) => sameFolder(q.project, folder)), (q) => unityAssetFile(folder, q.path));
      clashes = newClashes.length;
      if (clashes) this.writeQueue(all);
      if (!apply.length) return { applied: 0, failed: 0 };
      // The graphs' files as they are now, first (a failed checkpoint never stops the sync).
      const files = batchFiles(apply, (q) => unityAssetFile(folder, q.path));
      if (files.length && this.beforeSync) await this.beforeSync({ engine: "unity", project: folder, name: basename(folder), files, count: apply.length }).catch(() => undefined);
      const paths = [...new Set(apply.map((q) => q.path))];
      // A graph tab's waiting changes go in as one apply, so ids given to added nodes ("new-…" refs) carry over.
      const groups = mergeEdits(apply);
      const commands = [
        ...groups.map((g) => ({ cmd: "apply", path: g.path, graph: g.graph, ops: g.ops })),
        ...paths.map((path) => ({ cmd: "save", path })),
        ...paths.map((path) => ({ cmd: "graph", path })),
      ];
      const answers = await this.batch(folder, commands);
      let applied = 0;
      let failed = 0;
      for (let i = 0; i < groups.length; i++) {
        for (const q of groups[i]!.edits) {
          if (answers[i]?.ok) {
            applied++;
            await this.unqueue(q.id);
          } else failed++;
        }
      }
      // The graphs read at the end are the new saved copies.
      const dir = this.cacheDir(folder);
      for (let i = 0; i < paths.length; i++) {
        const a = answers[commands.length - paths.length + i];
        if (dir && a?.ok && a.result) writeJsonFile(join(dir, "graphs", graphFile(paths[i]!)), { graph: a.result, savedAt: new Date().toISOString() });
      }
      return { applied, failed };
    })().then((r) => {
      const lastError = r.failed ? `${r.failed} change(s) could not be applied; they stay waiting.` : undefined;
      this.syncState.set(folder, { running: false, lastAt: new Date().toISOString(), ...(lastError ? { lastError } : {}) });
      if (r.applied || r.failed || clashes) this.onSync?.({ engine: "unity", project: folder, ...r, clashes, ...(lastError ? { error: lastError } : {}) });
      return r;
    }, (e: Error) => {
      this.syncState.set(folder, { running: false, lastAt: new Date().toISOString(), lastError: e.message });
      this.onSync?.({ engine: "unity", project: folder, applied: 0, failed: 0, clashes, error: e.message });
      throw e;
    }).finally(() => this.syncing.delete(folder));
    this.syncing.set(folder, job);
    return job;
  }

  /**
   * Runs graph commands in one Unity run (the open editor, or one batch Unity) through a file, so a long list of
   * changes never meets the command line's length limit. An older package without kesher_batch: one run each.
   */
  private async batch(folder: string, commands: Array<Record<string, unknown>>): Promise<Array<{ ok: boolean; result?: unknown; error?: string }>> {
    const file = join(this.dataDir!, `batch-${randomUUID()}.json`);
    writeJsonFile(file, commands);
    try {
      const r = await this.requestIn<{ answers: Array<{ ok: boolean; result?: unknown; error?: string }> }>(folder, "batch", { file }, 20 * 60_000);
      return Array.isArray(r.answers) ? r.answers : [];
    } catch (err) {
      if (!/kesher_batch|Unknown command|not found/i.test((err as Error).message)) throw err;
      const out: Array<{ ok: boolean; result?: unknown; error?: string }> = [];
      for (const c of commands) {
        const { cmd, ...args } = c;
        const a = cmd === "apply" ? { ...args, ops: JSON.stringify(args.ops) } : args;
        out.push(await this.requestIn(folder, String(cmd), a, 10 * 60_000).then((result) => ({ ok: true, result }), (e: Error) => ({ ok: false, error: e.message })));
      }
      return out;
    } finally {
      rmSync(file, { force: true });
    }
  }

  /**
   * Roee's choice for a waiting change that clashes with an edit saved in Unity: "mine" applies it anyway (synced now),
   * "engine" drops it (Unity's version stays), "skip" leaves it waiting without syncing it.
   *
   * @param id - The waiting change.
   * @param choice - The choice.
   * @returns Whether the change was there.
   */
  async decide(id: string, choice: ClashChoice): Promise<boolean> {
    const all = await this.queue();
    const q = all.find((x) => x.id === id);
    if (!q) return false;
    if (choice === "engine") return this.unqueue(id);
    q.decision = choice;
    this.writeQueue(all);
    if (choice === "mine") this.scheduleSync(q.project, 500);
    return true;
  }

  private createJob?: { name: string; path: string; state: "running" | "done" | "failed"; message?: string; startedAt: number };

  /**
   * The CLI itself, with no project needed: its version and the Unity
   * editors installed (for "New project").
   */
  async cliInfo(): Promise<{ cli: boolean; version?: string; editors: string[]; job?: UnityCli["createJob"] }> {
    const v = await this.run(["--version"], 10_000);
    if (v.code !== 0) return { cli: false, editors: [], ...(this.createJob ? { job: this.createJob } : {}) };
    // The installed editors change rarely: asked at most once a minute.
    if (!this.editorsCache || Date.now() - this.editorsCache.at > 60_000) {
      const e = await this.run(["editors", "--installed", "--format", "json"], 30_000);
      this.editorsCache = { at: Date.now(), list: editorVersions(e.stdout) };
    }
    const editors = this.editorsCache.list;
    return { cli: true, version: v.stdout.trim().split(/\s+/).pop()?.slice(0, 40), editors, ...(this.createJob ? { job: this.createJob } : {}) };
  }

  /**
   * Makes a new Unity project with Unity's CLI (`unity projects create`),
   * with no Unity Cloud link; it already has Unity's Pipeline package. Runs
   * in the background (minutes); \`cliInfo().job\` says how it went. When it is
   * made, KesherAI's bridge package is added and the project is shown here.
   *
   * @param opts.name - The project's name (letters, numbers, spaces, - and _).
   * @param opts.parent - The folder to make it in (it must exist); empty = ~/Unity Projects.
   * @param opts.editor - An installed editor version (default: Unity's default).
   * @param opts.template - 3d (URP), 2d, or a template id.
   * @param opts.open - Open it in Unity when it is made.
   */
  createProject(opts: { name: string; parent: string; editor?: string; template?: string; open?: boolean }, copyPackage: (folder: string) => Promise<string>): void {
    if (this.createJob?.state === "running") throw new Error("A project is being made already.");
    const name = opts.name.trim();
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,59}$/u.test(name)) throw new Error("Use a name with letters, numbers, spaces, - or _ (up to 60).");
    // No folder given: "Unity Projects" in the user's home folder (made if needed), like Unity Hub.
    const given = opts.parent.trim() || join(homedir(), "Unity Projects");
    if (!opts.parent.trim()) mkdirSync(given, { recursive: true });
    const parent = resolve(given);
    if (!isAbsolute(given) || !existsSync(parent) || !statSync(parent).isDirectory()) throw new Error("Choose a folder that exists for the new project.");
    const path = join(parent, name);
    if (existsSync(path)) throw new Error(`There is already a folder named ${name} there.`);
    if (opts.editor && !/^[\w.]{3,30}$/.test(opts.editor)) throw new Error("That is not an editor version.");
    const kind = opts.template === "2d" ? "2d" : "3d";
    // Full template ids (older CLIs know no "2d"/"3d" short names); when the editor offers others, the closest one is used.
    const template = opts.template && /^com\.unity\.template\.[\w.-]{2,80}$/.test(opts.template) ? opts.template : kind === "2d" ? "com.unity.template.universal-2d" : "com.unity.template.urp-blank";
    const args = (t: string) => ["projects", "create", name, "--path", parent, "--template", t, "--no-cloud", "--format", "json", ...(opts.editor ? ["--editor-version", opts.editor] : [])];
    this.createJob = { name, path, state: "running", startedAt: Date.now() };
    const job = this.createJob;
    void (async () => {
      let r = await this.run(args(template), 20 * 60_000);
      if (r.code !== 0) {
        const other = closestTemplate(r.stdout, kind);
        if (other && other !== template) r = await this.run(args(other), 20 * 60_000);
      }
      if (r.code !== 0) {
        job.state = "failed";
        job.message = failure(r).message;
        return;
      }
      let made = path;
      try {
        made = String((JSON.parse(r.stdout) as { data?: { path?: string } }).data?.path ?? path);
      } catch {
        // keep the folder we asked for
      }
      job.path = made;
      try {
        await copyPackage(made);
        await this.addProject(made);
        job.message = "The project is ready, with KesherAI's bridge.";
      } catch (err) {
        job.message = `The project was made, but adding KesherAI's bridge failed: ${(err as Error).message}`;
      }
      job.state = "done";
      if (opts.open) await this.openProject(made).catch(() => undefined);
    })();
  }

  /** Updates Unity's CLI to its newest version (`unity self-update`); the user pressed the button. */
  /**
   * Installs Unity's CLI with Unity's own installer (unity.com/install.ps1 or
   * install.sh). On Windows it opens a PowerShell window the user can watch;
   * elsewhere it runs in the background. The check for the CLI runs again
   * every few seconds afterwards, so no restart is needed.
   */
  installCli(): string {
    if (process.platform === "win32") {
      const ps = "irm https://unity.com/install.ps1 | iex; Write-Host ''; Write-Host 'KesherAI: Unity CLI installed. You can close this window.'";
      openConsole("Unity CLI install", ps);
    } else {
      spawn("bash", ["-c", "curl -fsSL https://unity.com/install.sh | bash"], { detached: true, stdio: "ignore" }).unref();
    }
    this.cliCache = undefined;
    pathCache = undefined;
    return "Installing Unity's CLI (a PowerShell window shows it). It takes a minute.";
  }

  /** Where every CLI call is logged (the live window reads it). */
  static setLogFile(file: string): void {
    mkdirSync(dirname(file), { recursive: true });
    // Kept small: started fresh when it passed 5 MB.
    try {
      if (statSync(file).size > 5 * 1024 * 1024) writeFileSync(file, "");
    } catch {
      // not there yet
    }
    cliLogFile = file;
  }

  /**
   * Opens a console window that shows every Unity CLI command KesherAI runs,
   * with its output, live (Windows: PowerShell; elsewhere not available).
   */
  async openLiveWindow(): Promise<string> {
    if (!cliLogFile) throw new Error("The Unity CLI log is not set up.");
    if (!existsSync(cliLogFile)) await writeText(cliLogFile, "KesherAI: Unity CLI commands appear here as they run.\n");
    if (process.platform !== "win32") return `Follow ${cliLogFile} (e.g. tail -f).`;
    const file = cliLogFile.replace(/'/g, "''");
    openConsole("KesherAI - Unity CLI live", `Get-Content -LiteralPath '${file}' -Tail 40 -Wait`);
    return "A window now shows every Unity CLI command as it runs.";
  }

  /**
   * Adds a build platform (Android, iOS, WebGL…) to the shown project's Unity version, in a visible
   * PowerShell window: Windows asks for administrator permission (the Editor is in Program Files), and
   * the user answers it there. Unity's module licences are accepted as part of the install they asked for.
   */
  async installPlatform(platform: string): Promise<string> {
    const module = ({ android: "android", ios: "ios", webgl: "webgl", linux: "linux-mono", mac: "mac-mono" } as Record<string, string>)[platform];
    if (!module) throw new Error("Pick android, ios, webgl, linux or mac.");
    const path = this.path;
    if (!path) throw new Error("Add or make a Unity project first.");
    const version = /m_EditorVersion:\s*([\w.]+)/.exec(readFileSync(join(path, "ProjectSettings", "ProjectVersion.txt"), "utf8"))?.[1];
    if (!version) throw new Error("Could not tell the project's Unity version.");
    if (process.platform !== "win32") {
      const r = await this.run(["install-modules", "--editor-version", version, "--module", module, "--child-modules", "--yes", "--accept-eula"], 3 * 3_600_000);
      if (r.code !== 0) throw failure(r);
      return `Added ${module} to Unity ${version}.`;
    }
    openConsole(`Unity: add ${module}`, `unity install-modules --editor-version ${version} --module ${module} --child-modules --yes --accept-eula; Write-Host ''; Write-Host 'KesherAI: done. You can close this window.'`);
    return `Adding ${module} to Unity ${version} in a PowerShell window. Windows asks for permission: press Yes. It takes a while (a few GB).`;
  }

  /** Updates Unity's CLI (`unity self-update`). */
  async selfUpdate(): Promise<string> {
    const r = await this.run(["self-update", "--format", "json"], 300_000);
    if (r.code !== 0) throw failure(r);
    this.cliCache = undefined;
    return "Unity's CLI is up to date.";
  }

  /** Opens a project (the one shown, by default) in the Unity editor. */
  async openProject(folder = this.path): Promise<void> {
    if (!folder) throw new Error("Add or make a Unity project first.");
    if (!this.config.projects.includes(folder)) throw new Error("That project is not on the list.");
    const r = await this.run(["open", folder, "--format", "json"], 120_000);
    if (r.code !== 0) throw failure(r);
    this.statusCache = undefined;
  }

  /**
   * Prepares a project: the Pipeline package (through the CLI) and the KesherAI Bridge package.
   *
   * @param folder - The project folder.
   * @param copyPackage - Copies the bridge package into Packages/.
   * @returns What to tell the user.
   */
  async install(folder: string, copyPackage: (folder: string) => Promise<string>): Promise<string> {
    const copied = await copyPackage(folder);
    const r = await this.run(["pipeline", "install", "--project-path", folder, "--format", "json"], 120_000);
    if (r.code !== 0) throw failure(r);
    await this.addProject(folder);
    return `${copied} Unity's Pipeline package was added too.`;
  }
}

/**
 * Gives every added element an id of its own ("new-" and 8 hex) that is also its `ref`, and points the operation's
 * other references to it (a `$n` ref the page used), so later changes can name the node before Unity made it.
 *
 * @param ops - The page's operations.
 * @returns The operations to queue.
 */
export function withTempIds(ops: VsOp[]): VsOp[] {
  const map = new Map<string, string>();
  const swap = (v: unknown) => (typeof v === "string" && map.has(v) ? map.get(v)! : v);
  return ops.map((raw) => {
    const op: VsOp = JSON.parse(JSON.stringify(raw ?? {})) as VsOp;
    if (op.op === "add") {
      const id = `new-${randomUUID().slice(0, 8)}`;
      if (typeof op.ref === "string" && op.ref) map.set(op.ref, id);
      op.ref = id;
      op.id = id;
    }
    if (op.node !== undefined) op.node = swap(op.node);
    for (const end of ["from", "to"] as const) {
      const e = op[end] as { node?: unknown } | undefined;
      if (e && typeof e === "object") e.node = swap(e.node);
    }
    return op;
  });
}

/**
 * Joins waiting graph changes by graph and tab, in order (one apply each, so refs carry over).
 *
 * @param edits - The changes to apply.
 * @returns One group per graph tab, with its changes.
 */
export function mergeEdits(edits: QueuedEdit[]): Array<{ path: string; graph: string; ops: unknown[]; edits: QueuedEdit[] }> {
  const out: Array<{ path: string; graph: string; ops: unknown[]; edits: QueuedEdit[] }> = [];
  for (const q of edits) {
    const g = !q.kind ? out.find((x) => x.path === q.path && x.graph === q.graph && !x.edits[0]!.kind) : undefined;
    if (g) {
      g.ops.push(...q.ops);
      g.edits.push(q);
    } else out.push({ path: q.path, graph: q.graph, ops: [...q.ops], edits: [q] });
  }
  return out;
}
