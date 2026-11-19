import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAgentBatch, shownState, sortedCards, type AgentCard } from "./hub-agents.js";
import { cleanAgentPath, cleanOptIn, HUB_LIMITS, parseDeviceFrame, parseEnvelope, parseSealedBody, type AgentRunState, type SealedBody } from "./hub-protocol.js";

const state = (over: Partial<AgentRunState> = {}): AgentRunState => ({ runId: "h-1", title: "Fix the login", source: "chat-helper", state: "running", step: 2, startedAt: 1000, lastEventAt: 2000, files: 0, fileNames: [], ...over });
const batch = (s: AgentRunState, events: unknown[] = []) => parseSealedBody({ type: "agent_event", runId: s.runId, state: s, events }, "agent_event") as Extract<SealedBody, { type: "agent_event" }>;
const env = { v: 1, id: "m1", from: "pc1", to: "phone1", kind: "agent_event", ttl: 3600, iv: "AAAAAAAAAAAAAAAA", ct: "abc_-", run: "h-1", n: 1 };

test("agent_event envelopes carry a run id and an event count; the hub's seq is never taken from a device", () => {
  const e = parseEnvelope({ ...env, seq: 99, at: 5 });
  assert.equal(e?.run, "h-1");
  assert.equal(e?.n, 1);
  assert.equal(e?.seq, undefined);
  assert.equal(parseEnvelope({ ...env, run: "../x" }), null);
  assert.equal(parseEnvelope({ ...env, n: HUB_LIMITS.agentBatchEvents + 1 }), null);
  assert.equal(parseEnvelope({ ...env, kind: "result" })?.run, undefined, "other kinds drop the run id");
  assert.equal(parseDeviceFrame(JSON.stringify({ t: "agents", envs: [env] }))?.t, "agents");
  assert.equal(parseDeviceFrame(JSON.stringify({ t: "agents", envs: [{ ...env, kind: "task" }] })), null, "only activity in an agents frame");
  assert.equal(parseDeviceFrame(JSON.stringify({ t: "agents", envs: Array(HUB_LIMITS.agentFrameEnvs + 1).fill(env) })), null);
});

test("activity bodies: known events only, capped, paths cleaned, state must match the run", () => {
  const b = batch(state({ fileNames: ["/home/someone/proj/src/a.ts", "../../etc/passwd", "src/b.ts"] }), [
    { seq: 1, t: 1, type: "started", title: "Fix the login", source: "chat-helper", model: "Qwen3-4B" },
    { seq: 2, t: 2, type: "step", n: 1, label: "read_file".repeat(20) },
    { seq: 3, t: 3, type: "file", path: "C:\\Users\\someone\\proj\\src\\x.ts", op: "edit" },
    { seq: 4, t: 4, type: "shell", cmd: "rm -rf /" },
    { seq: 5, t: 5, type: "done", steps: 3, link: "javascript:alert(1)" },
  ]);
  assert.ok(b);
  assert.deepEqual(b.state.fileNames, ["proj/src/a.ts", "src/b.ts"], "absolute paths keep their last parts; .. is dropped");
  assert.equal(b.events.length, 4, "the unknown event is dropped");
  assert.equal((b.events[1] as { label: string }).label.length, 80);
  assert.equal((b.events[2] as { path: string }).path, "proj/src/x.ts");
  assert.equal("link" in b.events[3]!, false, "only https links");
  assert.equal(parseSealedBody({ type: "agent_event", runId: "h-2", state: state(), events: [] }, "agent_event"), null, "state of another run");
  assert.equal(parseSealedBody({ type: "agent_event", runId: "h-1", state: state(), events: [] }, "result"), null, "kind and type must match");
  assert.equal(cleanAgentPath("~/secret/x"), "secret/x");
});

test("opt-in: activity and file names are off by default", () => {
  const o = cleanOptIn({});
  assert.equal(o.reportActivity, false);
  assert.equal(o.reportFileNames, false);
  assert.equal(cleanOptIn({ reportActivity: true }).reportActivity, true);
});

test("cards: events once each, newest state wins, stale after 90 s, waiting pinned on top", () => {
  const cards = new Map<string, AgentCard>();
  applyAgentBatch(cards, "pc1", batch(state(), [{ seq: 1, t: 1, type: "step", n: 1, label: "read_file" }]), 10_000, 5);
  applyAgentBatch(cards, "pc1", batch(state(), [{ seq: 1, t: 1, type: "step", n: 1, label: "read_file" }, { seq: 2, t: 2, type: "step", n: 2, label: "grep" }]), 11_000, 6);
  const c = cards.get("pc1/h-1")!;
  assert.equal(c.events.length, 2);
  // A late catch-up batch with an older state does not undo the newer one.
  applyAgentBatch(cards, "pc1", batch(state({ lastEventAt: 1500, step: 1 })), 9_000, 4);
  assert.equal(cards.get("pc1/h-1")!.state.step, 2);
  assert.equal(shownState(cards.get("pc1/h-1")!, 11_000 + HUB_LIMITS.agentStaleMs - 1), "running");
  assert.equal(shownState(cards.get("pc1/h-1")!, 11_000 + HUB_LIMITS.agentStaleMs + 1), "stale");
  applyAgentBatch(cards, "pc1", batch(state({ runId: "h-2", state: "waiting", lastEventAt: 100, waiting: { reason: "ask", requestId: "h-2", conversationId: "helper-asks", summary: "Read the files?" } })), 12_000, 7);
  applyAgentBatch(cards, "pc1", batch(state({ runId: "h-3", state: "done", lastEventAt: 9000, endedAt: 9000 })), 12_000, 8);
  assert.deepEqual(sortedCards(cards.values(), 12_000).map((x) => x.runId), ["h-2", "h-1", "h-3"]);
  assert.equal(cards.get("pc1/h-2")!.state.waiting?.reason, "ask");
  for (let i = 0; i < 60; i++) applyAgentBatch(cards, "pc1", batch(state({ lastEventAt: 3000 + i }), [{ seq: 10 + i, t: i, type: "step", n: i, label: "x" }]), 13_000, 9 + i);
  assert.equal(cards.get("pc1/h-1")!.events.length, HUB_LIMITS.agentEventsPerRun);
  assert.deepEqual(sortedCards(cards.values(), 9000 + HUB_LIMITS.agentKeepMs + 1).map((x) => x.runId).includes("h-3"), false, "ended cards go after 7 days");
});
