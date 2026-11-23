import { describe, test } from "node:test";
import { strict } from "node:assert/strict";
import { hasBridgeAddon } from "./godot-cli.js";
import { join } from "node:path";

describe("godot-cli", () => {
  test("hasBridgeAddon returns false for non-existent directory", () => {
    strict.equal(hasBridgeAddon("/nonexistent/path"), false);
  });

  test("hasBridgeAddon returns false when addon folder exists but scripts are missing", () => {
    // project.godot exists at root, so the folder is real but addon is missing
    strict.equal(hasBridgeAddon(join(import.meta.dirname.replace(/\\/g, "/"), "..")), false);
  });

  test("validateScript and validateScene exist and are callable", async () => {
    const mod = await import("./godot-cli.js");
    strict.equal(typeof mod.validateScript, "function");
    strict.equal(typeof mod.validateScene, "function");
    strict.equal(typeof mod.hasBridgeAddon, "function");
  });
});
