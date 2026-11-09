import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkerFor, codeMap, problemsFrom, symbolsOf } from "./code-intel.js";

test("symbols for C#, C++ (Unreal) and TypeScript", () => {
  assert.deepEqual(symbolsOf("public class Player : MonoBehaviour {\n  private void Update() {\n    if (x) {}\n  }\n  public IEnumerator Jump(float h) {}\n}", ".cs"), ["class Player", "Update()", "Jump()"]);
  assert.deepEqual(symbolsOf("class MYGAME_API AEnemy : public ACharacter {\n};\nvoid AEnemy::Tick(float Dt)\n{", ".cpp"), ["class AEnemy", "AEnemy::Tick()"]);
  assert.deepEqual(symbolsOf("export class Journal {}\nexport function dayKey(t: number): string {\n", ".ts"), ["class Journal", "dayKey()"]);
});

test("the map skips Unity's Library and lists source files", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-map-"));
  await mkdir(join(root, "Assets", "Scripts"), { recursive: true });
  await mkdir(join(root, "Library"), { recursive: true });
  await writeFile(join(root, "Assets", "Scripts", "Player.cs"), "public class Player {}\n");
  await writeFile(join(root, "Library", "Junk.cs"), "public class Junk {}\n");
  const map = await codeMap(root);
  assert.match(map, /Assets\/Scripts\/Player\.cs: class Player/);
  assert.doesNotMatch(map, /Junk/);
});

test("picks the right checker and keeps only real problems", () => {
  assert.equal(checkerFor("/p", ["tsconfig.json", "package.json"])?.name, "TypeScript");
  assert.match(checkerFor("/p", ["MyGame.sln", "Assets"])!.command, /dotnet build "MyGame\.sln"/);
  assert.equal(checkerFor("/p", ["README.md"]), undefined);
  const out = "Build started\nAssets/Scripts/Player.cs(12,5): error CS1002: ; expected [MyGame.csproj]\nsrc/a.ts(3,1): error TS2304: Cannot find name 'x'.\nwarning: something general\n";
  const p = problemsFrom(out);
  assert.equal(p.errors, 2);
  assert.equal(p.lines.length, 2);
});

test("code map ranks the files others use, finds symbols and game assets", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { findAssets, findSymbol } = await import("./code-intel.js");
  const root = await mkdtemp(join(tmpdir(), "kesher-map-"));
  await mkdir(join(root, "Source"), { recursive: true });
  await mkdir(join(root, "Content", "UI"), { recursive: true });
  await writeFile(join(root, "Source", "Alpha.h"), "class Alpha {};\n");
  await writeFile(join(root, "Source", "HealthComponent.h"), "class UHealthComponent {\n};\n");
  await writeFile(join(root, "Source", "Pickup.cpp"), "#include \"HealthComponent.h\"\nvoid APickup::Use() { UHealthComponent* H; }\n");
  await writeFile(join(root, "Source", "Zone.cpp"), "void ADamageZone::Tick() { UHealthComponent* H; }\n");
  await writeFile(join(root, "Content", "BP_Door.uasset"), "x");
  await writeFile(join(root, "Content", "UI", "WBP_Hud.uasset"), "x");
  const map = await codeMap(root);
  assert.match(map.split("\n")[0]!, /HealthComponent\.h \[used by 2\]/, "the most used file first");
  assert.match((await codeMap(root, ".", 8000, "zone")).split("\n")[0]!, /Zone\.cpp/, "the query first");
  const where = await findSymbol(root, "UHealthComponent");
  assert.match(where, /Source\/HealthComponent\.h:1/);
  assert.match(where, /Used in 2 file/);
  assert.match(await findAssets(root), /2 assets: .*Blueprint.*widget|2 assets: .*widget.*Blueprint/);
  assert.match(await findAssets(root, "door"), /BP_Door\.uasset {2}\(Blueprint\)/);
});
