import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "@kesher/shared";
import { parseCoachJson, requestStats } from "./coach.js";

const ev = (e: Record<string, unknown>, seq: number) => ({ seq, at: "2026-11-07T10:00:00Z", ...e }) as AgentEvent;

test("measures each request and charges failed steps and rework as waste", () => {
  const events = [
    { type: "user", text: "build me a calculator" },
    { type: "usage", modelId: "m", role: "main", input: 1000, output: 100, estimated: false, tools: ["run_command"] },
    { type: "tool_result", callId: "1", name: "run_command", ok: false, output: "boom" },
    { type: "usage", modelId: "m", role: "main", input: 1200, output: 50, estimated: false, tools: [] },
    { type: "teammate", role: "reviewer", modelId: "r", text: "no exe", approved: false },
    { type: "usage", modelId: "r", role: "reviewer", input: 300, output: 20, estimated: true, tools: [] },
    { type: "usage", modelId: "m", role: "main", input: 1500, output: 80, estimated: false, tools: [] },
    { type: "user", text: "thanks" },
    { type: "usage", modelId: "m", role: "main", input: 100, output: 10, estimated: false, tools: [] },
  ].map(ev);
  const [a, b] = requestStats(events);
  assert.equal(a!.calls, 4);
  assert.equal(a!.failedSteps, 1);
  assert.equal(a!.reworks, 1);
  // rework: 1100 + 1250 before the rejection; the failed call (1100) is not counted twice
  assert.equal(a!.wastedTokens, 2350);
  assert.equal(a!.estimated, true);
  assert.equal(b!.inputTokens + b!.outputTokens, 110);
});

test("reads the coach's JSON even inside prose", () => {
  const r = parseCoachJson('Sure!\n```json\n{"suggestions":[{"kind":"mcp","title":"GitHub MCP","why":"you push often"},{"title":"x"}],"learned":["writes in Hebrew"]}\n```');
  assert.equal(r.suggestions.length, 1);
  assert.equal(r.suggestions[0]!.kind, "mcp");
  assert.deepEqual(r.learned, ["writes in Hebrew"]);
  assert.deepEqual(parseCoachJson("no json"), { suggestions: [], learned: [] });
});

test("sub-agents' saved runs add up apart from the chat's model, by role and by model", async () => {
  const { helperUsage } = await import("./coach.js");
  const events = [
    { type: "user", text: "look it up" },
    { type: "usage", modelId: "m", role: "main", input: 1000, output: 100, estimated: false, tools: [] },
    { type: "helper_usage", runId: "h-1", kind: "research", model: "Qwen3-4B", state: "done", input: 3000, output: 300, cached: 1000, calls: 2, estimated: false },
    { type: "helper_usage", runId: "h-2", kind: "build", agent: "tester", model: "Qwen3-14B", state: "failed", input: 500, output: 50, cached: 0, calls: 1, estimated: true },
    { type: "helper_usage", runId: "h-3", kind: "external", model: "Antigravity", state: "done", input: 0, output: 0, cached: 0, calls: 0, estimated: false },
  ].map((e, i) => ev(e, i + 1));
  const h = helperUsage(events);
  assert.equal(h.runs, 2);
  assert.equal(h.inputTokens, 3500);
  assert.equal(h.cachedTokens, 1000);
  assert.equal(h.estimated, true);
  assert.deepEqual(h.byRole, { research: { runs: 1, tokens: 3300 }, tester: { runs: 1, tokens: 550 } });
  assert.deepEqual(h.byModel, { "Qwen3-4B": 3300, "Qwen3-14B": 550 });
  // The chat's own requests do not count the helpers.
  assert.equal(requestStats(events).reduce((n, r) => n + r.inputTokens, 0), 1000);
});
