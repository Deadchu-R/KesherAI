import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentTool, ModelTurn } from "@kesher/agent";
import { delegateTool, helperTools, roleTools, type HelperApproval } from "./delegate.js";

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
  assert.match(r.output, /Part 1 — research — small \(id h-\w+\)\nsmall found it/);
  assert.match(r.output, /Part 2 — research — big \(id h-\w+\)\nbig found it/);
  assert.match(r.output, /Part 3 — research — big \(asked for nope, not available\)/);
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

test("a worker agent edits in its own copy and its changes come back as a diff", async () => {
  const wrote: string[] = [];
  let finished = false;
  const write: AgentTool = { risk: "write", spec: { name: "write_file", description: "w", inputSchema: { type: "object", properties: {} } }, run: async (_i, ctx) => { wrote.push(ctx.workspace ?? ""); return { output: "written" }; } };
  let step = 0;
  const turn: ModelTurn = async () => (step++ === 0 ? { text: "", toolCalls: [{ id: "1", name: "write_file", arguments: { path: "a.ts", content: "x" } }] } : { text: "done", toolCalls: [] });
  const base = { tools: () => [tool("read_file", "read"), write], currentModel: () => "m", turnFor: () => turn, models: () => [], agents: () => [{ name: "Fixer", description: "fixes", instructions: "fix", write: true, source: "persona" as const }] };
  const none = delegateTool(base);
  const r0 = await none.run({ parts: [{ task: "fix", agent: "Fixer" }] }, { signal: new AbortController().signal, recordChange: () => undefined });
  assert.match(r0.output, /only in a code chat whose folder is a git project/);
  const d = delegateTool({ ...base, worktree: () => ({ make: async () => ({ path: "/copy", finish: async () => { finished = true; return "+x"; } }) }) });
  const r = await d.run({ parts: [{ task: "fix a.ts", agent: "Fixer" }] }, { signal: new AbortController().signal, recordChange: () => undefined });
  assert.deepEqual(wrote, ["/copy"], "it wrote in its copy, without asking");
  assert.ok(finished);
  assert.match(r.output, /agent Fixer[\s\S]*Its changes[\s\S]*```diff\n\+x/);
});

test("background part: delegate answers at once, helper_wait brings the report; the session gets reports it was not given", async () => {
  const { HelperRuns } = await import("./helper-runs.js");
  const { helperToolsFor } = await import("./delegate.js");
  const runs = new HelperRuns({ limit: () => 2 });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const turn: ModelTurn = async () => {
    await gate;
    return { text: "it is in src/x.ts", toolCalls: [] };
  };
  const [d, result, wait] = helperToolsFor({ tools: () => [tool("read_file", "read")], currentModel: () => "m", turnFor: () => turn, models: () => [], runs, chatId: "c" });
  const ctx = { signal: new AbortController().signal, recordChange: () => undefined, callId: "call-1" };
  const r = await d!.run({ parts: [{ task: "find x", type: "lookup", background: true }] }, ctx);
  const id = /id (h-\w+)/.exec(r.output)?.[1];
  assert.ok(id);
  assert.match(r.output, /Started in the background/);
  assert.equal(runs.get(id!)!.callId, "call-1", "the card belongs to the delegate call");
  assert.match((await result!.run({ id }, ctx)).output, /Still running/);
  release();
  assert.match((await wait!.run({ ids: [id] }, ctx)).output, /lookup — m \(id h-\w+\)\nit is in src\/x\.ts/);
  assert.equal(runs.pending(id!), false);
});

test("stop: the chat's Stop stops the parts delegate waits for, and helper_stop stops one", async () => {
  const { HelperRuns } = await import("./helper-runs.js");
  const { helperToolsFor } = await import("./delegate.js");
  const runs = new HelperRuns({ limit: () => 2 });
  const turn: ModelTurn = (_req, signal) => new Promise((_, no) => signal.addEventListener("abort", () => no(new Error("aborted"))));
  const [d, , , stop] = helperToolsFor({ tools: () => [], currentModel: () => "m", turnFor: () => turn, models: () => [], runs, chatId: "c" });
  const ac = new AbortController();
  const p = d!.run({ parts: [{ task: "a" }, { task: "b", background: true }] }, { signal: ac.signal, recordChange: () => undefined });
  await new Promise((r) => setTimeout(r, 10));
  const bg = runs.list("c").find((x) => x.background)!;
  assert.match((await stop!.run({ id: bg.id }, { signal: ac.signal, recordChange: () => undefined })).output, /Stopped/);
  ac.abort();
  const out = await p;
  assert.match(out.output, /Stopped by the user/);
  assert.deepEqual(runs.list("c").map((x) => x.state), ["stopped", "stopped"]);
});

test("the model per part: modelFor's swap is prepared before the first step and released after", async () => {
  const order: string[] = [];
  const turn: ModelTurn = async () => {
    order.push("turn");
    return { text: "built", toolCalls: [] };
  };
  const d = delegateTool({
    tools: () => [],
    currentModel: () => "lead",
    turnFor: (m) => {
      order.push(`model ${m}`);
      return turn;
    },
    models: () => [],
    worktree: () => ({ make: async () => ({ path: "/copy", finish: async () => "+y" }) }),
    modelFor: ({ kind }) => ({
      modelId: "pending",
      label: "Coder",
      local: true,
      prepare: async (ctl) => {
        assert.equal(kind, "build");
        ctl.update({ swap: { from: "lead", to: "Coder", phase: "running" } });
        order.push("swap in");
        return "llamacpp/Coder";
      },
      release: async () => void order.push("swap back"),
    }),
  });
  const r = await d.run({ parts: [{ task: "fix it", type: "build" }] }, { signal: new AbortController().signal, recordChange: () => undefined });
  assert.deepEqual(order, ["swap in", "model llamacpp/Coder", "turn", "swap back"]);
  assert.match(r.output, /build — Coder[\s\S]*```diff\n\+y/);
});

test("a build part outside a git project is not run", async () => {
  const d = delegateTool({ tools: () => [], currentModel: () => "m", turnFor: () => async () => ({ text: "", toolCalls: [] }), models: () => [] });
  const r = await d.run({ parts: [{ task: "change it", type: "build" }] }, { signal: new AbortController().signal, recordChange: () => undefined });
  assert.match(r.output, /git project/);
});

test("a cloud helper asks once before reading the project; no means the web only", async () => {
  const { HelperRuns } = await import("./helper-runs.js");
  const runs = new HelperRuns({ limit: () => 2 });
  let answer: boolean | undefined;
  const seen: string[][] = [];
  const turn: ModelTurn = async (req) => {
    seen.push(req.tools.map((t) => t.name));
    return { text: "ok", toolCalls: [] };
  };
  const d = delegateTool({
    tools: () => [tool("read_file", "read"), tool("web_search", "read")],
    currentModel: () => "m",
    turnFor: () => turn,
    models: () => [],
    workspace: () => "/proj",
    runs,
    chatId: "c",
    modelFor: () => ({ modelId: "cloud/x", label: "X", local: false, cloud: true }),
    cloudFiles: { get: () => answer, set: (y) => void (answer = y) },
  });
  const p = d.run({ parts: [{ task: "what is new" }] }, { signal: new AbortController().signal, recordChange: () => undefined });
  await new Promise((r) => setTimeout(r, 10));
  const asking = runs.list("c")[0]!;
  assert.equal(asking.state, "asking");
  runs.answer(asking.id, false);
  await p;
  assert.equal(answer, false, "kept for the project");
  assert.deepEqual(seen[0]!.filter((t) => t !== "ask_user" && t !== "request_access"), ["web_search"]);
  await d.run({ parts: [{ task: "again" }] }, { signal: new AbortController().signal, recordChange: () => undefined });
  assert.equal(runs.list("c")[1]!.state, "done", "not asked twice");
});

test("steer and continue through the lead's tools: a note reaches the helper's next turn; an ended helper goes on from its conversation", async () => {
  const { HelperRuns } = await import("./helper-runs.js");
  const { helperToolsFor } = await import("./delegate.js");
  const runs = new HelperRuns({ limit: () => 2 });
  const seen: string[][] = [];
  let release!: () => void;
  let gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  const turn: ModelTurn = async (req) => {
    seen.push(req.messages.map((m) => (typeof m.content === "string" ? m.content : "")));
    calls++;
    if (calls === 1) {
      await gate;
      return { text: "", toolCalls: [{ id: "t1", name: "read_file", input: { path: "a.ts" } }] };
    }
    return { text: `report ${calls}`, toolCalls: [] };
  };
  const tools = helperToolsFor({ tools: () => [tool("read_file", "read")], currentModel: () => "m", turnFor: () => turn, models: () => [], runs, chatId: "c" });
  const byName = (n: string) => tools.find((t) => t.spec.name === n)!;
  const ctx = { signal: new AbortController().signal, recordChange: () => undefined };
  const out = await byName("delegate").run({ parts: [{ task: "find x", type: "lookup", background: true }] }, ctx);
  const id = /id (h-\w+)/.exec(out.output)![1]!;
  await new Promise((r) => setTimeout(r, 10));
  assert.match((await byName("helper_message").run({ id, text: "also check b.ts" }, ctx)).output, /Sent to/);
  release();
  const first = (await runs.wait([id]))[0]!;
  assert.equal(first.state, "done");
  assert.ok(seen[1]!.some((c) => /assistant that started you[\s\S]*also check b\.ts/.test(c)), "the note is in its next turn");
  await assert.rejects(byName("helper_message").run({ id, text: "late" }, ctx), /helper_continue/);
  // Continue: the same conversation and the follow-up.
  gate = Promise.resolve();
  const cont = await byName("helper_continue").run({ id, text: "now look at c.ts" }, ctx);
  assert.match(cont.output, /Continued/);
  const second = (await runs.wait([id]))[0]!;
  assert.equal(second.state, "done");
  assert.equal(second.continued, 1);
  const last = seen.at(-1)!;
  assert.ok(last.some((c) => c === "find x"), "it keeps its first task");
  assert.ok(last.some((c) => /continues your task[\s\S]*now look at c\.ts/.test(c)), "and gets the follow-up");
  await assert.rejects(byName("helper_continue").run({ id: "h-nope", text: "x" }, ctx), /No helper/);
});

test("each role gets its own browser, computer and command tools, with a helper's risk", () => {
  const all = [
    tool("read_file", "read"),
    tool("browser_tabs", "read"),
    tool("browser_read", "write"),
    tool("browser_screenshot", "write"),
    tool("browser_open", "exec"),
    tool("browser_click", "exec"),
    tool("computer_use_app", "exec"),
    tool("computer_screenshot", "read"),
    tool("computer_click", "read"),
    tool("run_command", "exec"),
    tool("generate_image", "exec"),
    tool("delegate", "safe"),
  ];
  const of = (kind: Parameters<typeof roleTools>[0]) => Object.fromEntries(roleTools(kind, all).map((t) => [t.spec.name, t.risk]));
  assert.deepEqual(of("lookup"), { read_file: "read" });
  // Research reads pages without asking; opening one asks.
  assert.deepEqual(of("research"), { read_file: "read", browser_tabs: "read", browser_read: "read", browser_screenshot: "read", browser_open: "exec" });
  assert.deepEqual(of("build"), { read_file: "read", browser_tabs: "read", browser_read: "read", browser_screenshot: "read", browser_open: "exec", browser_click: "exec", run_command: "exec" });
  // The operator: looking runs, every computer action asks (the chat's own computer_click is "read" after its app ask).
  const op = of("operate");
  assert.equal(op.computer_screenshot, "read");
  assert.equal(op.computer_click, "exec");
  assert.equal(op.computer_use_app, "exec");
  assert.equal(op.run_command, undefined);
  assert.equal(op.generate_image, undefined);
  assert.equal(op.delegate, undefined);
  // The chat's own tools are not changed.
  assert.equal(all.find((t) => t.spec.name === "computer_click")!.risk, "read");
});

/** A model that opens a page once, then reports what the tool said. */
const opener: ModelTurn = async (req) => {
  const last = req.messages.at(-1);
  if (last?.role === "user") return { text: "", toolCalls: [{ id: "1", name: "browser_open", arguments: { url: "https://example.com" } }] };
  return { text: `report: ${typeof last?.content === "string" ? last.content.slice(0, 40) : ""}`, toolCalls: [] };
};

test("a helper's action waits for the user's approval on a card that names it", async () => {
  const asked: HelperApproval[] = [];
  let opened = 0;
  const open: AgentTool = { ...tool("browser_open", "exec"), run: async () => ((opened++), { output: "page text" }) };
  const opts = (decision: "allow" | "deny") => ({
    tools: () => [tool("read_file", "read"), open],
    currentModel: () => "m",
    turnFor: () => opener,
    models: () => ["m"],
    approve: async (req: HelperApproval) => {
      asked.push(req);
      return { decision };
    },
  });
  const ctx = { signal: new AbortController().signal, recordChange: () => undefined };
  const r = await delegateTool(opts("allow")).run({ parts: [{ task: "open it", title: "Find prices", type: "operate" }] }, ctx);
  assert.equal(opened, 1);
  assert.match(r.output, /report: page text/);
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.name, "browser_open");
  assert.equal(asked[0]!.helper.title, "Find prices");
  assert.equal(asked[0]!.helper.kind, "operate");
  assert.ok(asked[0]!.requestId);
  // Denied: the tool does not run.
  await delegateTool(opts("deny")).run({ parts: [{ task: "open it", type: "research" }] }, ctx);
  assert.equal(opened, 1);
  assert.equal(asked.length, 2);
});

test("without a chat to ask, a helper's action is refused", async () => {
  let opened = 0;
  const open: AgentTool = { ...tool("browser_open", "exec"), run: async () => ((opened++), { output: "page" }) };
  const d = delegateTool({ tools: () => [open], currentModel: () => "m", turnFor: () => opener, models: () => ["m"] });
  const r = await d.run({ parts: [{ task: "open it", type: "operate" }] }, { signal: new AbortController().signal, recordChange: () => undefined });
  assert.equal(opened, 0);
  assert.match(r.output, /report: The user denied/);
});
