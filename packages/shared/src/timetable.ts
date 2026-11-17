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
}

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
  };
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
