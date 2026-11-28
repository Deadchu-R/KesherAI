import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agent } from "@agentclientprotocol/sdk";
import { INBOX_GIT_MISSING, type InboxTaskView } from "@kesher/shared";
import { AcpAgent } from "./acp.js";
import { modelAgent } from "./acp-models.test.js";
import { TaskInbox, isQuotaError, rememberFail, nextInLineTitle, quotaUntil, requeueSearchFailures, searchRetryDue, SEARCH_RETRY_MS, type RunCmd } from "./inbox-runner.js";
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

/** The heavy job the test pretends runs (heavy-gate.ts), if any. */
let heavyNow: string | undefined;

async function inboxFor(repo: string, root: string, write: Record<string, string>, seen: { prompts: number; push?: string; install?: string; mode?: string }, now = () => Date.now(), approvalMs = 300) {
  const notes: string[] = [];
  const noteOpts: Array<{ path?: string; actions?: Array<{ label: string; path: string }> } | undefined> = [];
  const board = new TaskBoard(join(root, "board.json"));
  const settings: Record<string, unknown> = { enabled: true, repo, branch: "kesher-inbox", dailyCap: 2, askSteps: true };
  const inbox = new TaskInbox({
    settings: () => settings,
    file: join(root, "inbox.json"),
    git,
    run: git.length ? async (cwd, args) => (args[0] === "git" ? git(cwd, args.slice(1)) : { code: 1, out: "not in tests" }) : git,
    startAgent: (_cwd, h) => AcpAgent.connect(fakeAgy(write, seen), h),
    board,
    notify: (t, b, o) => void (notes.push(`${t} ${b}`), noteOpts.push(o)),
    // A game is running: Antigravity runs in the cloud, so Run still goes ahead.
    busy: async () => ({ free: false, reasons: ["game: Elden Ring"] }),
    me: { username: "someone", home: join(root, "home", "someone") },
    now,
    heavy: () => heavyNow,
    approvalMs,
  });
  return { inbox, notes, noteOpts, board, settings };
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
    assert.equal((await inbox.run("c-20261119-02", { here: true })).status, "running", "a second Run on the running task starts nothing");
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

test("inbox run: Run from the hub drops the PC's own ask at once and the phone's later Run tap starts nothing", async () => {
  const { root, repo } = await setup({ "c-20261121-01": TASK("c-20261121-01") });
  const seen = { prompts: 0 };
  const { inbox } = await inboxFor(repo, root, { "apps/a.ts": "export const a = 4;\n" }, seen);
  try {
    await inbox.sync();
    const ask = (await inbox.task("c-20261121-01")).runAsk!;
    assert.ok(ask, "the PC asked 'Run this?' for the waiting task");
    // Every change is reported at once: the first one after Run already says running, with no ask left.
    const seenStates: string[] = [];
    inbox.onChange(() => void inbox.list().then((l) => seenStates.push(`${l[0]?.status}/${l[0]?.runAsk ? "ask" : "noask"}`)));
    await inbox.run("c-20261121-01", { approvedBy: "hub:dphone" });
    await inbox.idle();
    assert.equal(seenStates[0], "running/noask");
    assert.equal(inbox.openAsks().length, 0, "no ask is left for the phone to show");
    // The push's Run button on the old ask: quiet no-op, and a second Run on the task changes nothing.
    assert.equal(await inbox.answerRun(ask.requestId, "allow", "phone-1"), undefined);
    await settle(inbox, "c-20261121-01");
    assert.equal(seen.prompts, 1, "one Run is one run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox run: a second Run on a task that is already starting is a quiet no-op", async () => {
  const { root, repo } = await setup({ "c-20261121-02": TASK("c-20261121-02") });
  const seen = { prompts: 0 };
  const { inbox } = await inboxFor(repo, root, { "apps/a.ts": "export const a = 5;\n" }, seen);
  try {
    await inbox.sync();
    const first = inbox.run("c-20261121-02", { approvedBy: "hub:dphone" });
    const second = inbox.run("c-20261121-02", { approvedBy: "phone-1" });
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, "running");
    assert.equal(b.status, "running");
    await settle(inbox, "c-20261121-02");
    assert.equal(seen.prompts, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Three Antigravity tasks: A runs, B and C are pressed Run while A runs (they queue). */
async function queuedThree(ask = true, now?: () => number, approvalMs?: number) {
  const ids = ["c-20261122-01", "c-20261122-02", "c-20261122-03"];
  const { root, repo } = await setup(Object.fromEntries(ids.map((id) => [id, TASK(id)])));
  const seen = { prompts: 0 };
  const h = await inboxFor(repo, root, { "apps/a.ts": "export const a = 5;\n" }, seen, now, approvalMs);
  h.settings.dailyCap = 9;
  h.settings.askBeforeNext = { antigravity: ask, local: false };
  await h.inbox.sync();
  await h.inbox.run(ids[0]!, { here: true });
  await h.inbox.queueAdd(ids[1]!, "pc");
  await h.inbox.queueAdd(ids[2]!, "pc");
  await h.inbox.idle();
  return { ...h, ids, root, seen };
}

test("inbox queue: after a finish it stops and asks \"Next in line — Start?\"; nothing starts by itself", async () => {
  const { inbox, notes, ids, root, seen } = await queuedThree();
  try {
    const [a, b, c] = await Promise.all(ids.map((id) => inbox.task(id)));
    assert.equal(a!.status, "done");
    assert.equal(seen.prompts, 1, "only the first task ran");
    assert.equal(b!.status, "waiting");
    assert.deepEqual([b!.runAsk?.next?.done, b!.runAsk?.next?.more], [a!.title, 1]);
    assert.equal(c!.runAsk, undefined, "the third is not asked yet");
    assert.ok(notes.some((n) => n.startsWith("🟢 אנטיגרוויטי פנוי") && n.includes("Next in line:")), "one freed-slot note names the next");
    assert.equal(notes.filter((n) => n.startsWith("✦ Next in line")).length, 0, "no second note for the ask");
    assert.equal(inbox.openAsks().length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox queue: Start runs the asked task (and the next one is asked after it); the answer needs a verified sender", async () => {
  const { inbox, ids, root, seen } = await queuedThree();
  try {
    const ask = (await inbox.task(ids[1]!)).runAsk!;
    assert.equal(await inbox.answerRun(ask.requestId, "allow", ""), undefined, "no sender, nothing starts");
    const started = await inbox.answerRun(ask.requestId, "allow", "hub:dphone");
    assert.equal(started?.status, "running");
    await inbox.idle();
    assert.equal(seen.prompts, 2);
    assert.equal((await inbox.task(ids[1]!)).status, "done");
    const third = await inbox.task(ids[2]!);
    assert.equal(third.status, "waiting");
    assert.equal(third.runAsk?.next?.more, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox queue: Skip leaves the task waiting and asks about the one after; Skip on the last asks nothing", async () => {
  const { inbox, ids, root, seen } = await queuedThree();
  try {
    const first = (await inbox.task(ids[1]!)).runAsk!;
    await inbox.answerRun(first.requestId, "deny", "pc"); // a phone's "No" on this ask is a Skip
    const b = await inbox.task(ids[1]!);
    assert.deepEqual([b.status, b.runAsk, /Skipped for now/.test(b.note ?? "")], ["waiting", undefined, true]);
    const second = (await inbox.task(ids[2]!)).runAsk!;
    assert.ok(second, "asks again for the one after");
    await inbox.answerRun(second.requestId, "skip", "pc");
    assert.equal((await inbox.task(ids[2]!)).runAsk, undefined);
    assert.equal(inbox.openAsks().length, 0);
    assert.equal(seen.prompts, 1, "nothing ran");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox queue: Clear empties the line, its tasks go back to waiting for Run, and a Run press starts one", async () => {
  const { inbox, ids, root, seen } = await queuedThree();
  try {
    const ask = (await inbox.task(ids[1]!)).runAsk!;
    await inbox.answerRun(ask.requestId, "clear", "pc");
    for (const id of [ids[1]!, ids[2]!]) {
      const t = await inbox.task(id);
      assert.deepEqual([t.status, t.runAsk, /queue was cleared/.test(t.note ?? "")], ["waiting", undefined, true]);
    }
    assert.equal(inbox.openAsks().length, 0);
    assert.equal(seen.prompts, 1);
    assert.equal((await inbox.run(ids[2]!, { here: true })).status, "running");
    await inbox.idle();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox queue: an ask nobody answers expires and clears the line (nothing starts later)", async () => {
  const { inbox, ids, root } = await queuedThree();
  try {
    assert.ok((await inbox.task(ids[1]!)).runAsk);
    await new Promise((r) => setTimeout(r, 350)); // approvalMs is 300 in these tests
    assert.equal(inbox.openAsks().length, 0);
    assert.match((await inbox.task(ids[2]!)).note ?? "", /queue was cleared/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox queue: the ask's title fits 160 characters, however long the titles are", () => {
  const t = nextInLineTitle("x".repeat(300), "y".repeat(300));
  assert.ok(t.length <= 160);
  assert.match(t, /^Done: x+….*Next in line: y+… — Start\?$/);
  assert.equal(nextInLineTitle("A", "B"), "Done: A. Next in line: B — Start?");
});

test("inbox: a new task's replaces list skips the old ones that have not started, with a note", async () => {
  const old = TASK("c-20261122-10");
  const keep = TASK("c-20261122-11");
  const fresh = `${TASK("c-20261122-12").replace("max_files: 5", "max_files: 5\nreplaces: [c-20261122-10, c-20261122-99, ../x]")}`;
  const { root, repo } = await setup({ "c-20261122-10": old, "c-20261122-11": keep, "c-20261122-12": fresh });
  const { inbox } = await inboxFor(repo, root, {}, { prompts: 0 });
  try {
    await inbox.sync();
    const [o, k, f] = await Promise.all(["c-20261122-10", "c-20261122-11", "c-20261122-12"].map((id) => inbox.task(id)));
    assert.deepEqual([o.status, o.note, o.runAsk], ["skipped", "Replaced by c-20261122-12.", undefined]);
    assert.equal(k.status, "waiting");
    assert.equal(f.status, "waiting");
    assert.deepEqual(f.replaces, ["c-20261122-10", "c-20261122-99"], "only valid ids are kept");
    assert.equal(inbox.openAsks().some((a) => a.title === o.title && a.ask.requestId === o.runAsk?.requestId), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox run: a research report's personal paths are redacted (~ and <user>) and it is pushed; the same path in code still blocks", async () => {
  const { root, origin, repo } = await setup({ "c-20261122-30": TASK("c-20261122-30", "[docs/research/**]"), "c-20261122-31": TASK("c-20261122-31", "[docs/research/**, apps/**]") });
  const home = join(root, "home", "someone");
  const report = `# Findings\n\nThe log is at ${home}/AppData/kesher.log (also ${home.replace(/\//g, "\\")}\\AppData).\nOn Windows: C:\\Users\\Someone\\Desktop and D:/work/someone/notes.\n`;
  try {
    const a = await inboxFor(repo, root, { "docs/research/r-20261122-30.md": report }, { prompts: 0 });
    await a.inbox.sync();
    await a.inbox.run("c-20261122-30", { here: true });
    const t = await settle(a.inbox, "c-20261122-30");
    assert.equal(t.pushed, true, t.note);
    assert.ok(t.checks?.some((c) => c.name === "report redaction" && c.ok));
    assert.ok(t.checks?.some((c) => c.name === "secrets and privacy" && c.ok));
    const pushed = await sh(origin, "show", `${t.branch}:docs/research/r-20261122-30.md`);
    assert.ok(!pushed.toLowerCase().includes("someone"), pushed);
    assert.match(pushed, /~\/AppData\/kesher\.log/);
    assert.match(pushed, /D:\/work\/<user>\/notes/);

    // A report with an email still blocks; a code file with the home path still blocks (nothing is redacted there).
    const b = await inboxFor(repo, root, { "docs/research/r-20261122-31.md": `${report}Contact: someone@gmail.com\n`, "apps/p.ts": `export const p = "${home}/x";\n` }, { prompts: 0 });
    await b.inbox.sync();
    await b.inbox.run("c-20261122-31", { here: true });
    const u = await settle(b.inbox, "c-20261122-31");
    assert.equal(u.status, "failed");
    assert.equal(u.pushed, false);
    const scan = u.checks?.find((c) => c.name === "secrets and privacy");
    assert.ok(scan && !scan.ok && /email address in docs\/research/.test(scan.note) && /personal path in apps\/p\.ts/.test(scan.note), scan?.note);
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
    // The page's state leaves the report's text out (scan 2026-11-27: every poll carried every report).
    assert.equal((await inbox.state(false)).tasks.find((x) => x.id === "r-20261121-01")?.researchReport, undefined);
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

test("inbox: a research whose web search found nothing waits and tries again with a longer wait each time (30, 60, 120 minutes), then fails (not a quota stop, no GhostCLI move)", async () => {
  const { root, repo } = await setup({ "r-20261127-01": RESEARCH_TASK("r-20261127-01") });
  let now = 1_000_000;
  let calls = 0;
  const fail = "Web search returned nothing (duckduckgo: Search answered 429 (a bot check or rate limit).); no report written";
  const inbox = new TaskInbox({
    settings: () => ({ enabled: true, repo, branch: "kesher-inbox" }),
    file: join(root, "inbox.json"),
    git,
    run: async () => ({ code: 1, out: "not in tests" }),
    startAgent: () => Promise.reject(new Error("no")),
    notify: () => undefined,
    busy: async () => ({ free: true, reasons: [] }),
    now: () => now,
    research: { ready: () => true, run: async () => (calls++, Promise.reject(new Error(fail))) },
  });
  try {
    await inbox.sync();
    await inbox.idle();
    let t = await inbox.task("r-20261127-01");
    assert.deepEqual([t.status, t.runBy, calls, t.searchRetry, t.retryAt, t.autoRetried, t.searchTries], ["deferred-quota", "gemini", 1, "waiting", 1_000_000 + SEARCH_RETRY_MS, undefined, 1]);
    assert.match(t.note ?? "", /duckduckgo: Search answered 429[\s\S]*not the model's failure/);
    await inbox.pumpGemini();
    assert.equal(calls, 1, "nothing before the cooldown ends");
    for (const n of [2, 3]) {
      now += SEARCH_RETRY_MS * 2 ** (n - 2) + 1;
      await inbox.pumpGemini();
      t = await inbox.task("r-20261127-01");
      assert.deepEqual([t.status, calls, t.searchTries, t.retryAt], ["deferred-quota", n, n, now + SEARCH_RETRY_MS * 2 ** (n - 1)]);
    }
    now += 4 * SEARCH_RETRY_MS + 1;
    await inbox.pumpGemini();
    t = await inbox.task("r-20261127-01");
    assert.deepEqual([t.status, calls], ["failed", 4]);
    assert.match(t.note ?? "", /^The research failed: Web search returned nothing \(duckduckgo/);
    now += 3 * 60 * 60_000;
    await inbox.pumpGemini();
    assert.equal(calls, 4, "the tries are used: no further retry");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox: a blocked web search gives the research to Antigravity when it has quota (a hand-picked Gemini task too); 'only this executor' waits", async () => {
  const { root, repo } = await setup({ "r-20261128-05": RESEARCH_TASK("r-20261128-05").replace("kind: research", "executor: gemini\nkind: research"), "r-20261128-06": RESEARCH_TASK("r-20261128-06").replace("kind: research", "executor: gemini\nonly_this: true\nkind: research") });
  const now = 1_000_000;
  const fail = "Web search returned nothing (duckduckgo: Search answered 202 (a bot check).); no report written";
  const notes: string[] = [];
  const inbox = new TaskInbox({
    settings: () => ({ enabled: true, repo, branch: "kesher-inbox" }),
    file: join(root, "inbox.json"),
    git,
    run: async () => ({ code: 1, out: "not in tests" }),
    startAgent: () => Promise.reject(new Error("no")),
    notify: (t, b) => void notes.push(`${t} ${b}`),
    busy: async () => ({ free: true, reasons: [] }),
    now: () => now,
    agQuota: async () => ({ at: now, models: [{ name: "Gemini 3 Pro", left: 0.9 }] }),
    research: { ready: () => true, run: async () => Promise.reject(new Error(fail)) },
  });
  try {
    await inbox.loopTick();
    await inbox.sync();
    await inbox.idle();
    await inbox.loopTick();
    const moved = await inbox.task("r-20261128-05");
    assert.deepEqual([moved.runBy, moved.executor, moved.status, moved.movedFrom?.from, moved.moves], ["antigravity", "gemini", "waiting", "gemini", 1]);
    assert.match(moved.note ?? "", /^Moved to Antigravity: Gemini web search blocked till \d\d:\d\d UTC, Antigravity has /);
    assert.equal(notes.filter((n) => n.startsWith("↪ r-20261128-05 moved to Antigravity")).length, 1, "notified once");
    const kept = await inbox.task("r-20261128-06");
    assert.deepEqual([kept.runBy, kept.status, kept.onlyThis, kept.movedFrom], ["gemini", "deferred-quota", true, undefined]);
    // The switch off lets the next pass move it.
    const off = await inbox.setOnlyThis("r-20261128-06", false);
    assert.equal(off.onlyThis, undefined);
    assert.equal((await inbox.task("r-20261128-06")).runBy, "antigravity");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox: research that failed on an empty search before this update goes back once, by itself", () => {
  const base = { title: "x", status: "failed", runBy: "gemini", endedAt: 5 } as unknown as InboxTaskView;
  const tasks = [
    { ...base, id: "a", note: "The research failed: Web search returned nothing; no report written" },
    { ...base, id: "b", note: "The research failed: The model wrote no report." },
    { ...base, id: "c", note: "The research failed: Web search returned nothing; no report written", searchRetry: "used" as const },
    { ...base, id: "d", runBy: "antigravity" as const, note: "Web search returned nothing" },
  ];
  assert.deepEqual(requeueSearchFailures(tasks, 99), ["a"]);
  assert.deepEqual([tasks[0]!.status, tasks[0]!.retryAt, tasks[0]!.searchRetry, tasks[0]!.endedAt], ["deferred-quota", 99, "waiting", undefined]);
  assert.equal(searchRetryDue("Web search returned nothing (bing: x); no report written", undefined), true);
  assert.equal(searchRetryDue("429 RESOURCE_EXHAUSTED", undefined), false);
});

test("inbox: Gemini busy (503 overloaded) waits 15 minutes and tries once more, then succeeds", async () => {
  const { root, repo } = await setup({ "r-20261121-03": RESEARCH_TASK("r-20261121-03") });
  let now = 1_000_000;
  let calls = 0;
  let fail: string | undefined = "POST …/chat/completions → 503 Service Unavailable: The model is overloaded. Please try again later.";
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
    let t = await inbox.task("r-20261121-03");
    assert.deepEqual([t.status, calls, t.retryAt], ["deferred-quota", 1, 1_000_000 + 15 * 60_000]);
    now += 16 * 60_000;
    fail = undefined;
    await inbox.pumpGemini();
    t = await inbox.task("r-20261121-03");
    assert.deepEqual([t.status, calls], ["done", 2]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The ask lives 300 ms in most tests here (approvalMs) and openAsks() drops expired asks. The Windows CI runner spawns
// git slowly and synchronously (spawnSync blocks the event loop), so with the 300 ms default the ask expired before the
// poll below looked (0.6.506 added one more git fetch per sync). The test therefore uses a longer ask life (4 s).
test("inbox queue: even with the ask setting off, Antigravity's next queued task never starts without a Start answer", async () => {
  const { inbox, notes, ids, root, seen } = await queuedThree(false, undefined, 4_000);
  try {
    await inbox.idle();
    await inbox.pump();
    await inbox.sync();
    await inbox.idle();
    assert.equal(seen.prompts, 1, "only the tapped first run ran");
    assert.equal((await inbox.task(ids[1]!)).status, "waiting");
    assert.equal((await inbox.task(ids[2]!)).status, "waiting");
    // The ask is made after the run's end settles; slower machines (Windows CI) need a moment.
    for (let i = 0; i < 200 && inbox.openAsks().length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(inbox.openAsks().length, 1, "one ask at a time, for the first in line");
    assert.equal((await inbox.task(ids[1]!)).runAsk?.next?.done !== undefined, true, "the ask is for the first in line");
    assert.equal(notes.filter((n) => n.startsWith("🟢 אנטיגרוויטי:") && n.includes("התחילה")).length, 0, "no \"started\" note");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox queue: a slow machine (a sync that takes longer than the ask's life) loses a short ask, a long ask survives (the Windows CI failure)", async () => {
  for (const [approvalMs, want] of [[300, 0], [4_000, 1]] as const) {
    let skew = 0; // the clock jumps as a slow synchronous git spawn would make it
    const { inbox, root } = await queuedThree(false, () => Date.now() + skew, approvalMs);
    try {
      await inbox.idle();
      skew += 1000;
      assert.equal(inbox.openAsks().length, want, `approvalMs ${approvalMs}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("inbox queue: a heavy job holds the next queued task back until it is over", async () => {
  heavyNow = "Unreal build";
  const { inbox, ids, root, seen } = await queuedThree(false, undefined, 4_000);
  try {
    assert.equal(seen.prompts, 1, "the next one waits for the heavy job");
    const b = await inbox.task(ids[1]!);
    assert.equal(b.status, "waiting");
    assert.match(b.note ?? "", /waiting for Unreal build/);
    heavyNow = undefined;
    await inbox.pump();
    await inbox.idle();
    await inbox.idle();
    assert.equal(seen.prompts, 1, "when the job is over the next one is asked about, not started");
    for (let i = 0; i < 200 && inbox.openAsks().length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(inbox.openAsks().length, 1);
  } finally {
    heavyNow = undefined;
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox run: Run while another task runs is refused (409) with the PC's words, and Add to queue is the way", async () => {
  const ids = ["c-20261122-11", "c-20261122-12"];
  const { root, repo } = await setup(Object.fromEntries(ids.map((id) => [id, TASK(id)])));
  const seen = { prompts: 0 };
  const h = await inboxFor(repo, root, { "apps/a.ts": "export const a = 5;\n" }, seen);
  h.settings.dailyCap = 9;
  try {
    await h.inbox.sync();
    await h.inbox.run(ids[0]!, { here: true });
    await assert.rejects(h.inbox.run(ids[1]!, { here: true }), (e: Error & { code?: number }) => e.code === 409 && e.message === "משימה רצה, אין להריץ עד שתסתיים");
    await assert.rejects(h.inbox.queueAdd(ids[1]!, ""), (e: Error & { code?: number }) => e.code === 403, "a tap without a verified sender queues nothing");
    const q = await h.inbox.queueAdd(ids[1]!, "pc");
    assert.equal(q.queued, 1);
    assert.deepEqual(h.inbox.queues().antigravity, [ids[1]]);
    await h.inbox.queueRemove(ids[1]!);
    assert.deepEqual(h.inbox.queues().antigravity, []);
    await h.inbox.idle();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox queue: an Antigravity task that ends with another one waiting gets a fresh Next-in-line ask and one note", async () => {
  const ids = ["c-20261122-21", "c-20261122-22"];
  const { root, repo } = await setup(Object.fromEntries(ids.map((id) => [id, TASK(id)])));
  const seen = { prompts: 0 };
  const h = await inboxFor(repo, root, { "apps/a.ts": "export const a = 5;\n" }, seen);
  h.settings.dailyCap = 9;
  try {
    await h.inbox.sync();
    await h.inbox.run(ids[0]!, { here: true });
    await h.inbox.idle();
    const b = await h.inbox.task(ids[1]!);
    assert.ok(b.runAsk?.next, "the waiting task is asked, so the phone shows Run");
    assert.equal(h.notes.filter((n) => n.startsWith("🟢 אנטיגרוויטי פנוי")).length, 1, "one note per freed slot");
    assert.equal(h.notes.filter((n) => /^[✓✕◐⏸] c-2026/.test(n)).length, 0, "the plain end note is replaced");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox queue: the next queued task is the oldest created, not the first tapped", async () => {
  const ids = ["c-20261122-31", "c-20261122-32", "c-20261122-33"];
  const { root, repo } = await setup(Object.fromEntries(ids.map((id) => [id, TASK(id)])));
  const seen = { prompts: 0 };
  const h = await inboxFor(repo, root, { "apps/a.ts": "export const a = 5;\n" }, seen);
  h.settings.dailyCap = 9;
  h.settings.askBeforeNext = { antigravity: false, local: false };
  try {
    await h.inbox.sync();
    await h.inbox.run(ids[0]!, { here: true });
    // The newest is tapped first, the older second: the older still goes first.
    await h.inbox.queueAdd(ids[2]!, "pc");
    const q = await h.inbox.queueAdd(ids[1]!, "pc");
    assert.equal(q.queued, 1, "the older task is next in line");
    assert.equal(h.inbox.queues().antigravity.length, 2);
    assert.equal((await h.inbox.list()).find((t) => t.id === ids[2])?.queued, 2);
    for (let i = 0; i < 4; i++) await h.inbox.idle();
    const [b, c] = await Promise.all([h.inbox.task(ids[1]!), h.inbox.task(ids[2]!)]);
    assert.ok((b.startedAt ?? 0) <= (c.startedAt ?? 0), "oldest started first");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("standing task: a fresh copy of the template appears when Antigravity is idle, once, and never runs by itself", async () => {
  const tpl = "c-20261122-16";
  const { root, repo } = await setup({ [tpl]: TASK(tpl) });
  const seen = { prompts: 0 };
  const h = await inboxFor(repo, root, { "apps/a.ts": "export const a = 5;\n" }, seen);
  h.settings.dailyCap = 9;
  h.settings.loop = false; // with the work loop on, the copy is offered once a day (inbox-opencode.test.ts)
  try {
    await h.inbox.sync();
    assert.equal((await h.inbox.list()).filter((t) => t.standing).length, 0, "the template itself waits: Antigravity is not idle");
    await h.inbox.run(tpl, { here: true });
    await h.inbox.idle();
    await h.inbox.sync();
    let copies = (await h.inbox.list()).filter((t) => t.standing);
    assert.equal(copies.length, 1);
    assert.match(copies[0]!.id, /^c-\d{8}-next-1$/);
    assert.equal(copies[0]!.status, "waiting");
    assert.equal(copies[0]!.runAsk, undefined, "no ask, no auto run");
    await h.inbox.sync();
    copies = (await h.inbox.list()).filter((t) => t.standing);
    assert.equal(copies.length, 1, "at most one at a time");
    assert.equal(seen.prompts, 1, "only the template ran");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox queue: the freed-slot note's Run button starts the next task once; a taken slot voids it", async () => {
  const ids = ["c-20261122-41", "c-20261122-42", "c-20261122-43"];
  const { root, repo } = await setup(Object.fromEntries(ids.map((id) => [id, TASK(id)])));
  const seen = { prompts: 0 };
  const h = await inboxFor(repo, root, { "apps/a.ts": "export const a = 5;\n" }, seen);
  h.settings.dailyCap = 9;
  try {
    await h.inbox.sync();
    await h.inbox.run(ids[0]!, { here: true });
    await h.inbox.idle();
    const freed = h.noteOpts.filter((o, i) => h.notes[i]!.startsWith("🟢 אנטיגרוויטי פנוי") && o?.actions?.length);
    assert.equal(freed.length, 1, "one note with a Run button per freed slot");
    const code = /quick-run\/([\w-]{32})$/.exec(freed[0]!.actions![0]!.path)![1]!;
    assert.equal(await h.inbox.quickRun("x".repeat(32)), false, "an unknown code does nothing");
    assert.equal(await h.inbox.quickRun(code), true);
    assert.equal(await h.inbox.quickRun(code), false, "one-time");
    await h.inbox.idle();
    assert.equal(seen.prompts, 2);
    assert.ok(h.notes.some((n) => /התחילה Antigravity started/.test(n)), "a follow-up note says it started");
    // The slot freed again: a new code. Starting another task by hand voids the old buttons.
    const next = h.inbox.queues();
    assert.deepEqual(next.antigravity, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inbox models: the default for its kind (Opus for code with a check), Opus out of quota falls back to Sonnet, noted in the result", async () => {
  const { root, repo } = await setup({ "c-20261122-40": TASK("c-20261122-40") });
  const seen = { prompts: [] as string[] } as { setModel?: string; prompts: string[] };
  const refs: Array<string | undefined> = [];
  const progress: Array<{ ref: string; body: string }> = [];
  const inbox = new TaskInbox({
    settings: () => ({ enabled: true, repo, branch: "kesher-inbox", dailyCap: 5 }),
    file: join(root, "inbox.json"),
    git,
    run: async (cwd, args) => (args[0] === "git" ? git(cwd, args.slice(1)) : { code: 1, out: "not in tests" }),
    startAgent: (_cwd, h) => AcpAgent.connect(modelAgent(seen, "claude-opus-4.6"), h),
    notify: (_t, _b, o) => void refs.push(o?.ref),
    progress: (n) => void progress.push(n),
    busy: async () => ({ free: true, reasons: [] }),
    approvalMs: 300,
  });
  try {
    await inbox.sync();
    const before = await inbox.state(true);
    assert.deepEqual(before.models?.map((m) => m.name), ["Claude Opus 4.6 (Thinking)", "Claude Sonnet 4.6 (Thinking)", "Gemini 3.8 Flash (Medium)"], "known names before Antigravity was asked");
    await inbox.run("c-20261122-40", { here: true });
    const t = await settle(inbox, "c-20261122-40");
    assert.equal(seen.prompts[0], "claude-opus-4.6", "a code task with a check starts on Opus");
    assert.equal(seen.prompts[1], "claude-sonnet-4.6", `then Sonnet, by itself (${t.note})`);
    assert.equal(t.modelUsed, "Claude Sonnet 4.6 (Thinking)");
    assert.match(t.modelFallback ?? "", /Opus 4\.6.*quota.*→ Claude Sonnet/);
    assert.equal(progress[0]?.ref, "agy-c-20261122-40", "a live progress note while it runs");
    assert.match(progress[0]!.body, /^[▓░]{5} \d+\/\d+/);
    assert.equal(refs.at(-1), "agy-c-20261122-40", "the freed-slot note replaces it (same id)");
    const after = await inbox.state(true);
    assert.ok(!after.models?.some((m) => /Neon/.test(m.name)), "an unavailable model is not offered");
    assert.ok(after.models?.some((m) => /GPT-OSS/.test(m.name)), "the agent's own list after a run");
    await assert.rejects(inbox.setModel("c-20261122-40", "Gemini 4 Neon"), /does not offer/);
    assert.equal((await inbox.setModel("c-20261122-40", "GPT-OSS 120B (Medium)")).model, "GPT-OSS 120B (Medium)");
    assert.equal((await inbox.setModel("c-20261122-40", "")).model, undefined, "empty: back to the default");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an end notice that did not finish says why", async () => {
  const { endBody } = await import("./inbox-runner.js");
  assert.equal(endBody({ title: "T", note: "Today's limit of 10 OpenCode Go tasks is reached." }, "deferred-quota"), "T\nToday's limit of 10 OpenCode Go tasks is reached.");
  assert.equal(endBody({ title: "T", pushed: true, branch: "b", note: "x" }, "done"), "T · b");
});

test("the request budget grows with the task's size", async () => {
  const { requestBudget } = await import("./inbox-runner.js");
  assert.deepEqual([requestBudget({ size: "S" }), requestBudget({ size: "M" }), requestBudget({ size: "L" }, 100)], [80, 120, 200]);
});

test("scratch output files are told apart from work", async () => {
  const { isScratchFile } = await import("./inbox-runner.js");
  assert.deepEqual(["base-out.txt", "test-out.txt", "run.log", "apps/x/output.txt", "notes.tmp"].map(isScratchFile), [true, true, true, true, true]);
  assert.deepEqual(["README.txt", "LICENSE.txt", "docs/plan.txt", "apps/web/src/a.ts", "requirements.txt"].map(isScratchFile), [false, false, false, false, false]);
  assert.deepEqual(["prev_llamacpp.test.ts", "old-config.json", "server.ts.bak", "app.orig"].map(isScratchFile), [true, true, true, true]);
  assert.deepEqual(["previews.ts", "copyright.md", "packages/core/src/old.ts"].map(isScratchFile), [false, false, false]);
});

test("a failure goes back to the queue unless a safety rule stopped it", async () => {
  const { retryable } = await import("./inbox-runner.js");
  assert.equal(retryable("Stopped at the request budget (120)."), true);
  assert.equal(retryable("POST https://x/v1 → 502 Bad Gateway"), true);
  assert.equal(retryable("Privacy guard: skip. A file this run read holds 1 key"), false);
  assert.equal(retryable("Not committed or pushed: outside the allowed paths: a.txt"), false);
});

test("rememberFail keeps why a run did not succeed, and a done run clears it", () => {
  const t = { id: "x", title: "x", status: "failed", note: "Antigravity quota spent" } as Parameters<typeof rememberFail>[0];
  rememberFail(t, "deferred-quota", 5);
  assert.deepEqual(t.lastFail, { at: 5, status: "deferred-quota", note: "Antigravity quota spent" });
  t.note = "Queued";
  assert.equal(t.lastFail?.note, "Antigravity quota spent");
  rememberFail(t, "done", 6);
  assert.equal(t.lastFail, undefined);
});

test("fetchRepairing removes a broken remote-tracking ref and fetches again", async () => {
  const { brokenRemoteRef, fetchRepairing } = await import("./inbox-runner.js");
  assert.equal(brokenRemoteRef("fatal: bad object refs/remotes/origin/release\nerror: did not send all necessary objects"), "refs/remotes/origin/release");
  assert.equal(brokenRemoteRef("fatal: bad object refs/heads/main"), undefined);
  assert.equal(brokenRemoteRef("fatal: bad object refs/remotes/../x"), undefined);
  const calls: string[][] = [];
  let broken = true;
  const fake = async (_cwd: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "update-ref") { broken = false; return { code: 0, out: "" }; }
    return broken ? { code: 128, out: "fatal: bad object refs/remotes/origin/release" } : { code: 0, out: "" };
  };
  const r = await fetchRepairing(fake as never, "/repo", ["fetch", "--quiet", "origin"]);
  assert.equal(r.code, 0);
  assert.deepEqual(calls.map((c) => c[0]), ["fetch", "update-ref", "fetch"]);
  assert.deepEqual(calls[1], ["update-ref", "-d", "refs/remotes/origin/release"]);
  // Another failure is left alone.
  calls.length = 0;
  const other = await fetchRepairing((async (_c: string, a: string[]) => (calls.push(a), { code: 1, out: "Could not resolve host" })) as never, "/repo", ["fetch"]);
  assert.equal(other.code, 1);
  assert.equal(calls.length, 1);
});

test("fetchRepairing removes a damaged (empty) ref file git cannot delete, and fetches without auto-maintenance", async () => {
  const { fetchRepairing } = await import("./inbox-runner.js");
  const gitDir = process.platform === "win32" ? "C:\\repo\\.git" : "/repo/.git";
  const sep = process.platform === "win32" ? "\\" : "/";
  const refFile = [gitDir, "refs", "remotes", "origin", "release"].join(sep);
  const files = new Map<string, string>([[refFile, ""]]);
  const removed: string[] = [];
  const calls: string[][] = [];
  const fake = async (_cwd: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "update-ref") return { code: 128, out: "fatal: cannot lock ref 'refs/remotes/origin/release'" };
    if (args[0] === "rev-parse") return { code: 0, out: gitDir + "\n" };
    return files.has(refFile) ? { code: 128, out: "fatal: bad object refs/remotes/origin/release" } : { code: 0, out: "" };
  };
  const r = await fetchRepairing(fake as never, "/repo", ["fetch", "--quiet", "origin"], undefined, { read: async (p) => files.get(p), remove: async (p) => (removed.push(p), void files.delete(p)) });
  assert.equal(r.code, 0);
  assert.deepEqual(calls[0], ["fetch", "--no-auto-maintenance", "--quiet", "origin"]);
  assert.ok(removed.includes(refFile));
  // A ref file holding a valid id is never removed.
  files.set(refFile, "a".repeat(40) + "\n");
  removed.length = 0;
  const r2 = await fetchRepairing(fake as never, "/repo", ["fetch"], undefined, { read: async (p) => files.get(p), remove: async (p) => void removed.push(p) });
  assert.notEqual(r2.code, 0);
  assert.deepEqual(removed, []);
});

test("freshTaskId: tasks within 14 days of the newest on the branch are read, older ones never come back", async () => {
  const { freshTaskId } = await import("./inbox-runner.js");
  const fresh = freshTaskId(["o-20261101-03", "o-20261113-01", "r-20261127-14"]);
  assert.ok(fresh("r-20261127-14"));
  assert.ok(fresh("o-20261113-01"));
  assert.equal(fresh("o-20261101-03"), false);
  assert.ok(fresh("weird-id"), "no day: read");
  assert.ok(freshTaskId([])("x-20200101-01"), "an empty branch reads everything");
  // A task dated years ahead does not hide the real ones; a clock far behind every id still measures from the branch.
  const now = Date.UTC(2026, 10, 27);
  const typo = freshTaskId(["o-20261120-01", "o-29991231-01"], now);
  assert.ok(typo("o-20261120-01"));
  assert.equal(freshTaskId(["o-20261101-03", "r-20261127-14"], Date.UTC(2020, 0, 1))("o-20261101-03"), false);
});
