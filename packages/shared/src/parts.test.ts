import { test } from "node:test";
import assert from "node:assert/strict";
test("simple mode leaves out every menu page but pictures, models and settings", async () => {
  const { simpleHidden } = await import("./parts.js");
  assert.equal(simpleHidden(true, "#/images"), false);
  assert.equal(simpleHidden(true, "#/settings/phone"), false);
  assert.equal(simpleHidden(true, "#/unreal"), true);
  assert.equal(simpleHidden(false, "#/unreal"), false);
  assert.equal(simpleHidden(undefined, "#/self-work"), false);
});
