import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateHubKeys, openEnvelope, parseSealedBody, sealMessage, applyAgentBatch, shownState, HUB_LIMITS, type AgentCard } from "../../packages/shared/src/hub.js";
import { applyCommand, loadConfig, parseArgs, pruneRuns, saveConfig, scrub } from "./report.js";

test("a run: start, step, done build the whole state and numbered events", () => {
  const s = applyCommand("cc-1", undefined, { cmd: "start", kind: "build", model: "opus", title: "Hub: Claude chat group" }, 1000);
  assert.equal(s.state.source, "claude-chat");
  assert.equal(s.state.title, "🔨 Hub: Claude chat group");
  assert.equal(s.state.model, "opus");
  assert.deepEqual(s.unsent.map((e) => [e.seq, e.type]), [[1, "started"]]);
  const a = applyCommand("cc-1", s, { cmd: "step", label: "typecheck" }, 2000);
  assert.equal(a.state.step, 1);
  assert.equal(a.state.label, "typecheck");
  const d = applyCommand("cc-1", { ...a, unsent: [] }, { cmd: "done", summary: "Done. ".repeat(80) }, 3000);
  assert.equal(d.state.state, "done");
  assert.equal(d.state.endedAt, 3000);
  assert.equal(d.state.label, undefined);
  assert.ok(d.state.summary!.length <= 300);
  assert.deepEqual(d.unsent.map((e) => [e.seq, e.type]), [[3, "done"]]);
  const f = applyCommand("cc-1", a, { cmd: "failed", reason: "tests broke" }, 3000);
  assert.equal(f.state.state, "failed");
  assert.throws(() => applyCommand("cc-2", undefined, { cmd: "step", label: "x" }, 1), /Call start first/);
  assert.throws(() => applyCommand("bad id!", undefined, { cmd: "start", kind: "lookup", title: "x" }, 1), /run id/);
});

test("labels and summaries are scrubbed: no home paths, keys or tokens; one line", () => {
  const t = scrub("read /home/roee/kesher/a.ts and C:\\Users\\Someone\\x.txt\nkey sk-abcdefghijk token=abcdef123", 300);
  assert.ok(!/roee|Someone|abcdefghijk|abcdef123/.test(t), t);
  assert.ok(!t.includes("\n"));
  assert.equal(scrub("x".repeat(500), 80).length, 80);
});

test("arguments: the four commands, and a clear usage line otherwise", () => {
  assert.deepEqual(parseArgs(["start", "r1", "--kind", "research", "--model", "sonnet", "--title", "Look into X"]), { runId: "r1", command: { cmd: "start", kind: "research", title: "Look into X", model: "sonnet" } });
  assert.deepEqual(parseArgs(["step", "r1", "reading"]), { runId: "r1", command: { cmd: "step", label: "reading" } });
  assert.deepEqual(parseArgs(["done", "r1"]), { runId: "r1", command: { cmd: "done" } });
  assert.deepEqual(parseArgs(["failed", "r1", "why"]), { runId: "r1", command: { cmd: "failed", reason: "why" } });
  assert.throws(() => parseArgs(["start", "r1", "--kind", "other", "--title", "x"]), /Usage: start/);
  assert.throws(() => parseArgs(["nope"]), /Unknown command/);
});

test("a batch seals and opens as the viewer reads it, and shows stale only after an hour", async () => {
  const chat = await generateHubKeys(true);
  const phone = await generateHubKeys(true);
  const run = applyCommand("cc-9", undefined, { cmd: "start", kind: "lookup", title: "Find the hub route" }, 1000);
  const env = await sealMessage({ from: "chat1", to: "phone1", kind: "agent_event" }, { type: "agent_event", runId: run.state.runId, state: run.state, events: run.unsent }, chat.privateKey, phone.publicKey);
  const body = parseSealedBody(await openEnvelope(env, phone.privateKey, chat.publicKey), "agent_event");
  assert.ok(body && body.type === "agent_event");
  const cards = new Map<string, AgentCard>();
  const card = applyAgentBatch(cards, "chat1", body, 1000, 1);
  assert.equal(shownState(card, 1000 + HUB_LIMITS.agentStaleMs * 2), "running");
  assert.equal(shownState(card, 1000 + HUB_LIMITS.agentChatStaleMs + 1), "stale");
  const done = applyCommand("cc-9", { ...run, unsent: [] }, { cmd: "done", summary: "Route is /api/agents" }, 2000);
  const back = parseSealedBody(JSON.parse(JSON.stringify({ type: "agent_event", runId: "cc-9", state: done.state, events: done.unsent })), "agent_event");
  assert.ok(back && back.type === "agent_event" && back.state.summary === "Route is /api/agents" && back.events[0]!.type === "done");
});

test("the pairing file is only for this user (600), and old runs are pruned", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-hubreport-"));
  process.env.KESHER_HUB_HOME = join(dir, "h");
  try {
    await saveConfig({ url: "https://hub.test", token: "t", runs: {} });
    assert.equal((await stat(join(dir, "h", "claude-chat.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "h"))).mode & 0o777, 0o700);
    assert.equal((await loadConfig()).token, "t");
    const runs = { a: applyCommand("a", undefined, { cmd: "start", kind: "build", title: "a" }, 1) };
    runs.a = applyCommand("a", runs.a, { cmd: "done" }, 2);
    pruneRuns(runs, 2 + 86_400_001);
    assert.deepEqual(Object.keys(runs), []);
  } finally {
    delete process.env.KESHER_HUB_HOME;
    await rm(dir, { recursive: true, force: true });
  }
});
