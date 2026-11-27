import { test } from "node:test";
import assert from "node:assert/strict";
import { getGuidFromPath } from "./unity-meta.js";

test("getGuidFromPath returns 32 lowercase hex characters", () => {
  const guid = getGuidFromPath("Assets/Textures/wall.png");
  assert.match(guid, /^[0-9a-f]{32}$/);
});

test("getGuidFromPath is deterministic for the same path", () => {
  assert.equal(getGuidFromPath("Assets/Scenes/Main.unity"), getGuidFromPath("Assets/Scenes/Main.unity"));
});

test("getGuidFromPath normalizes separators and a leading ./", () => {
  assert.equal(getGuidFromPath("Assets\\Foo.png"), getGuidFromPath("./Assets/Foo.png"));
});

test("getGuidFromPath differs for different paths", () => {
  assert.notEqual(getGuidFromPath("Assets/A.png"), getGuidFromPath("Assets/B.png"));
});