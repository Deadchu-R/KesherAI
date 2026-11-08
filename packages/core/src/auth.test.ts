import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { allowedOrigin, isLocalRequest, registerRemoteAuth } from "./auth.js";

async function app() {
  const a = Fastify();
  registerRemoteAuth(a, () => "secret-token-123");
  a.get("/api/settings", async () => ({ ok: true }));
  a.post("/api/settings", async () => ({ ok: true }));
  a.get("/api/plugin-files/:t/x.js", async () => "js");
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
  // A sandboxed page (Origin: null): refused, except its own plugin files.
  assert.equal((await a.inject({ url: "/api/settings", headers: { host: "localhost:7420", origin: "null" } })).statusCode, 403);
  assert.equal((await a.inject({ url: "/api/plugin-files/secret-token-123/x.js", headers: { host: "localhost:7420", origin: "null" } })).statusCode, 200);
  // Another local web app (a dev server on another port) is not KesherAI either.
  assert.equal((await a.inject({ url: "/api/settings", headers: { host: "localhost:7420", origin: "http://localhost:3000" } })).statusCode, 403);
  // The Android app (http://localhost, no port) may ask; it still needs the token from outside.
  assert.equal((await a.inject({ url: "/api/settings", headers: { host: "localhost:7420", origin: "http://localhost" } })).statusCode, 200);
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
});
