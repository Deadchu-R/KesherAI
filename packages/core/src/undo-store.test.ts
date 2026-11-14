import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileUndoStore } from "./undo-store.js";

test("undo store: a run's files are kept on disk, read back, removed; ids are checked", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "undo-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s = fileUndoStore(dir, "conv-1");
  const files = { files: [{ path: "/p/a.txt", before: "one", after: "x" }] };
  await s.save("ab12", files);
  assert.deepEqual(await fileUndoStore(dir, "conv-1").load("ab12"), files);
  await s.remove("ab12");
  assert.equal(await s.load("ab12"), undefined);
  await assert.rejects(s.load("../x"), /Not a run id/);
});
