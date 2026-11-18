import { test } from "node:test";
import assert from "node:assert/strict";
import { attendanceAskNow, attendanceFor, classNow, classRemindNow, classesOn, classesToMark, cleanTimetable, freeSlots } from "./timetable.js";

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

test("freeSlots: study time after classes, not on top of them or of each other", () => {
  const t = cleanTimetable({ slots: [{ id: "a", courseId: "c1", day: 2, start: "16:00", end: "18:00" }] });
  // 2026-11-17 is a Tuesday (day 2).
  assert.deepEqual(freeSlots(t, "2026-11-17", [45, 30], { now: new Date("2026-11-10T09:00") }), ["18:15", "19:10"]);
  assert.deepEqual(freeSlots(t, "2026-11-18", [60], { now: new Date("2026-11-10T09:00") }), ["16:00"]);
  assert.deepEqual(freeSlots(t, "2026-11-17", [400], { now: new Date("2026-11-10T09:00") }), [undefined]);
});

test("attendance: marks and rules are checked, unmarked classes listed, sums and what is left", () => {
  const tt = cleanTimetable({
    slots: [{ id: "a", courseId: "anat", day: 0, start: "10:00", end: "12:00" }, { id: "b", courseId: "anat", day: 2, start: "08:00", end: "10:00" }, { id: "p", courseId: "pharm", day: 0, start: "14:00", end: "16:00" }],
    attendance: { "a@2026-11-15": "here", "b@2026-11-10": "absent", "a@2026-11-08": "here", "a@2026-11-01": "excused", "bad key": "here", "a@2026-11-02": "maybe" },
    limits: { anat: { absences: 2 }, pharm: { percent: 80 }, "../x": { absences: 1 }, big: { absences: 99 } },
    trackSince: new Date(2026, 10, 9, 9).getTime(),
  });
  assert.deepEqual(Object.keys(tt.attendance!).sort(), ["a@2026-11-01", "a@2026-11-08", "a@2026-11-15", "b@2026-11-10"]);
  assert.deepEqual(tt.limits, { anat: { absences: 2 }, pharm: { percent: 80 } });
  const anat = attendanceFor(tt, "anat");
  assert.deepEqual([anat.held, anat.here, anat.absent, anat.excused, anat.percent, anat.left, anat.warn, anat.over], [3, 2, 1, 1, 67, 1, true, false]);
  // Sunday 2026-11-15 at 13:00: the 10:00 class ended (marked), 14:00 not yet; Tuesday the 10th's class is marked.
  const now = new Date(2026, 10, 15, 13, 0);
  const todo = classesToMark(tt, now, 7);
  assert.deepEqual(todo, []);
  const later = classesToMark(tt, new Date(2026, 10, 15, 17, 0), 7);
  assert.deepEqual(later.map((x) => x.key), ["p@2026-11-15"]);
  // Not tracking: nothing asks; tracking since today: only today's classes.
  assert.deepEqual(classesToMark({ ...tt, trackSince: undefined } as never, new Date(2026, 10, 15, 17, 0)), []);
  assert.deepEqual(classesToMark({ ...tt, attendance: {}, trackSince: new Date(2026, 10, 15, 9).getTime() }, new Date(2026, 10, 15, 17, 0)).map((x) => x.key), ["p@2026-11-15", "a@2026-11-15"]);
  // A percent rule: 4 of 5 at 80% leaves no more absences; one more class there leaves one.
  const pc = cleanTimetable({ slots: tt.slots, limits: { pharm: { percent: 80 } }, attendance: { "p@2026-11-01": "here", "p@2026-11-02": "here", "p@2026-11-03": "here", "p@2026-11-04": "here", "p@2026-11-05": "absent" } });
  assert.equal(attendanceFor(pc, "pharm").left, 0);
  assert.equal(attendanceFor(cleanTimetable({ ...pc, attendance: { ...pc.attendance, "p@2026-11-06": "here" } }), "pharm").left, 0);
  assert.equal(attendanceFor(cleanTimetable({ ...pc, attendance: { ...pc.attendance, "p@2026-11-06": "here", "p@2026-11-07": "here", "p@2026-11-08": "here", "p@2026-11-09": "here", "p@2026-11-10": "here" } }), "pharm").left, 1);
  assert.equal(attendanceFor(tt, "none").held, 0);
});

test("cleanTimetable keeps a positive time stamp t and drops a bad one", () => {
  assert.equal(cleanTimetable({ t: 123 }).t, 123);
  assert.equal(cleanTimetable({ t: "123" }).t, 123);
  assert.equal(cleanTimetable({ t: 0 }).t, undefined);
  assert.equal(cleanTimetable({ t: -1 }).t, undefined);
  assert.equal(cleanTimetable({ t: "abc" }).t, undefined);
});

test("attendanceAskNow: 5–15 minutes after a class of a course with a rule, once unmarked", () => {
  const tt = cleanTimetable({ slots: [{ id: "a", courseId: "anat", day: 0, start: "10:00", end: "12:00" }, { id: "p", courseId: "pharm", day: 0, start: "12:00", end: "13:00" }], limits: { anat: { absences: 2 } }, trackSince: 1 });
  assert.equal(attendanceAskNow(tt, new Date(2026, 10, 15, 12, 3)), undefined);
  assert.equal(attendanceAskNow(tt, new Date(2026, 10, 15, 12, 6))?.key, "a@2026-11-15");
  assert.equal(attendanceAskNow(tt, new Date(2026, 10, 15, 13, 8)), undefined, "pharm has no rule");
  assert.equal(attendanceAskNow({ ...tt, attendance: { "a@2026-11-15": "here" } }, new Date(2026, 10, 15, 12, 6)), undefined);
  assert.equal(attendanceAskNow({ ...tt, trackSince: undefined } as never, new Date(2026, 10, 15, 12, 6)), undefined);
});
