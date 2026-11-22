import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { InboxTaskView } from "@kesher/shared";
import { convertedCopyPath, parseConvertTitle, PLUGIN_SOURCES, type PluginEngine } from "./engine-support.js";
import type { InstallJob } from "./unreal-install.js";

/**
 * An AI-converted plugin copy, from "ready" to installed in a project and back (Roee, 2026-11-21). "Convert with AI"
 * (engine-support.ts) only makes a branch; this is the rest: the page shows "AI-converted plugin for <version> is ready",
 * and it installs by itself into every project on this computer of that engine version (Roee 2026-11-22; Settings ›
 * Task inbox › autoInstallConverted turns that off, then "Install this copy" does it by hand). "Revert to none" removes
 * it. Only a project found on this computer is touched (so it works from the phone), and the files are read from the
 * task's commit with git (no checkout, no scripts run).
 */

/** The file beside an installed copy that says it is an AI-converted one (and is the only kind "Revert to none" removes). */
export const MARKER_FILE = ".kesher-converted.json";

/** The most files and bytes a converted copy may have (the plugin is about 40 files; a runaway task is refused). */
export const MAX_COPY_FILES = 80;
export const MAX_COPY_BYTES = 5 * 1024 * 1024;

/** What is written beside an installed AI-converted copy. */
export interface ConvertedMarker {
  /** The inbox task that made it. */
  taskId: string;
  engine: PluginEngine;
  /** The engine version it was converted for, e.g. "2020.3.48f1". */
  version: string;
  /** The commit it was read from. */
  sha: string;
  /** When it was installed (ms since epoch). */
  at: number;
}

/** A finished conversion task, as the page lists it for review. */
export interface ReadyCopy {
  taskId: string;
  engine: PluginEngine;
  /** The target version the task named. */
  version: string;
  /** Where the copy is in the branch (`integrations/unity/com.kesherai.bridge-unity2020.3`). */
  copy: string;
  branch: string;
  /** The reviewed commit (installing reads exactly this). */
  sha?: string;
  /** The diff summary from the task's result. */
  filesChanged: number;
  added: number;
  removed: number;
  /** The first files, for the review list. */
  files: Array<{ path: string; added: number; removed: number }>;
  /** Who did it: Antigravity or the local model. */
  runBy: string;
  endedAt?: number;
}

/**
 * The AI-converted copies that are ready to review: finished ("done": its checks passed) "Convert with AI" tasks that
 * changed files, the newest one for each engine and version.
 *
 * @param tasks - The task inbox's tasks.
 * @returns The ready copies, newest first.
 */
export function readyCopies(tasks: InboxTaskView[]): ReadyCopy[] {
  const out = new Map<string, ReadyCopy>();
  for (const t of [...tasks].sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))) {
    const what = parseConvertTitle(t.title);
    if (!what || t.status !== "done" || !t.files?.length || !t.branch) continue;
    const copy = convertedCopyPath(what.engine, what.version);
    // Only the copy's own folder counts: a task that also changed something else is not a clean copy.
    const own = t.files.filter((f) => f.path.startsWith(`${copy}/`));
    if (!own.length || own.length !== t.files.length) continue;
    out.set(copy, {
      taskId: t.id,
      engine: what.engine,
      version: what.version,
      copy,
      branch: t.branch,
      ...(t.headSha ? { sha: t.headSha } : {}),
      filesChanged: own.length,
      added: own.reduce((n, f) => n + f.added, 0),
      removed: own.reduce((n, f) => n + f.removed, 0),
      files: own.slice(0, 12).map((f) => ({ path: f.path.slice(copy.length + 1), added: f.added, removed: f.removed })),
      runBy: t.runBy,
      ...(t.endedAt ? { endedAt: t.endedAt } : {}),
    });
  }
  return [...out.values()].sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
}

/** Where an engine's plugin lives inside a project. */
export function pluginFolder(engine: PluginEngine, project: string): string {
  return engine === "unity" ? join(project, "Packages", "com.kesherai.bridge") : join(project, "Plugins", "KesherAIBridge");
}

/**
 * Writes the marker of an installed AI-converted copy.
 *
 * @param dest - The installed plugin's folder.
 * @param marker - What to record.
 */
export async function writeConvertedMarker(dest: string, marker: ConvertedMarker): Promise<void> {
  await writeFile(join(dest, MARKER_FILE), JSON.stringify(marker, null, 1), "utf8");
}

/**
 * Reads the marker of an installed AI-converted copy.
 *
 * @param engine - Unity or Unreal.
 * @param project - The project folder.
 * @returns The marker, or undefined when the project has none (no plugin, or KesherAI's own).
 */
export async function readConvertedMarker(engine: PluginEngine, project: string): Promise<ConvertedMarker | undefined> {
  try {
    const m = JSON.parse((await readFile(join(pluginFolder(engine, project), MARKER_FILE), "utf8")).replace(/^\uFEFF/, "")) as Partial<ConvertedMarker>;
    return m && typeof m.taskId === "string" && typeof m.version === "string" ? { taskId: m.taskId, engine, version: m.version, sha: String(m.sha ?? ""), at: Number(m.at) || 0 } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * "Revert to none": removes an installed AI-converted copy from a project. Only a folder with the converted-copy marker
 * is removed, never KesherAI's own plugin or anything else.
 *
 * @param engine - Unity or Unreal.
 * @param project - The project folder.
 * @returns True when a converted copy was removed, false when there was none.
 */
export async function revertConvertedCopy(engine: PluginEngine, project: string): Promise<boolean> {
  if (!(await readConvertedMarker(engine, project))) return false;
  await rm(pluginFolder(engine, project), { recursive: true, force: true });
  if (engine === "unity") await rm(join(project, "Temp", "KesherBridge.ok"), { force: true });
  return true;
}

/** Runs git and returns its output as bytes (a plugin has pictures). */
export type GitBytes = (cwd: string, args: string[]) => Promise<{ code: number; out: Buffer }>;

/** A leftover of the pure-text parse: the entries `git ls-tree -r -l -z` lists. */
interface TreeEntry {
  mode: string;
  oid: string;
  size: number;
  path: string;
}

/**
 * Parses `git ls-tree -r -l -z` output (`<mode> blob <oid> <size>\t<path>\0`).
 *
 * @param text - The output.
 */
export function parseTree(text: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  for (const rec of text.split("\0")) {
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(\d+|-)\t([\s\S]+)$/.exec(rec);
    if (m) out.push({ mode: m[1]!, oid: m[3]!, size: m[4] === "-" ? 0 : Number(m[4]), path: m[5]! });
  }
  return out;
}

/** Whether a path inside the copy is safe to write: relative, no `..`, no drive letters or odd characters. */
const safeRel = (p: string) => p.length > 0 && !p.startsWith("/") && !/(^|\/)\.\.?(\/|$)/.test(p) && !/[\\:\0]/.test(p);

/**
 * Reads a converted copy's files out of a git commit into a folder, without checking anything out: only the copy's
 * folder, only plain files (no symlinks or submodules), at most {@link MAX_COPY_FILES} files and {@link MAX_COPY_BYTES}.
 *
 * @param git - Runs git (bytes).
 * @param repo - The KesherAI source folder.
 * @param ref - The commit or branch to read.
 * @param copy - The copy's folder in the commit.
 * @param dest - Where the files go (emptied first, unless `keep`).
 * @param keep - Write over what is already in dest instead of emptying it (the converted files over the original's).
 * @returns The commit's full id.
 * @throws Error when the commit or folder is missing, or the copy is not a plain folder of files.
 */
export async function extractCopy(git: GitBytes, repo: string, ref: string, copy: string, dest: string, keep = false): Promise<string> {
  if (!/^[\w./-]+$/.test(copy) || copy.includes("..")) throw new Error("The copy's folder name is not valid.");
  // A ref that starts with "-" would be read by git as an option.
  if (ref.startsWith("-")) throw new Error("The converted copy's branch name is not valid.");
  const rev = await git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const sha = rev.out.toString("utf8").trim();
  if (rev.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) throw new Error("The converted copy's branch was not found on this computer. Open the task and sync, then try again.");
  const tree = await git(repo, ["ls-tree", "-r", "-l", "-z", sha, "--", `${copy}/`]);
  if (tree.code !== 0) throw new Error("The converted copy's folder could not be read.");
  const entries = parseTree(tree.out.toString("utf8"));
  if (!entries.length) throw new Error("The converted copy has no files.");
  if (entries.length > MAX_COPY_FILES || entries.reduce((n, e) => n + e.size, 0) > MAX_COPY_BYTES) throw new Error("The converted copy is larger than a plugin should be, so KesherAI did not install it.");
  const bad = entries.find((e) => (e.mode !== "100644" && e.mode !== "100755") || !e.path.startsWith(`${copy}/`) || !safeRel(e.path.slice(copy.length + 1)));
  if (bad) throw new Error(`The converted copy has an entry KesherAI will not install (${bad.path.slice(0, 80)}).`);
  if (!keep) await rm(dest, { recursive: true, force: true });
  for (const e of entries) {
    const blob = await git(repo, ["cat-file", "blob", e.oid]);
    if (blob.code !== 0) throw new Error(`Could not read ${e.path.slice(copy.length + 1)} from the commit.`);
    const file = join(dest, ...e.path.slice(copy.length + 1).split("/"));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, blob.out);
  }
  return sha;
}

/** Whether a folder holds a link (a symlink or junction) anywhere: a copy with one is not installed. */
export async function hasLinks(dir: string): Promise<boolean> {
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const p = join(dir, name);
    const info = await lstat(p).catch(() => undefined);
    if (!info) continue;
    if (info.isSymbolicLink()) return true;
    if (info.isDirectory() && (await hasLinks(p))) return true;
  }
  return false;
}

/** One install of a converted copy, as the page follows it. */
export interface CopyJob {
  engine: PluginEngine;
  /** The project folder's name (never its path). */
  project: string;
  taskId: string;
  state: "reading" | "installing" | "done" | "failed";
  message?: string;
  /** The compiler's errors when Unreal could not build the copy. */
  errors?: string[];
}

/** What the installer needs (replaced in tests). */
export interface CopiesDeps {
  /** The KesherAI source folder the branches are in (Settings > Task inbox > folder). */
  repo: () => string | undefined;
  git: GitBytes;
  /** A folder of KesherAI's own to keep the read copies in. */
  root: string;
  /** Unity: puts the files into the project's Packages folder. */
  installUnity: (project: string, source: string) => Promise<string>;
  /** Unreal: builds the copy for the project's engine and installs it (a job that runs on). */
  installUnreal: (project: string, copy: { source: string; tag: string; marker: ConvertedMarker }) => Promise<void>;
  /** Unreal's installer job now. */
  unrealJob: () => InstallJob | undefined;
  now?: () => number;
}

/**
 * The state of "Install this copy": reading the commit, installing, done or failed; one at a time. The page shows
 * {@link current}; an Unreal install runs on after {@link install} returns (its build takes minutes).
 */
export class ConvertedCopies {
  private job?: CopyJob;

  /** @param d - What the installer needs. */
  constructor(private readonly d: CopiesDeps) {}

  /** @returns The install now or last (undefined: none since the app started). Unreal's follows its own build job. */
  current(): CopyJob | undefined {
    const j = this.job;
    if (!j) return undefined;
    if (j.state === "installing" && j.engine === "unreal") {
      const u = this.d.unrealJob();
      if (u?.state === "done") return { ...j, state: "done", message: u.message ?? "Installed." };
      if (u?.state === "failed") return { ...j, state: "failed", message: u.message ?? "The build failed.", ...(u.errors?.length ? { errors: u.errors } : {}) };
    }
    return { ...j };
  }

  /**
   * Installs a reviewed copy into a project. The caller has checked that the project is one found on this computer and
   * that its engine version matches the copy's.
   *
   * @param copy - The ready copy the user reviewed.
   * @param project - The project folder.
   * @throws Error when another install runs, the source folder is unknown, or the copy is not a plain folder of files.
   */
  async install(copy: ReadyCopy, project: string): Promise<void> {
    const running = this.current();
    if (running && (running.state === "reading" || running.state === "installing")) throw new Error("A converted copy is being installed. Wait for it to finish.");
    const repo = this.d.repo();
    if (!repo) throw new Error("KesherAI's source folder is not set (Settings > Task inbox > folder), so the converted copy cannot be read.");
    const job: CopyJob = { engine: copy.engine, project: basename(project), taskId: copy.taskId, state: "reading" };
    this.job = job;
    try {
      const source = join(this.d.root, `${copy.engine}-${copy.taskId.replace(/[^\w.-]/g, "_")}`);
      // The original plugin first, then the converted files over it: an agent often writes only the files it changed
      // (r-20261122-02 wrote 11 of the plugin's files, and the build missed the rest).
      const ref = copy.sha ?? copy.branch;
      await extractCopy(this.d.git, repo, ref, PLUGIN_SOURCES[copy.engine].source, source).catch(() => undefined);
      const sha = await extractCopy(this.d.git, repo, ref, copy.copy, source, true);
      if (await hasLinks(source)) throw new Error("The converted copy has a link inside it, so KesherAI did not install it.");
      const marker: ConvertedMarker = { taskId: copy.taskId, engine: copy.engine, version: copy.version, sha, at: (this.d.now ?? Date.now)() };
      job.state = "installing";
      if (copy.engine === "unity") {
        job.message = await this.d.installUnity(project, source);
        await writeConvertedMarker(pluginFolder("unity", project), marker);
        job.state = "done";
      } else {
        await this.d.installUnreal(project, { source, tag: sha.slice(0, 8), marker });
      }
    } catch (e) {
      job.state = "failed";
      job.message = (e as Error).message;
      throw e;
    }
  }
}
