import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { modelParts } from "./models.js";

test("a model split in parts is all its parts; another model in the folder is not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "parts-"));
  try {
    for (const n of ["M-UD-00001-of-00003.gguf", "M-UD-00002-of-00003.gguf", "M-UD-00003-of-00003.gguf", "M-UD-X-00001-of-00002.gguf", "Other.gguf"]) await writeFile(join(dir, n), "x");
    assert.deepEqual((await modelParts(join(dir, "M-UD-00002-of-00003.gguf"))).map((p) => basename(p)).sort(), ["M-UD-00001-of-00003.gguf", "M-UD-00002-of-00003.gguf", "M-UD-00003-of-00003.gguf"]);
    assert.deepEqual((await modelParts(join(dir, "Other.gguf"))).map((p) => basename(p)), ["Other.gguf"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
