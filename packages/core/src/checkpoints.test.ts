import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Checkpoints } from "./checkpoints.js";

test("checkpoints save the folder and restore it (and the restore can be undone)", async (t) => {
  const cps = new Checkpoints(await mkdtemp(join(tmpdir(), "kesher-cps-")));
  if (!(await cps.hasGit())) return t.skip("git is not installed");
  const ws = await mkdtemp(join(tmpdir(), "kesher-ws-"));
  await writeFile(join(ws, "a.cs"), "class A {}\n");
  await mkdir(join(ws, "Library"));
  await writeFile(join(ws, "Library", "big.cache"), "x");
  const first = (await cps.snapshot("conv-1", ws, "Add a player"))!;
  // The agent changes a file and adds one.
  await writeFile(join(ws, "a.cs"), "class A { void Jump() {} }\n");
  await writeFile(join(ws, "b.cs"), "class B {}\n");
  const second = (await cps.snapshot("conv-1", ws, "Now add enemies"))!;
  assert.equal(second.files, 2);
  const before = await cps.restore("conv-1", ws, first.id);
  assert.equal(await readFile(join(ws, "a.cs"), "utf8"), "class A {}\n");
  assert.equal(existsSync(join(ws, "b.cs")), false, "files added later are removed");
  assert.ok(existsSync(join(ws, "Library", "big.cache")), "Unity's Library folder is never touched");
  // Undo the restore.
  await cps.restore("conv-1", ws, before!.id);
  assert.match(await readFile(join(ws, "a.cs"), "utf8"), /Jump/);
  assert.ok(existsSync(join(ws, "b.cs")));
  assert.ok(!existsSync(join(ws, ".git")), "the project's own git is not created or touched");
  assert.equal((await cps.list("conv-1")).length, 4);
});
