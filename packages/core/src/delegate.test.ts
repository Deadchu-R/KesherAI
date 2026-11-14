import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentTool, ModelTurn } from "@kesher/agent";
import { delegateTool, helperTools } from "./delegate.js";

const tool = (
  name: string,
  risk: AgentTool["risk"],
  out = "ok",
): AgentTool => ({
  risk,
  spec: {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
  },
  run: async () => ({ output: out }),
});

test("helpers get only read-only tools", () => {
  const names = helperTools([
    tool("read_file", "read"),
    tool("write_file", "write"),
    tool("run_command", "exec"),
    tool("computer_screenshot", "read"),
    tool("delegate", "safe"),
    tool("search", "read"),
  ]).map((t) => t.spec.name);
  assert.deepEqual(names, ["read_file", "search"]);
});

test("delegate runs the parts at the same time, each with its model, and reports", async () => {
  let running = 0;
  let most = 0;
  const seen: string[] = [];
  const turn =
    (label: string): ModelTurn =>
    async (req) => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 30));
      running--;
      const last = req.messages.at(-1);
      if (last?.role === "user") {
        seen.push(`${label}:${req.tools.map((t) => t.name).join(",")}`);
        return {
          text: "",
          toolCalls: [{ id: "1", name: "read_file", arguments: {} }],
        };
      }
      return { text: `${label} found it in src/a.ts`, toolCalls: [] };
    };
  const d = delegateTool({
    tools: () => [
      tool("read_file", "read", "file text"),
      tool("write_file", "write"),
    ],
    currentModel: () => "big",
    turnFor: (m) => {
      if (m !== "big" && m !== "small") throw new Error("unknown");
      return turn(m);
    },
    models: () => ["big", "small"],
  });
  const r = await d.run(
    {
      parts: [
        { task: "find A", model: "small" },
        { task: "find B" },
        { task: "find C", model: "nope" },
      ],
    },
    { signal: new AbortController().signal, recordChange: () => undefined },
  );
  assert.match(r.output, /Part 1 — small\nsmall found it/);
  assert.match(r.output, /Part 2 — big\nbig found it/);
  assert.match(r.output, /Part 3 — big \(asked for nope, not available\)/);
  assert.ok(most >= 2, "parts ran at the same time");
  assert.ok(
    seen.every((s) => !s.includes("write_file")),
    "no changing tools",
  );
});

test("a named agent brings its instructions, model and tools", async () => {
  const seen: Array<{ system: string; tools: string[] }> = [];
  const turn: ModelTurn = async (req) => {
    if (req.messages.at(-1)?.role === "user") seen.push({ system: String(req.messages[0]?.content ?? ""), tools: req.tools.map((t) => t.name) });
    return { text: "done", toolCalls: [] };
  };
  const d = delegateTool({
    tools: () => [tool("read_file", "read"), tool("search", "read")],
    currentModel: () => "big",
    turnFor: () => turn,
    models: () => ["big", "small"],
    agents: () => [{ name: "Perf", description: "Unity performance reviews", instructions: "Look for per-frame allocations.", model: "small", tools: ["search"], source: "persona" }],
  });
  assert.match(d.spec.description, /- Perf: Unity performance reviews/);
  const r = await d.run({ parts: [{ task: "check Player.cs", agent: "perf" }] }, { signal: new AbortController().signal, recordChange: () => undefined });
  assert.match(r.output, /Part 1 — agent Perf — small/);
  assert.match(seen[0]!.system, /agent "Perf"[\s\S]*per-frame allocations/);
  assert.deepEqual(seen[0]!.tools.filter((t) => t !== "ask_user" && t !== "request_access"), ["search"]);
});
