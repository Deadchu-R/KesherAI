import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateHubKeys, openEnvelope, sealMessage, type HubFrame, type SealedBody, type SealedEnvelope } from "@kesher/shared";
import { cleanHubUrl, HubClient, type HubSettings, type HubSocketEvents } from "./hub-client.js";
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
  const client = new HubClient({
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
  return { dir, s, board, sent, calls, client, notes, events: () => events!, socketUrl: () => socketUrl, done: () => rm(dir, { recursive: true, force: true }) };
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

  // Revoked by the hub: the token is forgotten.
  await r.client.onMessage(JSON.stringify({ t: "revoked" }));
  assert.equal(r.s.token, undefined);
  assert.equal(r.client.status().paired, false);
});
