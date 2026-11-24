import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeQuota } from "@kesher/shared";
import { inboxSnapshot } from "./agent-activity.js";
import { TaskInbox, type RunCmd, type TaskInboxDeps } from "./inbox-runner.js";
import type { ClaudeRunEnd } from "./claude-exec.js";

/**
 * The `claude` executor (Claude Code on the PC with the user's own subscription): a task waits for the Run tap, runs
 * in its own worktree on a `claude/*` branch with every step counted, is checked and pushed like the others; the quota
 * thresholds, the daily cap, the login check and a usage-limit message hold it back. A local bare repo and a fake
 * Claude Code stand in for GitHub and the CLI.
 */

const gitConfig = join(mkdtempSync(join(tmpdir(), "kesher-gitcfg-")), "gitconfig");
writeFileSync(gitConfig, "[user]\n\tname = Someone Real\n\temail = someone.real@example.com\n[init]\n\tdefaultBranch = main\n");
const git: RunCmd = async (cwd, args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" } });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const sh = async (cwd: string, ...args: string[]) => {
  const r = await git(cwd, args);
  assert.equal(r.code, 0, `git ${args.join(" ")}: ${r.out}`);
  return r.out.trim();
};

const TASK = (id: string) => `---
id: ${id}
title: Add a clear button ${id}
executor: claude
risk: medium
allowed_paths: [apps/**]
check: git status
max_files: 5
---

## Goal
Add a "Clear all" button.

## Acceptance
The button empties the list.
`;

/** A project with an origin and these tasks on its inbox branch. */
async function setup(ids: string[]) {
  const root = mkdtempSync(join(tmpdir(), "kesher-claude-inbox-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  await sh(root, "init", "--quiet", "--bare", "-b", "main", origin);
  await sh(root, "clone", "--quiet", origin, repo);
  await sh(repo, "checkout", "-q", "-b", "main");
  mkdirSync(join(repo, "apps"), { recursive: true });
  writeFileSync(join(repo, "apps", "a.ts"), "export const a = 1;\n");
  await sh(repo, "add", "-A");
  await sh(repo, "commit", "-q", "-m", "init");
  await sh(repo, "push", "-q", "origin", "main");
  const lead = join(root, "lead");
  await sh(root, "clone", "--quiet", origin, lead);
  await sh(lead, "checkout", "-q", "--orphan", "kesher-inbox");
  await sh(lead, "rm", "-rfq", ".");
  mkdirSync(join(lead, "tasks"), { recursive: true });
  writeFileSync(join(lead, "tasks", "README.md"), "inbox\n");
  for (const id of ids) writeFileSync(join(lead, "tasks", `${id}.md`), TASK(id));
  await sh(lead, "add", "-A");
  await sh(lead, "commit", "-q", "-m", "tasks");
  await sh(lead, "push", "-q", "origin", "kesher-inbox");
  return { root, repo };
}

/** A fake Claude Code: edits a file and reports two steps, or ends the way `end` says. */
function fakeClaude(o: { account?: "subscription" | "api-key" | "none"; quota?: ClaudeQuota; end?: () => Partial<ClaudeRunEnd> } = {}) {
  const runs: Array<{ model: string; commands: readonly string[] }> = [];
  const claude: NonNullable<TaskInboxDeps["claude"]> = {
    check: async () => ({ installed: true, version: "2.1.331", loggedIn: o.account !== "none", account: o.account ?? "subscription", plan: "max" }),
    quota: async () => o.quota,
    run: async ({ worktree, model, commands, onEvent }) => {
      runs.push({ model, commands });
      onEvent({ kind: "init", model: "claude-sonnet-4-5" });
      onEvent({ kind: "step", step: { tool: "Read", args: { file_path: "apps/a.ts" } } });
      const end = o.end?.();
      if (end) return { code: 1, stderr: "", ...end };
      onEvent({ kind: "step", step: { tool: "Edit", args: { file_path: "apps/a.ts" } } });
      writeFileSync(join(worktree, "apps", "a.ts"), `export const a = ${runs.length + 1};\n`);
      return { code: 0, result: { ok: true, text: "Changed apps/a.ts." }, stderr: "" };
    },
  };
  return { claude, runs };
}

function inboxFor(repo: string, root: string, claude: TaskInboxDeps["claude"], settings: Record<string, unknown> = {}, now = () => Date.now()) {
  const notes: string[] = [];
  const inbox = new TaskInbox({
    settings: () => ({ enabled: true, repo, branch: "kesher-inbox", dailyCap: 10, ...settings }),
    file: join(root, "inbox.json"),
    git,
    run: async (cwd, args) => (args[0] === "git" ? git(cwd, args.slice(1)) : { code: 1, out: "not in tests" }),
    startAgent: () => Promise.reject(new Error("Antigravity must not start for a Claude Code task")),
    notify: (t, b) => void notes.push(`${t} ${b}`),
    busy: async () => ({ free: true, reasons: [] }),
    ...(claude ? { claude } : {}),
    now,
  });
  return { inbox, notes };
}

test("claude: a task waits for Run, then runs on a claude/* branch with its steps, checked, pushed and shown", async () => {
  const id = "c-20261124-01";
  const { root, repo } = await setup([id]);
  const { claude, runs } = fakeClaude();
  const { inbox, notes } = inboxFor(repo, root, claude, { commands: ["git status"], claude: { model: "sonnet" } });
  try {
    await inbox.sync();
    await inbox.pumpClaude();
    let t = await inbox.task(id);
    assert.deepEqual([t.runBy, t.status, runs.length], ["claude", "waiting", 0], "nothing runs before the tap");
    assert.match(t.branch, /^claude\/c-20261124-01-/);
    assert.ok(t.runAsk, "the PC asks");
    assert.ok(notes.some((n) => n.startsWith("✳ Run this task in Claude Code?") && n.includes("uses your Claude limits")), notes.join("\n"));
    // From the phone, Run answers the ask; a bare remote press is refused.
    await assert.rejects(inbox.run(id, { here: false }), /answers the PC's ask/);
    await inbox.answerRun(t.runAsk!.requestId, "allow", "phone-1");
    await inbox.idle();
    t = await inbox.task(id);
    assert.deepEqual([t.status, t.pushed, t.steps, t.modelUsed], ["done", true, 2, "Claude Code · claude-sonnet-4-5"]);
    assert.deepEqual(runs, [{ model: "sonnet", commands: ["git status"] }]);
    assert.match(await sh(repo, "ls-remote", "origin", t.branch), /refs\/heads\/claude\//);
    await sh(repo, "fetch", "-q", "origin", t.branch);
    assert.match(await sh(repo, "log", "-1", "--format=%B", "FETCH_HEAD"), /run by Claude Code/);
    assert.ok(notes.some((n) => n.startsWith("✳ Claude Code התחיל משימה")), notes.join("\n"));
    assert.deepEqual([inboxSnapshot(t, undefined, "asks")?.source, inboxSnapshot(t, undefined, "asks")?.state], ["inbox", "done"]);
    const st = await inbox.state(true);
    assert.deepEqual([st.claude?.installed, st.claude?.version, st.claude?.account, st.claude?.used, st.claude?.blocked], [true, "2.1.331", "subscription", 1, undefined]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("claude: above the 5-hour or weekly threshold nothing starts until the reset; an unknown quota does not hold it", async () => {
  const id = "c-20261124-02";
  const { root, repo } = await setup([id]);
  const now = Date.now();
  const f = fakeClaude({ quota: { fiveHour: { usedPercentage: 81, resetsAt: now + 3_600_000 }, at: now } });
  const { inbox } = inboxFor(repo, root, f.claude);
  try {
    await inbox.sync();
    await assert.rejects(inbox.run(id, { here: true }), /5-hour usage is at 81% \(KesherAI stops at 80%\)/);
    const st = await inbox.state(true);
    assert.equal(st.claude?.blocked?.until, now + 3_600_000);
    assert.equal(f.runs.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const { root: r2, repo: repo2 } = await setup([id]);
  const g = fakeClaude();
  const { inbox: i2 } = inboxFor(repo2, r2, g.claude);
  try {
    await i2.sync();
    await i2.run(id, { here: true });
    await i2.idle();
    assert.equal((await i2.task(id)).status, "done");
    assert.equal((await i2.state(true)).claude?.quota, undefined, "shown as unknown");
  } finally {
    rmSync(r2, { recursive: true, force: true });
  }
});

test("claude: a usage-limit message defers the task until the reset, and Run waits for it", async () => {
  const ids = ["c-20261124-03", "c-20261124-04"];
  const { root, repo } = await setup(ids);
  const until = Date.now() + 2 * 3_600_000;
  const f = fakeClaude({ end: () => ({ result: { ok: false, text: "Claude AI usage limit reached" }, limit: { until } }) });
  const { inbox } = inboxFor(repo, root, f.claude);
  try {
    await inbox.sync();
    await inbox.run(ids[0]!, { here: true });
    await inbox.idle();
    const t = await inbox.task(ids[0]!);
    assert.equal(t.status, "deferred-quota");
    assert.match(t.note ?? "", /usage limit was reached; it can run again at/);
    await assert.rejects(inbox.run(ids[1]!, { here: true }), /usage limit was reached/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("claude: an API-key login, a missing login and today's cap are refused before anything starts", async () => {
  const id = "c-20261124-05";
  for (const [account, re] of [["api-key", /only with your Claude subscription/], ["none", /not signed in/]] as const) {
    const { root, repo } = await setup([id]);
    const f = fakeClaude({ account });
    const { inbox } = inboxFor(repo, root, f.claude);
    try {
      await inbox.sync();
      await assert.rejects(inbox.run(id, { here: true }), re);
      assert.equal(f.runs.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const ids = ["c-20261124-06", "c-20261124-07"];
  const { root, repo } = await setup(ids);
  const f = fakeClaude();
  const { inbox } = inboxFor(repo, root, f.claude, { claude: { dailyCap: 1 } });
  try {
    await inbox.sync();
    await inbox.run(ids[0]!, { here: true });
    await inbox.idle();
    await assert.rejects(inbox.run(ids[1]!, { here: true }), /Today's limit of 1 Claude Code tasks/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("claude: with Run tap per task off, its tasks run by themselves, one at a time", async () => {
  const ids = ["c-20261124-08", "c-20261124-09"];
  const { root, repo } = await setup(ids);
  const f = fakeClaude();
  const { inbox } = inboxFor(repo, root, f.claude, { claude: { askRun: false } });
  try {
    await inbox.sync();
    await inbox.pumpClaude();
    for (let i = 0; i < 100 && f.runs.length < 2; i++) {
      await inbox.idle();
      await new Promise((r) => setTimeout(r, 20));
    }
    await inbox.idle();
    assert.deepEqual(await Promise.all(ids.map(async (x) => (await inbox.task(x)).status)), ["done", "done"]);
    assert.equal((await inbox.task(ids[0]!)).runAsk, undefined, "no ask when it runs by itself");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
