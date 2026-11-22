import assert from "node:assert/strict";
import { test } from "node:test";
import { parseScenePreview } from "@kesher/shared";
import { groupOfTool, groupsByWords } from "./chat-tool-groups.js";
import { levelDesignTools, levelDiff, levelWrites, loadLevel, planArrange, planMove, turnQuat, unityMoves, unityLevelObjects, unrealMoves, unrealLevelObjects, type LevelDesignDeps, type LoadedLevel, type UnityMoveOut } from "./level-design-tools.js";
import type { UnityObject } from "./unity-scene.js";
import type { LevelActor } from "./unreal-level-tools.js";

const ctx = {} as never;
const unityObj = (id: string, name: string, x: number, z: number, o: Partial<UnityObject> = {}): UnityObject => ({ id, name, parent: "0", position: [x, 0.5, z], rotation: [0, 0, 0, 1], scale: [1, 1, 1], look: { builtin: "cube" }, ...o });
const sceneObjects = (): UnityObject[] => [
  unityObj("1", "Ground", 0, 0, { look: { builtin: "plane" }, position: [0, 0, 0], scale: [4, 1, 4] }),
  ...Array.from({ length: 4 }, (_, i) => unityObj(String(10 + i), `Crate (${i})`, 30 + i, 30)),
  unityObj("20", "Inside", 0, 0, { parent: "10", readOnly: "prefab" }),
];

function unityDeps(queued: Array<{ scene: string; moves: UnityMoveOut[] }>): LevelDesignDeps {
  return {
    unityProject: () => "/p",
    unrealProjectDir: () => undefined,
    readUnity: async () => ({ objects: sceneObjects() }),
    unityScenes: async () => ["Assets/Main.unity"],
    queueUnity: async (_p, scene, moves) => { queued.push({ scene, moves }); return { queued: moves.length, waiting: moves.length }; },
  };
}

test("level requests in Hebrew and English go to the level group", () => {
  for (const t of ["level_describe", "level_arrange", "level_move", "level_check"]) assert.equal(groupOfTool(t), "level");
  assert.ok(groupsByWords("סדר לי עצים לאורך הדרך").includes("level"));
  assert.ok(groupsByWords("place 10 crates in a grid").includes("level"));
  assert.ok(groupsByWords("תפזר סלעים בשלב").includes("level"));
  assert.ok(groupsByWords("check for overlapping objects").includes("level"));
  assert.ok(!groupsByWords("תצייר לי חתול").includes("level"));
});

test("Unity: a grid of crates becomes pending moves in the package's shape, one per crate", async () => {
  const queued: Array<{ scene: string; moves: UnityMoveOut[] }> = [];
  const arrange = levelDesignTools(unityDeps(queued)).find((t) => t.spec.name === "level_arrange")!;
  const input = { source: "Crate", count: 4, pattern: "grid", columns: 2, spacing: 3, center: [0, 0], yaw: 90 };
  const out = await arrange.run(input, ctx);
  assert.match(out.output, /Queued 4 moves for Assets\/Main.unity/);
  const [q] = queued;
  assert.equal(q!.scene, "Assets/Main.unity");
  assert.deepEqual(q!.moves.map((m) => m.id), ["10", "11", "12", "13"]);
  const m = q!.moves[0]!;
  assert.deepEqual(m.to.position, [-1.5, 0.5, -1.5]);
  assert.deepEqual(m.from.position, [30, 0.5, 30]);
  assert.ok(Math.abs(m.to.rotation[1]! - Math.SQRT1_2) < 1e-5 && Math.abs(m.to.rotation[3]! - Math.SQRT1_2) < 1e-5);
  assert.equal(m.to.rotation.length, 4);
  assert.equal(m.to.scale.length, 3);
});

test("Unity: asking for more copies than exist moves those and says what is needed", async () => {
  const level = (await loadLevel(unityDeps([]), { engine: "unity", scene: "Assets/Main.unity" })) as LoadedLevel;
  const plan = planArrange(level, { source: "Crate", count: 6, pattern: "line", from: [0, 0], to: [10, 0] });
  assert.ok(typeof plan !== "string");
  if (typeof plan === "string") return;
  assert.equal(plan.edits.length, 4);
  assert.equal(plan.spawns.length, 0);
  assert.match(plan.notes.join(" "), /2 more copies are needed/);
  assert.match(String(planArrange(level, { source: "Nothing", count: 2 })), /No object named/);
  assert.match(String(planArrange(level, { source: "Inside", count: 1 })), /part of something else/);
  assert.match(String(planArrange(level, { source: "Crate", count: 0 })), /count is how many/);
});

test("the approval preview carries the list and a top-down plan, and survives the card's parser", async () => {
  const level = (await loadLevel(unityDeps([]), { engine: "unity", scene: "Assets/Main.unity" })) as LoadedLevel;
  const plan = planMove(level, { objects: [{ name: "Crate (1)", offset: [1, 0, 0], rotate: 45 }, { name: "Crate (2)", position: [5, 0.5, 5] }] });
  assert.ok(typeof plan !== "string");
  if (typeof plan === "string") return;
  const parsed = parseScenePreview((await levelDesignTools(unityDeps([])).find((t) => t.spec.name === "level_move")!.preview!({ objects: [{ name: "Crate (1)", offset: [1, 0, 0], rotate: 45 }] }, ctx)));
  assert.ok(parsed);
  assert.equal(parsed!.diff.plan?.moved, 1);
  assert.deepEqual(parsed!.diff.plan?.before, [[31, 30]]);
  assert.deepEqual(parsed!.diff.plan?.after, [[32, 30]]);
  assert.equal(parsed!.diff.objects[0]!.props?.length, 2);
  const diff = levelDiff(level, plan, "checkpoint");
  assert.equal(diff.plan!.moved, 2);
  assert.ok(diff.plan!.rest.length >= 2);
  assert.ok(JSON.stringify(diff).length < 6000);
});

test("level_move refuses what cannot be moved and names the problem", async () => {
  const level = (await loadLevel(unityDeps([]), { engine: "unity", scene: "Assets/Main.unity" })) as LoadedLevel;
  assert.match(String(planMove(level, { objects: [{ name: "Inside", offset: [1, 0, 0] }] })), /cannot be moved/);
  assert.match(String(planMove(level, { objects: [{ name: "Crate", offset: [1, 0, 0] }] })), /names 4 objects/);
  assert.ok(typeof planMove(level, { objects: [{ name: "Crate", offset: [1, 0, 0], all: true }] }) !== "string");
  assert.match(String(planMove(level, { objects: [] })), /objects is a list/);
});

test("turning a quaternion about the up axis", () => {
  const q = turnQuat([0, 0, 0, 1], 90, 1);
  assert.ok(Math.abs(q[1]! - Math.SQRT1_2) < 1e-5);
  const z = turnQuat([0, 0, 0, 1], 90, 2);
  assert.ok(Math.abs(z[2]! - Math.SQRT1_2) < 1e-5);
  assert.deepEqual(turnQuat([0, 0, 0, 1], 0, 1), [0, 0, 0, 1]);
});

const actor = (id: string, x: number, y: number, z: number, o: Partial<LevelActor> = {}): LevelActor => ({ id, name: id, class: "StaticMeshActor", position: [x, y, z], rotation: [0, 0, 0, 1], scale: [1, 1, 1], mesh: "/Game/Props/SM_Crate.SM_Crate", ...o });
function unrealLevel(): LoadedLevel {
  const actors = [actor("Floor", 0, 0, -10, { scale: [40, 40, 0.2], mesh: "/Engine/BasicShapes/Cube.Cube" }), actor("Crate_1", 5000, 3000, 50), actor("Crate_2", 5100, 3000, 50)];
  return { engine: "unreal", scene: "/Game/Maps/Arena", objects: unrealLevelObjects(actors), actors: new Map(actors.map((a) => [a.id, a])), live: false };
}

test("Unreal: the cm and X-forward world maps to meters and back; moves keep the bridge's shape", () => {
  const level = unrealLevel();
  const crate = level.objects.find((o) => o.id === "Crate_1")!;
  assert.deepEqual(crate.pos, [30, 0.5, 50]);
  assert.equal(level.objects.find((o) => o.id === "Floor")!.ground, true);
  const moves = unrealMoves(level, [{ object: crate, pos: [0, 0.5, 10], yawDelta: 90, scaleMul: 2 }]);
  assert.deepEqual(moves[0]!.to.position, [1000, 0, 50]);
  assert.deepEqual(moves[0]!.from.position, [5000, 3000, 50]);
  assert.equal(moves[0]!.to.rotation.length, 4);
  assert.ok(Math.abs(moves[0]!.to.rotation[2]! - Math.SQRT1_2) < 1e-5);
  assert.deepEqual(moves[0]!.to.scale, [2, 2, 2]);
  assert.match(moves[0]!.id, /^[\w.-]{1,200}$/);
});

test("Unreal: missing copies are spawned from the source's mesh, in cm, in a KesherLevel folder", () => {
  const plan = planArrange(unrealLevel(), { source: "Crate", count: 4, pattern: "line", from: [0, 0], to: [9, 0] });
  assert.ok(typeof plan !== "string");
  if (typeof plan === "string") return;
  assert.equal(plan.edits.length, 2);
  assert.equal(plan.spawns.length, 2);
  const s = plan.spawns[0]!;
  assert.deepEqual([s.op, s.asset, s.folder], ["spawn", "/Game/Props/SM_Crate.SM_Crate", "KesherLevel"]);
  assert.deepEqual(s.location, [0, 600, 50]);
  const fromAsset = planArrange(unrealLevel(), { source: "/Engine/BasicShapes/Cube.Cube", count: 2, pattern: "grid", center: [0, 0] });
  assert.ok(typeof fromAsset !== "string" && fromAsset.spawns.length === 2 && fromAsset.spawns[0]!.mesh === "/Engine/BasicShapes/Cube.Cube");
  // The diff lists the new copies as added.
  const diff = levelDiff(unrealLevel(), plan, "queued");
  assert.deepEqual(diff.objects.map((o) => o.kind), ["changed", "changed", "added", "added"]);
  assert.equal(diff.plan!.after.length, 4);
});

test("Unreal with the editor closed queues the spawns and moves the existing crates through the bridge", async () => {
  const calls: string[] = [];
  const level = unrealLevel();
  const bridge = {
    connected: false, available: true,
    keptStandIn: async () => ({ path: "/Game/Maps/Arena", actors: [...level.actors!.values()] }),
    standIn: async () => { throw new Error("no"); },
    moveActors: async (_p: string, m: unknown[]) => { calls.push(`move ${m.length}`); return { moved: m.length, clashes: [], missing: [], saved: true }; },
    request: async () => { throw new Error("closed"); },
    enqueue: async (e: { kind?: string; ops: unknown[] }) => { calls.push(`enqueue ${e.kind} ${e.ops.length}`); return {} as never; },
    project: async () => "Arena",
    scheduleSync: () => { calls.push("sync"); },
  };
  const tool = levelDesignTools({ unityProject: () => undefined, unrealProjectDir: () => "/u", bridge: bridge as never, unrealLevels: async () => ["/Game/Maps/Arena"] }).find((t) => t.spec.name === "level_arrange")!;
  const out = await tool.run({ source: "Crate", count: 4, pattern: "grid", center: [0, 0] }, ctx);
  assert.deepEqual(calls, ["move 2", "enqueue spawn 2", "sync"]);
  assert.match(out.output, /2 moved/);
});

test("level_check and level_describe read a scene, and ask which scene when it is not clear", async () => {
  const tools = levelDesignTools(unityDeps([]));
  const check = await tools.find((t) => t.spec.name === "level_check")!.run({ scene: "Assets/Main.unity" }, ctx);
  assert.match(check.output, /Overlapping: none/);
  assert.match(check.output, /Outside the bounds \(4\)/);
  const describe = await tools.find((t) => t.spec.name === "level_describe")!.run({}, ctx);
  assert.match(describe.output, /^Unity scene Assets\/Main.unity: 6 objects/);
  const many = levelDesignTools({ ...unityDeps([]), unityScenes: async () => ["Assets/A.unity", "Assets/B.unity"] });
  assert.match((await many.find((t) => t.spec.name === "level_describe")!.run({}, ctx)).output, /^Which scene\? Assets\/A.unity, Assets\/B.unity/);
  const both = levelDesignTools({ ...unityDeps([]), unrealProjectDir: () => "/u" });
  assert.match((await both.find((t) => t.spec.name === "level_describe")!.run({}, ctx)).output, /Both a Unity and an Unreal/);
});

test("the turn's checkpoint keeps the scene and the waiting moves (Unity) or the level (Unreal)", () => {
  const lf = (dir: string, level: string) => `${dir}/Content${level.replace("/Game", "")}.umap`;
  assert.deepEqual(levelWrites({ scene: "Assets/Main.unity" }, { unity: "/p", unreal: "/u" }, lf), { engine: "unity", project: "/p", files: ["/p/Assets/Main.unity", "/p/KesherAI/pending-moves.json"] });
  assert.deepEqual(levelWrites({ scene: "/Game/Maps/Arena.Arena" }, { unity: "/p", unreal: "/u" }, lf), { engine: "unreal", project: "/u", files: ["/u/Content/Maps/Arena.umap"] });
  assert.equal(levelWrites({ scene: "Assets/../x.unity" }, { unity: "/p" }, lf), undefined);
  assert.equal(levelWrites({}, { unity: "/p", unreal: "/u" }, lf), undefined);
});

test("Unity objects: sizes, ground, movable and what is solid", () => {
  const objs = unityLevelObjects(sceneObjects());
  const ground = objs.find((o) => o.name === "Ground")!;
  assert.deepEqual([ground.ground, ground.size[0], ground.movable], [true, 40, true]);
  const inside = objs.find((o) => o.name === "Inside")!;
  assert.deepEqual([inside.solid, inside.movable, inside.parent], [false, false, "10"]);
  assert.equal(unityMoves({ engine: "unity", scene: "x", objects: objs, unity: new Map(sceneObjects().map((o) => [o.id, o])) }, [{ object: objs.find((o) => o.id === "10")!, pos: [1, 2, 3], yawDelta: 0, scaleMul: 1 }])[0]!.to.rotation.join(), "0,0,0,1");
});
