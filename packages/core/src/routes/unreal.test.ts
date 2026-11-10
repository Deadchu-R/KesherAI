import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { UNITY_PACKAGE_VERSION } from "./unreal.js";

test("the Unity package version the page offers is the package's own version", async () => {
  const pkg = JSON.parse(await readFile(join(import.meta.dirname, "..", "..", "..", "..", "integrations", "unity", "com.kesherai.bridge", "package.json"), "utf8")) as { version: string };
  assert.equal(UNITY_PACKAGE_VERSION, pkg.version);
});
