import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnityCli, type CliRunner } from "./unity-cli.js";
import type { BlueprintJson } from "./unreal-bridge.js";
import type { SyncReport } from "./game-sync.js";

const G: BlueprintJson = { path: "Assets/Door.asset", name: "Door", variables: [], graphs: [{ name: "Door", kind: "event", nodes: [{ id: "u1", title: "Start", class: "Start", x: 0, y: 0, pins: [] }] }] };
const result = (v: unknown) => ({ code: 0, stdout: JSON.stringify({ type: "result", success: true, data: { result: JSON.stringify(v) } }), stderr: "" });

/** Unity closed: every call is a batch run ("run"). */
async function setup() {
  const runs: string[][] = [];
  const run: CliRunner = async (args) => {
    if (args[0] === "--version") return { code: 0, stdout: "1.0.0", stderr: "" };
    if (args[0] === "status") return { code: 12, stdout: JSON.stringify({ success: false }), stderr: "" };
    if (args[0] !== "run") return { code: 1, stdout: "", stderr: "closed" };
    runs.push(args);
    const cmd = args[3];
    if (cmd === "kesher_graph") return result(G);
    if (cmd === "kesher_list") return result({ blueprints: [{ path: G.path, name: "Door" }] });
    if (cmd === "kesher_batch") {
      const list = JSON.parse(readFileSync(args[args.indexOf("--file") + 1]!, "utf8")) as Array<{ cmd: string }>;
      return result({ answers: list.map((c) => ({ ok: true, result: c.cmd === "graph" ? { ...G, name: "Door2" } : { failed: 0 } })) });
    }
    return { code: 1, stdout: "", stderr: "?" };
  };
  const project = await mkdtemp(join(tmpdir(), "kesher-unity-"));
  await mkdir(join(project, "Assets"));
  await writeFile(join(project, "Assets", "Door.asset"), "x");
  const t = Date.now() / 1000 - 120;
  await utimes(join(project, "Assets", "Door.asset"), t, t);
  const data = await mkdtemp(join(tmpdir(), "kesher-unity-data-"));
  const u = new UnityCli({ projects: [project], active: project }, async () => undefined, run, data);
  return { u, runs, project };
}

test("Unity closed: a graph read once opens again at once, from the saved copy", async () => {
  const { u, runs, project } = await setup();
  const first = await u.graph(G.path);
  assert.equal(first.offline, true);
  assert.equal(runs.length, 1);
  const again = await u.graph(G.path);
  assert.equal(again.cached, true);
  assert.equal(again.savedAt, first.savedAt);
  assert.equal(runs.length, 1, "no batch Unity for a saved copy");
  // The list too.
  await u.list();
  await u.list();
  assert.equal(runs.filter((r) => r[3] === "kesher_list").length, 1);
  // Unity saved the graph's file after the copy: read again.
  const now = Date.now() / 1000 + 10;
  await utimes(join(project, "Assets", "Door.asset"), now, now);
  assert.equal((await u.graph(G.path)).cached, undefined);
  assert.equal(runs.length, 3);
});

test("Unity closed: edits wait, then sync together in one Unity run", async () => {
  const { u, runs, project } = await setup();
  await u.graph(G.path);
  const reports: SyncReport[] = [];
  u.onSync = (r) => reports.push(r);
  await u.enqueue({ project, path: G.path, graph: "", ops: [{ op: "add", type: "branch" }] });
  await u.enqueue({ project, path: G.path, graph: "", ops: [{ op: "delete", node: "u1" }] });
  assert.equal((await u.status()).queued, 2);
  const before = runs.length;
  assert.deepEqual(await u.syncNow(), { applied: 2, failed: 0 });
  assert.equal(runs.length - before, 1, "one Unity run for the whole queue");
  assert.equal(runs.at(-1)![3], "kesher_batch");
  assert.equal((await u.queue()).length, 0);
  // The graph read at the end is the new saved copy; nothing to notify about.
  assert.equal((await u.graph(G.path)).graph.name, "Door2");
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.clashes, 0);
});

test("a change that clashes with an edit saved in Unity waits for a choice", async () => {
  const { u, runs, project } = await setup();
  await u.graph(G.path);
  const item = await u.enqueue({ project, path: G.path, graph: "", ops: [{ op: "add", type: "branch" }] });
  assert.ok(item.baseAt && item.baseSig?.u1 === "Start");
  const now = Date.now() / 1000 + 10;
  await utimes(join(project, "Assets", "Door.asset"), now, now);
  const reports: SyncReport[] = [];
  u.onSync = (r) => reports.push(r);
  const before = runs.length;
  assert.deepEqual(await u.syncNow(), { applied: 0, failed: 0 });
  assert.equal(runs.length, before, "nothing ran");
  assert.equal(reports[0]!.clashes, 1);
  assert.ok((await u.queue())[0]!.clash);
  // Skip for now: still waiting, never synced; keep mine: applied.
  await u.decide(item.id, "skip");
  assert.deepEqual(await u.syncNow(), { applied: 0, failed: 0 });
  await u.decide(item.id, "mine");
  assert.deepEqual(await u.syncNow(), { applied: 1, failed: 0 });
  // Keep the engine's: dropped.
  const other = await u.enqueue({ project, path: G.path, graph: "", ops: [] });
  assert.equal(await u.decide(other.id, "engine"), true);
  assert.equal((await u.queue()).length, 0);
});
