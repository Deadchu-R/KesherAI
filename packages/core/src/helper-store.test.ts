import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, type AgentTool, type ModelTurn } from "@kesher/agent";
import type { AgentMessage, HelperRunInfo } from "@kesher/shared";
import { ChatHelpers, type ChatHelpersHost } from "./chat-helpers.js";
import { helperToolsFor, resumeHelperRun, RESUME_NOTE } from "./delegate.js";
import { HelperRuns } from "./helper-runs.js";
import { HelperStore } from "./helper-store.js";

const readFile: AgentTool = { risk: "read", spec: { name: "read_file", description: "read", inputSchema: { type: "object", properties: {} } }, run: async () => ({ output: "line 1: hello" }) };
const ctx = { signal: new AbortController().signal, recordChange: () => undefined };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** Waits until `ok` holds (a test's way to wait for a step), up to 2 s. */
async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !ok(); i++) await tick();
  assert.ok(ok(), "timed out");
}

test("a background helper is saved on each step and continues after a restart from its saved conversation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-hstore-"));
  try {
    // Before the restart: one step (read_file), then it hangs (the app closes).
    const runs1 = new HelperRuns({ limit: () => 2 });
    const store1 = new HelperStore(dir, runs1);
    store1.watch();
    const hang: ModelTurn = async (req) => (req.messages.some((m) => m.role === "tool") ? new Promise(() => undefined) : { text: "", toolCalls: [{ id: "1", name: "read_file", arguments: { path: "a.ts" } }] });
    const [d] = helperToolsFor({ tools: () => [readFile], currentModel: () => "m", turnFor: () => hang, models: () => [], runs: runs1, chatId: "chat-1" });
    const out = await d!.run({ parts: [{ task: "find the greeting", title: "greeting", type: "lookup", background: true }] }, ctx);
    const id = /id (h-\w+)/.exec(out.output)![1]!;
    await until(() => runs1.saved("chat-1")[0]?.transcript?.some((m) => m.role === "tool") === true);
    await store1.flush();
    assert.deepEqual(await readdir(dir), ["chat-1.json"]);

    // After the restart: it comes back paused, then continues with the same id and its earlier steps.
    const runs2 = new HelperRuns({ limit: () => 2 });
    const saved = await new HelperStore(dir, runs2).load();
    assert.deepEqual(runs2.restore(saved), [id]);
    assert.deepEqual([runs2.get(id)!.state, runs2.get(id)!.restart, runs2.get(id)!.step], ["waiting", "paused", 1]);
    let seen: AgentMessage[] = [];
    const finish: ModelTurn = async (req) => {
      seen = req.messages;
      return { text: "It says hello (a.ts line 1).", toolCalls: [] };
    };
    const o = { tools: () => [readFile], currentModel: () => "m", turnFor: () => finish, models: () => [], runs: runs2, chatId: "chat-1" };
    // Waits by the `end` event (helper_wait would mark the report as handed over).
    const ended = new Promise<HelperRunInfo>((r) => runs2.once("end", r));
    assert.equal(resumeHelperRun(o, saved[0]!), true);
    const end = await ended;
    assert.equal(end!.state, "done");
    assert.equal(end!.restart, "resumed");
    assert.match(end!.report ?? "", /hello/);
    assert.ok(seen.some((m) => m.role === "tool" && m.content.includes("hello")), "its earlier tool result is in its context");
    assert.equal(seen.at(-1)?.content, RESUME_NOTE);
    assert.equal(runs2.pending(id), true, "its report still has to reach the chat's model");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restore: ended runs come back as they were; a run that cannot continue ends as failed", async () => {
  const runs = new HelperRuns({ limit: () => 2 });
  const base = { kind: "research" as const, title: "t", model: "m", queuedAt: 1, step: 2, maxSteps: 8, steps: ["a", "b"], background: true };
  const paused = runs.restore([
    { chatId: "c", info: { ...base, id: "h-done", state: "done", report: "r".repeat(7000) }, local: true, timeMs: 60_000, delivered: true },
    { chatId: "c", info: { ...base, id: "h-ext", kind: "external", state: "running" }, local: false, timeMs: 60_000 },
  ]);
  assert.deepEqual(paused, []);
  assert.equal(runs.get("h-done")!.cut, true, "a long report is cut on the card again");
  assert.equal(runs.get("h-done")!.full?.length, 7000);
  assert.equal(runs.pending("h-done"), false);
  assert.equal(runs.get("h-ext")!.state, "failed");
  assert.match(runs.get("h-ext")!.error ?? "", /restart/);
  assert.equal(runs.resume("h-done", async () => ({ report: "" })), false, "only a paused run resumes");
});

test("a part the chat waits for does not continue after a restart (the chat's own resume redoes it), but can take a follow-up", async () => {
  const runs = new HelperRuns({ limit: () => 2 });
  const turn: ModelTurn = async () => ({ text: "found", toolCalls: [] });
  const [d] = helperToolsFor({ tools: () => [readFile], currentModel: () => "m", turnFor: () => turn, models: () => [], runs, chatId: "c" });
  await d!.run({ parts: [{ task: "find x", type: "lookup" }] }, ctx);
  const saved = runs.saved("c")[0]!;
  assert.equal((saved.resume as { task?: string }).task, "find x", "kept for a follow-up");
  assert.equal(runs.get(saved.info.id)!.canContinue, true);
  // Saved while it ran: after the restart it ends as failed instead of pausing.
  const again = new HelperRuns({ limit: () => 2 });
  assert.deepEqual(again.restore([{ ...saved, info: { ...saved.info, id: "h-fg", state: "running" } }]), []);
  assert.equal(again.get("h-fg")!.state, "failed");
});

test("wake-up: a background helper that ends while its chat is idle wakes the chat's model once", async () => {
  const calls: string[] = [];
  const session = {
    busy: false,
    wake: (text: string, note: string) => (calls.push(`wake:${note}|${text.includes("its answer")}`), true),
    deliver: (text: string) => calls.push(`deliver:${text}`),
    helpersChanged: () => undefined,
    helperUsage: () => undefined,
  } as unknown as AgentSession;
  const host = { deps: { config: { helpers: { minutes: 10 } } }, session: () => session, workspace: () => undefined, worktree: () => undefined, leadModel: () => undefined } as unknown as ChatHelpersHost;
  const h = new ChatHelpers(host);
  const r = h.runs.start({ chatId: "c", kind: "research", title: "check the docs", background: true, maxSteps: 4, timeMs: 60_000, local: false, model: "m", run: async () => ({ report: "its answer" }) });
  await until(() => calls.length > 0);
  assert.deepEqual(calls, ["wake:סוכן עזר סיים: check the docs · Helper finished: check the docs|true"]);
  assert.equal(h.runs.pending(r.id), false);
});

test("AgentSession.wake runs the idle model once with the note; busy, the note waits for the next turn", async () => {
  const asked: string[] = [];
  const gate: { hold?: Promise<void> } = {};
  const model: ModelTurn = async (req) => {
    asked.push(String(req.messages.at(-1)?.content));
    await gate.hold;
    return { text: "Going on with the report.", toolCalls: [] };
  };
  const s = new AgentSession({ id: "s", modelId: "m", model, mode: "ask", tools: [], systemPrompt: "x" });
  assert.equal(s.wake("report A", "Helper finished: A"), true);
  await until(() => !s.busy && s.events.some((e) => e.type === "assistant"));
  assert.match(asked[0]!, /^\[KesherAI\] report A/);
  assert.ok(s.events.some((e) => e.type === "note" && e.text === "Helper finished: A"));
  let free!: () => void;
  gate.hold = new Promise((r) => (free = r));
  s.send("hi");
  assert.equal(s.wake("report B", "Helper finished: B"), false);
  free();
  await until(() => !s.busy);
  assert.equal(s.events.filter((e) => e.type === "note").length, 1, "no second line while it was busy");
});
