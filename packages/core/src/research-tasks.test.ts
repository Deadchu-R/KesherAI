import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dedupeResearchTasks,
  goalFor,
  nextForExecutor,
  normTitle,
  parseResearchTasks,
  routeResearchTask,
  sameTask,
  splitByCap,
} from "./research-tasks.js";

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

test("nextForExecutor: the hand-written BACKLOG.md goes before the reports' tasks", () => {
  const backlog = parseResearchTasks("# Research backlog\n\n## Tasks\n### BL-1: Add a loop chip\nSize M · Who AGY\nShow it.\n", "BACKLOG.md");
  assert.equal(backlog.length, 1);
  const all = [...parseResearchTasks(SYNTH, "S.md"), ...backlog];
  assert.equal(nextForExecutor(all, "antigravity")?.key, "BACKLOG.md#BL-1");
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

test("normTitle sorts words and drops fillers", () => {
  // normTitle lowercases, strips non-alphanumerics, removes short/filler words, then sorts alphabetically.
  assert.equal(normTitle("Overlay State (pure model)"), "model overlay pure state");
  assert.equal(normTitle("Add the Unreal level-cache"), "cache level unreal");
});

test("dedupeResearchTasks drops done and matching titles", () => {
  const tasks = parseResearchTasks(SYNTH, "S.md");
  // Use normalized forms that match normTitle's sorted-word output.
  const existing = ["model overlay pure state"];
  const workList = ["builds cloud unreal"];
  const kept = dedupeResearchTasks(tasks, existing, workList);
  // CD-1 matches existing, GE-9 is DONE, X-1 matches workList → all removed
  assert.ok(!kept.some((t) => t.id === "CD-1"));
  assert.ok(!kept.some((t) => t.id === "GE-9"));
  assert.ok(!kept.some((t) => t.id === "X-1"));
  // CD-2 and GE-6 remain
  assert.ok(kept.some((t) => t.id === "CD-2"));
  assert.ok(kept.some((t) => t.id === "GE-6"));
});

test("routeResearchTask maps size/who to executor and status", () => {
  const s = routeResearchTask({ id: "T-1", title: "t", body: "", key: "X#1", files: [], size: "S", who: "local", status: "new" });
  assert.equal(s.executor, "local");
  assert.equal(s.status, "waiting");
  const m = routeResearchTask({ id: "T-2", title: "t", body: "", key: "X#2", files: [], size: "M", who: "antigravity", status: "new" });
  assert.equal(m.executor, "antigravity");
  assert.equal(m.model, "opus");
  assert.equal(m.status, "waiting");
  const l = routeResearchTask({ id: "T-3", title: "t", body: "", key: "X#3", files: [], size: "L", who: "lead", status: "new" });
  assert.equal(l.executor, "claude");
  assert.equal(l.status, "needs-lead");
});

test("splitByCap respects priority order and the 15 runnable cap", () => {
 const make = (id: string, key: string, size: "S" | "M" | "L", who: "local" | "antigravity" | "lead"): import("./research-tasks.js").ResearchTask => ({
 id, title: id, body: "", key, files: [], size, who, status: "new",
 });
 const tasks = [
 make("X-1", "X#1", "S", "local"),
 make("CD-1", "CD#1", "S", "local"),
 make("GE-1", "GE#1", "M", "antigravity"),
 make("CH-1", "CH#1", "S", "local"),
 make("LEAD-1", "CD#2", "L", "lead"),
 ];
 const { queue, backlog } = splitByCap(tasks, 2);
 // Lead task always in queue, not counted against cap
 assert.ok(queue.some((t) => t.id === "LEAD-1"));
 // Priority follows SECTION_ORDER (CD, CH, GE, X); with cap=2 runnable, CD-1 and CH-1 are first
 const runnableQueue = queue.filter((t) => t.who !== "lead" && t.size !== "L");
 assert.equal(runnableQueue.length, 2);
 assert.equal(runnableQueue[0]!.id, "CD-1");
 assert.equal(runnableQueue[1]!.id, "CH-1");
 assert.ok(backlog.some((t) => t.id === "GE-1"));
 assert.ok(backlog.some((t) => t.id === "X-1"));
});
