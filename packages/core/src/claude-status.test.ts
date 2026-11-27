import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeStatusReader } from "./claude-status.js";
import type { GitRun } from "./external-agents.js";

const FILE = JSON.stringify({ updatedAt: 5, agents: [{ id: "a", title: "T", model: "opus", startedAt: 1000, state: "running" }] });

test("status reader: one show per blob sha; a new sha reads again", async () => {
  const calls: string[] = [];
  let sha = "a".repeat(40);
  const git: GitRun = async (a) => {
    calls.push(a[0]!);
    return a[0] === "rev-parse" ? `${sha}\n` : FILE;
  };
  const r = new ClaudeStatusReader(() => git);
  assert.equal((await r.read()).agents[0]!.id, "a");
  await r.read();
  assert.equal(calls.filter((c) => c === "show").length, 1);
  sha = "b".repeat(40);
  await r.read();
  assert.equal(calls.filter((c) => c === "show").length, 2);
});

test("status reader: no project, no branch, bad JSON or a git failure give an empty list", async () => {
  assert.deepEqual((await new ClaudeStatusReader(() => undefined).read()).agents, []);
  assert.deepEqual((await new ClaudeStatusReader(() => async () => "").read()).agents, [], "rev-parse printed nothing");
  assert.deepEqual((await new ClaudeStatusReader(() => async (a) => (a[0] === "rev-parse" ? "c".repeat(40) : "{oops")).read()).agents, []);
  assert.deepEqual((await new ClaudeStatusReader(() => async () => { throw new Error("no git"); }).read()).agents, []);
});
