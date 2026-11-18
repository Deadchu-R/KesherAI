import { test } from "node:test";
import assert from "node:assert/strict";
import { checkExtraArgs, checkLoadSettings, loadSettingsArgs, splitEngineArgs, withModelArgs } from "./model-args.js";

test("typed arguments split at spaces, quotes keep a value whole", () => {
  assert.deepEqual(splitEngineArgs(`--temp 0.7  -ot "blk\\.\\d+\\.ffn=CPU" --no-mmap`), ["--temp", "0.7", "-ot", "blk\\.\\d+\\.ffn=CPU", "--no-mmap"]);
});

test("only load and sampling settings are allowed; files, ports and keys are refused", () => {
  assert.equal(checkExtraArgs(["--temp", "0.7", "--no-mmap", "--top-k", "20", "--seed", "-1"]), undefined);
  assert.match(checkExtraArgs(["--log-file", "x.txt"])!, /not one of/);
  assert.match(checkExtraArgs(["--api-key", "k"])!, /not one of/);
  assert.match(checkExtraArgs(["--port", "9"])!, /not one of/);
  assert.match(checkExtraArgs(["--temp"])!, /needs a value/);
  assert.match(checkExtraArgs(["--temp", "--top-k"])!, /needs a value/);
  assert.match(checkLoadSettings({ ctx: 100 })!, /Context/);
  assert.equal(checkLoadSettings({ ctx: 65536, kv: "q8_0", cpuMoe: 20, flash: "on" }), undefined);
});

test("a model's setting replaces the engine's same setting, under any spelling", () => {
  const model = loadSettingsArgs({ ctx: 65536, kv: "f16", extra: ["--temp", "0.7"] });
  assert.deepEqual(model, ["-c", "65536", "--cache-type-k", "f16", "--cache-type-v", "f16", "--temp", "0.7"]);
  assert.deepEqual(withModelArgs(["--ctx-size", "8192", "-ngl", "99", "--jinja", "-ctk", "q8_0"], model), ["-ngl", "99", "--jinja", ...model]);
  assert.deepEqual(withModelArgs(["-c", "8192"], []), ["-c", "8192"]);
});
