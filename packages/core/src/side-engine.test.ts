import { test } from "node:test";
import assert from "node:assert/strict";
import { SIDE_PROVIDER, SideEngine } from "./side-engine.js";

test("the model beside: ids, no engine without the main one's files, stop withdraws it", async () => {
  assert.equal(SideEngine.idOf("C:\\models\\chat\\Gemma 4 E4B-Q4_K_M.gguf".replace(/\\/g, "/")), `${SIDE_PROVIDER}/Gemma-4-E4B-Q4_K_M`);
  const removed: string[] = [];
  const registry = { remove: (id: string) => removed.push(id), add: () => undefined } as never;
  const side = new SideEngine({ dir: "/tmp/engines", binary: () => undefined, args: [], registry });
  await assert.rejects(side.load("/tmp/x.gguf"), /Install the engine first/);
  assert.deepEqual(side.status(), { running: false });
  await side.stop();
  assert.deepEqual(removed, [SIDE_PROVIDER]);
});
