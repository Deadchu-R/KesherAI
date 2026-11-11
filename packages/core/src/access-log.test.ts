import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { AccessLog } from "./access-log.js";
import { registerRemoteAuth } from "./auth.js";

test("the access log counts visitors, keeps refusals without tokens, and alerts on bursts", async () => {
  const alerts: string[] = [];
  const log = new AccessLog(join(await mkdtemp(join(tmpdir(), "kesher-al-")), "access-log.json"), (t) => void alerts.push(t));
  const app = Fastify();
  registerRemoteAuth(app, () => "the-token-123", {}, (r) => log.note(r));
  app.get("/api/conversations", async () => []);
  await app.ready();
  const phone = { remoteAddress: "192.168.1.20", headers: { host: "192.168.1.5:7420", authorization: "Bearer the-token-123", "user-agent": "KesherAI Android" } };
  await app.inject({ url: "/api/conversations", ...phone });
  await app.inject({ url: "/api/conversations", ...phone });
  for (let i = 0; i < 5; i++) await app.inject({ url: "/api/conversations?token=guess" + i, remoteAddress: "203.0.113.7", headers: { host: "x.trycloudflare.com", "cf-connecting-ip": "203.0.113.7" } });
  // From this computer: not logged.
  await app.inject({ url: "/api/conversations", headers: { host: "localhost:7420" } });
  const l = await log.list();
  assert.equal(l.visitors.length, 1);
  assert.equal(l.visitors[0]!.count, 2);
  assert.equal(l.refused.length, 5);
  assert.equal(l.refused[0]!.via, "tunnel");
  assert.doesNotMatch(JSON.stringify(l), /guess|the-token/);
  assert.deepEqual(alerts, ["Someone tried to get into KesherAI"]);
  // The phone's own address refused (an old code after an app update): said without the alarm.
  for (let i = 0; i < 5; i++) await app.inject({ url: "/api/conversations", remoteAddress: "192.168.1.20", headers: { host: "192.168.1.5:7420", authorization: "Bearer old-code" + i } });
  assert.deepEqual(alerts, ["Someone tried to get into KesherAI", "A device was refused a few times"]);
  await app.close();
});

test("refused requests record the kind of key sent, never its text", async () => {
  const log = new AccessLog(join(await mkdtemp(join(tmpdir(), "kesher-al-")), "access-log.json"));
  const app = Fastify();
  registerRemoteAuth(app, () => "the-token-123", {}, (r) => log.note(r));
  app.get("/api/conversations", async () => []);
  await app.ready();
  // A device key that is no longer paired (an old code after an app update).
  await app.inject({ url: "/api/conversations", remoteAddress: "192.168.1.20", headers: { host: "192.168.1.5:7420", authorization: "Bearer kd_old-code-after-an-update" } });
  // A stranger's key: not a device key, not the shared token.
  await app.inject({ url: "/api/conversations", remoteAddress: "203.0.113.7", headers: { host: "x.trycloudflare.com", "cf-connecting-ip": "203.0.113.7", authorization: "Bearer stranger-key-42" } });
  // No key at all.
  await app.inject({ url: "/api/conversations", remoteAddress: "203.0.113.9", headers: { host: "x.trycloudflare.com", "cf-connecting-ip": "203.0.113.9" } });
  // The right shared token, but sent by another website: still "shared", not "different".
  await app.inject({ url: "/api/conversations", remoteAddress: "203.0.113.10", headers: { host: "x.trycloudflare.com", "cf-connecting-ip": "203.0.113.10", origin: "http://evil.example", authorization: "Bearer the-token-123" } });
  const l = await log.list();
  // Newest first: the token, no key, the stranger's key, the old device key.
  assert.deepEqual(l.refused.map((r) => r.kind), ["shared", "none", "other", "device-key"]);
  assert.doesNotMatch(JSON.stringify(l), /kd_old|stranger-key-42|the-token/);
  await app.close();
});
