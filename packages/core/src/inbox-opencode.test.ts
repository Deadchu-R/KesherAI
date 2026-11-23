import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFreeOpencodeModel, OPENCODE_DEFAULTS, opencodeFreeFirst, opencodeFreeModel, opencodeModelFor, opencodeModelOrder } from "@kesher/shared";
import { inboxSnapshot } from "./agent-activity.js";
import { OPENCODE_LIMIT_MS, TaskInbox, type RunCmd, type TaskInboxDeps } from "./inbox-runner.js";
import { taskSize } from "./task-inbox.js";

/**
 * The `opencode` executor (OpenCode Go, the flat coding plan): routing while Antigravity is out, the model by size,
 * its daily cap, the 429 back-off and "no key, not used". A local bare repo and a fake coder stand in for GitHub and
 * the code chat.
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

/** A task file: `extra` frontmatter lines after the standard ones. */
const TASK = (id: string, executor: string, extra = "") => `---
id: ${id}
title: Add a clear button ${id}
executor: ${executor}
risk: medium
allowed_paths: [apps/**]
check: git status
max_files: 5
${extra}---

## Goal
Add a "Clear all" button.

## Acceptance
The button empties the list.
`;

/** A project with an origin, tasks on its inbox branch and (optionally) a research report on main. */
async function setup(tasks: Record<string, string>, report?: string) {
  const root = mkdtempSync(join(tmpdir(), "kesher-ocgo-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  await sh(root, "init", "--quiet", "--bare", "-b", "main", origin);
  await sh(root, "clone", "--quiet", origin, repo);
  await sh(repo, "checkout", "-q", "-b", "main");
  mkdirSync(join(repo, "apps"), { recursive: true });
  writeFileSync(join(repo, "apps", "a.ts"), "export const a = 1;\n");
  if (report) {
    mkdirSync(join(repo, "docs", "research"), { recursive: true });
    writeFileSync(join(repo, "docs", "research", "r1.md"), report);
  }
  await sh(repo, "add", "-A");
  await sh(repo, "commit", "-q", "-m", "init");
  await sh(repo, "push", "-q", "origin", "main");
  const claude = join(root, "claude");
  await sh(root, "clone", "--quiet", origin, claude);
  await sh(claude, "checkout", "-q", "--orphan", "kesher-inbox");
  await sh(claude, "rm", "-rfq", ".");
  mkdirSync(join(claude, "tasks"), { recursive: true });
  writeFileSync(join(claude, "tasks", "README.md"), "inbox\n");
  for (const [id, text] of Object.entries(tasks)) writeFileSync(join(claude, "tasks", `${id}.md`), text);
  await sh(claude, "add", "-A");
  await sh(claude, "commit", "-q", "-m", "tasks");
  await sh(claude, "push", "-q", "origin", "kesher-inbox");
  return { root, repo };
}

/** A fake OpenCode Go coder: writes a file in the worktree, or throws what `fail` says. */
function fakeCoder(o: { ready?: boolean; fail?: (model: string) => Error | undefined; listed?: string[] } = {}) {
  const runs: Array<{ model: string; title: string }> = [];
  const coder: NonNullable<TaskInboxDeps["coder"]> = {
    ready: () => o.ready ?? true,
    models: async () => o.listed ?? ["opencode-go/mimo-v2.6-flash", "opencode-go/mimo-v2.6-pro"],
    run: async ({ worktree, model, title, onStep }) => {
      runs.push({ model, title });
      const err = o.fail?.(model);
      if (err) throw err;
      onStep(2);
      writeFileSync(join(worktree, "apps", "a.ts"), `export const a = ${runs.length + 1};\n`);
      return { text: "Changed apps/a.ts. Checked with git status." };
    },
  };
  return { coder, runs };
}

function inboxFor(repo: string, root: string, coder: TaskInboxDeps["coder"], settings: Record<string, unknown> = {}, now = () => Date.now()) {
  const notes: string[] = [];
  const inbox = new TaskInbox({
    settings: () => ({ enabled: true, repo, branch: "kesher-inbox", dailyCap: 10, ...settings }),
    file: join(root, "inbox.json"),
    git,
    run: async (cwd, args) => (args[0] === "git" ? git(cwd, args.slice(1)) : { code: 1, out: "not in tests" }),
    startAgent: () => Promise.reject(new Error("Antigravity must not start for an OpenCode Go task")),
    notify: (t, b) => void notes.push(`${t} ${b}`),
    busy: async () => ({ free: true, reasons: [] }),
    ...(coder ? { coder } : {}),
    now,
  });
  return { inbox, notes };
}

/** Syncs, then waits for the OpenCode Go loop to run what it can. */
async function syncAndRun(inbox: TaskInbox): Promise<void> {
  await inbox.sync();
  await inbox.pumpOpencode();
  await inbox.idle();
}

test("opencode: the model by size (S cheap, M/L strong; a task's own OpenCode Go model wins)", () => {
  const s = { small: "opencode-go/mimo-v2.6-flash", strong: "opencode-go/mimo-v2.6-pro" };
  assert.equal(opencodeModelFor({ size: "S" }, s), "opencode-go/mimo-v2.6-flash");
  assert.equal(opencodeModelFor({ size: "M" }, s), "opencode-go/mimo-v2.6-pro");
  assert.equal(opencodeModelFor({ size: "L" }, s), "opencode-go/mimo-v2.6-pro");
  assert.equal(opencodeModelFor({ size: "S", model: "opencode-go/minimax-m3" }, s), "opencode-go/minimax-m3");
  // An Antigravity model name in the task does not leak into OpenCode Go.
  assert.equal(opencodeModelFor({ size: "S", model: "Claude Opus 4.6 (Thinking)" }, s), "opencode-go/mimo-v2.6-flash");
  assert.equal(opencodeModelFor({}, { small: "", strong: "" }), OPENCODE_DEFAULTS.strong);
  // No size in the file: guessed from the limits.
  assert.equal(taskSize({ maxFiles: 2, risk: "low" }), "S");
  assert.equal(taskSize({ maxFiles: 10, risk: "low" }), "M");
  assert.equal(taskSize({ maxFiles: 40, risk: "medium" }), "L");
});

test("opencode: an explicit task runs by itself on its size's model, on an ocgo/* branch, checked, pushed and shown", async () => {
  const { root, repo } = await setup({ "c-20261122-01": TASK("c-20261122-01", "opencode", "size: S\n"), "c-20261122-02": TASK("c-20261122-02", "opencode", "size: M\n") });
  const { coder, runs } = fakeCoder();
  const { inbox, notes } = inboxFor(repo, root, coder);
  try {
    await syncAndRun(inbox);
    const a = await inbox.task("c-20261122-01");
    const b = await inbox.task("c-20261122-02");
    assert.deepEqual(runs.map((r) => r.model), ["opencode-go/mimo-v2.6-flash", "opencode-go/mimo-v2.6-pro"]);
    assert.deepEqual([a.runBy, a.status, a.modelUsed, a.pushed, a.steps], ["opencode", "done", "OpenCode Go · mimo-v2.6-flash", true, 2]);
    assert.match(a.branch, /^ocgo\/c-20261122-01-/);
    assert.equal(b.modelUsed, "OpenCode Go · mimo-v2.6-pro");
    // The branch is on origin (never main), committed as KesherAI.
    assert.match(await sh(repo, "ls-remote", "origin", a.branch), /refs\/heads\/ocgo\//);
    assert.match(await sh(repo, "log", "-1", "--format=%an %B", `origin/${a.branch}`).catch(async () => (await sh(repo, "fetch", "-q", "origin", a.branch), sh(repo, "log", "-1", "--format=%B", "FETCH_HEAD"))), /run by OpenCode Go \(OpenCode Go · mimo-v2\.6-flash\)/);
    // Hebrew notes when it starts and ends.
    assert.ok(notes.some((n) => n.startsWith("◈ OpenCode Go התחיל משימה")), notes.join("\n"));
    assert.ok(notes.some((n) => n.startsWith("✓ OpenCode Go סיים משימה")), notes.join("\n"));
    // The hub's Agents page: the task inbox's run, with its model.
    const snap = inboxSnapshot(a, undefined, "asks");
    assert.deepEqual([snap?.source, snap?.model, snap?.state], ["inbox", "OpenCode Go · mimo-v2.6-flash", "done"]);
    const st = await inbox.state(true);
    assert.deepEqual([st.opencode?.ready, st.opencode?.used, st.opencode?.models.length], [true, 2, 2]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("opencode: auto routing gives S/M code tasks to OpenCode Go only while Antigravity is out (L stays)", async () => {
  const tasks = { "c-20261122-03": TASK("c-20261122-03", "auto"), "c-20261122-04": TASK("c-20261122-04", "auto", "size: L\n") };
  // Antigravity has room: the task waits for its Run as before.
  {
    const { root, repo } = await setup(tasks);
    const { coder, runs } = fakeCoder();
    const { inbox } = inboxFor(repo, root, coder, { dailyCap: 10 });
    try {
      await syncAndRun(inbox);
      assert.equal((await inbox.task("c-20261122-03")).runBy, "antigravity");
      assert.equal(runs.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  // Antigravity's daily cap is spent: the M task goes to OpenCode Go and runs; the L one stays for Antigravity/Claude.
  {
    const { root, repo } = await setup(tasks);
    const { coder, runs } = fakeCoder();
    const { inbox } = inboxFor(repo, root, coder, { dailyCap: 0 });
    try {
      await syncAndRun(inbox);
      const t = await inbox.task("c-20261122-03");
      assert.deepEqual([t.runBy, t.status], ["opencode", "done"]);
      assert.equal((await inbox.task("c-20261122-04")).runBy, "antigravity");
      assert.deepEqual(runs.map((r) => r.model), ["opencode-go/mimo-v2.6-pro"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  // Antigravity out but OpenCode Go turned off: nothing goes there.
  {
    const { root, repo } = await setup(tasks);
    const { coder, runs } = fakeCoder();
    const { inbox } = inboxFor(repo, root, coder, { dailyCap: 0, opencode: { enabled: false } });
    try {
      await syncAndRun(inbox);
      assert.equal((await inbox.task("c-20261122-03")).runBy, "antigravity");
      assert.equal(runs.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("opencode: no key, not used (auto stays with Antigravity; an explicit task waits with a note)", async () => {
  const { root, repo } = await setup({ "c-20261122-05": TASK("c-20261122-05", "auto"), "c-20261122-06": TASK("c-20261122-06", "opencode") });
  const { coder, runs } = fakeCoder({ ready: false });
  const { inbox } = inboxFor(repo, root, coder, { dailyCap: 0 });
  try {
    await syncAndRun(inbox);
    assert.equal((await inbox.task("c-20261122-05")).runBy, "antigravity");
    const t = await inbox.task("c-20261122-06");
    assert.deepEqual([t.runBy, t.status], ["opencode", "waiting"]);
    assert.match(t.note ?? "", /Waiting for the OpenCode Go connection/);
    assert.equal(runs.length, 0);
    assert.equal((await inbox.state(true)).opencode?.ready, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("opencode: its daily cap holds the rest of the line", async () => {
  const { root, repo } = await setup({ "c-20261122-07": TASK("c-20261122-07", "opencode"), "c-20261122-08": TASK("c-20261122-08", "opencode") });
  const { coder, runs } = fakeCoder();
  const { inbox } = inboxFor(repo, root, coder, { opencode: { dailyCap: 1 } });
  try {
    await syncAndRun(inbox);
    assert.equal(runs.length, 1);
    const second = await inbox.task("c-20261122-08");
    assert.equal(second.status, "waiting");
    assert.match(second.note ?? "", /Today's limit of 1 OpenCode Go tasks/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("opencode: a 429 marks it out until Retry-After (else 5 hours) and stops feeding it; it goes again after", async () => {
  const { root, repo } = await setup({ "c-20261122-09": TASK("c-20261122-09", "opencode"), "c-20261122-10": TASK("c-20261122-10", "opencode") });
  let now = 1_800_000_000_000;
  let fail: Error | undefined = Object.assign(new Error("POST https://opencode.ai/zen/go/v1/chat/completions → 429 Too Many Requests: usage limit reached"), { rateHeaders: { "retry-after": "600" } });
  const { coder, runs } = fakeCoder({ fail: () => fail });
  const { inbox, notes } = inboxFor(repo, root, coder, {}, () => now);
  try {
    await syncAndRun(inbox);
    // Each 429 blocks only its model; the task went on through all four (two tries a run) before the family was out.
    assert.equal(runs.length, 4);
    const t = await inbox.task("c-20261122-09");
    assert.equal(t.status, "deferred-quota");
    assert.match(t.note ?? "", /OpenCode Go limit reached until/);
    assert.ok(notes.some((n) => n.startsWith("⏸ OpenCode Go הגיע למגבלה")), notes.join("\n"));
    assert.equal((await inbox.state(true)).opencode?.until, now + 600_000);
    // The second task is not fed to it while the limit holds.
    assert.equal((await inbox.task("c-20261122-10")).status, "waiting");
    await inbox.pumpOpencode();
    assert.equal(runs.length, 4);
    // After the reset both go, in order.
    fail = undefined;
    now += 601_000;
    await inbox.pumpOpencode();
    assert.deepEqual([(await inbox.task("c-20261122-09")).status, (await inbox.task("c-20261122-10")).status], ["done", "done"]);
    // A 429 that does not say how long: 5 hours.
    await syncAndRun(inbox);
    const later = await inbox.add({ title: "One more", goal: "Do it.", executor: "opencode", check: "git status" });
    fail = new Error("429 rate limit");
    await inbox.pumpOpencode();
    assert.equal((await inbox.task(later.id)).status, "deferred-quota");
    assert.equal((await inbox.state(true)).opencode?.until, now + OPENCODE_LIMIT_MS);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("opencode: a 429 blocks only that model; the task goes once more on the next free one", async () => {
  const { root, repo } = await setup({ "c-20261122-11": TASK("c-20261122-11", "opencode"), "c-20261122-12": TASK("c-20261122-12", "opencode") });
  const now = 1_800_000_000_000;
  const { coder, runs } = fakeCoder({ fail: () => (runs.length === 1 ? Object.assign(new Error("429 usage limit reached"), { rateHeaders: { "retry-after": "900" } }) : undefined) });
  const { inbox } = inboxFor(repo, root, coder, {}, () => now);
  try {
    await syncAndRun(inbox);
    // The first task: strong (pro) answered 429, flash took it over and finished it.
    assert.deepEqual(runs.slice(0, 2).map((r) => r.model), ["opencode-go/mimo-v2.6-pro", "opencode-go/mimo-v2.6-flash"]);
    const t = await inbox.task("c-20261122-11");
    assert.equal(t.status, "done");
    assert.match(t.modelUsed ?? "", /mimo-v2\.6-flash/);
    // The family is not blocked: only pro is cooling (900 s); the next task starts on the next free model.
    const st = (await inbox.state(true)).opencode;
    assert.equal(st?.until, undefined);
    assert.deepEqual(st?.cooldowns, { "opencode-go/mimo-v2.6-pro": now + 900_000 });
    assert.equal(runs[2]?.model, "opencode-go/mimo-v2.6-flash");
    assert.equal((await inbox.task("c-20261122-12")).status, "done");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("opencode: the fallback order and the free-model pick (kimi only when configured)", () => {
  const def = opencodeModelOrder(OPENCODE_DEFAULTS);
  assert.deepEqual(def, ["opencode-go/mimo-v2.6-flash", "opencode-go/mimo-v2.6-pro", "opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3"]);
  assert.ok(!def.some((m) => m.includes("kimi")));
  // Configured small/strong come first, kimi included when the user chose it.
  assert.deepEqual(opencodeModelOrder({ small: "opencode-go/kimi-k3", strong: "opencode-go/glm-5.3" }).slice(0, 3), ["opencode-go/kimi-k3", "opencode-go/glm-5.3", "opencode-go/mimo-v2.6-flash"]);
  const now = 1000;
  assert.equal(opencodeFreeModel(def, {}, now, "opencode-go/mimo-v2.6-pro"), "opencode-go/mimo-v2.6-pro");
  assert.equal(opencodeFreeModel(def, { "opencode-go/mimo-v2.6-pro": 2000 }, now, "opencode-go/mimo-v2.6-pro"), "opencode-go/mimo-v2.6-flash");
  // An expired cooldown is free again; a skipped model is never returned; all cooling: undefined.
  assert.equal(opencodeFreeModel(def, { "opencode-go/mimo-v2.6-pro": 999 }, now, "opencode-go/mimo-v2.6-pro"), "opencode-go/mimo-v2.6-pro");
  assert.equal(opencodeFreeModel(def, {}, now, undefined, ["opencode-go/mimo-v2.6-flash"]), "opencode-go/mimo-v2.6-pro");
  assert.equal(opencodeFreeModel(def, Object.fromEntries(def.map((m) => [m, 5000])), now), undefined);
});

test("opencode: the research loop fills the gap while Antigravity is out (M tasks; lead tasks stay)", async () => {
  const report = ["# Report", "", "## Tasks", "- **A1** — Add a sort button: Size M, who AGY.", "- **A2** — Rewrite the sync engine: Size L, who LEAD.", ""].join("\n");
  const { root, repo } = await setup({}, report);
  const { coder, runs } = fakeCoder();
  const { inbox } = inboxFor(repo, root, coder, { dailyCap: 0 });
  try {
    await syncAndRun(inbox);
    const tasks = await inbox.list();
    const made = tasks.find((t) => t.title.includes("sort button"));
    // Its check (typecheck and lint) cannot run in the test, so the work is kept as partial: it ran all the same.
    assert.deepEqual([made?.runBy, made?.size, made?.status], ["opencode", "M", "partial"]);
    assert.ok(!tasks.some((t) => t.title.includes("sync engine")));
    assert.deepEqual(runs.map((r) => r.model), ["opencode-go/mimo-v2.6-pro"]);
    assert.equal(inbox.researchBacklog().lead.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("opencode: the plan's free models go first and do not count toward the daily cap", async () => {
  const { root, repo } = await setup({ "c-20261122-21": TASK("c-20261122-21", "opencode", "size: S\n"), "c-20261122-22": TASK("c-20261122-22", "opencode", "size: S\n") });
  const listed = ["opencode-go/beam-free", "opencode-go/mimo-v2.6-flash", "opencode-go/mimo-v2.6-pro"];
  const { coder, runs } = fakeCoder({ listed });
  const { inbox } = inboxFor(repo, root, coder, { opencode: { dailyCap: 1 } });
  try {
    await inbox.state(true); // asks the connection for its models, as the settings card does
    await syncAndRun(inbox);
    // Both ran on Beam Free, past a cap of 1: free runs cost nothing.
    assert.deepEqual(runs.map((r) => r.model), ["opencode-go/beam-free", "opencode-go/beam-free"]);
    assert.equal((await inbox.state(true)).opencode?.used, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("opencode: free models are only those the connection lists, and off with useFree false", () => {
  assert.deepEqual(opencodeFreeFirst({}, ["opencode-go/beam-free", "opencode-go/glm-5.3"]), ["opencode-go/beam-free"]);
  assert.deepEqual(opencodeFreeFirst({ useFree: false }, ["opencode-go/beam-free"]), []);
  assert.deepEqual(opencodeFreeFirst({}, []), []);
  assert.equal(isFreeOpencodeModel("opencode-go/iceman-contributor-free"), true);
  assert.equal(isFreeOpencodeModel("opencode-go/mimo-v2.6-flash"), false);
});
