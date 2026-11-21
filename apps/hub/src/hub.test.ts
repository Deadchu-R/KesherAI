import { test } from "node:test";
import assert from "node:assert/strict";
import { exportPrivateJwk, generateHubKeys, openEnvelope, sealMessage, type HubFrame, type HubKeyPair, type SealedBody } from "../../../packages/shared/src/hub.js";
import { Hub, HUB_TIMES, isHubError, type DeviceSockets, type HubConfig } from "./hub.js";
import type { GoogleClaims } from "./google.js";
import { LIMITS, RateLimiter } from "./rate-limit.js";
import { MemoryStore } from "./store.js";

/** Sockets in memory: which devices are on, and every frame each got. */
class FakeSockets implements DeviceSockets {
  on = new Set<string>();
  got = new Map<string, HubFrame[]>();
  closed: string[] = [];
  send(id: string, f: HubFrame): boolean {
    if (!this.on.has(id)) return false;
    this.got.set(id, [...(this.got.get(id) ?? []), f]);
    return true;
  }
  isOnline(id: string): boolean {
    return this.on.has(id);
  }
  close(id: string): void {
    this.closed.push(id);
    this.on.delete(id);
  }
  closeAll(): void {
    for (const id of this.on) this.closed.push(id);
    this.on.clear();
  }
  frames(id: string, t: HubFrame["t"]): HubFrame[] {
    return (this.got.get(id) ?? []).filter((f) => f.t === t);
  }
}

const claims = (over: Partial<GoogleClaims> = {}): GoogleClaims => ({ sub: "sub-owner", email: "owner@example.com", email_verified: true, aud: "client", iss: "accounts.google.com", exp: 9e9, ...over });

async function setup(config: Partial<HubConfig> = {}, fire = async () => ({ ok: true as const, sessionUrl: "https://claude.ai/code/session_1" })) {
  let now = 1_000_000;
  const store = new MemoryStore();
  const sockets = new FakeSockets();
  const fired: string[] = [];
  const hub = new Hub({
    store,
    sockets,
    config: { allowedEmail: "Owner@Example.com", ...config },
    verifyIdToken: async (t) => {
      if (!t.startsWith("ok:")) throw new Error("bad");
      return claims({ sub: t.slice(3), email: t.slice(3) === "other" ? "x@example.com" : "owner@example.com" });
    },
    fireClaude: async (text) => {
      fired.push(text);
      return fire();
    },
    now: () => now,
  });
  return { hub, store, sockets, fired, tick: (ms: number) => (now += ms) };
}

/** Pairs a device through the full code flow and returns its id, token and keys. */
async function pair(hub: Hub, kind: "pc" | "phone" | "claude-chat", name: string): Promise<{ id: string; token: string; keys: HubKeyPair }> {
  const keys = await generateHubKeys(true);
  const start = await hub.pairStart("1.2.3.4", { publicKey: keys.publicKey, kind, name });
  assert.ok(!isHubError(start));
  assert.deepEqual(await hub.pairPoll("1.2.3.4", start.pollSecret), { status: "pending" });
  // Looking the code up first shows the same fingerprint the device shows, and approves nothing.
  const peek = await hub.pairPeek(start.code);
  assert.ok(!isHubError(peek) && peek.fingerprint === start.fingerprint && peek.kind === kind);
  assert.deepEqual(await hub.pairPoll("1.2.3.4", start.pollSecret), { status: "pending" });
  const ok = await hub.pairApprove(start.code.toLowerCase().replace("-", " "), name);
  assert.ok(!isHubError(ok) && /^\d{3} \d{3}$/.test(ok.fingerprint));
  const done = await hub.pairPoll("1.2.3.4", start.pollSecret);
  assert.ok(!isHubError(done) && done.status === "paired");
  return { id: done.deviceId, token: done.token, keys };
}

test("sign-in: allowed email pins its sub, then only that sub; sessions expire", async () => {
  const { hub, store, tick } = await setup();
  assert.equal(isHubError(await hub.signIn("garbage", "ip")) && (await hub.signIn("garbage", "ip") as { status: number }).status, 403);
  assert.ok(isHubError(await hub.signIn("ok:other", "ip")), "another account");
  const s = await hub.signIn("ok:sub-owner", "ip");
  assert.ok(!isHubError(s));
  assert.equal(store.getSetting("ownerSub"), "sub-owner");
  assert.ok(isHubError(await hub.signIn("ok:sub-new", "ip")), "the same email with a new sub after the pin is refused");
  assert.equal(await hub.checkSession(s.session), true);
  assert.equal(await hub.checkSession("forged"), false);
  tick(HUB_TIMES.sessionIdle + 1);
  assert.equal(await hub.checkSession(s.session), false, "12 hours idle ends it");
  const audit = store.auditList(50).map((a) => a.action);
  assert.ok(audit.includes("signin-refused") && audit.includes("owner-pinned"));
  assert.ok(!JSON.stringify(store.auditList(50)).includes("example.com"), "no email in the audit");
});

test("sign-in and pair start are rate limited per IP", async () => {
  const { hub } = await setup();
  for (let i = 0; i < LIMITS.signIn.burst; i++) await hub.signIn("bad", "9.9.9.9");
  const r = await hub.signIn("ok:sub-owner", "9.9.9.9");
  assert.ok(isHubError(r) && r.status === 429);
  const keys = await generateHubKeys(false);
  for (let i = 0; i < LIMITS.pairStart.burst; i++) assert.ok(!isHubError(await hub.pairStart("8.8.8.8", { publicKey: keys.publicKey })));
  const over = await hub.pairStart("8.8.8.8", { publicKey: keys.publicKey });
  assert.ok(isHubError(over) && over.status === 429);
});

test("rate limiter refills over time", () => {
  let t = 0;
  const r = new RateLimiter(() => t);
  const lim = { burst: 2, perMs: 1000 };
  assert.deepEqual([r.take("k", lim), r.take("k", lim), r.take("k", lim)], [true, true, false]);
  t = 500;
  assert.equal(r.take("k", lim), true);
  assert.equal(r.take("other", lim), true, "buckets are separate");
});

test("pairing: codes are single use, expire, and need a real key; tokens are stored as hashes only", async () => {
  const { hub, store, tick } = await setup();
  assert.ok(isHubError(await hub.pairStart("ip", { publicKey: "nope" })));
  const pc = await pair(hub, "pc", "Home PC");
  assert.match(pc.token, /^kh_[\w-]{43}$/);
  assert.ok(!JSON.stringify(store.devices()).includes(pc.token), "the token itself is never stored");
  const keys = await generateHubKeys(false);
  const start = await hub.pairStart("ip", { publicKey: keys.publicKey });
  assert.ok(!isHubError(start));
  tick(HUB_TIMES.pairing + 1);
  assert.ok(isHubError(await hub.pairApprove(start.code)), "expired code");
  const p2 = await hub.pairPoll("ip", start.pollSecret);
  assert.ok(isHubError(p2) && p2.status === 410);
  assert.ok(isHubError(await hub.pairApprove("ZZZZ-ZZZZ")));
});

test("tickets: one use, 60 seconds; tokens rotate and old ones stop; revoke closes the socket", async () => {
  const { hub, sockets, tick } = await setup();
  const pc = await pair(hub, "pc", "Home PC");
  assert.ok(isHubError(await hub.issueTicket("kh_wrong")));
  const t1 = await hub.issueTicket(pc.token);
  assert.ok(!isHubError(t1) && t1.rotateDue === false);
  assert.equal((await hub.takeTicket(t1.ticket))?.id, pc.id);
  assert.equal(await hub.takeTicket(t1.ticket), undefined, "used once");
  const t2 = await hub.issueTicket(pc.token);
  assert.ok(!isHubError(t2));
  tick(HUB_TIMES.ticket + 1);
  assert.equal(await hub.takeTicket(t2.ticket), undefined, "expired");

  tick(HUB_TIMES.rotateAfter);
  const t3 = await hub.issueTicket(pc.token);
  assert.ok(!isHubError(t3) && t3.rotateDue, "after 30 days the device is told to rotate");
  const rot = await hub.rotateToken(pc.token);
  assert.ok(!isHubError(rot));
  assert.ok(isHubError(await hub.issueTicket(pc.token)), "the old token stops at once");
  assert.ok(!isHubError(await hub.issueTicket(rot.token)));
  tick(HUB_TIMES.tokenMax + 1);
  assert.ok(isHubError(await hub.issueTicket(rot.token)), "a token never rotated for 180 days is refused");

  const { hub: h2, sockets: s2 } = await setup();
  const d = await pair(h2, "pc", "PC");
  s2.on.add(d.id);
  assert.equal(h2.revoke(d.id), true);
  assert.equal(s2.frames(d.id, "revoked").length, 1, "told it was revoked, then closed");
  assert.ok(s2.closed.includes(d.id));
  assert.ok(isHubError(await h2.issueTicket(d.token)));
  void sockets;
});

const taskBody = (taskId = "t1"): SealedBody => ({ type: "task", taskId, title: "Fix the test", spec: "pnpm test fails", executor: "auto", ifOffline: "wait", createdAt: "" });

test("relay: sealed task to a PC that opted in, queued while off, delivered on connect, deleted on ack", async () => {
  const { hub, store, sockets } = await setup();
  const pc = await pair(hub, "pc", "Home PC");
  const phone = await pair(hub, "phone", "Phone");
  sockets.on.add(phone.id);
  await hub.onOpen(phone.id);
  const env = await sealMessage({ from: phone.id, to: pc.id, kind: "task" }, taskBody(), phone.keys.privateKey, pc.keys.publicKey);

  // The PC has not opted in to tasks yet (default): refused.
  await hub.onFrame(phone.id, JSON.stringify({ t: "send", env }));
  assert.deepEqual(sockets.frames(phone.id, "refused").at(-1), { t: "refused", code: "not-accepting", id: env.id });

  // The PC connects and opts in, then goes off.
  sockets.on.add(pc.id);
  await hub.onOpen(pc.id);
  await hub.onFrame(pc.id, JSON.stringify({ t: "hello", version: "0.6.400", busy: false, optIn: { appear: true, acceptTasks: true }, agents: [{ kind: "claude-remote-control", state: "on", link: "https://claude.ai/code/x" }] }));
  assert.equal(store.device(pc.id)?.agents[0]?.link, undefined, "no vendor link unless the PC reports links");
  sockets.on.delete(pc.id);
  hub.onClose(pc.id);

  await hub.onFrame(phone.id, JSON.stringify({ t: "send", env }));
  assert.deepEqual(sockets.frames(phone.id, "sent").at(-1), { t: "sent", id: env.id, queued: true });
  assert.equal(store.queueCount(), 1);
  assert.ok(!store.queued(pc.id)[0]!.env.includes("Fix the test"), "the hub holds only ciphertext");

  // Back on: the queued task is delivered, the PC opens it, acks, and the hub forgets it.
  sockets.on.add(pc.id);
  await hub.onOpen(pc.id);
  const delivered = sockets.frames(pc.id, "deliver").at(-1);
  assert.ok(delivered?.t === "deliver");
  assert.deepEqual(await openEnvelope(delivered.env, pc.keys.privateKey, phone.keys.publicKey), taskBody());
  await hub.onFrame(pc.id, JSON.stringify({ t: "ack", id: env.id }));
  assert.equal(store.queueCount(), 0);

  // Resending the same id is idempotent.
  await hub.onFrame(phone.id, JSON.stringify({ t: "send", env }));
  await hub.onFrame(phone.id, JSON.stringify({ t: "send", env }));
  assert.equal(store.queueCount(), 1);
  // The audit holds metadata only.
  assert.ok(!JSON.stringify(store.auditList(100)).includes("Fix the test"));
});

test("relay rules: no spoofed sender, no unknown recipient, approvals live 30 minutes, expired messages are cleaned", async () => {
  const { hub, store, sockets, tick } = await setup();
  const pc = await pair(hub, "pc", "PC");
  const phone = await pair(hub, "phone", "Phone");
  sockets.on.add(pc.id);
  sockets.on.add(phone.id);
  const spoof = await sealMessage({ from: phone.id, to: pc.id, kind: "result" }, { type: "result", taskId: "t1", status: "done", text: "ok" }, pc.keys.privateKey, phone.keys.publicKey);
  await hub.onFrame(pc.id, JSON.stringify({ t: "send", env: spoof }));
  assert.equal((sockets.frames(pc.id, "refused").at(-1) as { code: string }).code, "not-allowed");
  const lost = await sealMessage({ from: pc.id, to: "dnobody", kind: "result" }, { type: "result", taskId: "t1", status: "done", text: "ok" }, pc.keys.privateKey, phone.keys.publicKey);
  await hub.onFrame(pc.id, JSON.stringify({ t: "send", env: lost }));
  assert.equal((sockets.frames(pc.id, "refused").at(-1) as { code: string }).code, "no-recipient");
  await hub.onFrame(pc.id, "{not json");
  assert.equal((sockets.frames(pc.id, "refused").at(-1) as { code: string }).code, "bad-frame");

  sockets.on.delete(phone.id);
  const ask = await sealMessage({ from: pc.id, to: phone.id, kind: "approval_request", ttl: 86400 }, { type: "approval_request", requestId: "req-12345678", conversationId: "c1", title: "Chat", tool: "run", preview: "ls", reason: "" }, pc.keys.privateKey, phone.keys.publicKey);
  assert.equal(ask.ttl, 30 * 60);
  await hub.onFrame(pc.id, JSON.stringify({ t: "send", env: ask }));
  assert.equal(store.queueCount(), 1);
  tick(31 * 60_000);
  assert.equal(hub.cleanup(), 1, "the approval request expired and was deleted");
});

test("rate limits: tasks per device per hour, frames per minute", async () => {
  const { hub, sockets } = await setup();
  const pc = await pair(hub, "pc", "PC");
  const phone = await pair(hub, "phone", "Phone");
  sockets.on.add(pc.id);
  sockets.on.add(phone.id);
  await hub.onFrame(pc.id, JSON.stringify({ t: "hello", version: "1", busy: false, optIn: { acceptTasks: true }, agents: [] }));
  for (let i = 0; i < LIMITS.task.burst; i++) {
    const env = await sealMessage({ from: phone.id, to: pc.id, kind: "task" }, taskBody(`t${i}`), phone.keys.privateKey, pc.keys.publicKey);
    await hub.onFrame(phone.id, JSON.stringify({ t: "send", env }));
  }
  const env = await sealMessage({ from: phone.id, to: pc.id, kind: "task" }, taskBody("t99"), phone.keys.privateKey, pc.keys.publicKey);
  await hub.onFrame(phone.id, JSON.stringify({ t: "send", env }));
  assert.equal((sockets.frames(phone.id, "refused").at(-1) as { code: string }).code, "rate-limited");
  for (let i = 0; i < LIMITS.message.burst; i++) await hub.onFrame(pc.id, JSON.stringify({ t: "beat", busy: false, agents: [] }));
  assert.equal((sockets.frames(pc.id, "refused").at(-1) as { code: string }).code, "rate-limited");
});

test("Claude path: only when set up and on; the hub opens the one message sealed to it and answers sealed", async () => {
  const hubKey = await generateHubKeys(true);
  const jwk = await exportPrivateJwk(hubKey.privateKey);
  const { hub, sockets, fired, store } = await setup({ hubPrivateJwk: jwk, claude: { triggerId: "trig_1", token: "tok" } });
  const phone = await pair(hub, "phone", "Phone");
  sockets.on.add(phone.id);
  await hub.onOpen(phone.id);
  const welcome = sockets.frames(phone.id, "welcome")[0];
  assert.ok(welcome?.t === "welcome" && welcome.hubKey === hubKey.publicKey);
  assert.equal((await hub.state()).cloudReady, true);

  const env = await sealMessage({ from: phone.id, to: "hub", kind: "cloud" }, taskBody("c1"), phone.keys.privateKey, hubKey.publicKey);
  await hub.onFrame(phone.id, JSON.stringify({ t: "send", env }));
  assert.deepEqual(fired, ["Task: Fix the test\n\npnpm test fails"]);
  const reply = sockets.frames(phone.id, "deliver").at(-1);
  assert.ok(reply?.t === "deliver");
  assert.deepEqual(await openEnvelope(reply.env, phone.keys.privateKey, hubKey.publicKey), { type: "cloud_started", taskId: "c1", sessionUrl: "https://claude.ai/code/session_1" });
  assert.ok(!JSON.stringify(store.auditList(100)).includes("Fix the test"));

  // A plain task kind cannot be sent to the hub; and with the path switched off it is refused.
  const wrong = await sealMessage({ from: phone.id, to: "hub", kind: "task" }, taskBody("c2"), phone.keys.privateKey, hubKey.publicKey);
  await hub.onFrame(phone.id, JSON.stringify({ t: "send", env: wrong }));
  assert.equal((sockets.frames(phone.id, "refused").at(-1) as { code: string }).code, "not-allowed");
  hub.setCloudOff(true);
  const again = await sealMessage({ from: phone.id, to: "hub", kind: "cloud" }, taskBody("c3"), phone.keys.privateKey, hubKey.publicKey);
  await hub.onFrame(phone.id, JSON.stringify({ t: "send", env: again }));
  assert.equal((sockets.frames(phone.id, "refused").at(-1) as { code: string }).code, "cloud-off");
  assert.equal(fired.length, 1);

  // No trigger set: refused (the hub still has its own key, made on first use).
  const bare = await setup();
  const p = await pair(bare.hub, "phone", "Phone");
  bare.sockets.on.add(p.id);
  const e = await sealMessage({ from: p.id, to: "hub", kind: "cloud" }, taskBody("c4"), p.keys.privateKey, hubKey.publicKey);
  await bare.hub.onFrame(p.id, JSON.stringify({ t: "send", env: e }));
  assert.equal((bare.sockets.frames(p.id, "refused").at(-1) as { code: string }).code, "cloud-off");
});

test("kill switches: pause closes sockets and refuses, kill-all revokes everything", async () => {
  const { hub, store, sockets } = await setup();
  const pc = await pair(hub, "pc", "PC");
  sockets.on.add(pc.id);
  hub.setPaused(true);
  assert.ok(sockets.closed.includes(pc.id));
  const t = await hub.issueTicket(pc.token);
  assert.ok(isHubError(t) && t.status === 503);
  hub.setPaused(false);
  assert.ok(!isHubError(await hub.issueTicket(pc.token)));
  const s = await hub.signIn("ok:sub-owner", "ip");
  assert.ok(!isHubError(s));
  hub.killAll();
  assert.equal(store.devices().length, 0);
  assert.equal(await hub.checkSession(s.session), false);
  assert.ok(isHubError(await hub.issueTicket(pc.token)));
});

test("live agent activity: only an opted-in PC, kept as a short ring per run, delivered live, caught up by seq", async () => {
  const { hub, store, sockets, tick } = await setup();
  const pc = await pair(hub, "pc", "PC");
  const phone = await pair(hub, "phone", "Phone");
  sockets.on.add(pc.id);
  sockets.on.add(phone.id);
  const state = { runId: "h-1", title: "Look into it", source: "chat-helper", state: "running", step: 1, startedAt: 1, lastEventAt: 2, files: 0, fileNames: [] } as const;
  const batch = async (n: number, run = "h-1") => ({ ...(await sealMessage({ from: pc.id, to: phone.id, kind: "agent_event" }, { type: "agent_event", runId: run, state: { ...state, runId: run }, events: Array.from({ length: n }, (_, i) => ({ seq: i + 1, t: 1, type: "step" as const, n: i, label: "x" })) }, pc.keys.privateKey, phone.keys.publicKey)), run, n });
  const send = async (envs: unknown[]) => hub.onFrame(pc.id, JSON.stringify({ t: "agents", envs }));

  // Not opted in: refused, nothing kept.
  await send([await batch(1)]);
  assert.equal(store.agentEventCount(), 0);
  assert.equal((sockets.frames(pc.id, "refused").at(-1) as { code: string }).code, "not-allowed");
  await hub.onFrame(pc.id, JSON.stringify({ t: "beat", busy: true, agents: [], optIn: { appear: true, reportActivity: true } }));

  // Opted in: delivered at once with the hub's seq and time, and opens on the phone.
  await send([await batch(2)]);
  const live = sockets.frames(phone.id, "deliver").at(-1) as { env: { seq: number; at: number; run: string } };
  assert.ok(live.env.seq > 0 && live.env.at > 0 && live.env.run === "h-1");
  const body = await openEnvelope(live.env as never, phone.keys.privateKey, pc.keys.publicKey);
  assert.equal(body.type, "agent_event");

  // Heartbeats replace each other; events past 50 per run push the oldest batches out.
  await send([await batch(0)]);
  await send([await batch(0)]);
  assert.equal(store.agentEvents(phone.id, 0, 500).filter((r) => r.n === 0).length, 1);
  for (let i = 0; i < 30; i++) await send([await batch(5)]);
  const rows = store.agentEvents(phone.id, 0, 500).filter((r) => r.run === "h-1" && r.n > 0);
  assert.ok(rows.reduce((a, r) => a + r.n, 0) <= 50, "at most 50 events per run");
  await send([await batch(3, "h-2")]);

  // Catch-up by seq with the phone's token; the PC's token sees only what was sealed to it.
  const all = await hub.agentsSince(phone.token, "0");
  assert.ok(!isHubError(all) && all.envs.length === store.agentEventCount());
  const later = await hub.agentsSince(phone.token, String(all.envs.at(-2)!.seq));
  assert.ok(!isHubError(later) && later.envs.length === 1 && later.envs[0]!.run === "h-2");
  const pcView = await hub.agentsSince(pc.token, "0");
  assert.ok(!isHubError(pcView) && pcView.envs.length === 0);
  assert.ok(isHubError(await hub.agentsSince("kh_nope", "0")));

  // A batch claiming another sender is refused; a task kind inside an agents frame is a bad frame.
  const forged = { ...(await batch(1)), from: phone.id };
  await send([forged]);
  assert.equal((sockets.frames(pc.id, "refused").at(-1) as { code: string }).code, "not-allowed");

  // The page's counter, the 7-day prune and the purge.
  const st = await hub.state();
  assert.ok(st.agents.kept > 0 && st.agents.writtenToday > 0 && st.agents.freeWrites === 100_000);
  tick(8 * 24 * 3600 * 1000);
  hub.cleanup();
  assert.equal(store.agentEventCount(), 0);
  await send([await batch(1)]);
  hub.dropAgentActivity();
  assert.equal(store.agentEventCount(), 0);
});

test("older clients: a 0.6.401 PC (old opt-in, unknown fields) stays online; unknown frames are refused alone; ping", async () => {
  const { hub, store, sockets } = await setup();
  const pc = await pair(hub, "pc", "Old PC");
  sockets.on.add(pc.id);
  await hub.onOpen(pc.id);
  // 0.6.401's hello: an opt-in without the activity fields, plus fields this hub does not know.
  await hub.onFrame(pc.id, JSON.stringify({ t: "hello", version: "0.6.401", platform: "win32", busy: false, optIn: { appear: true, acceptTasks: false, acceptLocal: false, acceptAntigravity: false, reportLinks: false }, agents: [{ kind: "local-model", state: "on", label: "Qwen", extra: 1 }], futureField: { x: 1 } }));
  await hub.onFrame(pc.id, JSON.stringify({ t: "beat", busy: true, agents: [], somethingNew: true }));
  // A frame from a newer client this hub does not know: refused, nothing else changes.
  await hub.onFrame(pc.id, JSON.stringify({ t: "from-the-future", data: 1 }));
  assert.deepEqual(sockets.frames(pc.id, "refused").at(-1), { t: "refused", code: "bad-frame" });
  assert.equal(sockets.closed.includes(pc.id), false, "never disconnected for an unknown frame");
  const d = (await hub.state()).devices.find((x) => x.id === pc.id)!;
  assert.equal(d.online, true);
  assert.equal(d.version, "0.6.401");
  assert.equal(d.busy, true);
  assert.equal(d.optIn.reportActivity, false, "missing opt-in fields take the defaults");
  assert.ok(store.device(pc.id)?.lastSeen);
  // The keep-alive ping is answered (on Cloudflare the auto-response does this without waking the hub).
  await hub.onFrame(pc.id, JSON.stringify({ t: "ping" }));
  assert.deepEqual(sockets.frames(pc.id, "pong").length, 1);
});

test("task-inbox reports: only from a PC to a phone, queued while the phone is off, never audited with content", async () => {
  const { hub, store, sockets } = await setup();
  const pc = await pair(hub, "pc", "Home PC");
  const phone = await pair(hub, "phone", "Phone");
  sockets.on.add(pc.id);
  await hub.onOpen(pc.id);
  const body: SealedBody = { type: "inbox_task", taskId: "c-1120-01", title: "Fix the hub status", state: "running", executor: "antigravity", from: "claude", runId: "in-c-1120-01", at: 5 };
  const env = await sealMessage({ from: pc.id, to: phone.id, kind: "inbox_task", ttl: 7 * 24 * 3600 }, body, pc.keys.privateKey, phone.keys.publicKey);
  await hub.onFrame(pc.id, JSON.stringify({ t: "send", env }));
  assert.deepEqual(sockets.frames(pc.id, "sent").at(-1), { t: "sent", id: env.id, queued: true });
  assert.ok(!store.queued(phone.id)[0]!.env.includes("Fix the hub"), "the hub holds only ciphertext");
  // The phone comes on: delivered and opened.
  sockets.on.add(phone.id);
  await hub.onOpen(phone.id);
  const got = sockets.frames(phone.id, "deliver").at(-1);
  assert.ok(got?.t === "deliver");
  assert.deepEqual(await openEnvelope(got.env, phone.keys.privateKey, pc.keys.publicKey), body);
  // A phone cannot send inbox reports (only the PC that has the inbox).
  const fake = await sealMessage({ from: phone.id, to: pc.id, kind: "inbox_task" }, body, phone.keys.privateKey, pc.keys.publicKey);
  await hub.onFrame(phone.id, JSON.stringify({ t: "send", env: fake }));
  assert.deepEqual(sockets.frames(phone.id, "refused").at(-1), { t: "refused", code: "not-allowed", id: fake.id });
  assert.ok(!JSON.stringify(store.auditList(100)).includes("inbox"));
});

test("Claude chat device: pairs by code, reports agent activity without PC opt-ins, never relays or takes tasks", async () => {
  const { hub, store, sockets } = await setup();
  const chat = await pair(hub, "claude-chat", "Claude chat");
  const phone = await pair(hub, "phone", "Phone");
  const pc = await pair(hub, "pc", "PC");
  sockets.on.add(chat.id);
  sockets.on.add(phone.id);
  sockets.on.add(pc.id);
  assert.equal(store.device(chat.id)?.kind, "claude-chat");
  assert.equal(hub.presence().find((d) => d.id === chat.id)?.kind, "claude-chat");
  // An unknown kind still pairs as a PC (old and odd clients keep working).
  const odd = await hub.pairStart("1.2.3.4", { publicKey: (await generateHubKeys(true)).publicKey, kind: "toaster" });
  assert.ok(!isHubError(odd) && !isHubError(await hub.pairPeek(odd.code)) && (await hub.pairPeek(odd.code) as { kind: string }).kind === "pc");

  // Its hello cannot turn on worker opt-ins or report agents; activity stays on.
  await hub.onFrame(chat.id, JSON.stringify({ t: "hello", version: "hub-report 1", busy: false, optIn: { appear: true, acceptTasks: true, acceptLocal: true }, agents: [{ kind: "local-model", state: "on" }] }));
  const row = store.device(chat.id)!;
  assert.equal(row.optIn.acceptTasks, false);
  assert.equal(row.optIn.reportActivity, true);
  assert.deepEqual(row.agents, []);

  const state = { runId: "cc-1", title: "🔨 Build", source: "claude-chat", state: "running", step: 0, startedAt: 1, lastEventAt: 1, files: 0, fileNames: [] } as const;
  const env = { ...(await sealMessage({ from: chat.id, to: phone.id, kind: "agent_event" }, { type: "agent_event", runId: "cc-1", state, events: [{ seq: 1, t: 1, type: "started", title: "🔨 Build", source: "claude-chat" }] }, chat.keys.privateKey, phone.keys.publicKey)), run: "cc-1", n: 1 };
  await hub.onFrame(chat.id, JSON.stringify({ t: "agents", envs: [env] }));
  const live = sockets.frames(phone.id, "deliver").at(-1) as { env: { run: string } };
  assert.equal(live.env.run, "cc-1");
  const body = await openEnvelope(live.env as never, phone.keys.privateKey, chat.keys.publicKey);
  assert.ok(body.type === "agent_event" && body.state.source === "claude-chat");

  // No relayed messages from it, and nothing relayed to it (a task, a result).
  const task = await sealMessage({ from: chat.id, to: pc.id, kind: "task" }, { type: "task", taskId: "t1", title: "x", spec: "x", executor: "pc-any", ifOffline: "wait", createdAt: new Date().toISOString() }, chat.keys.privateKey, pc.keys.publicKey);
  await hub.onFrame(chat.id, JSON.stringify({ t: "send", env: task }));
  assert.equal((sockets.frames(chat.id, "refused").at(-1) as { code: string }).code, "not-allowed");
  const res = await sealMessage({ from: pc.id, to: chat.id, kind: "result" }, { type: "result", taskId: "t1", status: "done", text: "x" }, pc.keys.privateKey, chat.keys.publicKey);
  await hub.onFrame(pc.id, JSON.stringify({ t: "send", env: res }));
  assert.equal((sockets.frames(pc.id, "refused").at(-1) as { code: string }).code, "not-allowed");
  assert.equal(store.queued(chat.id).length, 0);
});

test("sync ping: passed on bare to the other devices (not the sender, not the Claude chat), one per 5 seconds", async () => {
  const { hub, sockets, tick } = await setup();
  const pc = await pair(hub, "pc", "PC");
  const phone = await pair(hub, "phone", "Phone");
  const chat = await pair(hub, "claude-chat", "Claude chat");
  for (const d of [pc, phone, chat]) {
    sockets.on.add(d.id);
    await hub.onOpen(d.id);
  }
  await hub.onFrame(pc.id, JSON.stringify({ t: "sync", data: "ignored" }));
  assert.deepEqual(sockets.frames(phone.id, "sync"), [{ t: "sync" }], "nothing but the ping itself");
  assert.equal(sockets.frames(pc.id, "sync").length, 0, "not back to the sender");
  assert.equal(sockets.frames(chat.id, "sync").length, 0, "the Claude chat has no Drive");
  // A burst of 2 for jitter, then dropped without a refusal (that would slow the PC's live activity).
  await hub.onFrame(pc.id, JSON.stringify({ t: "sync" }));
  await hub.onFrame(pc.id, JSON.stringify({ t: "sync" }));
  assert.equal(sockets.frames(phone.id, "sync").length, 2);
  assert.equal(sockets.frames(pc.id, "refused").length, 0);
  tick(5000);
  await hub.onFrame(pc.id, JSON.stringify({ t: "sync" }));
  assert.equal(sockets.frames(phone.id, "sync").length, 3, "one more after 5 seconds");
  // The phone (hub page) pings the PC; the Claude chat cannot ping anyone.
  await hub.onFrame(phone.id, JSON.stringify({ t: "sync" }));
  assert.equal(sockets.frames(pc.id, "sync").length, 1);
  await hub.onFrame(chat.id, JSON.stringify({ t: "sync" }));
  assert.equal(sockets.frames(pc.id, "sync").length, 1);
  assert.equal(sockets.frames(phone.id, "sync").length, 3);
});

test("approvals: a PC's snapshot goes to phones only; answers go from a phone to a PC only, rate limited and audited without content", async () => {
  const { hub, store, sockets } = await setup();
  const pc = await pair(hub, "pc", "Home PC");
  const phone = await pair(hub, "phone", "Phone");
  for (const d of [pc, phone]) {
    sockets.on.add(d.id);
    await hub.onOpen(d.id);
  }
  const snap: SealedBody = { type: "approvals", at: 1, items: [{ requestId: "req-zq9-only-sealed", conversationId: "c1", title: "Fix the build", tool: "run_command", reason: "Runs a command", preview: "pnpm test", kind: "tool", forWhile: true, at: 1 }] };
  const env = await sealMessage({ from: pc.id, to: phone.id, kind: "approvals" }, snap, pc.keys.privateKey, phone.keys.publicKey);
  await hub.onFrame(pc.id, JSON.stringify({ t: "send", env }));
  const got = sockets.frames(phone.id, "deliver").at(-1);
  assert.ok(got?.t === "deliver" && got.env.ttl <= 30 * 60, "kept 30 minutes at most");
  assert.deepEqual(await openEnvelope(got.env, phone.keys.privateKey, pc.keys.publicKey), snap);
  // A phone cannot send a snapshot; a PC cannot answer approvals.
  const fakeSnap = await sealMessage({ from: phone.id, to: pc.id, kind: "approvals" }, snap, phone.keys.privateKey, pc.keys.publicKey);
  await hub.onFrame(phone.id, JSON.stringify({ t: "send", env: fakeSnap }));
  assert.deepEqual(sockets.frames(phone.id, "refused").at(-1), { t: "refused", code: "not-allowed", id: fakeSnap.id });
  const answer: SealedBody = { type: "approval_answer", requestId: "req-zq9-only-sealed", conversationId: "c1", decision: "allow", forMinutes: 60 };
  const fromPc = await sealMessage({ from: pc.id, to: phone.id, kind: "approval_answer" }, answer, pc.keys.privateKey, phone.keys.publicKey);
  await hub.onFrame(pc.id, JSON.stringify({ t: "send", env: fromPc }));
  assert.deepEqual(sockets.frames(pc.id, "refused").at(-1), { t: "refused", code: "not-allowed", id: fromPc.id });
  // The phone's answer reaches the PC sealed; the audit line names the kind and the device, nothing else.
  const ok = await sealMessage({ from: phone.id, to: pc.id, kind: "approval_answer" }, answer, phone.keys.privateKey, pc.keys.publicKey);
  await hub.onFrame(phone.id, JSON.stringify({ t: "send", env: ok }));
  const delivered = sockets.frames(pc.id, "deliver").at(-1);
  assert.ok(delivered?.t === "deliver" && delivered.env.id === ok.id);
  assert.deepEqual(await openEnvelope(delivered.env, pc.keys.privateKey, phone.keys.publicKey), answer);
  const audit = store.auditList(100);
  assert.ok(audit.some((a) => a.action === "relay-approval_answer" && a.deviceId === phone.id));
  assert.ok(!audit.some((a) => a.action === "relay-approvals"), "snapshots are not audited");
  assert.ok(!JSON.stringify(audit).includes("req-zq9-only-sealed") && !JSON.stringify(audit).includes("Fix the build"));
  // At most 30 answers a minute per device (the 31st is refused).
  for (let i = 0; i < 30; i++) {
    const e = await sealMessage({ from: phone.id, to: pc.id, kind: "approval_answer" }, answer, phone.keys.privateKey, pc.keys.publicKey);
    await hub.onFrame(phone.id, JSON.stringify({ t: "send", env: e }));
  }
  assert.equal(sockets.frames(phone.id, "refused").at(-1)?.t === "refused" && (sockets.frames(phone.id, "refused").at(-1) as { code: string }).code, "rate-limited");
});

test("Run / Cancel commands: from a phone to a PC only (audited without content); results from a PC to a phone only", async () => {
  const { hub, store, sockets } = await setup();
  const pc = await pair(hub, "pc", "Home PC");
  const phone = await pair(hub, "phone", "Phone");
  for (const d of [pc, phone]) {
    sockets.on.add(d.id);
    await hub.onOpen(d.id);
  }
  const cmd: SealedBody = { type: "command", commandId: "k1", action: "inbox-run", taskId: "agy-secret-task" };
  const ok = await sealMessage({ from: phone.id, to: pc.id, kind: "command" }, cmd, phone.keys.privateKey, pc.keys.publicKey);
  await hub.onFrame(phone.id, JSON.stringify({ t: "send", env: ok }));
  const got = sockets.frames(pc.id, "deliver").at(-1);
  assert.ok(got?.t === "deliver" && got.env.id === ok.id);
  assert.deepEqual(await openEnvelope(got.env, pc.keys.privateKey, phone.keys.publicKey), cmd);
  const bad = await sealMessage({ from: pc.id, to: phone.id, kind: "command" }, cmd, pc.keys.privateKey, phone.keys.publicKey);
  await hub.onFrame(pc.id, JSON.stringify({ t: "send", env: bad }));
  assert.deepEqual(sockets.frames(pc.id, "refused").at(-1), { t: "refused", code: "not-allowed", id: bad.id });
  const result: SealedBody = { type: "command_result", commandId: "k1", taskId: "agy-secret-task", ok: true, text: "Started on the PC." };
  const fake = await sealMessage({ from: phone.id, to: pc.id, kind: "command_result" }, result, phone.keys.privateKey, pc.keys.publicKey);
  await hub.onFrame(phone.id, JSON.stringify({ t: "send", env: fake }));
  assert.deepEqual(sockets.frames(phone.id, "refused").at(-1), { t: "refused", code: "not-allowed", id: fake.id });
  const back = await sealMessage({ from: pc.id, to: phone.id, kind: "command_result" }, result, pc.keys.privateKey, phone.keys.publicKey);
  await hub.onFrame(pc.id, JSON.stringify({ t: "send", env: back }));
  assert.equal(sockets.frames(phone.id, "deliver").at(-1)?.t, "deliver");
  const audit = JSON.stringify(store.auditList(100));
  assert.ok(audit.includes("relay-command") && !audit.includes("relay-command_result") && !audit.includes("agy-secret"));
});

test("agent-event rows have a total cap: the oldest go first, whatever the run", () => {
  const store = new MemoryStore();
  const add = (run: string, n: number) => store.addAgentEvent({ to: "p", from: "pc", run, n, env: "{}", createdAt: 1 }, 50);
  const first = add("r0", 1);
  for (let i = 1; i < 10; i++) add(`r${i}`, 1);
  store.capAgentEvents(4);
  const left = store.agentEvents("p", 0, 100);
  assert.equal(left.length, 4);
  assert.deepEqual(left.map((r) => r.run), ["r6", "r7", "r8", "r9"], "the newest are kept");
  assert.ok(left.every((r) => r.seq > first.seq));
  store.capAgentEvents(100);
  assert.equal(store.agentEventCount(), 4, "under the cap nothing goes");
});
