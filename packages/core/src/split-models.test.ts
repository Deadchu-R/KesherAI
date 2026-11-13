import assert from "node:assert/strict";
import { test } from "node:test";
import { joinSplitModels } from "./routes/models.js";

test("a model in several files is one row with the whole size; missing parts are counted", () => {
  const f = (path: string, size: number) => ({ path, name: path.split("/").pop()!, size });
  const out = joinSplitModels([f("/m/a.gguf", 5), f("/m/big-00002-of-00004.gguf", 49), f("/m/big-00001-of-00004.gguf", 1), f("/m/big-00003-of-00004.gguf", 49), f("/m/big-00004-of-00004.gguf", 4), f("/m/half-00001-of-00003.gguf", 1)]);
  assert.deepEqual(out.map((x) => [x.path, x.name, x.size, x.parts]), [
    ["/m/a.gguf", "a.gguf", 5, undefined],
    ["/m/big-00001-of-00004.gguf", "big.gguf", 103, { have: 4, of: 4 }],
    ["/m/half-00001-of-00003.gguf", "half.gguf", 1, { have: 1, of: 3 }],
  ]);
});
