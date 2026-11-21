import { test } from "node:test";
import assert from "node:assert/strict";
import { RECOMMENDED_MODELS } from "@kesher/shared";
import { pickStarterModels } from "./starter-models.js";

const GB = 1024 ** 3;
const pc = (vramGb: number, ramGb = 32) => ({ vram: vramGb * GB, ram: ramGb * GB, unified: false });

test("a 16 GB card: the strongest model that fits fully, plus a quick one; coders get a tool-calling model", () => {
  const picks = pickStarterModels(RECOMMENDED_MODELS, pc(16), { roles: ["artist"], hebrew: false });
  assert.ok(picks.length >= 2 && picks.length <= 3);
  assert.equal(picks[0]!.why, "best");
  assert.equal(picks[0]!.fit, "gpu");
  assert.equal(picks.at(-1)!.why, "fast");
  const code = pickStarterModels(RECOMMENDED_MODELS, pc(16), { roles: ["gamedev"], hebrew: false });
  assert.ok(RECOMMENDED_MODELS.find((m) => m.id === code[0]!.id)!.goodForCode);
  for (const p of picks) assert.notEqual(p.fit, "too-big");
});

test("Hebrew writers get Dicta's model when it runs; developers do not", () => {
  const writer = pickStarterModels(RECOMMENDED_MODELS, pc(16), { roles: ["writer"], hebrew: true });
  assert.ok(writer.some((p) => p.id === "dictalm-12b" && p.why === "hebrew"));
  const dev = pickStarterModels(RECOMMENDED_MODELS, pc(16), { roles: ["developer"], hebrew: true });
  assert.ok(!dev.some((p) => p.id === "dictalm-12b"));
});

test("no graphics card: small models that run partly, never too-big ones; nothing when nothing runs", () => {
  const picks = pickStarterModels(RECOMMENDED_MODELS, pc(0, 16), { roles: [], hebrew: false });
  assert.ok(picks.length >= 1);
  for (const p of picks) assert.equal(p.fit, "partial");
  assert.deepEqual(pickStarterModels(RECOMMENDED_MODELS, pc(0, 2), { roles: [], hebrew: false }), []);
});
