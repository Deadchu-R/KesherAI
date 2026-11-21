import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseRoute } from "./hub-route.js";
import { boardView, boardWaitsOnMe, boardWho, cleanAgents, cleanApproval, cleanBoardCommand, fitApprovals, fitBoard, type HubBoardItem, DEFAULT_OPT_IN, HUB_LIMITS, isSafeLink, parseDeviceFrame, parseEnvelope, parseSealedBody, syncPinger, ttlFor, type HubPresence } from "./hub-protocol.js";

const env = { v: 1, id: "m1", from: "pc1", to: "phone1", kind: "result", ttl: 3600, iv: "AAAAAAAAAAAAAAAA", ct: "abc_-" };

test("envelopes: shape, ids, sizes and ttl", () => {
  assert.ok(parseEnvelope(env));
  assert.equal(parseEnvelope({ ...env, v: 2 }), null);
  assert.equal(parseEnvelope({ ...env, to: "../x" }), null);
  assert.equal(parseEnvelope({ ...env, kind: "shell" }), null);
  assert.equal(parseEnvelope({ ...env, ct: "a".repeat(HUB_LIMITS.ctChars + 1) }), null);
  assert.equal(parseEnvelope({ ...env, ct: "not base64!" }), null);
  assert.equal(parseEnvelope({ ...env, ttl: 99 * 24 * 3600 })?.ttl, HUB_LIMITS.maxTtl);
  assert.equal(ttlFor("approval_request", 86400), HUB_LIMITS.approvalTtl, "approvals live 30 minutes at most");
  assert.equal(ttlFor("task", 1), 60);
  // The clear waiting count (for the hub's push) only on an approvals snapshot, a whole number up to 999.
  assert.equal(parseEnvelope({ ...env, kind: "approvals", waiting: 3 })?.waiting, 3);
  assert.equal(parseEnvelope({ ...env, waiting: 3 })?.waiting, undefined);
  for (const waiting of [-1, 1.5, 1000, "3"]) assert.equal(parseEnvelope({ ...env, kind: "approvals", waiting })?.waiting, undefined);
});

test("device frames: known shapes only, agents and links cleaned", () => {
  assert.equal(parseDeviceFrame("not json"), null);
  assert.equal(parseDeviceFrame(JSON.stringify({ t: "exec", cmd: "rm" })), null);
  assert.equal(parseDeviceFrame("x".repeat(HUB_LIMITS.frameChars + 1)), null);
  const hello = parseDeviceFrame(JSON.stringify({ t: "hello", version: "0.6.400", busy: false, agents: [{ kind: "claude-remote-control", state: "on", link: "https://claude.ai/code/session_x" }] }));
  assert.equal(hello?.t, "hello");
  if (hello?.t !== "hello") return;
  assert.deepEqual(hello.optIn, DEFAULT_OPT_IN, "missing opt-in: the defaults (no tasks)");
  assert.equal(hello.agents[0]?.link, undefined, "no link unless the PC opted in to report links");
  const agents = cleanAgents([{ kind: "claude-remote-control", state: "on", link: "https://claude.ai/code/s" }, { kind: "BAD KIND", state: "on" }, { kind: "codex", state: "weird", link: "javascript:alert(1)" }], true);
  assert.deepEqual(agents, [{ kind: "claude-remote-control", state: "on", link: "https://claude.ai/code/s" }, { kind: "codex", state: "off" }]);
  assert.ok(!isSafeLink("http://claude.ai") && !isSafeLink("https://user:pw@x.com") && isSafeLink("https://claude.ai/code/x"));
  assert.deepEqual(parseDeviceFrame(JSON.stringify({ t: "ack", id: "m1" })), { t: "ack", id: "m1" });
  assert.equal(parseDeviceFrame(JSON.stringify({ t: "send", env }))?.t, "send");
});

test("sealed bodies must fit their kind and are capped", () => {
  const t = { type: "task", taskId: "t1", title: "x", spec: "s".repeat(20_000), executor: "rm -rf", ifOffline: "maybe", createdAt: "" };
  const body = parseSealedBody(t, "task");
  assert.equal(body?.type === "task" && body.spec.length, HUB_LIMITS.specChars);
  assert.equal(body?.type === "task" && body.executor, "auto");
  assert.equal(parseSealedBody(t, "result"), null, "a task body in a result envelope");
  assert.deepEqual(parseSealedBody({ type: "approval_answer", requestId: "req-12345678", conversationId: "c1", decision: "yes please" }, "approval_answer"), { type: "approval_answer", requestId: "req-12345678", conversationId: "c1", decision: "deny" });
  assert.equal(parseSealedBody({ type: "result", taskId: "t1", status: "done", text: "ok", link: "file:///etc" }, "result")?.type, "result");
});

const pc = (id: string, over: Partial<HubPresence> = {}): HubPresence => ({ id, name: id, kind: "pc", publicKey: "k", online: true, busy: false, agents: [], optIn: { ...DEFAULT_OPT_IN, acceptTasks: true, acceptLocal: true }, ...over });

test("routing: a PC that is on, else Claude cloud or wait, by opt-in", () => {
  const cloud = { cloudAvailable: true };
  assert.deepEqual(chooseRoute({ executor: "auto", ifOffline: "wait" }, [pc("home")], cloud).to, "home");
  assert.equal(chooseRoute({ executor: "auto", ifOffline: "wait" }, [pc("a", { busy: true }), pc("b")], cloud).to, "b", "a free PC first");
  assert.equal(chooseRoute({ executor: "auto", ifOffline: "wait" }, [pc("a"), pc("b")], { cloudAvailable: true, preferredPc: "b" }).to, "b");
  const off = chooseRoute({ executor: "auto", ifOffline: "cloud" }, [pc("home", { online: false })], cloud);
  assert.deepEqual([off.route, off.to, off.kind], ["claude-cloud", "hub", "cloud"]);
  assert.match(off.cost.en, /Max usage/);
  assert.equal(chooseRoute({ executor: "auto", ifOffline: "cloud" }, [pc("home", { online: false })], { cloudAvailable: false }).route, "wait");
  assert.equal(chooseRoute({ executor: "pc-local", ifOffline: "cloud" }, [pc("home", { online: false })], cloud).route, "wait", "a local-model task never goes to the cloud");
  assert.equal(chooseRoute({ executor: "pc-antigravity", ifOffline: "wait" }, [pc("home")], cloud).route, "none", "this PC did not opt in to Antigravity");
  assert.equal(chooseRoute({ executor: "auto", ifOffline: "wait" }, [pc("home", { optIn: DEFAULT_OPT_IN })], cloud).route, "none", "a PC takes no tasks until it opts in");
  assert.equal(chooseRoute({ executor: "claude-cloud", ifOffline: "wait" }, [], { cloudAvailable: false }).route, "none");
  assert.equal(chooseRoute({ executor: "auto", ifOffline: "wait" }, [pc("p", { kind: "phone" })], cloud).route, "none", "a phone is not a worker");
});

test("sync pinger: the first ping at once, pings within 5 seconds become one at the end of the gap", () => {
  let now = 0;
  let sent = 0;
  const timers: { cb: () => void; at: number }[] = [];
  const p = syncPinger(() => sent++, { now: () => now, setTimer: (cb, ms) => timers.push({ cb, at: now + ms }) && timers.at(-1), clearTimer: (t) => timers.splice(timers.indexOf(t as never), 1) });
  p.ping();
  assert.equal(sent, 1);
  now = 1000;
  p.ping();
  p.ping();
  assert.equal(sent, 1);
  assert.equal(timers.length, 1, "held back once");
  assert.equal(timers[0]!.at, HUB_LIMITS.syncPingMs);
  now = timers[0]!.at;
  timers.shift()!.cb();
  assert.equal(sent, 2, "the last write is still announced");
  now += 1000;
  p.ping();
  p.cancel();
  assert.equal(timers.length, 0);
  assert.deepEqual(parseDeviceFrame(JSON.stringify({ t: "sync", extra: "x" })), { t: "sync" });
});

test("approvals: a snapshot fits one sealed message; an answer's minutes are for allow only, at most a day", () => {
  const big = Array.from({ length: 12 }, (_, i) => ({ requestId: `r${i}`, conversationId: "c1", title: "T".repeat(300), tool: "run_command", reason: "R".repeat(400), preview: "P".repeat(5000), kind: "tool" as const, forWhile: true, at: i }));
  const fit = fitApprovals(big);
  assert.equal(fit.length, HUB_LIMITS.approvalItems);
  assert.equal(fit[0]!.requestId, "r4", "the newest ones");
  assert.ok(JSON.stringify(fit).length <= HUB_LIMITS.approvalsChars);
  assert.equal(cleanApproval({ ...big[0], kind: "run", forWhile: true })!.forWhile, false, "no 'for a while' for a run");
  assert.equal(cleanApproval({ ...big[0], requestId: "../x" }), null);
  const ans = (x: Record<string, unknown>) => parseSealedBody({ type: "approval_answer", requestId: "r1", conversationId: "c1", ...x }, "approval_answer");
  assert.deepEqual(ans({ decision: "allow", forMinutes: 99_999 }), { type: "approval_answer", requestId: "r1", conversationId: "c1", decision: "allow", forMinutes: 24 * 60 });
  assert.deepEqual(ans({ decision: "deny", forMinutes: 60 }), { type: "approval_answer", requestId: "r1", conversationId: "c1", decision: "deny" });
  assert.equal(ttlFor("approvals", 7 * 24 * 3600), HUB_LIMITS.approvalTtl);
});

test("inbox_task: the gemini executor, the deferred state with its reset time, step counts; unknown executors stay as written", () => {
  const base = { type: "inbox_task", taskId: "c-1121-01", title: "Compare tools", state: "deferred", executor: "gemini", from: "claude", at: 5 };
  assert.deepEqual(parseSealedBody({ ...base, estSteps: 7, steps: 3, retryAt: 1_700_000_000_000, result: "Quota reached." }, "inbox_task"), { ...base, result: "Quota reached.", estSteps: 7, steps: 3, retryAt: 1_700_000_000_000 });
  // retryAt only means something while deferred.
  assert.equal((parseSealedBody({ ...base, state: "running", retryAt: 9 }, "inbox_task") as { retryAt?: number }).retryAt, undefined);
  // A newer PC's executor is kept as written; an odd one falls back to "claude".
  assert.equal((parseSealedBody({ ...base, executor: "mistral" }, "inbox_task") as { executor: string }).executor, "mistral");
  assert.equal((parseSealedBody({ ...base, executor: "<b>x" }, "inbox_task") as { executor: string }).executor, "claude");
  assert.equal(parseSealedBody({ ...base, state: "unknown-state" }, "inbox_task"), null);
});

test("board: caps (active and the last 20 done), the text limit, bad items and commands", () => {
  const item = (n: number, x: Partial<HubBoardItem> = {}): HubBoardItem => ({ id: `t${n}`, title: `Task ${n} ${"x".repeat(190)}`, status: "open", size: "big", priority: 5, at: n, ...x });
  const all = [
    ...Array.from({ length: 70 }, (_, n) => item(n + 1)),
    ...Array.from({ length: 30 }, (_, n) => item(100 + n, { status: "done", result: "r".repeat(300) })),
    item(200, { status: "claimed", owner: "claude", priority: 9 }),
  ];
  const fit = fitBoard(all);
  assert.equal(fit.items.filter((i) => i.status !== "done").length, HUB_LIMITS.boardActive, "active items are capped");
  assert.equal(fit.items[0]!.id, "t200", "taken ones first");
  assert.equal(fit.doneTotal, 30);
  assert.ok(fit.items.filter((i) => i.status === "done").length <= HUB_LIMITS.boardDone);
  assert.ok(fit.items.filter((i) => i.status === "done").every((i) => i.at >= 110), "the newest done ones");
  assert.ok(JSON.stringify(fit.items).length <= HUB_LIMITS.boardChars, "one snapshot fits one sealed message");
  assert.equal(fitBoard([item(1, { id: "../x" }), item(2, { status: "weird" as never })]).items.length, 0, "bad items are dropped");
  const body = parseSealedBody({ type: "board", rev: 3, items: [...fit.items, { nope: 1 }], doneTotal: 30, at: 9 }, "board");
  assert.equal((body as { items: unknown[] }).items.length, fit.items.length);
  assert.equal(parseSealedBody({ type: "board", rev: 3, items: [] }, "approvals"), null, "a kind cannot be swapped");
  assert.equal(ttlFor("board", 7 * 24 * 3600), HUB_LIMITS.approvalTtl);
  assert.deepEqual(cleanBoardCommand({ op: "note", text: `  ${"n".repeat(2000)}` })!.op, "note");
  assert.equal(cleanBoardCommand({ op: "note", text: "   " }), null);
  assert.equal(cleanBoardCommand({ op: "delete" }), null);
  const cmd = (board: unknown) => parseSealedBody({ type: "command", commandId: "c1", action: "board", taskId: "t4", board }, "command");
  assert.deepEqual(cmd({ op: "for-kesher", on: false }), { type: "command", commandId: "c1", action: "board", taskId: "t4", board: { op: "for-kesher", on: false } });
  assert.equal(cmd({ op: "rm" }), null);
});

test("board: filters, who an item is for, waiting on me", () => {
  const it = (id: string, x: Partial<HubBoardItem>): HubBoardItem => ({ id, title: id, status: "open", size: "big", priority: 5, at: 1, ...x });
  const items = [it("t1", {}), it("t2", { size: "small" }), it("t3", { status: "blocked", owner: "claude" }), it("t4", { status: "claimed", owner: "roee" }), it("t5", { status: "done", owner: "kesher" }), it("t6", { forKesher: true }), it("t7", { fable: true, size: "small" })];
  assert.equal(boardWho(items[1]!), "kesher");
  assert.equal(boardWho(items[0]!), "claude");
  assert.equal(boardWho(items[5]!), "kesher");
  assert.equal(boardWho(items[6]!), "claude", "Fable tasks are Claude's");
  assert.deepEqual(boardView(items, "open").map((i) => i.id), ["t1", "t2", "t3", "t4", "t6", "t7"]);
  assert.deepEqual(boardView(items, "me").map((i) => i.id), ["t3", "t4"]);
  assert.deepEqual(boardView(items, "done").map((i) => i.id), ["t5"]);
  assert.deepEqual(boardView(items, "open", "kesher").map((i) => i.id), ["t2", "t6"]);
  assert.equal(boardWaitsOnMe(items[4]!), false);
});

test("the away frame: asleep or awake, with a clean note; anything else is refused", () => {
  const f = parseDeviceFrame(JSON.stringify({ t: "away", state: "asleep", note: { downloads: 3, tasks: -1, selfWork: true, secret: "x" } }));
  assert.deepEqual(f, { t: "away", state: "asleep", note: { downloads: 3, selfWork: true } });
  assert.equal(parseDeviceFrame(JSON.stringify({ t: "away", state: "awake" }))?.t, "away");
  assert.equal(parseDeviceFrame(JSON.stringify({ t: "away", state: "dead" })), null);
});
