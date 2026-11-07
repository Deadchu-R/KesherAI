import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** The running version. */
export interface VersionInfo {
  /** From the root package.json, e.g. `0.2.0`. */
  version: string;
  /** Short git commit, when running from a git checkout. */
  commit?: string;
  /** How this copy was installed: a git checkout can update itself. */
  install: "git" | "package";
}

/** Result of an update check. */
export interface UpdateCheck extends VersionInfo {
  /** Commits on GitHub that this copy does not have yet, newest first. */
  newCommits: Array<{ hash: string; subject: string }>;
  /** Version in the newest package.json on GitHub. */
  latestVersion?: string;
  /** Files changed locally, which can block an update. */
  localChanges: string[];
  checkedAt: string;
}

/** Progress of an update being applied. */
export interface UpdateProgress {
  running: boolean;
  step?: string;
  log: string[];
  error?: string;
  /** Finished, and the app must be restarted to use the new version. */
  restartRequired?: boolean;
  finishedAt?: string;
}

/**
 * Checks GitHub for new versions and updates a git checkout in place:
 * `git pull`, `pnpm install`, then the build. When KesherAI runs from source
 * with `pnpm dev`, the server and the UI reload by themselves afterwards.
 * Packaged installers will update through their own updater instead.
 */
export class Updater {
  private progress: UpdateProgress = { running: false, log: [] };

  /** @param root - The repository folder (defaults to three levels above this file). */
  constructor(private readonly root = resolve(import.meta.dirname, "../../..")) {}

  private git(...args: string[]): Promise<string> {
    return exec("git", ["-C", this.root, ...args], { windowsHide: true, timeout: 60_000 }).then((r) => r.stdout.trim());
  }

  /** @returns Version, commit, and how this copy was installed. */
  async version(): Promise<VersionInfo> {
    let version = "0.0.0";
    try {
      version = (JSON.parse(readFileSync(join(this.root, "package.json"), "utf8")) as { version: string }).version;
    } catch {
      // not inside the repo (packaged build)
    }
    if (!existsSync(join(this.root, ".git"))) return { version, install: "package" };
    const commit = await this.git("rev-parse", "--short", "HEAD").catch(() => undefined);
    return { version, ...(commit ? { commit } : {}), install: "git" };
  }

  /**
   * Fetches from GitHub and lists what is new.
   *
   * @returns What would change.
   * @throws Error if this is not a git checkout or GitHub cannot be reached.
   */
  async check(): Promise<UpdateCheck> {
    const info = await this.version();
    if (info.install !== "git") throw new Error("This copy was not installed with git, so it cannot update itself here.");
    const branch = (await this.git("rev-parse", "--abbrev-ref", "HEAD")) || "main";
    await this.git("fetch", "--quiet", "origin", branch);
    const log = await this.git("log", "--format=%h%x09%s", `HEAD..origin/${branch}`, "-n", "50");
    const newCommits = log ? log.split("\n").map((l) => ({ hash: l.split("\t")[0]!, subject: l.split("\t").slice(1).join("\t") })) : [];
    let latestVersion: string | undefined;
    try {
      latestVersion = (JSON.parse(await this.git("show", `origin/${branch}:package.json`)) as { version: string }).version;
    } catch {
      latestVersion = undefined;
    }
    const status = await this.git("status", "--porcelain");
    const localChanges = status ? status.split("\n").map((l) => l.slice(3)) : [];
    return { ...info, newCommits, ...(latestVersion ? { latestVersion } : {}), localChanges, checkedAt: new Date().toISOString() };
  }

  /** @returns The progress of the current or last update. */
  status(): UpdateProgress {
    return { ...this.progress, log: this.progress.log.slice(-200) };
  }

  private step(name: string, cmd: string, args: string[]): Promise<void> {
    this.progress.step = name;
    this.progress.log.push(`$ ${cmd} ${args.join(" ")}`);
    return new Promise((resolvePromise, reject) => {
      const child = spawn(cmd, args, { cwd: this.root, shell: true, windowsHide: true, env: { ...process.env, CI: "1" } });
      const onData = (b: Buffer) => this.progress.log.push(...b.toString().split(/\r?\n/).filter(Boolean));
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolvePromise() : reject(new Error(`${name} failed (exit code ${code})`))));
    });
  }

  /**
   * Starts updating in the background. Poll {@link status} for progress.
   *
   * @returns The initial progress.
   * @throws Error if an update is already running or this is not a git checkout.
   */
  async apply(): Promise<UpdateProgress> {
    if (this.progress.running) throw new Error("An update is already running.");
    const info = await this.version();
    if (info.install !== "git") throw new Error("This copy cannot update itself.");
    this.progress = { running: true, log: [] };
    void (async () => {
      try {
        await this.step("Downloading the update", "git", ["pull", "--ff-only"]);
        await this.step("Installing dependencies", "pnpm", ["install"]);
        await this.step("Building", "pnpm", ["build:packages"]);
        await this.step("Building the interface", "pnpm", ["--filter", "@kesher/web", "build"]);
        await this.step("Building the desktop app", "pnpm", ["--filter", "@kesher/desktop", "build"]);
        // From source (`pnpm dev`) the server and UI reload themselves; a built copy needs a restart.
        this.progress.restartRequired = !import.meta.url.endsWith(".ts");
        this.progress.step = "Done";
      } catch (err) {
        this.progress.error = err instanceof Error ? err.message : String(err);
      } finally {
        this.progress.running = false;
        this.progress.finishedAt = new Date().toISOString();
      }
    })();
    return this.status();
  }
}
