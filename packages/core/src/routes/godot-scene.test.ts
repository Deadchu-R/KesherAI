import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { godotSceneRoutes } from "./godot-scene.js";
import type { GodotBridge } from "../godot-bridge.js";

const SCENE = `[gd_scene format=3]\n\n[node name="Level" type="Node3D"]\n\n[node name="Crate" type="Node3D" parent="."]\ntransform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 2, 0, -1)\n`;

async function setup(open = false, request?: (cmd: string, args: Record<string, unknown>) => Promise<unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "godot-"));
  await writeFile(join(dir, "project.godot"), "config_version=5\n");
  await mkdir(join(dir, "levels"));
  await writeFile(join(dir, "levels", "a.tscn"), SCENE);
  const app = Fastify();
  await godotSceneRoutes(app, { status: () => ({ connected: open, latest: "x" }), request: request ?? (() => Promise.reject(new Error("Unknown command standin_moves"))) } as unknown as GodotBridge);
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
  // An older addon: the move waits for Godot to close.
  const old = await open.app.inject({ method: "POST", url: "/api/godot/scene", payload: { project: open.dir, scene: "res://levels/a.tscn", changes: [move()] } });
  assert.equal(old.json().code, "godot-open");
  assert.match(old.json().error, /0\.1\.2/);
  await open.app.close();
  // Addon 0.1.2: the moves go into the open scene, and the file is not touched.
  const sent: Array<Record<string, unknown>> = [];
  const live = await setup(true, async (cmd, args) => { sent.push({ cmd, ...args }); return { written: 1, missing: [], conflicts: [] }; });
  const r = (await live.app.inject({ method: "POST", url: "/api/godot/scene", payload: { project: live.dir, scene: "res://levels/a.tscn", changes: [move()] } })).json();
  assert.equal(r.inEditor, true);
  assert.equal(sent[0]!.cmd, "standin_moves");
  assert.equal(sent[0]!.scene, "res://levels/a.tscn");
  assert.equal(await readFile(join(live.dir, "levels", "a.tscn"), "utf8"), SCENE);
  await live.app.close();
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

test("scenes placed in the scene come along (inner, not saved), and the models it uses can be fetched", async () => {
  const { app, dir } = await setup();
  await writeFile(join(dir, "door.tscn"), `[gd_scene format=3]\n\n[sub_resource type="BoxMesh" id="b"]\nsize = Vector3(1, 2, 0.1)\n\n[node name="Door" type="MeshInstance3D"]\nmesh = SubResource("b")\n\n[node name="Handle" type="Node3D" parent="."]\n`);
  await writeFile(join(dir, "levels", "b.tscn"), `[gd_scene format=3]\n\n[ext_resource type="PackedScene" path="res://door.tscn" id="1"]\n\n[node name="L" type="Node3D"]\n\n[node name="Door1" parent="." instance=ExtResource("1")]\n`);
  await writeFile(join(dir, "tree.glb"), "glTF....");
  const r = (await app.inject({ url: `/api/godot/scene?project=${encodeURIComponent(dir)}&scene=res://levels/b.tscn` })).json();
  assert.deepEqual(r.nodes.map((n: { path: string; inner?: boolean }) => [n.path, !!n.inner]), [[".", false], ["Door1", false], ["Door1/Handle", true]]);
  assert.deepEqual(r.nodes[1].shape, { kind: "box", size: [1, 2, 0.1] });
  const a = await app.inject({ url: `/api/godot/asset?project=${encodeURIComponent(dir)}&path=res://tree.glb` });
  assert.equal(a.statusCode, 200);
  assert.equal(a.headers["content-type"], "model/gltf-binary");
  assert.equal((await app.inject({ url: `/api/godot/asset?project=${encodeURIComponent(dir)}&path=res://project.godot` })).statusCode, 400);
  await app.close();
});
