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
