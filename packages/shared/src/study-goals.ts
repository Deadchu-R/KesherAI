/**
 * Study: focus sessions, streaks, badges, the daily goal and the week's recap.
 * Re-exported by study.ts, so everything imports it from there as before.
 */

import { topicMastery, type StudyCard, type StudyCourseData, type StudyQuestion, type StudyReview } from "./study.js";

/** A finished focus-timer session (minutes actually focused). */
export interface StudyFocus {
  t: number;
  minutes: number;
}

/** A day as YYYY-MM-DD in the device's own time zone (Israel time on her phone and computer). */
export const dayKey = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** The days she studied: a focus session or a card review that day, across all her courses. */
export function studyDays(courses: StudyCourseData[]): Set<string> {
  const days = new Set<string>();
  for (const d of courses) {
    for (const f of d.focus ?? []) days.add(dayKey(f.t));
    for (const r of d.reviews) days.add(dayKey(r.t));
  }
  return days;
}

/**
 * Her study streak: days in a row she studied, where one missed day in any seven keeps the chain (a "shield", so
 * one bad day is not punished). Today counts once she studies; until then the streak runs to yesterday.
 *
 * @param days - The days she studied (studyDays).
 * @param now - Now.
 * @returns The streak in days, whether today is done, and whether a shield was used this week.
 */
export function studyStreak(days: Set<string>, now = Date.now()): { days: number; today: boolean; shield: boolean } {
  const DAY = 86_400_000;
  const today = days.has(dayKey(now));
  let n = 0;
  let shieldAt = -Infinity;
  let shield = false;
  // From today (or yesterday when today is not done yet) back, day by day.
  for (let i = today ? 0 : 1; i < 3660; i++) {
    if (days.has(dayKey(now - i * DAY))) { n++; continue; }
    // A missed day: covered when the last shield was more than 7 days ago and the day before was studied.
    if (i - shieldAt >= 7 && days.has(dayKey(now - (i + 1) * DAY)) && n > 0) {
      shieldAt = i;
      if (i < 7) shield = true;
      continue;
    }
    break;
  }
  return { days: n, today, shield };
}

/**
 * "My mistakes" (design MyMistakes, like Duolingo's practice hub): the cards she forgot and the multiple-choice
 * questions she got wrong in the last days, newest first. A card she has since remembered twice in a row is left out.
 *
 * @param d - The course.
 * @param now - Now.
 * @param days - How far back.
 */
export function recentMistakes(d: StudyCourseData, now = Date.now(), days = 30): { cards: StudyCard[]; questions: Array<StudyQuestion & { t: number }> } {
  const from = now - days * 86_400_000;
  const byCard = new Map<string, StudyReview[]>();
  for (const r of d.reviews) if (r.t >= from) (byCard.get(r.cardId) ?? byCard.set(r.cardId, []).get(r.cardId)!).push(r);
  const cards: Array<{ c: StudyCard; t: number }> = [];
  for (const [id, rs] of byCard) {
    rs.sort((a, b) => a.t - b.t);
    const lastMiss = rs.findLastIndex((r) => r.rating === 1);
    if (lastMiss < 0) continue;
    const after = rs.slice(lastMiss + 1);
    if (after.length >= 2 && after.slice(-2).every((r) => r.rating >= 3)) continue;
    const c = d.cards.find((x) => x.id === id);
    // A confident mistake first (students part 27 #4): corrected, it is the one that sticks best.
    if (c) cards.push({ c, t: rs[lastMiss]!.t + (rs[lastMiss]!.sure ? 1e13 : 0) });
  }
  const seen = new Set<string>();
  const questions: Array<StudyQuestion & { t: number }> = [];
  for (const z of [...d.quizzes].sort((a, b) => b.t - a.t)) {
    if (z.t < from || !z.answers || z.kind) continue;
    z.questions.forEach((q, i) => {
      if (q.answer < 0 || z.answers![i] === q.answer || seen.has(q.q)) return;
      seen.add(q.q);
      questions.push({ ...q, t: z.t });
    });
  }
  return { cards: cards.sort((a, b) => b.t - a.t).map((x) => x.c).slice(0, 40), questions: questions.slice(0, 30) };
}

/**
 * The week in one card (RESEARCH_LOG students part 25 #6): the last 7 days' focus minutes, cards, new lectures,
 * quizzes and summaries, how many days she studied, and the topics that rose or dropped 10+ points.
 *
 * @param courses - Her courses.
 * @param activity - What she did.
 * @param now - Now.
 */
export function weekRecap(courses: StudyCourseData[], activity: StudyActivity[], now = Date.now()): { counts: Record<GoalKind, number>; days: number; rose: Array<{ course: string; title: string; change: number }>; dropped: Array<{ course: string; title: string; change: number }> } {
  const days = goalCounts(courses, activity);
  const counts: Record<GoalKind, number> = { minutes: 0, cards: 0, lectures: 0, videos: 0, quizzes: 0, summaries: 0 };
  let studied = 0;
  for (let i = 0; i < 7; i++) {
    const c = days.get(dayKey(now - i * 86_400_000));
    if (!c) continue;
    let any = false;
    for (const k of GOAL_KINDS) {
      counts[k] += c[k];
      if (c[k]) any = true;
    }
    if (any) studied++;
  }
  const moved = courses.flatMap((d) => topicMastery(d.cards, d.reviews, d.quizzes, now).map((m) => ({ course: d.course.name, title: d.lectures.find((l) => l.id === m.lectureId)?.title ?? "", change: m.change }))).filter((m) => m.title);
  return {
    counts,
    days: studied,
    rose: moved.filter((m) => m.change >= 10).sort((a, b) => b.change - a.change).slice(0, 3),
    dropped: moved.filter((m) => m.change <= -10).sort((a, b) => a.change - b.change).slice(0, 3),
  };
}

/** A milestone she reached (students part 25 #9). */
export interface StudyBadge { id: string; icon: string; he: string; en: string }

/**
 * Her milestones, from her own data: a first lecture, summary and quiz, 100 and 1,000 cards reviewed, 7- and 30-day
 * streaks, 10 hours of focus, and a lecture or a whole course at mastery 80+.
 *
 * @param courses - Her courses.
 * @param activity - What she did.
 * @param streakDays - Her study streak now.
 * @param now - Now.
 */
export function studyBadges(courses: StudyCourseData[], activity: StudyActivity[], streakDays: number, now = Date.now()): StudyBadge[] {
  const out: StudyBadge[] = [];
  const add = (ok: boolean, id: string, icon: string, he: string, en: string) => ok && out.push({ id, icon, he, en });
  const reviews = courses.reduce((n, d) => n + d.reviews.length, 0);
  const minutes = courses.reduce((n, d) => n + (d.focus ?? []).reduce((m, f) => m + f.minutes, 0), 0);
  const quizzes = courses.reduce((n, d) => n + d.quizzes.filter((z) => z.answers || z.marks).length, 0);
  const crowns = courses.map((d) => ({ d, m: topicMastery(d.cards, d.reviews, d.quizzes, now) }));
  add(courses.some((d) => d.lectures.length > 0), "first-lecture", "🌱", "הרצאה ראשונה", "First lecture");
  add(courses.some((d) => d.lectures.some((l) => l.summary)), "first-summary", "📝", "סיכום ראשון", "First summary");
  add(quizzes > 0, "first-quiz", "❓", "בוחן ראשון", "First quiz");
  add(quizzes >= 10, "ten-quizzes", "🧠", "10 בחנים", "10 quizzes");
  add(reviews >= 100, "cards-100", "🃏", "100 כרטיסיות", "100 cards");
  add(reviews >= 1000, "cards-1000", "🏅", "1,000 כרטיסיות", "1,000 cards");
  add(minutes >= 600, "focus-10h", "⏳", "10 שעות ריכוז", "10 hours of focus");
  add(streakDays >= 7, "streak-7", "🔥", "שבוע ברצף", "A week in a row");
  add(streakDays >= 30, "streak-30", "🌟", "30 ימים ברצף", "30 days in a row");
  add(crowns.some((c) => c.m.some((x) => x.mastery >= 80)), "crown", "👑", "כתר ראשון", "First crown");
  add(crowns.some((c) => c.d.lectures.length >= 3 && c.d.lectures.every((l) => c.m.some((x) => x.lectureId === l.id && x.mastery >= 80))), "course-mastered", "🏆", "קורס שלם בשליטה", "A whole course mastered");
  add(activity.some((a) => a.kind === "videos"), "first-video", "🎞", "סרטון ראשון עד הסוף", "First video to the end");
  return out;
}

/** What a daily goal can count (Roee, 2026-11-17: minutes, lectures, videos, scripts…). */
export type GoalKind = "minutes" | "cards" | "lectures" | "videos" | "quizzes" | "summaries";
export const GOAL_KINDS: GoalKind[] = ["minutes", "cards", "lectures", "videos", "quizzes", "summaries"];

/**
 * Her daily goal (design DailyGoal, like Duolingo's). Off until she turns it on in Settings → Study; then any mix of
 * targets a day, a reminder time, and whether the reminder also goes to the phone.
 */
export interface StudyGoal {
  on: boolean;
  /** How many of each a day; a missing or 0 kind is not part of the goal. */
  targets: Partial<Record<GoalKind, number>>;
  /** "HH:MM" on this computer's clock, or absent for no reminder. */
  remind?: string;
  /** The reminder also goes to the phone. */
  phone?: boolean;
}

/** Off until she turns it on. */
export const GOAL_DEFAULTS: StudyGoal = { on: false, targets: { minutes: 30 } };

/** Something she did that a goal can count (kept by Study): a lecture added, a video watched, a quiz done, a summary. */
export interface StudyActivity { t: number; kind: Exclude<GoalKind, "minutes" | "cards"> }

/** How much of each kind she did on each day (dayKey → counts). */
export function goalCounts(courses: StudyCourseData[], activity: StudyActivity[]): Map<string, Record<GoalKind, number>> {
  const days = new Map<string, Record<GoalKind, number>>();
  const at = (t: number) => {
    const k = dayKey(t);
    let d = days.get(k);
    if (!d) days.set(k, (d = { minutes: 0, cards: 0, lectures: 0, videos: 0, quizzes: 0, summaries: 0 }));
    return d;
  };
  for (const c of courses) {
    for (const f of c.focus ?? []) at(f.t).minutes += f.minutes;
    for (const r of c.reviews) at(r.t).cards++;
  }
  for (const a of activity) at(a.t)[a.kind]++;
  return days;
}

/** How she felt a day ("how am I today", design FocusComfort): a low day asks half. */
export type StudyEnergy = "high" | "ok" | "low";

/** The day's targets: half (rounded up) on a low-energy day. */
export function dayTargets(goal: StudyGoal, energy?: StudyEnergy): Partial<Record<GoalKind, number>> {
  if (energy !== "low") return goal.targets;
  return Object.fromEntries(Object.entries(goal.targets).map(([k, v]) => [k, v ? Math.max(1, Math.ceil(v / 2)) : 0]));
}

/** Whether a day's counts reach every target of the goal (half of it on a low-energy day). */
export function goalMet(goal: StudyGoal, counts: Record<GoalKind, number> | undefined, energy?: StudyEnergy): boolean {
  const t = dayTargets(goal, energy);
  const kinds = GOAL_KINDS.filter((k) => (t[k] ?? 0) > 0);
  return kinds.length > 0 && kinds.every((k) => (counts?.[k] ?? 0) >= t[k]!);
}

/**
 * Today against the goal, and the goal streak: days in a row the whole goal was reached, counted back from today (or
 * from yesterday while today is not reached yet).
 *
 * @param courses - Her courses.
 * @param activity - What she did (lectures, videos, quizzes, summaries).
 * @param goal - The goal.
 * @param now - Now.
 */
export function goalToday(courses: StudyCourseData[], activity: StudyActivity[], goal: StudyGoal, now = Date.now(), energy: Record<string, StudyEnergy> = {}): { counts: Record<GoalKind, number>; done: boolean; streak: number; targets: Partial<Record<GoalKind, number>>; energy?: StudyEnergy } {
  const days = goalCounts(courses, activity);
  const counts = days.get(dayKey(now)) ?? { minutes: 0, cards: 0, lectures: 0, videos: 0, quizzes: 0, summaries: 0 };
  const today = energy[dayKey(now)];
  const done = goalMet(goal, counts, today);
  let streak = 0;
  // Noon steps, so a clock change never skips or repeats a day.
  const noon = new Date(now);
  noon.setHours(12, 0, 0, 0);
  for (let i = done ? 0 : 1; i < 3650; i++) {
    const k = dayKey(noon.getTime() - i * 86_400_000);
    if (!goalMet(goal, days.get(k), energy[k])) break;
    streak++;
  }
  return { counts, done, streak, targets: dayTargets(goal, today), ...(today ? { energy: today } : {}) };
}

/**
 * Whether to remind her now: the goal is on, a reminder time is set and has passed today, the goal is not reached,
 * and no reminder went today yet.
 *
 * @param goal - The goal.
 * @param done - Whether today's goal is reached.
 * @param lastDay - The day of the last reminder (dayKey), if any.
 * @param now - Now (local time).
 */
export function goalRemindNow(goal: StudyGoal, done: boolean, lastDay: string | undefined, now = new Date()): boolean {
  if (!goal.on || !goal.remind || done || !GOAL_KINDS.some((k) => (goal.targets[k] ?? 0) > 0)) return false;
  const m = /^(\d{1,2}):(\d{2})$/.exec(goal.remind);
  if (!m) return false;
  if (lastDay === dayKey(now.getTime())) return false;
  return now.getHours() * 60 + now.getMinutes() >= Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Minutes focused on each of the last 7 days (oldest first), across all courses.
 *
 * @param courses - Her courses.
 * @param now - Now.
 */
export function focusWeek(courses: StudyCourseData[], now = Date.now()): Array<{ day: string; minutes: number }> {
  const week = Array.from({ length: 7 }, (_, i) => ({ day: dayKey(now - (6 - i) * 86_400_000), minutes: 0 }));
  const at = new Map(week.map((w) => [w.day, w]));
  for (const d of courses) for (const f of d.focus ?? []) { const w = at.get(dayKey(f.t)); if (w) w.minutes += f.minutes; }
  return week;
}
