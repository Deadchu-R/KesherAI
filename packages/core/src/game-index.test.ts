import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetGroup, definitionsOf, gameFindTool, searchGameProject, searchWords } from "./game-index.js";
import type { GameProject } from "./game-projects.js";
import { build, doorSpec } from "./uasset-fake.test.js";
import { unrealAssetView } from "./routes/game-inspector.js";
import { readUassetFile } from "./uasset.js";

/** A small Unity project: a script, a prefab, a scene and a material (and Library junk that must not show). */
async function unityProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kesher-gidx-"));
  await mkdir(join(root, "Assets", "Scripts"), { recursive: true });
  await mkdir(join(root, "Assets", "Prefabs"), { recursive: true });
  await mkdir(join(root, "Library"), { recursive: true });
  await writeFile(join(root, "Assets", "Scripts", "PlayerHealth.cs"), "public class PlayerHealth : MonoBehaviour {\n  public void TakeDamage(int n) {}\n}\n");
  await writeFile(join(root, "Assets", "Prefabs", "Enemy.prefab"), "%YAML");
  await writeFile(join(root, "Assets", "Main.unity"), "%YAML");
  await writeFile(join(root, "Assets", "Wood.mat"), "%YAML");
  await writeFile(join(root, "Library", "Junk.cs"), "public class Junk {}\n");
  return root;
}

test("search words: Hebrew kind words become the English ones", () => {
  assert.deepEqual(searchWords("הסצנה הראשית"), ["scene", "הראשית"]);
  assert.deepEqual(searchWords("BP_Door בלופרינט"), ["bp_door", "blueprint"]);
  assert.equal(assetGroup("level"), "scene");
  assert.equal(assetGroup("Blueprint"), "prefab");
  assert.equal(assetGroup("material"), "asset");
});

test("a project search finds symbols with lines, scripts, prefabs and scenes, and skips Library", async () => {
  const root = await unityProject();
  const r = await searchGameProject(root, "damage");
  assert.deepEqual(r.hits.map((h) => [h.kind, h.name, h.line]), [["code", "TakeDamage", 2]]);
  const health = await searchGameProject(root, "PlayerHealth");
  assert.equal(health.hits[0]!.kind, "code");
  assert.ok(health.hits.some((h) => h.kind === "script" && h.path === "Assets/Scripts/PlayerHealth.cs"));
  assert.deepEqual((await searchGameProject(root, "enemy")).hits.map((h) => h.kind), ["prefab"]);
  assert.deepEqual((await searchGameProject(root, "סצנה")).hits.map((h) => h.name), ["Main"]);
  assert.equal((await searchGameProject(root, "junk")).hits.length, 0);
  const counts = await searchGameProject(root, "");
  assert.deepEqual(counts.counts, { code: 2, script: 1, scene: 1, prefab: 1, asset: 1 });
  assert.deepEqual((await searchGameProject(root, "wood", { kind: "prefab" })).hits, []);
});

test("definitions by name, also A::B", async () => {
  const root = await unityProject();
  assert.deepEqual(await definitionsOf(root, "UPlayer::TakeDamage"), [{ path: "Assets/Scripts/PlayerHealth.cs", line: 2, symbol: "TakeDamage()" }]);
  assert.deepEqual(await definitionsOf(root, "Nope"), []);
});

test("game_find searches the named project and says which ones exist", async () => {
  const root = await unityProject();
  const projects: GameProject[] = [{ kind: "unity", name: "Shooter", path: root }];
  const tool = gameFindTool(async () => projects, () => undefined);
  const out = (await tool.run({ query: "enemy", project: "shooter" }, {} as never)).output;
  assert.match(String(out), /## Shooter \(unity\)\nprefab\s+Enemy \(prefab\)\s+Assets\/Prefabs\/Enemy\.prefab/);
  assert.match(String((await tool.run({ project: "Other" }, {} as never)).output), /No project named "Other"\. Projects: Shooter \(unity\)/);
  assert.match(String((await tool.run({}, {} as never)).output), /1 scripts, 2 classes\/functions, 1 scenes\/levels, 1 prefabs\/Blueprints, 1 other assets/);
});

/** A small Unreal project: a Blueprint without the BP_ prefix (Gate, extends Actor), the mesh it uses, a level. */
async function unrealProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kesher-gidx-"));
  for (const d of ["BP", "Props", "Maps"]) await mkdir(join(root, "Content", d), { recursive: true });
  await writeFile(join(root, "Game.uproject"), "{}");
  await writeFile(join(root, "Content", "BP", "Gate.uasset"), build(doorSpec(-8, 522, 1010)));
  const mesh = { legacy: -8, ue4: 522, ue5: 1010, names: ["/Script/Engine", "Package", "Class", "StaticMesh", "SM_Door"], imports: [[0, 1, 0, 0], [0, 2, -1, 3]] as Array<[number, number, number, number]>, exports: [[-2, 0, 0, 4, true]] as Array<[number, number, number, number, boolean]> };
  await writeFile(join(root, "Content", "Props", "SM_Door.uasset"), build(mesh));
  await writeFile(join(root, "Content", "Maps", "Broken.umap"), "not a package");
  return root;
}

test("Unreal packages get their class and parent from their headers, and who uses them", async () => {
  const root = await unrealProject();
  const gate = await searchGameProject(root, "gate");
  assert.deepEqual(gate.hits.map((h) => [h.kind, h.detail]), [["prefab", "Blueprint · Actor"]]);
  // The parent is searchable too; a broken file keeps its name-based kind.
  assert.deepEqual((await searchGameProject(root, "actor")).hits.map((h) => h.name), ["Gate"]);
  assert.deepEqual((await searchGameProject(root, "broken")).hits.map((h) => h.detail), ["level"]);
  const tool = gameFindTool(async () => [{ kind: "unreal", name: "Game", path: root }], () => undefined);
  const out = String((await tool.run({ query: "SM_Door" }, {} as never)).output);
  assert.match(out, /\/Game\/Props\/SM_Door: StaticMesh/);
  assert.match(out, /used by: Content\/BP\/Gate/);
  const view = await unrealAssetView(root, "Content/BP/Gate.uasset", await readUassetFile(join(root, "Content", "BP", "Gate.uasset")));
  assert.equal(view.className, "Blueprint");
  assert.equal(view.parent, "Actor");
  assert.deepEqual(view.uses, [{ package: "/Game/Props/SM_Door", path: "Content/Props/SM_Door.uasset" }]);
  assert.deepEqual(view.soft, [{ package: "/Game/Audio/S_Creak" }]);
  assert.deepEqual(view.engineUses, ["/Script/Engine"]);
  const meshView = await unrealAssetView(root, "Content/Props/SM_Door.uasset", await readUassetFile(join(root, "Content", "Props", "SM_Door.uasset")));
  assert.deepEqual(meshView.usedBy, [{ path: "Content/BP/Gate.uasset", soft: false }]);
  assert.equal(meshView.usedByComplete, true);
});
