import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editorLogPath, logIsFor, unityCompileErrors, unityCompileState } from "./unity-compile.js";

const LOG = [
  "Successfully changed project path to: D:/Games/Door",
  "Packages/com.kesherai.bridge/Editor/KesherGraph.cs(41,17): error CS0246: The type or namespace name 'Foo' could not be found",
  "Assets/Mine.cs(3,1): error CS1002: ; expected",
  "C:\\Users\\someone\\Door\\Packages\\com.kesherai.bridge\\Editor\\KesherVfx.cs(7,2): error CS0103: The name 'x' does not exist",
  "Library/PackageCache/com.kesherai.bridge@0.2.13/Editor/Json.cs(9,9): error CS0117: 'Y' does not contain a definition for 'Z'",
  "Packages/com.kesherai.bridge/Editor/KesherGraph.cs(41,17): error CS0246: The type or namespace name 'Foo' could not be found",
  "Packages/com.kesherai.bridge/Editor/KesherGraph.cs(50,1): warning CS0168: unused",
].join("\n");

test("only the KesherAI package's own compile errors are read, once each, without the path before the package", () => {
  const e = unityCompileErrors(LOG);
  assert.equal(e.length, 3);
  assert.equal(e[0], "Editor/KesherGraph.cs(41,17): error CS0246: The type or namespace name 'Foo' could not be found");
  assert.ok(e[1]!.startsWith("Editor/KesherVfx.cs(7,2)"));
  assert.ok(e[2]!.startsWith("Editor/Json.cs(9,9)"));
  assert.ok(e.every((l) => !/Users|Library|Packages/.test(l)));
  assert.deepEqual(unityCompileErrors(LOG, 1).length, 1);
  assert.deepEqual(unityCompileErrors("all fine"), []);
});

test("the log's path per system, and whether a log is this project's", () => {
  assert.equal(editorLogPath("win32", { LOCALAPPDATA: "C:\\L" }, "C:\\H").replace(/\\/g, "/"), "C:/L/Unity/Editor/Editor.log");
  assert.ok(editorLogPath("darwin", {}, "/h").replace(/\\/g, "/").endsWith("Library/Logs/Unity/Editor.log"));
  assert.ok(editorLogPath("linux", {}, "/h").replace(/\\/g, "/").endsWith(".config/unity3d/Editor.log"));
  assert.ok(logIsFor("-projectPath\nD:\\Games\\Door\n", "d:/games/door/"));
  assert.ok(!logIsFor("-projectPath\nD:\\Games\\Other\n", "D:/Games/Door"));
});

/** A project with the package (version 0.2.14), and a log. */
async function setup(opts: { log?: string; marker?: string; logOlder?: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), "kesher-compile-"));
  const project = join(dir, "Door");
  await mkdir(join(project, "Packages", "com.kesherai.bridge"), { recursive: true });
  await mkdir(join(project, "Temp"), { recursive: true });
  await writeFile(join(project, "Packages", "com.kesherai.bridge", "package.json"), JSON.stringify({ version: "0.2.14" }));
  if (opts.marker) await writeFile(join(project, "Temp", "KesherBridge.ok"), opts.marker);
  const log = join(dir, "Editor.log");
  if (opts.log !== undefined) {
    await writeFile(log, opts.log);
    if (opts.logOlder) await utimes(log, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
  }
  return { project, log };
}

test("compile state: ok by the marker of this version, failed by the log's errors, unknown otherwise", async () => {
  const head = (p: string) => `-projectPath\n${p}\n`;
  const a = await setup({ marker: "0.2.14" });
  assert.deepEqual(await unityCompileState(a.project, { log: a.log }), { state: "ok", errors: [], version: "0.2.14" });
  // An old version's marker (Unity kept the old assemblies when the new ones failed) is not trusted.
  // (and the log here is for another project)
  const b = await setup({ marker: "0.2.13", log: head("x") });
  assert.equal((await unityCompileState(b.project, { log: b.log })).state, "unknown");
  const c = await setup({});
  await writeFile(c.log, `${head(c.project)}${LOG}`);
  const failed = await unityCompileState(c.project, { log: c.log });
  assert.equal(failed.state, "failed");
  assert.equal(failed.errors.length, 3);
  // A log from before the package's files says nothing about them.
  const d = await setup({ log: "", logOlder: true });
  await writeFile(d.log, `${head(d.project)}${LOG}`);
  await utimes(d.log, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
  assert.equal((await unityCompileState(d.project, { log: d.log })).state, "unknown");
  // No log, and no package at all.
  assert.equal((await unityCompileState(a.project, { log: join(a.project, "none.log") })).state, "ok");
  assert.deepEqual(await unityCompileState(join(tmpdir(), "kesher-no-such-project")), { state: "unknown", errors: [] });
});
