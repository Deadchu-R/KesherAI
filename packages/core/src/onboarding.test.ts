import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PARTS, ROLES, partsForRole } from "@kesher/shared";
import { createKesherServer } from "./server.js";

test("every role names real parts; an unknown role keeps everything on", () => {
  const ids = new Set(PARTS.map((p) => p.id));
  for (const r of ROLES) for (const p of r.parts) assert.ok(ids.has(p), `${r.id}: ${p}`);
  assert.equal(partsForRole("gamedev").unreal, true);
  assert.equal(partsForRole("writer").unreal, false);
  assert.ok(Object.values(partsForRole(undefined)).every(Boolean));
});

test("the welcome shows once on a fresh computer, only locally, and remembers the role", async () => {
  const server = await createKesherServer({ dataDir: await mkdtemp(join(tmpdir(), "kesher-welcome-")), autodetect: false, pluginRoots: [] });
  try {
    const get = async (remote = false) => (await server.app.inject({ url: "/api/onboarding", ...(remote ? { remoteAddress: "192.168.1.5" } : {}) })).json() as { show: boolean; role?: string };
    assert.equal((await get()).show, true);
    assert.notEqual((await server.app.inject({ method: "PUT", url: "/api/onboarding", payload: { done: true }, remoteAddress: "192.168.1.5" })).statusCode, 200);
    await server.app.inject({ method: "PUT", url: "/api/onboarding", payload: { done: true, role: "artist" } });
    const after = await get();
    assert.equal(after.show, false);
    assert.equal(after.role, "artist");
  } finally {
    await server.close();
  }
});

test("the welcome's roles are saved together, kept after a restart, and checked", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "kesher-welcome-"));
  const open = () => createKesherServer({ dataDir, autodetect: false, pluginRoots: [] });
  let server = await open();
  try {
    assert.equal((await server.app.inject({ method: "PUT", url: "/api/onboarding", payload: { role: "<script>" } })).statusCode, 400);
    assert.equal((await server.app.inject({ method: "PUT", url: "/api/onboarding", payload: { done: true, role: "gamedev,researcher" } })).statusCode, 200);
  } finally {
    await server.close();
  }
  server = await open();
  try {
    const o = (await server.app.inject({ url: "/api/onboarding" })).json() as { role?: string; done: boolean };
    assert.equal(o.role, "gamedev,researcher");
    assert.equal(o.done, true);
    const check = (await server.app.inject({ url: "/api/welcome/check?roles=gamedev&lang=he" })).json() as { drives: Array<{ id: string }>; picks: unknown[] };
    assert.ok(check.drives.length >= 1 && Array.isArray(check.picks));
  } finally {
    await server.close();
  }
});
