import { test } from "node:test";
import assert from "node:assert/strict";
import type { HelperRunInfo, InboxTaskView } from "@kesher/shared";
import { AgentActivity, helperSnapshot, inboxRunId, inboxSnapshot, type ActivityBatch, type RunSnapshot } from "./agent-activity.js";

function setup(o: { enabled?: boolean; names?: boolean } = {}) {
  let now = 1_000_000;
  const sent: ActivityBatch[][] = [];
  const a = new AgentActivity({ send: (b) => sent.push(b), enabled: () => o.enabled ?? true, fileNames: () => o.names ?? false, now: () => now, manual: true });
  return { a, sent, tick: (ms: number) => (now += ms), at: () => now };
}
const snap = (over: Partial<RunSnapshot> = {}): RunSnapshot => ({ runId: "h-1", source: "chat-helper", title: "Look into the login bug", state: "running", step: 0, startedAt: 1, ...over });

test("a run's changes become events; one batch per run per flush; an ended run is forgotten", () => {
  const { a, tick } = setup();
  a.observe(snap());
  a.observe(snap({ step: 1, label: "read_file" }));
  tick(1500);
  a.observe(snap({ step: 2, label: "grep" }));
  const [b] = a.flush();
  assert.deepEqual(b!.events.map((e) => e.type), ["started", "step", "step"]);
  assert.equal(b!.state.step, 2);
  assert.equal(b!.state.label, "grep");
  a.observe(snap({ step: 2, state: "done", endedAt: 5 }));
  assert.deepEqual(a.flush()[0]!.events.map((e) => e.type), ["done"]);
  assert.equal(a.has("h-1"), false);
  a.observe(snap({ step: 2, state: "done" }));
  assert.equal(a.flush().length, 0, "a later listing of the ended run sends nothing");
});

test("steps are coalesced to one per second; the newest one wins", () => {
  const { a, tick } = setup();
  a.observe(snap());
  for (let i = 1; i <= 10; i++) {
    tick(100);
    a.observe(snap({ step: i, label: `tool${i}` }));
  }
  const ev = a.flush()[0]!.events.filter((e) => e.type === "step");
  assert.equal(ev.length, 1);
  assert.equal((ev[0] as { n: number }).n, 10);
});

test("off by default means nothing; old ended runs are not reported", () => {
  const off = setup({ enabled: false });
  off.a.observe(snap());
  assert.equal(off.a.flush().length, 0);
  const on = setup();
  on.a.observe(snap({ state: "done" }));
  assert.equal(on.a.flush().length, 0);
});

test("file names only with reportFileNames, cleaned; counted either way", () => {
  const files = [{ path: "/home/someone/proj/src/a.ts", op: "read" as const }, { path: "src/b.ts", op: "edit" as const }];
  const plain = setup();
  plain.a.observe(snap({ files }));
  const p = plain.a.flush()[0]!;
  assert.equal(p.state.files, 2);
  assert.deepEqual(p.state.fileNames, []);
  assert.equal(p.events.some((e) => e.type === "file"), false);
  const named = setup({ names: true });
  named.a.observe(snap({ files }));
  const n = named.a.flush()[0]!;
  assert.deepEqual(n.state.fileNames, ["proj/src/a.ts", "src/b.ts"]);
  assert.equal(JSON.stringify(n).includes("someone"), false, "no home path");
});

test("heartbeat for going runs after 25 s of quiet; waiting carries how to answer; cancel calls stop", async () => {
  const { a, tick } = setup();
  let stopped = false;
  a.observe(snap(), async () => (stopped = true));
  a.flush();
  tick(10_000);
  assert.equal(a.beat().length, 0);
  tick(20_000);
  const [hb] = a.beat();
  assert.equal(hb!.events.length, 0);
  a.observe(snap({ state: "waiting", waiting: { reason: "ask", requestId: "h-1", conversationId: "helper-asks", summary: "Read the files?" } }));
  const w = a.flush()[0]!;
  assert.equal(w.events[0]!.type, "waiting");
  assert.equal(w.state.waiting?.requestId, "h-1");
  assert.equal(await a.cancel("h-1"), true);
  assert.equal(stopped, true);
  assert.equal(await a.cancel("nope"), false);
});

test("adapters: helper steps give tool names only; inbox runs map Run asks and approvals", () => {
  const info: HelperRunInfo = { id: "h-9", kind: "build", title: "Add a test", model: "Qwen3-4B", state: "asking", waitReason: "May it read the project's files?", queuedAt: 1, startedAt: 2, step: 2, maxSteps: 30, steps: ["read_file: src/secret-plan.ts", "web_search: my private question"], background: true };
  const h = helperSnapshot(info, "task-inbox");
  assert.equal(h.label, "web_search");
  assert.equal(h.state, "waiting");
  assert.deepEqual(h.files, [{ path: "src/secret-plan.ts", op: "read" }]);
  assert.equal(JSON.stringify(h).includes("private question"), false, "a search query never leaves");
  assert.equal(h.waiting?.conversationId, "helper-asks");
  const t = { id: "t-7", title: "Fix CSS", runBy: "antigravity", status: "waiting", branch: "agy/t-7-fix-css" } as unknown as InboxTaskView;
  assert.equal(inboxSnapshot(t, undefined, "task-inbox")!.state, "queued");
  const w = inboxSnapshot(t, { requestId: "r1", until: 9, left: 3 } as never, "task-inbox")!;
  assert.equal(w.state, "waiting");
  assert.equal(w.waiting?.reason, "run-press");
  assert.equal(w.runId, inboxRunId("t-7"));
  assert.equal(inboxSnapshot({ ...t, runBy: "local" } as InboxTaskView, undefined, "task-inbox"), undefined);
  const r = inboxSnapshot({ ...t, status: "running", decisions: [{ at: 1, verdict: "allow", what: "pnpm add left-pad", rule: "x" }] } as InboxTaskView, undefined, "task-inbox")!;
  assert.equal(r.label, "pnpm", "only the verb of a step");
});
