import { test } from "node:test";
import assert from "node:assert/strict";
import { CLAUDE_STATUS_MAX, CLAUDE_STUCK_MS, isMaybeStuck, minutesSince, parseClaudeStatus, runningAgents } from "./claude-status.js";

const T0 = Date.UTC(2026, 10, 28, 10, 0);
const agent = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `T ${id}`, model: "opus", startedAt: T0, state: "running", ...extra });

test("status file: bad JSON or the wrong shape is unusable, a good file is read", () => {
  assert.equal(parseClaudeStatus("{not json"), undefined);
  assert.equal(parseClaudeStatus("[]"), undefined);
  assert.equal(parseClaudeStatus('{"agents":"x"}'), undefined);
  const f = parseClaudeStatus(JSON.stringify({ updatedAt: T0, agents: [agent("a1", { lastNote: " tests \n passing " })] }))!;
  assert.equal(f.agents.length, 1);
  assert.equal(f.agents[0]!.lastNote, "tests passing");
  assert.equal(f.updatedAt, T0);
});

test("status file: more than 10 entries are cut, unknown states, bad ids and bad times are dropped", () => {
  const many = Array.from({ length: 14 }, (_, i) => agent(`a${i}`));
  assert.equal(parseClaudeStatus(JSON.stringify({ agents: many }))!.agents.length, CLAUDE_STATUS_MAX);
  const f = parseClaudeStatus(JSON.stringify({ agents: [agent("ok"), agent("x", { state: "paused" }), agent("bad id!"), agent("../up"), agent("nostart", { startedAt: "now" }), null, 5] }))!;
  assert.deepEqual(f.agents.map((a) => a.id), ["ok"]);
});

test("status file: long text is cut and an empty title falls back to the id", () => {
  const f = parseClaudeStatus(JSON.stringify({ agents: [agent("a", { title: "", model: "m".repeat(99), lastNote: "n".repeat(500) })] }))!;
  assert.equal(f.agents[0]!.title, "a");
  assert.equal(f.agents[0]!.model.length, 40);
  assert.equal(f.agents[0]!.lastNote!.length, 200);
});

test("maybe stuck: only a running entry, only after 45 minutes without an update (fake clock)", () => {
  const a = parseClaudeStatus(JSON.stringify({ agents: [agent("a")] }))!.agents[0]!;
  assert.equal(isMaybeStuck(a, T0 + CLAUDE_STUCK_MS), false);
  assert.equal(isMaybeStuck(a, T0 + CLAUDE_STUCK_MS + 1), true);
  assert.equal(isMaybeStuck({ ...a, updatedAt: T0 + 40 * 60_000 }, T0 + 80 * 60_000), false, "a fresh update resets the clock");
  assert.equal(isMaybeStuck({ ...a, state: "done" }, T0 + 10 * CLAUDE_STUCK_MS), false);
});

test("running list and minutes", () => {
  const f = parseClaudeStatus(JSON.stringify({ agents: [agent("b", { startedAt: T0 + 5 }), agent("a"), agent("c", { state: "done" })] }))!;
  assert.deepEqual(runningAgents(f).map((a) => a.id), ["a", "b"]);
  assert.deepEqual(runningAgents(undefined), []);
  assert.equal(minutesSince(T0, T0 + 12 * 60_000 + 59_000), 12);
  assert.equal(minutesSince(T0, T0 - 5), 0);
});
