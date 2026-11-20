import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseRoute } from "./hub-route.js";
import { cleanAgents, DEFAULT_OPT_IN, HUB_LIMITS, isSafeLink, parseDeviceFrame, parseEnvelope, parseSealedBody, syncPinger, ttlFor, type HubPresence } from "./hub-protocol.js";

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
