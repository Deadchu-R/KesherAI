import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubOwnerState, hubPlan, hubStaticFile, startHubServer } from "./design-hub.js";
import { parseScenarioFile } from "./design-scenarios.js";

const seedOf = (hub: object) => parseScenarioFile(JSON.stringify({ group: "האב", target: "hub", boards: [{ id: "H", title: "t", route: "#tasks", hub }] }), "hub.json")[0]!.hub!;

async function site(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hub-site-"));
  await mkdir(join(root, "js"));
  await writeFile(join(root, "index.html"), "<p>index</p>");
  await writeFile(join(root, "connect.html"), "<p>connect</p>");
  await writeFile(join(root, "js", "a.js"), "export {}");
  await writeFile(join(root, "..", "hub-secret.txt"), "secret");
  return root;
}

test("the hub's static files: the pages as the Worker serves them, nothing outside the folder", async () => {
  const root = await site();
  try {
    assert.equal(hubStaticFile(root, "/"), join(root, "index.html"));
    assert.equal(hubStaticFile(root, "/connect"), join(root, "connect.html"));
    assert.equal(hubStaticFile(root, "/js/a.js"), join(root, "js", "a.js"));
    for (const bad of ["/../hub-secret.txt", "/%2e%2e/hub-secret.txt", "/js/../../hub-secret.txt", "/js", "/missing.js", "/a\\b", "/x%00", "/%E0%A4%A"]) assert.equal(hubStaticFile(root, bad), undefined, bad);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(join(root, "..", "hub-secret.txt"), { force: true });
  }
});

test("the hub server answers files with their type, an empty /__blank page, and 404 for the rest", async () => {
  const root = await site();
  const srv = await startHubServer(root);
  try {
    const js = await fetch(`${srv.base}/js/a.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    assert.match(await (await fetch(`${srv.base}/__blank`)).text(), /<title>seed<\/title>/);
    assert.equal((await fetch(`${srv.base}/api/state`)).status, 404);
  } finally {
    srv.close();
    await rm(root, { recursive: true, force: true });
    await rm(join(root, "..", "hub-secret.txt"), { force: true });
  }
});

test("a seed is filled in: tasks, run states, numbered events, the device", () => {
  const now = Date.parse("2026-11-21T09:00:00Z");
  const seed = seedOf({ device: { name: "הטלפון" }, pcs: [{ id: "pc1", name: "PC" }], tasks: [{ title: "משימה", status: "running" }], agents: [{ pc: "pc1", runId: "in-1", state: { title: "בדיקה", state: "done" }, events: [{ type: "cancelled" }, { type: "cancelled", seq: 9 }] }] });
  const plan = hubPlan(seed, now);
  assert.equal(plan.tasks[0]!.taskId, "t1");
  assert.equal(plan.tasks[0]!.status, "running");
  assert.equal(plan.tasks[0]!.createdAt, now - 3_600_000);
  const a = plan.agents[0]!;
  assert.equal(a.state.runId, "in-1");
  assert.equal(a.state.endedAt, now - 120_000, "an ended run has an end time");
  assert.deepEqual(a.events.map((e) => e.seq), [1, 9]);
  assert.equal(plan.device?.name, "הטלפון");
});

test("a run on a PC the seed does not list is refused", () => {
  assert.throws(() => hubPlan(seedOf({ agents: [{ pc: "nope", runId: "r1" }] }), 0), /not in "pcs"/);
});

test("a quotas seed is cleaned as the page cleans it, its times fixed; an unknown PC is refused", () => {
  const now = Date.UTC(2026, 10, 27, 9);
  const plan = hubPlan(seedOf({ pcs: [{ id: "pc1", name: "PC" }], quotas: [{ pc: "pc1", items: [{ id: "opencode", kind: "opencode", name: "OpenCode Go", state: "out", bars: [{ label: "day", used: 10, limit: 10, resetAt: { $inMs: "2h" } }], readAt: { $agoMs: "3m" } }, { id: "bad id", kind: "local", name: "x", state: "ok", bars: [] }] }] }), now);
  assert.equal(plan.quotas.length, 1);
  assert.equal(plan.quotas[0]!.at, now);
  // The seed's times are fixed by the scenario's own clock when it is read.
  const q = plan.quotas[0]!.items;
  assert.deepEqual(q.map((x) => [x.id, x.group, x.state, x.bars[0]?.used, x.bars[0]?.limit]), [["opencode", "tasks", "out", 10, 10]]);
  assert.equal(q[0]!.bars[0]!.resetAt! - q[0]!.readAt!, 2 * 3_600_000 + 3 * 60_000);
  assert.throws(() => hubPlan(seedOf({ pcs: [], quotas: [{ pc: "nope", items: [] }] }), now), /quotas are on PC "nope"/);
});

test("the owner state has defaults and the seed's fields win", () => {
  const seed = seedOf({ owner: { paused: true, connections: [{ id: "c1", name: "Claude" }] } });
  const o = hubOwnerState(seed, [{ id: "pc1", name: "PC", kind: "pc", online: true }]);
  assert.equal(o.paused, true);
  assert.equal(o.cloudReady, true);
  assert.equal((o.devices as unknown[]).length, 1);
  assert.deepEqual(o.connections, [{ id: "c1", name: "Claude" }]);
});
