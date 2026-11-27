/**
 * A code session in its own git worktree (like Claude Code's `--worktree` and Codex's worktree chats):
 * its own folder and branch, so two sessions on one project never touch each other's files and the
 * user's own checkout stays as it is.
 *
 * - Folder: `<worktreesDir>/<repo name>/<name>` when a worktrees folder is set (see {@link resolveWorktreesDir}: by
 *   default a `worktrees` folder next to the models folder when that is on another drive than Windows, because each
 *   worktree gets its own packages, GBs on the system drive); otherwise `<repo>/.kesher/worktrees/<name>`.
 *   Branch `kesher/<name>`, from the checkout's current commit. `.kesher/worktrees/` goes in the repo's local exclude
 *   file (`.git/info/exclude`), never in its .gitignore.
 * - `.worktreeinclude` at the repo root (the file Claude Code reads, .gitignore syntax) names ignored files
 *   to copy into each new worktree, such as `.env`. Only ignored files are copied; tracked ones are already there.
 * - Removing: only when it holds no work (no changed or untracked files, no commits of its own),
 *   unless the user says to remove it anyway.
 */
import { copyFile, mkdir, readFile, appendFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { readdir, rm, rmdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep, win32 } from "node:path";
import ignore from "ignore";

/** Runs git in a folder; resolves with its output, rejects with its error text. */
export type Git = (cwd: string, args: string[]) => Promise<string>;

/** A code session's own worktree: where it is, its branch and the commit it started from. */
export interface SessionWorktree {
  /** The user's checkout (the repo root). */
  repo: string;
  /** The worktree's folder. */
  path: string;
  branch: string;
  /** The commit it started from. */
  base: string;
}

/**
 * The commit a task run's own changes are measured from. A fresh run starts at the fetched base, so that commit is it.
 * A run that continues from an earlier partial branch starts elsewhere, and the base ref has usually moved on since
 * (a release bump or a new feature landed): comparing against the moved ref would list main's own changes as the
 * run's (2026-11-27, task o-20261127-18). The merge-base of the start and the base ref is the commit the partial work
 * grew from, so the diff holds the partial work and the new work, never what main gained.
 *
 * @param git - The git runner.
 * @param repo - The project.
 * @param start - What the worktree was made from (a commit or a ref).
 * @param taskBase - The task's base ref, as fetched when the run started.
 * @returns The commit sha to diff against; the start commit when the two share no history.
 */
export async function runBaseCommit(git: Git, repo: string, start: string, taskBase: string): Promise<string> {
  const sha = (await git(repo, ["rev-parse", "--verify", `${start}^{commit}`])).trim();
  if (start === taskBase) return sha;
  const mb = (await git(repo, ["merge-base", start, taskBase]).catch(() => "")).trim();
  return /^[0-9a-f]{40}$/.test(mb) ? mb : sha;
}

/** The configured worktrees folder (set once at start-up from {@link resolveWorktreesDir}); undefined: inside each repo. */
let worktreesRoot: string | undefined;

/** Sets the folder all session, inbox and self-work worktrees go under (undefined: `<repo>/.kesher/worktrees`). */
export function setWorktreesRoot(dir: string | undefined): void {
  worktreesRoot = dir && isAbsolute(dir) ? dir : undefined;
}

/** The worktrees folder in use (undefined: inside each repo). */
export function getWorktreesRoot(): string | undefined {
  return worktreesRoot;
}

/**
 * Where worktrees go: the `worktreesDir` setting; else a `worktrees` folder next to the models folder when that is on
 * another drive than Windows (so the GBs of packages leave C:); else undefined (inside each repo, as before).
 *
 * @param configured - The `worktreesDir` setting.
 * @param modelsDir - The models folder.
 * @param systemDrive - Windows' drive (`C:`); default from the environment.
 */
export function resolveWorktreesDir(configured: string | undefined, modelsDir: string, systemDrive = process.env.SystemDrive ?? "C:"): string | undefined {
  if (configured?.trim()) return resolve(configured.trim());
  const drive = /^([A-Za-z]:)/.exec(modelsDir)?.[1]?.toUpperCase();
  if (!drive || drive === systemDrive.toUpperCase()) return undefined;
  return win32.join(win32.dirname(modelsDir), "worktrees");
}

/** The folder of one worktree: `<root>/<repo name>/<name>` with a worktrees folder, else inside the repo. */
export function worktreeFolder(repo: string, name: string): string {
  return worktreesRoot ? join(worktreesRoot, basename(repo), name) : join(repo, ".kesher", "worktrees", name);
}

/** A name safe for a folder and a branch. */
export function worktreeName(text: string, now = new Date()): string {
  const slug = text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
  const stamp = now.toISOString().slice(5, 16).replace(/[-T:]/g, "");
  // Two sessions started in the same minute need different names.
  return `${slug || "session"}-${stamp}-${Math.random().toString(16).slice(2, 6).padEnd(4, "0")}`;
}

/** Files to copy into a new worktree: ignored files the repo's `.worktreeinclude` names. */
export function includedFiles(patterns: string, ignoredFiles: string[]): string[] {
  const lines = patterns.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => l.replace(/\\/g, "/"));
  if (!lines.length) return [];
  const ig = ignore().add(lines);
  return ignoredFiles
    .map((f) => f.replace(/\\/g, "/")) // normalize Windows backslashes
    .filter((f) => f && !f.endsWith("/") && ig.ignores(f));
}

/**
 * Keeps `.kesher/worktrees/` out of the user's `git status`, without changing a file they commit (the repo's local
 * exclude file).
 *
 * @param repo - The repo root.
 * @param git - Runs git.
 */
export async function excludeWorktrees(repo: string, git: Git): Promise<void> {
  const exclude = join(resolve(repo, (await git(repo, ["rev-parse", "--git-common-dir"])).trim()), "info", "exclude");
  const had = existsSync(exclude) ? await readFile(exclude, "utf8") : "";
  if (!/^[/\\]?\.kesher[/\\]worktrees[/\\]?$/m.test(had)) {
    await mkdir(dirname(exclude), { recursive: true });
    await appendFile(exclude, `${had && !had.endsWith("\n") ? "\n" : ""}/.kesher/worktrees/\n`);
  }
}

/**
 * Makes a session's worktree.
 *
 * @param folder - A folder inside the user's git checkout.
 * @param name - From {@link worktreeName}.
 * @param git - Runs git.
 * @param opts - `branch`: its own branch name instead of `kesher/<name>` (the task inbox's `agy/…`); `base`: the
 *   commit to start from instead of HEAD; `copyIncluded: false`: do not copy `.worktreeinclude` files (such as `.env`)
 *   into it (a worktree an outside agent works in gets no secrets).
 */
export async function createSessionWorktree(folder: string, name: string, git: Git, opts: { branch?: string; base?: string; copyIncluded?: boolean } = {}): Promise<SessionWorktree> {
  if (!/^[a-z0-9-]{1,60}$/.test(name)) throw new Error("Bad worktree name.");
  let repo: string;
  try {
    repo = resolve((await git(folder, ["rev-parse", "--show-toplevel"])).trim());
  } catch {
    throw new Error("This folder is not a git project, so it cannot have a worktree. Start the session without one, or run `git init` there first.");
  }
  const base = (await git(repo, ["rev-parse", "--verify", `${opts.base ?? "HEAD"}^{commit}`]).catch(() => "")).trim();
  if (!base) throw new Error(opts.base ? `There is no commit ${opts.base} in this project.` : "The git project has no commit yet: commit once, then start a session in a worktree.");
  // A folder left by an earlier failed run (27.11: "'…/gcli-o-…-2' already exists" failed a GhostCLI task): forget
  // worktrees whose folders are gone, then take the next free folder name. The old folder is never deleted (it may
  // hold work).
  let path = worktreeFolder(repo, name);
  if (existsSync(path)) {
    await git(repo, ["worktree", "prune"]).catch(() => "");
    for (let i = 2; existsSync(path) && i <= 9; i++) path = worktreeFolder(repo, `${name}-${i}`.slice(-60).replace(/^-+/, ""));
    if (existsSync(path)) throw new Error("Every work folder name for this run is taken; remove old ones in Settings › Worktrees.");
  }
  const branch = opts.branch ?? `kesher/${name}`;
  if (!worktreesRoot) await excludeWorktrees(repo, git);
  await mkdir(dirname(path), { recursive: true });
  await git(repo, ["worktree", "add", "-b", branch, path, base]);
  // .worktreeinclude: ignored files (.env and the like) the new checkout needs.
  const want = opts.copyIncluded !== false && existsSync(join(repo, ".worktreeinclude")) ? await readFile(join(repo, ".worktreeinclude"), "utf8") : "";
  if (want.trim()) {
    // --directory: an ignored folder (node_modules) is one line, so the list stays short and .env is not cut off.
    const ignored = (await git(repo, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"]).catch(() => "")).split(/\r?\n/);
    for (const f of includedFiles(want, ignored).filter((x) => !x.startsWith(".kesher/") && !x.startsWith(".kesher\\")).slice(0, 500)) {
      const to = join(path, f);
      await mkdir(dirname(to), { recursive: true });
      await copyFile(join(repo, f), to).catch(() => undefined);
    }
  }
  return { repo, path, branch, base };
}

/** What a worktree holds that removing it would lose. */
export async function worktreeWork(wt: SessionWorktree, git: Git): Promise<{ changed: number; commits: number; gone: boolean }> {
  if (!existsSync(wt.path)) return { changed: 0, commits: 0, gone: true };
  const status = await git(wt.path, ["status", "--porcelain"]);
  const changed = status.split(/\r?\n/).filter((l) => l.trim()).length;
  const commits = Number((await git(wt.path, ["rev-list", "--count", `${wt.base}..HEAD`]).catch(() => "0")).trim()) || 0;
  return { changed, commits, gone: false };
}

/**
 * Removes a session's worktree and its branch.
 *
 * @param force - Remove even with work in it (the user said so).
 * @returns false when it holds work and `force` was not given.
 */
export async function removeSessionWorktree(wt: SessionWorktree, git: Git, force = false): Promise<boolean> {
  const work = await worktreeWork(wt, git);
  if (!force && (work.changed || work.commits)) return false;
  if (!work.gone) await git(wt.repo, ["worktree", "remove", "--force", wt.path]);
  else await git(wt.repo, ["worktree", "prune"]).catch(() => "");
  await git(wt.repo, ["branch", "-D", wt.branch]).catch(() => "");
  return true;
}

/** One finished worktree the sweep removed. */
export interface SweptWorktree {
  path: string;
  branch?: string;
  /** A leftover folder git no longer knows (its registration was pruned), removed as a plain folder. */
  orphan?: true;
}

/**
 * The daily sweep: removes worktrees of `repo` that are done with. A worktree goes when it is one KesherAI made (under
 * the worktrees folder or `<repo>/.kesher/worktrees`), no task runs in it, it was last touched more than a day ago,
 * it has no uncommitted or untracked files and its HEAD is on a remote branch (so the work is safe on the remote).
 * Everything else stays. Then `git worktree prune`.
 *
 * @param repo - The repo root.
 * @param git - Runs git.
 * @param o - `isBusy`: whether a task still uses this folder; `now`: the time (ms); `minAgeMs`: how old, default 1 day.
 * @returns The worktrees removed.
 */
export async function sweepWorktrees(repo: string, git: Git, o: { isBusy?: (path: string) => boolean; now?: number; minAgeMs?: number } = {}): Promise<SweptWorktree[]> {
  const now = o.now ?? Date.now();
  const minAge = o.minAgeMs ?? 24 * 3600_000;
  // Real, long paths on both sides: git prints long paths with "/", while a folder can be reached through a short 8.3
  // name or a link (Windows temp folders do), and a mismatch would treat a live worktree as an orphan.
  const real = (p: string) => {
    try {
      return realpathSync.native(p).toLowerCase();
    } catch {
      return resolve(p).toLowerCase();
    }
  };
  const inside = (p: string, root: string) => real(p).startsWith(`${real(root)}${sep}`);
  const roots = [join(repo, ".kesher", "worktrees"), ...(worktreesRoot ? [join(worktreesRoot, basename(repo))] : [])];
  const listed = (await git(repo, ["worktree", "list", "--porcelain"]).catch(() => "")).split(/\r?\n\r?\n/);
  const removed: SweptWorktree[] = [];
  const known = new Set<string>();
  for (const block of listed) {
    const path = /^worktree (.+)$/m.exec(block)?.[1]?.trim();
    if (path) known.add(real(path));
    if (!path || !roots.some((r) => inside(path, r))) continue;
    if (o.isBusy?.(path)) continue;
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]?.trim();
    const touched = await stat(path).then((st) => st.mtimeMs).catch(() => undefined);
    if (touched !== undefined && now - touched < minAge) continue;
    if (touched !== undefined) {
      // Uncommitted work, or a HEAD no remote branch holds, keeps the folder.
      const dirty = (await git(path, ["status", "--porcelain"]).catch(() => "x")).trim();
      const onRemote = (await git(path, ["branch", "-r", "--contains", "HEAD"]).catch(() => "")).trim();
      if (dirty || !onRemote) continue;
      await git(repo, ["worktree", "remove", "--force", path]).catch(() => "");
    }
    removed.push({ path, ...(branch ? { branch } : {}) });
  }
  await git(repo, ["worktree", "prune"]).catch(() => "");
  // Orphans: folders directly under a worktrees folder that git has forgotten (a pushed branch kept the work).
  for (const root of roots) {
    for (const d of await readdir(root).catch(() => [])) {
      const path = join(root, d);
      if (known.has(real(path)) || o.isBusy?.(path)) continue;
      const touched = await stat(path).then((st) => (st.isDirectory() ? st.mtimeMs : undefined)).catch(() => undefined);
      if (touched === undefined || now - touched < minAge) continue;
      await rm(path, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
      if (!existsSync(path)) removed.push({ path, orphan: true });
    }
  }
  return removed;
}

/** Empty folders left under the worktrees folder after removals (`<root>/<repo name>`), best effort. */
export async function tidyWorktreesRoot(): Promise<void> {
  if (!worktreesRoot) return;
  for (const d of await readdir(worktreesRoot).catch(() => [])) {
    const dir = join(worktreesRoot, d);
    if (!(await readdir(dir).catch(() => ["x"])).length) await rmdir(dir).catch(() => undefined);
  }
}
