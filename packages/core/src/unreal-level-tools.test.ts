import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseScenePreview } from "@kesher/shared";
import { opsSummary, unrealLevelFile } from "./game-sync.js";
import type { UnrealBridge } from "./unreal-bridge.js";
import { actorLine, levelFromHeader, levelsOnDisk, quatToRotator, unrealLevelTools, type LevelRead } from "./unreal-level-tools.js";

const ctx = {} as never;

test("rotations read as Unreal's pitch, yaw, roll", () => {
  assert.deepEqual(quatToRotator([0, 0, 0, 1]), [0, 0, 0]);
  const s = Math.SQRT1_2;
  assert.deepEqual(quatToRotator([0, 0, s, s]), [0, 90, 0]);
  // Unreal's quaternions turn the other way round X: +X quarter turn is a roll of -90 (FRotator(0, 0, -90)).
  assert.deepEqual(quatToRotator([s, 0, 0, s]), [0, 0, -90]);
  // A pitch of 30: Y = -sin(15°).
  assert.deepEqual(quatToRotator([0, -Math.sin(Math.PI / 12), 0, Math.cos(Math.PI / 12)]), [30, 0, 0]);
});

test("an actor line names its place, mesh and slots", () => {
  const line = actorLine({ id: "StaticMeshActor_3", name: "Crate", class: "StaticMeshActor", position: [100, 0, 50.04], rotation: [0, 0, 0, 1], scale: [2, 2, 2], mesh: "/Game/SM_Crate.SM_Crate", slots: [{ component: "StaticMeshComponent0", materials: [{ slot: "Body", material: "/Game/M_Wood.M_Wood" }] }] });
  assert.equal(line, "Crate [StaticMeshActor_3] StaticMeshActor at (100, 0, 50) scale (2, 2, 2) — mesh SM_Crate\n    StaticMeshComponent0: Body=/Game/M_Wood.M_Wood");
});

test("the .umap header gives the actors, their components and the materials used", () => {
  const exp = (className: string, objectName: string, outer: number) => ({ className, objectName, outer, serialSize: 1, isAsset: false });
  const got = levelFromHeader({
    exports: [exp("World", "Arena", 0), exp("Level", "PersistentLevel", 1), exp("WorldSettings", "WorldSettings", 2), exp("StaticMeshActor", "StaticMeshActor_3", 2), exp("StaticMeshComponent", "StaticMeshComponent0", 4), exp("Model", "Model_0", 2)],
    imports: [{ classPackage: "/Script/CoreUObject", className: "Package", objectName: "/Game/M_Wood", outer: 0 }, { classPackage: "/Script/Engine", className: "Material", objectName: "M_Wood", outer: -1 }],
  });
  assert.deepEqual(got, { actors: [{ id: "StaticMeshActor_3", name: "StaticMeshActor_3", class: "StaticMeshActor", components: ["StaticMeshComponent"] }], materials: ["/Game/M_Wood.M_Wood"] });
});

test("levels on disk, without World Partition's actor files; level and sync file names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-ue-"));
  try {
    await mkdir(join(dir, "Content", "Maps"), { recursive: true });
    await mkdir(join(dir, "Content", "__ExternalActors__", "Maps", "Arena"), { recursive: true });
    await writeFile(join(dir, "Content", "Maps", "Arena.umap"), "");
    await writeFile(join(dir, "Content", "__ExternalActors__", "Maps", "Arena", "X.umap"), "");
    assert.deepEqual(await levelsOnDisk(dir), ["/Game/Maps/Arena"]);
    assert.equal(unrealLevelFile(dir, "/Game/Maps/Arena"), join(dir, "Content", "Maps", "Arena.umap"));
    assert.equal(unrealLevelFile(dir, "/Game/../x"), undefined);
    assert.deepEqual(opsSummary([{ op: "material", actor: "Crate", slot: "0", material: "/Game/M/MI_Glass" }]), ["◧ Crate [0]: MI_Glass"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A bridge with the editor open or closed, recording what it was asked. */
function fakeBridge(connected: boolean, seen: unknown[]) {
  const level: LevelRead = { path: "/Game/Maps/Arena", actors: [{ id: "SMA_3", name: "Crate", class: "StaticMeshActor", slots: [{ component: "StaticMeshComponent0", materials: [{ slot: "Body", material: "/Game/M_Wood.M_Wood" }] }] }] };
  return {
    connected,
    available: true,
    standIn: async () => level,
    keptStandIn: async () => (connected ? undefined : level),
    applyMaterial: async (path: string, args: unknown) => (seen.push({ path, args }), { actor: "Crate", component: "StaticMeshComponent0", slot: 0, from: "/Game/M_Wood.M_Wood", to: "/Game/MI_Glass.MI_Glass", saved: false }),
    project: async () => "Arena",
    enqueue: async (e: unknown) => (seen.push(e), e),
    scheduleSync: () => seen.push("sync"),
  } as unknown as UnrealBridge;
}

test("apply_material: the card shows old → new; open = one undo step, closed = queued for the sync", async () => {
  for (const connected of [true, false]) {
    const seen: unknown[] = [];
    const [, apply] = unrealLevelTools({ bridge: fakeBridge(connected, seen), projectDir: () => undefined });
    const input = { level: "/Game/Maps/Arena", actor: "Crate", material: "/Game/MI_Glass", slot: "Body" };
    const card = parseScenePreview(await apply!.preview!(input, ctx))!.diff;
    assert.deepEqual(card.objects[0]!.props, [{ name: "StaticMeshComponent0 slot Body", from: "/Game/M_Wood.M_Wood", to: "/Game/MI_Glass" }]);
    assert.equal(card.undo, connected ? "undo" : "queued");
    const out = (await apply!.run(input, ctx)).output;
    if (connected) {
      assert.match(out, /M_Wood\.M_Wood → \/Game\/MI_Glass\.MI_Glass \(one undo step/);
      assert.deepEqual(seen, [{ path: "/Game/Maps/Arena", args: { actor: "Crate", component: "", slot: "Body", material: "/Game/MI_Glass" } }]);
    } else {
      assert.match(out, /^Queued/);
      assert.equal((seen[0] as { kind: string }).kind, "material");
      assert.deepEqual((seen[0] as { ops: unknown[] }).ops, [{ op: "material", actor: "Crate", component: "", slot: "Body", material: "/Game/MI_Glass" }]);
      assert.equal(seen[1], "sync");
    }
  }
});

test("apply_material refuses paths outside /Game and /Engine", async () => {
  const [, apply] = unrealLevelTools({ bridge: fakeBridge(true, []), projectDir: () => undefined });
  assert.match((await apply!.run({ level: "C:/x", actor: "A", material: "/Game/M" }, ctx)).output, /^level is/);
  assert.match((await apply!.run({ level: "/Game/A", actor: "A", material: "/Script/../M" }, ctx)).output, /^material is/);
});
