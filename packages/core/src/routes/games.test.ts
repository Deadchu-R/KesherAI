import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gamesRoutes, syncNote } from "./games.js";
import { UnityCli, type CliRunner } from "../unity-cli.js";
import { UnrealBridge } from "../unreal-bridge.js";
import type { KesherServices } from "../services.js";
import type { Note } from "../notify.js";
import { GameCheckpoints } from "../game-checkpoints.js";

test("a sync note only for a failure or a clash", () => {
  assert.equal(syncNote({ engine: "unity", project: "/p/Game", applied: 3, failed: 0, clashes: 0 }), undefined);
  assert.match(syncNote({ engine: "unity", project: "/p/Game", applied: 0, failed: 0, clashes: 2 })!.title, /Sync clash: Game/);
  assert.match(syncNote({ engine: "unreal", project: "Shooter", applied: 0, failed: 1, clashes: 0, error: "boom" })!.title, /Sync failed: Shooter/);
});

test("Game projects: a Unity project with a clash, both sides on the sheet, and the choice applied", async () => {
  const home = await mkdtemp(join(tmpdir(), "kesher-games-"));
  const project = join(home, "Game");
  await mkdir(join(project, "Assets"), { recursive: true });
  await mkdir(join(project, "ProjectSettings"));
  await writeFile(join(project, "Assets", "Door.asset"), "x");
  await mkdir(join(project, "KesherAI"));
  await writeFile(join(project, "KesherAI", "pending-moves.json"), JSON.stringify({ "Assets/Main.unity": [{}, {}] }));
  const run: CliRunner = async (args) => (args[0] === "--version" ? { code: 0, stdout: "1", stderr: "" } : { code: 12, stdout: "{}", stderr: "" });
  const config = { unity: { projects: [project], active: project } };
  const unity = new UnityCli(config.unity, async () => undefined, run, join(home, "data", "unity"));
  const unreal = new UnrealBridge(join(home, "data", "unreal"));
  const sent: Note[] = [];
  const s = { unity, unreal, config, paths: { root: join(home, "data") }, godot: { status: () => ({ connected: false, latest: "" }) }, notifier: { send: async (n: Note) => { sent.push(n); return []; } } } as unknown as KesherServices;
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const app = Fastify();
  try {
    await gamesRoutes(app, s);
    const q = await unity.enqueue({ project, path: "Assets/Door.asset", graph: "", ops: [{ op: "add", type: "branch" }], baseAt: new Date(Date.now() - 60_000).toISOString(), baseSig: { u1: "Start" } });
    const t = Date.now() / 1000;
    await utimes(join(project, "Assets", "Door.asset"), t, t);
    await unity.syncNow(project);
    assert.equal(sent.length, 1, "notified once for the clash");
    assert.equal(sent[0]!.path, "#/games?sync=1");
    const home1 = (await app.inject({ url: "/api/games" })).json() as { projects: Array<{ engine: string; pending: number; moves: number; clashes: number; canSync: boolean }>; clashes: number };
    const p = home1.projects.find((x) => x.engine === "unity")!;
    assert.deepEqual([p.pending, p.moves, p.clashes, p.canSync, home1.clashes], [3, 2, 1, true, 1]);
    const c = (await app.inject({ url: "/api/games/conflicts" })).json().conflicts as Array<{ id: string; name: string; mine: string[] }>;
    assert.deepEqual([c[0]!.id, c[0]!.name, c[0]!.mine], [q.id, "Door", ["+ branch"]]);
    assert.equal((await app.inject({ method: "POST", url: `/api/games/conflicts/${q.id}`, payload: { choice: "bad" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: `/api/games/conflicts/${q.id}`, payload: { choice: "engine" } })).json().ok, true);
    assert.equal((await unity.queue()).length, 0);
    assert.equal((await app.inject({ method: "POST", url: `/api/games/conflicts/${q.id}`, payload: { choice: "engine" } })).statusCode, 404);
    // Search with Unity closed: the project's assets, and only projects found on this computer.
    const found = (await app.inject({ url: `/api/games/search?engine=unity&project=${encodeURIComponent(project)}&q=door` })).json() as { results: Array<{ hits: Array<{ kind: string; path: string }> }> };
    assert.deepEqual(found.results[0]!.hits.map((h) => [h.kind, h.path]), [["asset", "Assets/Door.asset"]]);
    assert.equal((await app.inject({ url: "/api/games/search?engine=unity&project=%2Fetc&q=passwd" })).statusCode, 400);
    // Only projects found on this computer can be synced.
    assert.equal((await app.inject({ method: "POST", url: "/api/games/sync", payload: { engine: "unity", project: "/etc" } })).statusCode, 400);
  } finally {
    process.env.HOME = oldHome;
    await app.close();
  }
});

test("Game projects: checkpoints listed, compared, restored, and the limits saved", async () => {
  const home = await mkdtemp(join(tmpdir(), "kesher-games-cp-"));
  const project = join(home, "Game");
  await mkdir(join(project, "Assets"), { recursive: true });
  await mkdir(join(project, "ProjectSettings"));
  await writeFile(join(project, "Assets", "Door.cs"), "class Door {}\n");
  const config = { unity: { projects: [project] }, gameCheckpoints: { days: 30, maxMB: 4096 } };
  const store = new GameCheckpoints(() => join(home, "heavy", "game-checkpoints"), () => config.gameCheckpoints);
  const unreal = new UnrealBridge(join(home, "data", "unreal"));
  const unity = new UnityCli(config.unity, async () => undefined, async () => ({ code: 1, stdout: "", stderr: "" }), join(home, "data", "unity"));
  const s = { unity, unreal, config, paths: { root: join(home, "data") }, gameCheckpoints: store, saveConfig: async () => undefined, godot: { status: () => ({ connected: false, latest: "" }) }, notifier: { send: async () => [] } } as unknown as KesherServices;
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const app = Fastify();
  try {
    await gamesRoutes(app, s);
    const cp = await store.beforeSave("unity", project, "source", "Save Assets/Door.cs", [join(project, "Assets", "Door.cs")]);
    await writeFile(join(project, "Assets", "Door.cs"), "class Door { void Open() {} }\n");
    const list = (await app.inject({ url: `/api/games/checkpoints?engine=unity&project=${encodeURIComponent(project)}` })).json() as { checkpoints: Array<{ id: string; files: Array<{ rel: string }> }>; bytes: number };
    assert.deepEqual([list.checkpoints[0]!.id, list.checkpoints[0]!.files[0]!.rel], [cp!.id, "Assets/Door.cs"]);
    assert.ok(list.bytes > 0);
    const d = (await app.inject({ url: `/api/games/checkpoints/${cp!.id}/diff?path=Assets/Door.cs` })).json() as { binary: boolean; diff: string };
    assert.equal(d.binary, false);
    assert.match(d.diff, /\+class Door \{ void Open/);
    assert.equal((await app.inject({ method: "POST", url: `/api/games/checkpoints/${cp!.id}/restore` })).json().restored, 1);
    assert.equal(await readFile(join(project, "Assets", "Door.cs"), "utf8"), "class Door {}\n");
    assert.equal((await app.inject({ method: "PUT", url: "/api/games/checkpoints/settings", payload: { days: 0, maxMB: 10 } })).statusCode, 400);
    assert.deepEqual((await app.inject({ method: "PUT", url: "/api/games/checkpoints/settings", payload: { days: 7, maxMB: 500 } })).json().limits, { days: 7, maxMB: 500 });
    assert.equal((await app.inject({ url: "/api/games/checkpoints?engine=unity&project=%2Fetc" })).statusCode, 400);
  } finally {
    process.env.HOME = oldHome;
    await app.close();
  }
});
