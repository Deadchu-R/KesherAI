import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { godotSceneRoutes } from "./godot-scene.js";
import type { GodotBridge } from "../godot-bridge.js";

const SCENE = `[gd_scene format=3]\n\n[node name="Level" type="Node3D"]\n\n[node name="Crate" type="Node3D" parent="."]\ntransform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 2, 0, -1)\n`;

async function setup(open = false) {
  const dir = await mkdtemp(join(tmpdir(), "godot-"));
  await writeFile(join(dir, "project.godot"), "config_version=5\n");
  await mkdir(join(dir, "levels"));
  await writeFile(join(dir, "levels", "a.tscn"), SCENE);
  const app = Fastify();
  await godotSceneRoutes(app, { status: () => ({ connected: open, latest: "x" }) } as unknown as GodotBridge);
  return { app, dir };
}
const move = (from?: number[]) => ({ path: "Crate", ...(from ? { from } : {}), transform: { basis: [1, 0, 0, 0, 1, 0, 0, 0, 1], origin: [5, 0, 0] as [number, number, number] } });

test("a Godot scene without Godot: listed, read, and a move written (with a backup); never outside the project", async () => {
  const { app, dir } = await setup();
  assert.deepEqual((await app.inject({ url: `/api/godot/scenes?project=${encodeURIComponent(dir)}` })).json().scenes, ["res://levels/a.tscn"]);
  const r = (await app.inject({ url: `/api/godot/scene?project=${encodeURIComponent(dir)}&scene=res://levels/a.tscn` })).json();
  assert.deepEqual(r.nodes.map((n: { path: string }) => n.path), [".", "Crate"]);
  const w = await app.inject({ method: "POST", url: "/api/godot/scene", payload: { project: dir, scene: "res://levels/a.tscn", changes: [move([1, 0, 0, 0, 1, 0, 0, 0, 1, 2, 0, -1])] } });
  assert.equal(w.json().written, 1);
  assert.match(await readFile(join(dir, "levels", "a.tscn"), "utf8"), /0, 0, 1, 5, 0, 0\)/);
  assert.equal(await readFile(join(dir, "levels", "a.tscn.kesher-bak"), "utf8"), SCENE);
  assert.equal((await app.inject({ url: `/api/godot/scene?project=${encodeURIComponent(dir)}&scene=res://../x.tscn` })).statusCode, 400);
  await app.close();
});

test("it moved in Godot meanwhile: a conflict, unless she keeps hers; Godot open: it waits", async () => {
  const { app, dir } = await setup();
  const c = await app.inject({ method: "POST", url: "/api/godot/scene", payload: { project: dir, scene: "res://levels/a.tscn", changes: [move([1, 0, 0, 0, 1, 0, 0, 0, 1, 9, 9, 9])] } });
  assert.equal(c.statusCode, 409);
  assert.deepEqual(c.json().conflicts, ["Crate"]);
  assert.equal((await app.inject({ method: "POST", url: "/api/godot/scene", payload: { project: dir, scene: "res://levels/a.tscn", keep: "mine", changes: [move([0])] } })).json().written, 1);
  await app.close();
  const open = await setup(true);
  assert.equal((await open.app.inject({ method: "POST", url: "/api/godot/scene", payload: { project: open.dir, scene: "res://levels/a.tscn", changes: [move()] } })).json().code, "godot-open");
  await open.app.close();
});

test("a link inside the project that leads outside is refused", async () => {
  const { symlink } = await import("node:fs/promises");
  const { app, dir } = await setup();
  const outside = await mkdtemp(join(tmpdir(), "out-"));
  await writeFile(join(outside, "b.tscn"), SCENE);
  await symlink(outside, join(dir, "linked"));
  assert.equal((await app.inject({ url: `/api/godot/scene?project=${encodeURIComponent(dir)}&scene=res://linked/b.tscn` })).statusCode, 400);
  await app.close();
});
