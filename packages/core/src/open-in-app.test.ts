import { test } from "node:test";
import assert from "node:assert/strict";
import { BLENDER_ROUND_TRIP } from "./open-in-app.js";

test("Blender's round trip takes the file from the environment, never written into the script, and saves back as GLB", () => {
  assert.match(BLENDER_ROUND_TRIP, /os\.environ\['KESHER_GLB'\]/);
  assert.match(BLENDER_ROUND_TRIP, /save_post\.append\(back\)/);
  assert.match(BLENDER_ROUND_TRIP, /export_format='GLB'/);
  assert.doesNotMatch(BLENDER_ROUND_TRIP, /[A-Z]:\\|\/Users\//);
});
