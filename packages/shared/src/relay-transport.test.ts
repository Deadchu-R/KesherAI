import { test } from "node:test";
import assert from "node:assert/strict";
import { generateHubKeys, sealMessage } from "./hub-crypto.js";
import type { SealedEnvelope } from "./hub-protocol.js";
import { AblyTransport, cleanRelayKeys, configuredRelays, makeTransports, pairChannel, SupabaseTransport, type RelayDeps, type RelaySocket } from "./relay-transport.js";

/** A fake socket: records what was sent; the test plays the server. */
class FakeSocket implements RelaySocket {
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({});
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  frame(f: unknown): void {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
}

/** Fake network and clock: timers run only when the test advances time. */
function fakes(status = 201) {
  const sockets: FakeSocket[] = [];
  const posts: Array<{ url: string; init: RequestInit }> = [];
  let now = 1_000_000;
  let timers: Array<{ at: number; cb: () => void; id: number }> = [];
  let nextId = 1;
  const deps: RelayDeps = {
    openSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    fetch: (async (url: string, init: RequestInit) => {
      posts.push({ url, init });
      return new Response(null, { status });
    }) as unknown as typeof fetch,
    now: () => now,
    setTimer: (cb, ms) => {
      const id = nextId++;
      timers.push({ at: now + ms, cb, id });
      return id;
    },
    clearTimer: (id) => {
      timers = timers.filter((t) => t.id !== id);
    },
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      now = due.at;
      due.cb();
    }
    now = until;
  };
  return { deps, sockets, posts, advance };
}

async function envelope(): Promise<SealedEnvelope> {
  const a = await generateHubKeys(false);
  const b = await generateHubKeys(false);
  return sealMessage({ from: "pc-1", to: "phone-1", kind: "progress" }, { type: "progress", taskId: "t1", line: "hi" }, a.privateKey, b.publicKey);
}

const ABLY_KEY = "appId1.keyId1:abcdefghijklmnop";
const SB = { url: "https://abcdefghijklmnop.supabase.co", anonKey: "sb_publishable_abcdefghijklmnopqrstuvwxyz" };

test("cleanRelayKeys keeps only well-formed keys, and Supabase only on supabase.co", () => {
  assert.deepEqual(cleanRelayKeys({ ably: { key: ` ${ABLY_KEY} ` }, supabase: { url: "https://ABCDEFGHIJKLMNOP.supabase.co/", anonKey: SB.anonKey } }), { ably: { key: ABLY_KEY }, supabase: SB });
  assert.deepEqual(cleanRelayKeys({ ably: { key: "no-colon" }, supabase: { url: "https://evil.example.com", anonKey: SB.anonKey } }), {});
  assert.deepEqual(cleanRelayKeys({ supabase: { url: "https://abcdefghijklmnop.supabase.co.evil.com", anonKey: SB.anonKey } }), {});
  assert.deepEqual(cleanRelayKeys({ supabase: { url: SB.url } }), {});
  assert.deepEqual(cleanRelayKeys(null), {});
  assert.deepEqual(configuredRelays({ supabase: SB, ably: { key: ABLY_KEY } }), ["ably", "supabase"]);
  assert.deepEqual(makeTransports({ supabase: SB }, fakes().deps).map((t) => t.kind), ["supabase"]);
});

test("pairChannel is the same on both sides, differs per pair and shows no id", async () => {
  const pc = await generateHubKeys(false);
  const phone = await generateHubKeys(false);
  const other = await generateHubKeys(false);
  const a = await pairChannel(pc.privateKey, phone.publicKey);
  assert.equal(a, await pairChannel(phone.privateKey, pc.publicKey));
  assert.notEqual(a, await pairChannel(pc.privateKey, other.publicKey));
  assert.match(a, /^kesher-[0-9a-f]{32}$/);
});

test("Ably: attaches after CONNECTED, delivers envelopes, publishes with REST and Basic auth", async () => {
  const f = fakes();
  const t = new AblyTransport(ABLY_KEY, f.deps);
  const got: Array<[SealedEnvelope, string]> = [];
  t.onEnvelope((e, c) => got.push([e, c]));
  t.connect();
  assert.equal(f.sockets.length, 0, "no channels: no socket");
  t.setChannels(["kesher-aa"]);
  const s = f.sockets[0]!;
  assert.match(s.url, /^wss:\/\/realtime\.ably\.io\/\?key=appId1\.keyId1%3Aabcdefghijklmnop&clientId=kesher&format=json&heartbeats=true/, "claims a client ID (namespaces that need identified clients, 40161)");
  s.open();
  assert.deepEqual(s.sent, []);
  s.frame({ action: 4, connectionDetails: { maxIdleInterval: 15000 } });
  assert.deepEqual(s.sent, [{ action: 10, channel: "kesher-aa" }]);
  assert.equal(t.health().healthy, true);
  const env = await envelope();
  s.frame({ action: 15, channel: "kesher-aa", messages: [{ name: "env", data: JSON.stringify(env) }, { name: "env", data: "{bad" }, { name: "other", data: "{}" }] });
  s.frame({ action: 15, channel: "kesher-zz", messages: [{ name: "env", data: JSON.stringify(env) }] });
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], [env, "kesher-aa"]);
  assert.equal(await t.publish("kesher-aa", env), true);
  const p = f.posts[0]!;
  assert.equal(p.url, "https://rest.ably.io/channels/kesher-aa/messages");
  assert.equal((p.init.headers as Record<string, string>).authorization, `Basic ${btoa(ABLY_KEY)}`);
  assert.equal((p.init.headers as Record<string, string>)["x-ably-clientid"], btoa("kesher"), "REST names the client too (basic auth)");
  assert.deepEqual(JSON.parse(String(p.init.body)), { name: "env", clientId: "kesher", data: JSON.stringify(env) });
  t.setChannels(["kesher-bb"]);
  assert.deepEqual(s.sent.slice(1), [{ action: 12, channel: "kesher-aa" }, { action: 10, channel: "kesher-bb" }]);
});

test("Ably: silence and errors reconnect with backoff; a refused key waits long; the key is never in the error", () => {
  const f = fakes();
  const t = new AblyTransport(ABLY_KEY, f.deps);
  t.setChannels(["kesher-aa"]);
  t.connect();
  f.sockets[0]!.open();
  f.sockets[0]!.frame({ action: 4, connectionDetails: { maxIdleInterval: 15000 } });
  f.advance(30_000);
  assert.equal(t.health().state, "down");
  assert.equal(t.health().error, "no heartbeat");
  f.advance(1000);
  assert.equal(f.sockets.length, 2, "reconnected after a short backoff");
  f.sockets[1]!.open();
  f.sockets[1]!.frame({ action: 9, error: { code: 40101, statusCode: 401 } });
  assert.equal(t.health().healthy, false);
  f.advance(10 * 60_000);
  assert.equal(f.sockets.length, 2, "a refused key does not retry every few seconds");
  f.advance(25 * 60_000);
  assert.equal(f.sockets.length, 3);
  assert.ok(!JSON.stringify(t.health()).includes("abcdefghijklmnop"));
  t.close();
  assert.equal(t.health().state, "off");
});

test("a failed publish marks the relay unhealthy until one goes through", async () => {
  const f = fakes(429);
  const t = new AblyTransport(ABLY_KEY, f.deps);
  t.setChannels(["kesher-aa"]);
  t.connect();
  f.sockets[0]!.open();
  f.sockets[0]!.frame({ action: 4 });
  assert.equal(await t.publish("kesher-aa", await envelope()), false);
  assert.deepEqual([t.health().healthy, t.health().error], [false, "publish 429"]);
});

test("Supabase: joins public broadcast channels, heartbeats, delivers, publishes with REST", async () => {
  const f = fakes(202);
  const t = new SupabaseTransport(SB, f.deps);
  const got: SealedEnvelope[] = [];
  t.onEnvelope((e) => got.push(e));
  t.setChannels(["kesher-aa"]);
  t.connect();
  const s = f.sockets[0]!;
  assert.equal(s.url, `wss://abcdefghijklmnop.supabase.co/realtime/v1/websocket?apikey=${SB.anonKey}&vsn=1.0.0`);
  s.open();
  assert.equal(s.sent[0]!.event, "phx_join");
  assert.equal(s.sent[0]!.topic, "realtime:kesher-aa");
  assert.deepEqual((s.sent[0]!.payload as { config: { private: boolean } }).config.private, false);
  assert.deepEqual(s.sent[1], { topic: "phoenix", event: "heartbeat", payload: {}, ref: "2" });
  s.frame({ topic: "phoenix", event: "phx_reply", payload: { status: "ok", response: {} }, ref: "2" });
  const env = await envelope();
  s.frame({ topic: "realtime:kesher-aa", event: "broadcast", payload: { type: "broadcast", event: "env", payload: { env } }, ref: null });
  s.frame({ topic: "realtime:kesher-aa", event: "broadcast", payload: { type: "broadcast", event: "env", payload: { env: { ...env, v: 9 } } }, ref: null });
  assert.deepEqual(got, [env]);
  assert.equal(await t.publish("kesher-aa", env), true);
  const p = f.posts[0]!;
  assert.equal(p.url, `${SB.url}/realtime/v1/api/broadcast`);
  const h = p.init.headers as Record<string, string>;
  assert.equal(h.apikey, SB.anonKey);
  assert.equal(h.authorization, undefined, "a publishable key is not a bearer token");
  assert.deepEqual(JSON.parse(String(p.init.body)), { messages: [{ topic: "kesher-aa", event: "env", payload: { env }, private: false }] });
  // The next heartbeat goes; a second one unanswered ends the link.
  f.advance(25_000);
  assert.equal(s.sent.at(-1)!.event, "heartbeat");
  f.advance(25_000);
  assert.equal(t.health().state, "down");
  assert.equal(t.health().error, "no heartbeat reply");
});

test("Supabase: a refused join (public channels off) waits long instead of looping", () => {
  const f = fakes();
  const t = new SupabaseTransport(SB, f.deps);
  t.setChannels(["kesher-aa"]);
  t.connect();
  f.sockets[0]!.open();
  f.sockets[0]!.frame({ topic: "realtime:kesher-aa", event: "phx_reply", payload: { status: "error", response: { reason: "Unauthorized" } }, ref: "1" });
  assert.deepEqual([t.health().state, t.health().error], ["down", "join refused"]);
  f.advance(20 * 60_000);
  assert.equal(f.sockets.length, 1);
});
