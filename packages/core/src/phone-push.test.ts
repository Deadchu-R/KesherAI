import { test } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { checkEndpoint, phoneMessage, PhonePush, privateAddress, webPushEncrypt } from "./phone-push.js";
import { Notifier } from "./notify.js";
import type { DeviceKey } from "./device-keys.js";

/** The phone's side of RFC 8291, to check what the computer sends. */
function decrypt(body: Buffer, ua: ReturnType<typeof createECDH>, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const shared = ua.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync("sha256", shared, auth, Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const data = body.subarray(21 + idlen);
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, "last record delimiter");
  return plain.subarray(0, -1).toString();
}

function phoneKeys() {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = randomBytes(16);
  return { ua, auth, p256dh: ua.getPublicKey().toString("base64url"), authB64: auth.toString("base64url") };
}

test("web push encryption: the phone can read it, the header follows RFC 8291", () => {
  const k = phoneKeys();
  const body = webPushEncrypt(Buffer.from('{"t":"show"}'), k.p256dh, k.authB64);
  assert.equal(body.readUInt32BE(16), 4096);
  assert.equal(body.readUInt8(20), 65);
  assert.equal(decrypt(body, k.ua, k.auth), '{"t":"show"}');
  assert.throws(() => webPushEncrypt(Buffer.from("x"), "AAAA", k.authB64));
});

test("private addresses are refused as push servers", () => {
  for (const ip of ["127.0.0.1", "10.0.0.5", "192.168.1.2", "172.20.0.1", "169.254.1.1", "100.100.1.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:192.168.0.1"]) assert.equal(privateAddress(ip), true, ip);
  for (const ip of ["159.203.148.75", "8.8.8.8", "2606:4700::1111"]) assert.equal(privateAddress(ip), false, ip);
});

test("a push address must be https and resolve to public addresses only", async () => {
  const pub = async () => ["159.203.148.75"];
  assert.equal(await checkEndpoint("https://ntfy.sh/upAbc?up=1", pub), undefined);
  assert.match((await checkEndpoint("http://ntfy.sh/up", pub)) ?? "", /https/);
  assert.match((await checkEndpoint("https://user:pw@ntfy.sh/up", pub)) ?? "", /https/);
  assert.match((await checkEndpoint("https://router.home/up", async () => ["192.168.1.1"])) ?? "", /private/);
  assert.match((await checkEndpoint("https://mixed.example/up", async () => ["8.8.8.8", "127.0.0.1"])) ?? "", /private/);
  assert.match((await checkEndpoint("https://127.0.0.1/up", pub)) ?? "", /private/);
  assert.match((await checkEndpoint("not a url", pub)) ?? "", /web address/);
});

test("one phone notification per chat, in the right channel", () => {
  assert.deepEqual(phoneMessage({ title: "Waiting for you: X", body: "b", path: "#/c/abc", ref: "abc", tags: ["raised_hand"], priority: 4 }).ch, "waiting");
  const done = phoneMessage({ title: "Done: X", body: "b", path: "#/c/abc", tags: ["white_check_mark"] });
  assert.equal(done.id, "abc");
  assert.equal(done.ch, "done");
  assert.equal(phoneMessage({ title: "Downloaded: m", body: "", path: "#/models", tags: ["inbox_tray"] }).ch, "downloads");
  const big = phoneMessage({ title: "t", body: "x".repeat(10_000) });
  assert.ok(Buffer.byteLength(JSON.stringify(big)) <= 3900);
});

test("live phones get it over the stream; others through their push address; a gone address is dropped", async () => {
  const k = phoneKeys();
  const devices: DeviceKey[] = [
    { id: "a", name: "Live phone", hash: "h", createdAt: "" },
    { id: "b", name: "Away phone", hash: "h", createdAt: "", push: { endpoint: "https://ntfy.sh/upX", p256dh: k.p256dh, auth: k.authB64 } },
  ];
  const posts: Array<{ url: string; body: Buffer; init: RequestInit }> = [];
  let status = 201;
  let saved = 0;
  const push = new PhonePush(() => devices, async () => void saved++, (async (url: string, init: RequestInit) => {
    posts.push({ url, body: Buffer.from(init.body as Uint8Array), init });
    return new Response(null, { status });
  }) as unknown as typeof fetch, 50);
  const written: string[] = [];
  // The live phone confirms what it gets, as the app does.
  const res = { writeHead: () => undefined, write: (s: string) => { written.push(s); const seq = /"seq":(\d+)/.exec(s)?.[1]; if (seq) setTimeout(() => push.ack(Number(seq)), 5); }, on: () => undefined, end: () => undefined };
  push.attach("a", res as never);
  assert.equal(push.hasReceivers(), true);
  assert.equal(await push.deliver({ t: "show", id: "c1", ch: "waiting", title: "T", body: "B" }), true);
  assert.ok(written.some((w) => w.startsWith("data: ") && w.includes('"id":"c1"')));
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.init.redirect, "manual");
  assert.equal((posts[0]!.init.headers as Record<string, string>).urgency, "high");
  assert.equal(JSON.parse(decrypt(posts[0]!.body, k.ua, k.auth)).id, "c1");
  // A sleeping phone that does not confirm: UnifiedPush takes over for it.
  const sleeping = new PhonePush(() => [{ ...devices[1]!, id: "s" }], async () => undefined, (async () => (posts.push({ url: "s", body: Buffer.alloc(0), init: {} }), new Response(null, { status: 201 }))) as unknown as typeof fetch, 30);
  sleeping.attach("s", { writeHead: () => undefined, write: () => undefined, on: () => undefined, end: () => undefined } as never);
  assert.equal(await sleeping.deliver({ t: "show", id: "c2" }), true);
  assert.equal(posts.at(-1)!.url, "s");
  sleeping.close();
  status = 410;
  await push.deliver({ t: "clear", id: "c1" });
  assert.equal(devices[1]!.push, undefined);
  assert.equal(saved, 1);
  push.close();
});

test("the notifier sends to the phone app instead of ntfy, and clears an answered chat there", async () => {
  const got: unknown[] = [];
  const ntfy: string[] = [];
  const settings = { ntfy: { enabled: true, server: "https://ntfy.sh", topic: "kesher-t" }, desktop: false, minSeconds: 0, includeText: false, waiting: true, approveButtons: true, waitingSeconds: 0 };
  const n = new Notifier(() => settings, {
    app: { deliver: async (m) => (got.push(m), true), hasReceivers: () => true },
    fetch: (async (url: string) => (ntfy.push(url), new Response(null, { status: 200 }))) as unknown as typeof fetch,
    decide: async () => true,
  });
  const channels = await n.send({ title: "Done: X", body: "b", path: "#/c/x" });
  assert.deepEqual(channels, ["app"]);
  assert.equal(ntfy.length, 0);
  // Waiting for an approval: buttons even without the internet link (the app posts to the computer itself).
  n.onConversationEvent("x", () => "X", { type: "approval_request", requestId: "r1", name: "run_command", risk: "exec", input: {} } as never, () => undefined);
  await new Promise((r) => setTimeout(r, 20));
  const waiting = got.find((m) => (m as { ch?: string }).ch === "waiting") as { actions?: unknown[] } | undefined;
  assert.equal(waiting?.actions?.length, 2);
  n.onConversationEvent("x", () => "X", { type: "approval_result", requestId: "r1", decision: "allow" } as never, () => undefined);
  assert.deepEqual(got.at(-1), { t: "clear", id: "x" });
  n.close();
});
