import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitPush } from "./git-panel.js";

const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } }).trim();

test("a branch that follows origin/main (as self-work's do) is pushed to its own name, never to main", async () => {
  const remote = await mkdtemp(join(tmpdir(), "kesher-remote-"));
  g(remote, "init", "--bare", "-b", "main");
  const work = await mkdtemp(join(tmpdir(), "kesher-work-"));
  g(work, "init", "-b", "main");
  g(work, "config", "push.default", "upstream");
  await writeFile(join(work, "a.txt"), "one");
  g(work, "add", ".");
  g(work, "commit", "-m", "one");
  g(work, "remote", "add", "origin", remote);
  g(work, "push", "-u", "origin", "main");
  const mainBefore = g(remote, "rev-parse", "main");
  g(work, "checkout", "-b", "kesher-self/1");
  g(work, "branch", "--set-upstream-to", "origin/main");
  await writeFile(join(work, "a.txt"), "two");
  g(work, "commit", "-am", "two");
  const r = await gitPush(work);
  assert.ok(r.ok, r.out);
  assert.equal(g(remote, "rev-parse", "main"), mainBefore, "main is untouched");
  assert.equal(g(remote, "rev-parse", "kesher-self/1"), g(work, "rev-parse", "HEAD"));
  // A branch that follows its own name is pushed the plain way.
  await writeFile(join(work, "a.txt"), "three");
  g(work, "commit", "-am", "three");
  assert.ok((await gitPush(work)).ok);
  assert.equal(g(remote, "rev-parse", "kesher-self/1"), g(work, "rev-parse", "HEAD"));
  assert.equal(g(remote, "rev-parse", "main"), mainBefore);
});

test("a push with the GitHub sign-in's token: the token never lands in the repository's settings or the output", async () => {
  const remote = await mkdtemp(join(tmpdir(), "kesher-remote-"));
  g(remote, "init", "--bare", "-b", "main");
  const work = await mkdtemp(join(tmpdir(), "kesher-work-"));
  g(work, "init", "-b", "main");
  await writeFile(join(work, "a.txt"), "one");
  g(work, "add", ".");
  g(work, "commit", "-m", "one");
  g(work, "remote", "add", "origin", remote);
  const r = await gitPush(work, "gho_secret_for_test");
  assert.ok(r.ok, r.out);
  assert.ok(!r.out.includes("gho_secret_for_test"));
  assert.equal(g(remote, "rev-parse", "main"), g(work, "rev-parse", "HEAD"));
  assert.ok(!(await readFile(join(work, ".git", "config"), "utf8")).includes("gho_"), "nothing written to .git/config");
});
