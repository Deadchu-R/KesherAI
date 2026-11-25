import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentCard } from "./hub-agents.js";
import type { AgentRunState, HubBoardItem, HubInboxTask } from "./hub-protocol.js";
import { cleanFilters, inboxMetaOf, leavers, listOrder, modelsOf, nextEntries, NO_FILTERS, nowRows, passes, phaseCounts, phaseOf, runToWorkTask, toWorkTask, workKindOf, workerOf, type WorkSource, type WorkTask } from "./hub-work.js";

const src = (over: Partial<WorkSource> = {}): WorkSource => ({ taskId: "t1", title: "Fix it", status: "waiting", executor: "auto", route: "pc", createdAt: 100, ...over });
const inbox = (over: Partial<NonNullable<WorkSource["inbox"]>> = {}): NonNullable<WorkSource["inbox"]> => ({ from: "claude", executor: "antigravity", deviceId: "pc1", at: 200, ...over });
const wt = (over: Partial<WorkTask> = {}): WorkTask => ({ id: "t1", title: "Fix it", status: "waiting", phase: "active", worker: "antigravity", at: 100, expired: false, ...over });
const item = (over: Partial<HubBoardItem> = {}): HubBoardItem => ({ id: "t1", title: "Board task", status: "open", size: "big", priority: 5, at: 50, ...over });
const card = (over: Partial<AgentRunState> = {}, at = 10_000): AgentCard => ({ deviceId: "pc1", runId: "r1", state: { runId: "r1", title: "Run", source: "antigravity", state: "running", step: 3, of: 8, startedAt: 1000, lastEventAt: at, files: 0, fileNames: [], ...over }, events: [], at, seq: 1 });

test("phases: done and partly done are Done; failed, blocked, stopped and expired are Failed; the rest is Active", () => {
  for (const s of ["done", "partial"]) assert.equal(phaseOf(s), "done");
  for (const s of ["failed", "blocked", "cancelled"]) assert.equal(phaseOf(s), "failed");
  for (const s of ["outbox", "sent", "waiting", "waiting-run", "deferred", "running", "queued"]) assert.equal(phaseOf(s), "active");
  assert.equal(phaseOf("waiting", true), "failed", "an expired task is a failed one");
  assert.deepEqual(phaseCounts([wt(), wt({ phase: "done" }), wt({ phase: "failed" }), wt({ phase: "failed" })]), { active: 1, done: 1, failed: 2 });
});

test("a page task becomes a work task: worker, model, board priority and the failure cause", () => {
  assert.equal(workerOf(src({ executor: "pc-antigravity" })), "antigravity");
  assert.equal(workerOf(src({ route: "claude-cloud" })), "claude");
  assert.equal(workerOf(src({ inbox: inbox({ executor: "gemini" }) })), "gemini");
  const board = new Map([["b1", item({ id: "b1", priority: 2 })]]);
  const w = toWorkTask(src({ inbox: inbox({ boardId: "b1", model: "Gemini 3" }) }), false, board);
  assert.equal(w.priority, 2, "from the board when the report has none");
  assert.equal(toWorkTask(src({ inbox: inbox({ boardId: "b1", priority: 0 }) }), false, board).priority, 0, "the report's own wins");
  assert.equal(w.model, "Gemini 3");
  const failed = toWorkTask(src({ status: "failed", line: "line", inbox: inbox({ cause: "Lint failed" }) }), false);
  assert.equal(failed.phase, "failed");
  assert.equal(failed.cause, "Lint failed");
  assert.equal(toWorkTask(src({ status: "failed", line: "No PC took it" }), false).cause, "No PC took it");
  assert.equal(toWorkTask(src({ status: "done", line: "ok" }), false).cause, undefined);
  assert.equal(toWorkTask(src({ status: "waiting" }), true).phase, "failed");
});

test("the payload mapping keeps the PC's newest fields and drops the ones it stopped sending", () => {
  const r: HubInboxTask = { taskId: "t1", title: "x", state: "running", executor: "local", from: "self-work", at: 5, model: "qwen3", priority: 1, queuePos: 2, kind: "research", startedAt: 3, boardId: "b1" };
  assert.deepEqual(inboxMetaOf(r, "pc1"), { from: "self-work", executor: "local", deviceId: "pc1", at: 5, model: "qwen3", boardId: "b1", priority: 1, queuePos: 2, kind: "research", startedAt: 3 });
  assert.deepEqual(inboxMetaOf({ taskId: "t1", title: "x", state: "waiting", executor: "claude", from: "claude", at: 6 }, "pc1"), { from: "claude", executor: "claude", deviceId: "pc1", at: 6 }, "an older PC");
  assert.equal(inboxMetaOf({ ...r, priority: 0 }, "pc1").priority, 0, "priority 0 is kept");
});

test("kinds: research, conversion (convert, port, migrate, Hebrew) and code", () => {
  assert.equal(workKindOf({ kind: "research", title: "Convert" }), "research");
  assert.equal(workKindOf({ title: "Convert the Unity package" }), "conversion");
  assert.equal(workKindOf({ title: "Add search", goal: "port the old code" }), "conversion");
  assert.equal(workKindOf({ title: "המר את התוסף" }), "conversion");
  assert.equal(workKindOf({ title: "Support the report page" }), "code");
});

test("Next: by board priority, then queue order, then age; deferred last; board items join; Roee's do not", () => {
  const tasks = [
    wt({ id: "a", priority: 3, queuePos: 1, at: 10 }),
    wt({ id: "b", priority: 1, queuePos: 3, at: 20 }),
    wt({ id: "c", queuePos: 2, at: 5 }), // no priority: after those that have one
    wt({ id: "d", priority: 1, queuePos: 2, at: 30 }),
    wt({ id: "e", priority: 0, status: "deferred", worker: "gemini" }),
    wt({ id: "f", status: "running" }),
    wt({ id: "g", status: "done", phase: "done" }),
    wt({ id: "h", status: "waiting-run", priority: 4, boardId: "b9" }),
  ];
  const board = [item({ id: "b9", priority: 4 }), item({ id: "x", priority: 2, forKesher: true }), item({ id: "y", priority: 1, owner: "roee", status: "claimed" }), item({ id: "z", priority: 2, status: "blocked" })];
  const list = nextEntries(tasks, board);
  assert.deepEqual(list.map((e) => e.id), ["d", "b", "x", "a", "h", "c", "e"]);
  assert.equal(list.find((e) => e.id === "x")!.worker, "local", "a handed-over board item goes to self-work");
  assert.equal(list.find((e) => e.id === "x")!.from, "board");
  assert.equal(list.find((e) => e.id === "h")!.needsRun, true);
  assert.equal(list.find((e) => e.id === "e")!.deferred, true);
  assert.equal(list.filter((e) => e.id === "b9").length, 0, "a board item an inbox task stands for is listed once");
});

test("Now: one row per worker, idle ones say free, a live run adds step and model, helpers and board items get rows", () => {
  const now = 20_000;
  const rows = nowRows([wt({ id: "t1", status: "running", title: "Fix it", worker: "antigravity", startedAt: 500, estSteps: 6 })], [card({ model: "Gemini 3" })], [], now, () => "pc1/r1");
  assert.deepEqual(rows.map((r) => [r.worker, r.free]), [["antigravity", false], ["gemini", true], ["opencode", true], ["ghostcli", true], ["local", true]]);
  assert.deepEqual([rows[0]!.step, rows[0]!.of, rows[0]!.model, rows[0]!.since, rows[0]!.runKey], [3, 8, "Gemini 3", 1000, "pc1/r1"]);
  // Without a live run the task's own numbers show; the linked run is not listed twice.
  const plain = nowRows([wt({ status: "running", worker: "gemini", steps: 2, estSteps: 5, startedAt: 700, model: "gemini-flash" })], [], [], now);
  assert.deepEqual(plain.filter((r) => !r.free).map((r) => [r.worker, r.step, r.of, r.model, r.since]), [["gemini", 2, 5, "gemini-flash", 700]]);
  // A helper run (no task), a Claude chat run and a board item taken by self-work.
  const more = nowRows([], [card({ source: "chat-helper", title: "Helper" }), { ...card({ source: "claude-chat", title: "Chat" }), runId: "r2" }, card({ state: "waiting", waiting: { reason: "run-press", requestId: "q", conversationId: "c", summary: "" } })].map((c, n) => ({ ...c, runId: `r${n}` })), [item({ id: "b1", status: "claimed", owner: "kesher", title: "Lint" }), item({ id: "b2", status: "claimed", owner: "roee" })], now);
  assert.deepEqual(more.filter((r) => !r.free).map((r) => [r.worker, r.title]), [["local", "Lint"], ["local", "Helper"], ["claude", "Chat"]], "by worker, then the one working longest first");
  assert.ok(!more.some((r) => r.title === "Run"), "an Antigravity run that only waits for Run is not working");
  assert.ok(!more.some((r) => r.worker === "claude" && r.free), "Claude has no free row");
  // A heartbeat that stopped is flagged, not hidden.
  assert.equal(nowRows([], [card({}, 1000)], [], 1000 + 200_000).find((r) => r.runKey)!.flag, "stale");
});

test("filters: agents (several), one model, one kind; a kind filter hides what has no kind; counts skip their own dimension", () => {
  const a = { worker: "antigravity", model: "Gemini 3", kind: "code" as const };
  const l = { worker: "local", model: "qwen3", kind: "research" as const };
  const run = { worker: "local", model: "qwen3" };
  assert.ok(passes(a, NO_FILTERS) && passes(run, NO_FILTERS));
  assert.ok(passes(a, { ...NO_FILTERS, who: ["antigravity", "gemini"] }));
  assert.ok(!passes(l, { ...NO_FILTERS, who: ["antigravity"] }));
  assert.ok(passes(l, { ...NO_FILTERS, model: "qwen3" }) && !passes(a, { ...NO_FILTERS, model: "qwen3" }));
  assert.ok(!passes(run, { ...NO_FILTERS, kind: "research" }));
  assert.ok(passes(l, { who: ["antigravity"], model: "", kind: "research" }, "who"), "skipping a dimension ignores it");
  assert.deepEqual(modelsOf([a, l, run, {}]), ["Gemini 3", "qwen3"]);
});

test("saved filters are cleaned: odd values are dropped, never trusted", () => {
  assert.deepEqual(cleanFilters(undefined), NO_FILTERS);
  assert.deepEqual(cleanFilters({ who: ["local", "local", "<b>", 5, "claude"], model: "x".repeat(99), kind: "research" }), { who: ["local", "claude"], model: "x".repeat(60), kind: "research" });
  assert.equal(cleanFilters({ kind: "magic" }).kind, "");
  assert.equal(cleanFilters({ who: "local" }).who.length, 0);
});

test("lists: Active is running first, then the Next order; Done and Failed the newest end first", () => {
  const active = [wt({ id: "n2", priority: 2 }), wt({ id: "r", status: "running" }), wt({ id: "n1", priority: 1 }), wt({ id: "d", status: "deferred", priority: 0 })];
  assert.deepEqual(active.sort(listOrder("active")).map((t) => t.id), ["r", "n1", "n2", "d"]);
  const ended = [wt({ id: "old", endedAt: 10 }), wt({ id: "new", endedAt: 30 }), wt({ id: "mid", at: 20 })];
  assert.deepEqual(ended.sort(listOrder("done")).map((t) => t.id), ["new", "mid", "old"]);
});

test("a run becomes a work task with its name, steps and the failure line; the leavers are the ids that went", () => {
  const w = runToWorkTask(card({ name: "Login checker", state: "failed", summary: "Quota", endedAt: 5000 }));
  assert.deepEqual([w.title, w.phase, w.worker, w.cause, w.endedAt], ["Login checker", "failed", "antigravity", "Quota", 5000]);
  assert.deepEqual(leavers(new Set(["a", "b", "c"]), new Set(["b", "d"])), ["a", "c"]);
});
