import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSynced, type DevicesConfig } from "./devices.js";

test("settings sync: new items arrive, the newer change wins, nothing ping-pongs", () => {
  const laptop: DevicesConfig["stamps"] = {};
  const pc: DevicesConfig["stamps"] = {};
  // The PC has OpenAI; the laptop has nothing yet.
  const r1 = mergeSynced({ openai: { key: "a" } }, {}, pc, "p:", 1000);
  assert.deepEqual(r1.apply, []);
  const drive = r1.merged;
  // The laptop gets it.
  const r2 = mergeSynced<{ key: string }>({}, drive, laptop, "p:", 2000);
  assert.deepEqual(r2.apply, [{ key: "a" }]);
  // Nothing changes on either side: no more work.
  assert.deepEqual(mergeSynced({ openai: { key: "a" } }, r2.merged, laptop, "p:", 3000).apply, []);
  // The laptop changes the key later: Drive takes it, and the PC applies it.
  const r3 = mergeSynced({ openai: { key: "b" } }, r2.merged, laptop, "p:", 4000);
  assert.equal(r3.merged.openai!.config.key, "b");
  const r4 = mergeSynced({ openai: { key: "a" } }, r3.merged, pc, "p:", 5000);
  assert.deepEqual(r4.apply, [{ key: "b" }]);
  assert.equal(r4.merged.openai!.config.key, "b");
});
