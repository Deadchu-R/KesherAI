import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guestEngineProjects, guestPathPrivate, guestProjectFolder } from "./guest-scenes.js";
import { canSymlink } from "./test-utils.js";

async function shared() {
  const root = await mkdtemp(join(tmpdir(), "kesher-guest-scenes-"));
  const ws = join(root, "ws");
  await mkdir(join(ws, "games", "level"), { recursive: true });
  await writeFile(join(ws, "games", "level", "project.godot"), "");
  await mkdir(join(ws, "city", "Assets"), { recursive: true });
  await mkdir(join(ws, "city", "ProjectSettings"));
  await mkdir(join(ws, ".git", "x"), { recursive: true });
  await writeFile(join(ws, ".git", "x", "project.godot"), "");
  await mkdir(join(ws, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(ws, "node_modules", "pkg", "project.godot"), "");
  // A project outside the shared folder, and a link to it from inside.
  await mkdir(join(root, "private"));
  await writeFile(join(root, "private", "project.godot"), "");
  if (await canSymlink()) await symlink(join(root, "private"), join(ws, "escape"));
  return { root, ws };
}

test("the engine projects in the shared folder: Godot and Unity, never hidden folders or build output", async () => {
  const { ws } = await shared();
  const found = await guestEngineProjects(ws);
  assert.deepEqual(found.filter((p) => p.project !== "escape").sort((a, b) => a.project.localeCompare(b.project)), [
    { engine: "unity", project: "city" },
    { engine: "godot", project: "games/level" },
  ]);
});

test("a guest's project path: only inside the shared folder, after links; 403 for anything outside", async () => {
  const { ws } = await shared();
  assert.match(await guestProjectFolder(ws, "games/level"), /games[\\/]level$/);
  assert.match(await guestProjectFolder(ws, "games\\level"), /games[\\/]level$/);
  for (const bad of ["../private", "/etc", "C:/Windows", "games/../../private", ".git/x", "escape", "", "a\0b"]) {
    await assert.rejects(guestProjectFolder(ws, bad), (e: { statusCode?: number }) => e.statusCode === 403 || e.statusCode === 404, bad);
  }
  await assert.rejects(guestProjectFolder(ws, "escape"), (e: { statusCode?: number }) => e.statusCode === 403);
  await assert.rejects(guestProjectFolder(ws, "../private"), (e: { statusCode?: number }) => e.statusCode === 403);
  await assert.rejects(guestProjectFolder(ws, "nope"), (e: { statusCode?: number }) => e.statusCode === 404);
});

test("private files are never a guest's, by their path", () => {
  assert.equal(guestPathPrivate("res://models/crate.glb"), false);
  assert.equal(guestPathPrivate("Assets/Models/Car.fbx"), false);
  for (const p of ["res://.env", "Assets/keys/server.pem", "res://.git/x.png", "Assets/../secret.png", "res://a/credentials.json"]) assert.equal(guestPathPrivate(p), true, p);
});
