import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { PLUGIN_FILES_KEY, allowedOrigin, clientAddress, isLocalRequest, registerRemoteAuth } from "./auth.js";

async function app() {
  const a = Fastify();
  registerRemoteAuth(a, () => "secret-token-123");
  a.get("/api/settings", async () => ({ ok: true }));
  a.post("/api/settings", async () => ({ ok: true }));
  a.get("/api/plugin-files/:t/x.js", async () => "js");
  a.get("/api/google/callback", async () => "signed in");
  await a.ready();
  return a;
}

test("other websites cannot use KesherAI's API, even from this computer", async () => {
  const a = await app();
  // The interface itself (same address): fine.
  assert.equal((await a.inject({ url: "/api/settings", headers: { host: "localhost:7420", origin: "http://localhost:7420", "sec-fetch-site": "same-origin" } })).statusCode, 200);
  // A page on another site, a simple form post with no preflight: refused.
  assert.equal((await a.inject({ method: "POST", url: "/api/settings", headers: { host: "localhost:7420", origin: "https://evil.example", "content-type": "text/plain" }, payload: "x" })).statusCode, 403);
  // A no-cors GET from another site (no Origin, but the browser says cross-site): refused.
  assert.equal((await a.inject({ url: "/api/settings", headers: { host: "localhost:7420", "sec-fetch-site": "cross-site" } })).statusCode, 403);
  // A sign-in's return from Google (a top-level navigation, always cross-site): allowed; its state is the check.
  assert.equal((await a.inject({ url: "/api/google/callback?code=c&state=s", headers: { host: "127.0.0.1:7420", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" } })).statusCode, 200);
  // Not a navigation (a script from another site fetching it), or another path: still refused.
  assert.equal((await a.inject({ url: "/api/google/callback?code=c&state=s", headers: { host: "127.0.0.1:7420", "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" } })).statusCode, 403);
  assert.equal((await a.inject({ url: "/api/settings", headers: { host: "localhost:7420", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" } })).statusCode, 403);
  // A sandboxed page (Origin: null): refused, except its own plugin files.
  assert.equal((await a.inject({ url: "/api/settings", headers: { host: "localhost:7420", origin: "null" } })).statusCode, 403);
  assert.equal((await a.inject({ url: "/api/plugin-files/secret-token-123/x.js", headers: { host: "localhost:7420", origin: "null" } })).statusCode, 200);
  // Another local web app (a dev server on another port) is not KesherAI either.
  assert.equal((await a.inject({ url: "/api/settings", headers: { host: "localhost:7420", origin: "http://localhost:3000" } })).statusCode, 403);
  // The Android app (http://localhost, no port) may ask; it still needs the token from outside.
  assert.equal((await a.inject({ url: "/api/settings", headers: { host: "localhost:7420", origin: "http://localhost" } })).statusCode, 200);
  await a.close();
});

test("the plugin files key opens a plugin's files from another device, and nothing else", async () => {
  const a = await app();
  const far = { remoteAddress: "100.64.1.2", headers: { host: "100.64.1.1:7420", origin: "null" } };
  assert.equal((await a.inject({ url: `/api/plugin-files/${PLUGIN_FILES_KEY}/x.js`, ...far })).statusCode, 200);
  assert.notEqual((await a.inject({ url: `/api/settings?token=${PLUGIN_FILES_KEY}`, remoteAddress: "100.64.1.2", headers: { host: "100.64.1.1:7420" } })).statusCode, 200);
  assert.notEqual((await a.inject({ url: "/api/plugin-files/wrong-key-123/x.js", ...far })).statusCode, 200);
  await a.close();
});

test("DNS rebinding: a request to this computer under another site's name is not local", async () => {
  const a = await app();
  assert.equal((await a.inject({ url: "/api/settings", headers: { host: "evil.example:7420" } })).statusCode, 401);
  assert.equal((await a.inject({ url: "/api/settings", headers: { host: "evil.example:7420", authorization: "Bearer secret-token-123" } })).statusCode, 200);
  assert.ok(isLocalRequest({ ip: "127.0.0.1", headers: { host: "127.0.0.1:7420" } }));
  assert.ok(!isLocalRequest({ ip: "127.0.0.1", headers: { host: "attacker.example" } }));
  await a.close();
});

test("encoded paths are checked as the router reads them", async () => {
  const a = await app();
  const r = await a.inject({ url: "/%61pi/settings", remoteAddress: "192.168.1.20", headers: { host: "192.168.1.5:7420" } });
  assert.notEqual(r.statusCode, 200);
  await a.close();
});

test("allowedOrigin", () => {
  assert.ok(allowedOrigin("chrome-extension://abcdef", "localhost:7420", "/api/browser/connect"));
  assert.ok(!allowedOrigin("chrome-extension://abcdef", "localhost:7420", "/api/conversations"));
  assert.ok(!allowedOrigin("chrome-extension://abcdef", "localhost:7420", "/api/browser/pane/shot"), "not the pane's pictures");
  assert.ok(!allowedOrigin("moz-extension://abc", "localhost:7420", "/api/browser/sites"));
});

test("the Unreal Editor's socket may send a bare loopback Origin; nothing else may", async () => {

  assert.equal(allowedOrigin("127.0.0.1", "127.0.0.1:7420", "/api/unreal/ws"), true);
  assert.equal(allowedOrigin("http://127.0.0.1", "127.0.0.1:7420", "/api/unreal/ws"), true);
  assert.equal(allowedOrigin("127.0.0.1", "127.0.0.1:7420", "/api/conversations"), false);
  assert.equal(allowedOrigin("https://evil.example", "127.0.0.1:7420", "/api/unreal/ws"), false);
});

test("clientAddress: a Funnel visitor is counted by their own address, not as this computer", () => {
  assert.equal(clientAddress({ ip: "127.0.0.1", headers: { "tailscale-funnel-request": "?1", "x-forwarded-for": "203.0.113.9, 100.64.0.1" } }), "203.0.113.9");
  assert.equal(clientAddress({ ip: "127.0.0.1", headers: { "cf-connecting-ip": "198.51.100.4" } }), "198.51.100.4");
  // From the network, the header is not believed.
  assert.equal(clientAddress({ ip: "192.168.1.5", headers: { "tailscale-funnel-request": "?1", "x-forwarded-for": "203.0.113.9" } }), "192.168.1.5");
  assert.equal(clientAddress({ ip: "127.0.0.1", headers: {} }), "127.0.0.1");
});

test("a guest key opens only /api/guest/*; an invite link needs no key; a guest cannot get past with an encoded path", async () => {
  const a = Fastify();
  const guest = { id: "g1", name: "Dani (guest)", scope: "project:p1:edit" };
  registerRemoteAuth(a, () => "secret-token-123", {}, undefined, {
    find: (k) => (k === "kd_guest" ? guest : undefined),
    seen: () => undefined,
    devicesOnly: () => false,
    idleDays: () => 0,
  });
  for (const p of ["/api/settings", "/api/conversations", "/api/guest/me", "/api/join/:t"]) {
    a.get(p, async () => ({ ok: true }));
    a.post(p, async () => ({ ok: true }));
  }
  await a.ready();
  const outside = { remoteAddress: "203.0.113.9", headers: { host: "kesher.example", authorization: "Bearer kd_guest" } };
  assert.equal((await a.inject({ url: "/api/guest/me", ...outside })).statusCode, 200);
  assert.equal((await a.inject({ url: "/api/settings", ...outside })).statusCode, 403);
  assert.equal((await a.inject({ url: "/api/conversations", ...outside })).statusCode, 403);
  assert.equal((await a.inject({ url: "/api/guest/../settings", ...outside })).statusCode, 403);
  assert.equal((await a.inject({ url: "/api/%67uest/../settings", ...outside })).statusCode, 403);
  // The invite link: its token is the key (the route checks it); a short or odd token is not this route.
  const token = "A".repeat(43);
  assert.equal((await a.inject({ url: `/api/join/${token}`, remoteAddress: "203.0.113.9", headers: { host: "kesher.example" } })).statusCode, 200);
  assert.equal((await a.inject({ url: "/api/join/short", remoteAddress: "203.0.113.9", headers: { host: "kesher.example" } })).statusCode, 401);
  await a.close();
});
