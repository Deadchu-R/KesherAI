import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConnectorAnswer, ConnectorQuery } from "@kesher/shared";
import { connectorTools } from "./mcp-connector-tools.js";

const signal = new AbortController().signal;

/** A desk that records what it was asked and answers with `reply`. */
function fake(reply: (q: ConnectorQuery) => Omit<ConnectorAnswer, "queryId" | "at">) {
  const asked: ConnectorQuery[] = [];
  return { asked, tools: connectorTools(async (q) => (asked.push(q), { queryId: q.queryId, at: 1, ...reply(q) })) };
}
const tool = (tools: ReturnType<typeof connectorTools>, name: string) => tools.find((t) => t.name === name)!;

test("local connector tools: the hub's names, task tools only, read-only ones marked", () => {
  const { tools } = fake(() => ({ ok: true }));
  assert.deepEqual(tools.map((t) => t.name), ["kesher_tasks", "kesher_task", "kesher_add_task", "kesher_task_action", "kesher_quotas", "kesher_agents"]);
  assert.ok(!tools.some((t) => /approve|settings|file/.test(t.name)), "no approvals, settings or files from here");
  assert.deepEqual(tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name), ["kesher_tasks", "kesher_task", "kesher_quotas", "kesher_agents"]);
});

test("local connector tools: a call becomes a checked query for the desk, and the answer becomes the hub's text", async () => {
  const { tools, asked } = fake((q) => (q.op === "tasks" ? { ok: true, tasks: [{ taskId: "r-1", title: "Fix", state: "waiting-run", executor: "antigravity", queuePos: 1 }] } : { ok: true, text: "Started on the PC." }));
  const list = await tool(tools, "kesher_tasks").run({ filter: "open" }, signal);
  assert.equal(list[0]!.text, "r-1 [waiting-run] Fix (antigravity, #1 in line)");
  assert.deepEqual({ op: asked[0]!.op, filter: asked[0]!.filter }, { op: "tasks", filter: "open" });
  assert.ok(asked[0]!.at && /^[\w-]{1,64}$/.test(asked[0]!.queryId), "a fresh id and time");
  assert.equal((await tool(tools, "kesher_task_action").run({ taskId: "r-1", action: "run" }, signal))[0]!.text, "Started on the PC.");
});

test("local connector tools: a request outside the allow-list never reaches the desk; a refusal is an error in words", async () => {
  const { tools, asked } = fake(() => ({ ok: false, text: "This PC does not let the Claude connector in (on the PC: Settings › Kesher Cloud › Claude connector may read and run)." }));
  await assert.rejects(() => tool(tools, "kesher_task_action").run({ taskId: "r-1", action: "approve" }, signal), /not allowed/);
  await assert.rejects(() => tool(tools, "kesher_task").run({ taskId: "../etc" }, signal), /not allowed/);
  assert.equal(asked.length, 0);
  await assert.rejects(() => tool(tools, "kesher_quotas").run({}, signal), /Claude connector may read and run/);
  await assert.rejects(() => connectorTools(undefined).find((t) => t.name === "kesher_agents")!.run({}, signal), /not available yet/);
});
