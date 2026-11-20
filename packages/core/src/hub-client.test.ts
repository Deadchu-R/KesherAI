import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateHubKeys, openEnvelope, sealMessage, type HubFrame, type SealedBody, type SealedEnvelope } from "@kesher/shared";
import type { InboxTaskView } from "@kesher/shared";
import { cleanHubUrl, HubClient, hubInboxTask, type HubSettings, type HubSocketEvents } from "./hub-client.js";
import { TaskBoard } from "./task-board.js";

const settings = (): HubSettings => ({ enabled: true, url: "https://hub.example.test", reported: [], optIn: { appear: true, acceptTasks: false, acceptLocal: false, acceptAntigravity: false, reportLinks: false } });

/** A fake hub: answers pairing and tickets, and records what the PC sends on its socket. */
async function rig() {
  const dir = await mkdtemp(join(tmpdir(), "kesher-hubc-"));
  const s = settings();
  const board = new TaskBoard(join(dir, "board.json"));
  const sent: Array<Record<string, unknown>> = [];
  const calls: Array<{ path: string; auth?: string }> = [];
  let events: HubSocketEvents | undefined;
  let socketUrl = "";
  let polls = 0;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const auth = (init.headers as Record<string, string>).authorization;
    calls.push({ path, ...(auth ? { auth } : {}) });
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (path === "/api/pair/start") return reply({ code: "ABCD-EFGH", pollSecret: "poll", expiresIn: 300 });
    if (path === "/api/pair/poll") return reply(++polls < 2 ? { status: "pending" } : { status: "paired", deviceId: "dpc", token: "kh_secret_token", hubKey: "" });
    if (path === "/api/ticket") return reply({ ticket: "tick1", rotateDue: false });
    return reply({ error: "no" }, 404);
  }) as unknown as typeof fetch;
  const notes: string[] = [];
  const activity = { cancelled: [] as string[], slowed: 0, has: (id: string) => id.startsWith("h-"), cancel: async (id: string) => (activity.cancelled.push(id), true), slowDown: () => void activity.slowed++ };
  const client = new HubClient({
    activity,
    settings: () => s,
    persist: async () => undefined,
    board,
    version: "test",
    notify: (t, b) => notes.push(`${t}: ${b}`),
    fetch: fakeFetch,
    deviceName: "Test PC",
    openSocket: (url, on) => {
      socketUrl = url;
      events = on;
      queueMicrotask(() => on.open());
      return { send: (t) => sent.push(JSON.parse(t) as Record<string, unknown>), close: () => undefined };
    },
  });
  return { dir, s, board, sent, calls, client, notes, activity, events: () => events!, socketUrl: () => socketUrl, done: () => rm(dir, { recursive: true, force: true }) };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("hub address: https only (http just for this computer)", () => {
  assert.equal(cleanHubUrl("https://hub.example.test/"), "https://hub.example.test");
  assert.equal(cleanHubUrl("http://hub.example.test"), undefined);
  assert.equal(cleanHubUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.equal(cleanHubUrl("https://u:p@hub.example.test"), undefined);
  assert.equal(cleanHubUrl("not a url"), undefined);
});

test("pairs, connects with a one-use ticket, takes a sealed task onto the board once, and reports the result", async (t) => {
  const r = await rig();
  t.after(() => {
    r.client.stop();
    return r.done();
  });
  const p = await r.client.pair();
  assert.equal(p.code, "ABCD-EFGH");
  assert.match(p.fingerprint, /^\d{3} \d{3}$/);
  for (let i = 0; i < 50 && !r.s.token; i++) await wait(100);
  assert.equal(r.s.deviceId, "dpc");
  // The status never shows the token or the key.
  assert.ok(!JSON.stringify(r.client.status()).includes("kh_secret") && !JSON.stringify(r.client.status()).includes('"d"'));

  for (let i = 0; i < 50 && !r.client.status().connected; i++) await wait(20);
  assert.equal(r.socketUrl(), "wss://hub.example.test/ws/device?ticket=tick1", "the token is not in the socket address");
  assert.equal(r.calls.find((c) => c.path === "/api/ticket")?.auth, "Bearer kh_secret_token");
  assert.equal(r.sent[0]?.t, "hello");

  // The phone and the presence the hub sends.
  const phone = await generateHubKeys(false);
  const pcPub = (await import("@kesher/shared")).importPrivateJwk(r.s.key!).then((k) => k.publicKey);
  await r.client.onMessage(JSON.stringify({ t: "welcome", deviceId: "dpc", hubKey: "", paused: false, rotateDue: false, presence: [{ id: "dphone", name: "Phone", kind: "phone", publicKey: phone.publicKey, online: true, busy: false, agents: [], optIn: {} }] } satisfies Partial<HubFrame> & { t: "welcome" }));
  const task: SealedBody = { type: "task", taskId: "task-1", title: "Fix the failing test", spec: "pnpm test", executor: "auto", ifOffline: "wait", createdAt: "" };
  const deliver = async (env: SealedEnvelope) => r.client.onMessage(JSON.stringify({ t: "deliver", env }));

  // Not opted in: refused with a sealed "blocked" result, nothing on the board, and acked.
  const e1 = await sealMessage({ from: "dphone", to: "dpc", kind: "task" }, task, phone.privateKey, await pcPub);
  await deliver(e1);
  assert.equal((await r.board.read()).tasks.length, 0);
  const refused = r.sent.filter((f) => f.t === "send").at(-1)!.env as SealedEnvelope;
  assert.equal(((await openEnvelope(refused, phone.privateKey, await pcPub)) as { status: string }).status, "blocked");
  assert.ok(r.sent.some((f) => f.t === "ack" && f.id === e1.id));

  // Opted in: on the board once, even when delivered again with a new envelope id.
  await r.client.setOptIn({ acceptTasks: true });
  await deliver(await sealMessage({ from: "dphone", to: "dpc", kind: "task" }, task, phone.privateKey, await pcPub));
  await deliver(await sealMessage({ from: "dphone", to: "dpc", kind: "task" }, task, phone.privateKey, await pcPub));
  const tasks = (await r.board.read()).tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.title, "Fix the failing test");
  assert.match(tasks[0]!.details!, /hub-task:task-1:dphone/);
  assert.equal(r.notes.length, 1);

  // A tampered envelope is dropped, never acted on.
  const bad = await sealMessage({ from: "dphone", to: "dpc", kind: "task" }, { ...task, taskId: "task-2" }, phone.privateKey, await pcPub);
  await deliver({ ...bad, ct: bad.ct.slice(0, -4) + (bad.ct.endsWith("AAAA") ? "BBBB" : "AAAA") });
  assert.equal((await r.board.read()).tasks.length, 1);
  assert.ok(r.sent.some((f) => f.t === "ack" && f.id === bad.id));

  // The board item is done: one sealed result goes back to the phone.
  await r.board.change("kesher", [{ op: "done", id: tasks[0]!.id, result: "Fixed in commit abc" }]);
  const before = r.sent.length;
  await r.client.reportResults();
  await r.client.reportResults();
  const results = r.sent.slice(before).filter((f) => f.t === "send");
  assert.equal(results.length, 1);
  const body = await openEnvelope(results[0]!.env as SealedEnvelope, phone.privateKey, await pcPub);
  assert.deepEqual(body, { type: "result", taskId: "task-1", status: "done", text: "Fixed in commit abc" });
  assert.deepEqual(r.s.reported, ["task-1"]);

  // Live agent activity: nothing until the opt-in; then one sealed batch per (phone, run) in an agents frame.
  const batch = { runId: "h-1", state: { runId: "h-1", title: "Look into it", source: "chat-helper" as const, state: "running" as const, step: 1, startedAt: 1, lastEventAt: 2, files: 0, fileNames: [] }, events: [{ seq: 1, t: 2, type: "step" as const, n: 1, label: "read_file" }] };
  const n0 = r.sent.length;
  await r.client.sendActivity([batch]);
  assert.equal(r.sent.length, n0, "reportActivity is off by default");
  await r.client.setOptIn({ reportActivity: true });
  await r.client.sendActivity([batch]);
  const frame = r.sent.filter((f) => f.t === "agents").at(-1) as { envs: SealedEnvelope[] };
  assert.equal(frame.envs.length, 1);
  assert.equal(frame.envs[0]!.run, "h-1");
  assert.equal(frame.envs[0]!.n, 1);
  assert.deepEqual(await openEnvelope(frame.envs[0]!, phone.privateKey, await pcPub), { type: "agent_event", ...batch });
  // Stop on an agent card reaches the run; a cancel of a hub task still goes to its board item.
  await deliver(await sealMessage({ from: "dphone", to: "dpc", kind: "cancel" }, { type: "cancel", taskId: "h-1" }, phone.privateKey, await pcPub));
  assert.deepEqual(r.activity.cancelled, ["h-1"]);
  await r.client.onMessage(JSON.stringify({ t: "refused", code: "rate-limited" }));
  assert.equal(r.activity.slowed, 1);

  // Revoked by the hub: the token is forgotten.
  await r.client.onMessage(JSON.stringify({ t: "revoked" }));
  assert.equal(r.s.token, undefined);
  assert.equal(r.client.status().paired, false);
});

test("a PC that pairs while Off turns On and connects at once; a cut link reconnects; errors have codes", async (t) => {
  const r = await rig();
  t.after(() => {
    r.client.stop();
    return r.done();
  });
  r.s.enabled = false;
  await r.client.pair();
  for (let i = 0; i < 100 && !r.client.status().connected; i++) await wait(50);
  assert.equal(r.s.enabled, true, "pairing turns the link on");
  assert.equal(r.client.status().connected, true, "and it connects without the On switch");
  assert.ok(r.client.status().lastConnectedAt);

  // The hub cuts the link: it retries by itself (a backoff from about 1 s) and says why meanwhile.
  r.events().close();
  const st = r.client.status();
  assert.equal(st.connected, false);
  assert.equal(st.errorCode, "socket");
  assert.ok(st.nextRetryAt && Date.parse(st.nextRetryAt) - Date.now() <= 1000);
  // "Try now" (the On switch again) does not wait for the backoff.
  await r.client.setEnabled(true);
  for (let i = 0; i < 50 && !r.client.status().connected; i++) await wait(20);
  assert.equal(r.client.status().connected, true);
  assert.equal(r.client.status().errorCode, undefined);
});

test("connection problems: unreachable retries, a refused PC must pair again", async () => {
  const s = settings();
  s.token = "kh_t";
  s.deviceId = "dpc";
  let mode: "down" | "refuse" = "down";
  const client = new HubClient({
    settings: () => s,
    persist: async () => undefined,
    version: "test",
    fetch: (async () => {
      if (mode === "down") throw new TypeError("fetch failed");
      return new Response("{}", { status: 401 });
    }) as unknown as typeof fetch,
    openSocket: () => assert.fail("no socket without a ticket"),
  });
  client.start();
  await wait(20);
  assert.equal(client.status().errorCode, "unreachable");
  assert.ok(client.status().nextRetryAt, "it keeps retrying");
  mode = "refuse";
  client.start(); // "Try now"
  await wait(20);
  assert.equal(client.status().errorCode, "refused");
  assert.equal(client.status().paired, false);
  client.stop();
});

const inboxTask = (over: Partial<InboxTaskView>): InboxTaskView => ({ id: "c-1120-01", title: "Fix the hub status", executor: "auto", risk: "low", from: "claude", base: "origin/main", allowedPaths: [], forbiddenPaths: [], check: "", maxMinutes: 30, maxFiles: 15, goal: "SECRET GOAL TEXT", status: "waiting", runBy: "antigravity", branch: "agy/c-1120-01-fix", ...over });

test("inbox tasks map to the hub's states and executors, metadata only", () => {
  const w = hubInboxTask(inboxTask({}), 1)!;
  assert.deepEqual(w, { taskId: "c-1120-01", title: "Fix the hub status", state: "waiting-run", executor: "antigravity", from: "claude", runId: "in-c-1120-01", at: 1 });
  assert.equal(hubInboxTask(inboxTask({ status: "running", startedAt: 1 }), 1)!.branch, "agy/c-1120-01-fix");
  const done = hubInboxTask(inboxTask({ status: "done", startedAt: 1, summary: "Fixed the dot.\nAll checks pass." }), 1)!;
  assert.equal(done.state, "done");
  assert.equal(done.result, "Fixed the dot. All checks pass.");
  assert.equal(done.runId, undefined);
  assert.equal(hubInboxTask(inboxTask({ status: "partial", startedAt: 1 }), 1)!.state, "partial");
  assert.equal(hubInboxTask(inboxTask({ status: "declined", note: "Touches release files." }), 1)!.state, "failed");
  assert.equal(hubInboxTask(inboxTask({ status: "queued", runBy: "local", branch: "local/x" }), 1)!.state, "waiting");
  assert.equal(hubInboxTask(inboxTask({ status: "queued", runBy: "local" }), 1)!.executor, "local");
  assert.equal(hubInboxTask(inboxTask({ status: "queued", runBy: "opus" }), 1)!.executor, "claude");
  assert.equal(hubInboxTask(inboxTask({ from: "hub" }), 1), undefined, "the hub page already lists its own tasks");
  for (const st of ["waiting", "running", "done", "failed"] as const) assert.ok(!JSON.stringify(hubInboxTask(inboxTask({ status: st }), 1)).includes("SECRET"), "never the task's text");
});

test("inbox reports go sealed to each phone, only when a task changed", async (t) => {
  const r = await rig();
  t.after(() => {
    r.client.stop();
    return r.done();
  });
  let tasks = [inboxTask({})];
  (r.client as unknown as { deps: { inboxTasks: () => Promise<InboxTaskView[]> } }).deps.inboxTasks = async () => tasks;
  await r.client.pair();
  for (let i = 0; i < 100 && !r.client.status().connected; i++) await wait(50);
  const phone = await generateHubKeys(false);
  const pcPub = await (await import("@kesher/shared")).importPrivateJwk(r.s.key!).then((k) => k.publicKey);
  await r.client.onMessage(JSON.stringify({ t: "welcome", deviceId: "dpc", hubKey: "", paused: false, rotateDue: false, presence: [{ id: "dphone", name: "Phone", kind: "phone", publicKey: phone.publicKey, online: true, busy: false, agents: [], optIn: {} }] }));
  await r.client.reportInbox();
  const sends = () => r.sent.filter((f) => f.t === "send" && (f.env as SealedEnvelope).kind === "inbox_task").map((f) => f.env as SealedEnvelope);
  assert.equal(sends().length, 1);
  const first = (await openEnvelope(sends()[0]!, phone.privateKey, pcPub)) as { state: string; from: string };
  assert.equal(first.state, "waiting-run");
  assert.equal(first.from, "claude");
  assert.ok(sends()[0]!.ttl >= 24 * 3600, "kept for a phone that is off");
  await r.client.reportInbox();
  assert.equal(sends().length, 1, "nothing changed, nothing sent");
  tasks = [inboxTask({ status: "done", startedAt: 1, summary: "Done." })];
  await r.client.reportInbox();
  assert.equal(sends().length, 2);
  assert.equal(((await openEnvelope(sends()[1]!, phone.privateKey, pcPub)) as { branch?: string }).branch, "agy/c-1120-01-fix");
});

test("approvals: one sealed snapshot to online phones when the set changes; answers only from a phone, with Allow for a while", async (t) => {
  const r = await rig();
  t.after(() => {
    r.client.stop();
    return r.done();
  });
  let pending = [{ conversationId: "c1", requestId: "r1", title: "Fix the build", tool: "run_command", preview: "pnpm test", reason: "Runs a command", forWhile: true, at: "2026-11-20T12:00:00Z" }];
  const answers: Array<{ requestId: string; decision: string; from?: { id: string; kind?: string }; forMinutes?: number }> = [];
  (r.client as unknown as { deps: { approvals: unknown } }).deps.approvals = {
    pending: () => pending,
    answer: async (_c: string, requestId: string, decision: string, from?: { id: string; kind?: string }, forMinutes?: number) => (answers.push({ requestId, decision, ...(from ? { from } : {}), ...(forMinutes ? { forMinutes } : {}) }), true),
  };
  await r.client.pair();
  for (let i = 0; i < 100 && !r.client.status().connected; i++) await wait(50);
  const phone = await generateHubKeys(false);
  const other = await generateHubKeys(false);
  const pcPub = await (await import("@kesher/shared")).importPrivateJwk(r.s.key!).then((k) => k.publicKey);
  const presence = [
    { id: "dphone", name: "Phone", kind: "phone", publicKey: phone.publicKey, online: true, busy: false, agents: [], optIn: {} },
    { id: "dpc2", name: "Other PC", kind: "pc", publicKey: other.publicKey, online: true, busy: false, agents: [], optIn: {} },
  ];
  await r.client.onMessage(JSON.stringify({ t: "welcome", deviceId: "dpc", hubKey: "", paused: false, rotateDue: false, presence }));
  await r.client.sendApprovals();
  const snaps = () => r.sent.filter((f) => f.t === "send" && (f.env as SealedEnvelope).kind === "approvals").map((f) => f.env as SealedEnvelope);
  assert.equal(snaps().length, 1, "to the phone only, not the other PC");
  assert.equal(snaps()[0]!.to, "dphone");
  const body = (await openEnvelope(snaps()[0]!, phone.privateKey, pcPub)) as Extract<SealedBody, { type: "approvals" }>;
  assert.equal(body.items[0]!.title, "Fix the build");
  assert.equal(body.items[0]!.forWhile, true);
  assert.equal(body.items[0]!.at, Date.parse("2026-11-20T12:00:00Z"));
  await r.client.sendApprovals();
  assert.equal(snaps().length, 1, "nothing changed, nothing sent");
  // Answers: the other PC's is ignored; the phone's goes through with its minutes.
  const answer: SealedBody = { type: "approval_answer", requestId: "r1", conversationId: "c1", decision: "allow", forMinutes: 60 };
  const fromPc = await sealMessage({ from: "dpc2", to: "dpc", kind: "approval_answer" }, answer, other.privateKey, pcPub);
  await r.client.onMessage(JSON.stringify({ t: "deliver", env: fromPc }));
  assert.equal(answers.length, 0, "a PC cannot answer approvals");
  const fromPhone = await sealMessage({ from: "dphone", to: "dpc", kind: "approval_answer" }, answer, phone.privateKey, pcPub);
  await r.client.onMessage(JSON.stringify({ t: "deliver", env: fromPhone }));
  assert.deepEqual(answers, [{ requestId: "r1", decision: "allow", from: { id: "dphone", kind: "phone" }, forMinutes: 60 }]);
  // The answered request leaves the list: a new (empty) snapshot goes at once.
  pending = [];
  await r.client.sendApprovals();
  assert.equal(snaps().length, 2);
  assert.deepEqual(((await openEnvelope(snaps()[1]!, phone.privateKey, pcPub)) as { items: unknown[] }).items, []);
});

test("Run / Cancel commands: only from a paired phone; the PC answers sealed with the result", async (t) => {
  const r = await rig();
  t.after(() => {
    r.client.stop();
    return r.done();
  });
  const did: string[] = [];
  (r.client as unknown as { deps: { inboxCommand: unknown } }).deps.inboxCommand = async (action: string, taskId: string, from: { id: string; kind: string }) => (did.push(`${action} ${taskId} ${from.id} ${from.kind}`), { ok: true, text: "Started on the PC." });
  await r.client.pair();
  for (let i = 0; i < 100 && !r.client.status().connected; i++) await wait(50);
  const phone = await generateHubKeys(false);
  const other = await generateHubKeys(false);
  const pcPub = await (await import("@kesher/shared")).importPrivateJwk(r.s.key!).then((k) => k.publicKey);
  const presence = [
    { id: "dphone", name: "Phone", kind: "phone", publicKey: phone.publicKey, online: true, busy: false, agents: [], optIn: {} },
    { id: "dpc2", name: "Other PC", kind: "pc", publicKey: other.publicKey, online: true, busy: false, agents: [], optIn: {} },
  ];
  await r.client.onMessage(JSON.stringify({ t: "welcome", deviceId: "dpc", hubKey: "", paused: false, rotateDue: false, presence }));
  const cmd: SealedBody = { type: "command", commandId: "k1", action: "inbox-run", taskId: "agy-1" };
  await r.client.onMessage(JSON.stringify({ t: "deliver", env: await sealMessage({ from: "dpc2", to: "dpc", kind: "command" }, cmd, other.privateKey, pcPub) }));
  assert.deepEqual(did, [], "a PC cannot press Run");
  await r.client.onMessage(JSON.stringify({ t: "deliver", env: await sealMessage({ from: "dphone", to: "dpc", kind: "command" }, cmd, phone.privateKey, pcPub) }));
  assert.deepEqual(did, ["inbox-run agy-1 dphone phone"]);
  const res = r.sent.filter((f) => f.t === "send" && (f.env as SealedEnvelope).kind === "command_result").map((f) => f.env as SealedEnvelope);
  assert.equal(res.length, 1);
  assert.deepEqual(await openEnvelope(res[0]!, phone.privateKey, pcPub), { type: "command_result", commandId: "k1", taskId: "agy-1", ok: true, text: "Started on the PC." });
});
