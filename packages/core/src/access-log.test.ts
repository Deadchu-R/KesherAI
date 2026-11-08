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
  await app.close();
});
