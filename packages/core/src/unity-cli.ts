import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

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

const realRunner: CliRunner = (args, timeoutMs) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn("unity", ["--no-banner", "--non-interactive", ...args], { windowsHide: true, env: { ...process.env, UNITY_NO_AGENT_HINTS: "1", UNITY_NO_UPDATE_CHECK: "1" } });
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

/** Unity projects through the CLI. Same calls as the Unreal bridge, so the page is shared. */
export class UnityCli {
  private statusCache?: { at: number; ready: boolean; project?: string };

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

  /** The page's status. */
  async status(): Promise<{ connected: boolean; editor?: { project: string; engine: string; bridge: string }; projects: string[]; queued: number; cli: boolean; active?: string }> {
    const cli = await this.run(["--version"], 10_000);
    const found = cli.code === 0;
    const ready = found ? await this.editorReady() : false;
    const path = this.path;
    return {
      connected: ready,
      ...(ready && path ? { editor: { project: basename(path), engine: "", bridge: "" } } : {}),
      projects: this.config.projects,
      queued: 0,
      cli: found,
      ...(path ? { active: path } : {}),
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
