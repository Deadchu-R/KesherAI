import { test } from "node:test";
import assert from "node:assert/strict";
import { StudyModelSwitch } from "./study-model.js";

test("a course's model: waits while self-work runs, loads, then puts the earlier model back", async () => {
  let loaded = "coder.gguf";
  const loads: string[] = [];
  let busy: "self-work" | undefined = "self-work";
  const sw = new StudyModelSwitch({
    loaded: () => loaded,
    load: async (p) => {
      loads.push(p);
      loaded = p;
    },
    busy: () => busy,
    backAfterMs: 5,
    wait: async () => {
      busy = undefined;
    },
  });
  const out = await sw.use("dicta.gguf", async () => loaded);
  assert.equal(out, "dicta.gguf");
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(loads, ["dicta.gguf", "coder.gguf"]);
  assert.equal(sw.status().switched, false);
});

test("a course's model: already loaded, nothing switches; 'switch now' stops the waiting", async () => {
  let loaded = "dicta.gguf";
  const loads: string[] = [];
  const sw = new StudyModelSwitch({ loaded: () => loaded, load: async (p) => void (loads.push(p), (loaded = p)), busy: () => "chat", backAfterMs: 5, wait: async () => sw.now() });
  assert.equal(await sw.use("dicta.gguf", async () => 1), 1);
  assert.deepEqual(loads, []);
  loaded = "coder.gguf";
  assert.equal(await sw.use("dicta.gguf", async () => 2), 2);
  assert.deepEqual(loads, ["dicta.gguf"]);
});
