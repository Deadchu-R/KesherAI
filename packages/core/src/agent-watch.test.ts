import { test } from "node:test";
import assert from "node:assert/strict";
import { limitsFor, parseReview, parseWatchVerdict, REPEAT_LIMIT, RunGuard, RunWatch, stepKey, stopNote, type GuardHooks, type StopReason } from "./agent-watch.js";

/** A fake clock the tests move by hand. */
function clock() {
  let t = 1_000_000;
  return { now: () => t, add: (ms: number) => void (t += ms) };
}
const MIN = 60_000;
const limits = { stallMs: 10 * MIN, maxRequests: 80, ceilingMs: 120 * MIN };

test("stepKey: the same tool and arguments (any key order) are the same step", () => {
  assert.equal(stepKey("read", { a: 1, b: 2 }), stepKey("read", { b: 2, a: 1 }));
  assert.notEqual(stepKey("read", { a: 1 }), stepKey("read", { a: 2 }));
  assert.notEqual(stepKey("read", "x"), stepKey("edit", "x"));
});

test("limitsFor: the ceiling is the longest of the task, the setting and 120; defaults 10 min and 80 requests", () => {
  const d = limitsFor(15, { maxMinutes: 15 });
  assert.deepEqual([d.stallMinutes, d.maxRequests, d.ceilingMinutes], [10, 80, 120]);
  assert.equal(limitsFor(300, { maxMinutes: 200 }).ceilingMinutes, 300);
  assert.equal(limitsFor(15, { maxMinutes: 240, stallMinutes: 3, maxRequests: 5 }).ceilingMinutes, 240);
});

test("RunWatch: no progress for the stall window stops; a changed file or a new step is progress", async () => {
  const c = clock();
  let fp = "a";
  const w = new RunWatch(limits, c.now, async () => ({ fp, files: ["x.ts"] }));
  assert.equal(await w.check(), undefined);
  c.add(9 * MIN);
  assert.equal(await w.check(), undefined);
  fp = "b"; // the worktree changed
  c.add(9 * MIN);
  assert.equal(await w.check(), undefined);
  w.step({ tool: "read", args: "a" }); // a new step
  c.add(9 * MIN);
  assert.equal(await w.check(), undefined);
  c.add(2 * MIN);
  assert.equal(await w.check(), "stall");
});

test("RunWatch: the same step 4 times in a row repeats; a different one in between resets", () => {
  const w = new RunWatch(limits, clock().now);
  const same = { tool: "run", args: "pnpm test" };
  for (let i = 1; i < REPEAT_LIMIT; i++) assert.equal(w.step(same), undefined);
  assert.equal(w.step({ tool: "read", args: "f" }), undefined);
  for (let i = 1; i < REPEAT_LIMIT; i++) assert.equal(w.step(same), undefined);
  assert.equal(w.step(same), "repeat");
});

test("RunWatch: the request budget and the safety ceiling", async () => {
  const c = clock();
  const w = new RunWatch({ ...limits, maxRequests: 5 }, c.now);
  for (let i = 0; i < 4; i++) assert.equal(w.step({ tool: "t", args: i }), undefined);
  assert.equal(w.step({ tool: "t", args: 99 }), "budget");
  const w2 = new RunWatch(limits, c.now, async () => ({ fp: String(c.now()), files: [] })); // always changing: never a stall
  await w2.check(); // the first look
  for (let i = 0; i < 119; i++) {
    c.add(MIN);
    assert.equal(await w2.check(), undefined);
  }
  c.add(2 * MIN);
  assert.equal(await w2.check(), "ceiling");
});

test("stopNote: the English notes", () => {
  const o = { stallMinutes: 10, maxRequests: 80, ceilingMinutes: 120 };
  const n = (r: StopReason) => stopNote(r, o);
  assert.equal(n("stall"), "Stopped: no progress for 10 minutes.");
  assert.equal(n("budget"), "Stopped at the request budget (80).");
  assert.equal(n("ceiling"), "Stopped at the 120-minute safety limit.");
  assert.equal(n("repeat"), "Stopped: the same step repeated 4 times.");
});

function guardFor(hooks: Partial<GuardHooks>, c = clock(), fp = () => "a") {
  const log: string[] = [];
  const stops: StopReason[] = [];
  const w = new RunWatch(limits, c.now, async () => ({ fp: fp(), files: ["a.ts"] }));
  const g = new RunGuard(w, { log: (l) => log.push(l), stop: (r) => stops.push(r), ...hooks }, c.now);
  return { g, w, c, log, stops };
}

test("RunGuard: a stall without a helper stops at once", async () => {
  const { g, c, stops } = guardFor({});
  c.add(11 * MIN);
  await g.tick();
  assert.deepEqual(stops, ["stall"]);
  await g.tick();
  assert.deepEqual(stops, ["stall"]); // only once
});

test("RunGuard: a stall is rescued once (hint injected, one more window), the second stall stops", async () => {
  const hints: string[] = [];
  const asked: string[][] = [];
  const { g, c, stops, log } = guardFor({
    rescue: async ({ steps }) => (asked.push(steps), { hint: "Try editing a.ts line 3\nmore", model: "local-x" }),
    inject: async (h) => void hints.push(h),
  });
  g.step({ tool: "read", args: "a" });
  c.add(11 * MIN);
  await g.tick();
  assert.deepEqual(stops, []);
  assert.deepEqual(hints, ["Try editing a.ts line 3\nmore"]);
  assert.equal(asked[0]!.length, 1);
  assert.match(log[0]!, /^Rescued by local-x: Try editing a\.ts line 3$/);
  c.add(5 * MIN);
  await g.tick();
  assert.deepEqual(stops, []); // the new window
  c.add(6 * MIN);
  await g.tick();
  assert.deepEqual(stops, ["stall"]); // no second rescue
  assert.equal(hints.length, 1);
});

test("RunGuard: a repeat is rescued; no hint available stops; the budget never asks", async () => {
  const a = guardFor({ rescue: async () => ({ hint: "do x", model: "m" }), inject: async () => undefined });
  for (let i = 0; i < REPEAT_LIMIT; i++) a.g.step({ tool: "run", args: "same" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(a.stops, []);
  assert.equal(a.w.rescued, true);

  const b = guardFor({ rescue: async () => undefined, inject: async () => undefined });
  for (let i = 0; i < REPEAT_LIMIT; i++) b.g.step({ tool: "run", args: "same" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(b.stops, ["repeat"]);

  let asks = 0;
  const w = new RunWatch({ ...limits, maxRequests: 3 }, clock().now);
  const stops: StopReason[] = [];
  const g = new RunGuard(w, { log: () => undefined, stop: (r) => stops.push(r), rescue: async () => (asks++, undefined) }, () => 0);
  for (let i = 0; i < 3; i++) g.step({ tool: "t", args: i });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(stops, ["budget"]);
  assert.equal(asks, 0);
});

test("RunGuard: the watchdog never stops; stuck triggers the rescue early, off-task is kept for the reviewer", async () => {
  const c = clock();
  const verdicts = [{ state: "ok" as const, why: "" }, { state: "off-task" as const, why: "edits docs, not the button" }];
  let looks = 0;
  const hints: string[] = [];
  const { g, stops, log } = guardFor(
    {
      look: async () => verdicts[looks++],
      rescue: async () => ({ hint: "go back to the button", model: "free" }),
      inject: async (h) => void hints.push(h),
    },
    c,
    () => String(c.now()), // always changing, so no stall
  );
  c.add(3 * MIN);
  await g.tick(); // look 1: ok
  assert.equal(log.length, 0);
  c.add(3 * MIN);
  await g.tick(); // look 2: off-task
  assert.equal(g.offTask, "edits docs, not the button");
  assert.deepEqual(hints, ["go back to the button"]);
  assert.match(log[0]!, /^Watchdog: off-task — edits docs/);
  assert.deepEqual(stops, []);
  c.add(3 * MIN);
  looks = 1;
  await g.tick(); // third look: off-task again, but the rescue is used up: still no stop
  assert.deepEqual(stops, []);
});

test("RunGuard: a user's chat (no stop, no inject) is only advised, once, and never stopped", async () => {
  const advice: Array<{ reason: string; hint?: string }> = [];
  const c = clock();
  const log: string[] = [];
  const w = new RunWatch(limits, c.now, async () => ({ fp: "a", files: [] }));
  const g = new RunGuard(w, { log: (l) => log.push(l), rescue: async () => ({ hint: "check the config", model: "m" }), advise: (a) => advice.push(a) }, c.now);
  c.add(11 * MIN);
  await g.tick();
  c.add(11 * MIN);
  await g.tick();
  assert.deepEqual(advice, [{ reason: "stall", why: "no progress", hint: "check the config" }]);
  assert.equal(g.stopped, undefined);
  // The budget in a chat is advice too, not a stop.
  const g2 = new RunGuard(new RunWatch({ ...limits, maxRequests: 1 }, c.now), { log: () => undefined, advise: (a) => advice.push(a) }, c.now);
  g2.step({ tool: "t" });
  await new Promise((r) => setImmediate(r));
  assert.equal(advice.at(-1)!.reason, "budget");
  assert.equal(g2.stopped, undefined);
});

test("parseWatchVerdict and parseReview read JSON inside text; rubbish is undefined", () => {
  assert.deepEqual(parseWatchVerdict('```json\n{"state":"stuck","why":"loops on the same error"}\n```'), { state: "stuck", why: "loops on the same error" });
  assert.equal(parseWatchVerdict('{"state":"maybe"}'), undefined);
  assert.equal(parseWatchVerdict("all fine"), undefined);
  assert.deepEqual(parseReview('Sure: {"verdict":"reject","reasons":["touches unrelated files","no test"]}'), { verdict: "reject", reasons: ["touches unrelated files", "no test"] });
  assert.equal(parseReview('{"verdict":"great"}'), undefined);
});
