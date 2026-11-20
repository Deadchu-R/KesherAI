import { test } from "node:test";
import assert from "node:assert/strict";
import { SideEngine, smallerBeside, translatorModelId } from "./side-engine.js";

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

test("model size per turn: only a running, clearly smaller model beside the main one", () => {
  const sizes: Record<string, number> = { "/m/small.gguf": 3, "/m/big.gguf": 20, "/m/mid.gguf": 15 };
  const size = (p: string) => sizes[p];
  const side = (modelPath: string, running = true) => ({ running, modelPath, modelId: `llamacpp-beside/${modelPath}` });
  assert.equal(smallerBeside(side("/m/small.gguf"), "/m/big.gguf", size), "llamacpp-beside//m/small.gguf");
  assert.equal(smallerBeside(side("/m/mid.gguf"), "/m/big.gguf", size), undefined, "not much smaller");
  assert.equal(smallerBeside(side("/m/small.gguf", false), "/m/big.gguf", size), undefined, "never loads one");
  assert.equal(smallerBeside(side("/m/small.gguf"), undefined, size), undefined);
  assert.equal(smallerBeside(side("/m/gone.gguf"), "/m/big.gguf", size), undefined);
});
