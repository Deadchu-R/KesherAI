import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateHubKeys, importPrivateJwk, openEnvelope, sealMessage, type InboxTaskView, type SealedEnvelope } from "@kesher/shared";
import { HubClient, type HubSettings, type HubSocketEvents } from "./hub-client.js";
import { ConnectorDesk, type ConnectorDeps } from "./hub-connector.js";
import { TaskBoard } from "./task-board.js";

const HOME = "/home/someone";

/** Three inbox tasks: one waiting for Run, one running with steps, one done with a result naming a home path. */
function sampleTasks(): InboxTaskView[] {
  const base = { risk: "medium", base: "origin/main", allowedPaths: [], forbiddenPaths: [], check: "", maxMinutes: 30, maxFiles: 15 };
  return [
    { ...base, id: "r-1", title: "Fix the hub page", goal: "SECRET GOAL TEXT", executor: "antigravity", runBy: "antigravity", from: "claude", status: "waiting" },
    { ...base, id: "r-2", title: "Port the plugin", goal: "g", executor: "local", runBy: "local", from: "roee", status: "running", startedAt: 1000, steps: 4, stepLog: [{ tool: "read_file", target: `${HOME}/kesher/a.ts`, at: 1100 }, { tool: "edit_file", target: "packages/x.ts", at: 1200 }] },
    { ...base, id: "r-3", title: "Research quotas", goal: "g", executor: "gemini", runBy: "gemini", from: "hub", status: "done", startedAt: 900, endedAt: 2000, summary: `Report written; key sk-ant-${"a".repeat(30)} and ${HOME}/notes.md` },
  ] as unknown as InboxTaskView[];
}

function desk(extra: Partial<ConnectorDeps> = {}) {
  const log: string[] = [];
  const did: string[] = [];
  let now = 10_000;
  const deps: ConnectorDeps = {
    inboxTasks: async () => sampleTasks(),
    quotas: async () => [{ id: "antigravity", kind: "antigravity", group: "tasks", name: "Antigravity", state: "ok", bars: [{ label: "Gemini Pro", left: 0.6 }] }],
    agents: () => [{ kind: "local-model", state: "busy", label: "Qwen 3 8B" }],
    inboxCommand: async (action, taskId, from) => (did.push(`${action} ${taskId} ${from.id}`), { ok: true, text: "Started on the PC." }),
    assign: async (taskId, to, confirm) => (did.push(`assign ${taskId} ${to} ${confirm}`), { ok: true, text: `Given to ${to}.` }),
    addTask: async (t) => (did.push(`add ${t.title} ${t.executor}`), { ...sampleTasks()[0]!, id: "r-9", title: t.title }),
    log: (l) => log.push(l),
    ...extra,
  };
  return { d: new ConnectorDesk(deps, () => now, { home: HOME, username: "someone" }), log, did, tick: (ms: number) => (now += ms) };
}

test("connector desk: refused while the opt-in is off, and nothing is read or done", async () => {
  const { d, did, log } = desk({ inboxTasks: async () => assert.fail("read while off") });
  for (const q of [{ queryId: "q1", op: "tasks" as const }, { queryId: "q2", op: "action" as const, taskId: "r-1", action: "run" as const }]) {
    const a = await d.answer(q, false);
    assert.equal(a.ok, false);
    assert.match(a.text!, /Claude connector may read and run/);
  }
  assert.deepEqual(did, []);
  assert.deepEqual(log, ["Claude connector: tasks -> refused", "Claude connector: action:run r-1 -> refused"]);
});

test("connector desk: lists tasks by filter with short fields, never the goal; hub tasks included", async () => {
  const { d } = desk();
  const all = await d.answer({ queryId: "q", op: "tasks", filter: "all" }, true);
  assert.deepEqual(all.tasks!.map((t) => `${t.taskId}:${t.state}`), ["r-1:waiting-run", "r-2:running", "r-3:done"]);
  assert.equal(all.tasks![0]!.queuePos, 1);
  assert.ok(!JSON.stringify(all).includes("SECRET GOAL"), "no goal text");
  assert.deepEqual((await d.answer({ queryId: "q", op: "tasks", filter: "open" }, true)).tasks!.map((t) => t.taskId), ["r-1"]);
  assert.deepEqual((await d.answer({ queryId: "q", op: "tasks", filter: "ended" }, true)).tasks!.map((t) => t.taskId), ["r-3"]);
  assert.deepEqual((await d.answer({ queryId: "q", op: "tasks", executor: "local" }, true)).tasks!.map((t) => t.taskId), ["r-2"]);
});

test("connector desk: one task with steps, scrubbed of the home folder and keys", async () => {
  const { d } = desk();
  const run = await d.answer({ queryId: "q", op: "task", taskId: "r-2" }, true);
  assert.equal(run.task!.steps, 4);
  assert.deepEqual(run.task!.stepLog.map((s) => s.tool), ["read_file", "edit_file"]);
  assert.ok(!JSON.stringify(run).includes(HOME), "home folder hidden");
  const done = await d.answer({ queryId: "q", op: "task", taskId: "r-3" }, true);
  assert.ok(done.task!.result && !done.task!.result.includes("sk-ant-") && !done.task!.result.includes(HOME), done.task!.result);
  assert.equal((await d.answer({ queryId: "q", op: "task", taskId: "nope" }, true)).ok, false);
});

test("connector desk: quotas, agents with the running task's last step, add and the allowed actions only", async () => {
  const { d, did, log } = desk();
  assert.equal((await d.answer({ queryId: "q", op: "quotas" }, true)).quotas![0]!.name, "Antigravity");
  const agents = (await d.answer({ queryId: "q", op: "agents" }, true)).agents!;
  assert.deepEqual(agents[0], { kind: "local-model", state: "busy", label: "Qwen 3 8B", task: { taskId: "r-2", title: "Port the plugin", steps: 4, estSteps: agents[0]!.task!.estSteps, now: { tool: "edit_file", target: "packages/x.ts", at: 1200 } } });
  const added = await d.answer({ queryId: "q", op: "add", title: "New task", goal: "Do it", executor: "auto" }, true);
  assert.match(added.text!, /r-9/);
  await d.answer({ queryId: "q", op: "action", taskId: "r-1", action: "run" }, true);
  await d.answer({ queryId: "q", op: "action", taskId: "r-1", action: "queue" }, true);
  await d.answer({ queryId: "q", op: "action", taskId: "r-2", action: "stop" }, true);
  await d.answer({ queryId: "q", op: "action", taskId: "r-1", action: "assign", to: "local", confirm: true }, true);
  assert.deepEqual(did, ["add New task auto", "inbox-run r-1 connector", "inbox-queue r-1 connector", "inbox-cancel r-2 connector", "assign r-1 local true"]);
  assert.ok(log.every((l) => !l.includes("New task") && !l.includes("Do it")), "the log names no titles or goals");
});

test("connector desk: at most 30 requests a minute", async () => {
  const { d, tick } = desk();
  for (let i = 0; i < 30; i++) assert.equal((await d.answer({ queryId: "q", op: "quotas" }, true)).ok, true);
  assert.match((await d.answer({ queryId: "q", op: "quotas" }, true)).text!, /Too many/);
  tick(60_001);
  assert.equal((await d.answer({ queryId: "q", op: "quotas" }, true)).ok, true);
});

test("hub client: a connector query opens only from the hub, is refused while the opt-in is off, and the answer goes sealed to the hub", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-hubconn-"));
  const s: HubSettings = { enabled: true, url: "https://hub.example.test", reported: [], optIn: { appear: true, acceptTasks: false, acceptLocal: false, acceptAntigravity: false, reportLinks: false } } as HubSettings;
  const sent: Array<Record<string, unknown>> = [];
  let polls = 0;
  const fakeFetch = (async (url: string) => {
    const path = new URL(url).pathname;
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (path === "/api/pair/start") return reply({ code: "ABCD-EFGH", pollSecret: "poll", expiresIn: 300 });
    if (path === "/api/pair/poll") return reply(++polls < 2 ? { status: "pending" } : { status: "paired", deviceId: "dpc", token: "kh_secret_token", hubKey: "" });
    return reply({ ticket: "tick1", rotateDue: false });
  }) as unknown as typeof fetch;
  const ran: string[] = [];
  const client = new HubClient({
    settings: () => s,
    persist: async () => undefined,
    board: new TaskBoard(join(dir, "board.json")),
    version: "test",
    fetch: fakeFetch,
    inboxTasks: async () => sampleTasks(),
    inboxCommand: async (a, id) => (ran.push(`${a} ${id}`), { ok: true, text: "Started on the PC." }),
    openSocket: (_url, on: HubSocketEvents) => {
      queueMicrotask(() => on.open());
      return { send: (x) => sent.push(JSON.parse(x) as Record<string, unknown>), close: () => undefined };
    },
  });
  t.after(async () => {
    client.stop();
    await rm(dir, { recursive: true, force: true });
  });
  await client.pair();
  for (let i = 0; i < 100 && !client.status().connected; i++) await new Promise((r) => setTimeout(r, 50));
  const hub = await generateHubKeys(false);
  const phone = await generateHubKeys(false);
  const pcPub = (await importPrivateJwk(s.key!)).publicKey;
  await client.onMessage(JSON.stringify({ t: "welcome", deviceId: "dpc", hubKey: hub.publicKey, paused: false, rotateDue: false, presence: [{ id: "dphone", name: "Phone", kind: "phone", publicKey: phone.publicKey, online: true, busy: false, agents: [], optIn: {} }] }));
  const ask = async (from: "hub" | "dphone", body: Record<string, unknown>) => {
    const env = await sealMessage({ from, to: "dpc", kind: "connector_query" }, { type: "connector_query", at: Date.now(), ...body } as never, from === "hub" ? hub.privateKey : phone.privateKey, pcPub);
    await client.onMessage(JSON.stringify({ t: "deliver", env }));
  };
  const answers = async () => Promise.all(sent.filter((f) => f.t === "send" && (f.env as SealedEnvelope).kind === "connector_answer").map((f) => openEnvelope(f.env as SealedEnvelope, hub.privateKey, pcPub)));
  await ask("hub", { queryId: "q1", op: "action", taskId: "r-1", action: "run" });
  let got = await answers();
  assert.equal(got.length, 1);
  assert.ok(got[0]!.type === "connector_answer" && !got[0]!.ok && /Settings › Kesher Cloud/.test(got[0]!.text ?? ""), "opt-in off: refused");
  assert.deepEqual(ran, []);
  await client.setOptIn({ connector: true });
  // A phone cannot use the connector's line (only the hub's key opens it as "hub").
  await ask("dphone", { queryId: "q2", op: "action", taskId: "r-1", action: "run" });
  assert.equal((await answers()).length, 1);
  await ask("hub", { queryId: "q3", op: "action", taskId: "r-1", action: "run" });
  got = await answers();
  assert.equal(got.length, 2);
  assert.ok(got[1]!.type === "connector_answer" && got[1]!.ok && got[1]!.queryId === "q3");
  assert.deepEqual(ran, ["inbox-run r-1"]);
  // A disallowed op (an approval answer, a setting) does not even open: dropped, nothing sent.
  await ask("hub", { queryId: "q4", op: "approve", taskId: "r-1" });
  assert.equal((await answers()).length, 2);
  const env = sent.find((f) => f.t === "send" && (f.env as SealedEnvelope).kind === "connector_answer")!.env as SealedEnvelope;
  assert.equal(env.to, "hub");
  // Replay after a restart: a query from an hour ago (or without its time) is refused and nothing runs.
  await ask("hub", { queryId: "q5", op: "action", taskId: "r-1", action: "run", at: Date.now() - 3_600_000 });
  await ask("hub", { queryId: "q6", op: "action", taskId: "r-1", action: "run", at: undefined });
  got = await answers();
  assert.equal(got.length, 4);
  assert.ok(got[2]!.type === "connector_answer" && !got[2]!.ok && /too old/.test(got[2]!.text ?? ""));
  assert.ok(got[3]!.type === "connector_answer" && !got[3]!.ok && /no time/.test(got[3]!.text ?? ""));
  assert.deepEqual(ran, ["inbox-run r-1"]);
});

/** Chat cards waiting on the PC: a plain command, a dangerous one, screen control, and two that are not chat cards. */
function waitingCards() {
  const base = { title: "Fix the build", preview: `pnpm test in ${HOME}/kesher`, at: "2026-11-27T10:00:00.000Z" };
  return [
    { ...base, conversationId: "c-1", requestId: "q-1", tool: "run_command", reason: "Runs a command.", forWhile: true },
    { ...base, conversationId: "c-1", requestId: "q-2", tool: "run_command", reason: "This command deletes files, so it always needs your approval.", forWhile: false },
    { ...base, conversationId: "c-2", requestId: "q-3", tool: "computer_use_app", reason: "Wants to see your screen.", forWhile: true },
    { ...base, conversationId: "task-inbox", requestId: "q-4", tool: "antigravity", reason: "Run it?", kind: "run" as const },
    { ...base, conversationId: "helper-asks", requestId: "q-5", tool: "x", reason: "y" },
    // A browser step on a bank's site (asked every time): the server marks it userOnly.
    { ...base, conversationId: "c-3", requestId: "q-6", tool: "browser_click", reason: "bank.example is a bank, so every action there is asked.", forWhile: true, userOnly: true },
  ];
}

function approvalsDesk(allow: boolean) {
  const answered: string[] = [];
  const h = desk({
    approvals: { pending: waitingCards, answer: async (c, r, d, from, m) => (answered.push(`${c}/${r} ${d} ${from.kind} ${m ?? "-"}`), true) },
    allowApprovals: () => allow,
  });
  return { ...h, answered };
}

test("connector desk: lists chat approval cards only (not Antigravity asks), scrubbed, with locked ones marked", async () => {
  const { d } = approvalsDesk(false);
  const a = await d.answer({ queryId: "q", op: "approvals" }, true);
  assert.equal(a.ok, true);
  assert.deepEqual(a.approvals!.map((x) => x.requestId), ["q-1", "q-2", "q-3", "q-6"]);
  assert.deepEqual(a.approvals!.map((x) => !!x.locked), [false, true, true, true]);
  assert.equal(a.canAnswer, false);
  assert.ok(!JSON.stringify(a).includes(HOME), "home folder hidden");
  assert.equal((await d.answer({ queryId: "q", op: "approvals" }, false)).ok, false, "the opt-in gates it");
});

test("connector desk: approve answers only when the user allows connected apps, and never a dangerous command or screen control", async () => {
  const off = approvalsDesk(false);
  const refused = await off.d.answer({ queryId: "q", op: "approve", conversationId: "c-1", requestId: "q-1", decision: "allow" }, true);
  assert.equal(refused.ok, false);
  assert.match(refused.text!, /not let connected apps answer/);
  assert.deepEqual(off.answered, []);
  // Deny is always possible: it only stops something.
  assert.equal((await off.d.answer({ queryId: "q", op: "approve", conversationId: "c-1", requestId: "q-2", decision: "deny" }, true)).ok, true);
  assert.deepEqual(off.answered, ["c-1/q-2 deny connector -"]);
  const on = approvalsDesk(true);
  for (const id of [["c-1", "q-2"], ["c-2", "q-3"], ["c-3", "q-6"]] as const) {
    const r = await on.d.answer({ queryId: "q", op: "approve", conversationId: id[0], requestId: id[1], decision: "allow" }, true);
    assert.equal(r.ok, false, id.join("/"));
    assert.match(r.text!, /own approval in KesherAI/);
  }
  assert.deepEqual(on.answered, []);
  const once = await on.d.answer({ queryId: "q", op: "approve", conversationId: "c-1", requestId: "q-1", decision: "allow" }, true);
  assert.deepEqual([once.ok, once.text], [true, "Allowed once."]);
  const ten = await on.d.answer({ queryId: "q", op: "approve", conversationId: "c-1", requestId: "q-1", decision: "allow", forMinutes: 10 }, true);
  assert.match(ten.text!, /10 minutes/);
  assert.deepEqual(on.answered, ["c-1/q-1 allow connector -", "c-1/q-1 allow connector 10"]);
  // A card that is gone, or one that is not a chat's, is "no longer waiting".
  for (const [c, r] of [["c-9", "q-1"], ["task-inbox", "q-4"]]) assert.match((await on.d.answer({ queryId: "q", op: "approve", conversationId: c!, requestId: r!, decision: "allow" }, true)).text!, /no longer waiting/);
  assert.equal((await on.d.answer({ queryId: "q", op: "approve", conversationId: "c-1", requestId: "q-1", decision: "allow" }, false)).ok, false, "the opt-in gates it");
  assert.ok(on.log.every((l) => !/q-1|Fix the build/.test(l.replace(/approve:\w+/, ""))), "the log has no card text");
});
