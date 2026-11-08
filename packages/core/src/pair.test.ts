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
    assert.equal(got.token, s.services.config.remote.token);
    // Only once.
    assert.equal((await s.app.inject({ method: "GET", url: `/api/pair/${id}`, ...phone })).statusCode, 404);
    // Not through the public tunnel.
    assert.equal((await s.app.inject({ method: "POST", url: "/api/pair", payload: {}, remoteAddress: "127.0.0.1", headers: { "cf-connecting-ip": "8.8.8.8" } })).statusCode, 403);
  } finally {
    await s.app.close();
  }
});
