import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnrealBridge } from "../unreal-bridge.js";
import { unrealLevelRoutes } from "./unreal-level.js";

test("an Unreal level without Unreal: read once in a headless editor, kept, and the moves saved through it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ul-"));
  const uproject = join(dir, "Game.uproject");
  writeFileSync(uproject, "{}");
  writeFileSync(join(dir, "last.json"), JSON.stringify({ last: "Game", projectFile: uproject }));
  const b = new UnrealBridge(dir);
  const runs: string[] = [];
  b.setHeadless(async (_file, commands) => {
    runs.push(...commands.map((c) => String(c.cmd)));
    return commands.map((c) =>
      c.cmd === "level" ? { ok: true, result: { path: c.path, actors: [{ id: "Cube_2", name: "Cube", class: "StaticMeshActor", position: [100, 0, 50], rotation: [0, 0, 0, 1], scale: [1, 1, 1], mesh: "/Engine/BasicShapes/Cube.Cube" }] } }
      : c.cmd === "level_move" ? { ok: true, result: { moved: (c.moves as unknown[]).length, clashes: [], missing: [], saved: true } }
      : { ok: true, result: { levels: ["/Game/Maps/Main"] } });
  });
  await b.project();
  const app = Fastify();
  await unrealLevelRoutes(app, b);
  assert.deepEqual((await app.inject({ url: "/api/unreal/levels" })).json().levels, ["/Game/Maps/Main"]);
  const first = (await app.inject({ url: "/api/unreal/level?path=/Game/Maps/Main" })).json();
  assert.equal(first.actors[0].id, "Cube_2");
  const again = (await app.inject({ url: "/api/unreal/level?path=/Game/Maps/Main" })).json();
  assert.equal(again.cached, true);
  assert.deepEqual(runs, ["levels", "level"], "the second read uses the copy kept");
  const move = { id: "Cube_2", from: { position: [100, 0, 50], rotation: [0, 0, 0, 1] }, to: { position: [300, 0, 50], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } };
  const r = (await app.inject({ method: "POST", url: "/api/unreal/level", payload: { path: "/Game/Maps/Main", moves: [move, { ...move, id: "x;y" }] } })).json();
  assert.equal(r.moved, 1);
  assert.equal(r.saved, true);
  (await app.inject({ url: "/api/unreal/level?path=/Game/Maps/Main" })).json();
  assert.equal(runs.filter((c) => c === "level").length, 2, "after a move, the level is read again");
  assert.equal((await app.inject({ url: "/api/unreal/level?path=/Game/../x" })).statusCode, 400);
  assert.equal((await app.inject({ url: "/api/unreal/level/mesh?path=C:/x" })).statusCode, 400);
  await app.close();
});

test("Unreal levels: an empty headless answer falls back to the .umap files on disk", async () => {
  const { mkdirSync } = await import("node:fs");
  const { levelsOnDisk } = await import("./unreal-level.js");
  const dir = mkdtempSync(join(tmpdir(), "ul-disk-"));
  const uproject = join(dir, "Game.uproject");
  writeFileSync(uproject, "{}");
  mkdirSync(join(dir, "Content", "Maps", "Sub"), { recursive: true });
  mkdirSync(join(dir, "Content", "__ExternalActors__", "Maps"), { recursive: true });
  writeFileSync(join(dir, "Content", "Maps", "Main.umap"), "");
  writeFileSync(join(dir, "Content", "Maps", "Sub", "Arena.umap"), "");
  writeFileSync(join(dir, "Content", "__ExternalActors__", "Maps", "X.umap"), "");
  writeFileSync(join(dir, "Content", "Maps", "Cube.uasset"), "");
  assert.deepEqual(await levelsOnDisk(dir), ["/Game/Maps/Main", "/Game/Maps/Sub/Arena"]);
  writeFileSync(join(dir, "last.json"), JSON.stringify({ last: "Game", projectFile: uproject }));
  const b = new UnrealBridge(dir);
  b.setHeadless(async (_f, commands) => commands.map(() => ({ ok: true, result: { levels: [] } })));
  await b.project();
  const app = Fastify();
  await unrealLevelRoutes(app, b);
  const r = (await app.inject({ url: "/api/unreal/levels" })).json();
  assert.deepEqual(r.levels, ["/Game/Maps/Main", "/Game/Maps/Sub/Arena"]);
  assert.equal(r.fromDisk, true);
});

test("Unreal levels: scanContent counts assets, and a project with only assets says so", async () => {
  const { mkdirSync } = await import("node:fs");
  const { scanContent } = await import("./unreal-level.js");
  const dir = mkdtempSync(join(tmpdir(), "ul-assets-"));
  mkdirSync(join(dir, "Content", "UI"), { recursive: true });
  mkdirSync(join(dir, "Content", "__ExternalActors__", "A"), { recursive: true });
  writeFileSync(join(dir, "Content", "UI", "WBP_Hud.uasset"), "");
  writeFileSync(join(dir, "Content", "UI", "BP_Door.uasset"), "");
  writeFileSync(join(dir, "Content", "__ExternalActors__", "A", "X.uasset"), "");
  assert.deepEqual(await scanContent(dir), { levels: [], assets: 2 });
  writeFileSync(join(dir, "Content", "UI", "Main.umap"), "");
  assert.deepEqual(await scanContent(dir), { levels: ["/Game/UI/Main"], assets: 2 });
  assert.deepEqual(await scanContent(join(dir, "missing")), { levels: [], assets: 0 });
});

test("Unreal levels: a project without the plugin answers from the files at once, with the asset count", async () => {
  const { mkdirSync } = await import("node:fs");
  // The project sits where KesherAI looks for Unreal projects (under the home folder; HOME points at a temp folder here).
  const home = mkdtempSync(join(tmpdir(), "ul-home-"));
  const dir = join(home, "Documents", "Unreal Projects", "OnlyUi");
  mkdirSync(join(dir, "Content", "UI"), { recursive: true });
  writeFileSync(join(dir, "OnlyUi.uproject"), "{}");
  writeFileSync(join(dir, "Content", "UI", "WBP_Hud.uasset"), "");
  // os.homedir() reads HOME on Linux/macOS and USERPROFILE on Windows.
  const was = process.env.HOME;
  const wasProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const b = new UnrealBridge(mkdtempSync(join(tmpdir(), "ul-b-")));
    let asked = 0;
    b.setHeadless(async () => { asked++; throw new Error("must not start an editor"); });
    const app = Fastify();
    await unrealLevelRoutes(app, b);
    const r = (await app.inject({ url: `/api/unreal/levels?project=${encodeURIComponent(dir)}` })).json();
    assert.deepEqual(r, { levels: [], fromDisk: true, assets: 1 });
    assert.equal(asked, 0);
    await app.close();
  } finally {
    if (was === undefined) delete process.env.HOME; else process.env.HOME = was;
    if (wasProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = wasProfile;
  }
});
