import { test } from "node:test";
import assert from "node:assert/strict";
import { clock, shortDuration, speedText, turnSpeed, turnStatus, turnSummary } from "./turn-status";

const base = [
  { type: "user", seq: 1, at: "2026-11-21T10:00:00Z" },
  { type: "assistant", seq: 2 },
  { type: "user", seq: 3, at: "2026-11-21T10:05:00Z" },
];

test("a tool call without its result is running; the turn starts at the last user message", () => {
  const ev = [...base, { type: "tool_call", callId: "a", name: "read_file" }, { type: "tool_result", callId: "a" }, { type: "tool_call", callId: "b", name: "run_command" }];
  assert.deepEqual(turnStatus(ev, {}, false), { kind: "tool", tool: "run_command", step: 2, since: "2026-11-21T10:05:00Z" });
});

test("a pending approval names its tool, before anything else", () => {
  const ev = [...base, { type: "tool_call", callId: "b", name: "write_file" }, { type: "approval_request", requestId: "r1", name: "write_file" }];
  assert.equal(turnStatus(ev, { pendingApprovals: ["r1"] }, false).kind, "approval");
  assert.equal(turnStatus(ev, { pendingApprovals: ["r1"] }, false).tool, "write_file");
});

test("a steered message does not restart the turn; no tool running: writing or thinking", () => {
  const ev = [...base, { type: "user", seq: 4, at: "2026-11-21T10:06:00Z", steered: true }];
  assert.deepEqual(turnStatus(ev, {}, true), { kind: "writing", step: 0, since: "2026-11-21T10:05:00Z" });
  assert.equal(turnStatus(ev, { pendingQuestions: ["q"] }, false).kind, "question");
  assert.equal(turnStatus(base, {}, false).kind, "thinking");
});

test("shortDuration", () => {
  assert.equal(shortDuration(8_400), "8s");
  assert.equal(shortDuration(65_000), "1m 05s");
  assert.equal(shortDuration(3_720_000), "1h 02m");
});

test("clock and speedText", () => {
  assert.equal(clock(42_900), "0:42");
  assert.equal(clock(725_000), "12:05");
  assert.equal(clock(3_729_000), "1:02:09");
  assert.equal(clock(-5), "0:00");
  assert.equal(speedText(38.4), "38 tok/s");
  assert.equal(speedText(7.26), "7.3 tok/s");
});

test("step counts the tool calls of this turn only; speed comes from the main model's usage", () => {
  const ev = [
    ...base,
    { type: "usage", role: "main", output: 100, writeMs: 2000 },
    { type: "usage", role: "helper", output: 900, writeMs: 1000 },
    { type: "tool_call", callId: "a", name: "make_music" },
    { type: "usage", role: "main", output: 50, writeMs: 1000 },
  ];
  const s = turnStatus(ev, {}, false);
  assert.equal(s.step, 1);
  assert.equal(s.tps, 50);
  assert.equal(turnSpeed(ev.slice(3)), 50);
  assert.equal(turnSpeed([{ type: "usage", role: "main", output: 5, writeMs: 50 }]), undefined);
});

test("turnSummary: duration to the last event, only for an answered turn", () => {
  const ev = [
    { type: "user", seq: 1, at: "2026-11-21T10:00:00Z" },
    { type: "tool_call", callId: "a", name: "x", at: "2026-11-21T10:00:10Z" },
    { type: "usage", role: "main", output: 380, writeMs: 10_000, at: "2026-11-21T10:00:20Z" },
    { type: "assistant", at: "2026-11-21T10:00:42Z" },
  ];
  assert.deepEqual(turnSummary(ev), { ms: 42_000, tps: 38, steps: 1 });
  assert.equal(turnSummary(ev.slice(0, 2)), undefined);
  assert.equal(turnSummary([]), undefined);
});
