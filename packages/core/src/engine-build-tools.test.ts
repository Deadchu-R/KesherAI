import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseScenePreview } from "@kesher/shared";
import { blockoutDiff, parseBlockout, parseVfx, unityBlockoutCs, unityBuildTools, unityVfxCs, unrealSpawnActors, vfxBudgetNote, type Blockout, type VfxSpec } from "./engine-build-tools.js";

test("a block-out plan turns grid cells into placed shapes", () => {
  const plan = parseBlockout({ cell: 2, items: [{ shape: "floor", cell: [0, 0], span: [4, 3] }, { shape: "wall", cell: [0, 0], span: [4, 1] }, { shape: "wall", cell: [0, 0], span: [1, 3], height: 4 }, { shape: "ramp", cell: [2, 0], span: [1, 2], height: 2, elevation: 0 }], lights: [{ type: "directional" }], navmesh: true }, "unity") as Blockout;
  assert.equal(typeof plan, "object");
  const [floor, wallX, wallZ, ramp] = plan.blocks;
  assert.deepEqual(floor!.center, [4, -0.1, 3]);
  assert.deepEqual(floor!.size, [8, 0.2, 6]);
  assert.deepEqual(wallX!.size, [8, 3, 0.2], "a wall runs along its longer span");
  assert.deepEqual(wallZ!.size, [0.2, 4, 6]);
  assert.equal(wallZ!.center[1], 2);
  // A ramp rising 2 m over 4 m: 26.565°, its length the hypotenuse.
  assert.equal(ramp!.pitch, 26.565);
  assert.equal(ramp!.size[2], 4.472);
  assert.equal(plan.lights[0]!.name, "Sun");
  // Bounds use each shape's box before its tilt (a little larger for a ramp), padded 2 m around, 1 m below and 3 m above.
  assert.deepEqual(plan.navmesh, { min: [-2, -1.2, -2.236], max: [10, 7, 8] });
});

test("block-out input is checked", () => {
  assert.match(parseBlockout({}, "unity") as string, /Give items/);
  assert.match(parseBlockout({ items: [{ shape: "tree", cell: [0, 0] }] }, "unity") as string, /shape is one of/);
  assert.match(parseBlockout({ items: [{ shape: "prefab", cell: [0, 0], asset: "/Game/BP_Crate" }] }, "unity") as string, /Assets\//);
  assert.match(parseBlockout({ items: [{ shape: "prefab", cell: [0, 0], asset: "Assets/../x.prefab" }] }, "unity") as string, /Assets\//);
  assert.match(parseBlockout({ items: [{ shape: "cube", cell: [0, 0] }] }, "unreal") as string, /level/);
  assert.match(parseBlockout({ level: "/Game/../x", items: [{ shape: "cube", cell: [0, 0] }] }, "unreal") as string, /level/);
  assert.match(parseBlockout({ items: Array.from({ length: 201 }, () => ({ shape: "cube", cell: [0, 0] })) }, "unity") as string, /At most 200/);
});

test("the approval card lists every object a block-out adds", () => {
  const plan = parseBlockout({ items: [{ shape: "cube", cell: [1, 1], name: "Cover" }], lights: [{ type: "point", cell: [0, 0] }], navmesh: true }, "unity") as Blockout;
  const diff = blockoutDiff("unity", plan, "undo");
  assert.deepEqual(diff.objects.map((o) => [o.kind, o.name, o.type]), [["added", "Blockout/Cover", "cube"], ["added", "Blockout/point_light_1", "point light"], ["added", "Blockout/NavMesh", "NavMeshSurface"]]);
});

test("Unity C#: one Undo group, prefabs by path, the navmesh by reflection", () => {
  const plan = parseBlockout({ items: [{ shape: "cylinder", cell: [0, 0], height: 4 }, { shape: "prefab", cell: [1, 0], asset: "Assets/Prefabs/Crate.prefab" }], navmesh: true }, "unity") as Blockout;
  const cs = unityBlockoutCs(plan);
  assert.match(cs, /CollapseUndoOperations\(group\)/);
  assert.match(cs, /PrimitiveType\.Cylinder/);
  assert.match(cs, /localScale = new UnityEngine\.Vector3\(2f, 2f, 2f\)/, "Unity's cylinder is 2 m high");
  assert.match(cs, /LoadAssetAtPath<UnityEngine\.GameObject>\("Assets\/Prefabs\/Crate\.prefab"\)/);
  assert.match(cs, /Unity\.AI\.Navigation\.NavMeshSurface, Unity\.AI\.Navigation/);
});

test("Unreal actors: centimeters, X forward = grid z, Y right = grid x, Z up", () => {
  const plan = parseBlockout({ level: "/Game/Maps/Arena", cell: 1, items: [{ shape: "cube", cell: [2, 5], span: [2, 1], height: 3 }, { shape: "prefab", cell: [0, 0], asset: "/Game/BP_Crate" }], lights: [{ type: "spot", cell: [0, 0], pitch: 40 }], navmesh: true }, "unreal") as Blockout;
  const actors = unrealSpawnActors(plan);
  assert.deepEqual(actors[0], { op: "spawn", name: "cube_1", mesh: "/Engine/BasicShapes/Cube.Cube", folder: "Blockout", location: [550, 300, 150], rotation: [0, 0, 0], scale: [1, 2, 3] });
  assert.equal(actors[1]!.asset, "/Game/BP_Crate");
  assert.equal(actors[2]!.class, "/Script/Engine.SpotLight");
  assert.equal(actors[2]!.rotation[0], -40, "a light points down with a negative pitch");
  assert.equal(actors[3]!.class, "/Script/NavigationSystem.NavMeshBoundsVolume");
});

test("effects: a preset, the numbers that differ, and tuning only what changes", () => {
  const s = parseVfx({ preset: "fire", name: "Camp fire", rate: 90, color: "#FF8800" }) as VfxSpec;
  assert.equal(s.name, "Camp_fire");
  assert.equal(s.rate, 90);
  assert.equal(s.color, "#ff8800");
  assert.equal(s.lifetime, 1.2, "the preset's number stays");
  assert.deepEqual(parseVfx({ size: 2 }, true), { size: 2 });
  assert.match(parseVfx({ preset: "lava" }) as string, /preset is one of/);
  assert.match(parseVfx({ preset: "fire", color: "red" }) as string, /#rrggbb/);
  assert.match(parseVfx({}, true) as string, /Give the numbers/);
  assert.equal(vfxBudgetNote({ rate: 60, lifetime: 1.2, max: 300 }), "");
  assert.match(vfxBudgetNote({ rate: 400, lifetime: 2, max: 2000 }), /800 live particles/);
  const cs = unityVfxCs(s);
  assert.match(cs, /rateOverTime = 90f/);
  assert.match(cs, /ParticlesUnlit\.mat/);
});

test("unity_vfx queues the spec when Unity is closed, and the card shows the effect", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-vfx-"));
  try {
    const [, vfx] = unityBuildTools({ project: () => dir, need: () => undefined, evalCs: async () => "Unity did not run it: no editor (is the Editor open and ready? unity_status)" });
    const input = { action: "create", preset: "sparks", name: "Hit" };
    const card = parseScenePreview(String(await vfx!.preview!(input)));
    assert.equal(card?.diff.objects[0]?.name, "Hit");
    const r = await vfx!.run(input, { signal: new AbortController().signal, recordChange: () => undefined });
    assert.match(r.output, /queued in KesherAI\/pending-vfx/);
    const saved = JSON.parse(await readFile(join(dir, "KesherAI", "pending-vfx", "Hit.json"), "utf8"));
    assert.equal(saved.preset, "sparks");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
