import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanMessage, commitPrompt, gitBranches, gitCommit, gitDiff, githubRepo, gitState, gitSwitch, parseStatus, recentMessages, validBranch } from "./git-panel.js";

test("status header and files are read", () => {
  const s = parseStatus("## main...origin/main [ahead 2, behind 1]\n M a.ts\n?? new file.md\nR  old.ts -> new.ts\n D gone.ts\n");
  assert.equal(s.branch, "main");
  assert.equal(s.upstream, "origin/main");
  assert.deepEqual([s.ahead, s.behind], [2, 1]);
  assert.deepEqual(s.files.map((f) => [f.state, f.path]), [["M", "a.ts"], ["?", "new file.md"], ["R", "new.ts"], ["D", "gone.ts"]]);
  assert.equal(s.files[2]!.from, "old.ts");
  assert.equal(parseStatus("## No commits yet on main\n").branch, "main");
  assert.equal(parseStatus("## feature/x.y\n").branch, "feature/x.y");
});

test("GitHub remotes and branch names", () => {
  assert.equal(githubRepo("https://github.com/someone/KesherAI.git"), "someone/KesherAI");
  assert.equal(githubRepo("git@github.com:a/b.c.git"), "a/b.c");
  assert.equal(githubRepo("https://gitlab.com/a/b"), undefined);
  assert.ok(validBranch("feature/git-panel"));
  assert.ok(!validBranch("-x"));
  assert.ok(!validBranch("a..b"));
});

test("a model's commit message is cleaned and the prompt carries the repo's style", () => {
  assert.equal(cleanMessage("```\nfix: a\n\nbody\n```"), "fix: a\n\nbody");
  assert.equal(cleanMessage('"fix: a"'), "fix: a");
  const p = commitPrompt("x".repeat(50), ["feat: one\n\nDesktop-he: א\n\nCo-Authored-By: X"]);
  assert.match(p, /Desktop-he/);
  assert.match(p, /word for word/);
});

test("state, diff, commit and branches on a real repository", async () => {
  const repo = await mkdtemp(join(tmpdir(), "kesher-git-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: repo });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  await writeFile(join(repo, "a.txt"), "one\ntwo\n");
  g("add", "-A");
  g("commit", "-qm", "first");
  await writeFile(join(repo, "a.txt"), "one\nTWO\nthree\n");
  await writeFile(join(repo, "b.txt"), "new\n");
  const st = await gitState(repo);
  assert.equal(st.repo, true);
  assert.equal(st.branch, "main");
  assert.deepEqual(st.files.map((f) => [f.path, f.state, f.added, f.removed]), [["a.txt", "M", 2, 1], ["b.txt", "?", 1, 0]]);
  assert.match((await gitDiff(repo, "a.txt")).diff, /\+TWO/);
  assert.match((await gitDiff(repo, "b.txt", true)).diff, /\+new/);
  const c = await gitCommit(repo, "second\n\nbody");
  assert.ok(c.ok, c.out);
  assert.ok(c.sha);
  assert.equal((await gitState(repo)).files.length, 0);
  assert.equal((await recentMessages(repo))[0], "second\n\nbody");
  assert.ok((await gitSwitch(repo, "feature/x", true)).ok);
  const b = await gitBranches(repo);
  assert.equal(b.current, "feature/x");
  assert.deepEqual([...b.local].sort(), ["feature/x", "main"]);
  assert.equal((await gitState(await mkdtemp(join(tmpdir(), "kesher-nogit-")))).repo, false);
});
