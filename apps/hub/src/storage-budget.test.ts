import { test } from "node:test";
import assert from "node:assert/strict";
import { exportPrivateJwk, generateHubKeys, sealMessage, type HubFrame, type HubKeyPair, type SealedBody } from "../../../packages/shared/src/hub.js";
import { DEFAULT_OPT_IN, sha256Hex } from "../../../packages/shared/src/hub.js";
import { CachedStore } from "./cached-store.js";
import { deriveHmacKey, issueDeviceToken, verifyDeviceToken } from "./device-token.js";
import { Hub, HUB_TIMES, isHubError, type DeviceSockets } from "./hub.js";
import { SqlStore } from "./sql-store.js";
import { guardStore, HubStorageError } from "./storage-guard.js";
import { MemoryStore, type HubStore } from "./store.js";
import { UsageMeter } from "./usage.js";
import type { SqlStorage } from "./cf.js";

/** Sockets in memory. */
class Sockets implements DeviceSockets {
  on = new Set<string>();
  got = new Map<string, HubFrame[]>();
  send(id: string, f: HubFrame): boolean {
    if (!this.on.has(id)) return false;
    this.got.set(id, [...(this.got.get(id) ?? []), f]);
    return true;
  }
  isOnline(id: string): boolean {
    return this.on.has(id);
  }
  close(id: string): void {
    this.on.delete(id);
  }
  closeAll(): void {
    this.on.clear();
  }
  frames(id: string, t: HubFrame["t"]): HubFrame[] {
    return (this.got.get(id) ?? []).filter((f) => f.t === t);
  }
}

/** Store methods that only read (everything else writes). */
const READS = /^(get|devices|device$|deviceBy|session$|pairingBy|pairingCount|queued|queueCount|auditList|agentEvent|oauthClient|grant)/;

/**
 * A MemoryStore that refuses like Cloudflare's quota: `"writes"` refuses writes, `"all"` reads too. Guarded like
 * production, so the hub sees {@link HubStorageError}s. Counts calls per method.
 */
function refusingStore() {
  const mem = new MemoryStore();
  const state = { mode: "none" as "none" | "writes" | "all", calls: {} as Record<string, number> };
  const raw = new Proxy(mem, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== "function" || typeof prop !== "string") return v;
      return (...args: unknown[]) => {
        state.calls[prop] = (state.calls[prop] ?? 0) + 1;
        if (state.mode === "all" || (state.mode === "writes" && !READS.test(prop))) throw new Error("Exceeded allowed rows written in Durable Objects free tier.");
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { mem, state, store: guardStore(raw as HubStore) };
}

async function setup(opts: { secret?: boolean; store?: HubStore } = {}) {
  let now = 1_000_000;
  const r = refusingStore();
  const sockets = new Sockets();
  const jwk = opts.secret === false ? undefined : await exportPrivateJwk((await generateHubKeys(true)).privateKey);
  const make = (store: HubStore) =>
    new Hub({ store, sockets, config: { allowedEmail: "o@example.com", ...(jwk ? { hubPrivateJwk: jwk } : {}) }, verifyIdToken: async () => Promise.reject(new Error("no")), fireClaude: async () => ({ ok: true as const }), now: () => now, schedule: () => {} });
  const hub = make(opts.store ?? r.store);
  return { ...r, hub, sockets, jwk, make, tick: (ms: number) => (now += ms) };
}

async function pair(hub: Hub, kind: "pc" | "phone", name: string): Promise<{ id: string; token: string; keys: HubKeyPair }> {
  const keys = await generateHubKeys(true);
  const start = await hub.pairStart("1.2.3.4", { publicKey: keys.publicKey, kind, name });
  assert.ok(!isHubError(start));
  assert.ok(!isHubError(await hub.pairApprove(start.code)));
  const done = await hub.pairPoll("1.2.3.4", start.pollSecret);
  assert.ok(!isHubError(done) && done.status === "paired");
  return { id: done.deviceId, token: done.token, keys };
}

test("kh2 tokens: signed claims verify, a changed one fails, and a key from another secret fails", async () => {
  const jwk = await exportPrivateJwk((await generateHubKeys(true)).privateKey);
  const key = await deriveHmacKey(jwk, "device-token-v2");
  const token = await issueDeviceToken(key, { deviceId: "dAbc123", kind: "phone", issuedAt: 1_700_000_000_000 });
  assert.ok(token.startsWith("kh2_dAbc123.phone.") && token.length < 100);
  assert.deepEqual(await verifyDeviceToken(key, token), { deviceId: "dAbc123", kind: "phone", issuedAt: 1_700_000_000_000 });
  assert.equal(await verifyDeviceToken(key, token.replace(".phone.", ".pc.")), undefined, "another kind");
  assert.equal(await verifyDeviceToken(key, token.replace("dAbc123", "dAbc124")), undefined, "another device");
  assert.equal(await verifyDeviceToken(await deriveHmacKey(jwk, "socket-ticket-v1"), token), undefined, "another purpose's key");
  assert.equal(await verifyDeviceToken(key, "kh2_garbage"), undefined);
});

test("kh2 tokens: issued at pairing, rotate to a new kh2 (the old stops), revoked ones are refused; old kh_ tokens still work and are moved to kh2", async () => {
  const { hub, mem } = await setup();
  const pc = await pair(hub, "pc", "PC");
  assert.match(pc.token, /^kh2_/);
  assert.equal((await hub.deviceForToken(pc.token))?.id, pc.id);
  const t = await hub.issueTicket(pc.token);
  assert.ok(!isHubError(t) && t.rotateDue === false);
  const rot = await hub.rotateToken(pc.token);
  assert.ok(!isHubError(rot) && rot.token.startsWith("kh2_") && rot.token !== pc.token);
  assert.equal(await hub.deviceForToken(pc.token), undefined, "the rotated token stops at once");
  assert.equal((await hub.deviceForToken(rot.token))?.id, pc.id);

  // A device paired before kh2 (a kh_ token): it still works, and its ticket asks it to rotate to kh2.
  const old = "kh_" + "o".repeat(43);
  mem.putDevice({ id: "dOld", name: "Old PC", kind: "pc", publicKey: (await generateHubKeys(true)).publicKey, tokenHash: await sha256Hex(old), tokenIssuedAt: 1_000_000, createdAt: 1_000_000, busy: false, optIn: { ...DEFAULT_OPT_IN }, agents: [] });
  const fresh = await setup({ store: mem });
  const t2 = await fresh.hub.issueTicket(old);
  assert.ok(!isHubError(t2) && t2.rotateDue === true, "moved to a signed token");
  const moved = await fresh.hub.rotateToken(old);
  assert.ok(!isHubError(moved) && moved.token.startsWith("kh2_"));
  assert.equal(await fresh.hub.deviceForToken(old), undefined);

  assert.ok(hub.revoke(pc.id));
  assert.equal(await hub.deviceForToken(rot.token), undefined, "revoked");
  assert.match(mem.getSetting("revokedIds") ?? "", new RegExp(pc.id), "the revocation is saved");
});

test("a kh2 token from another key falls back to its stored hash (a changed HUB_PRIVATE_KEY never locks a device out)", async () => {
  const a = await setup({ secret: false });
  const pc = await pair(a.hub, "pc", "PC");
  assert.match(pc.token, /^kh2_/, "signed with the key the hub keeps when no secret is set");
  const b = await setup({ store: a.mem });
  assert.equal((await b.hub.deviceForToken(pc.token))?.id, pc.id);
});

test("auth from memory: once devices are loaded, tickets need no storage at all (old and signed tokens)", async () => {
  const { hub, state, mem } = await setup();
  const pc = await pair(hub, "pc", "PC");
  const old = "kh_" + "p".repeat(43);
  mem.putDevice({ id: "dOld", name: "Old", kind: "phone", publicKey: (await generateHubKeys(true)).publicKey, tokenHash: await sha256Hex(old), tokenIssuedAt: 1_000_000, createdAt: 1_000_000, busy: false, optIn: { ...DEFAULT_OPT_IN }, agents: [] });
  // A hub that just woke: the first token loads every device in one read.
  const { make } = await setup();
  const warm = make(hub["store"]["inner" as never] as HubStore);
  assert.ok(!isHubError(await warm.issueTicket(old)));
  state.mode = "all";
  for (const tok of [old, pc.token]) assert.ok(!isHubError(await warm.issueTicket(tok)), "answered from memory while storage refuses reads and writes");
});

test("cold start with storage refusing reads: a kh2 device still gets a ticket and a socket; an old kh_ token gets a 503", async () => {
  const { hub, mem, jwk } = await setup();
  const pc = await pair(hub, "pc", "PC");
  const r = refusingStore();
  for (const d of mem.devices()) r.mem.putDevice(d);
  r.state.mode = "all";
  const sockets = new Sockets();
  const cold = new Hub({ store: r.store, sockets, config: { hubPrivateJwk: jwk! }, verifyIdToken: async () => Promise.reject(new Error("no")), fireClaude: async () => ({ ok: true as const }), now: () => 1_000_000, schedule: () => {} });
  const t = await cold.issueTicket(pc.token);
  assert.ok(!isHubError(t), "signed token checked without storage");
  const d = await cold.takeTicket(t.ticket);
  assert.equal(d?.id, pc.id);
  sockets.on.add(pc.id);
  await cold.onOpen(pc.id);
  assert.equal(sockets.frames(pc.id, "welcome").length, 1);
  assert.ok(!cold.presence().some((p) => p.id === pc.id), "a stand-in without a key is not listed");
  await assert.rejects(cold.issueTicket("kh_" + "x".repeat(43)), HubStorageError);
  await assert.rejects(cold.rotateToken(pc.token), HubStorageError, "a rotate must be kept: 503, the token stays");
});

test("relaying with storage refusing everything: live frames and queued kinds reach devices that are on; a message for an off device is a storage-limit refusal", async () => {
  const { hub, state, sockets } = await setup();
  const pc = await pair(hub, "pc", "PC");
  const phone = await pair(hub, "phone", "Phone");
  for (const d of [pc, phone]) {
    sockets.on.add(d.id);
    await hub.onOpen(d.id);
  }
  await hub.onFrame(pc.id, JSON.stringify({ t: "hello", version: "0.6.0", busy: false, optIn: { appear: true, reportActivity: true, acceptTasks: true }, agents: [] }));
  state.mode = "all";
  const board = await sealMessage({ from: pc.id, to: phone.id, kind: "board" }, { type: "board", rev: 1, items: [], doneTotal: 0, at: 1 }, pc.keys.privateKey, phone.keys.publicKey);
  await hub.onFrame(pc.id, JSON.stringify({ t: "send", env: board }));
  assert.equal(sockets.frames(phone.id, "deliver").at(-1)?.t === "deliver" && (sockets.frames(phone.id, "deliver").at(-1) as { env: { id: string } }).env.id, board.id);
  const cmd: SealedBody = { type: "command", commandId: "k1", action: "inbox-run", taskId: "t1" };
  const env = await sealMessage({ from: phone.id, to: pc.id, kind: "command" }, cmd, phone.keys.privateKey, pc.keys.publicKey);
  await hub.onFrame(phone.id, JSON.stringify({ t: "send", env }));
  assert.equal((sockets.frames(pc.id, "deliver").at(-1) as { env: { id: string } }).env.id, env.id, "delivered live although it could not be queued");
  assert.deepEqual(sockets.frames(phone.id, "sent").at(-1), { t: "sent", id: env.id, queued: false });
  await hub.onFrame(pc.id, JSON.stringify({ t: "beat", busy: true, agents: [] }));
  assert.equal(hub.presence().find((p) => p.id === pc.id)?.busy, true, "presence still moves");
  sockets.on.delete(pc.id);
  hub.onClose(pc.id);
  const later = await sealMessage({ from: phone.id, to: pc.id, kind: "command" }, cmd, phone.keys.privateKey, pc.keys.publicKey);
  await hub.onFrame(phone.id, JSON.stringify({ t: "send", env: later }));
  assert.deepEqual(sockets.frames(phone.id, "refused").at(-1), { t: "refused", code: "storage-limit", id: later.id });
  await assert.rejects(hub.answerByHttp(phone.token, { env: await sealMessage({ from: phone.id, to: pc.id, kind: "approval_answer" }, { type: "approval_answer", requestId: "r1", allow: true } as unknown as SealedBody, phone.keys.privateKey, pc.keys.publicKey) }), HubStorageError);
  // New pairings must be kept: refused.
  await assert.rejects(hub.pairStart("9.9.9.9", { publicKey: (await generateHubKeys(true)).publicKey }), HubStorageError);
});

test("a hub that wakes without storage relays between the devices its sockets carry (seeded cache)", async () => {
  const { hub, mem, sockets, jwk } = await setup();
  const pc = await pair(hub, "pc", "PC");
  const phone = await pair(hub, "phone", "Phone");
  const r = refusingStore();
  r.state.mode = "all";
  const cache = new CachedStore(r.store);
  cache.seed(mem.devices().map((d) => (d.id === pc.id ? { ...d, optIn: { ...d.optIn, appear: true, reportActivity: true } } : d)));
  const woke = new Hub({ store: cache, sockets, config: { hubPrivateJwk: jwk! }, verifyIdToken: async () => Promise.reject(new Error("no")), fireClaude: async () => ({ ok: true as const }), now: () => 1_000_000, schedule: () => {} });
  sockets.on.add(pc.id).add(phone.id);
  const run = { runId: "r1", title: "x", source: "chat-helper", state: "running", step: 1, startedAt: 1, lastEventAt: 2, files: 0, fileNames: [] } as const;
  const batch = { ...(await sealMessage({ from: pc.id, to: phone.id, kind: "agent_event" }, { type: "agent_event", runId: "r1", state: run, events: [{ seq: 1, t: 1, type: "step" as const, n: 0, label: "x" }] }, pc.keys.privateKey, phone.keys.publicKey)), run: "r1", n: 1 };
  await woke.onFrame(pc.id, JSON.stringify({ t: "agents", envs: [batch] }));
  assert.equal(sockets.frames(phone.id, "deliver").length, 1, "live activity relayed with no storage at all");
  assert.equal(woke.presence().length, 2);
});

test("cleanup: at most hourly, and skipped while nothing that can expire was written", async () => {
  const { hub, state, tick } = await setup();
  await pair(hub, "pc", "PC");
  const runs = () => state.calls.pruneSessions ?? 0;
  assert.notEqual(hub.cleanup(), undefined);
  assert.equal(runs(), 1, "the first run after a wake cleans");
  tick(5 * 60_000);
  hub.cleanup();
  assert.equal(runs(), 1, "an old 5-minute cron is skipped");
  tick(HUB_TIMES.cleanupGap);
  assert.equal(hub.cleanup(), undefined);
  assert.equal(runs(), 1, "nothing written since: skipped");
  await hub.pairStart("5.5.5.5", { publicKey: (await generateHubKeys(true)).publicKey });
  tick(HUB_TIMES.cleanupGap);
  hub.cleanup();
  assert.equal(runs(), 2, "a pairing was written: cleaned");
  tick(HUB_TIMES.cleanupIdle);
  hub.cleanup();
  assert.equal(runs(), 3, "and at least every 6 hours");
});

test("reads are cut: frames, presence and the owner page are answered from memory", async () => {
  const { hub, state, sockets } = await setup();
  const pc = await pair(hub, "pc", "PC");
  const phone = await pair(hub, "phone", "Phone");
  for (const d of [pc, phone]) {
    sockets.on.add(d.id);
    await hub.onOpen(d.id);
  }
  await hub.state();
  const reads = () => Object.entries(state.calls).filter(([k]) => READS.test(k)).reduce((n, [, v]) => n + v, 0);
  const before = reads();
  for (let i = 0; i < 50; i++) await hub.onFrame(pc.id, JSON.stringify({ t: "beat", busy: i % 2 === 0, agents: [] }));
  await hub.state();
  await hub.state();
  assert.equal(reads() - before, 0, "50 beats and two page refreshes read nothing (sessions aside)");
});

test("usage counters: rows read and written per kind, per UTC day, from the SQLite cursor", () => {
  let now = Date.UTC(2026, 10, 22, 23, 59);
  const meter = new UsageMeter(() => now);
  const sql: SqlStorage = { exec: (q: string) => ({ toArray: () => (/^SELECT v/.test(q) ? [{ v: "1" }] : []), rowsRead: /^SELECT/.test(q) ? 1 : 0, rowsWritten: /^INSERT/.test(q) ? 2 : 0 }) };
  const store = new SqlStore(sql, meter);
  store.setSetting("a", "1");
  store.getSetting("a");
  store.getSetting("a");
  const snap = meter.snapshot();
  assert.equal(snap.day, "2026-11-22");
  assert.deepEqual(snap.byKind.setSetting, { calls: 1, read: 0, written: 2, refused: 0 });
  assert.deepEqual(snap.byKind.getSetting, { calls: 2, read: 2, written: 0, refused: 0 });
  assert.equal(snap.written, 2);
  meter.refused("putDevice");
  assert.equal(meter.snapshot().refused, 1);
  now += 2 * 60_000;
  const next = meter.snapshot();
  assert.equal(next.day, "2026-11-23");
  assert.equal(next.read + next.written + next.refused, 0, "a new day starts from zero");
});
