import { test } from "node:test";
import assert from "node:assert/strict";
import { agoText, awayText, cleanAwayNote, computerState } from "./device-status.js";

const now = Date.parse("2026-11-21T12:00:00Z");

test("status: answering is online, a sleep message makes it asleep, the rest is offline", () => {
  assert.equal(computerState({ online: true }), "online");
  assert.equal(computerState({ online: true, asleepSince: "2026-11-21T11:00:00Z" }), "online", "back wins over an old sleep mark");
  assert.equal(computerState({ online: false, asleepSince: "2026-11-21T11:58:00Z" }), "asleep");
  assert.equal(computerState({ online: false }), "offline", "an older computer never says it sleeps");
});

test("the away note keeps counts and the self-work flag only", () => {
  assert.deepEqual(cleanAwayNote({ downloads: 3.9, tasks: 0, selfWork: "yes", x: 1 }), { downloads: 3 });
  assert.deepEqual(cleanAwayNote({ downloads: 1e9, selfWork: true }), { downloads: 9999, selfWork: true });
  assert.deepEqual(cleanAwayNote(null), {});
});

test("the sleep line, Hebrew and English, with what was running", () => {
  const at = "2026-11-21T11:58:00Z";
  assert.equal(awayText({ at }, now, false), "PC went to sleep · 2 min ago");
  assert.equal(awayText({ at }, now, true), "המחשב נכנס לשינה · לפני 2 דק'");
  assert.equal(awayText({ at, note: { downloads: 3 } }, now, false), "PC went to sleep · 2 min ago · 3 downloads paused");
  assert.equal(awayText({ at, note: { downloads: 3, selfWork: true } }, now, true), "המחשב נכנס לשינה · לפני 2 דק' · 3 הורדות מושהות · עבודה עצמית נעצרה");
  assert.equal(awayText({ at, note: { tasks: 1 } }, now, false), "PC went to sleep · 2 min ago · 1 task stopped");
  assert.equal(awayText({}, now, false), "PC went to sleep");
});

test("ago: minutes, hours, days", () => {
  assert.equal(agoText("2026-11-21T11:59:40Z", now, false), "just now");
  assert.equal(agoText("2026-11-21T09:00:00Z", now, true), "לפני 3 שע'");
  assert.equal(agoText("2026-11-18T12:00:00Z", now, false), "3 days ago");
  assert.equal(agoText("nope", now, false), "");
});

test("an away note for an update keeps a version only, and says restarting instead of sleep", () => {
  assert.deepEqual(cleanAwayNote({ update: "0.6.498", tasks: 1 }), { tasks: 1, update: "0.6.498" });
  assert.deepEqual(cleanAwayNote({ update: "0.6.498; rm -rf" }), {});
  const now = Date.parse("2026-11-27T15:52:00Z");
  assert.equal(awayText({ at: "2026-11-27T15:50:00Z", note: { update: "0.6.498" } }, now, false), "PC restarting for update 0.6.498 · 2 min ago");
  assert.match(awayText({ at: "2026-11-27T15:50:00Z", note: { update: "0.6.498" } }, now, true), /^המחשב מופעל מחדש לעדכון 0\.6\.498/);
});
