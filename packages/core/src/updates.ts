import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
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
  /** This copy runs from source (`pnpm dev`): the server restarts itself, the page only needs a reload. */
  fromSource?: boolean;
  finishedAt?: string;
}

/**
 * Checks GitHub for new versions and updates a git checkout in place:
 * `git pull`, `pnpm install`, then the build. When KesherAI runs from source
 * with `pnpm dev`, the server and the UI reload by themselves afterwards.
 * Packaged installers will update through their own updater instead.
 */
export class Updater {
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
    // Untracked files (like a stray download) never block `git pull --ff-only`.
    const status = await this.git("status", "--porcelain", "--untracked-files=no");
    const localChanges = status ? status.split("\n").map((l) => l.slice(3)) : [];
    return { ...info, newCommits, ...(latestVersion ? { latestVersion } : {}), localChanges, checkedAt: new Date().toISOString() };
  }

  /** Where the detached update script writes its progress (survives server restarts). */
  private get statusFile(): string {
    // Inside the repo (git-ignored), so the file is easy to find when something goes wrong.
    return existsSync(join(this.root, ".git")) ? join(this.root, ".kesher-update.json") : join(tmpdir(), `kesher-update-${createHash("sha1").update(this.root).digest("hex").slice(0, 10)}.json`);
  }

  /** @returns The progress of the current or last update. */
  status(): UpdateProgress {
    const fromSource = import.meta.url.endsWith(".ts");
    try {
      // The script may be writing the file at this very moment; read it again once if it is half-written.
      let raw = readFileSync(this.statusFile, "utf8");
      if (!raw.trim().endsWith("}")) raw = readFileSync(this.statusFile, "utf8");
      const p = JSON.parse(raw) as UpdateProgress;
      const done = !p.running && !p.error && p.step === "Done";
      return { ...p, log: p.log.slice(-200), fromSource, ...(done ? { restartRequired: !fromSource } : {}) };
    } catch {
      return { running: existsSync(this.statusFile), step: "Working", log: [], fromSource };
    }
  }

  /**
   * Starts updating in the background, in a separate process so it keeps
   * going if the server restarts. Poll {@link status} for progress.
   *
   * @returns The initial progress.
   * @throws Error if an update is already running or this is not a git checkout.
   */
  async apply(): Promise<UpdateProgress> {
    if (this.status().running) throw new Error("An update is already running.");
    const info = await this.version();
    if (info.install !== "git") throw new Error("This copy cannot update itself.");
    writeFileSync(this.statusFile, JSON.stringify({ running: true, step: "Starting", log: [] }));
    const child = spawn(process.execPath, [join(this.root, "scripts", "update.mjs"), this.statusFile], {
      cwd: this.root,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      // Electron's own binary runs as plain Node with this set.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    child.unref();
    return this.status();
  }
}
