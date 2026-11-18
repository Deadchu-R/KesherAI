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
