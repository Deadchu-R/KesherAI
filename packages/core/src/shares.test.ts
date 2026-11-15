import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { cleanForShare, ShareStore, sharePage, snapshotOf } from "./shares.js";
import { shareRoutes } from "./routes/shares.js";

test("a share hides local paths and keys, and keeps only the user's words and the answers", () => {
  assert.equal(cleanForShare("see C:\\Users\\someone\\Desktop\\a.txt and /home/someone/x.py", "/nowhere"), "see ~\\Desktop\\a.txt and ~/x.py");
  assert.equal(cleanForShare("in /Users/me/proj", "/nowhere"), "in ~/proj");
  assert.equal(cleanForShare("key sk-abcdefghijklmnop, ghp_abcdefghijklmnop, kd_abcdefghijkl, password: hunter22", "/nowhere"), "key sk-…, ghp_…, kd_…, password: …");
  assert.equal(cleanForShare("http://u:p@host/x?token=abc123&a=1", "/nowhere"), "http://…@host/x?token=…&a=1");
  const msgs = snapshotOf([
    { type: "user", text: "Summarize this\n[Attached: C:\\Users\\someone\\Documents\\report.pdf]" },
    { type: "tool_call", text: "read_file" },
    { type: "assistant_delta", text: "Part" },
    { type: "approval_request", text: "run?" },
    { type: "assistant", text: "It says hello." },
    { type: "user", text: "   " },
  ]);
  assert.deepEqual(msgs, [{ role: "user", text: "Summarize this", files: ["report.pdf"] }, { role: "assistant", text: "It says hello." }]);
});

test("share, update with the same link, expiry, views, revoke; the page is escaped and runs nothing", async () => {
  const store = new ShareStore(join(await mkdtemp(join(tmpdir(), "kesher-share-")), "shares.json"));
  const t0 = Date.parse("2026-11-15T10:00:00Z");
  await assert.rejects(store.share("c1", "Empty", [], 7, t0), /nothing to share/);
  const a = await store.share("c1", "Plan <b>", [{ role: "user", text: "Hi <script>alert(1)</script>" }], 7, t0);
  assert.match(a.token, /^[\w-]{22}$/);
  assert.equal(a.expiresAt, "2026-11-22T10:00:00.000Z");
  const b = await store.share("c1", "Plan <b>", [{ role: "user", text: "Hi" }, { role: "assistant", text: "```js\nx < 1\n```\nDone" }], 0, t0 + 1000);
  assert.equal(b.token, a.token, "updating keeps the link");
  assert.equal(b.expiresAt, null);
  assert.equal((await store.open(a.token))?.views, 1);
  assert.equal(await store.open("x".repeat(22)), undefined);
  assert.equal(await store.open("../../etc"), undefined);
  const short = await store.share("c2", "Short", [{ role: "user", text: "x" }], 1, t0);
  assert.equal(await store.open(short.token, t0 + 2 * 86_400_000), undefined, "expired");
  const page = sharePage(await store.open(a.token));
  assert.doesNotMatch(page, /<script>|<b>/);
  assert.match(page, /Plan &lt;b&gt;/);
  assert.match(page, /<pre>x &lt; 1<\/pre>/);
  const heb = sharePage({ ...(await store.share("c3", "טיול", [{ role: "assistant", text: "**חשוב** ו-`code` <i>" }], 7, t0, "he")), views: 0 });
  assert.match(heb, /dir="rtl"/);
  assert.match(heb, /<strong>חשוב<\/strong> ו-<code>code<\/code> &lt;i&gt;/);
  assert.match(heb, />תשובה</);
  assert.equal((await store.list()).length, 3);
  assert.equal(await store.revoke(b.id), true);
  assert.equal(await store.open(a.token), undefined, "revoked at once");
  assert.match(sharePage(undefined), /no longer shared/);
});

test("share routes: the owner shares and lists; /s/<token> is plain HTML with a strict CSP and noindex", async () => {
  const store = new ShareStore(join(await mkdtemp(join(tmpdir(), "kesher-share-")), "shares.json"));
  const app = Fastify();
  await shareRoutes(app, store, async (id) => (id === "c1" ? { title: "Trip plan", events: [{ type: "user", text: "Where to?" }, { type: "assistant", text: "Haifa." }] } : undefined));
  try {
    assert.equal((await app.inject({ method: "POST", url: "/api/conversations/nope/share" })).statusCode, 404);
    const made = (await app.inject({ method: "POST", url: "/api/conversations/c1/share", payload: { days: 30 } })).json() as { share: { path: string; messages: number; id: string } };
    assert.equal(made.share.messages, 2);
    assert.match(made.share.path, /^\/s\/[\w-]{22}$/);
    const listed = (await app.inject({ method: "GET", url: "/api/shares" })).json() as { shares: Array<Record<string, unknown>> };
    assert.equal(listed.shares.length, 1);
    assert.equal("token" in listed.shares[0]!, false, "the list carries the path, not a separate token field");
    const page = await app.inject({ method: "GET", url: made.share.path });
    assert.equal(page.statusCode, 200);
    assert.match(String(page.headers["content-security-policy"]), /default-src 'none'/);
    assert.equal(page.headers["x-robots-tag"], "noindex, nofollow");
    assert.match(page.body, /Haifa\./);
    assert.doesNotMatch(page.body, /<script/);
    await app.inject({ method: "DELETE", url: `/api/shares/${made.share.id}` });
    assert.equal((await app.inject({ method: "GET", url: made.share.path })).statusCode, 404);
  } finally {
    await app.close();
  }
});

test("over the network, /s/<token> needs no key but the share list does", async () => {
  const { createKesherServer } = await import("./server.js");
  const server = await createKesherServer({ dataDir: await mkdtemp(join(tmpdir(), "kesher-share-net-")), autodetect: false, pluginRoots: [] });
  try {
    const away = { remoteAddress: "203.0.113.9" };
    assert.equal((await server.app.inject({ method: "GET", url: "/api/shares", ...away })).statusCode, 401);
    assert.equal((await server.app.inject({ method: "GET", url: "/s/AAAAAAAAAAAAAAAAAAAAAA", ...away })).statusCode, 404, "reaches the route (no such share), not refused for a key");
  } finally {
    await server.app.close();
  }
});

test("the phone app's crash report goes to the fault log (behind the key from outside)", async () => {
  const { createKesherServer } = await import("./server.js");
  const server = await createKesherServer({ dataDir: await mkdtemp(join(tmpdir(), "kesher-phone-crash-")), autodetect: false, pluginRoots: [] });
  try {
    assert.equal((await server.app.inject({ method: "POST", url: "/api/faults/phone", payload: { error: "x" }, remoteAddress: "203.0.113.9" })).statusCode, 401);
    assert.equal((await server.app.inject({ method: "POST", url: "/api/faults/phone", payload: {} })).statusCode, 400);
    assert.equal((await server.app.inject({ method: "POST", url: "/api/faults/phone", payload: { error: "y", at: 1e300 } })).statusCode, 200, "a bad time is ignored, not a server error");
    const ok = await server.app.inject({ method: "POST", url: "/api/faults/phone", payload: { error: "java.lang.IllegalStateException: boom", stack: "at dev.kesherai.notify.LiveService.onStartCommand", where: "thread main", device: "OPPO CPH2653, Android 16", at: 1794700000000 } });
    assert.equal(ok.statusCode, 200);
    await new Promise((r) => setTimeout(r, 200));
    const faults = (await server.app.inject({ method: "GET", url: "/api/faults" })).json() as Array<{ kind: string; where: string; message: string }>;
    const f = faults.find((x) => x.kind === "phone")!;
    assert.match(f.where, /CPH2653, Android 16 · thread main · 2026-11-14T23:46:40/);
    assert.match(f.message, /IllegalStateException: boom[\s\S]*LiveService/);
  } finally {
    await server.app.close();
  }
});
