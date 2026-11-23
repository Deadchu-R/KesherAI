import { test } from "node:test";
import assert from "node:assert/strict";
import { dailySummary, localDay, loopState, nextLocalMidnight, standingDue, summaryDue } from "./work-loop.js";

/** The work loop's decisions with a fake clock. Times are built in local time, so the tests pass in any time zone. */

const at = (h: number, m = 0, day = 23) => new Date(2026, 10, day, h, m).getTime();
const FAMILIES = ["opus", "sonnet", "flash"];
const base = { on: true, inboxOn: true, families: FAMILIES, capReached: false };

test("loop: running, off (switch or inbox), and paused until the quota's reset", () => {
  const now = at(10);
  assert.deepEqual(loopState({ ...base, now }), { state: "running" });
  assert.deepEqual(loopState({ ...base, on: false, now }), { state: "off" });
  assert.deepEqual(loopState({ ...base, inboxOn: false, now }), { state: "off" });
  assert.deepEqual(loopState({ ...base, quotaUntil: at(14, 30), now }), { state: "paused", until: at(14, 30), why: "quota" });
  // A quota that already ended does not pause.
  assert.deepEqual(loopState({ ...base, quotaUntil: at(9), now }), { state: "running" });
});

test("loop: paused only when every model family is out, until the first one is back", () => {
  const now = at(10);
  assert.equal(loopState({ ...base, familyUntil: { opus: at(12), sonnet: at(12) }, now }).state, "running");
  assert.deepEqual(loopState({ ...base, familyUntil: { opus: at(12), sonnet: at(13), flash: at(11) }, now }), { state: "paused", until: at(11), why: "models" });
});

test("loop: today's cap pauses until local midnight; with a later quota, the later end wins", () => {
  const now = at(18);
  assert.deepEqual(loopState({ ...base, capReached: true, now }), { state: "paused", until: at(0, 0, 24), why: "cap" });
  assert.deepEqual(loopState({ ...base, capReached: true, quotaUntil: at(3, 0, 24), now }), { state: "paused", until: at(3, 0, 24), why: "quota" });
  assert.equal(nextLocalMidnight(at(23, 59)), at(0, 0, 24));
});

test("loop: the standing task is offered once a day, only with an empty backlog, idle and running", () => {
  const ok = { running: true, backlogEmpty: true, idle: true, now: at(9) };
  assert.equal(standingDue(ok), true);
  assert.equal(standingDue({ ...ok, lastDay: localDay(at(1)) }), false, "already today");
  assert.equal(standingDue({ ...ok, lastDay: localDay(at(22, 0, 22)) }), true, "yesterday's does not count");
  assert.equal(standingDue({ ...ok, backlogEmpty: false }), false);
  assert.equal(standingDue({ ...ok, idle: false }), false);
  assert.equal(standingDue({ ...ok, running: false }), false, "paused (quota) or off");
});

test("loop: the summary is due from 21:00, once a day; a PC off at 21:00 sends it later that evening", () => {
  assert.equal(summaryDue(at(20, 59), undefined), false);
  assert.equal(summaryDue(at(21), undefined), true);
  assert.equal(summaryDue(at(23, 10), undefined), true);
  assert.equal(summaryDue(at(21, 5), localDay(at(21))), false, "already sent today");
  assert.equal(summaryDue(at(8, 0, 24), localDay(at(21))), false, "next morning waits for the evening");
  assert.equal(summaryDue(at(21, 0, 24), localDay(at(21))), true);
});

test("loop: the summary counts done, failed and branches to review since the last one, and names what is next", () => {
  const since = at(21, 0, 22);
  const tasks = [
    { id: "a", title: "A", status: "done" as const, endedAt: at(10), pushed: true, runBy: "antigravity" as const },
    { id: "b", title: "B", status: "partial" as const, endedAt: at(11), pushed: true, merged: "abc", runBy: "opencode" as const },
    { id: "c", title: "C", status: "failed" as const, endedAt: at(12), runBy: "local" as const },
    { id: "d", title: "D", status: "done" as const, endedAt: at(10, 0, 20), runBy: "antigravity" as const },
  ];
  const n = dailySummary({ tasks, next: ["Next one", "Second"], since, state: { state: "running" } });
  assert.match(n.title, /2 הושלמו · 1 נכשלו · 1 ענפים לבדיקה/);
  assert.match(n.body, /2 done, 1 failed, 1 branches to review\./);
  assert.match(n.body, /Next: Next one · Second/);
  const p = dailySummary({ tasks: [], next: [], since, state: { state: "paused", until: at(23, 30), why: "quota" } });
  assert.match(p.body, /paused until 23:30/);
  assert.match(p.body, /Nothing in line/);
});
