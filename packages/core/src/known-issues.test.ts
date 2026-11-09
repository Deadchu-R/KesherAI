import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_ISSUES, applies, compareVersions, iniValue, preflight } from "./known-issues.js";

test("versions and which issues apply", () => {
  assert.ok(compareVersions("5.8.10", "5.8.4") > 0);
  assert.equal(compareVersions("5.8", "5.8.0"), 0);
  const shader = BUILTIN_ISSUES.find((i) => i.id === "UE-396689")!;
  assert.equal(applies(shader, "unreal", "5.8.2", "android"), true);
  assert.equal(applies(shader, "unreal", "5.8.4", "android"), false, "fixed in 5.8.4");
  assert.equal(applies(shader, "unreal", "5.8.2", "windows"), false);
  assert.equal(applies(shader, "unity", "5.8.2", "android"), false);
});

test("preflight fixes the project before an Android build, once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ki-"));
  await mkdir(join(dir, "Config"));
  await writeFile(join(dir, "Config", "DefaultGame.ini"), "[/Script/UnrealEd.ProjectPackagingSettings]\nbShareMaterialShaderCode=True\nbUseIoStore=True\n");
  await writeFile(join(dir, "Config", "DefaultEngine.ini"), "[/Script/Engine.RendererSettings]\nr.MobileHDR=False\nr.DefaultFeature.Bloom=False\n");
  const lines = await preflight(dir, "unreal", "5.8.2", "android", BUILTIN_ISSUES);
  assert.equal(lines.length, 2);
  const game = await readFile(join(dir, "Config", "DefaultGame.ini"), "utf8");
  assert.equal(iniValue(game, "[/Script/UnrealEd.ProjectPackagingSettings]", "bShareMaterialShaderCode"), "False");
  assert.match(game, /bUseIoStore=True/);
  assert.equal(iniValue(await readFile(join(dir, "Config", "DefaultEngine.ini"), "utf8"), "[/Script/Engine.RendererSettings]", "r.MobileHDR"), "True");
  assert.match(await readFile(join(dir, "Config", "DefaultGame.ini.kesher-backup"), "utf8"), /=True/);
  assert.deepEqual(await preflight(dir, "unreal", "5.8.2", "android", BUILTIN_ISSUES), [], "nothing left to fix");
});
