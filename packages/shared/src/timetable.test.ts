import { test } from "node:test";
import assert from "node:assert/strict";
import { classNow, classRemindNow, classesOn, cleanTimetable } from "./timetable.js";

const t = cleanTimetable({
  slots: [
    { id: "a", courseId: "c1", day: 0, start: "10:00", end: "12:00", room: " 101 ", kind: "lecture" },
    { id: "b", courseId: "c2", day: 0, start: "08:30", end: "10:00" },
    { id: "bad", courseId: "c2", day: 0, start: "12:00", end: "11:00" },
    { courseId: "../x", day: 1, start: "09:00", end: "10:00" },
    { courseId: "c3", day: 9, start: "09:00", end: "10:00" },
  ],
  remind: true,
});
// Sunday 15 Nov 2026.
const at = (h: number, m: number) => new Date(2026, 10, 15, h, m);

test("cleanTimetable keeps only real classes", () => {
  assert.deepEqual(t.slots.map((s) => s.id), ["a", "b"]);
  assert.equal(t.slots[0]!.room, "101");
  assert.deepEqual(classesOn(t, 0).map((s) => s.id), ["b", "a"]);
});

test("the class now, or soon", () => {
  assert.deepEqual(classNow(t, at(10, 30)), { slot: t.slots[0], state: "now", minutes: 90 });
  // At 10:00 the first ends and the second starts: she is in the second.
  assert.equal(classNow(t, at(10, 0))?.slot.id, "a");
  assert.deepEqual(classNow(t, at(8, 25)), { slot: t.slots[1], state: "soon", minutes: 5 });
  assert.equal(classNow(t, at(7, 0)), undefined);
  assert.equal(classNow(t, at(13, 0)), undefined);
});

test("a reminder once per class a day, only when on", () => {
  const r = classRemindNow(t, at(9, 56))!;
  assert.equal(r.slot.id, "a");
  assert.equal(r.key, "a@2026-11-15");
  assert.equal(classRemindNow({ ...t, lastReminded: r.key }, at(9, 57)), undefined);
  assert.equal(classRemindNow(t, at(10, 5)), undefined);
  assert.equal(classRemindNow({ ...t, remind: false }, at(9, 56)), undefined);
});

test("classes read from a schedule photo are checked", async () => {
  const { cleanReadClasses } = await import("./timetable.js");
  assert.deepEqual(cleanReadClasses([
    { name: " פיזיולוגיה  א ", day: 1, start: "8:30", end: "10:00", room: "קפלן 3", kind: "lecture" },
    { name: "בלי זמן", day: 2, start: "x", end: "11:00" },
    { name: "סוף לפני התחלה", day: 2, start: "12:00", end: "11:00" },
    { name: "יום רע", day: 9, start: "10:00", end: "11:00" },
    { name: "תרגול", day: 3, start: "14:00", end: "15:30", kind: "seminar" },
  ]), [
    { name: "פיזיולוגיה א", day: 1, start: "08:30", end: "10:00", room: "קפלן 3", kind: "lecture" },
    { name: "תרגול", day: 3, start: "14:00", end: "15:30" },
  ]);
  assert.deepEqual(cleanReadClasses("no"), []);
});
