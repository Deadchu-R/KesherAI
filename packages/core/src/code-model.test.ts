import { test } from "node:test";
import assert from "node:assert/strict";
import { pickCodeModel } from "./code-model.js";

const m = (id: string, location: "local" | "server" | "cloud" = "local", category = "chat") => ({ id, name: id.split("/").pop()!, category, location });

test("long coding runs: the best coder that runs well here; never a cloud model by itself; too big is skipped", () => {
  const list = [m("lmstudio/qwen3-8b"), m("lmstudio/qwen/qwen3-coder-30b"), m("ollama/gpt-oss:20b"), m("openai/gpt-5", "cloud"), m("comfy/flux", "local", "image")];
  assert.equal(pickCodeModel(list)!.id, "lmstudio/qwen/qwen3-coder-30b");
  assert.match(pickCodeModel(list)!.why, /coding agents/);
  // Too big for this computer: the next best that fits.
  assert.equal(pickCodeModel(list, (x) => (x.id.includes("coder-30b") ? "too-big" : "good"))!.id, "ollama/gpt-oss:20b");
  // Slow here: a slightly weaker fast model wins for hours of work.
  assert.equal(pickCodeModel([m("a/devstral-small-24b"), m("b/gpt-oss-20b")], (x) => (x.id.startsWith("a/") ? "slow" : "good"))!.id, "b/gpt-oss-20b");
  assert.equal(pickCodeModel([m("openai/gpt-5", "cloud")]), undefined);
  assert.equal(pickCodeModel([m("x/some-model")])!.id, "x/some-model");
});
