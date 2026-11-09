import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileErrors, describePlugins, installBuiltPlugin, listPlugins } from "./unreal-plugins.js";

test("lists project and Fab plugins with what each can do", async () => {
  const root = await mkdtemp(join(tmpdir(), "uplug-"));
  const proj = join(root, "Game");
  await mkdir(join(proj, "Plugins", "Tools", "MyTool", "Source"), { recursive: true });
  await writeFile(join(proj, "Plugins", "Tools", "MyTool", "MyTool.uplugin"), JSON.stringify({ VersionName: "1.2", FriendlyName: "My Tool" }));
  await writeFile(join(proj, "Game.uproject"), JSON.stringify({ Plugins: [{ Name: "MyTool", Enabled: true }, { Name: "PythonScriptPlugin", Enabled: true }] }));
  const eng = join(root, "UE_5.8");
  await mkdir(join(eng, "Engine", "Plugins", "Marketplace", "Fancy", "Binaries", "Win64"), { recursive: true });
  await writeFile(join(eng, "Engine", "Plugins", "Marketplace", "Fancy", "Fancy.uplugin"), JSON.stringify({ VersionName: "3.0", EngineVersion: "5.7.0" }));
  const list = await listPlugins({ projectDir: proj, uproject: join(proj, "Game.uproject"), enginePath: eng, includeEngine: true });
  const mine = list.find((p) => p.name === "MyTool")!;
  assert.equal(mine.hasSource, true);
  assert.equal(mine.enabled, true);
  const fancy = list.find((p) => p.name === "Fancy")!;
  assert.equal(fancy.where, "marketplace");
  assert.equal(fancy.hasSource, false);
  assert.ok(list.some((p) => p.name === "PythonScriptPlugin" && p.where === "engine"));
  const text = describePlugins(list, "5.8");
  assert.match(text, /My Tool \(MyTool\) — v1\.2, on in the project, has source/);
  assert.match(text, /built for UE 5\.7\.0 ⚠ not 5\.8, built only \(no source\)/);
});

test("compiler errors are picked out, and a rebuilt plugin replaces the old one with a backup", async () => {
  const log = "noise\nC:\\x\\Plugins\\P\\Source\\P\\Private\\A.cpp(12,3): error C2872: 'Error': ambiguous symbol\nmore\n";
  assert.deepEqual(compileErrors(log), ["Source\\P\\Private\\A.cpp(12,3): error C2872: 'Error': ambiguous symbol"]);
  const root = await mkdtemp(join(tmpdir(), "uport-"));
  const built = join(root, "built");
  await mkdir(join(built, "Binaries"), { recursive: true });
  await mkdir(join(built, "Intermediate"), { recursive: true });
  await mkdir(join(built, "Source"), { recursive: true });
  await writeFile(join(built, "P.uplugin"), "{}");
  const dest = join(root, "Plugins", "P");
  await mkdir(dest, { recursive: true });
  await writeFile(join(dest, "old.txt"), "old");
  const backup = await installBuiltPlugin(built, dest, true);
  assert.ok(backup && (await readFile(join(backup, "old.txt"), "utf8")) === "old");
  assert.deepEqual((await readdir(dest)).sort(), ["Binaries", "P.uplugin", "Source"]);
});
