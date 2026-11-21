import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CooldownHandoff, EMPTY_HANDOFF, handoffGoal, isClaudeModel, localDate, stepHandoff, withCooldown, type HandoffInput, type HandoffState } from "./cooldown-handoff.js";

const NOW = new Date(2026, 10, 21, 10, 0).getTime();
const HOUR = 3_600_000;
const cooling = (s: Partial<HandoffState> = {}): HandoffState => ({ ...EMPTY_HANDOFF, today: { date: localDate(NOW), used: 0 }, cooldown: { until: NOW + 2 * HOUR, since: NOW - 1000, source: "manual" }, ...s });
const input = (i: Partial<HandoffInput> = {}): HandoffInput => ({
  now: NOW,
  enabled: true,
  cap: 6,
  batch: 2,
  candidates: [
    { boardId: "t1", title: "One" },
    { boardId: "t2", title: "Two", inboxId: "c-1" },
    { boardId: "t3", title: "Three" },
    { boardId: "t9", title: "Agy", antigravity: true },
  ],
  boardStatus: {},
  selfWork: "idle",
  ...i,
});
const working = (ids: string[]) => ids.map((id) => ({ boardId: id, title: id, at: NOW - 1000, status: "working" as const }));

test("stepHandoff: the hand-off state machine", () => {
  const rows: Array<{ why: string; s: HandoffState; i: Partial<HandoffInput>; actions: string[]; phase: HandoffState["phase"]; handed?: string[] }> = [
    { why: "no cooldown: nothing", s: { ...EMPTY_HANDOFF }, i: {}, actions: [], phase: "idle" },
    { why: "cooling, idle: hands a batch, starts, notifies", s: cooling(), i: {}, actions: ["hand", "start", "notify"], phase: "working", handed: ["t1", "t2"] },
    { why: "turned off: nothing", s: cooling(), i: { enabled: false }, actions: [], phase: "idle" },
    { why: "the user's own run goes first", s: cooling(), i: { selfWork: "other" }, actions: [], phase: "idle" },
    { why: "our run is going: wait", s: cooling({ phase: "working", handed: working(["t1"]) }), i: { selfWork: "ours" }, actions: [], phase: "working" },
    { why: "run ended with t1 done: next batch", s: cooling({ phase: "working", handed: working(["t1"]) }), i: { boardStatus: { t1: "done" } }, actions: ["hand", "start", "notify"], phase: "working", handed: ["t1", "t2", "t3"] },
    { why: "run gone with t1 unfinished: give back, then next", s: cooling({ phase: "working", handed: working(["t1"]) }), i: {}, actions: ["giveBack", "hand", "start", "notify"], phase: "working" },
    { why: "Claude back while working: stop, give back, notify", s: { ...cooling({ phase: "working", handed: working(["t1"]) }), cooldown: { until: NOW - 1, since: NOW - HOUR, source: "error" } }, i: { selfWork: "ours" }, actions: ["stop", "giveBack", "notify"], phase: "idle" },
    { why: "daily cap reached: nothing", s: cooling({ today: { date: localDate(NOW), used: 6 } }), i: {}, actions: [], phase: "idle" },
    { why: "a new day resets the cap", s: cooling({ today: { date: "2026-11-20", used: 6 } }), i: {}, actions: ["hand", "start", "notify"], phase: "working" },
    { why: "never Antigravity", s: cooling(), i: { candidates: [{ boardId: "t9", title: "Agy", antigravity: true }] }, actions: [], phase: "idle" },
    { why: "after a failed start: wait for retryAt", s: cooling({ retryAt: NOW + 1000 }), i: {}, actions: [], phase: "idle" },
  ];
  for (const r of rows) {
    const out = stepHandoff(r.s, input(r.i));
    assert.deepEqual(out.actions.map((a) => a.type), r.actions, r.why);
    assert.equal(out.state.phase, r.phase, r.why);
    if (r.handed) assert.deepEqual(out.state.handed.map((t) => t.boardId), r.handed, r.why);
  }
});

test("stepHandoff: the cap limits a batch; done and given-back tasks are not handed again", () => {
  const out = stepHandoff(cooling({ today: { date: localDate(NOW), used: 5 } }), input());
  assert.deepEqual(out.state.handed.map((t) => t.boardId), ["t1"]);
  assert.equal(out.state.today.used, 6);
  const again = stepHandoff(cooling({ handed: [{ boardId: "t1", title: "t1", at: 0, status: "returned" }, { boardId: "t2", title: "t2", at: 0, status: "done" }] }), input());
  assert.deepEqual(again.state.handed.filter((t) => t.status === "working").map((t) => t.boardId), ["t3"]);
  const start = again.actions.find((a) => a.type === "start");
  assert.ok(start && start.type === "start" && start.until === NOW + 2 * HOUR);
});

test("withCooldown extends an active cooldown and starts a new one fresh", () => {
  const s = cooling({ handed: [{ boardId: "old", title: "o", at: 0, status: "done" }, ...working(["w"])] });
  assert.equal(withCooldown(s, { until: NOW + HOUR, source: "error" }, NOW).cooldown!.until, NOW + 2 * HOUR, "never shortened");
  assert.equal(withCooldown(s, { until: NOW + 3 * HOUR, source: "error" }, NOW).cooldown!.until, NOW + 3 * HOUR);
  const fresh = withCooldown({ ...s, cooldown: { until: NOW - 1, since: 0, source: "manual" } }, { until: NOW + HOUR, source: "claude" }, NOW);
  assert.deepEqual(fresh.handed.map((t) => t.boardId), ["w"]);
  assert.equal(fresh.cooldown!.source, "claude");
  assert.equal(withCooldown(s, { until: NOW - 5, source: "manual" }, NOW), s, "a time in the past changes nothing");
});

test("isClaudeModel and the goal text", () => {
  assert.ok(isClaudeModel("agent/claude"));
  assert.ok(isClaudeModel("anthropic/claude-opus-5-5"));
  assert.ok(!isClaudeModel("lmstudio/qwen3.6-27b"));
  assert.ok(!isClaudeModel(undefined));
  const g = handoffGoal(working(["t1", "t2"]), NOW + HOUR);
  assert.match(g, /^Claude is cooling down until 11:00/);
  assert.match(g, /1\. \[t1\] t1\n2\. \[t2\] t2/);
});

test("CooldownHandoff: hands over, resumes after a restart, gives back when Claude is back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-handoff-"));
  try {
    let now = NOW;
    const board = [
      { id: "t1", title: "One", status: "open" as "open" | "claimed" | "done" | "blocked", localOk: true },
      { id: "t2", title: "Two", status: "open" as "open" | "claimed" | "done" | "blocked", localOk: true },
      { id: "t3", title: "Big", status: "open" as "open" | "claimed" | "done" | "blocked" },
    ];
    let run: { running: boolean; goal?: string } = { running: false };
    const log: string[] = [];
    const deps = {
      file: join(dir, "h.json"),
      settings: () => ({ enabled: true, repo: "/home/u/p", check: "", dailyCap: 6, batch: 3 }),
      board: async () => board,
      inbox: async () => [],
      selfWork: async () => run,
      startSelfWork: async (o: { goal: string }) => {
        log.push("start");
        run = { running: true, goal: o.goal };
      },
      stopSelfWork: async () => {
        log.push("stop");
        run = { running: false, goal: run.goal };
      },
      mark: async (t: { boardId: string }, toLocal: boolean) => void log.push(`${toLocal ? "hand" : "back"} ${t.boardId}`),
      notify: async (title: string) => void log.push(`notify ${title}`),
      now: () => now,
    };
    const h = new CooldownHandoff(deps);
    assert.deepEqual(await h.tick(), [], "nothing while Claude is fine");
    await h.set(NOW + HOUR, "claude");
    assert.deepEqual(log, ["hand t1", "hand t2", "start", "notify Running on the local model"]);
    // KesherAI restarts: a new runner reads the file and sees its run still going (self-work resumed it).
    const h2 = new CooldownHandoff(deps);
    assert.deepEqual(await h2.tick(), []);
    assert.equal((await h2.view()).phase, "working");
    board[0]!.status = "done";
    now = NOW + HOUR + 1;
    await h2.tick();
    assert.deepEqual(log.slice(4), ["stop", "back t2", "notify Claude is back"]);
    const v = await h2.view();
    assert.equal(v.cooling, false);
    assert.deepEqual(v.handed.map((t) => `${t.boardId}:${t.status}`), ["t1:done", "t2:returned"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CooldownHandoff: a failed start gives the tasks back and waits before trying again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-handoff-"));
  try {
    const log: string[] = [];
    const h = new CooldownHandoff({
      file: join(dir, "h.json"),
      settings: () => ({ enabled: true, repo: "/home/u/p", check: "", dailyCap: 6, batch: 3 }),
      board: async () => [{ id: "t1", title: "One", status: "open", localOk: true }],
      inbox: async () => [{ id: "c-1", boardId: "t1", runBy: "opus", status: "queued" }],
      selfWork: async () => ({ running: false }),
      startSelfWork: async () => {
        throw new Error("The drive is full.");
      },
      stopSelfWork: async () => undefined,
      mark: async (t, toLocal) => void log.push(`${toLocal ? "hand" : "back"} ${t.inboxId ?? t.boardId}`),
      notify: async (title) => void log.push(`notify ${title}`),
      now: () => NOW,
    });
    await h.set(NOW + HOUR, "manual");
    assert.deepEqual(log, ["hand c-1", "back c-1", "notify The local model could not start"]);
    const v = await h.view();
    assert.equal(v.phase, "idle");
    assert.equal(v.retryAt, NOW + 30 * 60_000);
    assert.deepEqual(await h.tick(), [], "no retry before retryAt");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CooldownHandoff: only a Claude chat's usage limit starts a cooldown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-handoff-"));
  try {
    const h = new CooldownHandoff({
      file: join(dir, "h.json"),
      settings: () => ({ enabled: false, repo: "", check: "", dailyCap: 6, batch: 3 }),
      board: async () => [],
      inbox: async () => [],
      selfWork: async () => ({ running: false }),
      startSelfWork: async () => undefined,
      stopSelfWork: async () => undefined,
      mark: async () => undefined,
      notify: async () => undefined,
      now: () => NOW,
    });
    assert.equal(await h.noteError("lmstudio/qwen", "rate limit"), false);
    assert.equal(await h.noteError("agent/claude", "network down"), false);
    assert.equal(await h.noteError("agent/claude", "Usage limit reached, try again in 2h 30m"), true);
    assert.equal((await h.view()).cooldown!.until, NOW + 150 * 60_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
