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
