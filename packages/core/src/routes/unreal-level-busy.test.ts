import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { currentBusy, JobQueue, withBusy } from "../busy.js";
import type { UnrealBridge } from "../unreal-bridge.js";
import { unrealLevelRoutes } from "./unreal-level.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A server with the real level routes, a fake bridge whose meshes take a while, and a health route like the real one. */
async function app(slowMs: number, seen: { running: number; peak: number }) {
  const bridge = {
    projectFile: undefined,
    knownProjectFile: undefined,
    standIn: async (cmd: string) => {
      if (cmd !== "level_mesh") return { actors: [] };
      seen.running++;
      seen.peak = Math.max(seen.peak, seen.running);
      await sleep(slowMs);
      seen.running--;
      return { tris: "AAAA" };
    },
  } as unknown as UnrealBridge;
  const a = Fastify();
  await unrealLevelRoutes(a, bridge);
  a.get("/api/health", async () => ({ ok: true, ...(currentBusy() ? { busy: currentBusy()!.en, busyHe: currentBusy()!.he } : {}) }));
  return a;
}

test("the ping answers within 200 ms and says what is going on while many meshes are read", async () => {
  const seen = { running: 0, peak: 0 };
  const a = await app(150, seen);
  try {
    const meshes = Array.from({ length: 24 }, (_, i) => a.inject({ url: `/api/unreal/level/mesh?path=${encodeURIComponent(`/Game/M/Mesh${i}`)}` }));
    await sleep(30);
    const t0 = Date.now();
    const r = await a.inject({ url: "/api/health" });
    assert.ok(Date.now() - t0 < 200, `ping took ${Date.now() - t0} ms`);
    assert.equal(r.statusCode, 200);
    const j = r.json() as { busy?: string; busyHe?: string };
    assert.equal(j.busy, "Reading the level in the background");
    assert.match(String(j.busyHe), /רמה/);
    assert.ok((await Promise.all(meshes)).every((m) => m.statusCode === 200));
    assert.ok(seen.peak <= 4, `at most 4 meshes at once, saw ${seen.peak}`);
    assert.equal(currentBusy(), undefined, "the note is gone when the work ends");
  } finally {
    await a.close();
  }
});

test("the same mesh asked twice at once is read once", async () => {
  const seen = { running: 0, peak: 0 };
  const a = await app(50, seen);
  try {
    const url = "/api/unreal/level/mesh?path=%2FGame%2FM%2FSame";
    const [x, y] = await Promise.all([a.inject({ url }), a.inject({ url })]);
    assert.equal(x.statusCode, 200);
    assert.equal(y.statusCode, 200);
    assert.equal(seen.peak, 1);
  } finally {
    await a.close();
  }
});

test("JobQueue keeps its limit when a job fails, and withBusy clears its note", async () => {
  const q = new JobQueue(2);
  let running = 0;
  let peak = 0;
  const job = (fail: boolean) => async () => {
    peak = Math.max(peak, ++running);
    await sleep(10);
    running--;
    if (fail) throw new Error("x");
    return 1;
  };
  const all = await Promise.allSettled([q.run("a", job(true)), q.run("b", job(false)), q.run("c", job(true)), q.run("d", job(false))]);
  assert.equal(all.filter((r) => r.status === "rejected").length, 2);
  assert.equal(peak, 2);
  await assert.rejects(withBusy({ en: "x", he: "x" }, async () => Promise.reject(new Error("no"))));
  assert.equal(currentBusy(), undefined);
});
