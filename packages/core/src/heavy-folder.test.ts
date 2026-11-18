import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeavyFolder, finishPending, isLink, suggestHeavyDir, type HeavyPending } from "./heavy-folder.js";

test("heavy folders: copied now, a link takes their place at the next start, and the paths keep working", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-root-"));
  const other = await mkdtemp(join(tmpdir(), "kesher-heavy-"));
  await mkdir(join(root, "engines", "voice", "bin"), { recursive: true });
  await writeFile(join(root, "engines", "voice", "model.bin"), "x".repeat(5000));
  // A file link needs special rights on Windows, so it is made only elsewhere.
  if (process.platform !== "win32") await symlink(join("..", "model.bin"), join(root, "engines", "voice", "bin", "python"));
  // An absolute link inside the folder (like uv's link to its Python) points into the new place after the move.
  await mkdir(join(root, "engines", "py", "cpython-3.11.18"), { recursive: true });
  await writeFile(join(root, "engines", "py", "cpython-3.11.18", "python"), "py");
  await symlink(join(root, "engines", "py", "cpython-3.11.18"), join(root, "engines", "py", "cpython-3.11"), process.platform === "win32" ? "junction" : undefined);
  let pending: HeavyPending[] = [];
  const h = new HeavyFolder(root, async (p) => { pending = p; });
  h.start(other, ["engines", "unreal"]);
  await h.idle();
  assert.equal(h.status().error, undefined);
  assert.deepEqual(pending.map((p) => p.name), ["engines"]);
  // Changed after the copy, before the restart: copied again at the start.
  await writeFile(join(root, "engines", "voice", "new.txt"), "late");
  const left = await finishPending(root, pending);
  assert.deepEqual(left, []);
  assert.equal(await isLink(join(root, "engines")), true);
  assert.equal(await readFile(join(root, "engines", "voice", "new.txt"), "utf8"), "late");
  assert.equal((await readFile(join(other, "engines", "voice", "model.bin"))).length, 5000);
  // The links inside work in the new place (on Windows a file link is copied as the file, a folder link is a junction).
  if (process.platform !== "win32") assert.equal((await readFile(join(other, "engines", "voice", "bin", "python"))).length, 5000);
  assert.equal(await readFile(join(other, "engines", "py", "cpython-3.11", "python"), "utf8"), "py");
  assert.equal((await realpath(join(other, "engines", "py", "cpython-3.11"))).startsWith(await realpath(other)), true);
  // The old folder is removed once the link works.
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual((await readdir(root)).filter((n) => n.startsWith("engines.moved")), []);
  // Already a link: nothing to do.
  assert.deepEqual(await finishPending(root, pending), []);
});

test("heavy folders: refuses a place inside the data folder, and suggests next to the models", async () => {
  const root = await mkdtemp(join(tmpdir(), "kesher-root-"));
  const h = new HeavyFolder(root, async () => undefined);
  assert.throws(() => h.start(join(root, "big"), ["engines"]), /outside/);
  const elsewhere = await mkdtemp(join(tmpdir(), "kesher-e-"));
  assert.equal(suggestHeavyDir(join(elsewhere, "models"), root), elsewhere);
  assert.equal(suggestHeavyDir(join(root, "models"), root), undefined);
});
