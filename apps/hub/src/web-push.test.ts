import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { webPushEncrypt } from "../../../packages/core/src/phone-push.js";
import { fromB64url, generateHubKeys, sealMessage, toB64url, type HubKeyPair, type SealedBody } from "../../../packages/shared/src/hub.js";
import { Hub, isHubError, type DeviceSockets } from "./hub.js";
import { MemoryStore } from "./store.js";
import { cleanPushSub, encryptPush, PUSH, pushText, vapidAuth, vapidFromEnv, type VapidKeys } from "./web-push.js";

/** A browser's push keys (as `PushSubscription.toJSON().keys`), with its private key for decrypting in the test. */
function browser() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { ecdh, p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
}

/** Decrypts an aes128gcm body the way the browser does (RFC 8291). */
function decrypt(body: Uint8Array, b: ReturnType<typeof browser>): string {
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16);
  assert.equal(buf.readUInt32BE(16), 4096, "record size");
  assert.equal(buf[20], 65, "key id is the sender's uncompressed key");
  const asPublic = buf.subarray(21, 86);
  const shared = b.ecdh.computeSecret(asPublic);
  const uaPublic = b.ecdh.getPublicKey();
  const ikm = Buffer.from(hkdfSync("sha256", shared, Buffer.from(b.auth, "base64url"), Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const ct = buf.subarray(86);
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain.at(-1), 2, "last-record delimiter");
  return plain.subarray(0, -1).toString();
}

/** A fresh VAPID key pair in the Worker's variable format. */
async function vapid(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const v = vapidFromEnv(toB64url(await crypto.subtle.exportKey("raw", pair.publicKey)), jwk.d, "https://hub.example.com");
  assert.ok(v);
  return v;
}

const FCM = "https://fcm.googleapis.com/fcm/send/abc123";

test("subscriptions: only https addresses of known push services, with well-formed keys", () => {
  const b = browser();
  const ok = cleanPushSub({ endpoint: FCM, keys: { p256dh: b.p256dh, auth: b.auth }, lang: "en" });
  assert.deepEqual(ok, { endpoint: FCM, p256dh: b.p256dh, auth: b.auth, lang: "en" });
  assert.equal(cleanPushSub({ endpoint: FCM, keys: { p256dh: b.p256dh, auth: b.auth } })?.lang, "he", "Hebrew by default");
  assert.ok(cleanPushSub({ endpoint: "https://web.push.apple.com/x", keys: { p256dh: b.p256dh, auth: b.auth } }));
  for (const endpoint of ["http://fcm.googleapis.com/x", "https://fcm.googleapis.com.evil.example/x", "https://evil.example/fcm.googleapis.com", "https://127.0.0.1/x", "https://fcm.googleapis.com:8443/x", "https://u:p@fcm.googleapis.com/x", "not a url"]) {
    assert.equal(cleanPushSub({ endpoint, keys: { p256dh: b.p256dh, auth: b.auth } }), undefined, endpoint);
  }
  assert.equal(cleanPushSub({ endpoint: FCM, keys: { p256dh: b.p256dh.slice(4), auth: b.auth } }), undefined, "short key");
  assert.equal(cleanPushSub({ endpoint: FCM, keys: { p256dh: b.p256dh, auth: "AAAA" } }), undefined, "short auth");
  assert.equal(cleanPushSub(null), undefined);
});

test("VAPID: needs all three values; the ES256 token verifies with the public key and names the push service's origin", async () => {
  const v = await vapid();
  assert.equal(vapidFromEnv(v.publicKey, v.privateKey, undefined), undefined);
  assert.equal(vapidFromEnv(v.publicKey, v.privateKey, "hub.example.com"), undefined, "the subject is https: or mailto:");
  assert.equal(vapidFromEnv(v.publicKey, "short", v.subject), undefined);
  const header = await vapidAuth(`${FCM}?x=1`, v, 1_000_000_000_000);
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
  assert.ok(m);
  assert.equal(m[4], v.publicKey);
  assert.deepEqual(JSON.parse(Buffer.from(m[1]!, "base64url").toString()), { typ: "JWT", alg: "ES256" });
  assert.deepEqual(JSON.parse(Buffer.from(m[2]!, "base64url").toString()), { aud: "https://fcm.googleapis.com", exp: 1_000_000_000 + 12 * 3600, sub: "https://hub.example.com" });
  const pub = await crypto.subtle.importKey("raw", fromB64url(v.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.equal(fromB64url(m[3]!).length, 64, "r‖s");
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, fromB64url(m[3]!), new TextEncoder().encode(`${m[1]}.${m[2]}`)));
});

test("tools/hub-vapid.mjs prints a pair the hub takes and signs with", async () => {
  const out = execFileSync(process.execPath, [new URL("../../../tools/hub-vapid.mjs", import.meta.url).pathname]).toString();
  const v = vapidFromEnv(/VAPID_PUBLIC_KEY=(\S+)/.exec(out)?.[1], /VAPID_PRIVATE_KEY=(\S+)/.exec(out)?.[1], "mailto:owner@example.com");
  assert.ok(v);
  assert.match(await vapidAuth(FCM, v, Date.now()), /^vapid t=/);
});

test("payload: aes128gcm equals the PC's Node encryption byte for byte, and the browser can open it", async () => {
  const b = browser();
  const sender = createECDH("prime256v1");
  sender.generateKeys();
  const pub = sender.getPublicKey();
  const jwk = { kty: "EC", crv: "P-256", d: sender.getPrivateKey().toString("base64url"), x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") };
  const keys = { privateKey: await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]), publicKey: await crypto.subtle.importKey("jwk", { ...jwk, d: undefined }, { name: "ECDH", namedCurve: "P-256" }, true, []) };
  const salt = new Uint8Array(randomBytes(16));
  const plain = Buffer.from('{"n":2}');
  const mine = await encryptPush(plain, b.p256dh, b.auth, { keys, salt });
  assert.deepEqual(Buffer.from(mine), webPushEncrypt(plain, b.p256dh, b.auth, { privateKey: sender.getPrivateKey(), salt: Buffer.from(salt) }));
  // A fresh key and salt each time; still opens.
  const a1 = await encryptPush(plain, b.p256dh, b.auth);
  const a2 = await encryptPush(plain, b.p256dh, b.auth);
  assert.notDeepEqual(a1.subarray(0, 16), a2.subarray(0, 16));
  assert.equal(decrypt(a1, b), '{"n":2}');
  await assert.rejects(encryptPush(plain, b.p256dh.slice(2), b.auth));
});

test("words: content-free, Hebrew and English", () => {
  assert.deepEqual(pushText(2, "en"), { title: "KesherAI", body: "2 waiting for you" });
  assert.equal(pushText(2, "he").body, "2 מחכים לך");
  assert.equal(pushText(1, "he").body, "1 מחכה לך");
});

// ---- the hub: storage per device, when it pushes, the rate limit ----

class Sockets implements DeviceSockets {
  on = new Set<string>();
  send = (id: string) => this.on.has(id);
  isOnline = (id: string) => this.on.has(id);
  close = (id: string) => void this.on.delete(id);
  closeAll = () => this.on.clear();
}

async function setup(withVapid = true) {
  let now = 1_000_000;
  const store = new MemoryStore();
  const sockets = new Sockets();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let status = 201;
  const hub = new Hub({
    store,
    sockets,
    config: { allowedEmail: "owner@example.com", ...(withVapid ? { vapid: await vapid() } : {}) },
    verifyIdToken: async () => {
      throw new Error("unused");
    },
    fireClaude: async () => ({ ok: true as const }),
    fetchPush: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status });
    }) as typeof fetch,
    now: () => now,
  });
  const pair = async (kind: "pc" | "phone"): Promise<{ id: string; token: string; keys: HubKeyPair }> => {
    const keys = await generateHubKeys(true);
    const start = await hub.pairStart("ip", { publicKey: keys.publicKey, kind, name: kind });
    assert.ok(!isHubError(start));
    assert.ok(!isHubError(await hub.pairApprove(start.code, kind)));
    const done = await hub.pairPoll("ip", start.pollSecret);
    assert.ok(!isHubError(done) && done.status === "paired");
    return { id: done.deviceId, token: done.token, keys };
  };
  return { hub, store, sockets, calls, pair, tick: (ms: number) => (now += ms), setStatus: (s: number) => (status = s) };
}

const snap: SealedBody = { type: "approvals", at: 1, items: [] };

test("hub push: kept per phone, pushed when the count grows on a closed page, at most once per 30 s, dropped on 410 and unpair", async () => {
  const { hub, store, sockets, calls, pair, tick, setStatus } = await setup();
  const pc = await pair("pc");
  const phone = await pair("phone");
  sockets.on.add(pc.id);
  const b = browser();
  const sub = { endpoint: FCM, keys: { p256dh: b.p256dh, auth: b.auth }, lang: "en" };
  assert.ok(isHubError(await hub.pushSubscribe("kh_wrong", sub)), "a device token is needed");
  assert.ok(isHubError(await hub.pushSubscribe(pc.token, sub)), "a PC gets no notifications");
  assert.ok(isHubError(await hub.pushSubscribe(phone.token, { ...sub, endpoint: "https://evil.example/x" })));
  assert.deepEqual(await hub.pushSubscribe(phone.token, sub), { ok: true });
  assert.ok(store.getSetting(`push:${phone.id}`));

  const send = async (waiting: number) => {
    const env = await sealMessage({ from: pc.id, to: phone.id, kind: "approvals" }, snap, pc.keys.privateKey, phone.keys.publicKey);
    await hub.onFrame(pc.id, JSON.stringify({ t: "send", env: { ...env, waiting } }));
  };
  await send(2);
  assert.equal(calls.length, 1, "page closed, count grew: one push");
  const h = calls[0]!.init.headers as Record<string, string>;
  assert.equal(calls[0]!.url, FCM);
  assert.equal(h["content-encoding"], "aes128gcm");
  assert.equal(h.topic, PUSH.topic);
  assert.equal(h.urgency, "high");
  assert.match(h.authorization!, /^vapid t=.+, k=/);
  assert.deepEqual(JSON.parse(decrypt(calls[0]!.init.body as Uint8Array, b)), { title: "KesherAI", body: "2 waiting for you", n: 2, tag: PUSH.tag, url: PUSH.url });

  await send(3);
  assert.equal(calls.length, 1, "within 30 s: collapsed into the shown notification");
  tick(PUSH.gapMs);
  await send(2);
  assert.equal(calls.length, 1, "the count did not grow past what was told");
  await send(3);
  assert.equal(calls.length, 2);

  // With the page open, nothing is pushed; the count it saw is noted (0), so the next new one pushes again.
  sockets.on.add(phone.id);
  await send(0);
  sockets.on.delete(phone.id);
  tick(PUSH.gapMs);
  await send(1);
  assert.equal(calls.length, 3);

  // An approvals message without a count (an older PC) pushes nothing.
  tick(PUSH.gapMs);
  const env = await sealMessage({ from: pc.id, to: phone.id, kind: "approvals" }, snap, pc.keys.privateKey, phone.keys.publicKey);
  await hub.onFrame(pc.id, JSON.stringify({ t: "send", env }));
  assert.equal(calls.length, 3);

  // The push service says the subscription is gone: it is forgotten.
  setStatus(410);
  await send(5);
  assert.equal(calls.length, 4);
  assert.equal(store.getSetting(`push:${phone.id}`), undefined);

  // Unsubscribe and unpair both forget it.
  assert.deepEqual(await hub.pushSubscribe(phone.token, sub), { ok: true });
  assert.deepEqual(await hub.pushUnsubscribe(phone.token), { ok: true });
  assert.equal(store.getSetting(`push:${phone.id}`), undefined);
  assert.deepEqual(await hub.pushSubscribe(phone.token, sub), { ok: true });
  hub.revoke(phone.id);
  assert.equal(store.getSetting(`push:${phone.id}`), undefined);
  assert.ok(!store.auditList(50).some((a) => JSON.stringify(a).includes("fcm")), "no address in the audit");
});

test("hub push: off when the hub has no VAPID keys", async () => {
  const { hub, pair } = await setup(false);
  const phone = await pair("phone");
  const b = browser();
  const r = await hub.pushSubscribe(phone.token, { endpoint: FCM, keys: { p256dh: b.p256dh, auth: b.auth } });
  assert.ok(isHubError(r) && r.status === 503);
});
