import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findGameProjects, findScripts } from "./game-projects.js";

test("Unity and Unreal projects on the computer are found for a chat", async () => {
  const home = await mkdtemp(join(tmpdir(), "kesher-home-"));
  const door = join(home, "Documents", "Unreal Projects", "DoorGame");
  await mkdir(door, { recursive: true });
  await writeFile(join(door, "DoorGame.uproject"), JSON.stringify({ EngineAssociation: "5.8" }));
  await mkdir(join(home, "Documents", "Unreal Projects", "NotAProject"), { recursive: true });
  const runner = join(home, "Work", "Runner");
  await mkdir(join(runner, "Assets"), { recursive: true });
  await mkdir(join(runner, "ProjectSettings"), { recursive: true });
  const hub = join(home, ".config", "UnityHub");
  await mkdir(hub, { recursive: true });
  const old = process.env.APPDATA;
  process.env.APPDATA = join(home, "nope");
  try {
    await writeFile(join(hub, "projects-v1.json"), JSON.stringify({ data: { [runner]: { path: runner, title: "Runner", version: "6000.3.1f1" }, gone: { path: join(home, "Gone"), title: "Gone" } } }));
    const found = await findGameProjects({ home });
    assert.deepEqual(found.map((p) => `${p.kind}:${p.name}:${p.engine ?? ""}`).sort(), ["unity:Runner:6000.3.1f1", "unreal:DoorGame:5.8"]);
  } finally {
    if (old === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = old;
  }
});

test("scripts are found by name in the chat's folders, skipping generated ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-scripts-"));
  await mkdir(join(root, "Assets", "Scripts"), { recursive: true });
  await mkdir(join(root, "Library", "PackageCache"), { recursive: true });
  await mkdir(join(root, "Source", "Door", "Private"), { recursive: true });
  await mkdir(join(root, "Intermediate"), { recursive: true });
  await writeFile(join(root, "Assets", "Scripts", "PlayerController.cs"), "class P {}");
  await writeFile(join(root, "Assets", "Scripts", "Enemy.cs"), "class E {}");
  await writeFile(join(root, "Library", "PackageCache", "Player.cs"), "generated");
  await writeFile(join(root, "Source", "Door", "Private", "Door.cpp"), "//");
  await writeFile(join(root, "Intermediate", "Door.gen.cpp"), "//");
  await writeFile(join(root, "Assets", "Scripts", "photo.png"), "x");
  const player = await findScripts([root], "player");
  assert.deepEqual(player.map((x) => x.rel), ["Assets/Scripts/PlayerController.cs"]);
  const door = await findScripts([root], "door");
  assert.deepEqual(door.map((x) => x.rel), ["Source/Door/Private/Door.cpp"]);
  const all = await findScripts([root], "");
  assert.equal(all.length, 3);
});

test("finds Unity projects Unity Hub does not list, two levels deep in the usual folders", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = await mkdtemp(join(tmpdir(), "home-"));
  const mk = async (p: string, version = "6000.6.8f1") => {
    await mkdir(join(p, "Assets"), { recursive: true });
    await mkdir(join(p, "ProjectSettings"), { recursive: true });
    await writeFile(join(p, "ProjectSettings", "ProjectVersion.txt"), `m_EditorVersion: ${version}\n`);
  };
  await mk(join(home, "source", "repos", "Tetris"));
  await mk(join(home, "Documents", "Games", "Racer"), "2022.3.40f1");
  await mk(join(home, "Documents", "a", "b", "TooDeep"));
  await mkdir(join(home, "source", "repos", "NotUnity", "Assets"), { recursive: true });
  const found = (await findGameProjects({ home })).filter((p) => p.kind === "unity");
  assert.deepEqual(found.map((p) => p.name).sort(), ["Racer", "Tetris"]);
  assert.equal(found.find((p) => p.name === "Racer")!.engine, "2022.3.40f1");
});
