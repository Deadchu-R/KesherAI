import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * An assignment broken into steps placed in the days before it is due (RESEARCH_LOG "Students, part 18" #2, design
 * DeadlinePlan, like Motion and Todoist Assist): the chat model suggests the steps; KesherAI checks every date is
 * between today and the due day, caps the minutes, and spreads them so no day gets too much.
 */

/** One step. */
export interface PlanStep { title: string; date: string; minutes: number; done?: boolean }
/** A plan for one assignment. */
export interface StudyPlan { id: string; title: string; course: string; due: number; steps: PlanStep[]; createdAt: number; calendar?: boolean }

const day = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const addDays = (key: string, n: number) => {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return day(new Date(y, m - 1, d + n).getTime());
};

/** The instructions for the model. */
export function planPrompt(lang: "he" | "en"): string {
  return `You plan a student's work on one assignment. Break it into 3 to 6 concrete steps (each a short action, in ${lang === "he" ? "Hebrew" : "English"}), each with minutes (15–180) and a date (YYYY-MM-DD) from the first day to the day before the due day; the last step can be on the due day. Put the hard steps earlier, leave a little room before the end, and avoid days that are already busy. Answer with JSON only: {"steps":[{"title":"…","minutes":60,"date":"YYYY-MM-DD"}]}`;
}

/**
 * The model's steps, checked: dates inside [today, due day], minutes 10–240, at most 8 steps, in date order; a day
 * that would pass `perDay` minutes (with what is already planned) moves the step to the nearest free earlier day.
 * With no usable steps from the model, an even plan of three steps.
 *
 * @param raw - The model's JSON (or undefined).
 * @param now - Now (ms).
 * @param due - When it is due (ms).
 * @param busy - Minutes already planned per day.
 * @param lang - For the fallback steps' words.
 */
export function checkPlan(raw: unknown, now: number, due: number, busy: Record<string, number> = {}, lang: "he" | "en" = "he", perDay = 180): PlanStep[] {
  const first = day(now);
  const last = day(Math.max(due, now));
  const inside = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= first && d <= last;
  let steps: PlanStep[] = (Array.isArray((raw as { steps?: unknown })?.steps) ? (raw as { steps: unknown[] }).steps : []).slice(0, 8).flatMap((x) => {
    const o = x as { title?: unknown; minutes?: unknown; date?: unknown };
    const title = String(o.title ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    const minutes = Math.min(240, Math.max(10, Math.round(Number(o.minutes) || 45)));
    const date = String(o.date ?? "");
    return title ? [{ title, minutes, date: inside(date) ? date : last }] : [];
  });
  if (!steps.length) {
    const words = lang === "he" ? ["לקרוא את ההנחיות ולתכנן", "לעשות את עיקר העבודה", "לעבור על הכל ולהגיש"] : ["Read the brief and plan", "Do the main work", "Check everything and submit"];
    const span = Math.max(0, Math.round((new Date(`${last}T12:00`).getTime() - new Date(`${first}T12:00`).getTime()) / 86_400_000));
    steps = words.map((title, i) => ({ title, minutes: i === 1 ? 120 : 45, date: addDays(first, Math.round((span * i) / 2)) }));
  }
  steps.sort((a, b) => a.date.localeCompare(b.date));
  const load: Record<string, number> = { ...busy };
  for (const s of steps) {
    // The nearest earlier day with room; a step too big for any day stays where it was.
    let d = s.date;
    while ((load[d] ?? 0) + s.minutes > perDay && d > first) d = addDays(d, -1);
    if ((load[d] ?? 0) + s.minutes <= perDay) s.date = d;
    d = s.date;
    load[d] = (load[d] ?? 0) + s.minutes;
  }
  return steps.sort((a, b) => a.date.localeCompare(b.date));
}

/** Plans kept in one file in the Study folder. */
export class StudyPlans {
  /** @param file - The plans file. */
  constructor(private readonly file: string) {}

  /** Every plan, soonest due first. */
  async list(): Promise<StudyPlan[]> {
    const raw = await readFile(this.file, "utf8").then((t) => JSON.parse(t) as StudyPlan[], () => [] as StudyPlan[]);
    return (Array.isArray(raw) ? raw : []).sort((a, b) => a.due - b.due);
  }

  private async save(plans: StudyPlan[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(plans));
    await rename(tmp, this.file);
  }

  /** Minutes already planned per day (open steps of other plans). */
  async busy(except?: string): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const p of await this.list()) if (p.id !== except) for (const s of p.steps) if (!s.done) out[s.date] = (out[s.date] ?? 0) + s.minutes;
    return out;
  }

  /** Adds or replaces a plan. */
  async put(plan: StudyPlan): Promise<StudyPlan> {
    const all = (await this.list()).filter((p) => p.id !== plan.id);
    // Plans long past their due day leave after two weeks.
    await this.save([...all.filter((p) => p.due > Date.now() - 14 * 86_400_000), plan]);
    return plan;
  }

  /** One plan. */
  async get(id: string): Promise<StudyPlan | undefined> {
    return (await this.list()).find((p) => p.id === id);
  }

  /** Removes a plan. */
  async remove(id: string): Promise<void> {
    await this.save((await this.list()).filter((p) => p.id !== id));
  }
}
