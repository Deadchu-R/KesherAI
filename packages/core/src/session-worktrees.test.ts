import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIn } from "./run-in.js";
import { createSessionWorktree, includedFiles, removeSessionWorktree, resolveWorktreesDir, setWorktreesRoot, sweepWorktrees, worktreeName, worktreeWork, type Git } from "./session-worktrees.js";

const git: Git = async (cwd, args) => {
  const r = await runIn(cwd, "git", args, false);
  if (r.code) throw new Error(r.out);
  return r.out;
};

test("worktree names are safe for folders and branches", () => {
  assert.match(worktreeName("Fix the login bug!", new Date("2026-11-14T00:30:00Z")), /^fix-the-login-bug-11140030-[0-9a-f]{4}$/);
  assert.match(worktreeName("תקן באג"), /^session-\d{8}-[0-9a-f]{4}$/);
});

test(".worktreeinclude picks only the ignored files it names", () => {
  assert.deepEqual(includedFiles(".env\nconfig/*.local.json\n# note", [".env", "node_modules/a.js", "config/db.local.json", "dist/"]), [".env", "config/db.local.json"]);
  assert.deepEqual(includedFiles("", [".env"]), []);
});

test(".worktreeinclude normalizes Windows backslashes in ignored files", () => {
  assert.deepEqual(includedFiles(".env\nbuild\\output.txt", [".env", "build\\output.txt", "src\\main.js"]), [".env", "build/output.txt"]);
});

test("a session worktree: own folder and branch, .env copied, user's status clean, removed only without work", async () => {
  const repo = await mkdtemp(join(tmpdir(), "kesher-wt-"));
  await git(repo, ["init", "-q", "-b", "main"]);
  await writeFile(join(repo, ".gitignore"), ".env\nnode_modules/\n");
  await writeFile(join(repo, "a.txt"), "a\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-qm", "first"]);
  await writeFile(join(repo, ".env"), "KEY=1\n");
  await writeFile(join(repo, ".worktreeinclude"), ".env\n");
  await assert.rejects(createSessionWorktree(await mkdtemp(join(tmpdir(), "kesher-nogit-")), "x", git), /not a git project/);

  const wt = await createSessionWorktree(repo, "s1-11140030", git);
  assert.equal(wt.branch, "kesher/s1-11140030");
  assert.ok(existsSync(join(wt.path, "a.txt")));
  assert.equal(await readFile(join(wt.path, ".env"), "utf8"), "KEY=1\n", ".env copied");
  const status = await git(repo, ["status", "--porcelain"]);
  assert.ok(!status.includes(".kesher"), "the user's checkout does not list the worktrees");
  assert.deepEqual(await worktreeWork(wt, git), { changed: 0, commits: 0, gone: false });

  await writeFile(join(wt.path, "b.txt"), "b\n");
  assert.equal((await worktreeWork(wt, git)).changed, 1);
  assert.equal(await removeSessionWorktree(wt, git), false, "kept: it holds work");
  assert.ok(existsSync(wt.path));
  assert.equal(await removeSessionWorktree(wt, git, true), true);
  assert.ok(!existsSync(wt.path));
  assert.ok(!(await git(repo, ["branch"])).includes("kesher/s1"), "branch removed");
});

test("the worktrees folder: the setting, else next to the models folder when on another drive than Windows", () => {
  assert.equal(resolveWorktreesDir("   ", "E:\\KesherAI\\models", "C:"), "E:\\KesherAI\\worktrees");
  assert.equal(resolveWorktreesDir(undefined, "e:\\KesherAI\\models", "C:"), "e:\\KesherAI\\worktrees");
  assert.equal(resolveWorktreesDir(undefined, "C:\\Users\\x\\models", "c:"), undefined);
  assert.equal(resolveWorktreesDir(undefined, "/home/x/models", "C:"), undefined);
});

/** A repo with a bare remote `origin` and one pushed commit on main. */
async function repoWithRemote(): Promise<{ repo: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "kesher-wt-"));
  const repo = join(dir, "proj");
  const remote = join(dir, "remote.git");
  await git(dir, ["init", "-q", "--bare", remote]);
  await git(dir, ["init", "-q", "-b", "main", repo]);
  await git(repo, ["config", "user.email", "t@example.invalid"]);
  await git(repo, ["config", "user.name", "t"]);
  await writeFile(join(repo, "a.txt"), "a");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-qm", "one"]);
  await git(repo, ["remote", "add", "origin", remote]);
  await git(repo, ["push", "-q", "origin", "main"]);
  return { repo, dir };
}

test("worktrees go under the worktrees folder and the daily sweep removes only the pushed, clean, idle, old ones", async () => {
  const { repo, dir } = await repoWithRemote();
  const root = join(dir, "worktrees");
  setWorktreesRoot(root);
  try {
    const pushed = await createSessionWorktree(repo, "pushed-1", git);
    const dirty = await createSessionWorktree(repo, "dirty-1", git);
    const local = await createSessionWorktree(repo, "local-1", git);
    const busy = await createSessionWorktree(repo, "busy-1", git);
    assert.equal(pushed.path, join(root, "proj", "pushed-1"));
    // pushed: a commit that is on the remote. dirty: pushed but an untracked file. local: a commit no remote holds.
    for (const w of [pushed, dirty, busy]) await git(w.path, ["push", "-q", "origin", `HEAD:refs/heads/${w.branch}`]);
    await git(repo, ["fetch", "-q", "origin"]);
    await writeFile(join(dirty.path, "new.txt"), "x");
    await writeFile(join(local.path, "b.txt"), "b");
    await git(local.path, ["add", "."]);
    await git(local.path, ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "own"]);
    // Too young: nothing goes.
    assert.deepEqual(await sweepWorktrees(repo, git, { isBusy: (p) => p.includes("busy-1") }), []);
    const later = Date.now() + 2 * 24 * 3600_000;
    const gone = await sweepWorktrees(repo, git, { now: later, isBusy: (p) => p.includes("busy-1") });
    // The main checkout also holds main on the remote, but it is not under a worktrees folder, so it is never touched.
    assert.deepEqual(gone.map((g) => g.branch).sort(), ["kesher/pushed-1"]);
    assert.equal(existsSync(pushed.path), false);
    for (const w of [dirty, local, busy]) assert.equal(existsSync(w.path), true, w.path);
    // Orphans: folders git forgot. Old ones go, unless a task still uses them.
    const { mkdir, utimes } = await import("node:fs/promises");
    for (const n of ["orphan-old", "orphan-busy-1"]) {
      await mkdir(join(root, "proj", n, "node_modules"), { recursive: true });
      await utimes(join(root, "proj", n), new Date(0), new Date(0));
    }
    const swept = await sweepWorktrees(repo, git, { now: later, isBusy: (p) => p.includes("busy-1") });
    assert.deepEqual(swept.map((g) => [g.path.split(/[\\/]/).pop(), g.orphan]), [["orphan-old", true]]);
    assert.equal(existsSync(join(root, "proj", "orphan-busy-1")), true);
  } finally {
    setWorktreesRoot(undefined);
  }
});
