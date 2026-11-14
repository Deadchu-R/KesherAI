import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findMmproj } from "./llamacpp.js";

test("findMmproj: the vision file beside the model; the one named like it, then F16", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mm-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const model = join(dir, "Qwen3.8-27B-UD-Q4_K_XL.gguf");
  writeFileSync(model, "");
  assert.equal(await findMmproj(model), undefined);
  writeFileSync(join(dir, "mmproj-BF16.gguf"), "");
  writeFileSync(join(dir, "mmproj-F16.gguf"), "");
  assert.equal(await findMmproj(model), join(dir, "mmproj-F16.gguf"));
  writeFileSync(join(dir, "Qwen3.8-27B-mmproj-F32.gguf"), "");
  assert.equal(await findMmproj(model), join(dir, "Qwen3.8-27B-mmproj-F32.gguf"));
});
