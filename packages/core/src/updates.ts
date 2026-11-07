import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
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
/** How an installed (not git) copy updates itself: from the project's GitHub releases. */
export interface PackagedUpdates {
  /** The installed app's version (e.g. Electron's app.getVersion()). */
  version: string;
  /** `owner/repo` on GitHub. */
  repo: string;
  /** Runs a downloaded installer (and usually quits the app so it can replace it). */
  install(file: string): Promise<void>;
  /** The GitHub API base (tests pass a fake server). */
  api?: string;
}

/**
 * Compares two versions like `0.4.1` and `0.10.0`.
 *
 * @returns Positive when `a` is newer.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, "").split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/**
 * Picks this system's installer from a release's files.
 *
 * @param names - The release's file names.
 * @param platform - `win32`, `darwin` or `linux`.
 * @param arch - `x64` or `arm64`.
 * @returns The file name, if there is one.
 */
export function installerFor(names: string[], platform = process.platform, arch = process.arch): string | undefined {
  if (platform === "win32") return names.find((n) => /setup.*\.exe$/i.test(n)) ?? names.find((n) => /\.exe$/i.test(n));
  if (platform === "darwin") return names.find((n) => new RegExp(`${arch}.*\\.dmg$`, "i").test(n)) ?? names.find((n) => /\.dmg$/i.test(n));
  return names.find((n) => /\.AppImage$/i.test(n));
}

/** Updates KesherAI: a git checkout in place, or an installed copy from GitHub releases. */
export class Updater {
  private packagedProgress: UpdateProgress = { running: false, log: [] };
  private pending?: { url: string; name: string; size: number };

  /**
   * @param root - The repository folder (defaults to three levels above this file).
   * @param packaged - For installed copies: where releases come from and how to run an installer.
   */
  constructor(
    private readonly root = resolve(import.meta.dirname, "../../.."),
    private readonly packaged?: PackagedUpdates,
  ) {}

  private git(...args: string[]): Promise<string> {
    return exec("git", ["-C", this.root, ...args], { windowsHide: true, timeout: 60_000 }).then((r) => r.stdout.trim());
  }

  /** @returns Version, commit, and how this copy was installed. */
  async version(): Promise<VersionInfo> {
    let version = this.packaged?.version ?? "0.0.0";
    try {
      version = (JSON.parse(readFileSync(join(this.root, "package.json"), "utf8")) as { version: string }).version;
    } catch {
      // not inside the repo (packaged build): the app told us its version
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
    if (info.install !== "git") return this.checkRelease(info);
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

  /** Installed copies: is there a newer release on GitHub, with an installer for this system? */
  private async checkRelease(info: VersionInfo): Promise<UpdateCheck> {
    if (!this.packaged) throw new Error("This copy was not installed with git, so it cannot update itself here.");
    const res = await fetch(`${this.packaged.api ?? "https://api.github.com"}/repos/${this.packaged.repo}/releases/latest`, { headers: { accept: "application/vnd.github+json", "user-agent": "KesherAI" }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) return { ...info, newCommits: [], localChanges: [], checkedAt: new Date().toISOString() };
    if (!res.ok) throw new Error(`GitHub answered ${res.status} while looking for a new version.`);
    const rel = (await res.json()) as { tag_name: string; name?: string; body?: string; assets: Array<{ name: string; browser_download_url: string; size: number }> };
    const latestVersion = rel.tag_name.replace(/^v/, "");
    const newer = compareVersions(latestVersion, info.version) > 0;
    const file = installerFor(rel.assets.map((a) => a.name));
    const asset = rel.assets.find((a) => a.name === file);
    this.pending = newer && asset ? { url: asset.browser_download_url, name: asset.name, size: asset.size } : undefined;
    // What's new: the release notes' bullet points, shown like the git copy's list of changes.
    const notes = (rel.body ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[-*] /.test(l)).map((l) => l.replace(/^[-*] /, "").replace(/\*\*/g, "")).slice(0, 12);
    const newCommits = newer ? (notes.length ? notes : [rel.name ?? `v${latestVersion}`]).map((subject, i) => ({ hash: i === 0 ? `v${latestVersion}` : "", subject })) : [];
    return { ...info, newCommits, latestVersion, localChanges: [], checkedAt: new Date().toISOString() };
  }

  /** Installed copies: downloads the installer with progress, then runs it. */
  private async applyRelease(): Promise<UpdateProgress> {
    if (!this.packaged) throw new Error("This copy cannot update itself.");
    if (!this.pending) await this.checkRelease(await this.version());
    const p = this.pending;
    if (!p) throw new Error("There is no newer version with an installer for this computer.");
    const installer = this.packaged;
    const prog = (step: string, line?: string) => {
      this.packagedProgress = { ...this.packagedProgress, step, log: line ? [...this.packagedProgress.log, line].slice(-200) : this.packagedProgress.log };
    };
    this.packagedProgress = { running: true, step: "Downloading", log: [`Downloading ${p.name}`] };
    void (async () => {
      try {
        const res = await fetch(p.url, { headers: { "user-agent": "KesherAI" } });
        if (!res.ok || !res.body) throw new Error(`The download failed (${res.status}).`);
        const file = join(tmpdir(), p.name);
        const out = createWriteStream(file);
        let got = 0;
        let shown = -1;
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          got += chunk.length;
          if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
          const pct = p.size ? Math.floor((got / p.size) * 100) : 0;
          if (pct !== shown) {
            shown = pct;
            prog(`Downloading ${pct}%`);
          }
        }
        await new Promise<void>((ok, fail) => out.end((err?: Error | null) => (err ? fail(err) : ok())));
        prog("Installing", `Saved ${file}; starting the installer`);
        await installer.install(file);
        this.packagedProgress = { ...this.packagedProgress, running: false, step: "Done", finishedAt: new Date().toISOString() } as UpdateProgress;
      } catch (err) {
        this.packagedProgress = { ...this.packagedProgress, running: false, error: (err as Error).message };
      }
    })();
    return this.packagedProgress;
  }

  /** Where the detached update script writes its progress (survives server restarts). */
  private get statusFile(): string {
    // Inside the repo (git-ignored), so the file is easy to find when something goes wrong.
    return existsSync(join(this.root, ".git")) ? join(this.root, ".kesher-update.json") : join(tmpdir(), `kesher-update-${createHash("sha1").update(this.root).digest("hex").slice(0, 10)}.json`);
  }

  /** @returns The progress of the current or last update. */
  status(): UpdateProgress {
    if (this.packaged && !existsSync(join(this.root, ".git"))) return this.packagedProgress;
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
    if (info.install !== "git") return this.applyRelease();
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
