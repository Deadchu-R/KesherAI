import { test } from "node:test";
import assert from "node:assert/strict";
import { VISION_MODELS } from "@kesher/shared";
import { BENCH_TASKS, inBox, median, runVisionBench } from "./vision-bench.js";

test("the ten tasks: five web pages and five Notepad-like, each with exactly one #target", () => {
  assert.equal(BENCH_TASKS.length, 10);
  assert.equal(BENCH_TASKS.filter((t) => t.kind === "web").length, 5);
  assert.equal(new Set(BENCH_TASKS.map((t) => t.id)).size, 10);
  for (const t of BENCH_TASKS) assert.equal(t.html.match(/id="target"/g)?.length, 1, t.id);
});

test("inBox counts a few pixels around the box; median of times", () => {
  assert.ok(inBox(12, 12, [10, 10, 5, 5]));
  assert.ok(inBox(7, 10, [10, 10, 5, 5]));
  assert.ok(!inBox(30, 10, [10, 10, 5, 5]));
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 4]), 3);
  assert.equal(median([]), 0);
});

test("runVisionBench: right/wrong per task, median time, load time, errors kept per model and per task", async () => {
  const [qwen, tars] = VISION_MODELS;
  const progress: number[] = [];
  const run = await runVisionBench({
    models: [qwen!, tars!],
    tasks: BENCH_TASKS.slice(0, 3),
    load: async (m) => (m.id === tars!.id ? Promise.reject(new Error("not installed")) : 4200),
    draw: async (t) => (t.id === "web-remember" ? Promise.reject(new Error("pane closed")) : { png: Buffer.from(t.id), width: 100, height: 100, target: [10, 10, 20, 20] }),
    ground: async (m, r) => (r.query.includes("blue") ? { found: true, x: 15, y: 15, confidence: 0.9, ms: 800, model: m.id } : { found: true, x: 90, y: 90, ms: 1200, model: m.id }),
    progress: (done) => progress.push(done),
    now: () => new Date("2026-11-21T10:00:00Z"),
  });
  assert.equal(run.at, "2026-11-21T10:00:00.000Z");
  const [a, b] = run.models;
  assert.deepEqual([a!.right, a!.of, a!.loadMs, a!.medianMs], [1, 3, 4200, 1000]);
  assert.deepEqual(a!.tasks.map((t) => t.ok), [true, false, false]);
  assert.match(a!.tasks[2]!.error!, /pane closed/);
  assert.equal(b!.error, "not installed");
  assert.deepEqual(progress, [1, 2, 3, 6]);
});
