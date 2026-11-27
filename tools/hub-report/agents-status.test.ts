import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaudeStatus, CLAUDE_STATUS_FILE } from "../../packages/shared/src/claude-status.js";
import { applyUpdate, FILE, parseArgs, readAgents } from "./agents-status.mjs";

const T0 = Date.UTC(2026, 10, 28, 10, 0);

test("set starts a running entry, a second set keeps its start and refreshes the update time", () => {
  const a = applyUpdate([], { cmd: "set", id: "r1", title: "Research X", model: "opus" }, T0);
  assert.deepEqual(a.agents[0], { id: "r1", title: "Research X", model: "opus", startedAt: T0, state: "running", updatedAt: T0 });
  const b = applyUpdate(a.agents, { cmd: "set", id: "r1", note: "half way" }, T0 + 600_000);
  assert.equal(b.agents.length, 1);
  assert.equal(b.agents[0]!.startedAt, T0);
  assert.equal(b.agents[0]!.title, "Research X");
  assert.equal(b.agents[0]!.updatedAt, T0 + 600_000);
  assert.equal(b.agents[0]!.lastNote, "half way");
});

test("done and fail end the entry and keep its title; a restart of a finished id is a new run", () => {
  const a = applyUpdate([], { cmd: "set", id: "r1", title: "T", model: "m" }, T0);
  const d = applyUpdate(a.agents, { cmd: "done", id: "r1" }, T0 + 1000);
  assert.equal(d.agents[0]!.state, "done");
  assert.equal(d.agents[0]!.title, "T");
  assert.equal(applyUpdate(a.agents, { cmd: "fail", id: "r1", note: "tsc" }, T0 + 1000).agents[0]!.state, "failed");
  assert.equal(applyUpdate(d.agents, { cmd: "set", id: "r1" }, T0 + 5000).agents[0]!.startedAt, T0 + 5000);
  assert.equal(applyUpdate([], { cmd: "done", id: "zz" }, T0).agents[0]!.title, "zz");
});

test("at most 10 entries: finished ones go first, old finished ones go after a day", () => {
  let list: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 10; i++) list = applyUpdate(list, { cmd: "set", id: `a${i}` }, T0 + i).agents;
  list = applyUpdate(list, { cmd: "done", id: "a3" }, T0 + 100).agents;
  list = applyUpdate(list, { cmd: "set", id: "new" }, T0 + 200).agents;
  assert.equal(list.length, 10);
  assert.ok(!list.some((a) => a.id === "a3"), "the finished one was dropped");
  assert.ok(list.some((a) => a.id === "new"));
  const later = applyUpdate(applyUpdate([], { cmd: "done", id: "old" }, T0).agents, { cmd: "set", id: "x" }, T0 + 25 * 3_600_000);
  assert.deepEqual(later.agents.map((a) => a.id), ["x"]);
});

test("input checks: id, text cut, bad existing file starts afresh, arguments", () => {
  assert.throws(() => applyUpdate([], { cmd: "set", id: "bad id" }, T0));
  assert.equal(applyUpdate([], { cmd: "set", id: "a", title: "x".repeat(300) }, T0).agents[0]!.title!.toString().length, 120);
  assert.deepEqual(readAgents("{oops"), []);
  assert.deepEqual(readAgents(undefined), []);
  assert.deepEqual(parseArgs(["set", "a1", "My title", "opus", "--note", "n"]), { cmd: "set", id: "a1", title: "My title", model: "opus", note: "n" });
  assert.throws(() => parseArgs(["go", "a1"]));
  assert.throws(() => parseArgs(["set"]));
});

test("the script's output passes the reader's validation and both name the same file", () => {
  const f = applyUpdate(applyUpdate([], { cmd: "set", id: "a", title: "T", model: "m" }, T0).agents, { cmd: "done", id: "b" }, T0 + 5);
  const parsed = parseClaudeStatus(JSON.stringify(f))!;
  assert.equal(parsed.agents.length, 2);
  assert.equal(FILE, CLAUDE_STATUS_FILE);
});
