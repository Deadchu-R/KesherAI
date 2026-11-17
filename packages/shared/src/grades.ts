/**
 * Grades and the weighted average (design Grades, RESEARCH_LOG "Students, part 27" #2): each course's credits (נק"ז)
 * and the parts of its grade with their weights, the course grade, what she needs in what is left for the grade she
 * wants, and the weighted average with what she needs in the credits left for a target average.
 */

/** A part of a course's grade: its weight in percent and her score once known. */
export interface GradePart {
  name: string;
  weight: number;
  score?: number;
}

/** A course in her grades: one of her Study courses or an earlier one. */
export interface GradeRow {
  id: string;
  /** Her Study course, when it is one. */
  courseId?: string;
  name: string;
  credits: number;
  parts: GradePart[];
  /** A final grade she typed (an earlier course, or the official one): wins over the parts. */
  final?: number;
  /** The lowest exam score that passes the course, when it has one (many courses: 55 or 60). */
  minExam?: number;
  /** The grade she wants in this course (else her target average). */
  want?: number;
  /** Which of her degree's requirements it counts toward (a DegreeKind id): design DegreeProgress. */
  kind?: string;
  /** A pass/fail course (design MoedB): its credits count toward the degree when passed, never in the average. */
  binary?: boolean;
  /** A pass/fail course's result, once known. */
  passed?: boolean;
}

/** A kind of credits her degree asks for (required, electives, general studies, English…), and how many. */
export interface DegreeKind {
  id: string;
  name: string;
  need: number;
}

/** All her grades. */
export interface Grades {
  rows: GradeRow[];
  /** The average she aims for. */
  target?: number;
  /** Credits she still has to take (for "what average do I need in the rest"). */
  remaining?: number;
  /** Her degree's requirements by kind (design DegreeProgress, students part 28 #7). */
  kinds?: DegreeKind[];
  /** The degree's total credits, when it says more than the kinds add up to. */
  total?: number;
  /** The lowest course grade that passes (her institution's; 60 when not set). */
  pass?: number;
  /** Her institution's rule for a retake (Moed B): the last exam counts, or the higher of the two. */
  moedRule?: "last" | "best";
  /** When she last changed them (ms), so the phone's and the computer's copies sync (the later one wins). */
  t?: number;
}

const num = (v: unknown, lo: number, hi: number): number | undefined => {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? undefined : Math.max(lo, Math.min(hi, Math.round(n * 10) / 10));
};
const text = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/[\r\n]+/g, " ").trim().slice(0, n) : "");

/** Her grades from the page, checked: at most 200 courses of at most 10 parts, numbers in range. */
export function cleanGrades(raw: unknown): Grades {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rows = (Array.isArray(o.rows) ? o.rows : []).slice(0, 200).flatMap((r, i): GradeRow[] => {
    const x = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const name = text(x.name, 120);
    if (!name) return [];
    const parts = (Array.isArray(x.parts) ? x.parts : []).slice(0, 10).flatMap((p): GradePart[] => {
      const y = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
      const weight = num(y.weight, 0, 100);
      if (weight === undefined) return [];
      const score = num(y.score, 0, 100);
      return [{ name: text(y.name, 60), weight, ...(score !== undefined ? { score } : {}) }];
    });
    const final = num(x.final, 0, 100);
    const minExam = num(x.minExam, 0, 100);
    const want = num(x.want, 0, 100);
    return [{
      id: typeof x.id === "string" && /^[\w-]{1,40}$/.test(x.id) ? x.id : `g${i}${Date.now().toString(36)}`,
      ...(typeof x.courseId === "string" && /^[\w-]{1,80}$/.test(x.courseId) ? { courseId: x.courseId } : {}),
      name,
      credits: num(x.credits, 0, 30) ?? 0,
      parts,
      ...(final !== undefined ? { final } : {}),
      ...(minExam !== undefined ? { minExam } : {}),
      ...(want !== undefined ? { want } : {}),
      ...(typeof x.kind === "string" && /^[\w-]{1,40}$/.test(x.kind) ? { kind: x.kind } : {}),
      ...(x.binary === true ? { binary: true, ...(typeof x.passed === "boolean" ? { passed: x.passed } : {}) } : {}),
    }];
  });
  const kinds = (Array.isArray(o.kinds) ? o.kinds : []).slice(0, 12).flatMap((k, i): DegreeKind[] => {
    const y = (k && typeof k === "object" ? k : {}) as Record<string, unknown>;
    const name = text(y.name, 60);
    const need = num(y.need, 0, 400);
    return name && need !== undefined ? [{ id: typeof y.id === "string" && /^[\w-]{1,40}$/.test(y.id) ? y.id : `k${i}`, name, need }] : [];
  });
  const total = num(o.total, 0, 600);
  const pass = num(o.pass, 0, 100);
  const target = num(o.target, 0, 100);
  const remaining = num(o.remaining, 0, 400);
  return { rows, ...(target !== undefined ? { target } : {}), ...(remaining !== undefined ? { remaining } : {}), ...(kinds.length ? { kinds } : {}), ...(total !== undefined ? { total } : {}), ...(pass !== undefined ? { pass } : {}), ...(o.moedRule === "last" || o.moedRule === "best" ? { moedRule: o.moedRule } : {}), ...(Number(o.t) > 0 && Number.isFinite(Number(o.t)) ? { t: Number(o.t) } : {}) };
}

/**
 * A course's grade: the final one she typed, else the weighted parts once all are known (weights that do not add up
 * to 100 are taken relative to their sum). `sofar` is the grade from the parts known so far, `left` the weight still
 * open.
 */
export function rowGrade(r: GradeRow): { grade?: number; sofar?: number; left: number } {
  if (r.final !== undefined) return { grade: r.final, left: 0 };
  const total = r.parts.reduce((s, p) => s + p.weight, 0);
  if (!total) return { left: 0 };
  const known = r.parts.filter((p) => p.score !== undefined);
  const kw = known.reduce((s, p) => s + p.weight, 0);
  const got = known.reduce((s, p) => s + p.weight * p.score!, 0);
  const left = ((total - kw) / total) * 100;
  const round = (n: number) => Math.round(n * 10) / 10;
  return { ...(left === 0 ? { grade: round(got / total) } : {}), ...(kw ? { sofar: round(got / kw) } : {}), left: round(left) };
}

/**
 * What she needs in the parts still open (as one score) to finish the course with `target`, at least the course's
 * passing exam score. Undefined when nothing is open; above 100 means it cannot be reached.
 */
export function neededFor(r: GradeRow, target: number): number | undefined {
  if (r.final !== undefined) return undefined;
  const total = r.parts.reduce((s, p) => s + p.weight, 0);
  const open = r.parts.filter((p) => p.score === undefined).reduce((s, p) => s + p.weight, 0);
  if (!total || !open) return undefined;
  const got = r.parts.filter((p) => p.score !== undefined).reduce((s, p) => s + p.weight * p.score!, 0);
  const need = Math.ceil((target * total - got) / open);
  return Math.max(0, need, r.minExam ?? 0);
}

/** The weighted average of the courses with a grade, and their credits. */
export function weightedAverage(rows: GradeRow[]): { average?: number; credits: number } {
  let sum = 0;
  let credits = 0;
  for (const r of rows) {
    const g = rowGrade(r).grade;
    if (r.binary || g === undefined || !r.credits) continue;
    sum += g * r.credits;
    credits += r.credits;
  }
  return { ...(credits ? { average: Math.round((sum / credits) * 100) / 100 } : {}), credits };
}

/**
 * The average she needs in the credits still to come to reach `target` overall. Undefined without credits to come;
 * above 100 means it cannot be reached.
 */
export function averageNeeded(rows: GradeRow[], target: number, remaining: number): number | undefined {
  if (!(remaining > 0)) return undefined;
  const { average, credits } = weightedAverage(rows);
  const need = (target * (credits + remaining) - (average ?? 0) * credits) / remaining;
  return Math.max(0, Math.round(need * 10) / 10);
}

/** One requirement's progress: credits done (passed), in progress (no grade yet) and still missing. */
export interface KindProgress {
  id: string;
  name: string;
  need: number;
  done: number;
  doing: number;
  missing: number;
}

/**
 * Her degree's progress (design DegreeProgress, like Open Student and degree audits): for each kind of credits, what
 * she passed, what she is taking now and what is still missing; and the same for the whole degree. A course counts
 * as passed with a grade at or above the pass mark (60 when not set), and as in progress while it has no grade.
 */
export function degreeProgress(g: Grades): { kinds: KindProgress[]; total: KindProgress; failed: number } {
  const pass = g.pass ?? 60;
  const sum = (rows: GradeRow[], what: "done" | "doing" | "failed") => rows.reduce((n, r) => {
    const grade = rowGrade(r).grade;
    const is = r.binary ? (r.passed === undefined ? "doing" : r.passed ? "done" : "failed") : grade === undefined ? "doing" : grade >= pass ? "done" : "failed";
    return is === what ? n + r.credits : n;
  }, 0);
  const round = (n: number) => Math.round(n * 10) / 10;
  const of = (id: string, name: string, need: number, rows: GradeRow[]): KindProgress => {
    const done = round(sum(rows, "done"));
    const doing = round(sum(rows, "doing"));
    return { id, name, need, done, doing, missing: round(Math.max(0, need - done - doing)) };
  };
  const kinds = (g.kinds ?? []).map((k) => of(k.id, k.name, k.need, g.rows.filter((r) => r.kind === k.id)));
  const need = Math.max(g.total ?? 0, kinds.reduce((n, k) => n + k.need, 0));
  return { kinds, total: of("all", "", need, g.rows), failed: round(sum(g.rows, "failed")) };
}

/**
 * "Should I take Moed B?" (design MoedB, like the Israeli "מועד ב׳" app): the course grade and the weighted average
 * with her Moed A score and with a Moed B score she expects, under her institution's rule (the last exam counts, or
 * the higher). `part` is the exam part of the course (by default the heaviest).
 */
export function moedB(g: Grades, rowId: string, b: number, part?: number): { part: number; a?: number; course: { now?: number; withB?: number }; average: { now?: number; withB?: number } } | undefined {
  const row = g.rows.find((r) => r.id === rowId);
  if (!row || row.binary || !row.parts.length || row.final !== undefined) return undefined;
  const i = part ?? row.parts.reduce((best, p, k) => (p.weight > row.parts[best]!.weight ? k : best), 0);
  const a = row.parts[i]?.score;
  const score = g.moedRule === "best" && a !== undefined ? Math.max(a, b) : b;
  const withB = { ...row, parts: row.parts.map((p, k) => (k === i ? { ...p, score } : p)) };
  const rows = g.rows.map((r) => (r.id === rowId ? withB : r));
  return { part: i, ...(a !== undefined ? { a } : {}), course: { now: rowGrade(row).grade, withB: rowGrade(withB).grade }, average: { now: weightedAverage(g.rows).average, withB: weightedAverage(rows).average } };
}
