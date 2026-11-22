import { test } from "node:test";
import assert from "node:assert/strict";
import { goalFor, nextForExecutor, parseResearchTasks, sameTask } from "./research-tasks.js";

const SYNTH = `# Synthesis

## 1. CO-DEVELOPER (CD)

**CD-1 Overlay state (pure model)** — NEW. Why: c-15. Build: \`overlay-state.ts\`. Size S. Who LOCAL. Deps none.

**CD-2 Overlay window** — NEW. Build: BrowserWindow. Size M. Who AGY.

## 3. GAME ENGINE TOOLS (GE)

**GE-6 Unreal level cache** — PARTIAL (cache.ts). Size M. Who AGY.

**GE-9 Cloud builds** — DONE (builds.ts).

## 4. EVERYTHING ELSE (X)

**X-22 Hub builder** — NEW. Size L. Who LEAD.
`;

const REPORT = `# Report

## Conclusion
Fine.

## Tasks
### T1: Add the cache flag
Build it in llamacpp.ts. Size S.

- **T2** Measure the speed: on the PC, M size.

## Sources
1. [x](https://x)
`;

test("parseResearchTasks: synthesis blocks with size, who and status", () => {
  const t = parseResearchTasks(SYNTH, "SYNTHESIS-2026-11-22.md");
  assert.deepEqual(t.map((x) => [x.key.split("#")[1], x.size, x.who, x.status]), [
    ["CD-1", "S", "local", "new"],
    ["CD-2", "M", "antigravity", "new"],
    ["GE-6", "M", "antigravity", "partial"],
    ["GE-9", "M", "antigravity", "done"],
    ["X-22", "L", "lead", "new"],
  ]);
  assert.equal(t[0]!.title, "Overlay state (pure model)");
});

test("parseResearchTasks: only the ## Tasks section of a normal report; size decides who", () => {
  const t = parseResearchTasks(REPORT, "c-1.md");
  assert.deepEqual(t.map((x) => [x.key, x.title, x.size, x.who]), [
    ["c-1.md#T1", "Add the cache flag", "S", "local"],
    ["c-1.md#T2", "Measure the speed", "M", "antigravity"],
  ]);
  assert.deepEqual(parseResearchTasks("# No tasks\n\n## Conclusion\nnone", "c-2.md"), []);
});

test("nextForExecutor: co-developer first, lead and done never", () => {
  const t = parseResearchTasks(SYNTH, "S.md");
  assert.equal(nextForExecutor(t, "antigravity")?.key, "S.md#CD-2");
  assert.equal(nextForExecutor(t.filter((x) => !x.key.endsWith("CD-2")), "antigravity")?.key, "S.md#GE-6");
  assert.equal(nextForExecutor(t, "local")?.key, "S.md#CD-1");
  assert.equal(nextForExecutor(t.filter((x) => x.who === "lead"), "antigravity"), undefined);
});

test("sameTask: same words in another order, or almost all words inside the other", () => {
  assert.ok(sameTask("Overlay state (pure model)", "Pure model: overlay state"));
  assert.ok(sameTask("Unreal level cache written at editor exit", "Unreal level cache written at the editor exit time"));
  assert.ok(!sameTask("Overlay window", "Overlay state"));
});

test("goalFor: names the report and the rules", () => {
  const g = goalFor(parseResearchTasks(SYNTH, "S.md")[2]!);
  assert.match(g, /docs\/research\/S\.md \(GE-6\)/);
  assert.match(g, /already exists/);
});
