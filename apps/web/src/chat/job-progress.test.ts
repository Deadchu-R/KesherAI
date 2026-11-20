import { test } from "node:test";
import assert from "node:assert/strict";
import { MEDIA_JOB, mergeProgress } from "./job-progress.js";

test("a progress update keeps the last preview frame and takes the new step", () => {
  const a = mergeProgress(undefined, { phase: "sampling", step: 1, steps: 20, preview: "data:image/jpeg;base64,AA" });
  const b = mergeProgress(a, { phase: "sampling", step: 2, steps: 20 });
  assert.deepEqual(b, { phase: "sampling", step: 2, steps: 20, preview: "data:image/jpeg;base64,AA" });
  assert.equal(mergeProgress(b, { preview: "data:image/png;base64,BB" }).preview, "data:image/png;base64,BB");
  assert.deepEqual(mergeProgress(undefined, { phase: "queued" }), { phase: "queued" });
});

test("which steps are media jobs", () => {
  assert.ok(MEDIA_JOB.test("generate_image") && MEDIA_JOB.test("make_music") && MEDIA_JOB.test("upscale_image"));
  assert.ok(!MEDIA_JOB.test("read_file") && !MEDIA_JOB.test("generate_image_x"));
});
