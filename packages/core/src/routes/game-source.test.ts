import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gameSourceRoutes, listSource, sourceLang, sourcePath } from "./game-source.js";
import type { GameProject } from "../game-projects.js";
import type { KesherServices } from "../services.js";

/** A Godot project and an Unreal project with C++, Verse and files that must not be listed. */
async function projects(): Promise<{ home: string; godot: GameProject; unreal: GameProject }> {
  const home = await mkdtemp(join(tmpdir(), "kesher-gsrc-"));
  const g = join(home, "Platformer");
  await mkdir(join(g, "player"), { recursive: true });
  await mkdir(join(g, ".godot"), { recursive: true });
  await writeFile(join(g, "player", "player.gd"), "class_name Player\nfunc jump():\n\tpass\n");
  await writeFile(join(g, ".godot", "cache.gd"), "func x():\n");
  const u = join(home, "Shooter");
  await mkdir(join(u, "Source", "Shooter"), { recursive: true });
  await mkdir(join(u, "Content", "Verse"), { recursive: true });
  await mkdir(join(u, "Intermediate"), { recursive: true });
  await writeFile(join(u, "Source", "Shooter", "Enemy.h"), "class SHOOTER_API AEnemy : public ACharacter\n{\n};\n");
  await writeFile(join(u, "Content", "Verse", "score.verse"), "score_device := class(creative_device):\n");
  await writeFile(join(u, "Content", "stray.cpp"), "int x;\n");
  await writeFile(join(u, "Intermediate", "Gen.h"), "class Gen {};\n");
  return { home, godot: { kind: "godot", name: "Platformer", path: g }, unreal: { kind: "unreal", name: "Shooter", path: u } };
}

test("the code files of a Godot and an Unreal project, without caches and hidden folders", async () => {
  const { godot, unreal } = await projects();
  assert.deepEqual((await listSource(godot)).map((f) => [f.path, f.lang]), [["player/player.gd", "gdscript"]]);
  assert.deepEqual((await listSource(unreal)).map((f) => f.path), ["Content/Verse/score.verse", "Source/Shooter/Enemy.h"]);
  assert.equal(sourceLang("A.cs"), "csharp");
});

test("paths: outside the project, hidden folders, caches and non-code files are refused", async () => {
  const { godot, unreal } = await projects();
  assert.equal(sourcePath(godot, "player/player.gd").rel, "player/player.gd");
  assert.throws(() => sourcePath(godot, "../x.gd"));
  assert.throws(() => sourcePath(godot, ".godot/cache.gd"));
  assert.throws(() => sourcePath(godot, "project.godot"));
  assert.throws(() => sourcePath(unreal, "Intermediate/Gen.h"));
  assert.throws(() => sourcePath(unreal, "Content/stray.cpp"));
  assert.throws(() => sourcePath(unreal, "Source/../../etc/passwd"));
});

test("read with an outline, write with the old text kept, refuse a file changed meanwhile, go to definition", async () => {
  const { home, godot } = await projects();
  const s = { paths: { root: join(home, "data") }, unity: {} } as unknown as KesherServices;
  const app = Fastify();
  gameSourceRoutes(app, s, async (engine, path) => (engine === "godot" && path === godot.path ? godot : undefined));
  try {
    const q = `engine=godot&project=${encodeURIComponent(godot.path)}`;
    const files = (await app.inject({ url: `/api/games/source/files?${q}` })).json() as { files: unknown[]; compile: unknown };
    assert.deepEqual([files.files.length, files.compile], [1, null]);
    const f = (await app.inject({ url: `/api/games/source/file?${q}&path=player/player.gd` })).json() as { mtime: number; outline: unknown };
    assert.deepEqual(f.outline, [{ symbol: "class_name Player", line: 1 }, { symbol: "jump()", line: 2 }]);
    const put = await app.inject({ method: "PUT", url: "/api/games/source/file", payload: { engine: "godot", project: godot.path, path: "player/player.gd", text: "class_name Player\n", mtime: f.mtime } });
    assert.equal(put.statusCode, 200);
    assert.equal(await readFile(join(godot.path, "player", "player.gd"), "utf8"), "class_name Player\n");
    assert.equal((await readdir(join(home, "data", "game-backups", "godot"))).length, 1);
    const stale = await app.inject({ method: "PUT", url: "/api/games/source/file", payload: { engine: "godot", project: godot.path, path: "player/player.gd", text: "x\n", mtime: f.mtime - 5000 } });
    assert.equal(stale.statusCode, 409);
    // Scan 168: overwriting an existing file without the time it was opened with is refused too.
    const blind = await app.inject({ method: "PUT", url: "/api/games/source/file", payload: { engine: "godot", project: godot.path, path: "player/player.gd", text: "x\n" } });
    assert.equal(blind.statusCode, 409);
    assert.equal(await readFile(join(godot.path, "player", "player.gd"), "utf8"), "class_name Player\n");
    assert.equal((await app.inject({ url: `/api/games/source/files?engine=godot&project=%2Fetc` })).statusCode, 400);
    const def = (await app.inject({ url: `/api/games/source/definition?${q}&name=Player` })).json() as { definitions: Array<{ path: string; line: number }> };
    assert.deepEqual(def.definitions.map((d) => [d.path, d.line]), [["player/player.gd", 1]]);
  } finally {
    await app.close();
  }
});
