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
  /** Its field of study (STUDY_FIELDS), recognised from its lectures or chosen by the student. */
  field?: string;
  /** The student chose the field (it is no longer guessed). */
  fieldChosen?: boolean;
  /** The exam's date (YYYY-MM-DD), when she set one. */
  examDate?: string;
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
  /** A spoken review of the lecture (an "audio overview", to listen to on the bus), once made. */
  audio?: string;
  /** Her own notes beside the summary (what the lecturer stressed, what to ask, what she did not get). */
  notes?: string;
  /** When her notes were last changed (a sync keeps the newer notes). */
  notesT?: number;
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
  /** Empty for an open or case question (answered in her words). */
  options: string[];
  /** The right option; -1 for an open or case question. */
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
  /** "open": questions answered in her words; "case": a short case, then a question. Missing: multiple choice. */
  kind?: "open" | "case";
  /** How hard she asked for. */
  level?: StudyLevel;
  /** Her written answers (open and case quizzes). */
  texts?: string[];
  /** Each written answer's mark: 1 right, 0.5 partly, 0 wrong. */
  marks?: number[];
  /** What the grader said about each written answer. */
  feedback?: string[];
}

/** How hard a quiz is. */
export type StudyLevel = "easy" | "normal" | "hard";

/** How hard the questions are, as a line for the quiz prompt. */
export const LEVEL_RULE: Record<StudyLevel, string> = {
  easy: "Level: easy. Direct recall of the main facts and terms, one idea per question, clear wording.",
  normal: "Level: medium. Mix recall and understanding: why, compare, what follows.",
  hard: "Level: hard, like a tough final exam. Apply the material to new situations, combine two ideas, multi-step reasoning; wrong options are close and tempting.",
};

/** An open quiz (her words) or a case quiz, from lecture material. */
export const OPEN_QUIZ_PROMPT = (kind: "open" | "case") =>
  `You write ${kind === "case" ? "case questions: each starts with a short realistic case or scenario from the course's field (a patient, a client, a legal fact pattern, a system, an experiment: 2–4 sentences), then asks what to do, conclude or explain, answered from the lectures" : "open questions a student answers in a few sentences of her own (explain, compare, why, describe a process)"} for a student from lecture material. Write in the same language as the material (usually Hebrew). Use only what the material says. For each question give the model answer in 1–3 sentences: the points a full answer must have. Answer with JSON only: [{"q": "...", "answer": "...", "lecture": 1}] where "lecture" is the number of the lecture it comes from.`;

/** Grading a written answer against the model answer and her lecture. */
export const OPEN_GRADE_PROMPT =
  'You grade a student\'s written answer. You get the question, the model answer (the points a full answer has) and passages of her lecture. Judge the meaning, not the wording: "right" when it has the main points, "partly" when some are missing or one is wrong, "wrong" otherwise. Answer with JSON only: {"verdict": "right" | "partly" | "wrong", "answer": "what was missing or wrong, in one or two short sentences in the question\'s language (empty when right)"}';

/** The messages for grading one written answer. */
export function openGradeMessages(o: { lectures: StudyLecture[]; question: StudyQuestion; text: string; budget?: number }): TutorMessage[] {
  const pick = o.question.lectureId ? o.lectures.filter((l) => l.id === o.question.lectureId) : o.lectures;
  const passages = findPassages(pick.length ? pick : o.lectures, `${o.question.q} ${o.question.explain}`.slice(0, 3000), o.budget ?? 4000);
  const material = passages.length ? passages.map((p) => `${passageLabel(p)}\n${p.text}`).join("\n\n---\n\n") : "(No passage matches.)";
  return [{ role: "system", content: OPEN_GRADE_PROMPT }, { role: "user", content: `Passages:\n\n${material}\n\nQuestion: ${o.question.q.slice(0, 2000)}\nModel answer: ${o.question.explain.slice(0, 1500)}\nHer answer: ${o.text.slice(0, 3000)}` }];
}

/** A grader's reply as a mark (1, 0.5, 0) and a line to show her, or undefined when it had no verdict. */
export function openMark(raw: string, he: boolean): { mark: number; line: string } | undefined {
  const j = jsonIn(raw) as { verdict?: string; answer?: string } | undefined;
  const v = String(j?.verdict ?? "").toLowerCase();
  if (!["right", "partly", "wrong"].includes(v)) return undefined;
  const why = cleanScript(String(j?.answer ?? "").trim(), he).slice(0, 600);
  const head = v === "right" ? (he ? "✓ נכון." : "✓ Right.") : v === "partly" ? (he ? "◐ נכון בחלקו." : "◐ Partly right.") : he ? "✗ לא בדיוק." : "✗ Not quite.";
  return { mark: v === "right" ? 1 : v === "partly" ? 0.5 : 0, line: why && v !== "right" ? `${head} ${why}` : head };
}

/** A model's open or case questions, checked: each has a question and a model answer. */
export function parseOpenQuestions(raw: string, lectureIds: string[], count: number): StudyQuestion[] {
  const list = jsonIn(raw) ?? (raw.includes("[") && raw.lastIndexOf("}") > raw.indexOf("[") ? jsonIn(`${raw.slice(raw.indexOf("["), raw.lastIndexOf("}") + 1)}]`) : undefined);
  if (!Array.isArray(list)) return [];
  const out: StudyQuestion[] = [];
  for (const x of list as Array<{ q?: unknown; answer?: unknown; lecture?: unknown }>) {
    const q = String(x?.q ?? "").trim();
    const a = String(x?.answer ?? "").trim();
    if (q.length < 8 || a.length < 4 || a.length > 1200) continue;
    const lec = lectureIds[Number(x.lecture) - 1] ?? (lectureIds.length === 1 ? lectureIds[0] : undefined);
    out.push({ q: q.slice(0, 3000), options: [], answer: -1, explain: a, ...(lec ? { lectureId: lec } : {}) });
    if (out.length >= count) break;
  }
  return out;
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
      s.ok += z.marks ? (z.marks[i] ?? 0) : z.answers![i] === q.answer ? 1 : 0;
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

// ── Nursing ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A drug card (the fields nursing drug guides use). Only what the student's material says is filled. */
export interface StudyDrug {
  id: string;
  name: string;
  /** Brand names (Israeli ones when the material gives them). */
  brands?: string;
  drugClass?: string;
  action?: string;
  uses?: string;
  dose?: string;
  sideEffects?: string;
  contraindications?: string;
  nursing?: string;
  teaching?: string;
  lectureId?: string;
}

/** One normal adult lab range. Ranges differ between labs: the page says to check the hospital's own. */
export interface LabValue {
  group: "electrolytes" | "blood" | "kidney" | "gases" | "coagulation" | "other";
  name: string;
  he: string;
  range: string;
  unit: string;
  note?: string;
}

/** Common adult reference ranges as taught in nursing courses (textbook values; each lab has its own). */
export const LAB_VALUES: LabValue[] = [
  { group: "electrolytes", name: "Sodium (Na⁺)", he: "נתרן", range: "135–145", unit: "mEq/L" },
  { group: "electrolytes", name: "Potassium (K⁺)", he: "אשלגן", range: "3.5–5.0", unit: "mEq/L" },
  { group: "electrolytes", name: "Chloride (Cl⁻)", he: "כלוריד", range: "98–106", unit: "mEq/L" },
  { group: "electrolytes", name: "Calcium (total)", he: "סידן", range: "8.5–10.5", unit: "mg/dL" },
  { group: "electrolytes", name: "Magnesium (Mg²⁺)", he: "מגנזיום", range: "1.5–2.5", unit: "mg/dL" },
  { group: "electrolytes", name: "Phosphate", he: "זרחן", range: "2.5–4.5", unit: "mg/dL" },
  { group: "blood", name: "Hemoglobin", he: "המוגלובין", range: "♀ 12–16 · ♂ 14–18", unit: "g/dL" },
  { group: "blood", name: "Hematocrit", he: "המטוקריט", range: "♀ 37–47 · ♂ 42–52", unit: "%" },
  { group: "blood", name: "WBC", he: "כדוריות דם לבנות", range: "4.5–11", unit: "×10³/µL" },
  { group: "blood", name: "Platelets", he: "טסיות", range: "150–400", unit: "×10³/µL" },
  { group: "blood", name: "Glucose (fasting)", he: "סוכר בצום", range: "70–99", unit: "mg/dL" },
  { group: "blood", name: "HbA1c", he: "המוגלובין מסוכרר", range: "< 5.7", unit: "%" },
  { group: "kidney", name: "Creatinine", he: "קריאטינין", range: "0.6–1.2", unit: "mg/dL" },
  { group: "kidney", name: "BUN", he: "שתנן בדם", range: "7–20", unit: "mg/dL" },
  { group: "gases", name: "pH (arterial)", he: "חומציות", range: "7.35–7.45", unit: "" },
  { group: "gases", name: "PaCO₂", he: "פחמן דו-חמצני", range: "35–45", unit: "mmHg" },
  { group: "gases", name: "HCO₃⁻", he: "ביקרבונט", range: "22–26", unit: "mEq/L" },
  { group: "gases", name: "PaO₂", he: "חמצן", range: "80–100", unit: "mmHg" },
  { group: "gases", name: "SpO₂", he: "רוויון חמצן", range: "95–100", unit: "%" },
  { group: "coagulation", name: "INR", he: "INR", range: "0.8–1.1", unit: "", note: "on warfarin, usually 2–3" },
  { group: "coagulation", name: "PT", he: "זמן פרותרומבין", range: "11–13.5", unit: "s" },
  { group: "coagulation", name: "aPTT", he: "aPTT", range: "30–40", unit: "s" },
  { group: "other", name: "Digoxin level", he: "רמת דיגוקסין", range: "0.5–2.0", unit: "ng/mL" },
  { group: "other", name: "Albumin", he: "אלבומין", range: "3.5–5.0", unit: "g/dL" },
];

// ── Fields of study ───────────────────────────────────────────────────────────────────────────────────────────────

/** A field of study: what it is called and the words that show it (Hebrew and English). */
export interface StudyField {
  id: string;
  he: string;
  en: string;
  words: string[];
}

/** The fields KesherAI recognises (research: docs/RESEARCH_LOG.md "Students, part 6"). */
export const STUDY_FIELDS: StudyField[] = [
  { id: "nursing", he: "סיעוד", en: "Nursing", words: ["סיעוד", "אחות", "אחיות", "מטופל", "nursing", "nurse", "בחינת רישוי", "תרופות", "פרמקולוגיה", "pharmacology", "מתן תרופה"] },
  { id: "medicine", he: "רפואה", en: "Medicine", words: ["רפואה", "רופא", "אבחנה", "medicine", "medical", "clinical", "פתולוגיה", "pathology", "אנטומיה", "anatomy", "פיזיולוגיה", "physiology"] },
  { id: "law", he: "משפטים", en: "Law", words: ["משפטים", "חוק", "סעיף", "פסק דין", "בית המשפט", "עליון", "חוזים", "נזיקין", "law", "court", "statute", "contract", "tort", "plaintiff"] },
  { id: "engineering", he: "הנדסה", en: "Engineering", words: ["הנדסה", "מהנדס", "חוזק חומרים", "מעגלים", "engineering", "circuit", "thermodynamics", "תרמודינמיקה", "סטטיקה", "statics", "mechanics"] },
  { id: "cs", he: "מדעי המחשב", en: "Computer science", words: ["מדעי המחשב", "תכנות", "אלגוריתם", "סיבוכיות", "מבני נתונים", "programming", "algorithm", "complexity", "data structures", "python", "java", "c++", "קוד"] },
  { id: "math", he: "מתמטיקה ופיזיקה", en: "Mathematics and physics", words: ["מתמטיקה", "חדו\"א", "אינפי", "אלגברה", "לינארית", "פיזיקה", "calculus", "algebra", "linear", "physics", "derivative", "integral", "נגזרת", "אינטגרל", "משוואה"] },
  { id: "psychology", he: "פסיכולוגיה", en: "Psychology", words: ["פסיכולוגיה", "פסיכולוג", "התנהגות", "קוגניטיבי", "psychology", "cognitive", "behavior", "behaviour", "פרויד", "freud", "piaget"] },
  { id: "economics", he: "כלכלה וניהול", en: "Economics and management", words: ["כלכלה", "מיקרו", "מאקרו", "ניהול", "חשבונאות", "שיווק", "economics", "micro", "macro", "accounting", "marketing", "finance", "ביקוש", "היצע"] },
  { id: "biology", he: "ביולוגיה וכימיה", en: "Biology and chemistry", words: ["ביולוגיה", "כימיה", "תא", "גנטיקה", "ביוכימיה", "biology", "chemistry", "cell", "genetics", "biochemistry", "אורגנית", "organic"] },
  { id: "education", he: "חינוך", en: "Education", words: ["חינוך", "הוראה", "פדגוגיה", "education", "teaching", "pedagogy", "תלמידים", "בית ספר"] },
  { id: "humanities", he: "מדעי הרוח והחברה", en: "Humanities and social sciences", words: ["היסטוריה", "פילוסופיה", "ספרות", "סוציולוגיה", "מדע המדינה", "history", "philosophy", "literature", "sociology", "political science"] },
];

/** A tool for one field of study: it works on text she pastes, or on the course's lectures. */
export interface StudyTool {
  id: string;
  he: string;
  en: string;
  /** Who it is for (field ids). */
  fields: string[];
  /** "text": she pastes something; "course": it reads the course's lectures. */
  input: "text" | "course";
  placeholder?: [string, string];
  prompt: string;
}

const TOOL_LANG = "Write in the same language as the material (usually Hebrew), keeping technical terms, names and symbols as written. Use only what is given; where something needed is missing, write [חסר] instead of inventing it. Markdown.";

/** The tools for each field (the same on the computer and the phone). */
export const STUDY_TOOLS: StudyTool[] = [
  { id: "formulas", he: "דף נוסחאות מהקורס", en: "Formula sheet from the course", fields: ["engineering", "math", "cs", "economics", "biology"], input: "course",
    prompt: `Make a formula sheet from these lectures: every formula, law and rule written in them, grouped by topic (## heading per topic). For each: the formula (plain text, like F = m * a, no LaTeX), what each symbol means with its units, and when to use it, in one line. Then the lecture it came from in brackets. ${TOOL_LANG}` },
  { id: "brief", he: "תקציר פסק דין (IRAC)", en: "Case brief (IRAC)", fields: ["law"], input: "text", placeholder: ["הדביקי את פסק הדין או חלק ממנו", "Paste the ruling or part of it"],
    prompt: `Write a case brief of this ruling: ## העובדות (short), ## השאלה המשפטית, ## הכלל (statutes and precedents exactly as cited, with section numbers), ## היישום (the court's reasoning), ## ההכרעה, and ## דעות נוספות (minority or concurring opinions, if any). ${TOOL_LANG}` },
  { id: "statute", he: "פירוק סעיף לרכיבים", en: "A section broken into elements", fields: ["law"], input: "text", placeholder: ["הדביקי את סעיף החוק", "Paste the section"],
    prompt: `Break this statutory section into its elements: the conditions that must all hold (numbered), the exceptions, the result or remedy, and the defined terms it uses. Then one short example that meets every element, and one that misses one, saying which. ${TOOL_LANG}` },
  { id: "trace", he: "הסבר קוד ומעקב", en: "Explain and trace code", fields: ["cs"], input: "text", placeholder: ["הדביקי קוד", "Paste code"],
    prompt: `Explain this code for a student: what it does in two sentences, then line by line (short), then a trace table of the variables for a small example input (a markdown table, one row per step, at most 15 rows), then its time and space complexity with the reason, and any bug or edge case it misses. Write code in code blocks. ${TOOL_LANG}` },
  { id: "research", he: "ניתוח מאמר מחקר", en: "Analyze a research paper", fields: ["psychology", "education", "humanities", "biology", "medicine", "nursing", "economics"], input: "text", placeholder: ["הדביקי את התקציר או המאמר", "Paste the abstract or paper"],
    prompt: `Analyze this study for a student: ## שאלת המחקר והשערות, ## משתנים (independent, dependent, controlled, with how each was measured), ## מערך המחקר (design, sample and size, how it was chosen), ## ממצאים (with the numbers given: effect sizes, p values), ## מגבלות (as the paper states them, then others a reader would raise, marked as such), ## במשפט אחד. ${TOOL_LANG}` },
  { id: "apa", he: "רשימה ביבליוגרפית APA 7", en: "APA 7 references", fields: ["psychology", "education", "humanities", "economics", "nursing", "medicine", "biology"], input: "text", placeholder: ["פרטי המקורות: מחברים, שנה, כותרת, כתב עת, כרך, עמודים, DOI (מקור בכל שורה)", "Source details: authors, year, title, journal, volume, pages, DOI (one per line)"],
    prompt: `Write each source as an APA 7th edition reference entry, sorted alphabetically, then the in-text citation for each, e.g. (Cohen & Levi, 2020). Use only the details given; any missing part becomes [חסר]. Hebrew sources follow the Hebrew APA conventions (ו׳ for &, עמ׳). Plain list. ${TOOL_LANG}` },
  { id: "lesson", he: "מערך שיעור", en: "Lesson plan", fields: ["education"], input: "text", placeholder: ["נושא, גיל או כיתה, משך השיעור, מטרות", "Topic, age or grade, length, goals"],
    prompt: `Write a lesson plan: ## מטרות (measurable), ## ידע קודם, ## מהלך השיעור (opening, main part, closing, with minutes for each and what the teacher and the pupils do), ## הבחנה בין תלמידים (for those who need more help and those who need more challenge), ## הערכה (how she will know the goals were met), ## חומרים. ${TOOL_LANG}` },
  { id: "source", he: "ניתוח מקור או טקסט", en: "Analyze a source or text", fields: ["humanities", "education", "law"], input: "text", placeholder: ["הדביקי את הטקסט או המקור", "Paste the text or source"],
    prompt: `Analyze this text for a student: ## מי, מתי ולמי (author, time, audience, as far as the text shows), ## הטענה המרכזית, ## הנימוקים והראיות, ## מושגי מפתח, ## הקשר (what the text answers or argues with, only if it says so), ## שאלות לדיון (three). ${TOOL_LANG}` },
  { id: "reflection", he: "רפלקציה על משמרת (גיבס)", en: "Shift reflection (Gibbs)", fields: ["nursing", "medicine", "education", "psychology"], input: "text", placeholder: ["מה קרה במשמרת או בשיעור, בלי שמות ופרטים מזהים של מטופלים או תלמידים", "What happened in the shift or lesson, with no names or identifying details of patients or pupils"],
    prompt: `Write a reflective journal entry by Gibbs' cycle from her notes: ## תיאור, ## רגשות ומחשבות, ## הערכה (what went well and what did not), ## ניתוח (why, linked to what the course teaches, only where her notes allow), ## מסקנות, ## תוכנית פעולה (what she will do next time). First person, her voice, honest and short. If her notes include a name, ID number or other identifying detail of a patient or pupil, leave it out and write [הוסר]. ${TOOL_LANG}` },
  { id: "sbar", he: "העברת משמרת (SBAR)", en: "Handoff (SBAR)", fields: ["nursing", "medicine"], input: "text", placeholder: ["הערות על המטופל לתרגול, בלי שם ומספר זהות", "Notes on the patient, for practice, with no name or ID"],
    prompt: `Turn these practice notes into an SBAR handoff: ## S – מצב (now, in one or two lines), ## B – רקע, ## A – הערכה (vital signs and findings as given, what she thinks is going on), ## R – המלצה (what the next shift should do and watch). Short lines, numbers exactly as given. Leave out any name, ID number or address and write [הוסר]. This is practice for a student, not a real handoff. ${TOOL_LANG}` },
  { id: "case", he: "תוכנית טיפול למקרה", en: "Care plan for a case", fields: ["nursing", "medicine", "psychology"], input: "text", placeholder: ["תיאור המקרה", "The case"],
    prompt: `From this case, write: ## בעיות עיקריות (by priority, with the findings that show each), ## מטרות, ## התערבויות (with the reason for each), ## מה לעקוב ולהעריך. Base everything on the case and on standard principles the course would teach; mark anything that needs a doctor's order or the ward's protocol. This is practice for a student, not care for a real patient. ${TOOL_LANG}` },
];

/** What to search Wikimedia Commons for, for a lecture: its English terms first (Commons is mostly English), else its title. */
export function pictureQuery(l: Pick<StudyLecture, "title" | "terms">): string {
  const en = (l.terms ?? []).map((t) => t.en?.trim()).filter((t): t is string => !!t && /^[\x20-\x7e]+$/.test(t));
  return (en.length ? en.slice(0, 2).join(" ") : l.title).replace(/["\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
}

/** A free picture from Wikimedia Commons for a lecture, with its credit. */
export interface StudyPicture {
  /** The picture (an upload.wikimedia.org address, or a data: copy the computer fetched). */
  src: string;
  page: string;
  license: string;
  artist: string;
}

/**
 * The address of a Commons picture search (the phone calls it itself; `origin=*` lets a page read the answer).
 * Diagrams (Commons' PNG copy of a drawing) and photos, nothing unsuitable.
 */
export function commonsSearchUrl(query: string, width = 480): string {
  const q = query.replace(/["\\]/g, " ").trim().slice(0, 100);
  const params = new URLSearchParams({ action: "query", format: "json", origin: "*", generator: "search", gsrsearch: `"${q}" -nude -naked -nudity -erotic -sexy -porn -gore`, gsrnamespace: "6", gsrlimit: "16", prop: "imageinfo", iiprop: "url|mime|extmetadata", iiextmetadatafilter: "LicenseShortName|Artist", iiurlwidth: String(width) });
  return `https://commons.wikimedia.org/w/api.php?${params}`;
}

/** Reads a Commons search answer into pictures: only scaled copies on upload.wikimedia.org, over HTTPS. */
export function parseCommonsPictures(json: unknown, max = 8): StudyPicture[] {
  const pages = (json as { query?: { pages?: Record<string, { index?: number; imageinfo?: Array<Record<string, unknown>> }> } })?.query?.pages ?? {};
  const plain = (h: unknown) => String(h ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
  const out: StudyPicture[] = [];
  for (const p of Object.values(pages).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))) {
    const info = p.imageinfo?.[0];
    const mime = String(info?.mime ?? "");
    if (!info || !/^image\/(png|jpeg|webp|svg\+xml)$/.test(mime)) continue;
    const src = String(info.thumburl ?? "");
    try {
      const u = new URL(src);
      if (u.protocol !== "https:" || u.hostname !== "upload.wikimedia.org" || !/\.(png|jpe?g|webp)$/i.test(u.pathname)) continue;
    } catch {
      continue;
    }
    const meta = (info.extmetadata ?? {}) as Record<string, { value?: unknown }>;
    const page = String(info.descriptionurl ?? "");
    out.push({ src, page: /^https:\/\/commons\.wikimedia\.org\//.test(page) ? page : "", license: plain(meta.LicenseShortName?.value) || "free licence", artist: plain(meta.Artist?.value) || "unknown" });
    if (out.length >= max) break;
  }
  return out;
}

/** The tools that fit a course's field (all of them when the field is unknown). */
export function toolsFor(field: string | undefined): StudyTool[] {
  if (!field) return STUDY_TOOLS;
  return STUDY_TOOLS.filter((t) => t.fields.includes(field));
}

/** The course's material for a "course" tool: summaries (or text), each with its title, within a budget. */
export function toolMaterial(lectures: StudyLecture[], budget = 40_000): string {
  const each = Math.max(1500, Math.floor(budget / Math.max(1, lectures.length)));
  return lectures.map((l) => `### ${l.title}\n${(l.summary || l.text).slice(0, each)}`).join("\n\n").slice(0, budget);
}

/**
 * Guesses a course's field from its name and its lectures' words (the name counts three times).
 *
 * @param name - The course's name.
 * @param text - Its lectures' titles and the start of their text.
 * @returns The field's id, or undefined when nothing stands out.
 */
export function detectField(name: string, text: string): string | undefined {
  const hay = ` ${name} ${name} ${name} ${text} `.toLowerCase();
  let best: { id: string; score: number } | undefined;
  for (const f of STUDY_FIELDS) {
    let score = 0;
    for (const w of f.words) {
      // Hebrew joins one-letter words to the next (ו, ה, ב, ל, מ, ש, כ).
      const re = new RegExp(`(^|[^\\p{L}])[והבלמשכ]{0,2}${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gu");
      score += hay.match(re)?.length ?? 0;
    }
    if (score > (best?.score ?? 1)) best = { id: f.id, score };
  }
  return best?.id;
}

/** Whether a field gets the nursing tools (drug cards, lab values, medication calculations). */
export const clinicalField = (field: string | undefined): boolean => field === "nursing" || field === "medicine";

// ── Student benefits ──────────────────────────────────────────────────────────────────────────────────────────────

/** A student benefit: what it gives and how to turn it on, with its official page. Offers change: each says when
 *  it was checked, and the page asks the web for what is current before relying on it. */
export interface StudentBenefit {
  id: string;
  group: "transport" | "ai" | "software" | "design" | "dev" | "money";
  name: { he: string; en: string };
  what: { he: string; en: string };
  how: { he: string[]; en: string[] };
  url: string;
  /** Fields of study it matters most for (empty: everyone). */
  fields?: string[];
  checked: string;
  note?: { he: string; en: string };
}

export const STUDENT_BENEFITS: StudentBenefit[] = [
  {
    id: "transit", group: "transport", checked: "2026-11-16", url: "https://www.kolzchut.org.il/he/%D7%94%D7%A0%D7%97%D7%94_%D7%9C%D7%A1%D7%98%D7%95%D7%93%D7%A0%D7%98_%D7%91%D7%A0%D7%A1%D7%99%D7%A2%D7%94_%D7%91%D7%90%D7%95%D7%98%D7%95%D7%91%D7%95%D7%A1",
    name: { he: "הנחה בתחבורה ציבורית", en: "Public transport discount" },
    what: { he: "סטודנטים זכאים ל-33%–50% הנחה בנסיעות, לפי סוג הלימודים.", en: "Students get 33%–50% off fares, by type of studies." },
    how: { he: ["מבקשים מהמוסד אישור לימודים או מעדכנים פרופיל סטודנט ברב-קו.", "טוענים את הפרופיל בעמדת רב-קו, באתר או באפליקציה של רב-קו.", "באפליקציות תשלום (מוביט, פנגו ועוד) בוחרים פרופיל סטודנט."], en: ["Get a study certificate from your school, or update the student profile on your Rav-Kav.", "Load the profile at a Rav-Kav station, the Rav-Kav site or app.", "In payment apps (Moovit, Pango and others) choose the student profile."] },
  },
  {
    id: "gemini", group: "ai", checked: "2026-11-16", url: "https://support.google.com/gemini/answer/16417758",
    name: { he: "Google Gemini לסטודנטים", en: "Google Gemini for students" },
    what: { he: "שנה של מנוי Gemini בתשלום בחינם לסטודנטים, עם NotebookLM.", en: "A free year of a paid Gemini plan for students, with NotebookLM." },
    how: { he: ["נכנסים ל-Google One מהחשבון האישי.", "מאמתים סטודנטיות דרך SheerID (מייל של המוסד או אישור לימודים).", "בוחרים את מבצע הסטודנטים ומוסיפים אמצעי תשלום (בלי חיוב בשנה הראשונה). לבטל לפני החידוש אם לא רוצים להמשיך."], en: ["Open Google One with your personal account.", "Verify you are a student with SheerID (school email or certificate).", "Pick the student offer and add a payment method (no charge in the first year). Cancel before it renews if you do not want to continue."] },
    note: { he: "בבדיקה ב-16.11.2026: לפי עמוד העזרה של Google ההצעה החדשה מוגבלת כרגע לסטודנטים בארה\"ב; מקורות אחרים מזכירים גרסה מצומצמת ב-140 מדינות. לבדוק מה זמין בישראל עכשיו.", en: "Checked 16.11.2026: Google's help page says new claims are limited to US students for now; other sources mention a smaller plan in 140 countries. Check what Israel gets now." },
  },
  {
    id: "m365", group: "software", checked: "2026-11-16", url: "https://www.microsoft.com/education/products/office",
    name: { he: "Microsoft 365 (Word, Excel, Teams)", en: "Microsoft 365 (Word, Excel, Teams)" },
    what: { he: "לרוב חינם דרך המוסד.", en: "Usually free through your school." },
    how: { he: ["נכנסים עם המייל של המוסד באתר של Microsoft 365.", "אם לא עובד, שואלים את מחלקת המחשוב של המוסד."], en: ["Sign in with your school email on the Microsoft 365 site.", "If that does not work, ask your school's IT."] },
  },
  {
    id: "github", group: "dev", checked: "2026-11-16", url: "https://education.github.com/pack", fields: ["cs", "engineering", "math"],
    name: { he: "GitHub Student Developer Pack", en: "GitHub Student Developer Pack" },
    what: { he: "עשרות כלי פיתוח בחינם: JetBrains, קרדיט לענן, דומיין ועוד.", en: "Dozens of free developer tools: JetBrains, cloud credit, a domain and more." },
    how: { he: ["נרשמים ב-education.github.com/pack.", "מאמתים עם המייל של המוסד או צילום של כרטיס/אישור סטודנט."], en: ["Sign up at education.github.com/pack.", "Verify with your school email or a photo of your student card or certificate."] },
  },
  {
    id: "notion", group: "software", checked: "2026-11-16", url: "https://www.notion.com/product/notion-for-education",
    name: { he: "Notion לחינוך", en: "Notion for education" },
    what: { he: "תוכנית Plus בחינם לסטודנטים.", en: "The Plus plan free for students." },
    how: { he: ["נרשמים עם המייל של המוסד.", "בהגדרות: מעבר לתוכנית Education."], en: ["Sign up with your school email.", "In settings: switch to the Education plan."] },
  },
  {
    id: "canva", group: "design", checked: "2026-11-16", url: "https://www.canva.com/education/",
    name: { he: "Canva לחינוך", en: "Canva for education" },
    what: { he: "Canva Pro בחינם לסטודנטים מאומתים (לרוב דרך המוסד).", en: "Canva Pro free for verified students (often through the school)." },
    how: { he: ["בודקים באתר Canva Education אם המוסד שלך רשום.", "מאמתים לפי ההוראות שם."], en: ["Check on Canva Education whether your school is listed.", "Verify as it explains."] },
  },
  {
    id: "figma", group: "design", checked: "2026-11-16", url: "https://www.figma.com/education/", fields: ["cs", "engineering", "humanities"],
    name: { he: "Figma לחינוך", en: "Figma for education" },
    what: { he: "Figma ו-FigJam בחינם לסטודנטים.", en: "Figma and FigJam free for students." },
    how: { he: ["נכנסים ל-figma.com/education.", "מאמתים סטודנטיות."], en: ["Go to figma.com/education.", "Verify you are a student."] },
  },
  {
    id: "autodesk", group: "software", checked: "2026-11-16", url: "https://www.autodesk.com/education/edu-software/overview", fields: ["engineering"],
    name: { he: "Autodesk (AutoCAD, Fusion, Revit)", en: "Autodesk (AutoCAD, Fusion, Revit)" },
    what: { he: "רישיונות חינוך בחינם.", en: "Free education licences." },
    how: { he: ["נרשמים באתר Autodesk Education.", "מאמתים עם אישור לימודים."], en: ["Sign up on Autodesk Education.", "Verify with a study certificate."] },
  },
];

/**
 * The benefits that matter for these fields first, then everyone's.
 *
 * @param fields - The student's courses' fields.
 */
export function benefitsFor(fields: Array<string | undefined>): StudentBenefit[] {
  const set = new Set(fields.filter(Boolean));
  const score = (b: StudentBenefit) => (b.fields?.some((f) => set.has(f)) ? 0 : b.fields?.length ? 2 : 1);
  return [...STUDENT_BENEFITS].sort((a, b) => score(a) - score(b));
}

/** Everything kept for one course (the computer's file, and what the phone sends when it syncs). */
export interface StudyCourseData {
  course: StudyCourse;
  lectures: StudyLecture[];
  cards: StudyCard[];
  reviews: StudyReview[];
  quizzes: StudyQuiz[];
  /** Drug cards (nursing). */
  drugs?: StudyDrug[];
  /** Ids of lectures, cards and drug cards deleted here, so a sync does not bring them back. */
  removed?: string[];
  /** Finished focus-timer sessions for this course. */
  focus?: StudyFocus[];
  /** Past exams she added (their text), so practice tests follow their style. */
  pastExams?: StudyPastExam[];
  /** What the course's syllabus says: exams, assignments and the topic of each week (she confirmed it). */
  syllabus?: StudySyllabus;
  /** One summary of the whole course by topic, grown as lectures are summarized. */
  courseSummary?: StudyCourseSummary;
}

/** The course's growing summary: markdown by topic, and which lectures are already in it. */
export interface StudyCourseSummary {
  text: string;
  lectureIds: string[];
  t: number;
}

/** Writing or growing the course's summary from its lectures' summaries. */
export const COURSE_SUMMARY_PROMPT =
  "You keep one study summary of a whole university course, organized by topic (not by lecture). You get the summary so far (may be empty) and summaries of new lectures. Merge the new material into the right topics, add new topics where needed, keep everything already there, remove repeats, and keep the order a student would learn it in. Markdown: a `## ` heading per topic, short bullets, key terms in bold, and after each bullet that came from a lecture, the lecture's title in brackets like [הרצאה 3]. Write in the same language as the material (usually Hebrew), keeping English technical terms as written. Use only what the material says. Answer with the full updated summary only.";

/** What to send to grow the summary, or null when no summarized lecture is new to it. */
export function courseSummaryInput(d: Pick<StudyCourseData, "lectures" | "courseSummary">, budget = 50_000): { user: string; ids: string[] } | null {
  const have = new Set(d.courseSummary?.lectureIds ?? []);
  const fresh = d.lectures.filter((l) => l.summary?.trim() && !have.has(l.id));
  if (!fresh.length) return null;
  const old = d.courseSummary?.text ?? "";
  let room = Math.max(4000, budget - old.length);
  const ids: string[] = [];
  const parts: string[] = [];
  for (const l of fresh) {
    const piece = `### ${l.title}${l.date ? ` (${l.date})` : ""}\n${l.summary!.trim()}`;
    if (parts.length && piece.length > room) break;
    parts.push(piece.slice(0, room));
    room -= piece.length;
    ids.push(l.id);
  }
  return { user: `Summary so far:\n${old || "(empty)"}\n\nNew lectures:\n\n${parts.join("\n\n")}`, ids };
}

/** A model's course summary, cleaned; keeps the lectures that went into it. */
export function parseCourseSummary(raw: string, prev: StudyCourseSummary | undefined, ids: string[], t = Date.now()): StudyCourseSummary | null {
  const body = String(raw ?? "").replace(/^```(?:markdown|md)?\s*|```\s*$/g, "").trim();
  const text = cleanScript(body, /[\u0590-\u05ff]/.test(body)).slice(0, 120_000);
  if (text.length < 40) return null;
  return { text, lectureIds: [...new Set([...(prev?.lectureIds ?? []), ...ids])], t };
}

/** One place a search across all her courses found the words. */
export interface StudyHit {
  courseId: string;
  course: string;
  kind: "lecture" | "summary" | "notes" | "card" | "term";
  lectureId?: string;
  title: string;
  snippet: string;
}

const fold = (t: string) => t.toLowerCase().replace(/[\u0591-\u05c7]/g, "");

/**
 * Searches every course: lecture text, summaries, her notes, cards and glossary terms. Every word must appear
 * (Hebrew prefixes like ו/ה/ב/ל/מ/ש/כ are fine: matching is inside words). Best first: titles and terms, then notes.
 */
export function searchStudy(courses: Array<Pick<StudyCourseData, "course" | "lectures" | "cards">>, query: string, limit = 40): StudyHit[] {
  const want = fold(query).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
  if (!want.length) return [];
  const has = (t: string) => { const f = fold(t); return want.every((w) => f.includes(w)); };
  const snip = (t: string) => {
    const f = fold(t);
    const at = Math.max(0, f.indexOf(want[0]!) - 60);
    return `${at ? "…" : ""}${t.slice(at, at + 180).replace(/\s+/g, " ").trim()}${t.length > at + 180 ? "…" : ""}`;
  };
  const out: Array<StudyHit & { rank: number }> = [];
  for (const d of courses) {
    const base = { courseId: d.course.id, course: d.course.name };
    for (const l of d.lectures) {
      for (const t of l.terms ?? []) if (has(`${t.term} ${t.en ?? ""} ${t.explain}`)) out.push({ ...base, kind: "term", lectureId: l.id, title: t.term, snippet: snip(t.explain), rank: has(t.term) ? 0 : 2 });
      if (l.notes && has(l.notes)) out.push({ ...base, kind: "notes", lectureId: l.id, title: l.title, snippet: snip(l.notes), rank: 1 });
      if (l.summary && has(`${l.title} ${l.summary}`)) out.push({ ...base, kind: "summary", lectureId: l.id, title: l.title, snippet: snip(has(l.summary) ? l.summary : l.title), rank: has(l.title) ? 0 : 2 });
      else if (has(`${l.title} ${l.text}`)) out.push({ ...base, kind: "lecture", lectureId: l.id, title: l.title, snippet: snip(has(l.text) ? l.text : l.title), rank: has(l.title) ? 1 : 3 });
    }
    for (const c of d.cards) if (has(`${c.front} ${c.back}`)) out.push({ ...base, kind: "card", ...(c.lectureId ? { lectureId: c.lectureId } : {}), title: c.front.slice(0, 120), snippet: snip(c.back), rank: 3 });
  }
  return out.sort((x, y) => x.rank - y.rank).slice(0, limit).map(({ rank: _r, ...h }) => h);
}

/** A course's syllabus, read once from its file and confirmed by her. Dates are YYYY-MM-DD. */
export interface StudySyllabus {
  exams: Array<{ title: string; date: string }>;
  assignments: Array<{ title: string; date: string }>;
  weeks: Array<{ week: number; topic: string; date?: string }>;
  t: number;
}

/** Reading a syllabus: dates of exams and assignments, and the topic of each week. */
export const SYLLABUS_PROMPT = (today: string) =>
  `You read a university course syllabus. Today is ${today}. Find the exams (midterm, final, quizzes: moed A/B too), the assignments or papers with their due dates, and the topic of each week or lesson. Dates as YYYY-MM-DD (when the year is missing, use the coming occurrence after today); leave out anything without a clear date, except weekly topics (date optional). Titles and topics in the syllabus's language, short. Answer with JSON only: {"exams":[{"title":"...","date":"YYYY-MM-DD"}],"assignments":[{"title":"...","date":"YYYY-MM-DD"}],"weeks":[{"week":1,"topic":"...","date":"YYYY-MM-DD"}]}`;

const isDate = (d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T12:00:00`));

/**
 * A model's reading of a syllabus, checked: real dates only, short titles, at most 30 of each, sorted by date.
 *
 * @param raw - The model's reply (or a syllabus object to clean).
 * @returns The syllabus, or undefined when nothing usable was found.
 */
export function parseSyllabus(raw: unknown, now = Date.now()): StudySyllabus | undefined {
  const j = (typeof raw === "string" ? jsonIn(raw) : raw) as Partial<Record<"exams" | "assignments" | "weeks", unknown[]>> | undefined;
  if (!j || typeof j !== "object") return undefined;
  const dated = (list: unknown) => (Array.isArray(list) ? list : [])
    .filter((x): x is { title: unknown; date: string } => !!x && typeof x === "object" && isDate((x as { date?: unknown }).date) && !!String((x as { title?: unknown }).title ?? "").trim())
    .map((x) => ({ title: String(x.title).trim().slice(0, 120), date: x.date }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 30);
  const weeks = (Array.isArray(j.weeks) ? j.weeks : [])
    .filter((x): x is { week: unknown; topic: unknown; date?: unknown } => !!x && typeof x === "object" && !!String((x as { topic?: unknown }).topic ?? "").trim())
    .map((x, i) => ({ week: Math.max(1, Math.min(60, Math.round(Number(x.week)) || i + 1)), topic: String(x.topic).trim().slice(0, 200), ...(isDate(x.date) ? { date: x.date } : {}) }))
    .slice(0, 30);
  const out = { exams: dated(j.exams), assignments: dated(j.assignments), weeks, t: now };
  return out.exams.length || out.assignments.length || out.weeks.length ? out : undefined;
}

/**
 * What the syllabus says for now: the next exam and assignments (next 21 days), and this week's topic (the week
 * whose date is the latest one not after today).
 */
export function syllabusNow(s: StudySyllabus | undefined, now = Date.now()): { nextExam?: { title: string; date: string; daysLeft: number }; due: Array<{ title: string; date: string; daysLeft: number }>; week?: { week: number; topic: string } } {
  if (!s) return { due: [] };
  const today = dayKey(now);
  const days = (d: string) => Math.round((Date.parse(`${d}T12:00:00`) - Date.parse(`${today}T12:00:00`)) / 86_400_000);
  const exam = s.exams.find((e) => e.date >= today);
  const due = s.assignments.filter((a) => a.date >= today && days(a.date) <= 21).map((a) => ({ ...a, daysLeft: days(a.date) }));
  const week = [...s.weeks].filter((w) => w.date && w.date <= today).sort((a, b) => b.date!.localeCompare(a.date!))[0];
  return { ...(exam ? { nextExam: { ...exam, daysLeft: days(exam.date) } } : {}), due, ...(week ? { week: { week: week.week, topic: week.topic } } : {}) };
}

/** A past exam's text (from a file or photo), kept to write practice tests like it. */
export interface StudyPastExam {
  id: string;
  title: string;
  text: string;
  t: number;
}

/** The style note for a practice test "like the past exams": excerpts of each (questions, format, difficulty). */
export function pastExamStyle(exams: StudyPastExam[], budget = 8000): string {
  if (!exams.length) return "";
  const each = Math.floor(budget / exams.length);
  return `Write the questions like these past exams of this course: the same kinds of questions, format, length, difficulty and topics they stress (do not copy their questions word for word; write new ones, only about what the lectures say, never a fact the lectures do not give):\n\n${exams.map((e) => `--- Past exam: ${e.title}\n${e.text.slice(0, each)}`).join("\n\n")}`;
}

/**
 * Cards as tab-separated text, one card a line (front, back): what Anki ("Notes in plain text") and Quizlet import.
 * Line breaks inside a card become <br>, tabs become spaces.
 */
export function cardsToTsv(cards: Array<{ front: string; back: string }>): string {
  const cell = (t: string) => t.replace(/\t/g, " ").replace(/\r?\n/g, "<br>");
  return cards.map((c) => `${cell(c.front)}\t${cell(c.back)}`).join("\n");
}

/**
 * Cards from an Anki or Quizlet export (tab-, semicolon- or comma-separated, one card a line; Anki's "#" header lines
 * skipped; <br> back to a line break; quoted cells unwrapped). At most 2000.
 */
export function cardsFromTsv(text: string): Array<{ front: string; back: string }> {
  const out: Array<{ front: string; back: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    const sep = line.includes("\t") ? "\t" : line.includes(";") ? ";" : ",";
    const [f, ...rest] = line.split(sep);
    const un = (t = "") => t.trim().replace(/^"([\s\S]*)"$/, "$1").replace(/""/g, '"').replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim();
    const front = un(f).slice(0, 1000);
    const back = un(rest.join(sep)).slice(0, 3000);
    if (front && back) out.push({ front, back });
    if (out.length >= 2000) break;
  }
  return out;
}

/** "What to study now": one next step across her courses, most urgent first. */
export interface StudyNext {
  kind: "due-soon" | "exam-soon" | "review" | "weak" | "summarize" | "cards" | "focus";
  courseId: string;
  course: string;
  /** What it is about: the assignment, the lecture, or the number of cards. */
  what?: string;
  lectureId?: string;
  days?: number;
}

/**
 * The one thing to study now (like a study coach): an assignment due within 2 days, an exam within 7 (a practice
 * test on weak topics), cards due for review, a weak lecture, a lecture not yet summarised, a summarised one with no
 * cards, else a focus session.
 *
 * @param courses - Her courses.
 * @param now - Now.
 * @returns The step, or undefined when she has no course.
 */
export function studyNext(courses: StudyCourseData[], now = Date.now()): StudyNext | undefined {
  if (!courses.length) return undefined;
  const base = (d: StudyCourseData) => ({ courseId: d.course.id, course: d.course.name });
  for (const d of courses) {
    const due = syllabusNow(d.syllabus, now).due.find((a) => a.daysLeft <= 2);
    if (due) return { kind: "due-soon", ...base(d), what: due.title, days: due.daysLeft };
  }
  for (const d of courses) {
    const plan = examPlan(d, now);
    if (plan && plan.daysLeft <= 7) return { kind: "exam-soon", ...base(d), days: plan.daysLeft };
  }
  const reviews = courses.map((d) => ({ d, n: cardsToReview(d, now).length })).sort((a, b) => b.n - a.n)[0];
  if (reviews && reviews.n > 0) return { kind: "review", ...base(reviews.d), what: String(reviews.n) };
  for (const d of courses) {
    const weak = weakLectures(d.quizzes).find((w) => w.correct < 0.6 && w.n >= 3);
    const l = weak && d.lectures.find((x) => x.id === weak.lectureId);
    if (l) return { kind: "weak", ...base(d), what: l.title, lectureId: l.id };
  }
  for (const d of courses) {
    const l = [...d.lectures].reverse().find((x) => !x.summary && x.text.length > 200);
    if (l) return { kind: "summarize", ...base(d), what: l.title, lectureId: l.id };
  }
  for (const d of courses) {
    const l = [...d.lectures].reverse().find((x) => x.summary && !d.cards.some((c) => c.lectureId === x.id));
    if (l) return { kind: "cards", ...base(d), what: l.title, lectureId: l.id };
  }
  return { kind: "focus", ...base(courses[0]!) };
}

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

const lectureWeight = (l: StudyLecture) => (l.summary ? 4 : 0) + (l.terms?.length ? 2 : 0) + (l.diagram ? 1 : 0);
const lastReview = (c: StudyCard) => String((c.fsrs as { last_review?: unknown }).last_review ?? "");

function byId<T extends { id: string }>(a: T[], b: T[], gone: Set<string>, pick: (x: T, y: T) => T): T[] {
  const out = new Map<string, T>();
  for (const x of a) if (!gone.has(x.id)) out.set(x.id, x);
  for (const y of b) {
    if (gone.has(y.id)) continue;
    const x = out.get(y.id);
    out.set(y.id, x ? pick(x, y) : y);
  }
  return [...out.values()];
}

/**
 * Merges two copies of a course (the phone's and the computer's) so studying in either place counts: everything from
 * both is kept, except what was deleted in either. For the same card, the copy reviewed last wins (its schedule is
 * newer); for the same lecture, the one with more made from it (summary, terms, diagram), then the longer text.
 *
 * @param a - One copy (it wins ties, and gives the name unless only `b`'s field was chosen by the student).
 * @param b - The other copy.
 * @returns The merged course.
 */
export function mergeCourseData(a: StudyCourseData, b: StudyCourseData): StudyCourseData {
  const removed = [...new Set([...(a.removed ?? []), ...(b.removed ?? [])])].slice(-5000);
  const gone = new Set(removed);
  const seen = new Set<string>();
  const reviews = [...a.reviews, ...b.reviews]
    .filter((r) => {
      const k = `${r.cardId}:${r.t}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((x, y) => x.t - y.t);
  const field = !a.course.fieldChosen && b.course.fieldChosen ? { field: b.course.field, fieldChosen: true } : {};
  const drugs = byId(a.drugs ?? [], b.drugs ?? [], gone, (x) => x);
  const pastExams = byId(a.pastExams ?? [], b.pastExams ?? [], gone, (x) => x);
  const syllabus = !a.syllabus ? b.syllabus : !b.syllabus ? a.syllabus : b.syllabus.t > a.syllabus.t ? b.syllabus : a.syllabus;
  const courseSummary = !a.courseSummary ? b.courseSummary : !b.courseSummary ? a.courseSummary : b.courseSummary.t > a.courseSummary.t ? b.courseSummary : a.courseSummary;
  const focusSeen = new Set<number>();
  const focus = [...(a.focus ?? []), ...(b.focus ?? [])].filter((f) => !focusSeen.has(f.t) && focusSeen.add(f.t)).sort((x, y) => x.t - y.t).slice(-5000);
  return {
    course: { ...a.course, ...field, ...(!a.course.examDate && b.course.examDate ? { examDate: b.course.examDate } : {}) },
    lectures: byId(a.lectures, b.lectures, gone, (x, y) => {
      const pick = lectureWeight(y) > lectureWeight(x) || (lectureWeight(y) === lectureWeight(x) && y.text.length > x.text.length) ? y : x;
      // Her notes are hers: the newer notes win whichever copy has the better summary.
      const notes = (y.notesT ?? 0) > (x.notesT ?? 0) ? y : x;
      if (notes.notesT === pick.notesT) return pick;
      const { notes: _n, notesT: _t, ...rest } = pick;
      return { ...rest, ...(notes.notes ? { notes: notes.notes } : {}), ...(notes.notesT ? { notesT: notes.notesT } : {}) };
    }),
    cards: byId(a.cards, b.cards, gone, (x, y) => (lastReview(y) > lastReview(x) ? y : x)),
    reviews,
    quizzes: byId(a.quizzes, b.quizzes, gone, (x, y) => (!x.answers && y.answers ? y : x)).sort((x, y) => x.t - y.t),
    ...(drugs.length ? { drugs } : {}),
    ...(removed.length ? { removed } : {}),
    ...(focus.length ? { focus } : {}),
    ...(pastExams.length ? { pastExams } : {}),
    ...(syllabus ? { syllabus } : {}),
    ...(courseSummary ? { courseSummary } : {}),
  };
}

/** Where a course stands before its exam. */
export interface ExamPlan {
  date: string;
  /** Whole days from today to the exam day (0 on the day itself). */
  daysLeft: number;
  /** Cards due now. */
  dueNow: number;
  /** Cards whose next review falls after the exam: each is shown once more before it. */
  beforeExam: number;
  /** Cards a day, to get through all of them by the exam. */
  perDay: number;
  /** Lectures with nothing to study from yet (no summary, or no cards). */
  notReady: Array<{ id: string; title: string }>;
  /** The last week: a practice test on the weak topics is worth it now. */
  testWeek: boolean;
}

const DAY = 86_400_000;
const examAt = (date: string) => Date.parse(`${date}T08:00:00`);

/**
 * The plan toward a course's exam: how many cards a day, what has nothing to study from yet, and whether it is the
 * week for practice tests. Cards scheduled after the exam are brought forward (seen once more before it), the
 * standard "review before a deadline" of spaced-repetition apps.
 *
 * @param d - The course.
 * @param now - Now (ms).
 * @returns The plan, or undefined without an exam date or after the exam.
 */
export function examPlan(d: StudyCourseData, now = Date.now()): ExamPlan | undefined {
  const date = d.course.examDate;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const at = examAt(date);
  if (at + DAY < now) return undefined;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const daysLeft = Math.max(0, Math.round((examAt(date) - 8 * 3_600_000 - today.getTime()) / DAY));
  const dueNow = d.cards.filter((c) => Date.parse(c.due) <= now).length;
  const beforeExam = d.cards.filter((c) => Date.parse(c.due) > at && Date.parse(String((c.fsrs as { last_review?: string }).last_review ?? 0)) < now - 2 * DAY).length;
  const cardsOf = new Set(d.cards.map((c) => c.lectureId));
  return {
    date,
    daysLeft,
    dueNow,
    beforeExam,
    perDay: Math.ceil((dueNow + beforeExam) / Math.max(1, daysLeft)),
    notReady: d.lectures.filter((l) => !l.summary || !cardsOf.has(l.id)).map((l) => ({ id: l.id, title: l.title })),
    testWeek: daysLeft <= 7,
  };
}

/**
 * The cards to review now: those due, then (with an exam in the plan) the ones scheduled after the exam, up to the
 * day's share, earliest first.
 *
 * @param d - The course.
 * @param now - Now (ms).
 * @param limit - At most this many.
 * @returns The cards.
 */
export function cardsToReview(d: StudyCourseData, now = Date.now(), limit = 50): StudyCard[] {
  const due = d.cards.filter((c) => Date.parse(c.due) <= now).sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
  const plan = examPlan(d, now);
  if (!plan || due.length >= plan.perDay) return due.slice(0, limit);
  const at = examAt(plan.date);
  const ahead = d.cards
    .filter((c) => Date.parse(c.due) > at && Date.parse(String((c.fsrs as { last_review?: string }).last_review ?? 0)) < now - 2 * DAY)
    .sort((a, b) => Date.parse(a.due) - Date.parse(b.due))
    .slice(0, plan.perDay - due.length);
  return [...due, ...ahead].slice(0, limit);
}

/** A piece of a lecture found for a question. */
export interface StudyPassage {
  lectureId: string;
  title: string;
  text: string;
  /** The file's page or slide the passage starts on (lectures read from a PDF or slides keep "— 12 —" marks). */
  page?: number;
}

const PAGE_MARK = /(?:^|\n)— (\d{1,4}) —\n/g;

/** The page or slide a place in a lecture's text is on, from the "— n —" marks a file's pages keep. */
export function pageAt(text: string, at: number): number | undefined {
  let page: number | undefined;
  PAGE_MARK.lastIndex = 0;
  for (let m = PAGE_MARK.exec(text); m && m.index <= at; m = PAGE_MARK.exec(text)) page = Number(m[1]);
  return page;
}

/** A passage's label for the model: its lecture, and its page when known (so the answer can cite "p. 12"). */
export const passageLabel = (p: StudyPassage) => `[Lecture: ${p.title}${p.page ? `, p. ${p.page}` : ""}]`;

const STOP = new Set(["the", "and", "what", "how", "why", "is", "are", "of", "to", "in", "a", "an", "את", "של", "על", "מה", "איך", "למה", "זה", "זו", "הוא", "היא", "עם", "או", "גם", "כי", "אם", "לא", "יש", "אין", "כל", "אני", "מתי", "איזה", "אילו"]);

/** Words of a text for matching: lower case, Hebrew prefixes (ו ה ב ל מ ש כ) off longer words. */
function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => (/^[֐-׿]/.test(w) && w.length > 3 ? w.replace(/^[והבלמשכ]{1,2}(?=[֐-׿]{3})/, "") : w)).filter((w) => w.length > 1 && !STOP.has(w));
}

/**
 * The lecture passages that best match a question (word overlap, rare words counting more), for answering only from
 * the student's own material. Lectures are cut into ~1500-character pieces.
 *
 * @param lectures - The course's lectures.
 * @param question - Her question.
 * @param budget - Characters to return at most.
 * @returns The passages, best first.
 */
export function findPassages(lectures: StudyLecture[], question: string, budget = 9000): StudyPassage[] {
  const want = new Set(words(question));
  if (!want.size) return [];
  const pieces: Array<StudyPassage & { w: string[] }> = [];
  for (const l of lectures) {
    const body = l.text.length > 200 ? l.text : `${l.text}\n${l.summary ?? ""}`;
    for (let i = 0; i < body.length; i += 1400) {
      const text = body.slice(i, i + 1500);
      // The page it starts on, or the first page mark inside it.
      const page = pageAt(body, i) ?? pageAt(text, text.length);
      pieces.push({ lectureId: l.id, title: l.title, text, ...(page ? { page } : {}), w: words(`${l.title} ${text}`) });
    }
  }
  const df = new Map<string, number>();
  for (const p of pieces) for (const w of new Set(p.w)) if (want.has(w)) df.set(w, (df.get(w) ?? 0) + 1);
  const scored = pieces
    .map((p) => {
      const seen = new Set(p.w);
      let score = 0;
      for (const w of want) if (seen.has(w)) score += Math.log(1 + pieces.length / (df.get(w) ?? 1));
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const out: StudyPassage[] = [];
  let used = 0;
  for (const { p } of scored) {
    if (used + p.text.length > budget) break;
    out.push({ lectureId: p.lectureId, title: p.title, text: p.text, ...(p.page ? { page: p.page } : {}) });
    used += p.text.length;
  }
  return out;
}

/** The tutor's instructions: answer only from her lectures, say which lecture, and say so when they do not cover it. */
export const TUTOR_PROMPT =
  "You are a tutor for a student's course. Answer only from the lecture passages given (her own material), in the language of her question, clearly and briefly, with an example when it helps. After each fact, name its lecture in square brackets, like [Lecture: <title>]; when the passage is a recording's transcript with times (lines starting like 12:30), add the minute, like [Lecture: <title>, 12:30]; when the passage's label has a page (p. 12), add it, like [Lecture: <title>, p. 12], so she can find it. If the passages do not answer the question, say that her lectures do not cover it, and what to look up; do not answer from general knowledge. Never invent numbers, doses or values.";

/**
 * A calculation question checked against its own working: the last result after "=" in the explanation must be one
 * of the options (found on the PC: the model worked out 66.7 and then marked 80). The question is fixed when another
 * option matches its result, and dropped when none does. Questions without numbers pass unchanged.
 *
 * @returns The question (maybe with the answer fixed), or undefined to drop it.
 */
export function checkCalcQuestion<T extends { options: string[]; answer: number; explain?: string }>(q: T): T | undefined {
  const nums = [...String(q.explain ?? "").matchAll(/=\s*(-?\d[\d,]*(?:\.\d+)?)/g)].map((m) => Number(m[1]!.replace(/,/g, "")));
  const result = nums.at(-1);
  const optNum = q.options.map((o) => { const m = /-?\d[\d,]*(?:\.\d+)?/.exec(o); return m ? Number(m[0].replace(/,/g, "")) : NaN; });
  // Only when the options are numbers and the explanation worked one out.
  if (result === undefined || !Number.isFinite(result) || optNum.filter(Number.isFinite).length < 2) return q;
  const close = (a: number) => Math.abs(a - result) <= Math.max(0.5, Math.abs(result) * 0.01);
  const hit = optNum.findIndex((n) => Number.isFinite(n) && close(n));
  if (hit < 0) return undefined;
  return hit === q.answer ? q : { ...q, answer: hit };
}

/** Study mode: the tutor asks her about her own lectures, waits, then corrects (Socratic, like ChatGPT's study mode). */
export const STUDY_MODE_PROMPT =
  "You are a tutor quizzing a student on her own lecture passages (given). Do not lecture. Ask ONE short question at a time about the passages, then stop and wait for her answer. When she answers: judge it only by what the passages say (not by general knowledge): if the passages say something else, it is not right, even if it could be true elsewhere. Say plainly whether it is right, give the passages' answer briefly and name the lecture in square brackets, like [Lecture: <title>], then ask the next question: a little harder if she was right, simpler if not. If she asks for help, give a hint as a question before the answer. Write only in her language (the lectures' language when she has not written yet), with no words in other languages or scripts. Never invent numbers, doses or values.";

/** Homework help: step by step, one hint at a time, the full solution only when she asks (Khanmigo-like, without the wall). */
export const HOMEWORK_PROMPT =
  "You help a student with a homework problem step by step, like a good tutor. Do not solve it at once. First, in two short lines, say what the problem asks and ask what she tried, or give only the first step as a question. When she writes a step, say whether it is right and why, then point to the next step. When she asks for a hint, give ONE short hint (each hint a little more direct than the last). Only when she asks for the full solution, give it worked out step by step, then one line on the idea to remember. Use the lecture passages when they help (name the lecture in square brackets, like [Lecture: <title>]); general knowledge is allowed for homework, but never invent numbers, doses or values that the problem does not give. Write math as plain text (like 1000 × 20 ÷ 480 = 41.7), never LaTeX. Write only in her language.";

/** Live translation of a lecture's transcript, half a minute at a time. */
export const TRANSLATE_PROMPT = (to: "he" | "en") =>
  `Translate this piece of a live lecture transcript into ${to === "he" ? "Hebrew" : "English"}. Keep medical and scientific terms accurate (in Hebrew, add the English term in brackets the first time). The transcript may have recognition mistakes: translate the meaning. Answer with the translation only.`;

/** Models with English instructions drift into English (found on the PC): Hebrew material says so at the end. */
const hebrewAsk = (sample: string) => (/[\u0590-\u05ff]/.test(sample) ? "\n\n(Answer in Hebrew.)" : "");

/** Explaining a passage she selected in a lecture (like "explain this" in PDF readers), by kind. */
const EXPLAIN_RULES = " Write only in the passage's language (English only for a technical term, in brackets). Be accurate: if the lecture does not explain it, give the standard textbook meaning carefully and say it is not from the lecture.";
export const EXPLAIN_PROMPTS: Record<"explain" | "simple" | "example", string> = {
  explain: "A student selected a passage from her lecture and asks what it means. Explain it clearly in 3-5 short sentences in the passage's language: what it says, the terms in it, and why it matters in this lecture. Use the lecture context given; never invent numbers, doses or values.",
  simple: "A student selected a passage from her lecture that she finds hard. Say it again in very simple words, as to a first-year student, in 2-4 short sentences in the passage's language, with an everyday comparison if one fits. Never invent numbers, doses or values.",
  example: "A student selected a passage from her lecture. Give one short concrete example (for clinical material, a short patient case) that shows what it means, in the passage's language, then one line linking it back to the passage. Never invent doses or values that the lecture does not give.",
};

/** The messages for explaining a selected passage, with the lecture around it as context. */
export function explainMessages(o: { selection: string; lecture: StudyLecture; kind: "explain" | "simple" | "example"; hint?: string }): TutorMessage[] {
  const sel = o.selection.trim().slice(0, 3000);
  const ctx = (o.lecture.summary || o.lecture.text).slice(0, 4000);
  return [
    { role: "system", content: `${EXPLAIN_PROMPTS[o.kind]}${EXPLAIN_RULES}${o.hint ? `\n${o.hint}` : ""}` },
    { role: "user", content: `Lecture: ${o.lecture.title}\nContext from the lecture:\n${ctx}\n\nThe passage she selected:\n${sel}${hebrewAsk(`${sel} ${ctx.slice(0, 300)}`)}` },
  ];
}

/** Study mode's grading step: a verdict only, as JSON, so even a small or code-minded model grades by her lecture. */
export const GRADE_PROMPT =
  'You grade a student\'s answer to a question about her lecture, using ONLY the lecture passages given (not general knowledge: if the passages say something else, the answer is wrong). Answer with JSON only: {"verdict": "right" | "partly" | "wrong", "answer": "the passages\' answer in one short sentence, in the question\'s language"}';

/**
 * The messages for grading her answer in study mode.
 *
 * @param o.lectures - The course's lectures.
 * @param o.tutorQuestion - The question the tutor asked.
 * @param o.answer - Her answer.
 * @returns The messages and the passages used.
 */
export function gradeMessages(o: { lectures: StudyLecture[]; tutorQuestion: string; answer: string; budget?: number }): { messages: TutorMessage[]; passages: StudyPassage[] } {
  const passages = findPassages(o.lectures, `${o.tutorQuestion} ${o.answer}`.slice(0, 3000), o.budget ?? 6000);
  const material = passages.length ? passages.map((p) => `${passageLabel(p)}\n${p.text}`).join("\n\n---\n\n") : "(No passage matches.)";
  return { messages: [{ role: "system", content: GRADE_PROMPT }, { role: "user", content: `Passages:\n\n${material}\n\nQuestion: ${o.tutorQuestion.slice(0, 1000)}\nHer answer: ${o.answer.slice(0, 1000)}` }], passages };
}

/**
 * Her grade in words (written here, not by the model, so it never says "right" to a wrong answer in another language).
 *
 * @param raw - The model's reply to the grading messages.
 * @param he - Whether she studies in Hebrew.
 * @returns The line, or undefined when the reply had no verdict.
 */
export function gradeLine(raw: string, he: boolean): string | undefined {
  const j = jsonIn(raw) as { verdict?: string; answer?: string } | undefined;
  const v = String(j?.verdict ?? "").toLowerCase();
  if (!["right", "partly", "wrong"].includes(v)) return undefined;
  const answer = cleanScript(String(j?.answer ?? "").trim(), he).slice(0, 600);
  const head = v === "right" ? (he ? "✓ נכון." : "✓ Right.") : v === "partly" ? (he ? "◐ נכון בחלקו." : "◐ Partly right.") : he ? "✗ לא בדיוק." : "✗ Not quite.";
  return answer ? `${head} ${he ? "לפי ההרצאה: " : "Your lecture says: "}${answer}` : head;
}

/**
 * Removes letters of other scripts a model slipped into a Hebrew (or English) answer (Chinese, Arabic, Cyrillic…),
 * keeping Hebrew, Latin (terms, drug names), digits and punctuation; the lecture label becomes Hebrew.
 *
 * @param text - The model's text.
 * @param he - Whether the text should be Hebrew.
 * @returns The text.
 */
export function cleanScript(text: string, he: boolean): string {
  if (!he) return text;
  // The lecture label in Hebrew too ([Lecture: …] → [הרצאה: …]).
  return text.replace(/[\u0400-\u04ff\u0600-\u06ff\u3000-\u30ff\u3400-\u9fff\uac00-\ud7af\uff00-\uffef]+/g, "").replace(/[ \t]{2,}/g, " ").replace(/\[\s*lecture\s*:\s*/gi, "[הרצאה: ");
}

/** Why a missed card's answer is right, in one or two sentences, from her lecture. */
export const MISSED_PROMPT =
  "A student got this flashcard wrong. In one or two short sentences, in the card's language, explain why the answer is right, using the lecture passage when it helps, so it sticks (a reason, a link or a memory trick). Never invent numbers, doses or values. Write only the explanation.";

/** A chat message for the tutor's model. */
export interface TutorMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * The messages for the course tutor, the same on the computer and on the phone.
 *
 * @param o.lectures - The course's lectures.
 * @param o.question - Her question, or her answer in study mode ("" starts study mode with a first question).
 * @param o.history - The earlier turns (the last 6 are kept, each cut to 4000 characters).
 * @param o.mode - "ask": answers from her lectures; "study": the tutor asks her.
 * @param o.hint - The field's note for the model, if any.
 * @param o.budget - Characters of lecture passages at most.
 * @param o.pick - For study mode's first question: picks a lecture (tests pass a fixed one; default random).
 * @returns The messages and the passages used.
 */
export function tutorMessages(o: { lectures: StudyLecture[]; question: string; history?: Array<{ role: string; content: string }>; mode?: "ask" | "study" | "homework"; hint?: string; budget?: number; pick?: (n: number) => number }): { messages: TutorMessage[]; passages: StudyPassage[] } {
  const study = o.mode === "study";
  const turns = (o.history ?? [])
    .filter((h): h is { role: "user" | "assistant"; content: string } => (h.role === "user" || h.role === "assistant") && typeof h.content === "string")
    .slice(-6)
    .map((h) => ({ role: h.role, content: h.content.slice(0, 4000) }));
  const q = o.question.trim().slice(0, 2000);
  const budget = o.budget ?? 9000;
  // The passages: what her question (and the tutor's last question, in study mode) is about.
  const last = [...turns].reverse().find((h) => h.role === (study ? "assistant" : "user"))?.content ?? "";
  let passages = q || last ? findPassages(o.lectures, `${q} ${last}`.slice(0, 3000), budget) : [];
  if (study && !passages.length) {
    // The first question (or nothing matched): a stretch of one lecture, chosen at random.
    const withText = o.lectures.filter((l) => l.text.trim() || l.summary);
    const l = withText[(o.pick ?? ((n) => Math.floor(Math.random() * n)))(withText.length)];
    if (l) {
      const body = l.text.length > 200 ? l.text : `${l.text}\n${l.summary ?? ""}`;
      const from = body.length > budget ? Math.floor(((o.pick ?? ((n) => Math.floor(Math.random() * n)))(1000) / 1000) * (body.length - budget)) : 0;
      passages = [{ lectureId: l.id, title: l.title, text: body.slice(from, from + Math.min(budget, 4000)) }];
    }
  }
  const material = passages.length ? passages.map((p) => `${passageLabel(p)}\n${p.text}`).join("\n\n---\n\n") : "(No passage of her lectures matches this question.)";
  const homework = o.mode === "homework";
  const system = `${study ? STUDY_MODE_PROMPT : homework ? HOMEWORK_PROMPT : TUTOR_PROMPT}${o.hint ? `\n${o.hint}` : ""}`;
  // Homework: the problem is the first thing she wrote; her later messages are steps, hints asked for, or "full solution".
  const problem = homework ? (turns.find((h) => h.role === "user")?.content ?? q) : "";
  const user = homework ? `Passages from her lectures:\n\n${material}\n\n${turns.length ? `The problem: ${problem.slice(0, 3000)}\n\nHer message: ${q}` : `The problem: ${q}`}` : study ? (q ? `Passages from her lectures:\n\n${material}\n\nHer answer: ${q}` : `Passages from her lectures:\n\n${material}\n\n${turns.length ? "Ask her the next question (a new one, not asked above). Only the question." : "Start: ask her the first question."}`) : `Passages from her lectures:\n\n${material}\n\nHer question: ${q}`;
  return { messages: [{ role: "system", content: system }, ...turns, { role: "user", content: `${user}${hebrewAsk(`${q} ${o.lectures[0]?.text.slice(0, 300) ?? ""}`)}` }], passages };
}

/** The spoken review of a lecture: written to be heard, not read. */
export const AUDIO_PROMPT =
  "Write a spoken review of this lecture for a student to listen to on the bus, about 3 minutes long (400-550 words), in the lecture's language. Talk to her directly and warmly, like a good tutor: open with what the lecture is about in one sentence, go through the main ideas in a sensible order with one concrete example, say the key terms clearly (with the English name in brackets the first time, for medical terms), and end with three short questions to think about, each followed by its answer. Plain spoken sentences only: no headings, lists, symbols, tables or markdown. Use only what is in the lecture; never invent numbers, doses or values.";

/** A course as a file to share with classmates: its material, without her own answers and review history. */
export interface SharedCourse {
  kind: "kesherai-course";
  version: 1;
  name: string;
  field?: string;
  lectures: Array<Pick<StudyLecture, "title" | "date" | "text" | "summary" | "terms" | "diagram" | "audio">>;
  cards: Array<Pick<StudyCard, "front" | "back" | "format" | "kind"> & { lecture?: number }>;
  drugs?: Array<Omit<StudyDrug, "id">>;
}

/**
 * The course as a file to share: the lectures and what was made from them, and the cards (without their schedules:
 * whoever opens it starts them fresh). Her reviews, quiz answers and progress stay hers.
 *
 * @param d - The course.
 * @returns The shared form.
 */
export function shareCourse(d: StudyCourseData): SharedCourse {
  const index = new Map(d.lectures.map((l, i) => [l.id, i]));
  return {
    kind: "kesherai-course",
    version: 1,
    name: d.course.name,
    ...(d.course.field ? { field: d.course.field } : {}),
    lectures: d.lectures.map(({ title, date, text, summary, terms, diagram, audio }) => ({ title, date, text, ...(summary ? { summary } : {}), ...(terms ? { terms } : {}), ...(diagram ? { diagram } : {}), ...(audio ? { audio } : {}) })),
    cards: d.cards.map((c) => ({ front: c.front, back: c.back, format: c.format, ...(c.kind ? { kind: c.kind } : {}), ...(c.lectureId && index.has(c.lectureId) ? { lecture: index.get(c.lectureId) } : {}) })),
    ...(d.drugs?.length ? { drugs: d.drugs.map(({ id: _id, ...g }) => g) } : {}),
  };
}

/**
 * A shared course file as a new course of her own: new ids, every card new on the schedule.
 *
 * @param s - The file's content.
 * @param newId - Makes an id.
 * @param newCard - A fresh FSRS card for `now` (from the app's scheduler).
 * @param now - Now (ms).
 * @returns The course, or undefined when the file is not a shared course.
 */
export function openSharedCourse(s: unknown, newId: () => string, newCard: (now: Date) => Record<string, unknown>, now = Date.now()): StudyCourseData | undefined {
  const f = s as Partial<SharedCourse> | undefined;
  if (!f || f.kind !== "kesherai-course" || !Array.isArray(f.lectures) || !Array.isArray(f.cards)) return undefined;
  const lectures: StudyLecture[] = f.lectures.map((l) => ({ ...l, id: newId(), title: String(l.title ?? ""), date: String(l.date ?? ""), text: String(l.text ?? "") }));
  const at = new Date(now);
  const cards: StudyCard[] = f.cards.map((c) => ({
    id: newId(),
    front: String(c.front ?? ""),
    back: String(c.back ?? ""),
    format: STUDY_FORMATS.includes(c.format) ? c.format : "text",
    ...(c.kind ? { kind: c.kind } : {}),
    ...(typeof c.lecture === "number" && lectures[c.lecture] ? { lectureId: lectures[c.lecture]!.id } : {}),
    createdAt: now,
    due: at.toISOString(),
    fsrs: newCard(at),
  }));
  return {
    course: { id: newId(), name: String(f.name ?? "Course").slice(0, 120), createdAt: now, ...(f.field ? { field: f.field } : {}) },
    lectures,
    cards,
    reviews: [],
    quizzes: [],
    ...(f.drugs?.length ? { drugs: f.drugs.map((g) => ({ ...g, id: newId() })) } : {}),
  };
}
