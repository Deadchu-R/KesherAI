import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetGroup, definitionsOf, gameFindTool, searchGameProject, searchWords } from "./game-index.js";
import type { GameProject } from "./game-projects.js";

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
