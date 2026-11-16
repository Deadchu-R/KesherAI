import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelsMove } from "./models-move.js";

test("models move to the new folder, keeping sub-folders; one already there is not copied again", async () => {
  const root = await mkdtemp(join(tmpdir(), "models-move-"));
  const from = join(root, "old");
  const to = join(root, "new");
  await mkdir(join(from, "loras"), { recursive: true });
  await mkdir(to, { recursive: true });
  await writeFile(join(from, "a.gguf"), "aaaa");
  await writeFile(join(from, "loras", "b.safetensors"), "bb");
  await writeFile(join(to, "a.gguf"), "aaaa");
  const m = new ModelsMove();
  assert.throws(() => m.start(from, join(from, "x")), /inside each other/);
  m.start(from, to);
  await m.idle();
  const st = m.status();
  assert.equal(st.files, 2);
  assert.equal(st.done, 2);
  assert.deepEqual(st.kept, []);
  assert.equal(await readFile(join(to, "loras", "b.safetensors"), "utf8"), "bb");
  assert.equal(await stat(join(from, "a.gguf")).catch(() => null), null);
});
