import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gamesRoutes } from "./games.js";
import { UnityCli } from "../unity-cli.js";
import { UnrealBridge } from "../unreal-bridge.js";
import { GameCheckpoints } from "../game-checkpoints.js";
import type { KesherServices } from "../services.js";
import { canSymlink } from "../test-utils.js";

const PREFAB = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &100
GameObject:
  m_Component:
  - component: {fileID: 540}
  m_Name: Crate
--- !u!54 &540
Rigidbody:
  m_GameObject: {fileID: 100}
  m_Mass: 1
  m_Drag: 0
`;

test("Inspector: a prefab's values with Unity closed, a change queued, synced after a checkpoint, a clash held", async () => {
  const home = await mkdtemp(join(tmpdir(), "kesher-inspect-"));
  const project = join(home, "Game");
  await mkdir(join(project, "Assets"), { recursive: true });
  await mkdir(join(project, "ProjectSettings"));
  await writeFile(join(project, "Assets", "Crate.prefab"), PREFAB);
  await writeFile(join(project, "Assets", "Crate.prefab.meta"), "fileFormatVersion: 2\nguid: 11111111111111111111111111111111\n");
  const config = { unity: { projects: [project] }, gameCheckpoints: { days: 30, maxMB: 4096 } };
  const store = new GameCheckpoints(() => join(home, "heavy"));
  const unity = new UnityCli(config.unity, async () => undefined, async () => ({ code: 1, stdout: "", stderr: "" }), join(home, "data", "unity"));
  const notes: unknown[] = [];
  const s = { unity, unreal: new UnrealBridge(join(home, "data", "unreal")), config, paths: { root: join(home, "data") }, gameCheckpoints: store, godot: { status: () => ({ connected: false, latest: "" }) }, notifier: { send: async (n: unknown) => { notes.push(n); return []; } } } as unknown as KesherServices;
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const app = Fastify();
  const q = (path: string) => `engine=unity&project=${encodeURIComponent(project)}${path ? `&path=${encodeURIComponent(path)}` : ""}`;
  try {
    await gamesRoutes(app, s);
    const files = (await app.inject({ url: `/api/games/inspect/files?${q("")}` })).json() as { files: Array<{ path: string }> };
    assert.deepEqual(files.files.map((f) => f.path), ["Assets/Crate.prefab"]);
    const view = (await app.inject({ url: `/api/games/inspect?${q("Assets/Crate.prefab")}` })).json() as { objects: Array<{ name: string; components: Array<{ target: string; type: string; fields: Array<{ name: string; value: string }> }> }>; open: boolean };
    assert.equal(view.open, false);
    assert.deepEqual(view.objects[0]!.components[1]!.fields.map((f) => [f.name, f.value]), [["m_Mass", "1"], ["m_Drag", "0"]]);
    // Outside the project, or not an asset: refused.
    assert.equal((await app.inject({ url: `/api/games/inspect?${q("../secret.prefab")}` })).statusCode, 400);
    assert.equal((await app.inject({ url: `/api/games/inspect?${q("Assets/Crate.prefab.meta")}` })).statusCode, 400);
    // Scan 168: a prefab that is a link out of the project is neither read nor queued.
    if (await canSymlink()) {
      await writeFile(join(home, "outside.prefab"), "%YAML 1.1\n");
      await symlink(join(home, "outside.prefab"), join(project, "Assets", "Linked.prefab"));
      assert.equal((await app.inject({ url: `/api/games/inspect?${q("Assets/Linked.prefab")}` })).statusCode, 400);
    }
    const body = (to: string, from = "1", name = "m_Mass") => ({ engine: "unity", project, path: "Assets/Crate.prefab", target: "540", name, from, to });
    assert.equal((await app.inject({ method: "POST", url: "/api/games/inspect/value", payload: body("heavy") })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/games/inspect/value", payload: body("5", "2") })).statusCode, 409);
    assert.equal((await app.inject({ method: "POST", url: "/api/games/inspect/value", payload: body("5") })).json().queued, true);
    assert.equal((await app.inject({ method: "POST", url: "/api/games/inspect/value", payload: body("0.5", "0", "m_Drag") })).json().queued, true);
    const listed = (await app.inject({ url: "/api/games" })).json() as { projects: Array<{ pending: number; values: number; canSync: boolean }> };
    assert.deepEqual([listed.projects[0]!.pending, listed.projects[0]!.values, listed.projects[0]!.canSync], [2, 2, true]);
    // Unity changed the drag meanwhile: the mass goes in, the drag waits for a choice.
    await writeFile(join(project, "Assets", "Crate.prefab"), PREFAB.replace("m_Drag: 0", "m_Drag: 2"));
    const synced = (await app.inject({ method: "POST", url: "/api/games/sync", payload: { engine: "unity", project } })).json() as { values: { applied: number; clashes: number } };
    assert.deepEqual([synced.values.applied, synced.values.clashes], [1, 1]);
    assert.match(await readFile(join(project, "Assets", "Crate.prefab"), "utf8"), /m_Mass: 5\n {2}m_Drag: 2/);
    assert.equal(notes.length, 1, "one note for the clash");
    assert.equal((await store.list(project))[0]!.files[0]!.rel, "Assets/Crate.prefab");
    const conflicts = (await app.inject({ url: "/api/games/conflicts" })).json().conflicts as Array<{ id: string; engine: string; mine: string[]; value: { engine: string[] } }>;
    assert.deepEqual([conflicts[0]!.engine, conflicts[0]!.mine[0], conflicts[0]!.value.engine[0]], ["unity", "Crate · m_Drag: 0 → 0.5", "Crate · m_Drag: 2"]);
    assert.equal((await app.inject({ method: "POST", url: `/api/games/conflicts/${conflicts[0]!.id}`, payload: { choice: "engine" } })).json().ok, true);
    // Unity open: values wait.
    await app.inject({ method: "POST", url: "/api/games/inspect/value", payload: body("7", "5") });
    await mkdir(join(project, "Temp"));
    await writeFile(join(project, "Temp", "UnityLockfile"), "");
    assert.equal((await app.inject({ method: "POST", url: "/api/games/sync", payload: { engine: "unity", project } })).statusCode, 409);
  } finally {
    process.env.HOME = oldHome;
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});
