import { test } from "node:test";
import assert from "node:assert/strict";
import { SideEngine, translatorModelId } from "./side-engine.js";

test("a GGUF translator is loaded beside once; a model id is used as it is", async () => {
  let loads = 0;
  let path: string | undefined;
  const side = {
    status: () => (path ? { running: true, modelPath: path, modelId: SideEngine.idOf(path) } : { running: false }),
    load: async (p: string) => {
      loads++;
      path = p;
      return SideEngine.idOf(p);
    },
  } as unknown as SideEngine;
  assert.equal(await translatorModelId(side, "llamacpp/Qwen"), "llamacpp/Qwen");
  assert.equal(await translatorModelId(side, "E:/m/translategemma-4b_Q5_K_M.gguf"), "llamacpp-beside/translategemma-4b_Q5_K_M");
  await translatorModelId(side, "E:/m/translategemma-4b_Q5_K_M.gguf");
  assert.equal(loads, 1);
});
