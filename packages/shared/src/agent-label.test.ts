import { test } from "node:test";
import assert from "node:assert/strict";
import { agentDoing, cleanAgentLabel, sameLabel, stepTool } from "./agent-label.js";
import { parseSealedBody, type AgentRunState } from "./hub-protocol.js";
import { agentName, applyAgentBatch, type AgentCard } from "./hub-agents.js";

test("a label is cleaned: one-line name, cut, controls and direction overrides removed, empty fields left out", () => {
  assert.deepEqual(cleanAgentLabel({ name: "  Login\n bug‮ ", note: "line 1\r\n\n\n\nline 2\u0007" }, 5), { name: "Login bug", note: "line 1\n\nline 2", at: 5 });
  assert.equal(cleanAgentLabel({ name: "x".repeat(200) }).name!.length, 80);
  assert.equal(cleanAgentLabel({ note: "y".repeat(900) }).note!.length, 500);
  assert.deepEqual(cleanAgentLabel({ name: "   ", note: 7 }), {});
  assert.deepEqual(cleanAgentLabel(null), {});
  assert.ok(sameLabel({ name: "a" }, { name: "a", at: 9 }));
  assert.ok(!sameLabel({ name: "a" }, { name: "a", note: "n" }));
});

test("doing now: from the state and the latest tool, with a short file path; none once ended", () => {
  assert.deepEqual(agentDoing({ state: "running", tool: "edit_file", target: "apps/web/src/ui/App.tsx" }), { he: "עורך …/ui/App.tsx", en: "Editing …/ui/App.tsx" });
  assert.equal(agentDoing({ state: "running", tool: "run_tests" })!.en, "Running tests");
  assert.equal(agentDoing({ state: "running" })!.en, "Thinking…");
  assert.equal(agentDoing({ state: "running", tool: "my_tool" })!.en, "Using my_tool");
  assert.equal(agentDoing({ state: "queued" })!.en, "Waiting in the queue");
  assert.equal(agentDoing({ state: "asking" })!.en, "Waiting for you");
  assert.equal(agentDoing({ state: "done", tool: "edit_file" }), undefined);
  assert.deepEqual(stepTool("read_file: src/a.ts"), { tool: "read_file", target: "src/a.ts" });
  assert.deepEqual(stepTool("run_command: rm -rf /"), { tool: "run_command" }, "a command's text is never a target");
  assert.deepEqual(stepTool("note(user): hi there"), {});
});

const state = (over: Partial<AgentRunState> = {}): AgentRunState => ({ runId: "h-1", title: "Look into the login bug", source: "chat-helper", state: "running", step: 1, startedAt: 1, lastEventAt: 10, files: 0, fileNames: [], ...over });

test("the protocol carries a run's name and note, and the agent-label command (cleaned)", () => {
  const b = parseSealedBody({ type: "agent_event", runId: "h-1", state: { ...state(), name: " Login\n", note: "mine", labelAt: 20 }, events: [] }, "agent_event");
  assert.ok(b && b.type === "agent_event");
  assert.equal(b.state.name, "Login");
  assert.equal(b.state.note, "mine");
  assert.equal(b.state.labelAt, 20);
  const c = parseSealedBody({ type: "command", commandId: "c1", action: "agent-label", taskId: "h-1", label: { name: "N‮", note: "x".repeat(900) } }, "command");
  assert.ok(c && c.type === "command");
  assert.equal(c.action, "agent-label");
  assert.equal(c.label?.name, "N");
  assert.equal(c.label?.note?.length, 500);
  assert.equal(parseSealedBody({ type: "command", commandId: "c1", action: "agent-bad", taskId: "h-1" }, "command"), null);
});

test("a viewer keeps the newest label even when the newest state is older, and clears a cleared one", () => {
  const cards = new Map<string, AgentCard>();
  applyAgentBatch(cards, "pc", { type: "agent_event", runId: "h-1", state: state({ lastEventAt: 50 }), events: [] }, 1, 1);
  // The relabel batch of an ended run carries an older event time, but a newer label.
  let c = applyAgentBatch(cards, "pc", { type: "agent_event", runId: "h-1", state: state({ lastEventAt: 40, name: "Login", note: "n", labelAt: 100 }), events: [] }, 2, 2);
  assert.equal(c.state.name, "Login");
  assert.equal(c.state.lastEventAt, 50);
  assert.deepEqual(agentName(c.state), { name: "Login", title: "Look into the login bug" });
  c = applyAgentBatch(cards, "pc", { type: "agent_event", runId: "h-1", state: state({ lastEventAt: 60, labelAt: 200 }), events: [] }, 3, 3);
  assert.equal(c.state.name, undefined);
  assert.equal(c.state.note, undefined);
  assert.deepEqual(agentName(c.state), { name: "Look into the login bug" });
});

test("the assign command and its answer cross the protocol; an unknown target is refused", async () => {
  const { helperHandoff, parseAssignTo } = await import("./task-assign.js");
  const c = parseSealedBody({ type: "command", commandId: "c1", action: "assign", taskId: "r-1", to: "helper:build", confirm: true }, "command");
  assert.ok(c && c.type === "command");
  assert.equal(c.to, "helper:build");
  assert.equal(c.confirm, true);
  assert.equal(parseSealedBody({ type: "command", commandId: "c1", action: "assign", taskId: "r-1", to: "root" }, "command"), null);
  const r = parseSealedBody({ type: "command_result", commandId: "c1", taskId: "r-1", ok: false, text: "x", ask: "running" }, "command_result");
  assert.ok(r && r.type === "command_result" && r.ask === "running");
  assert.equal(parseAssignTo("helper:operate"), undefined);
  assert.ok(!helperHandoff("build", "t", "a ``` b").includes("a ``` b"), "the task's text cannot close the quote");
});
