import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentTool, ModelTurn } from "@kesher/agent";
import { HelperRuns } from "./helper-runs.js";
import { helperToolsFor } from "./delegate.js";
import { assembleReport, collectSources, deepResearchTool, reportTitle, researchTask } from "./deep-research.js";

const tool = (name: string, out = "ok"): AgentTool => ({
  risk: "read",
  spec: { name, description: name, inputSchema: { type: "object", properties: {} } },
  run: async () => ({ output: out }),
});

test("sources: Markdown links, 'Title — URL' lines and bare links, numbered once each", () => {
  const s = collectSources([
    "- fact\nSources:\n- Ollama docs — https://ollama.com/docs.\n- [LM Studio](https://lmstudio.ai/docs)",
    "See https://ollama.com/docs/ again and https://example.org/a?b=1)",
    "not a link: http://localhost and ftp://x.y",
  ]);
  assert.deepEqual(s.map((x) => [x.n, x.url, x.title]), [
    [1, "https://ollama.com/docs", "Ollama docs"],
    [2, "https://lmstudio.ai/docs", "LM Studio"],
    [3, "https://example.org/a?b=1", "example.org"],
  ]);
});

test("the report keeps the writer's text, drops its own source list, and adds the numbered links", () => {
  const body = "# Local runners\n\nSummary [1].\n\n## Sources\n- made up";
  const out = assembleReport(body, [{ n: 1, url: "https://a.io/x", title: "A [docs]" }], false);
  assert.equal(out, "# Local runners\n\nSummary [1].\n\n## Sources\n\n1. [A docs](https://a.io/x)");
  assert.match(assembleReport("# כותרת\n\nטקסט", [{ n: 1, url: "https://a.io", title: "A" }], true), /## מקורות\n\n1\. \[A\]/);
  assert.equal(reportTitle("intro\n# **Best** runners\n", "q"), "Best runners");
  assert.equal(reportTitle("no heading", "the question"), "the question");
  assert.match(researchTask("Q", "sub"), /^Research this sub-question: sub\n\(It is part of a bigger question: Q\)[\s\S]*Sources:/);
});

test("two or more parts make one plan; the lead adds and removes sub-agents and changes the goal", async () => {
  const runs = new HelperRuns({ limit: () => 4 });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const turn: ModelTurn = async () => {
    await gate;
    return { text: "found", toolCalls: [] };
  };
  const [d, , , , , , revise] = helperToolsFor({ tools: () => [tool("read_file")], currentModel: () => "m", turnFor: () => turn, models: () => [], runs, chatId: "c" });
  assert.equal(revise!.spec.name, "plan_revise");
  const ctx = { signal: new AbortController().signal, recordChange: () => undefined, callId: "k1" };
  const r = await d!.run({ goal: "Compare runners", parts: [{ task: "a", background: true }, { task: "b", background: true }] }, ctx);
  const planId = /Plan (p-[\w]+)/.exec(r.output)?.[1];
  assert.ok(planId, r.output);
  const list = runs.list("c");
  assert.equal(list.length, 2);
  assert.ok(list.every((x) => x.plan?.id === planId && x.plan.goal === "Compare runners" && x.plan.kind === "plan"));
  // One part alone makes no plan.
  await d!.run({ parts: [{ task: "solo", background: true }] }, ctx);
  assert.equal(runs.list("c").filter((x) => !x.plan).length, 1);
  // Adding to the plan, then removing one and changing the goal.
  await d!.run({ plan: planId, parts: [{ task: "c", background: true }] }, ctx);
  const mine = runs.list("c").filter((x) => x.plan?.id === planId);
  assert.equal(mine.length, 3);
  await revise!.run({ plan: planId, goal: "Pick a runner", remove: [mine[0]!.id] }, ctx);
  const after = runs.list("c").filter((x) => x.plan?.id === planId);
  assert.ok(after.every((x) => x.plan!.goal === "Pick a runner" && x.plan!.rev === 2));
  assert.equal(after.find((x) => x.id === mine[0]!.id)!.removed, true);
  await assert.rejects(revise!.run({ plan: "p-none", goal: "x" }, ctx), /No plan/);
  release();
  await runs.wait(runs.list("c").map((x) => x.id));
});

test("deep research: sub-agents in parallel on the research model, a report document with sources, the plan's stages", async () => {
  const runs = new HelperRuns({ limit: () => 4 });
  const stages: string[] = [];
  runs.on("change", () => {
    const p = runs.list("c")[0]?.plan?.phase;
    if (p && stages.at(-1) !== p) stages.push(p);
  });
  let writerSaw = "";
  const turnFor = (m: string): ModelTurn => async (req) => {
    if (m === "lead") {
      writerSaw = req.messages.map((x) => x.content).join("\n");
      return { text: "# Runners\n\nOllama is simple [1].", toolCalls: [] };
    }
    const task = String(req.messages.find((x) => x.role === "user")?.content ?? "");
    return { text: `- fact about ${/sub-question: (\w+)/.exec(task)?.[1]}\nSources:\n- Docs — https://ollama.com/docs`, toolCalls: [] };
  };
  const saved: Array<{ title: string; body: string }> = [];
  const t = deepResearchTool({
    tools: () => [tool("web_search")],
    currentModel: () => "lead",
    turnFor,
    models: () => [],
    runs,
    chatId: "c",
    modelFor: ({ kind }) => ({ modelId: kind === "research" ? "small" : "lead", label: "Small", local: false }),
    report: async (title, body) => {
      saved.push({ title, body });
      return { id: "d1", ver: 1 };
    },
  });
  const r = await t.run({ question: "Which runner?", parts: ["ollama", "lmstudio", "ollama"] }, { signal: new AbortController().signal, recordChange: () => undefined, callId: "k" });
  assert.match(r.output, /^Saved v1 \(\d+ words\)\. The user sees it at #\/docs\/d1\./);
  const list = runs.list("c");
  assert.equal(list.length, 2, "repeated sub-questions run once");
  assert.ok(list.every((x) => x.model === "Small" && x.callId === "k" && x.plan?.kind === "research"));
  assert.deepEqual(list[0]!.plan!.doc, { id: "d1", title: "Runners", ver: 1 });
  assert.deepEqual(stages, ["researching", "writing", "done"]);
  assert.match(writerSaw, /\[1\] Docs — https:\/\/ollama\.com\/docs/);
  assert.equal(saved[0]!.body, "# Runners\n\nOllama is simple [1].\n\n## Sources\n\n1. [Docs](https://ollama.com/docs)");
});

test("deep research with nothing found fails the plan, and without documents the answer holds the report", async () => {
  const runs = new HelperRuns({ limit: () => 4 });
  const failing = deepResearchTool({ tools: () => [], currentModel: () => "m", turnFor: () => async () => { throw new Error("offline"); }, models: () => [], runs, chatId: "c" });
  const r = await failing.run({ question: "Q", parts: ["a"] }, { signal: new AbortController().signal, recordChange: () => undefined });
  assert.match(r.output, /^No sub-agent found anything/);
  assert.equal(runs.list("c")[0]!.plan!.phase, "failed");
  const runs2 = new HelperRuns({ limit: () => 4 });
  const plain = deepResearchTool({ tools: () => [], currentModel: () => "m", turnFor: () => async () => ({ text: "# T\n\nbody https://a.io/x", toolCalls: [] }), models: () => [], runs: runs2, chatId: "c" });
  const r2 = await plain.run({ question: "Q", parts: [] }, { signal: new AbortController().signal, recordChange: () => undefined });
  assert.match(r2.output, /keeps no documents[\s\S]*## Sources\n\n1\. \[a\.io\]\(https:\/\/a\.io\/x\)/);
});

test("researchReport: plans parts, searches and reads one after the other, writes one report with a Sources list", async () => {
  const { researchReport } = await import("./deep-research.js");
  const asked: string[] = [];
  const model: ModelTurn = async (req) => {
    const system = req.messages[0]!.content as string;
    asked.push(system.slice(0, 20));
    return { text: system.startsWith("Split") ? '{"parts": ["sync in Obsidian", "sync in Notion", "sync in Obsidian", "a", "b"]}' : "# Sync\n\nObsidian syncs files [1].\n\n## Sources\n\n1. made up" } as Awaited<ReturnType<ModelTurn>>;
  };
  const searches: string[] = [];
  const report = await researchReport("How do apps sync notes?", {
    model,
    search: async (q) => (searches.push(q), [{ title: `Doc ${q}`, url: `https://${q.split(" ").pop()}.example/doc`, snippet: "s" }]),
    read: async () => "page text",
  }, new AbortController().signal);
  assert.deepEqual(searches, ["sync in Obsidian", "sync in Notion", "a"], "at most three parts, no repeats");
  assert.match(report, /Obsidian syncs files \[1\]/);
  assert.match(report, /## Sources\n\n1\. \[Doc sync in Obsidian\]\(https:\/\/Obsidian\.example\/doc\)/);
  assert.doesNotMatch(report, /made up/);
  // The model's own error (a quota) is thrown as it is.
  await assert.rejects(researchReport("q", { model: async () => { throw new Error("429 RESOURCE_EXHAUSTED"); }, search: async () => [], read: async () => "" }, new AbortController().signal), /RESOURCE_EXHAUSTED/);
});

test("researchReport: no search result and no page read means no report, and the writer must not invent sources", async () => {
  const { researchReport, NO_SEARCH_NOTE, writerMessages } = await import("./deep-research.js");
  let wrote = false;
  const model: ModelTurn = async (req) => {
    const system = req.messages[0]!.content as string;
    if (!system.startsWith("Split")) wrote = true;
    return { text: system.startsWith("Split") ? '{"parts": ["a"]}' : "# T\n\nmade up [Findings 1]" } as Awaited<ReturnType<ModelTurn>>;
  };
  await assert.rejects(researchReport("q", { model, search: async () => [], read: async () => "" }, new AbortController().signal), new RegExp(NO_SEARCH_NOTE));
  // Results but no page that opened: still nothing was read.
  await assert.rejects(researchReport("q", { model, search: async () => [{ title: "A", url: "https://a.io/x", snippet: "s" }], read: async () => "" }, new AbortController().signal), /Web search returned nothing \(pages: None of the results could be read\.\); no report written/);
  assert.equal(wrote, false);
  assert.match(writerMessages("q", [], [])[0]!.content, /never invent a source or write placeholders such as \[Findings N\]/);
});

test("researchReport: a search that found nothing keeps each backend's reason (no addresses or keys), logged once per backend", async () => {
  const { researchReport, noSearchNote, NO_SEARCH_NOTE } = await import("./deep-research.js");
  const model: ModelTurn = async () => ({ text: '{"parts": ["a", "b"]}' }) as Awaited<ReturnType<ModelTurn>>;
  const logged: string[] = [];
  const info = console.info;
  console.info = (x: string) => void logged.push(x);
  try {
    const search = async () => {
      throw Object.assign(new Error("Web search failed on every backend."), { failures: ["duckduckgo: Search answered 202 (a bot check or rate limit).", "bing: Irrelevant results at https://www.bing.com/search?q=x&key=SECRET123"] });
    };
    const e = (await researchReport("q", { model, search, read: async () => "" }, new AbortController().signal).catch((x: unknown) => x)) as Error;
    assert.equal(e.message, "Web search returned nothing (duckduckgo: Search answered 202 (a bot check or rate limit).; bing: Irrelevant results at www.bing.com); no report written");
    assert.equal(logged.length, 2, "two sub-questions, but each backend is logged once");
    assert.doesNotMatch(logged.join(" "), /SECRET123/);
  } finally {
    console.info = info;
  }
  assert.equal(noSearchNote([]), NO_SEARCH_NOTE);
  assert.ok(noSearchNote(Array.from({ length: 9 }, (_, i) => `engine${i}: ${"x".repeat(90)}`)).length < 320);
});
