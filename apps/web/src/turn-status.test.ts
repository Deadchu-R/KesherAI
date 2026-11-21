import { test } from "node:test";
import assert from "node:assert/strict";
import { shortDuration, turnStatus } from "./turn-status";

const base = [
  { type: "user", seq: 1, at: "2026-11-21T10:00:00Z" },
  { type: "assistant", seq: 2 },
  { type: "user", seq: 3, at: "2026-11-21T10:05:00Z" },
];

test("a tool call without its result is running; the turn starts at the last user message", () => {
  const ev = [...base, { type: "tool_call", callId: "a", name: "read_file" }, { type: "tool_result", callId: "a" }, { type: "tool_call", callId: "b", name: "run_command" }];
  assert.deepEqual(turnStatus(ev, {}, false), { kind: "tool", tool: "run_command", since: "2026-11-21T10:05:00Z" });
});

test("a pending approval names its tool, before anything else", () => {
  const ev = [...base, { type: "tool_call", callId: "b", name: "write_file" }, { type: "approval_request", requestId: "r1", name: "write_file" }];
  assert.equal(turnStatus(ev, { pendingApprovals: ["r1"] }, false).kind, "approval");
  assert.equal(turnStatus(ev, { pendingApprovals: ["r1"] }, false).tool, "write_file");
});

test("a steered message does not restart the turn; no tool running: writing or thinking", () => {
  const ev = [...base, { type: "user", seq: 4, at: "2026-11-21T10:06:00Z", steered: true }];
  assert.deepEqual(turnStatus(ev, {}, true), { kind: "writing", since: "2026-11-21T10:05:00Z" });
  assert.equal(turnStatus(ev, { pendingQuestions: ["q"] }, false).kind, "question");
  assert.equal(turnStatus(base, {}, false).kind, "thinking");
});

test("shortDuration", () => {
  assert.equal(shortDuration(8_400), "8s");
  assert.equal(shortDuration(65_000), "1m 05s");
  assert.equal(shortDuration(3_720_000), "1h 02m");
});
