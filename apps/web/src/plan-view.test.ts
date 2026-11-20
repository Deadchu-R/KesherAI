import { test } from "node:test";
import assert from "node:assert/strict";
import type { HelperPlanRef, HelperRunInfo } from "@kesher/shared";
import { planCollapsed, plansOf } from "./plan-view.js";

const run = (id: string, state: HelperRunInfo["state"], at: number, plan?: HelperPlanRef, more: Partial<HelperRunInfo> = {}): HelperRunInfo => ({
  id, kind: "research", title: id, model: "m", state, queuedAt: at, step: 0, maxSteps: 8, steps: [], background: true, ...(plan ? { plan } : {}), ...more,
});

test("runs group into plans, with the newest revision, the first call and live counts", () => {
  const p = { id: "p1", goal: "old", kind: "plan" as const };
  const views = plansOf([
    run("solo", "done", 0),
    run("b", "running", 2, { ...p, goal: "new", rev: 1 }, { callId: "k2", startedAt: 5 }),
    run("a", "done", 1, p, { callId: "k1", startedAt: 3, endedAt: 9 }),
    run("c", "stopped", 3, { ...p, goal: "new", rev: 1 }, { removed: true }),
  ]);
  assert.equal(views.length, 1);
  const v = views[0]!;
  assert.deepEqual(v.runs.map((r) => r.id), ["a", "b", "c"]);
  assert.equal(v.plan.goal, "new");
  assert.equal(v.callId, "k1");
  assert.deepEqual([v.stage, v.going, v.done, v.stopped, v.startedAt, v.endedAt], ["running", 1, 1, 0, 3, undefined]);
  assert.equal(planCollapsed(v), false);
});

test("ended plans collapse; a deep research follows its own stage", () => {
  const p = { id: "p", goal: "g", kind: "plan" as const };
  assert.equal(plansOf([run("a", "failed", 0, p), run("b", "done", 1, p)])[0]!.stage, "done");
  assert.equal(plansOf([run("a", "failed", 0, p), run("b", "failed", 1, p)])[0]!.stage, "failed");
  const r = (phase: HelperPlanRef["phase"]) => plansOf([run("a", "done", 0, { id: "r", goal: "q", kind: "research", ...(phase ? { phase } : {}) })])[0]!;
  assert.equal(r("writing").stage, "writing");
  assert.equal(planCollapsed(r("writing")), false);
  assert.equal(r("done").stage, "done");
  assert.equal(r("researching").stage, "stopped", "nothing going and no report: it was cut short");
  assert.equal(planCollapsed(r("done")), true);
});
