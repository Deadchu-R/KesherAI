import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agent } from "@agentclientprotocol/sdk";
import { INBOX_GIT_MISSING } from "@kesher/shared";
import { AcpAgent } from "./acp.js";
import { TaskInbox, isQuotaError, quotaUntil, type RunCmd } from "./inbox-runner.js";
import { TaskBoard } from "./task-board.js";

// The tester's own git identity, as a user's global config would have it: the inbox must never commit with it.
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

const TASK = (id: string, paths = "[apps/**]") => `---
id: ${id}
title: Clear all downloads
executor: antigravity
risk: low
allowed_paths: ${paths}
check: git status
max_files: 5
---

## Goal
Add a "Clear all" button.
`;

/** A project with an `origin` (a bare repo) and a task on its inbox branch, as Claude would push it. */
async function setup(tasks: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "kesher-inbox-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  await sh(root, "init", "--quiet", "--bare", "-b", "main", origin);
  await sh(root, "clone", "--quiet", origin, repo);
  await sh(repo, "checkout", "-q", "-b", "main");
  mkdirSync(join(repo, "apps"), { recursive: true });
  writeFileSync(join(repo, "apps", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "AGENTS.md"), "rules\n");
  await sh(repo, "add", "-A");
  await sh(repo, "commit", "-q", "-m", "init");
  await sh(repo, "push", "-q", "origin", "main");
  // Claude's side: another clone writes tasks/ on the inbox branch.
  const claude = join(root, "claude");
  await sh(root, "clone", "--quiet", origin, claude);
  await sh(claude, "checkout", "-q", "--orphan", "kesher-inbox");
  await sh(claude, "rm", "-rfq", ".");
  for (const [id, text] of Object.entries(tasks)) {
    mkdirSync(join(claude, "tasks"), { recursive: true });
    writeFileSync(join(claude, "tasks", `${id}.md`), text);
  }
  await sh(claude, "add", "-A");
  await sh(claude, "commit", "-q", "-m", "tasks");
  await sh(claude, "push", "-q", "origin", "kesher-inbox");
  return { root, origin, repo };
}

/** A fake `agy acp`: asks for a push (denied by the policy), an install (asked), edits a file in its folder. */
function fakeAgy(write: Record<string, string>, seen: { prompts: number; push?: string; install?: string; mode?: string }) {
  let cwd = "";
  return agent()
    .onRequest("initialize", () => ({ protocolVersion: 1, agentInfo: { name: "fake-agy" }, authMethods: [] }))
    .onRequest("session/new", ({ params }) => {
      cwd = params.cwd;
      return { sessionId: "s1", modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "accept-edits", name: "Accept edits" }] }, configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "gemini-flash", options: [{ value: "gemini-flash", name: "Gemini 3.8 Flash" }] }] };
    })
    .onRequest("session/set_mode", ({ params }) => {
      seen.mode = params.modeId;
      return {};
    })
    .onRequest("session/prompt", async ({ params, client }) => {
      seen.prompts++;
      const sessionId = params.sessionId;
      const options = [
        { optionId: "yes", name: "Allow", kind: "allow_once" as const },
        { optionId: "no", name: "Deny", kind: "reject_once" as const },
      ];
      const push = await client.request("session/request_permission", { sessionId, toolCall: { toolCallId: "t1", title: "git push", kind: "execute", rawInput: { command: "git push origin HEAD" } }, options });
      seen.push = push.outcome.outcome === "selected" ? push.outcome.optionId : "cancelled";
      const install = await client.request("session/request_permission", { sessionId, toolCall: { toolCallId: "t2", title: "to filter the list", kind: "execute", rawInput: { command: "pnpm add fuse.js" } }, options });
      seen.install = install.outcome.outcome === "selected" ? install.outcome.optionId : "cancelled";
      const python = await client.request("session/request_permission", { sessionId, toolCall: { toolCallId: "t3", title: "a script", kind: "execute", rawInput: { command: "python gen.py" } }, options });
      void python;
      await client.notify("session/update", { sessionId, update: { sessionUpdate: "plan", entries: [{ content: "Edit the page", priority: "high", status: "completed" }] } });
      for (const [p, text] of Object.entries(write)) {
        mkdirSync(dirname(join(cwd, p)), { recursive: true });
        writeFileSync(join(cwd, p), text);
      }
      await client.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Changed apps/a.ts. Checked with git status." } } });
      return { stopReason: "end_turn" };
    });
}

async function inboxFor(repo: string, root: string, write: Record<string, string>, seen: { prompts: number; push?: string; install?: string; mode?: string }, now = () => Date.now()) {
  const notes: string[] = [];
  const board = new TaskBoard(join(root, "board.json"));
  const settings = { enabled: true, repo, branch: "kesher-inbox", dailyCap: 2, askSteps: true };
  const inbox = new TaskInbox({
    settings: () => settings,
    file: join(root, "inbox.json"),
    git,
    run: git.length ? async (cwd, args) => (args[0] === "git" ? git(cwd, args.slice(1)) : { code: 1, out: "not in tests" }) : git,
    startAgent: (_cwd, h) => AcpAgent.connect(fakeAgy(write, seen), h),
    board,
    notify: (t, b) => void notes.push(`${t} ${b}`),
    // A game is running: Antigravity runs in the cloud, so Run still goes ahead.
    busy: async () => ({ free: false, reasons: ["game: Elden Ring"] }),
    me: { username: "someone", home: join(root, "home", "someone") },
    now,
    approvalMs: 300,
  });
  return { inbox, notes, board, settings };
}

const settle = async (inbox: TaskInbox, id: string) => {
  await inbox.idle();
  return inbox.task(id);
};

test("inbox run: Run on the PC, the policy, KesherAI's checks, one agy branch and the result pushed", async () => {
  const { root, origin, repo } = await setup({ "c-20261119-02": TASK("c-20261119-02") });
  const seen = { prompts: 0 } as { prompts: number; push?: string; install?: string; mode?: string };
  const { inbox, notes, board } = await inboxFor(repo, root, { "apps/a.ts": "export const a = 2;\n" }, seen);
  try {
    await inbox.sync();
    let t = await inbox.task("c-20261119-02");
    assert.equal(t.status, "waiting");
    assert.equal(t.runBy, "antigravity");
    assert.ok(t.runAsk, "the PC asks right away");
    assert.ok(notes.some((n) => /Run this task in Antigravity\?/.test(n)), "and the phone is told");
    assert.ok((await board.read()).tasks.some((x) => x.id === t.boardId && /\[Inbox c-20261119-02\]/.test(x.title)), "on the shared board");

    t = await inbox.run("c-20261119-02", { here: true });
    assert.equal(t.status, "running");
    await assert.rejects(inbox.run("c-20261119-02", { here: true }), /One at a time|cannot be run/);
    // The install is asked; nobody answers within the (test) 300 ms, so it is denied.
    t = await settle(inbox, "c-20261119-02");
    assert.equal(seen.prompts, 1, "one prompt per Run");
    assert.equal(seen.mode, "accept-edits");
    assert.equal(seen.push, "no", "git push is denied by the policy");
    assert.equal(seen.install, "no", "an unanswered ask is denied");
    assert.equal(t.status, "done", t.note);
    assert.equal(t.branch, "agy/c-20261119-02-clear-all-downloads");
    assert.equal(t.pushed, true);
    assert.equal(t.modelUsed, "Gemini 3.8 Flash");
    assert.deepEqual(t.files, [{ path: "apps/a.ts", added: 1, removed: 1 }]);
    assert.ok(t.checks?.every((c) => c.ok));
    assert.ok(t.decisions?.some((d) => d.verdict === "deny" && /only KesherAI/.test(d.rule)));
    assert.ok(t.decisions?.some((d) => d.verdict === "ask" && d.answer === "timeout"));
    // On origin: the work branch (by KesherAI's own identity) and the result file; main untouched.
    const remote = await sh(origin, "branch", "--list");
    assert.match(remote, /agy\/c-20261119-02-clear-all-downloads/);
    assert.equal(await sh(origin, "log", "-1", "--format=%an <%ae>", "agy/c-20261119-02-clear-all-downloads"), "KesherAI <kesherai@noreply.invalid>");
    assert.equal(await sh(origin, "rev-list", "--count", "main"), "1", "main is never pushed");
    const result = await sh(origin, "show", "kesher-inbox:results/c-20261119-02.md");
    assert.match(result, /status: done/);
    assert.match(result, /branch: agy\/c-20261119-02-clear-all-downloads/);
    const item = (await board.read()).tasks.find((x) => x.id === t.boardId);
    assert.equal(item?.status, "done");
    assert.equal((await inbox.state(true)).today.used, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox run: from the phone, Run is the answer to the PC's ask — one answer, one task; expired asks start nothing", async () => {
  const { root, repo } = await setup({ "c-20261119-03": TASK("c-20261119-03") });
  const seen = { prompts: 0 };
  let clock = Date.now();
  const { inbox } = await inboxFor(repo, root, { "apps/a.ts": "export const a = 3;\n" }, seen, () => clock);
  try {
    await inbox.sync();
    await assert.rejects(inbox.run("c-20261119-03", { here: false }), (e: { code?: number }) => e.code === 403);
    const ask = (await inbox.task("c-20261119-03")).runAsk!;
    assert.equal(await inbox.answerRun("not-the-id", "allow", "phone-1"), undefined);
    assert.equal(await inbox.answerRun(ask.requestId, "allow", ""), undefined, "no verified sender, nothing starts");
    // "Not now" uses the ask up.
    assert.equal((await inbox.answerRun(ask.requestId, "deny", "phone-1"))?.status, "waiting");
    assert.equal(await inbox.answerRun(ask.requestId, "allow", "phone-1"), undefined, "a used ask cannot start it");
    // A new ask expires after its 30 (here 0.3 s of clock) minutes.
    const again = (await inbox.askRun("c-20261119-03")).runAsk!;
    clock += 1000;
    assert.equal(await inbox.answerRun(again.requestId, "allow", "phone-1"), undefined);
    // A fresh one answered in time runs the task once.
    const fresh = (await inbox.askRun("c-20261119-03")).runAsk!;
    assert.equal(inbox.openAsks().length, 1);
    const t = await inbox.answerRun(fresh.requestId, "allow", "phone-1");
    assert.equal(t?.status, "running");
    assert.equal(await inbox.answerRun(fresh.requestId, "allow", "phone-1"), undefined, "a yes is never remembered");
    await settle(inbox, "c-20261119-03");
    assert.equal(seen.prompts, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox run: work outside the allowed paths or with a secret is never committed or pushed", async () => {
  const { root, origin, repo } = await setup({ "c-20261119-04": TASK("c-20261119-04") });
  const seen = { prompts: 0 };
  const { inbox } = await inboxFor(repo, root, { "apps/a.ts": "export const a = 4;\n", ".github/workflows/x.yml": "on: push\n", "apps/k.ts": `export const k = "sk-ant-${"x".repeat(30)}";\n` }, seen);
  try {
    await inbox.sync();
    await inbox.run("c-20261119-04", { here: true });
    const t = await settle(inbox, "c-20261119-04");
    assert.equal(t.status, "failed");
    assert.equal(t.pushed, false);
    assert.match(t.note ?? "", /Not committed or pushed/);
    assert.ok(t.checks?.some((c) => c.name === "paths" && !c.ok));
    assert.ok(t.checks?.some((c) => c.name === "secrets and privacy" && !c.ok && !c.note.includes("sk-ant")));
    assert.doesNotMatch(await sh(origin, "branch", "--list"), /agy\//);
    assert.equal((await inbox.state(true)).lastError, undefined);
    assert.match(await sh(origin, "show", "kesher-inbox:results/c-20261119-04.md"), /status: failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox: a declined task file, the daily cap, and the quota", async () => {
  const { root, repo } = await setup({ "c-20261119-05": "not a task", "c-20261119-06": TASK("c-20261119-06") });
  const { inbox, settings } = await inboxFor(repo, root, {}, { prompts: 0 });
  try {
    await inbox.sync();
    assert.equal((await inbox.task("c-20261119-05")).status, "declined");
    // A task from the hub for Antigravity is prepared and waits for the user's Run, like any other.
    await inbox.fromHub({ taskId: "T-77", title: "From the phone", spec: "Fix the gap" }, "t9");
    const hub = await inbox.task("h-t-77");
    assert.deepEqual([hub.status, hub.runBy, hub.from, hub.boardId, !!hub.runAsk], ["waiting", "antigravity", "hub", "t9", true]);
    // A task another device wrote to Google Drive (tasks-sync.ts): queued once, "claude" runs as Opus.
    assert.equal(await inbox.fromDrive({ id: "g-0123456789abcdef", title: "From Drive", goal: "Add a test", executor: "claude" }), true);
    assert.equal(await inbox.fromDrive({ id: "g-0123456789abcdef", title: "Again", goal: "x", executor: "local" }), false);
    assert.equal(await inbox.fromDrive({ id: "Bad id", title: "x", goal: "x", executor: "local" }), false);
    const drive = await inbox.task("g-0123456789abcdef");
    assert.deepEqual([drive.runBy, drive.from, drive.title], ["opus", "device", "From Drive"]);
    // Security scan 167: a Drive task is never taken by a runner by itself; local and auto go to Antigravity's Run ask.
    for (const [id, executor] of [["g-1111111111aaaaaa", "local"], ["g-2222222222bbbbbb", "auto"]] as const) {
      assert.equal(await inbox.fromDrive({ id, title: "Device task", goal: "Do it", executor }), true);
      const d = await inbox.task(id);
      assert.deepEqual([d.runBy, d.from, d.status, !!d.runAsk], ["antigravity", "device", "waiting", true]);
    }
    settings.dailyCap = 0;
    await assert.rejects(inbox.run("c-20261119-06", { here: true }), /limit of 0/);
    assert.ok(isQuotaError("RESOURCE_EXHAUSTED: quota exceeded, retry in 1h35m"));
    assert.equal(quotaUntil("quota exceeded, retry in 1h35m", 0).until, 95 * 60_000);
    assert.equal(quotaUntil("quota", 0).estimated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox: Who does it — a task goes back in the queue for the new executor, or moves out to a chat", async () => {
  const { root, repo } = await setup({ "c-20261120-01": TASK("c-20261120-01") });
  const { inbox } = await inboxFor(repo, root, {}, { prompts: 0 });
  try {
    await inbox.fromHub({ taskId: "T-88", title: "From the phone", spec: "Fix the gap" }, "t9");
    let t = await inbox.reassign("h-t-88", "local");
    assert.deepEqual([t.runBy, t.status, !!t.runAsk], ["local", "queued", false]);
    t = await inbox.reassign("h-t-88", "antigravity");
    assert.deepEqual([t.runBy, t.status, !!t.runAsk], ["antigravity", "waiting", true], "Antigravity asks for Run again");
    t = await inbox.movedOut("h-t-88", "to a build agent in the chat \"Fix\"");
    assert.equal(t.status, "skipped");
    assert.match(t.note ?? "", /^Moved: to a build agent/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox: a chat agent's message ask — one answer, one message, counted against the same daily limit", async () => {
  const root = mkdtempSync(join(tmpdir(), "kesher-inbox-"));
  let clock = Date.now();
  const notes: string[] = [];
  const settings = { dailyCap: 2 };
  const inbox = new TaskInbox({ settings: () => settings, file: join(root, "inbox.json"), git, run: git, startAgent: () => Promise.reject(new Error("no")), notify: (t) => void notes.push(t), busy: async () => ({ free: true, reasons: [] }), now: () => clock, approvalMs: 1000 });
  try {
    const a = inbox.askMessage({ title: "@antigravity: fix", text: "fix the gap", where: "KesherAI" });
    assert.equal(a.ask.left, 2);
    assert.ok(notes.some((n) => /Run this in Antigravity\?/.test(n)), "the phone is told");
    assert.equal(inbox.openAsks().length, 1, "and the hub sends it");
    assert.equal(await inbox.answerMessage(a.ask.requestId, "allow", ""), false, "no verified sender");
    assert.equal(await inbox.answerMessage(a.ask.requestId, "allow", "phone-1"), true);
    assert.equal(await a.answer, "allow");
    assert.equal(await inbox.answerMessage(a.ask.requestId, "allow", "phone-1"), false, "used up");
    assert.equal((await inbox.state(true)).today.used, 1);
    const b = inbox.askMessage({ title: "t", text: "x", where: "p" });
    assert.equal(await inbox.answerMessage(b.ask.requestId, "deny", "pc"), true);
    assert.equal(await b.answer, "deny");
    assert.equal((await inbox.state(true)).today.used, 1, "Not now costs nothing");
    const c = inbox.askMessage({ title: "t", text: "x", where: "p" });
    clock += 2000;
    assert.equal(await inbox.answerMessage(c.ask.requestId, "allow", "pc"), false, "expired");
    assert.equal(await c.answer, "timeout");
    const d = inbox.askMessage({ title: "t", text: "x", where: "p" });
    await inbox.answerMessage(d.ask.requestId, "allow", "pc");
    assert.throws(() => inbox.askMessage({ title: "t", text: "x", where: "p" }), /limit of 2/);
    assert.equal(inbox.openAsks().length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox: Claude's work list is read from origin/main through git, and missing is undefined", async () => {
  const { root, repo } = await setup({ "c-20261120-09": TASK("c-20261120-09") });
  const { inbox } = await inboxFor(repo, root, {}, { prompts: 0 });
  try {
    assert.equal(await inbox.workList(), undefined, "no docs/WORK_LIST.md on main yet");
    // Claude pushes the list to main from another clone; the PC's checkout never changes.
    const claude = join(root, "claude-main");
    await sh(root, "clone", "--quiet", "-b", "main", join(root, "origin.git"), claude);
    mkdirSync(join(claude, "docs"), { recursive: true });
    writeFileSync(join(claude, "docs", "WORK_LIST.md"), "## Now\n- ⬜ Next thing.\n");
    await sh(claude, "add", "-A");
    await sh(claude, "commit", "-q", "-m", "work list");
    await sh(claude, "push", "-q", "origin", "main");
    assert.equal(await inbox.workList(), "## Now\n- ⬜ Next thing.\n");
    assert.equal(existsSync(join(repo, "docs", "WORK_LIST.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox: git missing (Windows without Git) shows as such, not as \"no inbox branch yet\"", async () => {
  const root = mkdtempSync(join(tmpdir(), "kesher-inbox-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  // What the runner answers when git cannot be started (server/build-inbox.ts, inbox-spawn.ts startErrorText).
  const noGit: RunCmd = async () => ({ code: -1, out: INBOX_GIT_MISSING });
  const inbox = new TaskInbox({ settings: () => ({ enabled: true, repo, branch: "kesher-inbox" }), file: join(root, "inbox.json"), git: noGit, run: noGit, startAgent: () => Promise.reject(new Error("no")), notify: () => undefined, busy: async () => ({ free: true, reasons: [] }) });
  try {
    await inbox.sync();
    const s = await inbox.state(true);
    assert.equal(s.lastError, INBOX_GIT_MISSING);
    assert.deepEqual(s.tasks, []);
    assert.equal(await inbox.workList(), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox: credit, upgrade and billing offers count as a quota stop (never paid)", () => {
  for (const m of ["You have run out of AI credits", "Buy more credits to continue", "Please upgrade your plan", "Billing is required", "429 RESOURCE_EXHAUSTED"]) assert.ok(isQuotaError(m), m);
  assert.ok(!isQuotaError("The agent crashed: ENOENT"));
});

const RESEARCH_TASK = (id: string) => `---
id: ${id}
title: How do others sync notes
kind: research
risk: low
---

## Goal
How do Obsidian and Notion sync notes?
`;

test("inbox: free-Gemini research runs by itself, one at a time, and waits with a note while no Gemini connection exists", async () => {
  const { root, repo } = await setup({ "r-20261121-01": RESEARCH_TASK("r-20261121-01") });
  const notes: string[] = [];
  let ready = false;
  const asked: string[] = [];
  const inbox = new TaskInbox({
    settings: () => ({ enabled: true, repo, branch: "kesher-inbox" }),
    file: join(root, "inbox.json"),
    git,
    run: async () => ({ code: 1, out: "not in tests" }),
    startAgent: () => Promise.reject(new Error("Antigravity must not start for a Gemini task")),
    notify: (t, b) => void notes.push(`${t} ${b}`),
    busy: async () => ({ free: true, reasons: [] }),
    research: { ready: () => ready, run: async (q) => (asked.push(q), "# Sync\n\nText [1]\n\n## Sources\n\n1. [A](https://a.example/x)") },
  });
  try {
    await inbox.sync();
    await inbox.idle();
    let t = await inbox.task("r-20261121-01");
    assert.deepEqual([t.runBy, t.kind, t.status, t.allowedPaths], ["gemini", "research", "waiting", ["docs/research/r-20261121-01.md"]]);
    assert.match(t.note ?? "", /Waiting for a Gemini connection/);
    assert.equal(asked.length, 0);
    await assert.rejects(inbox.run("r-20261121-01", { here: true }), /runs by itself/);
    ready = true;
    await inbox.pumpGemini();
    t = await inbox.task("r-20261121-01");
    assert.deepEqual([t.status, t.note, t.researchReport?.startsWith("# Sync")], ["done", undefined, true]);
    assert.match(asked[0]!, /How do others sync notes\n\nHow do Obsidian/);
    assert.match(await sh(repo, "show", "origin/kesher-inbox:results/r-20261121-01.md").catch(async () => (await sh(repo, "fetch", "-q", "origin", "kesher-inbox"), sh(repo, "show", "FETCH_HEAD:results/r-20261121-01.md"))), /status: done[\s\S]*## Research report\n# Sync/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox: a Gemini limit or billing error defers the task to the reset; one automatic retry, never a loop", async () => {
  const { root, repo } = await setup({ "r-20261121-02": RESEARCH_TASK("r-20261121-02") });
  let now = 1_000_000;
  let calls = 0;
  let fail: string | undefined = "429 RESOURCE_EXHAUSTED: quota exceeded, retry in 30m";
  const inbox = new TaskInbox({
    settings: () => ({ enabled: true, repo, branch: "kesher-inbox" }),
    file: join(root, "inbox.json"),
    git,
    run: async () => ({ code: 1, out: "not in tests" }),
    startAgent: () => Promise.reject(new Error("no")),
    notify: () => undefined,
    busy: async () => ({ free: true, reasons: [] }),
    now: () => now,
    research: { ready: () => true, run: async () => (calls++, fail ? Promise.reject(new Error(fail)) : "# R\n\nok") },
  });
  try {
    await inbox.sync();
    await inbox.idle();
    let t = await inbox.task("r-20261121-02");
    assert.deepEqual([t.status, calls, t.retryAt], ["deferred-quota", 1, 1_000_000 + 30 * 60_000]);
    // Before the reset nothing runs, however often it is pumped.
    for (let i = 0; i < 3; i++) await inbox.pumpGemini();
    assert.equal(calls, 1);
    // After the reset: the one automatic retry; a second limit error ends it deferred, with no further retry.
    now += 31 * 60_000;
    fail = "Please upgrade your plan or buy credits";
    await inbox.pumpGemini();
    t = await inbox.task("r-20261121-02");
    assert.deepEqual([t.status, calls, t.autoRetried, t.retryAt], ["deferred-quota", 2, true, undefined]);
    now += 3 * 60 * 60_000;
    await inbox.pumpGemini();
    assert.equal(calls, 2, "no loop: a second stop waits for the user");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
