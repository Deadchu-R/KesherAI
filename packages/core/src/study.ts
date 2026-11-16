/**
 * Study (students): courses, their lectures (typed, pasted or transcribed), summaries and terms, flashcards on a
 * spaced-repetition schedule (FSRS), quizzes graded by code, and recall per study format ("what works for me").
 * One JSON file per course, on this computer.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createEmptyCard, fsrs, Rating, type Card, type Grade } from "ts-fsrs";
import { cardsToReview, detectField, examPlan, findPassages, TUTOR_PROMPT, jsonIn, mergeCourseData, STUDY_FIELDS, STUDY_FORMATS, weakLectures, type StudyCard, type StudyCourse, type StudyCourseData, type StudyDrug, type StudyFormat, type StudyLecture, type StudyQuestion, type StudyQuiz, type StudyReview, type StudyTerm } from "@kesher/shared";
import { documentText, type ModelTurn } from "@kesher/agent";

/** Everything kept for one course. */
export type CourseData = StudyCourseData;

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const arr = <T>(v: unknown, max: number): T[] => (Array.isArray(v) ? (v.slice(0, max) as T[]) : []);
const okId = (v: unknown) => typeof v === "string" && /^[\w-]{1,80}$/.test(v);

/**
 * A course sent by the phone, checked before it is merged: ids are short words, texts and lists have the same caps
 * as on the computer, and anything else is dropped.
 */
export function cleanCourseData(raw: unknown): CourseData | undefined {
  const d = raw as Partial<CourseData> | undefined;
  const c = d?.course;
  if (!c || typeof c.id !== "string" || !/^[a-z0-9-]{8,40}$/.test(c.id)) return undefined;
  const course: StudyCourse = { id: c.id, name: str(c.name, 120) || "Course", createdAt: Number(c.createdAt) || Date.now(), ...(STUDY_FIELDS.some((f) => f.id === c.field) ? { field: c.field } : {}), ...(c.fieldChosen ? { fieldChosen: true } : {}), ...(typeof c.examDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c.examDate) ? { examDate: c.examDate } : {}) };
  const lectures = arr<StudyLecture>(d.lectures, 2000).filter((l) => okId(l?.id)).map((l) => ({
    id: l.id, title: str(l.title, 200), date: /^\d{4}-\d{2}-\d{2}$/.test(l.date) ? l.date : new Date().toISOString().slice(0, 10), text: str(l.text, 400_000),
    ...(l.summary ? { summary: str(l.summary, 100_000) } : {}),
    ...(Array.isArray(l.terms) ? { terms: arr<StudyTerm>(l.terms, 300).map((t) => ({ term: str(t?.term, 200), ...(t?.en ? { en: str(t.en, 200) } : {}), explain: str(t?.explain, 2000) })) } : {}),
    ...(l.diagram ? { diagram: str(l.diagram, 20_000) } : {}),
  }));
  const cards = arr<StudyCard>(d.cards, 20_000).filter((k) => okId(k?.id)).map((k) => ({
    id: k.id, front: str(k.front, 4000), back: str(k.back, 8000), format: STUDY_FORMATS.includes(k.format) ? k.format : "text", ...(k.kind ? { kind: str(k.kind, 40) } : {}),
    ...(okId(k.lectureId) ? { lectureId: k.lectureId } : {}), createdAt: Number(k.createdAt) || Date.now(), due: str(k.due, 40), fsrs: k.fsrs && typeof k.fsrs === "object" ? JSON.parse(JSON.stringify(k.fsrs).slice(0, 2000)) as Record<string, unknown> : {},
  }));
  const reviews = arr<StudyReview>(d.reviews, 200_000).filter((r) => okId(r?.cardId) && Number.isFinite(r.t)).map((r) => ({ cardId: r.cardId, t: r.t, rating: Math.min(4, Math.max(1, Math.round(Number(r.rating) || 3))), format: STUDY_FORMATS.includes(r.format) ? r.format : "text", elapsedDays: Math.max(0, Number(r.elapsedDays) || 0), ...(r.kind ? { kind: str(r.kind, 40) } : {}) }));
  const quizzes = arr<StudyQuiz>(d.quizzes, 500).filter((q) => okId(q?.id) && Array.isArray(q.questions)).map((q) => JSON.parse(JSON.stringify(q).slice(0, 200_000)) as StudyQuiz);
  const drugs = arr<StudyDrug>(d.drugs, 1000).filter((g) => okId(g?.id)).map((g) => JSON.parse(JSON.stringify(g).slice(0, 20_000)) as StudyDrug);
  const removed = arr<string>(d.removed, 5000).filter(okId);
  return { course, lectures, cards, reviews, quizzes, ...(drugs.length ? { drugs } : {}), ...(removed.length ? { removed } : {}) };
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

const DRUGS_PROMPT = `You make nursing drug cards from lecture material. ${LANG} ${ONLY_MATERIAL}
For every drug the material discusses, fill what the material says (leave a field out when it says nothing about it; never guess doses).
Answer with JSON only: [{"name": "generic name", "brands": "", "drugClass": "", "action": "how it works", "uses": "", "dose": "", "sideEffects": "", "contraindications": "", "nursing": "what the nurse checks and does", "teaching": "what to tell the patient"}]`;

const LICENSING = "Write the questions like the Israeli nursing licensing exam (בחינת רישוי): multiple choice with four options, mostly short patient cases that ask what the nurse should do first or what is most important, with plausible distractors.";

/** What each field's material needs from the model. */
const FIELD_HINT: Record<string, string> = {
  nursing: "This is nursing: favour what the nurse assesses, does and teaches, and patient safety.",
  medicine: "This is medicine: favour mechanisms, diagnosis and treatment, as the material states them.",
  law: "This is law: give section numbers, statute and case names exactly as the material writes them, and the rule or holding of each.",
  engineering: "This is engineering: keep formulas with their units and the conditions they hold under; a worked example shows each step.",
  cs: "This is computer science: short code in ``` blocks, the complexity of algorithms, and when to use each data structure.",
  math: "This is mathematics or physics: state definitions and theorems exactly; worked problems show each step; keep formulas as plain text.",
  psychology: "This is psychology: name the theory and its researcher, and the study and finding behind it, as the material gives them.",
  economics: "This is economics or management: definitions, models and what moves each curve or figure, with the formulas as written.",
  biology: "This is biology or chemistry: processes in order, structures and their functions, reactions as written.",
  education: "This is education: theories, their thinkers and how each is used in class.",
  humanities: "This is the humanities or social sciences: thinkers, ideas, dates and arguments as the material gives them.",
};

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
  async list(): Promise<Array<StudyCourse & { lectures: number; cards: number; due: number; daysLeft?: number; perDay?: number }>> {
    await mkdir(this.dir, { recursive: true });
    const names = (await readdir(this.dir)).filter((n) => n.endsWith(".json"));
    const out = [];
    const now = Date.now();
    for (const n of names) {
      const d = await this.get(n.slice(0, -5)).catch(() => undefined);
      if (d) {
        const plan = examPlan(d, now);
        out.push({ ...d.course, lectures: d.lectures.length, cards: d.cards.length, due: d.cards.filter((c) => Date.parse(c.due) <= now).length, ...(plan ? { daysLeft: plan.daysLeft, perDay: plan.perDay } : {}) });
      }
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
    const n = name.trim().slice(0, 120) || "Course";
    const field = detectField(n, "");
    const course: StudyCourse = { id: randomUUID(), name: n, createdAt: Date.now(), ...(field ? { field } : {}) };
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

  /** Sets the course's exam date (YYYY-MM-DD), or clears it with "". */
  async setExam(id: string, date: string): Promise<StudyCourse> {
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Object.assign(new Error("The date is YYYY-MM-DD."), { statusCode: 400 });
    const d = await this.get(id);
    if (date) d.course.examDate = date;
    else delete d.course.examDate;
    await this.save(d);
    return d.course;
  }

  /** Sets a course's field (the student's choice; "" lets KesherAI guess again). */
  async setField(id: string, field: string): Promise<StudyCourse> {
    const d = await this.get(id);
    if (field && !STUDY_FIELDS.some((f) => f.id === field)) throw Object.assign(new Error("No such field."), { statusCode: 400 });
    if (field) {
      d.course.field = field;
      d.course.fieldChosen = true;
    } else {
      delete d.course.fieldChosen;
      const guess = detectField(d.course.name, d.lectures.map((x) => `${x.title} ${x.text.slice(0, 3000)}`).join(" "));
      if (guess) d.course.field = guess;
      else delete d.course.field;
    }
    await this.save(d);
    return d.course;
  }

  /** Removes a course and everything in it. */
  async removeCourse(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
    this.cache.delete(id);
    const gone = await this.removedCourses();
    if (!gone.includes(id)) await writeFile(join(this.dir, "_removed.json"), JSON.stringify([...gone, id].slice(-2000)));
  }

  /** Courses deleted on this computer (a sync from the phone does not bring them back). */
  private async removedCourses(): Promise<string[]> {
    return arr<string>(await readFile(join(this.dir, "_removed.json"), "utf8").then((t) => JSON.parse(t) as unknown, () => []), 2000);
  }

  /**
   * Two-way sync with the phone: each course it sends is merged with this computer's copy (both kept, minus what
   * either deleted), and every course here comes back to it.
   *
   * @param courses - The phone's courses (checked by cleanCourseData).
   * @param removedCourses - Courses deleted on the phone.
   * @returns All courses here after the merge, and the courses deleted on either side.
   */
  async sync(courses: unknown[], removedCourses: unknown[]): Promise<{ courses: CourseData[]; removedCourses: string[] }> {
    for (const id of arr<string>(removedCourses, 2000)) if (typeof id === "string" && /^[a-z0-9-]{8,40}$/.test(id)) await this.removeCourse(id);
    const gone = new Set(await this.removedCourses());
    for (const raw of arr<unknown>(courses, 500)) {
      const theirs = cleanCourseData(raw);
      if (!theirs || gone.has(theirs.course.id)) continue;
      const mine = await this.get(theirs.course.id).catch(() => undefined);
      await this.save(mine ? mergeCourseData(mine, theirs) : theirs);
    }
    const all = [];
    for (const c of await this.list()) all.push(await this.get(c.id));
    return { courses: all, removedCourses: [...gone] };
  }

  /** Adds a lecture's text (typed, pasted, or a transcript). */
  async addLecture(id: string, p: { title?: string; text: string; date?: string }): Promise<StudyLecture> {
    const d = await this.get(id);
    const text = String(p.text ?? "").slice(0, 400_000);
    if (!text.trim()) throw Object.assign(new Error("The lecture has no text."), { statusCode: 400 });
    const lecture: StudyLecture = { id: randomUUID(), title: (p.title ?? "").trim().slice(0, 200) || `${d.lectures.length + 1}`, date: /^\d{4}-\d{2}-\d{2}$/.test(p.date ?? "") ? p.date! : new Date().toISOString().slice(0, 10), text };
    d.lectures.push(lecture);
    if (!d.course.fieldChosen) {
      const guess = detectField(d.course.name, d.lectures.map((x) => `${x.title} ${x.text.slice(0, 3000)}`).join(" "));
      if (guess) d.course.field = guess;
    }
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
    d.removed = [...(d.removed ?? []), lectureId].slice(-5000);
    for (const c of d.cards) if (c.lectureId === lectureId) delete c.lectureId;
    await this.save(d);
  }

  private lecture(d: CourseData, lectureId: string): StudyLecture {
    const l = d.lectures.find((x) => x.id === lectureId);
    if (!l) throw Object.assign(new Error("No such lecture."), { statusCode: 404 });
    return l;
  }

  /**
   * The text of a file for a new lecture: slides (PowerPoint), a PDF, a Word file or a text file are read here; a
   * photo (the whiteboard, a notebook page, a slide on screen) is read by the chat model, which must see pictures.
   *
   * @param name - The file's name (its type comes from the extension).
   * @param data - Its bytes (at most 50 MB).
   * @returns The text, with page or slide marks, and a title from the file name.
   */
  async extract(name: string, data: Buffer, signal?: AbortSignal): Promise<{ title: string; text: string }> {
    const ext = (/\.[a-z0-9]+$/i.exec(name)?.[0] ?? "").toLowerCase();
    const title = name.replace(/\.[^.]+$/, "").slice(0, 200);
    const bad = (msg: string) => Object.assign(new Error(msg), { statusCode: 400 });
    if (data.length > 50 * 1024 * 1024) throw bad("The file is larger than 50 MB.");
    const pictures: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
    if (pictures[ext]) {
      const m = this.model();
      if (!m) throw Object.assign(new Error("Choose a chat model first (Models page)."), { statusCode: 409 });
      const r = await m.turn(
        {
          messages: [
            { role: "system", content: "You read photos of study material (a whiteboard, a notebook page, a slide, a book page). Write out every word exactly, in its own language, keeping the order, headings, lists and numbers. Describe each drawing, diagram, graph or table in words, inside [square brackets]. Add nothing that is not in the photo. If you cannot see a picture, answer only: NO-IMAGE." },
            { role: "user", content: `The photo: ${name}`, images: [{ mimeType: pictures[ext]!, data: data.toString("base64") }] },
          ],
          tools: [],
        },
        signal ?? AbortSignal.timeout(300_000),
        () => undefined,
      );
      const text = r.text.trim();
      if (!text || /^NO-IMAGE/.test(text)) throw bad("The chosen chat model cannot see pictures. Choose a model with vision (for example Gemma 3 or Qwen-VL), or send the slides as a PDF.");
      return { title, text: text.slice(0, 400_000) };
    }
    if (![".pdf", ".pptx", ".docx", ".txt", ".md", ".srt", ".vtt"].includes(ext)) throw bad("This kind of file cannot be read: send a PDF, PowerPoint, Word, text file or a photo.");
    const doc = await documentText(data, name);
    // Each page or slide keeps its number (a lecture's "slide 12" can be found again).
    const text = doc.pages.map((p, i) => [i + 1, p.trim()] as const).filter(([, p]) => p).map(([n, p]) => (doc.pages.length > 1 ? `— ${n} —\n${p}` : p)).join("\n\n");
    if (!text.trim()) throw bad(ext === ".pdf" ? "This PDF has no text in it (a scan). Send photos of its pages instead." : "The file has no text.");
    return { title, text: text.slice(0, 400_000) };
  }

  /**
   * The course's tutor: answers a question from her own lectures only, naming the lecture of each fact.
   *
   * @param id - The course.
   * @param question - Her question.
   * @param history - The conversation so far (last few turns are kept).
   * @returns The answer and the lectures it drew on.
   */
  async askCourse(id: string, question: string, history: Array<{ role: "user" | "assistant"; content: string }> = [], signal?: AbortSignal): Promise<{ answer: string; sources: Array<{ lectureId: string; title: string }> }> {
    const q = question.trim().slice(0, 2000);
    if (!q) throw Object.assign(new Error("Ask a question."), { statusCode: 400 });
    const d = await this.get(id);
    // The previous question helps find the passages for a follow-up ("and its side effects?").
    const lastQ = [...history].reverse().find((h) => h.role === "user")?.content ?? "";
    const passages = findPassages(d.lectures, `${q} ${lastQ}`.slice(0, 3000));
    const m = this.model();
    if (!m) throw Object.assign(new Error("Choose a chat model first (Models page)."), { statusCode: 409 });
    const system = `${TUTOR_PROMPT}${d.course.field && FIELD_HINT[d.course.field] ? `\n${FIELD_HINT[d.course.field]}` : ""}`;
    const material = passages.length ? passages.map((p) => `[Lecture: ${p.title}]\n${p.text}`).join("\n\n---\n\n") : "(No passage of her lectures matches this question.)";
    const turns = history.slice(-6).filter((h) => (h.role === "user" || h.role === "assistant") && typeof h.content === "string").map((h) => ({ role: h.role, content: h.content.slice(0, 4000) }));
    const r = await m.turn({ messages: [{ role: "system", content: system }, ...turns, { role: "user", content: `Passages from her lectures:\n\n${material}\n\nHer question: ${q}` }], tools: [] }, signal ?? AbortSignal.timeout(300_000), () => undefined);
    const seen = new Set<string>();
    const sources = passages.filter((p) => !seen.has(p.lectureId) && seen.add(p.lectureId)).map((p) => ({ lectureId: p.lectureId, title: p.title }));
    return { answer: r.text.trim(), sources };
  }

  private async ask(system: string, user: string, signal?: AbortSignal, field?: string): Promise<string> {
    const m = this.model();
    if (field && FIELD_HINT[field]) system = `${system}\n${FIELD_HINT[field]}`;
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
    const raw = await this.ask(SUMMARY_PROMPT, `Lecture: ${l.title}\n\n${material.slice(0, 60_000)}`, signal, d.course.field);
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
    const raw = await this.ask(`${CARDS_PROMPT}\n${FORMAT_HINT[format]}`, `Write ${count} cards.\n\nLecture: ${l.title}\n\n${material}`, signal, d.course.field);
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
    d.removed = [...(d.removed ?? []), cardId].slice(-5000);
    await this.save(d);
  }

  /** @returns Cards due now, earliest first (at most `limit`). */
  async due(id: string, limit = 50): Promise<StudyCard[]> {
    return cardsToReview(await this.get(id), Date.now(), limit);
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
  async makeQuiz(id: string, p: { lectureIds?: string[]; count?: number; weak?: boolean; style?: "licensing" }, signal?: AbortSignal): Promise<StudyQuiz> {
    const d = await this.get(id);
    let chosen = d.lectures.filter((l) => !p.lectureIds?.length || p.lectureIds.includes(l.id));
    if (p.weak) {
      const weak = new Set(weakLectures(d.quizzes).filter((w) => w.correct < 0.8).slice(0, 4).map((w) => w.lectureId));
      if (weak.size) chosen = chosen.filter((l) => weak.has(l.id));
    }
    if (!chosen.length) throw Object.assign(new Error("Add a lecture first."), { statusCode: 400 });
    const count = Math.max(3, Math.min(p.style === "licensing" ? 60 : 30, Number(p.count) || 10));
    const budget = Math.floor(48_000 / chosen.length);
    const material = chosen.map((l, i) => `### Lecture ${i + 1}: ${l.title}\n${(l.text.length > budget && l.summary ? l.summary : l.text).slice(0, budget)}`).join("\n\n");
    const raw = await this.ask(p.style === "licensing" ? `${QUIZ_PROMPT}\n${LICENSING}` : QUIZ_PROMPT, `Write ${count} questions.\n\n${material}`, signal, d.course.field);
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

  /**
   * Makes drug cards from a lecture, and three flashcards for each new drug (class and action, nursing, side effects).
   *
   * @returns The course's drugs after the change.
   */
  async makeDrugs(id: string, lectureId: string, signal?: AbortSignal): Promise<StudyDrug[]> {
    const d = await this.get(id);
    const l = this.lecture(d, lectureId);
    const raw = await this.ask(DRUGS_PROMPT, `Lecture: ${l.title}\n\n${l.text.slice(0, 48_000)}`, signal);
    const list = jsonIn(raw);
    if (!Array.isArray(list)) throw Object.assign(new Error("The model did not return drug cards. Try again, or another model."), { statusCode: 502 });
    const keys = ["brands", "drugClass", "action", "uses", "dose", "sideEffects", "contraindications", "nursing", "teaching"] as const;
    d.drugs ??= [];
    const now = new Date();
    for (const x of list as Array<Record<string, unknown>>) {
      const name = String(x?.name ?? "").trim().slice(0, 120);
      if (!name) continue;
      const drug: StudyDrug = { id: randomUUID(), name, lectureId };
      for (const k of keys) if (typeof x[k] === "string" && (x[k] as string).trim()) drug[k] = (x[k] as string).trim().slice(0, 1500);
      const old = d.drugs.findIndex((g) => g.name.toLowerCase() === name.toLowerCase());
      if (old >= 0) {
        d.drugs[old] = { ...d.drugs[old], ...drug, id: d.drugs[old]!.id };
        continue;
      }
      d.drugs.push(drug);
      const card = (front: string, back: string | undefined) => {
        if (!back) return;
        const c = createEmptyCard(now);
        d.cards.push({ id: randomUUID(), front, back, format: "text", kind: "drug", lectureId, createdAt: now.getTime(), due: c.due.toISOString(), fsrs: fromCard(c) });
      };
      card(`${name}: לאיזו קבוצה שייכת ואיך פועלת?`, [drug.drugClass, drug.action].filter(Boolean).join(" — ") || undefined);
      card(`${name}: מה האחות בודקת ועושה?`, drug.nursing);
      card(`${name}: תופעות לוואי?`, drug.sideEffects);
    }
    await this.save(d);
    return d.drugs;
  }

  /** Removes a drug card (its flashcards stay). */
  async removeDrug(id: string, drugId: string): Promise<void> {
    const d = await this.get(id);
    d.drugs = (d.drugs ?? []).filter((g) => g.id !== drugId);
    d.removed = [...(d.removed ?? []), drugId].slice(-5000);
    await this.save(d);
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
