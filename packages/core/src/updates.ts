import { fetchRetrying } from "@kesher/downloads";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fastDownload, redact } from "./fast-download.js";
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
  /** A newer version whose installer for this computer is not published yet (still being built). */
  building?: string;
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
  private pending?: { url: string; name: string; size: number; feedUrl?: string };

  /**
   * @param root - The repository folder (defaults to three levels above this file).
   * @param packaged - For installed copies: where releases come from and how to run an installer.
   */
  constructor(
    private readonly root = resolve(import.meta.dirname, "../../.."),
    private readonly packaged?: PackagedUpdates,
    /** Where update logs are kept (the last ten), with timings and no secrets. */
    private readonly logDir?: string,
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
  private async checkRelease(info: VersionInfo, force = false): Promise<UpdateCheck> {
    if (!this.packaged) throw new Error("This copy was not installed with git, so it cannot update itself here.");
    type Release = { tag_name: string; name?: string; body?: string; draft?: boolean; prerelease?: boolean; assets: Array<{ name: string; browser_download_url: string; size: number }> };
    const res = await fetchRetrying(`${this.packaged.api ?? "https://api.github.com"}/repos/${this.packaged.repo}/releases?per_page=10`, { headers: { accept: "application/vnd.github+json", "user-agent": "KesherAI" }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) return { ...info, newCommits: [], localChanges: [], checkedAt: new Date().toISOString() };
    let releases: Release[];
    if (res.ok) releases = ((await res.json()) as Release[]).filter((r) => !r.draft && !r.prerelease && /^v?\d+\.\d+\.\d+$/.test(r.tag_name));
    else if (res.status === 403 || res.status === 429) releases = [await this.releaseFromFeed()];
    else throw new Error(`GitHub answered ${res.status} while looking for a new version.`);
    releases.sort((a, b) => compareVersions(b.tag_name.replace(/^v/, ""), a.tag_name.replace(/^v/, "")));
    // The newest release that has an installer for this computer (a newer one may still be building).
    const usable = releases.find((r) => installerFor(r.assets.map((a) => a.name)));
    const newest = releases[0];
    const building = newest && newest !== usable && compareVersions(newest.tag_name.replace(/^v/, ""), info.version) > 0 ? newest.tag_name.replace(/^v/, "") : undefined;
    if (!usable) return { ...info, newCommits: [], localChanges: [], checkedAt: new Date().toISOString(), ...(building ? { building } : {}) };
    const rel = usable;
    const latestVersion = rel.tag_name.replace(/^v/, "");
    const newer = compareVersions(latestVersion, info.version) > 0;
    const file = installerFor(rel.assets.map((a) => a.name));
    const asset = rel.assets.find((a) => a.name === file);
    // The installer's sha512 is in the release's update feed (latest.yml): checked before it runs.
    const feedName = process.platform === "darwin" ? "latest-mac.yml" : process.platform === "linux" ? "latest-linux.yml" : "latest.yml";
    const feed = rel.assets.find((a) => a.name === feedName);
    this.pending = (newer || force) && asset ? { url: asset.browser_download_url, name: asset.name, size: asset.size, ...(feed ? { feedUrl: feed.browser_download_url } : {}) } : undefined;
    // What's new: the release notes' bullet points, shown like the git copy's list of changes.
    const notes = (rel.body ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[-*] /.test(l)).map((l) => l.replace(/^[-*] /, "").replace(/\*\*/g, "")).slice(0, 12);
    const newCommits = newer ? (notes.length ? notes : [rel.name ?? `v${latestVersion}`]).map((subject, i) => ({ hash: i === 0 ? `v${latestVersion}` : "", subject })) : [];
    return { ...info, newCommits, latestVersion, localChanges: [], checkedAt: new Date().toISOString(), ...(building ? { building } : {}) };
  }

  /**
   * When GitHub's API limit is reached (403), reads the update feed the
   * installer build publishes next to the files (latest.yml), which is not limited.
   */
  private async releaseFromFeed(): Promise<{ tag_name: string; name?: string; body?: string; assets: Array<{ name: string; browser_download_url: string; size: number }> }> {
    const feed = process.platform === "darwin" ? "latest-mac.yml" : process.platform === "linux" ? "latest-linux.yml" : "latest.yml";
    const base = `https://github.com/${this.packaged!.repo}/releases/latest/download`;
    const res = await fetchRetrying(`${base}/${feed}`, { headers: { "user-agent": "KesherAI" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`GitHub is busy right now (${res.status}). Try again in a few minutes.`);
    const yml = await res.text();
    const version = /^version:\s*['"]?([^'"\s]+)/m.exec(yml)?.[1];
    if (!version) throw new Error("The update feed could not be read.");
    const files = [...yml.matchAll(/^\s*-?\s*url:\s*['"]?([^'"\s]+)/gm)].map((m) => m[1]!);
    const sizes = [...yml.matchAll(/^\s*size:\s*(\d+)/gm)].map((m) => Number(m[1]));
    return { tag_name: `v${version}`, name: `KesherAI ${version}`, assets: [...new Set(files)].map((name, i) => ({ name, size: sizes[i] ?? 0, browser_download_url: `${base}/${name}` })) };
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
    const t0 = Date.now();
    const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1)} s]`;
    const logLines: string[] = [];
    const line = (text: string) => {
      const l = redact(`${stamp()} ${text}`);
      logLines.push(`${new Date().toISOString()} ${l}`);
      prog(this.packagedProgress.step ?? "", l);
    };
    const saveLog = async () => {
      if (!this.logDir) return;
      try {
        await mkdir(this.logDir, { recursive: true });
        await writeFile(join(this.logDir, `update-${new Date(t0).toISOString().replace(/[:.]/g, "-")}.log`), `${logLines.join("\n")}\n`);
        const old = (await readdir(this.logDir)).filter((f) => /^update-.*\.log$/.test(f)).sort().slice(0, -10);
        for (const f of old) await rm(join(this.logDir, f), { force: true });
      } catch {
        // a log that cannot be written never stops the update
      }
    };
    this.packagedProgress = { running: true, step: "Downloading", log: [] };
    line(`Updating to ${p.name} (${(p.size / 1048576).toFixed(0)} MB) from GitHub`);
    void (async () => {
      try {
        const file = join(tmpdir(), p.name);
        let lastLogged = 0;
        await fastDownload(p.url, file, {
          size: p.size,
          headers: { "user-agent": "KesherAI" },
          log: line,
          onProgress: (got, total, bps) => {
            const pct = Math.floor((got / total) * 100);
            const eta = bps > 0 ? Math.round((total - got) / bps) : 0;
            prog(`Downloading ${pct}% · ${(bps / 1048576).toFixed(1)} MB/s · ${eta} s left`);
            if (pct - lastLogged >= 25) {
              lastLogged = pct;
              line(`${pct}% at ${(bps / 1048576).toFixed(1)} MB/s`);
            }
          },
        });
        // Integrity: the file must match the sha512 the release published for it.
        const feedUrl = p.feedUrl ?? `https://github.com/${installer.repo}/releases/latest/download/${process.platform === "darwin" ? "latest-mac.yml" : process.platform === "linux" ? "latest-linux.yml" : "latest.yml"}`;
        const yml = await fetchRetrying(feedUrl, { headers: { "user-agent": "KesherAI" }, signal: AbortSignal.timeout(20_000) }).then((r) => (r.ok ? r.text() : ""), () => "");
        const want = expectedSha512(yml, p.name);
        if (want) {
          const have = createHash("sha512").update(await readFile(file)).digest("base64");
          if (have !== want) {
            await rm(file, { force: true });
            throw new Error("The downloaded installer does not match the release's fingerprint (sha512), so it was deleted and not run. Try again.");
          }
          line("Checked the installer's sha512 against the release: it matches");
        } else line("The release has no sha512 for this file; installing without that check");
        line(`Downloaded in ${((Date.now() - t0) / 1000).toFixed(0)} s; starting the installer`);
        prog("Installing");
        await installer.install(file);
        line("The installer started; the app restarts when it finishes");
        this.packagedProgress = { ...this.packagedProgress, running: false, step: "Done", finishedAt: new Date().toISOString() } as UpdateProgress;
      } catch (err) {
        const msg = (err as Error).message;
        line(`Failed: ${msg}`);
        this.packagedProgress = { ...this.packagedProgress, running: false, error: /5\d\d/.test(msg) ? `${msg} GitHub's downloads are having trouble; try again in a few minutes.` : msg };
      } finally {
        await saveLog();
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
   * Installed copies: downloads the latest version's installer and runs it,
   * even when it is the version already installed (a repair).
   *
   * @returns The initial progress.
   */
  async reinstall(): Promise<UpdateProgress> {
    if (this.status().running) throw new Error("An update is already running.");
    const info = await this.version();
    if (info.install === "git") throw new Error("This copy runs from the source code: use git to get a fresh copy.");
    await this.checkRelease(info, true);
    return this.applyRelease();
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

/**
 * The sha512 (base64) the update feed (latest.yml) gives for one file.
 *
 * @param yml - The feed's text.
 * @param name - The installer's file name.
 */
export function expectedSha512(yml: string, name: string): string | undefined {
  const lines = yml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const url = /^\s*-?\s*url:\s*['"]?([^'"\s]+)/.exec(lines[i]!)?.[1];
    if (url !== name) continue;
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      const sha = /^\s*sha512:\s*['"]?([A-Za-z0-9+/=]+)/.exec(lines[j]!)?.[1];
      if (sha) return sha;
    }
  }
  const path = /^path:\s*['"]?([^'"\s]+)/m.exec(yml)?.[1];
  return path === name ? /^sha512:\s*['"]?([A-Za-z0-9+/=]+)/m.exec(yml)?.[1] : undefined;
}
