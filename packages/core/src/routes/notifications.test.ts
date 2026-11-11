import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { DeviceKey } from "../device-keys.js";
import { registerRemoteAuth } from "../auth.js";
import type { KesherServices } from "../services.js";
import { notificationRoutes } from "./notifications.js";

test("/api/phone-push is only for a paired device with its own key", async () => {
  const devices: DeviceKey[] = [];
  const key = `kd_test-phone-${"a".repeat(32)}`;
  devices.push({ id: "phone-1", name: "Test phone", hash: "h", createdAt: "2026-01-01T00:00:00.000Z" });
  const app = Fastify();
  // The real auth, so the request is recognized the way it would be on the server.
  registerRemoteAuth(app, () => "the-token-123", {}, undefined, {
    find: (k) => (k === key ? { id: "phone-1", name: "Test phone" } : undefined),
    seen: () => undefined,
    devicesOnly: () => false,
    idleDays: () => 0,
  });
  await notificationRoutes(app, { config: { remote: { devices } }, phonePush: { status: () => ({ seq: 3, pending: [] }) }, tunnel: { status: () => ({ url: "https://kesher.example" }) }, saveConfig: async () => undefined } as unknown as KesherServices);
  await app.ready();
  // A paired device, with its own key: allowed.
  const ok = await app.inject({ url: "/api/phone-push", remoteAddress: "203.0.113.7", headers: { host: "x.trycloudflare.com", "cf-connecting-ip": "203.0.113.7", authorization: `Bearer ${key}` } });
  assert.equal(ok.statusCode, 200);
  assert.equal((ok.json() as { internet: string | null }).internet, "https://kesher.example");
  // The same request without the paired device's key (an ordinary browser with the shared token): refused.
  const bad = await app.inject({ url: "/api/phone-push", remoteAddress: "203.0.113.8", headers: { host: "x.trycloudflare.com", "cf-connecting-ip": "203.0.113.8", authorization: "Bearer the-token-123" } });
  assert.equal(bad.statusCode, 403);
  // …and one with a device key that is no longer paired is just a wrong key: refused too.
  const gone = await app.inject({ url: "/api/phone-push", remoteAddress: "203.0.113.9", headers: { host: "x.trycloudflare.com", "cf-connecting-ip": "203.0.113.9", authorization: "Bearer kd_a-key-that-was-removed" } });
  assert.equal(gone.statusCode, 401);
  await app.close();
});
