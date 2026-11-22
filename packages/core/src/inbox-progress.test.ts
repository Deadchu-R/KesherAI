import { test } from "node:test";
import assert from "node:assert/strict";
import { pastMinutes, progressNote, progressRef, ProgressTicker, textBar, type ProgressNote, type ProgressTask } from "./inbox-progress.js";
import { phoneMessage } from "./phone-push.js";

const MIN = 60_000;
const task = (o: Partial<ProgressTask> = {}): ProgressTask => ({ id: "c-1", title: "Clear all downloads", status: "running", startedAt: 0, maxMinutes: 60, runBy: "antigravity", maxFiles: 5, goal: "Add a button", check: "git status", ...o });

test("progress note: from the plan (bar, step, done and left, time from the pace so far)", () => {
  const plan = [
    { content: "Read the page", status: "completed" },
    { content: "Add the button", status: "completed" },
    { content: "Wire   the\nstore", status: "in_progress" },
    { content: "Test", status: "pending" },
    { content: "Report", status: "pending" },
  ];
  const n = progressNote(task({ plan }), 4 * MIN);
  assert.equal(n.ref, progressRef("c-1"));
  assert.equal(n.ref, "agy-c-1");
  assert.match(n.title, /^✦ אנטיגרוויטי: Clear all downloads$/);
  const lines = n.body.split("\n");
  assert.equal(lines[0], "▓▓░░░ 2/5 · ~6 דק'", "2 entries in 4 minutes: 3 left take about 6");
  assert.equal(lines[1], "שלב: Wire the store");
  assert.match(lines[2]!, /Running/);
  assert.equal(lines[3], "2 בוצעו · 3 נותרו");
  assert.deepEqual(n.progress, { v: 2, max: 5 });
});

test("progress note: no plan, past runs of the same kind; never past the minute limit; waiting for an approval", () => {
  const past = [10, 20, 30].map((m, i) => ({ runBy: "antigravity" as const, kind: undefined, status: "done" as const, startedAt: (i + 1) * 100 * MIN, endedAt: (i + 1) * 100 * MIN + m * MIN }));
  assert.equal(pastMinutes(past, undefined), 20);
  assert.equal(pastMinutes(past, "research"), undefined, "another kind does not count");
  const n = progressNote(task({ steps: 3 }), 5 * MIN, past);
  assert.match(n.body.split("\n")[0]!, /3\/\d+ · ~15 דק'$/, "20 typical minus 5 so far");
  const late = progressNote(task({ steps: 3, maxMinutes: 8 }), 5 * MIN, past);
  assert.match(late.body, /~3 דק'/, "capped at the task's limit");
  const waits = progressNote(task({ status: "needs-approval" }), MIN);
  assert.match(waits.body, /מחכה לאישור/);
  assert.notEqual(waits.key, progressNote(task(), MIN).key, "an approval wait is a new step");
  assert.equal(textBar(0), "░░░░░");
  assert.equal(textBar(1), "▓▓▓▓▓");
});

test("progress ticker: at once on a step change, else at most every 20 s; nothing after stop", () => {
  let now = 0;
  const t = task({ plan: [{ content: "A", status: "in_progress" }, { content: "B", status: "pending" }] });
  const sent: ProgressNote[] = [];
  const k = new ProgressTicker(() => ({ t, past: [] }), (n) => sent.push(n), () => now);
  k.tick(true);
  assert.equal(sent.length, 1);
  now = 5_000;
  k.tick();
  assert.equal(sent.length, 1, "same step, 5 s later: nothing");
  t.plan = [{ content: "A", status: "completed" }, { content: "B", status: "in_progress" }];
  k.tick();
  assert.equal(sent.length, 2, "a new step goes at once");
  now = 6_000;
  t.plan = [{ content: "A", status: "completed" }, { content: "B", status: "completed" }];
  k.tick();
  assert.equal(sent.length, 2, "a burst within 3 s waits");
  now = 30_000;
  k.tick();
  assert.equal(sent.length, 3);
  k.stop();
  now = 90_000;
  t.plan = [];
  k.tick();
  assert.equal(sent.length, 3, "stopped");
});

test("progress on the phone: the same id as the freed-slot note, and the native bar's numbers", () => {
  const m = phoneMessage({ title: "x", body: "▓▓░░░ 2/5", ref: progressRef("c-1"), tags: ["inbox_tray"], progress: { v: 2, max: 5 } });
  assert.equal(m.id, "agy-c-1");
  assert.equal(m.ch, "downloads", "quiet channel");
  assert.deepEqual(m.pg, { v: 2, max: 5 });
  assert.equal(phoneMessage({ title: "x", body: "y" }).pg, undefined);
});
