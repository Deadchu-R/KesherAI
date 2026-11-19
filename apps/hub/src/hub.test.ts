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
async function pair(hub: Hub, kind: "pc" | "phone", name: string): Promise<{ id: string; token: string; keys: HubKeyPair }> {
  const keys = await generateHubKeys(true);
  const start = await hub.pairStart("1.2.3.4", { publicKey: keys.publicKey, kind, name });
  assert.ok(!isHubError(start));
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
