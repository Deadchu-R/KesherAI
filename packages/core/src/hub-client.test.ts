import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateHubKeys, openEnvelope, pairChannel, sealMessage, type HubFrame, type SealedBody, type SealedEnvelope } from "@kesher/shared";
import type { InboxTaskView } from "@kesher/shared";
import { afterUtcMidnight, askNoteOf, cleanHubUrl, HubClient, hubInboxTask, type HubClientDeps, type HubSettings, type HubSocketEvents } from "./hub-client.js";
import { TaskBoard } from "./task-board.js";

const settings = (): HubSettings => ({ enabled: true, url: "https://hub.example.test", reported: [], optIn: { appear: true, acceptTasks: false, acceptLocal: false, acceptAntigravity: false, reportLinks: false } });

/** A fake hub: answers pairing and tickets, and records what the PC sends on its socket. */
async function rig(extra: Partial<HubClientDeps> = {}) {
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
    ...extra,
  });
  return { dir, s, board, sent, calls, client, notes, activity, events: () => events!, socketUrl: () => socketUrl, done: () => rm(dir, { recursive: true, force: true }) };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the hello carries this PC's tailnet addresses (the phone's backup path), and again when they change", async (t) => {
  let direct: { url?: string; ip?: string } | undefined = { ip: "100.64.0.9" };
  const r = await rig({ direct: () => direct });
  t.after(() => {
    r.client.stop();
    return r.done();
  });
  Object.assign(r.s, { token: "kh_secret_token", deviceId: "dpc" });
  r.client.start();
  for (let i = 0; i < 50 && !r.client.status().connected; i++) await wait(20);
  assert.deepEqual(r.sent[0], { ...r.sent[0], t: "hello", direct: { ip: "100.64.0.9" } });
  direct = { url: "https://pc.tail1.ts.net", ip: "100.64.0.9" };
  r.client.sayHello();
  assert.deepEqual(r.sent.filter((f) => f.t === "hello").at(-1)?.direct, direct);
});

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

test("the hub's daily storage limit: shown with its own code, and the next try is after 00:00 UTC (not in minutes)", async () => {
  const s = settings();
  s.token = "kh_t";
  s.deviceId = "dpc";
  let tries = 0;
  const client = new HubClient({
    settings: () => s,
    persist: async () => undefined,
    version: "test",
    fetch: (async () => {
      tries++;
      return new Response(JSON.stringify({ error: "hub-storage-limit" }), { status: 503 });
    }) as unknown as typeof fetch,
    openSocket: () => assert.fail("no socket without a ticket"),
  });
  client.start();
  await wait(20);
  const st = client.status();
  assert.equal(st.errorCode, "hub-limit");
  assert.equal(st.paused, false, "not mistaken for a paused hub");
  assert.equal(tries, 1);
  // In the first hour after 00:00 UTC it tries again in 15 minutes (the hub can lag its reset); otherwise after the reset.
  const firstHour = afterUtcMidnight(Date.now(), 0) - Date.now() > 23 * 3600_000;
  const next = Date.parse(st.nextRetryAt!);
  assert.ok(firstHour ? next >= Date.now() + 14 * 60_000 && next <= Date.now() + 16 * 60_000 : next >= afterUtcMidnight(Date.now(), 0) - 1000, "waits for the reset");
  assert.equal(s.token, "kh_t", "the pairing is kept");
  client.stop();
});

test("afterUtcMidnight: one to five minutes after the next 00:00 UTC", () => {
  const now = Date.UTC(2026, 10, 22, 10, 11);
  assert.equal(afterUtcMidnight(now, 0), Date.UTC(2026, 10, 23, 0, 1));
  assert.equal(afterUtcMidnight(now, 0.999), Date.UTC(2026, 10, 23, 0, 4, 59, 760));
});

const inboxTask = (over: Partial<InboxTaskView>): InboxTaskView => ({ id: "c-1120-01", title: "Fix the hub status", executor: "auto", risk: "low", from: "claude", base: "origin/main", allowedPaths: [], forbiddenPaths: [], check: "", maxMinutes: 30, maxFiles: 15, goal: "SECRET GOAL TEXT", status: "waiting", runBy: "antigravity", branch: "agy/c-1120-01-fix", ...over });

test("a free-Gemini task keeps its own executor; a quota deferral carries the reset time, a running task its steps", () => {
  const g = inboxTask({ runBy: "gemini", kind: "research", acceptance: "- a\n- b", branch: "gemini/x" });
  assert.equal(hubInboxTask(g, 1)!.executor, "gemini");
  assert.equal(hubInboxTask(g, 1)!.estSteps, 5);
  const d = hubInboxTask({ ...g, status: "deferred-quota", retryAt: 99, note: "Quota reached." }, 1)!;
  assert.equal(d.state, "deferred");
  assert.equal(d.retryAt, 99);
  assert.equal(d.result, "Quota reached.");
  // Antigravity's deferral keeps the old state, so an older page still lists it.
  assert.equal(hubInboxTask(inboxTask({ status: "deferred-quota" }), 1)!.state, "waiting-run");
  assert.equal(hubInboxTask(inboxTask({ status: "running", startedAt: 1, steps: 4 }), 1)!.steps, 4);
  assert.equal(hubInboxTask({ ...g, status: "done", startedAt: 1, summary: "Report." }, 1)!.result, "Report.");
  });

  test("a task with a plan: the hub's step count is the plan's items, not the formula", () => {
  const plan = ["read the file", "fix it", "typecheck", "test", "report"].map((content) => ({ content, status: "pending" }));
  assert.equal(hubInboxTask(inboxTask({ plan }), 1)!.estSteps, 5, "the formula would say 3 + 15 + 1");
  assert.equal(hubInboxTask(inboxTask({ plan: [] }), 1)!.estSteps, 3 + 15 + 1, "an empty plan falls back to the formula");
  });

  test("inbox tasks map to the hub's states and executors, metadata only", () => {
  const w = hubInboxTask(inboxTask({}), 1)!;
  assert.deepEqual(w, { taskId: "c-1120-01", title: "Fix the hub status", state: "waiting-run", executor: "antigravity", from: "claude", estSteps: 3 + 15 + 1, runId: "in-c-1120-01", kind: "code", at: 1 });
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

test("inbox reports carry who works on what: model, priority, queue place, kind, times and the cause", () => {
  const w = hubInboxTask(inboxTask({ boardId: "t12", model: "Gemini 3 Pro" }), 5, { priority: 2, queuePos: 3 })!;
  assert.equal(w.model, "Gemini 3 Pro");
  assert.equal(w.boardId, "t12");
  assert.equal(w.priority, 2);
  assert.equal(w.queuePos, 3);
  // The queue place only means something while it waits; a model the agent named wins over the one asked for.
  assert.equal(hubInboxTask(inboxTask({ status: "running", startedAt: 7, model: "a", modelUsed: "b" }), 5, { queuePos: 1 })!.queuePos, undefined);
  assert.equal(hubInboxTask(inboxTask({ status: "running", startedAt: 7, model: "a", modelUsed: "b" }), 5)!.model, "b");
  assert.equal(hubInboxTask(inboxTask({ status: "running", startedAt: 7 }), 5)!.startedAt, 7);
  assert.equal(hubInboxTask(inboxTask({ status: "running", startedAt: 7, endedAt: 9 }), 5)!.endedAt, undefined, "not ended yet");
  const failed = hubInboxTask(inboxTask({ status: "failed", startedAt: 7, endedAt: 9, note: "The check failed:\n lint has 2 errors." }), 5)!;
  assert.equal(failed.endedAt, 9);
  assert.equal(failed.cause, "The check failed: lint has 2 errors.");
  assert.equal(hubInboxTask(inboxTask({ status: "done", startedAt: 7, endedAt: 9, summary: "ok" }), 5)!.cause, undefined, "a done task has no cause");
  assert.equal(hubInboxTask(inboxTask({ kind: "research" }), 5)!.kind, "research");
  assert.equal(hubInboxTask(inboxTask({ title: "Convert the Unity bridge to 2020.3" }), 5)!.kind, "conversion");
  assert.equal(hubInboxTask(inboxTask({ boardId: "../x" }), 5)!.boardId, undefined, "an odd board id is dropped");
  assert.ok(!JSON.stringify(w).includes("SECRET"), "never the task's text");
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

test("approvals: one sealed snapshot to phones when the set changes (with the waiting count, offline phones too); answers only from a phone, with Allow for a while", async (t) => {
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
    { id: "dphone2", name: "Phone 2", kind: "phone", publicKey: other.publicKey, online: false, busy: false, agents: [], optIn: {} },
  ];
  await r.client.onMessage(JSON.stringify({ t: "welcome", deviceId: "dpc", hubKey: "", paused: false, rotateDue: false, presence }));
  await r.client.sendApprovals();
  const all = () => r.sent.filter((f) => f.t === "send" && (f.env as SealedEnvelope).kind === "approvals").map((f) => f.env as SealedEnvelope);
  // The offline phone gets each change too (for its "N waiting" push); the rest of this test follows the online one.
  const snaps = () => all().filter((e) => e.to === "dphone");
  assert.deepEqual(all().map((e) => [e.to, e.waiting]), [["dphone", 1], ["dphone2", 1]], "to the phones only (online and off), not the other PC, with the count");
  const body = (await openEnvelope(snaps()[0]!, phone.privateKey, pcPub)) as Extract<SealedBody, { type: "approvals" }>;
  assert.equal(body.items[0]!.title, "Fix the build");
  assert.equal(body.items[0]!.forWhile, true);
  assert.equal(body.items[0]!.at, Date.parse("2026-11-20T12:00:00Z"));
  await r.client.sendApprovals();
  assert.equal(all().length, 2, "nothing changed, nothing sent");
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
  assert.equal(snaps()[1]!.waiting, 0);
  assert.deepEqual(((await openEnvelope(snaps()[1]!, phone.privateKey, pcPub)) as { items: unknown[] }).items, []);
});

test("ask notes: the newest ask (an Antigravity Run first) rides each phone's snapshot sealed to that phone; the notification's answer reaches the app as a phone's", async (t) => {
  const r = await rig();
  t.after(() => {
    r.client.stop();
    return r.done();
  });
  const pending = [
    { conversationId: "c1", requestId: "r1", title: "Fix the build", tool: "run_command", preview: "pnpm test", reason: "Runs a command", at: "2026-11-20T12:00:00Z" },
    { conversationId: "task-inbox", requestId: "a1b2c3", title: "Run in Antigravity? Fix the hub status", tool: "antigravity", preview: "SECRET GOAL", reason: "One tap runs this once.", who: "Antigravity", kind: "run" as const, at: "2026-11-20T12:05:00Z", until: "2099-01-01T00:00:00Z" },
  ];
  const answers: Array<{ conversationId: string; requestId: string; decision: string; from?: { id: string; kind?: string } }> = [];
  (r.client as unknown as { deps: { approvals: unknown } }).deps.approvals = {
    pending: () => pending,
    answer: async (conversationId: string, requestId: string, decision: string, from?: { id: string; kind?: string }) => (answers.push({ conversationId, requestId, decision, ...(from ? { from } : {}) }), true),
  };
  await r.client.pair();
  for (let i = 0; i < 100 && !r.client.status().connected; i++) await wait(50);
  const phone = await generateHubKeys(false);
  const pcPub = await (await import("@kesher/shared")).importPrivateJwk(r.s.key!).then((k) => k.publicKey);
  await r.client.onMessage(JSON.stringify({ t: "welcome", deviceId: "dpc", hubKey: "", paused: false, rotateDue: false, presence: [{ id: "dphone", name: "Phone", kind: "phone", publicKey: phone.publicKey, online: false, busy: false, agents: [], optIn: {} }] }));
  await r.client.sendApprovals();
  const env = r.sent.filter((f) => f.t === "send").map((f) => f.env as SealedEnvelope).find((e) => e.kind === "approvals")!;
  assert.ok(env.note && env.note.kind === "ask_note" && env.note.to === "dphone" && env.note.from === "dpc");
  assert.ok(!JSON.stringify(env.note).includes("Fix the hub status"), "sealed");
  const note = await openEnvelope(env.note, phone.privateKey, pcPub);
  assert.deepEqual(note, { type: "ask_note", ask: { requestId: "a1b2c3", conversationId: "task-inbox", kind: "run", title: "Fix the hub status", until: Date.parse("2099-01-01T00:00:00Z") }, waiting: 2 });
  // The service worker's answer (the same sealed approval_answer) goes to the app as from that phone: server.ts sends
  // a task-inbox one to answerRun with "hub:<device>".
  const answer = await sealMessage({ from: "dphone", to: "dpc", kind: "approval_answer" }, { type: "approval_answer", requestId: "a1b2c3", conversationId: "task-inbox", decision: "allow" }, phone.privateKey, pcPub);
  await r.client.onMessage(JSON.stringify({ t: "deliver", env: answer }));
  assert.deepEqual(answers, [{ conversationId: "task-inbox", requestId: "a1b2c3", decision: "allow", from: { id: "dphone", kind: "phone" } }]);
});

test("askNoteOf: the newest ask, its own expiry or 30 minutes, nothing when it ended", () => {
  const now = Date.parse("2026-11-20T12:10:00Z");
  const tool = { conversationId: "c1", requestId: "r1", title: "", tool: "run_command", preview: "", reason: "", at: "2026-11-20T12:00:00Z" };
  assert.deepEqual(askNoteOf([tool], now), { requestId: "r1", conversationId: "c1", kind: "tool", title: "run_command", until: Date.parse("2026-11-20T12:30:00Z") });
  assert.equal(askNoteOf([tool], Date.parse("2026-11-20T12:30:00Z")), undefined, "an ended ask is not shown");
  assert.equal(askNoteOf([], now), undefined);
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

test("board: one sealed snapshot to the online phones, on change only; a board command from a phone is applied as Roee", async (t) => {
  const r = await rig();
  t.after(() => {
    r.client.stop();
    return r.done();
  });
  await r.board.change("roee", [{ op: "add", title: "Build the hub board", details: "SECRET" }]);
  await r.client.pair();
  for (let i = 0; i < 100 && !r.client.status().connected; i++) await wait(50);
  const phone = await generateHubKeys(false);
  const pcPub = await (await import("@kesher/shared")).importPrivateJwk(r.s.key!).then((k) => k.publicKey);
  const presence = [
    { id: "dphone", name: "Phone", kind: "phone", publicKey: phone.publicKey, online: true, busy: false, agents: [], optIn: {} },
    { id: "dphone2", name: "Phone 2", kind: "phone", publicKey: phone.publicKey, online: false, busy: false, agents: [], optIn: {} },
  ];
  await r.client.onMessage(JSON.stringify({ t: "welcome", deviceId: "dpc", hubKey: "", paused: false, rotateDue: false, presence }));
  await r.client.reportBoard();
  const snaps = () => r.sent.filter((f) => f.t === "send" && (f.env as SealedEnvelope).kind === "board").map((f) => f.env as SealedEnvelope);
  assert.deepEqual(snaps().map((e) => e.to), ["dphone"], "online phones only: nothing queues on the hub for an off one");
  assert.equal(snaps()[0]!.ttl, 30 * 60);
  const body = (await openEnvelope(snaps()[0]!, phone.privateKey, pcPub)) as Extract<SealedBody, { type: "board" }>;
  assert.equal(body.items[0]!.title, "Build the hub board");
  assert.ok(!JSON.stringify(body).includes("SECRET"));
  await r.client.reportBoard();
  assert.equal(snaps().length, 1, "nothing changed, nothing sent");
  await r.board.change("claude", [{ op: "claim", id: "t1" }]);
  await r.client.reportBoard();
  assert.equal(snaps().length, 2, "a change sends a new snapshot");
  // A command from the phone goes through the board's own rules (the app's `boardCommand`, wired in server.ts).
  const applied: Array<[string, unknown]> = [];
  (r.client as unknown as { deps: { boardCommand: unknown } }).deps.boardCommand = async (id: string, cmd: unknown) => (applied.push([id, cmd]), { ok: true, text: "Reopened." });
  const cmd: SealedBody = { type: "command", commandId: "c1", action: "board", taskId: "t1", board: { op: "reopen" } };
  await r.client.onMessage(JSON.stringify({ t: "deliver", env: await sealMessage({ from: "dphone", to: "dpc", kind: "command" }, cmd, phone.privateKey, pcPub) }));
  assert.deepEqual(applied, [["t1", { op: "reopen" }]]);
  const result = r.sent.filter((f) => f.t === "send" && (f.env as SealedEnvelope).kind === "command_result").map((f) => f.env as SealedEnvelope);
  assert.equal(((await openEnvelope(result[0]!, phone.privateKey, pcPub)) as { ok: boolean; text: string }).text, "Reopened.");
  // An older hub that cannot read the frame: no more snapshots on this link.
  await r.board.change("claude", [{ op: "release", id: "t1" }]);
  await r.client.onMessage(JSON.stringify({ t: "refused", code: "bad-frame" }));
  await r.client.reportBoard();
  assert.equal(snaps().length, 2, "stopped after the hub refused it");
});

test("a local task: waiting for the local agent while open on the board, running once the agent claimed it", () => {
  const l = inboxTask({ runBy: "local", status: "queued", branch: "local/c-1120-01-fix", note: "Self-work takes it from the task board." });
  assert.equal(hubInboxTask(l, 1)!.executor, "local");
  assert.equal(hubInboxTask(l, 1)!.state, "waiting");
  assert.equal(hubInboxTask({ ...l, boardState: "open" }, 1)!.state, "waiting");
  assert.equal(hubInboxTask({ ...l, boardState: "claimed" }, 1)!.state, "running");
  // Ended: the board's result.
  const done = hubInboxTask({ ...l, boardState: "claimed", status: "done", summary: "Converted." }, 1)!;
  assert.equal(done.state, "done");
  assert.equal(done.result, "Converted.");
  assert.equal(hubInboxTask({ ...l, status: "failed", summary: "Blocked: no tests." }, 1)!.state, "failed");
  // Only a local task follows the board.
  assert.equal(hubInboxTask(inboxTask({ boardState: "claimed" }), 1)!.state, "waiting-run");
});

test("scheduleInbox: changes in a row make one inbox report and one approvals check, within a second", async (t) => {
  const r = await rig();
  t.after(() => {
    r.client.stop();
    return r.done();
  });
  let reports = 0;
  let approvals = 0;
  const c = r.client as unknown as { reportInbox: () => Promise<void>; sendApprovals: () => Promise<void> };
  c.reportInbox = async () => void reports++;
  c.sendApprovals = async () => void approvals++;
  r.client.scheduleInbox();
  r.client.scheduleInbox();
  r.client.scheduleInbox();
  assert.equal(reports, 0, "debounced, not inline");
  await wait(600);
  assert.equal(reports, 1);
  assert.equal(approvals, 1, "the open asks follow the inbox, so a dropped ask leaves the phone at once");
});

test("going to sleep: the hub gets one clean away frame on a live link, nothing when not connected", async (t) => {
  const r = await rig();
  t.after(() => {
    r.client.stop();
    return r.done();
  });
  r.client.announceAway("asleep", { downloads: 2 }); // not connected yet: nothing is sent
  assert.equal(r.sent.filter((f) => f.t === "away").length, 0);
  await r.client.pair();
  for (let i = 0; i < 100 && !r.client.status().connected; i++) await wait(50);
  r.client.announceAway("asleep", { downloads: 2, selfWork: true, junk: 1 } as never);
  r.client.announceAway("awake");
  const away = r.sent.filter((f) => f.t === "away");
  assert.deepEqual(away, [
    { t: "away", state: "asleep", note: { downloads: 2, selfWork: true } },
    { t: "away", state: "awake", note: {} },
  ]);
});

test("a failed ticket names the step, the status and the reason, and the hub's diagnostics are fetched and saved", async () => {
  const s = settings();
  s.token = "kh_t";
  s.deviceId = "dpc";
  const saved: Array<{ reason: string; entries: number }> = [];
  const paths: string[] = [];
  const client = new HubClient({
    settings: () => s,
    persist: async () => undefined,
    version: "test",
    saveDiag: (snap, reason) => saved.push({ reason, entries: snap.entries.length }),
    fetch: (async (url: string) => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path === "/api/diag") return new Response(JSON.stringify({ now: "n", startedAt: "s", total: 1, entries: [{ at: "2026-11-22T10:00:00.000Z", kind: "error", where: "http", message: "boom" }] }), { status: 200 });
      return new Response(JSON.stringify({ error: "hub-unavailable", message: "The hub could not answer (boom)" }), { status: 503 });
    }) as unknown as typeof fetch,
    openSocket: () => assert.fail("no socket without a ticket"),
  });
  client.start();
  await wait(30);
  const st = client.status();
  assert.equal(st.errorCode, "hub-error");
  assert.equal(st.lastError, "ticket 503 hub-unavailable: The hub could not answer (boom)");
  assert.deepEqual(paths, ["/api/ticket", "/api/diag"]);
  assert.deepEqual(saved, [{ reason: st.lastError, entries: 1 }]);
  client.stop();
});

test("a plain 500 from the ticket route (not JSON) is shown as 'ticket 500: <text>'", async () => {
  const s = settings();
  s.token = "kh_t";
  s.deviceId = "dpc";
  const client = new HubClient({
    settings: () => s,
    persist: async () => undefined,
    version: "test",
    fetch: (async () => new Response("<html><h1>Error 1101</h1> Worker threw</html>", { status: 500 })) as unknown as typeof fetch,
    openSocket: () => assert.fail("no socket without a ticket"),
  });
  client.start();
  await wait(30);
  assert.equal(client.status().lastError, "ticket 500: Error 1101 Worker threw");
  client.stop();
});

test("a refused socket upgrade says 'socket upgrade 500: <message>' and fetches the diagnostics", async () => {
  const s = settings();
  s.token = "kh_t";
  s.deviceId = "dpc";
  const reasons: string[] = [];
  const client = new HubClient({
    settings: () => s,
    persist: async () => undefined,
    version: "test",
    saveDiag: (_snap, reason) => reasons.push(reason),
    fetch: (async (url: string) => (new URL(url).pathname === "/api/ticket" ? new Response(JSON.stringify({ ticket: "t1", rotateDue: false }), { status: 200 }) : new Response(JSON.stringify({ now: "", startedAt: "", total: 0, entries: [] }), { status: 200 }))) as unknown as typeof fetch,
    openSocket: (_url, on) => {
      queueMicrotask(() => on.error?.('Unexpected server response: 500 {"error":"x"}'));
      return { send: () => undefined, close: () => undefined };
    },
  });
  client.start();
  await wait(30);
  assert.equal(client.status().lastError, 'socket upgrade 500: {"error":"x"}');
  assert.deepEqual(reasons, ['socket upgrade 500: {"error":"x"}']);
  client.stop();
});

test("while connected the diagnostics are fetched on the 10-minute timer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const s = settings();
  s.token = "kh_t";
  s.deviceId = "dpc";
  const reasons: string[] = [];
  const client = new HubClient({
    settings: () => s,
    persist: async () => undefined,
    version: "test",
    saveDiag: (_snap, reason) => reasons.push(reason),
    fetch: (async (url: string) => (new URL(url).pathname === "/api/ticket" ? new Response(JSON.stringify({ ticket: "t1", rotateDue: false }), { status: 200 }) : new Response(JSON.stringify({ now: "", startedAt: "", total: 0, entries: [] }), { status: 200 }))) as unknown as typeof fetch,
    openSocket: (_url, on) => {
      queueMicrotask(() => on.open());
      return { send: () => undefined, close: () => undefined };
    },
  });
  client.start();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(client.status().connected, true);
  t.mock.timers.tick(10 * 60_000);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(reasons, ["every 10 minutes"]);
  client.stop();
});

test("a due rotate stores the hub's signed kh2_ token and uses it for the next ticket", async () => {
  const s = settings();
  s.token = "kh_old";
  s.deviceId = "dpc";
  let persisted = 0;
  const auths: Array<[string, string]> = [];
  const signed = "kh2_dpc.pc.lfls.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde";
  const client = new HubClient({
    settings: () => s,
    persist: async () => void persisted++,
    version: "test",
    saveDiag: () => undefined,
    fetch: (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      auths.push([path, (init.headers as Record<string, string>).authorization ?? ""]);
      if (path === "/api/rotate") return new Response(JSON.stringify({ token: signed }), { status: 200 });
      return new Response(JSON.stringify({ ticket: "t1", rotateDue: auths.length === 1 }), { status: 200 });
    }) as unknown as typeof fetch,
    openSocket: () => ({ send: () => undefined, close: () => undefined }),
  });
  client.start();
  await wait(30);
  client.stop();
  assert.equal(s.token, signed, "the signed token replaces the old one");
  assert.ok(persisted >= 1, "and is saved");
  assert.deepEqual(auths.slice(0, 3), [["/api/ticket", "Bearer kh_old"], ["/api/rotate", "Bearer kh_old"], ["/api/ticket", `Bearer ${signed}`]]);
});

test("backup relays: keys are checked, never in the status, and go sealed to the online phones only", async (t) => {
  const r = await rig();
  t.after(() => {
    r.client.stop();
    return r.done();
  });
  await r.client.pair();
  for (let i = 0; i < 100 && !r.client.status().connected; i++) await wait(50);
  await assert.rejects(r.client.setRelays({ supabaseUrl: "https://evil.example.com" }), /Supabase project URL/);
  const phone = await generateHubKeys(false);
  const pcPub = await (await import("@kesher/shared")).importPrivateJwk(r.s.key!).then((k) => k.publicKey);
  const presence = [
    { id: "dphone", name: "Phone", kind: "phone", publicKey: phone.publicKey, online: true, busy: false, agents: [], optIn: {} },
    { id: "dphone2", name: "Phone 2", kind: "phone", publicKey: phone.publicKey, online: false, busy: false, agents: [], optIn: {} },
    { id: "dchat", name: "Claude", kind: "claude-chat", publicKey: phone.publicKey, online: true, busy: false, agents: [], optIn: {} },
  ];
  await r.client.onMessage(JSON.stringify({ t: "welcome", deviceId: "dpc", hubKey: "", paused: false, rotateDue: false, presence }));
  const sentRelays = () => r.sent.filter((f) => f.t === "send" && (f.env as SealedEnvelope).kind === "relays").map((f) => f.env as SealedEnvelope);
  assert.equal(sentRelays().length, 0, "no keys: nothing sent");
  const ably = "appId1.keyId1:SECRETSECRETSECRET";
  await r.client.setRelays({ ablyKey: ably, supabaseUrl: "https://abcdefghijklmnop.supabase.co", supabaseKey: "sb_publishable_SECRETSECRETSECRETSECRET" });
  for (let i = 0; i < 50 && !sentRelays().length; i++) await wait(10);
  assert.deepEqual(r.client.status().relays, { ably: true, supabase: true, supabaseUrl: "https://abcdefghijklmnop.supabase.co" });
  assert.ok(!JSON.stringify(r.client.status()).includes("SECRET"));
  assert.deepEqual(sentRelays().map((e) => e.to), ["dphone"]);
  assert.ok(!JSON.stringify(sentRelays()).includes("SECRET"), "the hub sees only ciphertext");
  const body = (await openEnvelope(sentRelays()[0]!, phone.privateKey, pcPub)) as Extract<SealedBody, { type: "relays" }>;
  assert.deepEqual(body.keys.ably, { key: ably });
  await r.client.sendRelays();
  assert.equal(sentRelays().length, 1, "the same keys go once per phone");
  await r.client.setRelays({ ablyKey: "" });
  for (let i = 0; i < 50 && sentRelays().length < 2; i++) await wait(10);
  assert.equal(r.client.status().relays.ably, false);
  assert.equal(sentRelays().length, 2, "a change goes again");
});

test("three relays: the hub first; a silent hub fails over to Ably on the pair's channel; copies are dropped by id; back to the hub after 2 minutes", async (t) => {
  let now = Date.UTC(2026, 10, 22, 12);
  const published: Array<{ url: string; body: { name: string; data: string } }> = [];
  let polls = 0;
  const fetchAll = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (u.host === "rest.ably.io") {
      published.push({ url, body: JSON.parse(String(init.body)) as { name: string; data: string } });
      return new Response(null, { status: 201 });
    }
    if (u.pathname === "/api/pair/start") return reply({ code: "ABCD-EFGH", pollSecret: "poll", expiresIn: 300 });
    if (u.pathname === "/api/pair/poll") return reply(++polls < 2 ? { status: "pending" } : { status: "paired", deviceId: "dpc", token: "kh_secret_token", hubKey: "" });
    if (u.pathname === "/api/ticket") return reply({ ticket: "tick1", rotateDue: false });
    return reply({ error: "no" }, 404);
  }) as unknown as typeof fetch;
  const relaySockets: Array<{ url: string; sent: unknown[]; onmessage: ((ev: { data: unknown }) => void) | null }> = [];
  const r = await rig({
    fetch: fetchAll,
    now: () => now,
    openRelaySocket: (url) => {
      const s = { url, sent: [] as unknown[], readyState: 0, onopen: null as ((ev: unknown) => void) | null, onmessage: null as ((ev: { data: unknown }) => void) | null, onclose: null, onerror: null, send: (d: string) => void s.sent.push(JSON.parse(d)), close: () => undefined };
      relaySockets.push(s);
      queueMicrotask(() => {
        s.readyState = 1;
        s.onopen?.({});
        s.onmessage?.({ data: JSON.stringify({ action: 4, connectionDetails: { maxIdleInterval: 15000 } }) });
      });
      return s;
    },
  });
  t.after(() => {
    r.client.stop();
    return r.done();
  });
  await r.client.pair();
  for (let i = 0; i < 100 && !r.client.status().connected; i++) await wait(50);
  const phone = await generateHubKeys(false);
  const pcPub = await (await import("@kesher/shared")).importPrivateJwk(r.s.key!).then((k) => k.publicKey);
  const presence = [{ id: "dphone", name: "Phone", kind: "phone", publicKey: phone.publicKey, online: true, busy: false, agents: [], optIn: {} }];
  await r.client.onMessage(JSON.stringify({ t: "welcome", deviceId: "dpc", hubKey: "", paused: false, rotateDue: false, presence }));
  await r.client.setRelays({ ablyKey: "appId1.keyId1:abcdefghijklmnop" });
  await wait(20);
  const channel = await pairChannel(phone.privateKey, pcPub);
  assert.deepEqual(relaySockets[0]!.sent, [{ action: 10, channel }], "listens on the pair's channel");
  assert.deepEqual(r.s.peers, [{ id: "dphone", kind: "phone", publicKey: phone.publicKey }], "the phone's key is kept for a start while the hub is down");
  assert.equal(r.client.status().path, "hub");

  const boards = () => r.sent.filter((f) => f.t === "send" && (f.env as SealedEnvelope).kind === "board").length;
  const before = boards();
  await r.board.change("roee", [{ op: "add", title: "One" }]);
  await r.client.reportBoard();
  assert.equal(boards(), before + 1, "through the hub while it answers");
  assert.equal(published.length, 0);

  // The hub's socket stays open but hears nothing for 60 s: the next message goes through Ably.
  now += 61_000;
  assert.equal(r.client.status().path, "ably");
  await r.board.change("roee", [{ op: "add", title: "Two" }]);
  await r.client.reportBoard();
  assert.equal(boards(), before + 1);
  assert.equal(published.length, 1);
  assert.equal(published[0]!.url, `https://rest.ably.io/channels/${channel}/messages`);
  const env = JSON.parse(published[0]!.body.data) as SealedEnvelope;
  const body = (await openEnvelope(env, phone.privateKey, pcPub)) as Extract<SealedBody, { type: "board" }>;
  assert.deepEqual(body.items.map((i) => i.title), ["One", "Two"]);
  assert.equal(r.client.status().relayUse.ably, 2, "a publish counts two messages");

  // A command from the phone through Ably and the same one through the hub: applied once.
  const applied: string[] = [];
  (r.client as unknown as { deps: { boardCommand: unknown } }).deps.boardCommand = async (id: string) => (applied.push(id), { ok: true, text: "ok" });
  const cmd = await sealMessage({ from: "dphone", to: "dpc", kind: "command" }, { type: "command", commandId: "c1", action: "board", taskId: "t1", board: { op: "raise" } }, phone.privateKey, pcPub);
  relaySockets[0]!.onmessage?.({ data: JSON.stringify({ action: 15, channel, messages: [{ name: "env", data: JSON.stringify(cmd) }] }) });
  await wait(30);
  await r.client.onMessage(JSON.stringify({ t: "deliver", env: cmd }));
  assert.deepEqual(applied, ["t1"]);
  // One from another channel (not this pair's) is ignored.
  relaySockets[0]!.onmessage?.({ data: JSON.stringify({ action: 15, channel: "kesher-00", messages: [{ name: "env", data: JSON.stringify({ ...cmd, id: "other1" }) }] }) });
  await wait(30);
  assert.deepEqual(applied, ["t1"]);

  // The hub answers again: still Ably until it has answered for 2 minutes in a row (from its first answer).
  for (let i = 0; i < 4; i++) {
    now += 30_000;
    r.events().message('{"t":"pong"}');
  }
  assert.equal(r.client.status().path, "ably");
  now += 30_000;
  r.events().message('{"t":"pong"}');
  assert.equal(r.client.status().path, "hub");
});
