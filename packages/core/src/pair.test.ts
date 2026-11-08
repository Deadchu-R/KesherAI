import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKesherServer } from "./server.js";

test("pairing: a phone on the network asks, the user allows it here, the phone gets the token once", async () => {
  const data = await mkdtemp(join(tmpdir(), "kesher-pair-"));
  const s = await createKesherServer({ dataDir: data, autodetect: false, pluginRoots: [] });
  try {
    s.services.config.remote.enabled = true;
    const phone = { remoteAddress: "192.168.1.50" };
    const ask = await s.app.inject({ method: "POST", url: "/api/pair", payload: { device: "Pixel 9" }, ...phone });
    assert.equal(ask.statusCode, 200);
    const { id, code } = ask.json() as { id: string; code: string };
    assert.match(code, /^\d{4}$/);
    // A second request from the same phone waits for the first.
    assert.equal((await s.app.inject({ method: "POST", url: "/api/pair", payload: {}, ...phone })).statusCode, 429);
    // The phone cannot answer for itself, and others cannot read its request.
    assert.equal((await s.app.inject({ method: "POST", url: `/api/pair/${id}`, payload: { allow: true }, ...phone })).statusCode, 401);
    assert.equal((await s.app.inject({ method: "GET", url: `/api/pair/${id}`, remoteAddress: "192.168.1.66" })).statusCode, 404);
    assert.equal(((await s.app.inject({ method: "GET", url: `/api/pair/${id}`, ...phone })).json() as { state: string }).state, "pending");
    const waiting = (await s.app.inject({ method: "GET", url: "/api/pair" })).json() as Array<{ id: string; code: string; device: string }>;
    assert.deepEqual(waiting.map((w) => [w.code, w.device]), [[code, "Pixel 9"]]);
    assert.equal((await s.app.inject({ method: "POST", url: `/api/pair/${id}`, payload: { allow: true } })).statusCode, 200);
    const got = (await s.app.inject({ method: "GET", url: `/api/pair/${id}`, ...phone })).json() as { state: string; token?: string };
    assert.equal(got.state, "allowed");
    // A key of its own for this device (not the shared token), which works, and can be removed alone.
    assert.match(got.token!, /^kd_/);
    assert.notEqual(got.token, s.services.config.remote.token);
    const asPhone = { ...phone, headers: { ...(phone as { headers?: Record<string, string> }).headers, authorization: `Bearer ${got.token}` } };
    assert.equal((await s.app.inject({ method: "GET", url: "/api/conversations", ...asPhone })).statusCode, 200);
    assert.equal(s.services.config.remote.devices[0]!.name, "Pixel 9");
    assert.ok(!JSON.stringify(s.services.config.remote.devices).includes(got.token!), "only a hash is kept");
    // Through the internet link with "only paired devices", the shared token is refused and the device key is not.
    s.services.config.remote.anywhereDevicesOnly = true;
    const tunnel = { remoteAddress: "127.0.0.1", headers: { host: "x.trycloudflare.com", "cf-connecting-ip": "203.0.113.9" } };
    assert.equal((await s.app.inject({ method: "GET", url: "/api/conversations", ...tunnel, headers: { ...tunnel.headers, authorization: `Bearer ${s.services.config.remote.token}` } })).statusCode, 403);
    assert.equal((await s.app.inject({ method: "GET", url: "/api/conversations", ...tunnel, headers: { ...tunnel.headers, authorization: `Bearer ${got.token}` } })).statusCode, 200);
    await s.services.deviceKeys!.remove(s.services.config.remote.devices[0]!.id);
    assert.equal((await s.app.inject({ method: "GET", url: "/api/conversations", ...asPhone })).statusCode, 401, "a removed device is out at once");
    // Only once.
    assert.equal((await s.app.inject({ method: "GET", url: `/api/pair/${id}`, ...phone })).statusCode, 404);
    // Not through the public tunnel.
    assert.equal((await s.app.inject({ method: "POST", url: "/api/pair", payload: {}, remoteAddress: "127.0.0.1", headers: { "cf-connecting-ip": "8.8.8.8" } })).statusCode, 403);
  } finally {
    await s.app.close();
  }
});

test("a device with the shared token trades it for a key of its own", async () => {
  const { createKesherServer } = await import("./server.js");
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const s = await createKesherServer({ dataDir: await mkdtemp(join(tmpdir(), "kesher-ex-")), autodetect: false, pluginRoots: [] });
  try {
    s.services.config.remote.enabled = true;
    const shared = s.services.config.remote.token!;
    const phone = { remoteAddress: "192.168.1.50", headers: { host: "192.168.1.5:7420", authorization: `Bearer ${shared}`, "content-type": "application/json" } };
    const r = (await s.app.inject({ method: "POST", url: "/api/remote/devices/exchange", ...phone, payload: { device: "Pixel 9" } })).json() as { token: string };
    assert.match(r.token, /^kd_/);
    // A device key cannot trade itself for more keys.
    const again = await s.app.inject({ method: "POST", url: "/api/remote/devices/exchange", ...phone, headers: { ...phone.headers, authorization: `Bearer ${r.token}` }, payload: {} });
    assert.equal(again.statusCode, 400);
  } finally {
    await s.app.close();
  }
});
