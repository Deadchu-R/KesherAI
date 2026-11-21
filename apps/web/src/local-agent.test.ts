import { test } from "node:test";
import assert from "node:assert/strict";
import { localAgentState, restartBody, type LocalAgentRun } from "./local-agent.js";

const run = (status: LocalAgentRun["status"]): LocalAgentRun => ({ repo: "/home/x/proj", goal: "tasks", check: "pnpm -s test", status });

test("local agent: on while it runs or waits, off otherwise", () => {
  assert.equal(localAgentState(run("running")), "on");
  assert.equal(localAgentState(run("waiting")), "on");
  for (const s of ["done", "blocked", "stopped", "failed"] as const) assert.equal(localAgentState(run(s)), "off-restart");
});

test("local agent: no earlier run means the user sets it up on the Self-work page", () => {
  assert.equal(localAgentState(null), "off-setup");
  assert.equal(localAgentState(undefined), "off-setup");
  assert.equal(localAgentState({ ...run("stopped"), repo: "" }), "off-setup");
});

test("local agent: start again reuses the last project, goal and check", () => {
  assert.deepEqual(restartBody(run("stopped")), { repo: "/home/x/proj", goal: "tasks", check: "pnpm -s test", hours: 2 });
  assert.equal(restartBody(run("stopped"), 4).hours, 4);
});
