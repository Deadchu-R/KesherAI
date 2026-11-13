import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIn } from "./run-in.js";
import { createSessionWorktree, includedFiles, removeSessionWorktree, worktreeName, worktreeWork, type Git } from "./session-worktrees.js";

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
