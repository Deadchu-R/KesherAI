/**
 * A code session in its own git worktree (like Claude Code's `--worktree` and Codex's worktree chats):
 * its own folder and branch, so two sessions on one project never touch each other's files and the
 * user's own checkout stays as it is.
 *
 * - Folder: `<repo>/.kesher/worktrees/<name>`, branch `kesher/<name>`, from the checkout's current commit.
 *   `.kesher/worktrees/` goes in the repo's local exclude file (`.git/info/exclude`), never in its .gitignore.
 * - `.worktreeinclude` at the repo root (the file Claude Code reads, .gitignore syntax) names ignored files
 *   to copy into each new worktree, such as `.env`. Only ignored files are copied; tracked ones are already there.
 * - Removing: only when it holds no work (no changed or untracked files, no commits of its own),
 *   unless the user says to remove it anyway.
 */
import { copyFile, mkdir, readFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

/** A name safe for a folder and a branch. */
export function worktreeName(text: string, now = new Date()): string {
  const slug = text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
  const stamp = now.toISOString().slice(5, 16).replace(/[-T:]/g, "");
  // Two sessions started in the same minute need different names.
  return `${slug || "session"}-${stamp}-${Math.random().toString(16).slice(2, 6).padEnd(4, "0")}`;
}

/** Files to copy into a new worktree: ignored files the repo's `.worktreeinclude` names. */
export function includedFiles(patterns: string, ignoredFiles: string[]): string[] {
  const lines = patterns.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (!lines.length) return [];
  const ig = ignore().add(lines);
  return ignoredFiles.filter((f) => f && !f.endsWith("/") && ig.ignores(f));
}

/**
 * Makes a session's worktree.
 *
 * @param folder - A folder inside the user's git checkout.
 * @param name - From {@link worktreeName}.
 * @param git - Runs git.
 */
export async function createSessionWorktree(folder: string, name: string, git: Git): Promise<SessionWorktree> {
  if (!/^[a-z0-9-]{1,60}$/.test(name)) throw new Error("Bad worktree name.");
  let repo: string;
  try {
    repo = resolve((await git(folder, ["rev-parse", "--show-toplevel"])).trim());
  } catch {
    throw new Error("This folder is not a git project, so it cannot have a worktree. Start the session without one, or run `git init` there first.");
  }
  const base = (await git(repo, ["rev-parse", "HEAD"]).catch(() => "")).trim();
  if (!base) throw new Error("The git project has no commit yet: commit once, then start a session in a worktree.");
  const path = join(repo, ".kesher", "worktrees", name);
  const branch = `kesher/${name}`;
  // Keep the worktrees out of the user's `git status`, without changing a file they commit.
  const exclude = join(resolve(repo, (await git(repo, ["rev-parse", "--git-common-dir"])).trim()), "info", "exclude");
  const had = existsSync(exclude) ? await readFile(exclude, "utf8") : "";
  if (!/^\/?\.kesher\/worktrees\/?$/m.test(had)) {
    await mkdir(dirname(exclude), { recursive: true });
    await appendFile(exclude, `${had && !had.endsWith("\n") ? "\n" : ""}/.kesher/worktrees/\n`);
  }
  await mkdir(dirname(path), { recursive: true });
  await git(repo, ["worktree", "add", "-b", branch, path, base]);
  // .worktreeinclude: ignored files (.env and the like) the new checkout needs.
  const want = existsSync(join(repo, ".worktreeinclude")) ? await readFile(join(repo, ".worktreeinclude"), "utf8") : "";
  if (want.trim()) {
    const ignored = (await git(repo, ["ls-files", "--others", "--ignored", "--exclude-standard"]).catch(() => "")).split(/\r?\n/);
    for (const f of includedFiles(want, ignored).filter((x) => !x.startsWith(".kesher/")).slice(0, 500)) {
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
