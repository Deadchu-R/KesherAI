/**
 * Study (students): the shapes shared by the computer and the page, the medication calculations (always computed
 * here, never by a model), and "what works for me" — recall per study format from the student's own reviews.
 *
 * Pure functions only: the page uses them directly, so they work on the phone with no computer.
 */

/** How a card or topic was studied (research: docs/RESEARCH_LOG.md "Students, part 5"). */
export type StudyFormat = "text" | "diagram" | "audio" | "example" | "explain";

export const STUDY_FORMATS: StudyFormat[] = ["text", "diagram", "audio", "example", "explain"];

/** One course. */
export interface StudyCourse {
  id: string;
  name: string;
  createdAt: number;
}

/** A term from a lecture, Hebrew with its English (medical) name. */
export interface StudyTerm {
  term: string;
  en?: string;
  explain: string;
}

/** One lecture: its text (typed, pasted, or a transcript) and what was made from it. */
export interface StudyLecture {
  id: string;
  title: string;
  date: string;
  text: string;
  summary?: string;
  terms?: StudyTerm[];
  /** A Mermaid diagram of the lecture's main process, when it has one. */
  diagram?: string;
}

/** A flashcard. `fsrs` is the scheduler's state (ts-fsrs Card, dates as ISO strings). */
export interface StudyCard {
  id: string;
  front: string;
  back: string;
  format: StudyFormat;
  /** Kind of material: "anatomy", "drug", "process", "calculation", "concept"… */
  kind?: string;
  lectureId?: string;
  createdAt: number;
  due: string;
  fsrs: Record<string, unknown>;
}

/** One review of a card. */
export interface StudyReview {
  cardId: string;
  t: number;
  /** 1 again, 2 hard, 3 good, 4 easy. */
  rating: number;
  format: StudyFormat;
  kind?: string;
  /** Days since the card was last seen (0 for a card seen the same day). */
  elapsedDays: number;
}

/** A multiple-choice question (graded by code, not by the model). */
export interface StudyQuestion {
  q: string;
  options: string[];
  answer: number;
  explain: string;
  lectureId?: string;
}

/** A quiz and, once taken, its result. */
export interface StudyQuiz {
  id: string;
  t: number;
  questions: StudyQuestion[];
  answers?: number[];
  score?: number;
}

/**
 * Recall per study format: only reviews after at least a day count (same-day reviews say little about memory).
 *
 * @param reviews - The course's reviews.
 * @param minAnswers - Answers needed before a format's result is shown as reliable.
 * @returns For each format with reviews: how many, the share remembered (rated 2 or more), and whether there are enough.
 */
export function formatStats(reviews: StudyReview[], minAnswers = 20): Array<{ format: StudyFormat; n: number; recall: number; enough: boolean }> {
  const by = new Map<StudyFormat, { n: number; ok: number }>();
  for (const r of reviews) {
    if (r.elapsedDays < 1) continue;
    const s = by.get(r.format) ?? { n: 0, ok: 0 };
    s.n++;
    if (r.rating >= 2) s.ok++;
    by.set(r.format, s);
  }
  return STUDY_FORMATS.filter((f) => by.has(f)).map((f) => {
    const s = by.get(f)!;
    return { format: f, n: s.n, recall: s.ok / s.n, enough: s.n >= minAnswers };
  });
}

/**
 * The lectures answered worst in quizzes (to lean the next quiz on them).
 *
 * @param quizzes - Taken quizzes.
 * @returns Lecture ids with their share correct, worst first (only lectures with at least 2 answers).
 */
export function weakLectures(quizzes: StudyQuiz[]): Array<{ lectureId: string; correct: number; n: number }> {
  const by = new Map<string, { n: number; ok: number }>();
  for (const z of quizzes) {
    if (!z.answers) continue;
    z.questions.forEach((q, i) => {
      if (!q.lectureId) return;
      const s = by.get(q.lectureId) ?? { n: 0, ok: 0 };
      s.n++;
      if (z.answers![i] === q.answer) s.ok++;
      by.set(q.lectureId, s);
    });
  }
  return [...by].filter(([, s]) => s.n >= 2).map(([lectureId, s]) => ({ lectureId, correct: s.ok / s.n, n: s.n })).sort((a, b) => a.correct - b.correct);
}

/**
 * The first JSON array or object in a model's answer (models wrap JSON in prose or code fences).
 *
 * @param text - The answer.
 * @returns The parsed value, or undefined.
 */
export function jsonIn(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  for (const src of [fenced, text]) {
    if (!src) continue;
    const start = src.search(/[[{]/);
    if (start < 0) continue;
    const open = src[start]!;
    const close = open === "[" ? "]" : "}";
    const end = src.lastIndexOf(close);
    if (end <= start) continue;
    try {
      return JSON.parse(src.slice(start, end + 1));
    } catch {
      // try the next form
    }
  }
  return undefined;
}

// ── Medication calculations ────────────────────────────────────────────────────────────────────────────────────────

/** A calculation's answer with the steps that lead to it (numbers and units, the same in every language). */
export interface CalcResult {
  value: number;
  unit: string;
  steps: string[];
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const fmt = (n: number) => String(round(n));

function need(...ns: number[]): void {
  if (ns.some((n) => !Number.isFinite(n) || n <= 0)) throw new Error("Every number must be above zero.");
}

/** The kinds of medication calculation. */
export type CalcKind = "volume" | "tablets" | "weight" | "rate" | "drops" | "infusion";

/**
 * Volume to give: what is ordered ÷ what is in the bottle × its volume ("desired over have").
 *
 * @param doseMg - Ordered dose.
 * @param haveMg - Amount of drug in the stock volume.
 * @param perMl - The stock volume (mL).
 */
export function volumeToGive(doseMg: number, haveMg: number, perMl: number): CalcResult {
  need(doseMg, haveMg, perMl);
  const v = (doseMg / haveMg) * perMl;
  return { value: round(v), unit: "mL", steps: [`${fmt(doseMg)} mg ÷ ${fmt(haveMg)} mg × ${fmt(perMl)} mL = ${fmt(v)} mL`] };
}

/**
 * Tablets to give.
 *
 * @param doseMg - Ordered dose.
 * @param tabletMg - One tablet's strength.
 */
export function tabletsToGive(doseMg: number, tabletMg: number): CalcResult {
  need(doseMg, tabletMg);
  const t = doseMg / tabletMg;
  return { value: round(t), unit: "tab", steps: [`${fmt(doseMg)} mg ÷ ${fmt(tabletMg)} mg = ${fmt(t)}`] };
}

/**
 * A dose by body weight, with an optional top dose.
 *
 * @param mgPerKg - The dose per kilogram.
 * @param kg - Weight.
 * @param maxMg - The highest single dose, when there is one.
 */
export function doseByWeight(mgPerKg: number, kg: number, maxMg?: number): CalcResult {
  need(mgPerKg, kg);
  const d = mgPerKg * kg;
  const steps = [`${fmt(mgPerKg)} mg/kg × ${fmt(kg)} kg = ${fmt(d)} mg`];
  if (maxMg && d > maxMg) {
    steps.push(`${fmt(d)} mg > ${fmt(maxMg)} mg (max) → ${fmt(maxMg)} mg`);
    return { value: round(maxMg), unit: "mg", steps };
  }
  return { value: round(d), unit: "mg", steps };
}

/**
 * Infusion pump rate.
 *
 * @param volumeMl - Volume to run.
 * @param hours - Over how long.
 */
export function pumpRate(volumeMl: number, hours: number): CalcResult {
  need(volumeMl, hours);
  const r = volumeMl / hours;
  return { value: round(r, 1), unit: "mL/h", steps: [`${fmt(volumeMl)} mL ÷ ${fmt(hours)} h = ${round(r, 1)} mL/h`] };
}

/**
 * Gravity drip rate (drops per minute, whole drops).
 *
 * @param volumeMl - Volume to run.
 * @param minutes - Over how long.
 * @param dropFactor - Drops per mL of the set (20 for a regular set, 60 for a micro-drip).
 */
export function dropRate(volumeMl: number, minutes: number, dropFactor: number): CalcResult {
  need(volumeMl, minutes, dropFactor);
  const raw = (volumeMl * dropFactor) / minutes;
  return { value: Math.round(raw), unit: "gtt/min", steps: [`${fmt(volumeMl)} mL × ${fmt(dropFactor)} gtt/mL ÷ ${fmt(minutes)} min = ${fmt(raw)} → ${Math.round(raw)} gtt/min`] };
}

/**
 * Pump rate for a dose per kilogram per minute (e.g. dopamine in mcg/kg/min).
 *
 * @param mcgPerKgMin - Ordered dose.
 * @param kg - Weight.
 * @param drugMg - Drug in the bag.
 * @param bagMl - The bag's volume.
 */
export function infusionRate(mcgPerKgMin: number, kg: number, drugMg: number, bagMl: number): CalcResult {
  need(mcgPerKgMin, kg, drugMg, bagMl);
  const perMin = mcgPerKgMin * kg;
  const perHourMg = (perMin * 60) / 1000;
  const conc = drugMg / bagMl;
  const r = perHourMg / conc;
  return {
    value: round(r, 1),
    unit: "mL/h",
    steps: [
      `${fmt(mcgPerKgMin)} mcg/kg/min × ${fmt(kg)} kg = ${fmt(perMin)} mcg/min`,
      `${fmt(perMin)} mcg/min × 60 ÷ 1000 = ${fmt(perHourMg)} mg/h`,
      `${fmt(drugMg)} mg ÷ ${fmt(bagMl)} mL = ${round(conc, 3)} mg/mL`,
      `${fmt(perHourMg)} mg/h ÷ ${round(conc, 3)} mg/mL = ${round(r, 1)} mL/h`,
    ],
  };
}

/** A practice problem: its numbers, and the answer computed by the functions above. */
export interface CalcProblem {
  kind: CalcKind;
  values: Record<string, number>;
  result: CalcResult;
}

const pick = <T>(xs: readonly T[], rnd: () => number): T => xs[Math.floor(rnd() * xs.length)]!;

/**
 * A random practice problem with realistic numbers.
 *
 * @param kind - Which calculation.
 * @param rnd - Random numbers in [0, 1) (tests pass a fixed one).
 */
export function practiceProblem(kind: CalcKind, rnd: () => number = Math.random): CalcProblem {
  switch (kind) {
    case "volume": {
      const haveMg = pick([25, 50, 100, 250, 500], rnd);
      const perMl = pick([1, 2, 5, 10], rnd);
      const doseMg = haveMg * pick([0.5, 1, 1.5, 2, 0.25], rnd);
      return { kind, values: { doseMg, haveMg, perMl }, result: volumeToGive(doseMg, haveMg, perMl) };
    }
    case "tablets": {
      const tabletMg = pick([5, 10, 25, 50, 250, 500], rnd);
      const doseMg = tabletMg * pick([0.5, 1, 2, 3], rnd);
      return { kind, values: { doseMg, tabletMg }, result: tabletsToGive(doseMg, tabletMg) };
    }
    case "weight": {
      const mgPerKg = pick([0.1, 0.5, 1, 2, 5, 10, 15], rnd);
      const kg = pick([8, 12, 20, 35, 50, 62, 70, 85], rnd);
      return { kind, values: { mgPerKg, kg }, result: doseByWeight(mgPerKg, kg) };
    }
    case "rate": {
      const volumeMl = pick([250, 500, 1000], rnd);
      const hours = pick([2, 4, 6, 8, 12, 24], rnd);
      return { kind, values: { volumeMl, hours }, result: pumpRate(volumeMl, hours) };
    }
    case "drops": {
      const volumeMl = pick([100, 250, 500, 1000], rnd);
      const minutes = pick([30, 60, 120, 240, 480], rnd);
      const dropFactor = pick([20, 60], rnd);
      return { kind, values: { volumeMl, minutes, dropFactor }, result: dropRate(volumeMl, minutes, dropFactor) };
    }
    case "infusion": {
      const mcgPerKgMin = pick([2, 3, 5, 8, 10], rnd);
      const kg = pick([50, 60, 70, 80, 90], rnd);
      const drugMg = pick([200, 400, 800], rnd);
      const bagMl = pick([250, 500], rnd);
      return { kind, values: { mcgPerKgMin, kg, drugMg, bagMl }, result: infusionRate(mcgPerKgMin, kg, drugMg, bagMl) };
    }
  }
}

/**
 * Whether an answer is right: within 1% (at least 0.05) of the computed one; drops must be the whole number.
 *
 * @param answer - What the student wrote.
 * @param result - The computed answer.
 */
export function calcCorrect(answer: number, result: CalcResult): boolean {
  if (!Number.isFinite(answer)) return false;
  if (result.unit === "gtt/min") return Math.round(answer) === result.value;
  return Math.abs(answer - result.value) <= Math.max(0.05, Math.abs(result.value) * 0.01);
}
