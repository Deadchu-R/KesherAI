/**
 * Study (students): courses, their lectures (typed, pasted or transcribed), summaries and terms, flashcards on a
 * spaced-repetition schedule (FSRS), quizzes graded by code, and recall per study format ("what works for me").
 * One JSON file per course, on this computer.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createEmptyCard, fsrs, Rating, type Card, type Grade } from "ts-fsrs";
import { jsonIn, STUDY_FORMATS, weakLectures, type StudyCard, type StudyCourse, type StudyFormat, type StudyLecture, type StudyQuestion, type StudyQuiz, type StudyReview, type StudyTerm } from "@kesher/shared";
import type { ModelTurn } from "@kesher/agent";

/** Everything kept for one course. */
export interface CourseData {
  course: StudyCourse;
  lectures: StudyLecture[];
  cards: StudyCard[];
  reviews: StudyReview[];
  quizzes: StudyQuiz[];
}

type Model = { turn: ModelTurn; id: string } | undefined;

const LANG = "Write in the same language as the material (usually Hebrew). Keep English medical and scientific terms in English, as written in the material.";
const ONLY_MATERIAL = "Use only what the material says; do not add facts that are not in it.";

const SUMMARY_PROMPT = `You summarise a university lecture for a student. ${LANG} ${ONLY_MATERIAL}
Answer with JSON only: {"summary": "a clear summary in short paragraphs and bullet lines (markdown), main ideas first", "terms": [{"term": "the term", "en": "English name if any", "explain": "one sentence"}], "diagram": "a Mermaid flowchart of the main process or mechanism, or an empty string when there is none"}`;

const CARDS_PROMPT = `You write flashcards for a student from lecture material. ${LANG} ${ONLY_MATERIAL}
Each card tests one fact or idea; the front is a question, the back a short answer. Prefer questions that make the student recall, not recognise.
Give each card a kind: anatomy, drug, process, calculation, concept or other.
Answer with JSON only: [{"front": "...", "back": "...", "kind": "..."}]`;

const QUIZ_PROMPT = `You write a multiple-choice quiz for a student from lecture material. ${LANG} ${ONLY_MATERIAL}
Each question has 4 options, exactly one right; wrong options are plausible. Mix recall, understanding and short clinical cases where the material allows.
The explanation says why the right answer is right, from the material.
Answer with JSON only: [{"q": "...", "options": ["...", "...", "...", "..."], "answer": 0, "explain": "...", "lecture": 1}] where "lecture" is the number of the lecture the question comes from.`;

const FORMAT_HINT: Record<StudyFormat, string> = {
  text: "",
  diagram: "Where it helps, the back includes a small Mermaid diagram in a ```mermaid block.",
  audio: "Write the back as a short spoken explanation (two or three sentences) that reads well aloud.",
  example: "The back gives a short worked example or a patient case that shows the idea.",
  explain: "The front asks the student to explain the idea in her own words; the back lists the points a good explanation covers.",
};

/** Long material is cut into pieces a small model can read. */
export function pieces(text: string, size = 12_000): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size / 2) cut = rest.lastIndexOf(". ", size);
    if (cut < size / 2) cut = size;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

const isGrade = (n: number): n is Grade => n === Rating.Again || n === Rating.Hard || n === Rating.Good || n === Rating.Easy;
const toCard = (c: StudyCard): Card => {
  const f = c.fsrs as Record<string, unknown>;
  return { ...(f as unknown as Card), due: new Date(String(f.due)), ...(f.last_review ? { last_review: new Date(String(f.last_review)) } : {}) };
};
const fromCard = (c: Card): Record<string, unknown> => JSON.parse(JSON.stringify(c)) as Record<string, unknown>;

/** The study store. */
export class Study {
  private readonly scheduler = fsrs();
  private readonly cache = new Map<string, CourseData>();
  private writing = Promise.resolve();

  /**
   * @param dir - Where the courses are kept.
   * @param model - The chat model to use (the active one when no id is given).
   */
  constructor(
    private readonly dir: string,
    private readonly model: (modelId?: string) => Model,
  ) {}

  private file(id: string) {
    if (!/^[a-z0-9-]{8,40}$/.test(id)) throw Object.assign(new Error("No such course."), { statusCode: 404 });
    return join(this.dir, `${id}.json`);
  }

  /** @returns Every course with its counts, newest first. */
  async list(): Promise<Array<StudyCourse & { lectures: number; cards: number; due: number }>> {
    await mkdir(this.dir, { recursive: true });
    const names = (await readdir(this.dir)).filter((n) => n.endsWith(".json"));
    const out = [];
    const now = Date.now();
    for (const n of names) {
      const d = await this.get(n.slice(0, -5)).catch(() => undefined);
      if (d) out.push({ ...d.course, lectures: d.lectures.length, cards: d.cards.length, due: d.cards.filter((c) => Date.parse(c.due) <= now).length });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** @returns One course's data (throws 404 when there is none). */
  async get(id: string): Promise<CourseData> {
    const hit = this.cache.get(id);
    if (hit) return hit;
    let d: CourseData;
    try {
      d = JSON.parse(await readFile(this.file(id), "utf8")) as CourseData;
    } catch {
      throw Object.assign(new Error("No such course."), { statusCode: 404 });
    }
    d.lectures ??= [];
    d.cards ??= [];
    d.reviews ??= [];
    d.quizzes ??= [];
    this.cache.set(id, d);
    return d;
  }

  private async save(d: CourseData): Promise<void> {
    this.cache.set(d.course.id, d);
    const run = this.writing.then(async () => {
      await mkdir(this.dir, { recursive: true });
      const f = this.file(d.course.id);
      await writeFile(`${f}.tmp`, JSON.stringify(d));
      await rename(`${f}.tmp`, f);
    });
    this.writing = run.catch(() => undefined);
    await run;
  }

  /** Adds a course. */
  async addCourse(name: string): Promise<StudyCourse> {
    const course = { id: randomUUID(), name: name.trim().slice(0, 120) || "Course", createdAt: Date.now() };
    await this.save({ course, lectures: [], cards: [], reviews: [], quizzes: [] });
    return course;
  }

  /** Renames a course. */
  async renameCourse(id: string, name: string): Promise<StudyCourse> {
    const d = await this.get(id);
    d.course.name = name.trim().slice(0, 120) || d.course.name;
    await this.save(d);
    return d.course;
  }

  /** Removes a course and everything in it. */
  async removeCourse(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
    this.cache.delete(id);
  }

  /** Adds a lecture's text (typed, pasted, or a transcript). */
  async addLecture(id: string, p: { title?: string; text: string; date?: string }): Promise<StudyLecture> {
    const d = await this.get(id);
    const text = String(p.text ?? "").slice(0, 400_000);
    if (!text.trim()) throw Object.assign(new Error("The lecture has no text."), { statusCode: 400 });
    const lecture: StudyLecture = { id: randomUUID(), title: (p.title ?? "").trim().slice(0, 200) || `${d.lectures.length + 1}`, date: /^\d{4}-\d{2}-\d{2}$/.test(p.date ?? "") ? p.date! : new Date().toISOString().slice(0, 10), text };
    d.lectures.push(lecture);
    await this.save(d);
    return lecture;
  }

  /** Changes a lecture's title, date or text. */
  async updateLecture(id: string, lectureId: string, p: Partial<Pick<StudyLecture, "title" | "date" | "text" | "summary">>): Promise<StudyLecture> {
    const d = await this.get(id);
    const l = this.lecture(d, lectureId);
    if (typeof p.title === "string") l.title = p.title.trim().slice(0, 200) || l.title;
    if (typeof p.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.date)) l.date = p.date;
    if (typeof p.text === "string" && p.text.trim()) l.text = p.text.slice(0, 400_000);
    if (typeof p.summary === "string") l.summary = p.summary.slice(0, 100_000);
    await this.save(d);
    return l;
  }

  /** Removes a lecture (its cards stay, without the link). */
  async removeLecture(id: string, lectureId: string): Promise<void> {
    const d = await this.get(id);
    d.lectures = d.lectures.filter((l) => l.id !== lectureId);
    for (const c of d.cards) if (c.lectureId === lectureId) delete c.lectureId;
    await this.save(d);
  }

  private lecture(d: CourseData, lectureId: string): StudyLecture {
    const l = d.lectures.find((x) => x.id === lectureId);
    if (!l) throw Object.assign(new Error("No such lecture."), { statusCode: 404 });
    return l;
  }

  private async ask(system: string, user: string, signal?: AbortSignal): Promise<string> {
    const m = this.model();
    if (!m) throw Object.assign(new Error("Choose a chat model first (Models page)."), { statusCode: 409 });
    const r = await m.turn({ messages: [{ role: "system", content: system }, { role: "user", content: user }], tools: [] }, signal ?? AbortSignal.timeout(600_000), () => undefined);
    return r.text;
  }

  /** Writes a lecture's summary, terms and diagram (long lectures: piece by piece, then together). */
  async summarize(id: string, lectureId: string, signal?: AbortSignal): Promise<StudyLecture> {
    const d = await this.get(id);
    const l = this.lecture(d, lectureId);
    const parts = pieces(l.text);
    let material = l.text;
    if (parts.length > 1) {
      const notes: string[] = [];
      for (const [i, p] of parts.entries()) notes.push(await this.ask(`Write detailed notes of this part of a lecture: every idea, term, number and example. ${LANG} ${ONLY_MATERIAL}`, `Part ${i + 1} of ${parts.length}:\n\n${p}`, signal));
      material = notes.join("\n\n");
    }
    const raw = await this.ask(SUMMARY_PROMPT, `Lecture: ${l.title}\n\n${material.slice(0, 60_000)}`, signal);
    const j = jsonIn(raw) as { summary?: string; terms?: StudyTerm[]; diagram?: string } | undefined;
    l.summary = (j?.summary ?? raw).slice(0, 100_000);
    l.terms = Array.isArray(j?.terms) ? j!.terms.filter((t) => t && t.term && t.explain).slice(0, 80).map((t) => ({ term: String(t.term).slice(0, 120), ...(t.en ? { en: String(t.en).slice(0, 120) } : {}), explain: String(t.explain).slice(0, 400) })) : [];
    const diagram = String(j?.diagram ?? "").replace(/^```(?:mermaid)?\s*|```$/g, "").trim();
    if (diagram) l.diagram = diagram.slice(0, 8000);
    else delete l.diagram;
    await this.save(d);
    return l;
  }

  /** Makes flashcards from a lecture, studied in one format. */
  async makeCards(id: string, lectureId: string, p: { format?: StudyFormat; count?: number }, signal?: AbortSignal): Promise<StudyCard[]> {
    const d = await this.get(id);
    const l = this.lecture(d, lectureId);
    const format: StudyFormat = STUDY_FORMATS.includes(p.format as StudyFormat) ? p.format! : "text";
    const count = Math.max(3, Math.min(40, Number(p.count) || 12));
    const material = (l.summary && l.text.length > 24_000 ? `${l.summary}\n\nTerms: ${(l.terms ?? []).map((t) => `${t.term}${t.en ? ` (${t.en})` : ""}: ${t.explain}`).join("; ")}` : l.text).slice(0, 40_000);
    const raw = await this.ask(`${CARDS_PROMPT}\n${FORMAT_HINT[format]}`, `Write ${count} cards.\n\nLecture: ${l.title}\n\n${material}`, signal);
    const list = jsonIn(raw);
    if (!Array.isArray(list)) throw Object.assign(new Error("The model did not return cards. Try again, or another model."), { statusCode: 502 });
    const now = new Date();
    const made: StudyCard[] = [];
    for (const x of list as Array<{ front?: string; back?: string; kind?: string }>) {
      if (!x?.front || !x.back) continue;
      const c = createEmptyCard(now);
      made.push({ id: randomUUID(), front: String(x.front).slice(0, 2000), back: String(x.back).slice(0, 6000), format, ...(x.kind ? { kind: String(x.kind).slice(0, 30) } : {}), lectureId, createdAt: now.getTime(), due: c.due.toISOString(), fsrs: fromCard(c) });
      if (made.length >= count) break;
    }
    d.cards.push(...made);
    await this.save(d);
    return made;
  }

  /** Adds a card by hand. */
  async addCard(id: string, p: { front: string; back: string; format?: StudyFormat; kind?: string; lectureId?: string }): Promise<StudyCard> {
    const d = await this.get(id);
    if (!p.front?.trim() || !p.back?.trim()) throw Object.assign(new Error("A card needs a front and a back."), { statusCode: 400 });
    const c = createEmptyCard(new Date());
    const card: StudyCard = { id: randomUUID(), front: p.front.slice(0, 2000), back: p.back.slice(0, 6000), format: STUDY_FORMATS.includes(p.format as StudyFormat) ? p.format! : "text", ...(p.kind ? { kind: p.kind.slice(0, 30) } : {}), ...(p.lectureId ? { lectureId: p.lectureId } : {}), createdAt: Date.now(), due: c.due.toISOString(), fsrs: fromCard(c) };
    d.cards.push(card);
    await this.save(d);
    return card;
  }

  /** Removes a card. */
  async removeCard(id: string, cardId: string): Promise<void> {
    const d = await this.get(id);
    d.cards = d.cards.filter((c) => c.id !== cardId);
    await this.save(d);
  }

  /** @returns Cards due now, earliest first (at most `limit`). */
  async due(id: string, limit = 50): Promise<StudyCard[]> {
    const d = await this.get(id);
    const now = Date.now();
    return d.cards.filter((c) => Date.parse(c.due) <= now).sort((a, b) => Date.parse(a.due) - Date.parse(b.due)).slice(0, limit);
  }

  /** Records a review (1 again … 4 easy) and schedules the card's next one. */
  async review(id: string, cardId: string, rating: number): Promise<StudyCard> {
    if (!isGrade(rating)) throw Object.assign(new Error("Rating is 1 to 4."), { statusCode: 400 });
    const d = await this.get(id);
    const card = d.cards.find((c) => c.id === cardId);
    if (!card) throw Object.assign(new Error("No such card."), { statusCode: 404 });
    const now = new Date();
    const before = toCard(card);
    const elapsedDays = before.last_review ? Math.floor((now.getTime() - before.last_review.getTime()) / 86_400_000) : 0;
    const next = this.scheduler.next(before, now, rating).card;
    card.fsrs = fromCard(next);
    card.due = next.due.toISOString();
    d.reviews.push({ cardId, t: now.getTime(), rating, format: card.format, ...(card.kind ? { kind: card.kind } : {}), elapsedDays });
    if (d.reviews.length > 50_000) d.reviews.splice(0, d.reviews.length - 50_000);
    await this.save(d);
    return card;
  }

  /** Makes a multiple-choice quiz from chosen lectures (or the weak ones, or all). */
  async makeQuiz(id: string, p: { lectureIds?: string[]; count?: number; weak?: boolean }, signal?: AbortSignal): Promise<StudyQuiz> {
    const d = await this.get(id);
    let chosen = d.lectures.filter((l) => !p.lectureIds?.length || p.lectureIds.includes(l.id));
    if (p.weak) {
      const weak = new Set(weakLectures(d.quizzes).filter((w) => w.correct < 0.8).slice(0, 4).map((w) => w.lectureId));
      if (weak.size) chosen = chosen.filter((l) => weak.has(l.id));
    }
    if (!chosen.length) throw Object.assign(new Error("Add a lecture first."), { statusCode: 400 });
    const count = Math.max(3, Math.min(30, Number(p.count) || 10));
    const budget = Math.floor(48_000 / chosen.length);
    const material = chosen.map((l, i) => `### Lecture ${i + 1}: ${l.title}\n${(l.text.length > budget && l.summary ? l.summary : l.text).slice(0, budget)}`).join("\n\n");
    const raw = await this.ask(QUIZ_PROMPT, `Write ${count} questions.\n\n${material}`, signal);
    const list = jsonIn(raw);
    if (!Array.isArray(list)) throw Object.assign(new Error("The model did not return a quiz. Try again, or another model."), { statusCode: 502 });
    const questions: StudyQuestion[] = [];
    for (const x of list as Array<{ q?: string; options?: unknown[]; answer?: number; explain?: string; lecture?: number }>) {
      const options = Array.isArray(x?.options) ? x.options.map((o) => String(o).slice(0, 600)).filter(Boolean) : [];
      const answer = Number(x?.answer);
      if (!x?.q || options.length < 2 || !(answer >= 0 && answer < options.length)) continue;
      const lec = chosen[Number(x.lecture) - 1] ?? (chosen.length === 1 ? chosen[0] : undefined);
      questions.push({ q: String(x.q).slice(0, 2000), options, answer, explain: String(x.explain ?? "").slice(0, 2000), ...(lec ? { lectureId: lec.id } : {}) });
      if (questions.length >= count) break;
    }
    if (!questions.length) throw Object.assign(new Error("The model did not return usable questions. Try again, or another model."), { statusCode: 502 });
    const quiz: StudyQuiz = { id: randomUUID(), t: Date.now(), questions };
    d.quizzes.push(quiz);
    if (d.quizzes.length > 200) d.quizzes.splice(0, d.quizzes.length - 200);
    await this.save(d);
    return quiz;
  }

  /** Grades a quiz by code and keeps the answers (for the weak topics). */
  async answerQuiz(id: string, quizId: string, answers: number[]): Promise<StudyQuiz> {
    const d = await this.get(id);
    const z = d.quizzes.find((q) => q.id === quizId);
    if (!z) throw Object.assign(new Error("No such quiz."), { statusCode: 404 });
    z.answers = z.questions.map((_, i) => (Number.isInteger(answers?.[i]) ? answers[i]! : -1));
    z.score = z.questions.filter((q, i) => z.answers![i] === q.answer).length;
    await this.save(d);
    return z;
  }
}
