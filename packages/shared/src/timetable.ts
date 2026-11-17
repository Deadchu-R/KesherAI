/**
 * The weekly timetable (design Timetable, RESEARCH_LOG "Students, part 27" #3, like MyStudyLife): her classes by day
 * and hour, so Study knows when she is in class, reminds her to record when one starts, and files the recording
 * under the right course.
 */

/** A kind of class. */
export type ClassKind = "lecture" | "practice" | "lab";
export const CLASS_KINDS: ClassKind[] = ["lecture", "practice", "lab"];

/** One class in the week. */
export interface ClassSlot {
  id: string;
  courseId: string;
  /** 0 Sunday … 6 Saturday. */
  day: number;
  /** "HH:MM", 24 hours. */
  start: string;
  end: string;
  room?: string;
  kind?: ClassKind;
}

/** Her timetable. */
export interface Timetable {
  slots: ClassSlot[];
  /** A note when a class starts, to record it. */
  remind?: boolean;
  /** Also to the phone. */
  phone?: boolean;
  /** The last class reminded ("slotId@YYYY-MM-DD"), so each is reminded once. */
  lastReminded?: string;
  /** When she last changed it (ms), so the phone's and the computer's copies sync (the later one wins). */
  t?: number;
  /** Since when she tracks attendance (ms); without it, no class asks "were you there?". */
  trackSince?: number;
  /** Was she there (design Attendance, students part 41): "slotId@YYYY-MM-DD" → her mark. */
  attendance?: Record<string, AttendanceMark>;
  /** A course's attendance rule: at most this many absences, or at least this percent. */
  limits?: Record<string, AttendanceLimit>;
}

/** One class's mark: there, missed, missed with a reason (not counted), or the class did not take place. */
export type AttendanceMark = "here" | "absent" | "excused" | "cancelled";
export const ATTENDANCE_MARKS: AttendanceMark[] = ["here", "absent", "excused", "cancelled"];

/** A course's attendance rule (one of the two). */
export interface AttendanceLimit { absences?: number; percent?: number }

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const mins = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

/** Her timetable from the page, checked: at most 80 classes, times as HH:MM with the end after the start. */
export function cleanTimetable(raw: unknown): Timetable {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const slots = (Array.isArray(o.slots) ? o.slots : []).slice(0, 80).flatMap((s, i): ClassSlot[] => {
    const x = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
    const day = Number(x.day);
    const start = String(x.start ?? "");
    const end = String(x.end ?? "");
    if (typeof x.courseId !== "string" || !/^[\w-]{1,80}$/.test(x.courseId) || !(Number.isInteger(day) && day >= 0 && day <= 6) || !HM.test(start) || !HM.test(end) || mins(end) <= mins(start)) return [];
    const room = typeof x.room === "string" ? x.room.replace(/[\r\n]+/g, " ").trim().slice(0, 40) : "";
    return [{
      id: typeof x.id === "string" && /^[\w-]{1,40}$/.test(x.id) ? x.id : `t${i}${Date.now().toString(36)}`,
      courseId: x.courseId,
      day,
      start,
      end,
      ...(room ? { room } : {}),
      ...(CLASS_KINDS.includes(x.kind as ClassKind) ? { kind: x.kind as ClassKind } : {}),
    }];
  });
  return {
    slots,
    ...(o.remind === true ? { remind: true } : {}),
    ...(o.phone === true ? { phone: true } : {}),
    ...(typeof o.lastReminded === "string" && o.lastReminded.length <= 80 ? { lastReminded: o.lastReminded } : {}),
    ...(Number.isFinite(Number(o.t)) && Number(o.t) > 0 ? { t: Number(o.t) } : {}),
    ...(Number.isFinite(Number(o.trackSince)) && Number(o.trackSince) > 0 ? { trackSince: Number(o.trackSince) } : {}),
    ...cleanAttendance(o.attendance, o.limits),
  };
}

/** Attendance marks (at most 2000, the latest dates kept) and rules (absences 0–50, percent 1–100), checked. */
function cleanAttendance(rawMarks: unknown, rawLimits: unknown): Pick<Timetable, "attendance" | "limits"> {
  const marks = Object.entries(rawMarks && typeof rawMarks === "object" ? (rawMarks as Record<string, unknown>) : {})
    .filter(([k, v]) => /^[\w-]{1,40}@\d{4}-\d\d-\d\d$/.test(k) && ATTENDANCE_MARKS.includes(v as AttendanceMark))
    .sort((a, b) => b[0].slice(-10).localeCompare(a[0].slice(-10)))
    .slice(0, 2000);
  const limits: Record<string, AttendanceLimit> = {};
  for (const [k, v] of Object.entries(rawLimits && typeof rawLimits === "object" ? (rawLimits as Record<string, unknown>) : {}).slice(0, 100)) {
    if (!/^[\w-]{1,80}$/.test(k) || !v || typeof v !== "object") continue;
    const a = Number((v as AttendanceLimit).absences);
    const pc = Number((v as AttendanceLimit).percent);
    if (Number.isInteger(a) && a >= 0 && a <= 50) limits[k] = { absences: a };
    else if (Number.isFinite(pc) && pc >= 1 && pc <= 100) limits[k] = { percent: Math.round(pc) };
  }
  return { ...(marks.length ? { attendance: Object.fromEntries(marks) as Record<string, AttendanceMark> } : {}), ...(Object.keys(limits).length ? { limits } : {}) };
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * The classes of the last `days` days (today's once they ended) that she has not marked yet, newest first, so she can
 * say whether she was there (design Attendance). Only while she tracks it, and only classes since she started.
 */
export function classesToMark(t: Timetable, now: Date, days = 7): Array<{ slot: ClassSlot; date: string; key: string }> {
  const out: Array<{ slot: ClassSlot; date: string; key: string }> = [];
  const since = t.trackSince;
  if (!since) return out;
  const start = new Date(since);
  const first = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
  const m = now.getHours() * 60 + now.getMinutes();
  for (let back = 0; back < days; back++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, 12);
    if (d.getTime() < first) break;
    const date = ymd(d);
    for (const slot of classesOn(t, d.getDay()).reverse()) {
      if (back === 0 && mins(slot.end) > m) continue;
      const key = `${slot.id}@${date}`;
      if (!t.attendance?.[key]) out.push({ slot, date, key });
    }
  }
  return out;
}

/** A course's attendance: classes held (here + absent), there, missed, the percent, and what the rule leaves. */
export interface AttendanceSum { held: number; here: number; absent: number; excused: number; percent: number | undefined; limit?: AttendanceLimit; left?: number; warn: boolean; over: boolean }

/**
 * Sums a course's marks. With a rule: how many more absences are allowed (`left`), a warning at one left (or within
 * 5 points of the percent) and `over` once it is broken. A percent rule's `left` counts against the classes so far.
 */
export function attendanceFor(t: Timetable, courseId: string): AttendanceSum {
  const ids = new Set(t.slots.filter((s) => s.courseId === courseId).map((s) => s.id));
  let here = 0, absent = 0, excused = 0;
  for (const [k, v] of Object.entries(t.attendance ?? {})) {
    if (!ids.has(k.slice(0, k.indexOf("@")))) continue;
    if (v === "here") here++;
    else if (v === "absent") absent++;
    else if (v === "excused") excused++;
  }
  const held = here + absent;
  const percent = held ? Math.round((here / held) * 100) : undefined;
  const limit = t.limits?.[courseId];
  if (!limit) return { held, here, absent, excused, percent, warn: false, over: false };
  if (limit.absences !== undefined) {
    const left = limit.absences - absent;
    return { held, here, absent, excused, percent, limit, left: Math.max(0, left), warn: left <= 1, over: left < 0 };
  }
  const need = (limit.percent ?? 0) / 100;
  // Absences still allowed so far: the most a with here / (held + a) ≥ need, counting more absences as more classes.
  const left = need > 0 ? Math.floor(here / need - held + 1e-9) : 0;
  return { held, here, absent, excused, percent, limit, left: Math.max(0, left), warn: percent !== undefined && percent < (limit.percent ?? 0) + 5, over: percent !== undefined && percent < (limit.percent ?? 0) };
}

/**
 * The class she is in now, or the next one starting within `soon` minutes: with "now" or "soon" and the minutes
 * until it starts (soon) or ends (now).
 */
export function classNow(t: Timetable, now: Date, soon = 10): { slot: ClassSlot; state: "now" | "soon"; minutes: number } | undefined {
  const day = now.getDay();
  const m = now.getHours() * 60 + now.getMinutes();
  const today = t.slots.filter((s) => s.day === day).sort((a, b) => mins(a.start) - mins(b.start));
  const inClass = today.find((s) => mins(s.start) <= m && m < mins(s.end));
  if (inClass) return { slot: inClass, state: "now", minutes: mins(inClass.end) - m };
  const next = today.find((s) => mins(s.start) > m && mins(s.start) - m <= soon);
  return next ? { slot: next, state: "soon", minutes: mins(next.start) - m } : undefined;
}

/** The classes of a day, by time. */
export function classesOn(t: Timetable, day: number): ClassSlot[] {
  return t.slots.filter((s) => s.day === day).sort((a, b) => mins(a.start) - mins(b.start));
}

/**
 * Whether to remind her of a class now: reminders on, a class starting within 5 minutes (or started a minute ago),
 * not reminded yet. Returns the class and the key to keep.
 */
export function classRemindNow(t: Timetable, now: Date): { slot: ClassSlot; key: string } | undefined {
  if (!t.remind) return undefined;
  const m = now.getHours() * 60 + now.getMinutes();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const slot = classesOn(t, now.getDay()).find((s) => mins(s.start) - m <= 5 && m - mins(s.start) <= 1);
  if (!slot) return undefined;
  const key = `${slot.id}@${date}`;
  return t.lastReminded === key ? undefined : { slot, key };
}

/** A class read from a photo of her schedule (design TimetablePhoto, students part 31 #3), before she picks its course. */
export interface ReadClass { name: string; day: number; start: string; end: string; room?: string; kind?: ClassKind }

export const TIMETABLE_PHOTO_PROMPT = "You read a photo or screenshot of a student's weekly class schedule. List every class you can see: its course name exactly as written, the day (0 Sunday, 1 Monday … 6 Saturday; Hebrew days: א=0 ב=1 ג=2 ד=3 ה=4 ו=5), the start and end time as HH:MM (24 hours), the room if written, and the kind if written (lecture / practice for תרגול / lab for מעבדה). Answer with JSON only: [{\"name\":\"…\",\"day\":1,\"start\":\"10:00\",\"end\":\"12:00\",\"room\":\"…\",\"kind\":\"lecture\"}]. If it is not a schedule, answer [].";

/** The classes the model read, checked: valid days and times, end after start, at most 80. */
export function cleanReadClasses(raw: unknown): ReadClass[] {
  const pad = (t: string) => (/^\d:\d\d$/.test(t) ? `0${t}` : t);
  return (Array.isArray(raw) ? raw : []).slice(0, 80).flatMap((r): ReadClass[] => {
    const x = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const name = typeof x.name === "string" ? x.name.replace(/\s+/g, " ").trim().slice(0, 120) : "";
    const day = Number(x.day);
    const start = pad(String(x.start ?? "").trim());
    const end = pad(String(x.end ?? "").trim());
    if (!name || !(Number.isInteger(day) && day >= 0 && day <= 6) || !HM.test(start) || !HM.test(end) || mins(end) <= mins(start)) return [];
    const room = typeof x.room === "string" ? x.room.replace(/\s+/g, " ").trim().slice(0, 40) : "";
    const kind = CLASS_KINDS.includes(x.kind as ClassKind) ? (x.kind as ClassKind) : undefined;
    return [{ name, day, start, end, ...(room ? { room } : {}), ...(kind ? { kind } : {}) }];
  });
}

/**
 * When to study on a day around her classes (students part 37, like Reclaim.ai's free slots): for each length asked,
 * the earliest free time between `from` and `to` that does not overlap a class (with 15 minutes' rest after each
 * class) or a time already given; today, not before `now`. Undefined for one that does not fit.
 *
 * @param t - Her timetable.
 * @param date - The day, "YYYY-MM-DD".
 * @param minutes - The study pieces of that day, in order.
 * @param opts - The day's window ("HH:MM") and the current time.
 */
export function freeSlots(t: Timetable, date: string, minutes: number[], opts: { from?: string; to?: string; now?: Date } = {}): Array<string | undefined> {
  const day = new Date(`${date}T12:00`).getDay();
  const now = opts.now ?? new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  let start = mins(opts.from ?? "16:00");
  const end = mins(opts.to ?? "22:00");
  if (date === today) start = Math.max(start, Math.ceil((now.getHours() * 60 + now.getMinutes()) / 15) * 15);
  const busy = classesOn(t, day).map((s) => [mins(s.start), mins(s.end) + 15] as [number, number]);
  const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return minutes.map((len) => {
    let at = start;
    for (;;) {
      if (at + len > end) return undefined;
      const hit = busy.find(([a, b]) => at < b && at + len > a);
      if (!hit) break;
      at = hit[1];
    }
    busy.push([at, at + len + 10]);
    return hm(at);
  });
}
