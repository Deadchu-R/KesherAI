import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { appendFile, writeFile as writeText } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

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
  if (pathCache && Date.now() - pathCache.at < 10_000) return pathCache.value;
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

/** Every CLI call is written here (when set), so the user can watch it live in a console window. */
let cliLogFile: string | undefined;
const logLine = (line: string) => {
  if (cliLogFile) void appendFile(cliLogFile, `${line}\n`).catch(() => undefined);
};
const shown = (args: string[]) => args.map((a) => (a.length > 160 ? `${a.slice(0, 160)}…(${a.length} chars)` : /\s/.test(a) ? `"${a}"` : a)).join(" ");

const realRunner: CliRunner = (args, timeoutMs) => {
  const started = Date.now();
  logLine(`\n[${new Date().toLocaleTimeString()}] > unity ${shown(args)}`);
  return realRun(args, timeoutMs).then((r) => {
    const out = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.trim();
    logLine(`${out.length > 3000 ? `${out.slice(0, 3000)}\n… (${out.length - 3000} more characters)` : out}`);
    logLine(`[exit ${r.code} · ${((Date.now() - started) / 1000).toFixed(1)} s]`);
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

/** An error from the CLI's JSON envelope, in plain words. */
function failure(run: CliRun): Error {
  if (run.stderr === "ENOENT") return new Error("Unity's CLI is not installed. Install it once (Windows PowerShell: irm https://unity.com/install.ps1 | iex), then try again.");
  try {
    const j = JSON.parse(run.stdout) as { errors?: Array<{ code?: string; message?: string }> };
    const e = j.errors?.[0];
    if (e?.code === "REMOTE_COMMAND_FAILED" || /kesher_/.test(e?.message ?? "")) return new Error("This project does not have the KesherAI Bridge package yet: press “Add to a project…”.");
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

  /**
   * @param config - The `unity` config section.
   * @param save - Persists it.
   * @param run - Runs the CLI.
   */
  constructor(
    private readonly config: UnityConfig,
    private readonly save: () => Promise<void>,
    private readonly run: CliRunner = realRunner,
  ) {}

  /** The project folder the page shows (for the chat's Unity tools). */
  get activeProject(): string | undefined {
    return this.path;
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
  private async editorReady(): Promise<boolean> {
    const path = this.path;
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
    const path = this.path;
    if (!path) throw new Error("Add a Unity project first.");
    const name = `kesher_${cmd === "compile" ? "check" : cmd}`;
    const flags = Object.entries(args).flatMap(([k, v]) => (v === undefined || v === "" ? [] : [`--${k}`, typeof v === "string" ? v : JSON.stringify(v)]));
    const warm = await this.editorReady();
    const run = warm
      ? await this.run(["command", name, ...flags, "--project-path", path, "--result-only", "--timeout", String(Math.ceil(timeoutMs / 1000))], timeoutMs + 5000)
      : await this.run(["run", path, "--command", name, "--format", "ndjson", "--", ...flags], Math.max(timeoutMs, 600_000));
    if (run.code !== 0) throw failure(run);
    const value = readResult(run.stdout) as T & { error?: string };
    if (value && typeof value === "object" && typeof value.error === "string") throw new Error(value.error);
    return value;
  }

  /** @returns The project's graphs. */
  async list(): Promise<{ blueprints: Array<{ path: string; name: string; parent?: string }>; offline: boolean; project?: string }> {
    const project = await this.project();
    if (!project) return { blueprints: [], offline: true };
    const r = await this.request<{ blueprints: Array<{ path: string; name: string; parent?: string }> }>("list");
    return { blueprints: [...r.blueprints].sort((a, b) => a.name.localeCompare(b.name)), offline: !this.connected, project };
  }

  /**
   * @param path - Where the graph lives.
   * @returns The graph.
   */
  async graph(path: string): Promise<{ graph: import("./unreal-bridge.js").BlueprintJson; offline: boolean }> {
    return { graph: await this.request("graph", { path }), offline: !this.connected };
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
  async status(): Promise<{ connected: boolean; editor?: { project: string; engine: string; bridge: string }; projects: string[]; queued: number; cli: boolean; active?: string; packages?: { pipeline: boolean; bridge: boolean } }> {
    if (!this.cliCache || Date.now() - this.cliCache.at > 60_000) this.cliCache = { at: Date.now(), found: (await this.run(["--version"], 10_000)).code === 0 };
    const found = this.cliCache.found;
    const ready = found ? await this.editorReady() : false;
    const path = this.path;
    return {
      connected: ready,
      ...(ready && path ? { editor: { project: basename(path), engine: "", bridge: "" } } : {}),
      projects: this.config.projects,
      queued: 0,
      cli: found,
      ...(path ? { active: path, packages: this.packagesOf(path) } : {}),
    };
  }

  // Unity changes run at once (in the open editor or a batch one): nothing waits.
  /** @returns Nothing (no queue with the CLI). */
  async queue(): Promise<[]> {
    return [];
  }

  /** @returns false (no queue with the CLI). */
  async unqueue(): Promise<boolean> {
    return false;
  }

  /** @returns Never: the CLI runs changes at once. */
  async enqueue(): Promise<never> {
    throw new Error("Unity changes run at once through the CLI.");
  }

  private createJob?: { name: string; path: string; state: "running" | "done" | "failed"; message?: string; startedAt: number };

  /**
   * The CLI itself, with no project needed: its version and the Unity
   * editors installed (for "New project").
   */
  async cliInfo(): Promise<{ cli: boolean; version?: string; editors: string[]; job?: UnityCli["createJob"] }> {
    const v = await this.run(["--version"], 10_000);
    if (v.code !== 0) return { cli: false, editors: [], ...(this.createJob ? { job: this.createJob } : {}) };
    const e = await this.run(["editors", "--installed", "--format", "json"], 30_000);
    const editors = editorVersions(e.stdout);
    return { cli: true, version: v.stdout.trim().split(/\s+/).pop()?.slice(0, 40), editors, ...(this.createJob ? { job: this.createJob } : {}) };
  }

  /**
   * Makes a new Unity project with Unity's CLI (`unity projects create`),
   * with no Unity Cloud link; it already has Unity's Pipeline package. Runs
   * in the background (minutes); \`cliInfo().job\` says how it went. When it is
   * made, KesherAI's bridge package is added and the project is shown here.
   *
   * @param opts.name - The project's name (letters, numbers, spaces, - and _).
   * @param opts.parent - The folder to make it in (it must exist).
   * @param opts.editor - An installed editor version (default: Unity's default).
   * @param opts.template - 3d (URP), 2d, or a template id.
   * @param opts.open - Open it in Unity when it is made.
   */
  createProject(opts: { name: string; parent: string; editor?: string; template?: string; open?: boolean }, copyPackage: (folder: string) => Promise<string>): void {
    if (this.createJob?.state === "running") throw new Error("A project is being made already.");
    const name = opts.name.trim();
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,59}$/u.test(name)) throw new Error("Use a name with letters, numbers, spaces, - or _ (up to 60).");
    const parent = resolve(opts.parent.trim());
    if (!isAbsolute(opts.parent.trim()) || !existsSync(parent) || !statSync(parent).isDirectory()) throw new Error("Choose a folder that exists for the new project.");
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
      const ps = "irm https://unity.com/install.ps1 | iex; Write-Host ''; Write-Host 'KesherAI: Unity CLI installed. You can close this window.'; Start-Sleep -Seconds 20";
      // detached on Windows = its own console window, so the user sees the install run.
      spawn("powershell.exe", ["-NoProfile", "-Command", ps], { detached: true, stdio: "ignore", windowsHide: false }).unref();
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
    spawn("powershell.exe", ["-NoProfile", "-Command", `$Host.UI.RawUI.WindowTitle = 'KesherAI - Unity CLI live'; Get-Content -LiteralPath '${file}' -Tail 40 -Wait`], { detached: true, stdio: "ignore", windowsHide: false }).unref();
    return "A window now shows every Unity CLI command as it runs.";
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
