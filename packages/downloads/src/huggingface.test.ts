import { test } from "node:test";
import assert from "node:assert/strict";
import { isHubRepo, listHubFiles, modelSummary } from "./huggingface.js";

test("isHubRepo: owner/name and old top-level names only", async () => {
  for (const r of ["unsloth/Qwen3-8B-GGUF", "gpt2", "bartowski/Llama-3.2-3B-Instruct-GGUF", "a_b/c.d-e"]) assert.equal(isHubRepo(r), true, r);
  for (const r of ["", "../x", "a/../b", "a/b/c", "a/b?x=1", "a/b#f", "@evil.com/x", "a/..", "a/.", "/a", "a/", "a b/c", "a\\b"]) assert.equal(isHubRepo(r), false, r);
  // Refused before any request is made.
  await assert.rejects(listHubFiles("a/../../b"), /Not a Hugging Face repo id/);
  await assert.rejects(modelSummary("x?y"), /Not a Hugging Face repo id/);
});
