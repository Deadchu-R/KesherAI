/**
 * Study (students): courses, their lectures (typed, pasted or transcribed), summaries and terms, flashcards on a
 * spaced-repetition schedule (FSRS), quizzes graded by code, and recall per study format ("what works for me").
 * One JSON file per course, on this computer.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createEmptyCard, fsrs, Rating, type Card, type Grade } from "ts-fsrs";
import { downloadPicture } from "./look-pictures.js";
import { AUDIO_PROMPT, VIDEO_PROMPT, parseVideoSlides, TEACH_BACK_PROMPT, parseTeachBack, type TeachBackResult, cardsToReview, detectField, examPlan, findPassages, openSharedCourse, shareCourse, MISSED_PROMPT, tutorMessages, gradeMessages, gradeLine, cleanScript, explainMessages, TRANSLATE_PROMPT, type TutorMessage, type StudyPassage, type SharedCourse, jsonIn, mergeCourseData, STUDY_FIELDS, STUDY_FORMATS, weakLectures, type StudyCard, type StudyCourse, type StudyCourseData, type StudyFocus, type StudyPastExam, pastExamStyle, parseSyllabus, SYLLABUS_PROMPT, checkCalcQuestion, studyNext, type StudyNext, cardsFromTsv, dayKey, COURSE_SUMMARY_PROMPT, STUDY_FIELD_HINTS, RECORDING_DEFAULTS, recordingExpired, semesterEnd, type StudyRecordingSettings, pictureQueries, relevantPictures, commonsSearchUrl, parseCommonsPictures, type StudyPicture, type StudyMediaKind, STUDY_TOOLS, toolMaterial, LEVEL_RULE, OPEN_QUIZ_PROMPT, openGradeMessages, openMark, parseOpenQuestions, type StudyLevel, searchStudy, type StudyHit, courseSummaryInput, parseCourseSummary, type StudyCourseSummary, type StudySyllabus, studyStreak, studyDays, focusWeek, type StudyDrug, type StudyFormat, type StudyLecture, type StudyQuestion, type StudyQuiz, type StudyReview, type StudyTerm } from "@kesher/shared";
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
    ...(l.audio ? { audio: str(l.audio, 20_000) } : {}),
    ...(Array.isArray(l.video) ? { video: parseVideoSlides({ slides: l.video }) } : {}),
    ...(typeof l.youtube === "string" && /^[\w-]{11}$/.test(l.youtube) ? { youtube: l.youtube } : {}),
    ...(l.notes ? { notes: str(l.notes, 50_000), notesT: Number(l.notesT) || Date.now() } : {}),
  }));
  const cards = arr<StudyCard>(d.cards, 20_000).filter((k) => okId(k?.id)).map((k) => ({
    id: k.id, front: str(k.front, 4000), back: str(k.back, 8000), format: STUDY_FORMATS.includes(k.format) ? k.format : "text", ...(k.kind ? { kind: str(k.kind, 40) } : {}),
    ...(okId(k.lectureId) ? { lectureId: k.lectureId } : {}), createdAt: Number(k.createdAt) || Date.now(), due: str(k.due, 40), fsrs: k.fsrs && typeof k.fsrs === "object" ? JSON.parse(JSON.stringify(k.fsrs).slice(0, 2000)) as Record<string, unknown> : {},
  }));
  const reviews = arr<StudyReview>(d.reviews, 200_000).filter((r) => okId(r?.cardId) && Number.isFinite(r.t)).map((r) => ({ cardId: r.cardId, t: r.t, rating: Math.min(4, Math.max(1, Math.round(Number(r.rating) || 3))), format: STUDY_FORMATS.includes(r.format) ? r.format : "text", elapsedDays: Math.max(0, Number(r.elapsedDays) || 0), ...(r.kind ? { kind: str(r.kind, 40) } : {}) }));
  const quizzes = arr<StudyQuiz>(d.quizzes, 500).filter((q) => okId(q?.id) && Array.isArray(q.questions)).map((q) => JSON.parse(JSON.stringify(q).slice(0, 200_000)) as StudyQuiz);
  const drugs = arr<StudyDrug>(d.drugs, 1000).filter((g) => okId(g?.id)).map((g) => JSON.parse(JSON.stringify(g).slice(0, 20_000)) as StudyDrug);
  const removed = arr<string>(d.removed, 5000).filter(okId);
  const focus = arr<StudyFocus>(d.focus, 5000).filter((f) => Number.isFinite(f?.t) && Number.isFinite(f?.minutes)).map((f) => ({ t: Number(f.t), minutes: Math.min(600, Math.max(1, Math.round(Number(f.minutes)))) }));
  const syllabus = d.syllabus ? parseSyllabus(d.syllabus, Number((d.syllabus as { t?: number }).t) || Date.now()) : undefined;
  const pastExams = arr<StudyPastExam>(d.pastExams, 50).filter((e) => okId(e?.id)).map((e) => ({ id: e.id, title: str(e.title, 200), text: str(e.text, 200_000), t: Number(e.t) || Date.now() }));
  const cs = d.courseSummary as StudyCourseSummary | undefined;
  const courseSummary = cs && typeof cs.text === "string" ? { text: str(cs.text, 120_000), lectureIds: arr<string>(cs.lectureIds, 5000).filter(okId), t: Number(cs.t) || Date.now() } : undefined;
  return { course, lectures, cards, reviews, quizzes, ...(drugs.length ? { drugs } : {}), ...(removed.length ? { removed } : {}), ...(focus.length ? { focus } : {}), ...(pastExams.length ? { pastExams } : {}), ...(syllabus ? { syllabus } : {}), ...(courseSummary ? { courseSummary } : {}) };
}

type Model = { turn: ModelTurn; id: string } | undefined;

const LANG = "Write in the same language as the material (usually Hebrew). Keep English medical and scientific terms in English, as written in the material.";
const ONLY_MATERIAL = "Use only what the material says; do not add facts that are not in it.";

const SUMMARY_PROMPT = `You summarise a university lecture for a student. ${LANG} ${ONLY_MATERIAL}
Answer with JSON only: {"summary": "a clear summary in short paragraphs and bullet lines (markdown), main ideas first", "terms": [{"term": "the term", "en": "English name if any", "explain": "one sentence"}], "diagram": "a Mermaid flowchart of the main process or mechanism, or an empty string when there is none", "picture": "2-4 English words to find a diagram of the lecture's topic on Wikimedia Commons, e.g. heart anatomy"}`;

const CARDS_PROMPT = `You write flashcards for a student from lecture material. ${LANG} ${ONLY_MATERIAL}
Each card tests one fact or idea; the front is a question, the back a short answer. Prefer questions that make the student recall, not recognise.
Give each card a kind: anatomy, drug, process, calculation, concept or other.
Answer with JSON only: [{"front": "...", "back": "...", "kind": "..."}]`;

const QUIZ_PROMPT = `You write a multiple-choice quiz for a student from lecture material. ${LANG} ${ONLY_MATERIAL}
Each question has 4 options, exactly one right; wrong options are plausible. Mix recall, understanding and short clinical cases where the material allows.
For a calculation, solve it first; the right option must equal your result exactly, and the other options are plausible mistakes. The explanation says why the right answer is right, from the material, in at most three sentences. Write everything in the material's language.
Answer with JSON only: [{"q": "...", "options": ["...", "...", "...", "..."], "answer": 0, "explain": "...", "lecture": 1}] where "lecture" is the number of the lecture the question comes from.`;

const DRUGS_PROMPT = `You make nursing drug cards from lecture material. ${LANG} ${ONLY_MATERIAL}
For every drug the material discusses, fill what the material says (leave a field out when it says nothing about it; never guess doses).
Answer with JSON only: [{"name": "generic name", "brands": "", "drugClass": "", "action": "how it works", "uses": "", "dose": "", "sideEffects": "", "contraindications": "", "nursing": "what the nurse checks and does", "teaching": "what to tell the patient"}]`;

const LICENSING = "Write the questions like the Israeli nursing licensing exam (בחינת רישוי): multiple choice with four options, mostly short patient cases that ask what the nurse should do first or what is most important, with plausible distractors.";

/** What each field's material needs from the model. */
const FIELD_HINT: Record<string, string> = STUDY_FIELD_HINTS;

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

/** Whether a lecture is mostly in Hebrew (its overviews are then asked for in Hebrew outright). */
function hebrewLecture(text: string): boolean {
  const sample = text.slice(0, 4000);
  return (sample.match(/[\u0590-\u05ff]/g) ?? []).length > (sample.match(/[A-Za-z]/g) ?? []).length;
}

/** Whether a text meant to be Hebrew came out mostly in Latin letters. */
function latinMostly(text: string): boolean {
  return (text.match(/[A-Za-z]/g) ?? []).length > (text.match(/[\u0590-\u05ff]/g) ?? []).length * 1.5;
}

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

  /** Called when the computer finished summarizing a lecture by itself (the phone gets "the lecture is ready"). */
  onLectureReady?: (course: StudyCourse, lecture: StudyLecture) => void;
  /** The course models' state (set by the server): a course waiting for its model, and the models to choose from. */
  modelState?: () => Promise<{ waiting?: { want: string; now?: string; why: string; since: number }; switched: boolean; hebrew?: string; models: string[] }>;
  /** "Switch now": load the waiting course's model at once (set by the server). */
  switchNow?: () => void;
  private later: Promise<void> = Promise.resolve();

  /** Summarizes a lecture in the background, one at a time, when a chat model is chosen; then tells the phone. */
  private summarizeLater(id: string, lectureId: string): void {
    this.later = this.later.then(async () => {
      if (!this.model()) return;
      const d = await this.get(id).catch(() => undefined);
      const l = d?.lectures.find((x) => x.id === lectureId);
      if (!d || !l || l.summary) return;
      const done = await this.summarize(id, lectureId);
      this.onLectureReady?.(d.course, done);
    }).catch(() => undefined);
  }

  /** Waits for the background summaries (tests). */
  async idle(): Promise<void> {
    await this.later;
  }

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

  /** "What to study now": the one most urgent step across her courses. */
  async next(now = Date.now()): Promise<StudyNext | null> {
    await mkdir(this.dir, { recursive: true });
    const all: CourseData[] = [];
    for (const n of (await readdir(this.dir)).filter((x) => x.endsWith(".json"))) {
      const d = await this.get(n.slice(0, -5)).catch(() => undefined);
      if (d) all.push(d);
    }
    return studyNext(all, now) ?? null;
  }

  /** Her study streak and this week's focus minutes, across all her courses. */
  async progress(now = Date.now()): Promise<{ streak: { days: number; today: boolean; shield: boolean }; week: Array<{ day: string; minutes: number }> }> {
    await mkdir(this.dir, { recursive: true });
    const all: CourseData[] = [];
    for (const n of (await readdir(this.dir)).filter((x) => x.endsWith(".json"))) {
      const d = await this.get(n.slice(0, -5)).catch(() => undefined);
      if (d) all.push(d);
    }
    return { streak: studyStreak(studyDays(all), now), week: focusWeek(all, now) };
  }

  /**
   * Keeps a finished focus-timer session.
   *
   * @param id - The course she focused on.
   * @param minutes - Minutes actually focused (1–600).
   */
  async addFocus(id: string, minutes: number): Promise<StudyFocus> {
    const d = await this.get(id);
    const f = { t: Date.now(), minutes: Math.min(600, Math.max(1, Math.round(Number(minutes) || 0))) };
    (d.focus ??= []).push(f);
    if (d.focus.length > 5000) d.focus.splice(0, d.focus.length - 5000);
    await this.save(d);
    return f;
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

  /** Recordings are kept in their own folder (audio, not JSON): one file per lecture. */
  private recDir(id: string): string {
    if (!/^[\w-]{1,80}$/.test(id)) throw Object.assign(new Error("No such course."), { statusCode: 404 });
    return join(this.dir, "recordings", id);
  }

  /** @returns The lecture's kept recording file and type, if it has one. */
  async recordingFile(id: string, lectureId: string): Promise<{ path: string; mime: string; bytes: number } | undefined> {
    const d = await this.get(id);
    const l = this.lecture(d, lectureId);
    if (!l.recording) return undefined;
    const path = join(this.recDir(id), `${lectureId.replace(/[^\w-]/g, "")}.audio`);
    return { path, mime: l.recording.mime, bytes: l.recording.bytes };
  }

  /**
   * Keeps a lecture's recording (from the computer's recorder or the phone's, on sync).
   *
   * @param data - The audio (WebM/Ogg/MP4/WAV), at most 400 MB.
   * @param mime - Its type.
   */
  async saveRecording(id: string, lectureId: string, data: Buffer, mime: string): Promise<StudyLecture> {
    if (!/^audio\/(webm|ogg|mp4|wav|x-wav|mpeg)$/.test(mime)) throw Object.assign(new Error("Send the recording as audio (WebM, Ogg, MP4 or WAV)."), { statusCode: 415 });
    if (data.length < 1000 || data.length > 400 * 1024 * 1024) throw Object.assign(new Error("The recording is empty or larger than 400 MB."), { statusCode: 400 });
    const d = await this.get(id);
    const l = this.lecture(d, lectureId);
    await mkdir(this.recDir(id), { recursive: true });
    const path = join(this.recDir(id), `${lectureId.replace(/[^\w-]/g, "")}.audio`);
    await writeFile(`${path}.tmp`, data);
    await rename(`${path}.tmp`, path);
    l.recording = { t: Date.now(), bytes: data.length, mime };
    await this.save(d);
    return l;
  }

  /** Deletes a lecture's kept recording (its transcript stays). */
  async removeRecording(id: string, lectureId: string): Promise<void> {
    const d = await this.get(id);
    const l = this.lecture(d, lectureId);
    await rm(join(this.recDir(id), `${lectureId.replace(/[^\w-]/g, "")}.audio`), { force: true });
    delete l.recording;
    await this.save(d);
  }

  /** What happens to kept recordings (Settings → Study). */
  async recordingSettings(): Promise<StudyRecordingSettings> {
    const j: Partial<StudyRecordingSettings> = await readFile(join(this.dir, "_recordings.json"), "utf8").then((t) => JSON.parse(t) as Partial<StudyRecordingSettings>, () => ({}));
    const after = ["never", "30", "90", "semester"].includes(String(j.deleteAfter)) ? (j.deleteAfter as StudyRecordingSettings["deleteAfter"]) : RECORDING_DEFAULTS.deleteAfter;
    return { keep: typeof j.keep === "boolean" ? j.keep : RECORDING_DEFAULTS.keep, deleteAfter: after, ...(j.asked ? { asked: true } : {}) };
  }

  /** Changes them (and deletes what the new choice says is due). */
  async setRecordingSettings(change: Partial<StudyRecordingSettings>): Promise<StudyRecordingSettings> {
    const cur = await this.recordingSettings();
    const next: StudyRecordingSettings = {
      keep: typeof change.keep === "boolean" ? change.keep : cur.keep,
      deleteAfter: change.deleteAfter && ["never", "30", "90", "semester"].includes(change.deleteAfter) ? change.deleteAfter : cur.deleteAfter,
      ...(change.asked || cur.asked ? { asked: true } : {}),
    };
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, "_recordings.json"), JSON.stringify(next));
    await this.cleanRecordings().catch(() => undefined);
    return next;
  }

  /** Sets when her semester ends (YYYY-MM-DD), for "delete after the semester"; "" clears it. */
  async setSemesterEnd(id: string, date: string): Promise<StudyCourse> {
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Object.assign(new Error("The date is YYYY-MM-DD."), { statusCode: 400 });
    const d = await this.get(id);
    if (date) d.course.semesterEnd = date;
    else delete d.course.semesterEnd;
    await this.save(d);
    return d.course;
  }

  /** Deletes kept recordings whose time has come (on start, daily, and when the choice changes). */
  async cleanRecordings(now = Date.now()): Promise<number> {
    const settings = await this.recordingSettings();
    if (settings.deleteAfter === "never") return 0;
    let n = 0;
    for (const c of await this.list()) {
      const d = await this.get(c.id).catch(() => undefined);
      if (!d) continue;
      const end = semesterEnd(d);
      for (const l of d.lectures) {
        if (!l.recording || !recordingExpired(l.recording, settings, end, now)) continue;
        await this.removeRecording(d.course.id, l.id).catch(() => undefined);
        n++;
      }
    }
    return n;
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

  /**
   * Which model writes for this course: "auto" (the best Hebrew model on this computer, else the active chat model),
   * or a model id. Empty goes back to auto.
   */
  async setModel(id: string, model: string): Promise<StudyCourse> {
    const d = await this.get(id);
    const m = model.trim().slice(0, 300);
    if (m && m !== "auto" && !/^[\w.-]+\/[^\s]+$/.test(m)) throw Object.assign(new Error("No such model."), { statusCode: 400 });
    if (!m || m === "auto") delete d.course.model;
    else d.course.model = m;
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
    await rm(this.recDir(id), { recursive: true, force: true }).catch(() => undefined);
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
      const had = new Set(mine?.lectures.map((l) => l.id) ?? []);
      const merged = mine ? mergeCourseData(mine, theirs) : theirs;
      await this.save(merged);
      // Lectures recorded on the phone and not summarized there: the computer does the heavy work by itself.
      for (const l of merged.lectures) if (!had.has(l.id) && !l.summary && l.text.length > 200) this.summarizeLater(merged.course.id, l.id);
    }
    const all = [];
    for (const c of await this.list()) all.push(await this.get(c.id));
    return { courses: all, removedCourses: [...gone] };
  }

  /** Adds a lecture's text (typed, pasted, or a transcript). */
  async addLecture(id: string, p: { title?: string; text: string; date?: string; youtube?: string }): Promise<StudyLecture> {
    const d = await this.get(id);
    const text = String(p.text ?? "").slice(0, 400_000);
    if (!text.trim()) throw Object.assign(new Error("The lecture has no text."), { statusCode: 400 });
    const lecture: StudyLecture = { id: randomUUID(), title: (p.title ?? "").trim().slice(0, 200) || `${d.lectures.length + 1}`, date: /^\d{4}-\d{2}-\d{2}$/.test(p.date ?? "") ? p.date! : new Date().toISOString().slice(0, 10), text, ...(p.youtube && /^[\w-]{11}$/.test(p.youtube) ? { youtube: p.youtube } : {}) };
    d.lectures.push(lecture);
    if (!d.course.fieldChosen) {
      const guess = detectField(d.course.name, d.lectures.map((x) => `${x.title} ${x.text.slice(0, 3000)}`).join(" "));
      if (guess) d.course.field = guess;
    }
    await this.save(d);
    return lecture;
  }

  /** Changes a lecture's title, date or text. */
  async updateLecture(id: string, lectureId: string, p: Partial<Pick<StudyLecture, "title" | "date" | "text" | "summary" | "notes">>): Promise<StudyLecture> {
    const d = await this.get(id);
    const l = this.lecture(d, lectureId);
    if (typeof p.title === "string") l.title = p.title.trim().slice(0, 200) || l.title;
    if (typeof p.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.date)) l.date = p.date;
    if (typeof p.text === "string" && p.text.trim()) l.text = p.text.slice(0, 400_000);
    if (typeof p.summary === "string") l.summary = p.summary.slice(0, 100_000);
    if (typeof p.notes === "string") {
      if (p.notes.trim()) l.notes = p.notes.slice(0, 50_000);
      else delete l.notes;
      l.notesT = Date.now();
    }
    await this.save(d);
    return l;
  }

  /** Removes a lecture (its cards stay, without the link). */
  async removeLecture(id: string, lectureId: string): Promise<void> {
    const d = await this.get(id);
    d.lectures = d.lectures.filter((l) => l.id !== lectureId);
    d.removed = [...(d.removed ?? []), lectureId].slice(-5000);
    await rm(join(this.recDir(id), `${lectureId.replace(/[^\w-]/g, "")}.audio`), { force: true }).catch(() => undefined);
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

  /** Writes the lecture's spoken review (an audio overview) from its summary, or its text, and keeps it. */
  async audioOverview(id: string, lectureId: string, signal?: AbortSignal): Promise<StudyLecture> {
    const d = await this.get(id);
    const l = this.lecture(d, lectureId);
    const material = l.summary ? `Summary:\n${l.summary}\n\nThe lecture (start):\n${l.text.slice(0, 20_000)}` : l.text.slice(0, 40_000);
    const he = hebrewLecture(l.text);
    const say = async (extra: string) => (await this.ask(`${AUDIO_PROMPT}${extra}`, `Lecture: ${l.title}\n\n${material}`, signal, d.course)).replace(/[#*_`>|]/g, "").trim().slice(0, 20_000);
    let text = await say(he ? " Write it in Hebrew." : "");
    // Some local models answer in English whatever they are told (found on the PC): once more, Hebrew first.
    if (he && latinMostly(text)) text = await say(" Answer in Hebrew only (עברית), every sentence.");
    l.audio = text;
    await this.save(d);
    return l;
  }

  /** A video overview of a lecture: narrated slides made once by the chat model and kept (design VideoOverview). */
  async videoOverview(id: string, lectureId: string, signal?: AbortSignal): Promise<StudyLecture> {
    const d = await this.get(id);
    const l = this.lecture(d, lectureId);
    const material = l.summary ? `Summary:\n${l.summary}\n\nThe lecture (start):\n${l.text.slice(0, 16_000)}` : l.text.slice(0, 30_000);
    const he = hebrewLecture(l.text);
    const make = async (extra: string) => parseVideoSlides(jsonIn(await this.ask(`${VIDEO_PROMPT}${extra}`, `Lecture: ${l.title}\n\n${material}`, signal, d.course)));
    let slides = await make(he ? " Write every title, bullet and narration in Hebrew." : "");
    if (he && latinMostly(slides.map((x) => `${x.title} ${x.bullets.join(" ")} ${x.say}`).join(" "))) slides = await make(" Answer in Hebrew only (עברית): every title, bullet and narration.");
    if (slides.length < 2) throw Object.assign(new Error("The model did not write the slides in the expected form; try again or pick another model."), { statusCode: 502 });
    l.video = slides;
    await this.save(d);
    return l;
  }

  /** The course as a file to share with classmates (its material, without her history). */
  async exportCourse(id: string): Promise<SharedCourse> {
    return shareCourse(await this.get(id));
  }

  /** A shared course file opened as a new course of her own (checked like a synced course). */
  async importCourse(file: unknown): Promise<StudyCourse> {
    const opened = openSharedCourse(file, () => randomUUID(), (now) => JSON.parse(JSON.stringify(createEmptyCard(now))) as Record<string, unknown>);
    const d = opened && cleanCourseData(opened);
    if (!d) throw Object.assign(new Error("This is not a shared KesherAI course file."), { statusCode: 400 });
    await this.save(d);
    return d.course;
  }

  /**
   * The course's tutor: answers a question from her own lectures only, naming the lecture of each fact.
   *
   * @param id - The course.
   * @param question - Her question.
   * @param history - The conversation so far (last few turns are kept).
   * @returns The answer and the lectures it drew on.
   */
  async askCourse(id: string, question: string, history: Array<{ role: "user" | "assistant"; content: string }> = [], signal?: AbortSignal, mode: "ask" | "study" | "homework" = "ask"): Promise<{ answer: string; sources: Array<{ lectureId: string; title: string }> }> {
    if (!question.trim() && mode !== "study") throw Object.assign(new Error("Ask a question."), { statusCode: 400 });
    const d = await this.get(id);
    const m = this.model(d.course.model);
    if (!m) throw Object.assign(new Error("Choose a chat model first (Models page)."), { statusCode: 409 });
    // The same messages as the phone's tutor (shared): answers from her lectures, or study mode asking her.
    const hint = d.course.field ? FIELD_HINT[d.course.field] : undefined;
    const he = /[\u0590-\u05ff]/.test(`${question} ${d.lectures[0]?.text.slice(0, 400) ?? ""}`);
    const say = async (messages: TutorMessage[]) => (await m.turn({ messages, tools: [] }, signal ?? AbortSignal.timeout(300_000), () => undefined)).text;
    const sourcesOf = (passages: StudyPassage[]) => {
      const seen = new Set<string>();
      return passages.filter((p) => !seen.has(p.lectureId) && seen.add(p.lectureId)).map((p) => ({ lectureId: p.lectureId, title: p.title, ...(p.page ? { page: p.page } : {}) }));
    };
    // Study mode, her answer: graded first as a plain verdict (our words, by her lecture), then the next question.
    const asked = [...history].reverse().find((h) => h.role === "assistant")?.content;
    if (mode === "study" && question.trim() && asked) {
      const g = gradeMessages({ lectures: d.lectures, tutorQuestion: asked, answer: question });
      const line = gradeLine(await say(g.messages), he);
      if (line) {
        const next = tutorMessages({ lectures: d.lectures, question: "", history: [...history, { role: "user", content: question }, { role: "assistant", content: line }], mode, hint });
        return { answer: `${line}\n\n${cleanScript((await say(next.messages)).trim(), he)}`, sources: sourcesOf(g.passages) };
      }
    }
    const { messages, passages } = tutorMessages({ lectures: d.lectures, question, history, mode, hint });
    return { answer: cleanScript((await say(messages)).trim(), he), sources: sourcesOf(passages) };
  }

  /**
   * Reads a syllabus's text (from /api/study/extract) with the chat model: exams, assignments and weekly topics, for
   * her to confirm. Nothing is saved here.
   */
  async readSyllabus(text: string, signal?: AbortSignal): Promise<StudySyllabus> {
    const t = text.trim().slice(0, 60_000);
    if (!t) throw Object.assign(new Error("The syllabus has no text."), { statusCode: 400 });
    const raw = await this.ask(SYLLABUS_PROMPT(dayKey(Date.now())), t, signal ?? AbortSignal.timeout(300_000), undefined, 30_000);
    const s = parseSyllabus(raw);
    if (!s) throw Object.assign(new Error("No dates or topics were found in the syllabus."), { statusCode: 422 });
    return s;
  }

  /**
   * Keeps the syllabus she confirmed; the course's exam date becomes its next exam when none was set.
   */
  async setSyllabus(id: string, raw: unknown): Promise<StudySyllabus | null> {
    const d = await this.get(id);
    const s = raw === null ? undefined : parseSyllabus(raw);
    if (s) d.syllabus = s;
    else delete d.syllabus;
    const today = dayKey(Date.now());
    const next = s?.exams.find((e) => e.date >= today);
    if (next && (!d.course.examDate || d.course.examDate < today)) d.course.examDate = next.date;
    await this.save(d);
    return s ?? null;
  }

  /**
   * Keeps a past exam's text for practice tests like it.
   *
   * @param id - The course.
   * @param p - Its title and text (from a file or photo, read by extract).
   */
  async addPastExam(id: string, p: { title?: string; text?: string }): Promise<StudyPastExam> {
    const text = String(p.text ?? "").trim().slice(0, 200_000);
    if (!text) throw Object.assign(new Error("The past exam has no text."), { statusCode: 400 });
    const d = await this.get(id);
    const e = { id: randomUUID(), title: String(p.title ?? "").trim().slice(0, 200) || "Past exam", text, t: Date.now() };
    (d.pastExams ??= []).push(e);
    if (d.pastExams.length > 50) d.pastExams.splice(0, d.pastExams.length - 50);
    await this.save(d);
    return e;
  }

  /** Removes a past exam (and keeps it from coming back with a sync). */
  async removePastExam(id: string, examId: string): Promise<void> {
    const d = await this.get(id);
    d.pastExams = (d.pastExams ?? []).filter((e) => e.id !== examId);
    d.removed = [...(d.removed ?? []), examId].slice(-5000);
    await this.save(d);
  }

  /**
   * Translates a piece of a live lecture transcript (live captions in the other language).
   *
   * @param text - Half a minute of transcript.
   * @param to - he or en.
   */
  async translate(text: string, to: "he" | "en", signal?: AbortSignal): Promise<{ text: string }> {
    const t = text.trim().slice(0, 4000);
    if (!t) return { text: "" };
    const out = await this.ask(TRANSLATE_PROMPT(to), t, signal ?? AbortSignal.timeout(90_000));
    return { text: cleanScript(out.trim(), to === "he") };
  }

  /**
   * Explains a passage she selected in a lecture.
   *
   * @param id - The course.
   * @param lectureId - The lecture.
   * @param selection - The selected text.
   * @param kind - explain, simple or example.
   */
  async explainPassage(id: string, lectureId: string, selection: string, kind: "explain" | "simple" | "example", signal?: AbortSignal): Promise<{ text: string }> {
    if (!selection.trim()) throw Object.assign(new Error("Select some text first."), { statusCode: 400 });
    const d = await this.get(id);
    const m = this.model(d.course.model);
    if (!m) throw Object.assign(new Error("Choose a chat model first (Models page)."), { statusCode: 409 });
    const messages = explainMessages({ selection, lecture: this.lecture(d, lectureId), kind, hint: d.course.field ? FIELD_HINT[d.course.field] : undefined });
    const r = await m.turn({ messages, tools: [] }, signal ?? AbortSignal.timeout(180_000), () => undefined);
    return { text: cleanScript(r.text.trim(), /[\u0590-\u05ff]/.test(selection)) };
  }

  /**
   * Why a missed card's answer is right, in a sentence or two, from her lecture.
   *
   * @param id - The course.
   * @param cardId - The card she got wrong.
   * @returns The explanation.
   */
  async explainCard(id: string, cardId: string, signal?: AbortSignal): Promise<{ text: string }> {
    const d = await this.get(id);
    const card = d.cards.find((c) => c.id === cardId);
    if (!card) throw Object.assign(new Error("No such card."), { statusCode: 404 });
    const passage = findPassages(d.lectures.filter((l) => !card.lectureId || l.id === card.lectureId), `${card.front} ${card.back}`, 2500).map((p) => p.text).join("\n");
    const text = await this.ask(MISSED_PROMPT, `Card: ${card.front}\nAnswer: ${card.back}${passage ? `\n\nLecture passage:\n${passage}` : ""}`, signal ?? AbortSignal.timeout(120_000), d.course);
    return { text: text.trim() };
  }

  /**
   * One question to the chat model. `maxChars` stops a model that runs on (found on the PC: a quiz of 4 questions
   * still writing after 10000 tokens) and returns what it wrote so far.
   */
  private async ask(system: string, user: string, signal?: AbortSignal, course?: StudyCourse | string, maxChars = 60_000): Promise<string> {
    // The course's own model (a Hebrew one, chosen per course), else the active chat model.
    const field = typeof course === "string" ? course : course?.field;
    const m = this.model(typeof course === "object" ? course.model : undefined);
    if (field && FIELD_HINT[field]) system = `${system}\n${FIELD_HINT[field]}`;
    if (!m) throw Object.assign(new Error("Choose a chat model first (Models page)."), { statusCode: 409 });
    const stop = new AbortController();
    const outer = signal ?? AbortSignal.timeout(600_000);
    if (outer.aborted) stop.abort();
    else outer.addEventListener("abort", () => stop.abort(), { once: true });
    let so = "";
    try {
      const r = await m.turn({ messages: [{ role: "system", content: system }, { role: "user", content: user }], tools: [] }, stop.signal, (d) => {
        so += d;
        if (so.length > maxChars && !stop.signal.aborted) stop.abort();
      });
      return r.text;
    } catch (err) {
      // Stopped for running on (not by her or the timeout): what it wrote is the answer.
      if (so.length > maxChars && !outer.aborted) return so;
      throw err;
    }
  }

  /** Writes a lecture's summary, terms and diagram (long lectures: piece by piece, then together). */
  async summarize(id: string, lectureId: string, signal?: AbortSignal): Promise<StudyLecture> {
    const d = await this.get(id);
    const l = this.lecture(d, lectureId);
    const parts = pieces(l.text);
    let material = l.text;
    if (parts.length > 1) {
      const notes: string[] = [];
      for (const [i, p] of parts.entries()) notes.push(await this.ask(`Write detailed notes of this part of a lecture: every idea, term, number and example. ${LANG} ${ONLY_MATERIAL}`, `Part ${i + 1} of ${parts.length}:\n\n${p}`, signal, d.course));
      material = notes.join("\n\n");
    }
    const raw = await this.ask(SUMMARY_PROMPT, `Lecture: ${l.title}\n\n${material.slice(0, 60_000)}`, signal, d.course);
    const j = jsonIn(raw) as { summary?: string; terms?: StudyTerm[]; diagram?: string; picture?: string } | undefined;
    l.summary = (j?.summary ?? raw).slice(0, 100_000);
    l.terms = Array.isArray(j?.terms) ? j!.terms.filter((t) => t && t.term && t.explain).slice(0, 80).map((t) => ({ term: String(t.term).slice(0, 120), ...(t.en ? { en: String(t.en).slice(0, 120) } : {}), explain: String(t.explain).slice(0, 400) })) : [];
    const diagram = String(j?.diagram ?? "").replace(/^```(?:mermaid)?\s*|```$/g, "").trim();
    if (diagram) l.diagram = diagram.slice(0, 8000);
    else delete l.diagram;
    const picture = String(j?.picture ?? "").replace(/[^\x20-\x7e]/g, "").trim().slice(0, 80);
    if (picture) l.picture = picture;
    await this.save(d);
    return l;
  }

  /** Runs one of her field's tools on text she pasted, or on the course's lectures. */
  async runTool(id: string, toolId: string, text: string, signal?: AbortSignal): Promise<{ text: string }> {
    const d = await this.get(id);
    const tool = STUDY_TOOLS.find((t) => t.id === toolId);
    if (!tool) throw Object.assign(new Error("No such tool."), { statusCode: 404 });
    let input: string;
    if (tool.input === "course") {
      if (!d.lectures.length) throw Object.assign(new Error("Add a lecture first."), { statusCode: 400 });
      input = toolMaterial(d.lectures);
    } else {
      input = text.trim().slice(0, 40_000);
      if (input.length < 10) throw Object.assign(new Error("Paste the text first."), { statusCode: 400 });
    }
    const out = await this.ask(tool.prompt, input, signal, d.course, 40_000);
    // A whole answer wrapped in a ```markdown fence (seen on the PC) showed the fence as text.
    const plain = out.trim().replace(/^```[a-z]*\s*\n([\s\S]*?)\n?```$/i, "$1");
    // The answer's own language decides the cleaning (an English paper gets a Hebrew analysis).
    return { text: cleanScript(plain.trim(), /[\u0590-\u05ff]/.test(plain)).slice(0, 40_000) };
  }

  /**
   * Free pictures (diagrams and photos) from Wikimedia Commons for a lecture's topic, fetched here and sent as data:
   * copies (the page never loads pictures from another site), each with its licence and author.
   */
  async lecturePictures(id: string, lectureId: string, signal?: AbortSignal, kind: StudyMediaKind = "image"): Promise<{ query: string; pictures: StudyPicture[] }> {
    const d = await this.get(id);
    const l = this.lecture(d, lectureId);
    // The searches in order until one finds something (see pictureQueries).
    let query = "";
    let found: StudyPicture[] = [];
    for (const q of pictureQueries(l)) {
      query = q;
      const res = await fetch(commonsSearchUrl(q, 480, kind), { headers: { "user-agent": "KesherAI (https://github.com/Deadchu-R/KesherAI; local app)" }, signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(20_000)]) });
      if (!res.ok) throw Object.assign(new Error(`Wikimedia answered ${res.status}.`), { statusCode: 502 });
      found = relevantPictures(parseCommonsPictures(await res.json(), 8, kind), q);
      if (found.length) break;
    }
    const got = await Promise.all(found.map(async (p) => {
      try {
        if (kind === "gif") {
          // An animation: GIF bytes, checked like a picture (Commons only, no redirects, 3 MB at most, a real GIF).
          const r = await fetch(p.src, { headers: { "user-agent": "KesherAI (https://github.com/Deadchu-R/KesherAI; local app)" }, redirect: "error", signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(30_000)]) });
          const bytes = new Uint8Array(await r.arrayBuffer());
          if (!r.ok || bytes.length > 3 * 1024 * 1024 || String.fromCharCode(...bytes.slice(0, 4)) !== "GIF8") return undefined;
          return { ...p, src: `data:image/gif;base64,${Buffer.from(bytes).toString("base64")}` };
        }
        const pic = await downloadPicture({ url: p.src, width: 0, height: 0, page: p.page, license: p.license, artist: p.artist, from: "commons" }, { maxBytes: 1024 * 1024, ...(signal ? { signal } : {}) });
        return { ...p, src: `data:${pic.mimeType};base64,${Buffer.from(pic.data).toString("base64")}` };
      } catch {
        return undefined;
      }
    }));
    return { query, pictures: got.filter((p): p is StudyPicture => !!p) };
  }

  /** Searches all her courses (lectures, summaries, notes, cards, terms). */
  async search(q: string): Promise<StudyHit[]> {
    const rows = await this.list();
    const all = await Promise.all(rows.map((r) => this.get(r.id)));
    return searchStudy(all, q);
  }

  /**
   * Grows the course's one summary by topic from lectures summarized since it was last written (a few at a time:
   * call again while `more` is true).
   */
  async courseSummary(id: string, signal?: AbortSignal): Promise<{ summary: StudyCourseSummary; more: boolean }> {
    const d = await this.get(id);
    if (!d.lectures.some((l) => l.summary?.trim())) throw Object.assign(new Error("Summarize at least one lecture first."), { statusCode: 400 });
    const inp = courseSummaryInput(d);
    if (!inp) return { summary: d.courseSummary!, more: false };
    // A summary is about as long as what it is made from; much past that the model is running on (found on the PC).
    const raw = await this.ask(COURSE_SUMMARY_PROMPT, inp.user, signal, d.course, Math.min(120_000, Math.max(6000, Math.round(inp.user.length * 1.6))));
    const s = parseCourseSummary(raw, d.courseSummary, inp.ids);
    if (!s) throw Object.assign(new Error("The model did not write a summary. Try again."), { statusCode: 502 });
    const fresh = await this.get(id);
    fresh.courseSummary = s;
    await this.save(fresh);
    return { summary: s, more: !!courseSummaryInput(fresh) };
  }

  /** Makes flashcards from a lecture, studied in one format. */
  async makeCards(id: string, lectureId: string, p: { format?: StudyFormat; count?: number }, signal?: AbortSignal): Promise<StudyCard[]> {
    const d = await this.get(id);
    const l = this.lecture(d, lectureId);
    const format: StudyFormat = STUDY_FORMATS.includes(p.format as StudyFormat) ? p.format! : "text";
    const count = Math.max(3, Math.min(40, Number(p.count) || 12));
    const material = (l.summary && l.text.length > 24_000 ? `${l.summary}\n\nTerms: ${(l.terms ?? []).map((t) => `${t.term}${t.en ? ` (${t.en})` : ""}: ${t.explain}`).join("; ")}` : l.text).slice(0, 40_000);
    const raw = await this.ask(`${CARDS_PROMPT}\n${FORMAT_HINT[format]}`, `Write ${count} cards.\n\nLecture: ${l.title}\n\n${material}`, signal, d.course);
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

  /**
   * Teach-back (the Feynman technique, design TeachBack): her explanation of a topic checked against the lecture —
   * what she got right, what she left out (each with a card she can add), what is wrong, a score and a tip.
   */
  async teachBack(id: string, lectureId: string, topic: string, explanation: string, signal?: AbortSignal): Promise<TeachBackResult> {
    if (explanation.trim().length < 20) throw Object.assign(new Error("Explain it in a few sentences first."), { statusCode: 400 });
    const d = await this.get(id);
    const l = this.lecture(d, lectureId);
    const material = l.summary ? `Summary:\n${l.summary}\n\nThe lecture:\n${l.text.slice(0, 20_000)}` : l.text.slice(0, 30_000);
    const he = hebrewLecture(`${explanation} ${l.text.slice(0, 2000)}`);
    const r = parseTeachBack(jsonIn(await this.ask(`${TEACH_BACK_PROMPT}${he ? " Write it all in Hebrew." : ""}`, `Lecture: ${l.title}\n\n${material}\n\nTopic: ${topic.slice(0, 200) || l.title}\n\nHer explanation:\n${explanation.slice(0, 6000)}`, signal, d.course)));
    if (!r) throw Object.assign(new Error("The model did not check it in the expected form; try again or pick another model."), { statusCode: 502 });
    return r;
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

  /**
   * Cards from an Anki or Quizlet export (tab, semicolon or comma separated), added as new cards; the same card
   * (front and back) already in the course is skipped.
   */
  async importCards(id: string, text: string): Promise<{ added: number; skipped: number }> {
    const d = await this.get(id);
    const have = new Set(d.cards.map((c) => `${c.front}\u0000${c.back}`));
    let added = 0;
    let skipped = 0;
    for (const x of cardsFromTsv(text)) {
      if (have.has(`${x.front}\u0000${x.back}`)) { skipped++; continue; }
      have.add(`${x.front}\u0000${x.back}`);
      const c = createEmptyCard(new Date());
      d.cards.push({ id: randomUUID(), front: x.front, back: x.back, format: "text", createdAt: Date.now(), due: c.due.toISOString(), fsrs: fromCard(c) });
      added++;
    }
    if (d.cards.length > 20_000) throw Object.assign(new Error("A course holds 20000 cards at most."), { statusCode: 400 });
    if (added) await this.save(d);
    return { added, skipped };
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
  async makeQuiz(id: string, p: { lectureIds?: string[]; count?: number; weak?: boolean; style?: "licensing" | "past"; kind?: "open" | "case"; level?: StudyLevel }, signal?: AbortSignal): Promise<StudyQuiz> {
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
    const level = p.level && p.level !== "normal" ? `\n${LEVEL_RULE[p.level]}` : "";
    if (p.kind) {
      // Open or case questions: fewer (each is answered in writing), graded later against a model answer.
      const n = Math.min(count, 10);
      const raw = await this.ask(`${OPEN_QUIZ_PROMPT(p.kind)}${level}`, `Write exactly ${n} questions, then stop.\n\n${material}`, signal, d.course, n * 1800 + 2000);
      const questions = parseOpenQuestions(raw, chosen.map((l) => l.id), n);
      if (!questions.length) throw Object.assign(new Error("The model did not return usable questions. Try again, or another model."), { statusCode: 502 });
      const quiz: StudyQuiz = { id: randomUUID(), t: Date.now(), questions, kind: p.kind, ...(p.level ? { level: p.level } : {}) };
      d.quizzes.push(quiz);
      if (d.quizzes.length > 200) d.quizzes.splice(0, d.quizzes.length - 200);
      await this.save(d);
      return quiz;
    }
    const past = p.style === "past" ? pastExamStyle(d.pastExams ?? []) : "";
    if (p.style === "past" && !past) throw Object.assign(new Error("Add a past exam first."), { statusCode: 400 });
    // About 1500 characters a question is plenty; past that the model is running on.
    const raw = await this.ask(`${p.style === "licensing" ? `${QUIZ_PROMPT}\n${LICENSING}` : past ? `${QUIZ_PROMPT}\n${past}` : QUIZ_PROMPT}${level}`, `Write exactly ${count} questions, then stop.\n\n${material}`, signal, d.course, count * 1500 + 2000);
    // A list cut off mid-way: keep the questions that were finished.
    const list = jsonIn(raw) ?? (raw.includes("[") && raw.lastIndexOf("}") > raw.indexOf("[") ? jsonIn(`${raw.slice(raw.indexOf("["), raw.lastIndexOf("}") + 1)}]`) : undefined);
    if (!Array.isArray(list)) throw Object.assign(new Error("The model did not return a quiz. Try again, or another model."), { statusCode: 502 });
    const questions: StudyQuestion[] = [];
    for (const x of list as Array<{ q?: string; options?: unknown[]; answer?: number; explain?: string; lecture?: number }>) {
      const options = Array.isArray(x?.options) ? x.options.map((o) => String(o).slice(0, 600)).filter(Boolean) : [];
      const answer = Number(x?.answer);
      if (!x?.q || options.length < 2 || !(answer >= 0 && answer < options.length)) continue;
      // A long, wandering explanation means the model was not sure of its own answer (found on the PC): drop it.
      if (String(x.explain ?? "").length > 900) continue;
      const lec = chosen[Number(x.lecture) - 1] ?? (chosen.length === 1 ? chosen[0] : undefined);
      const checked = checkCalcQuestion({ q: String(x.q).slice(0, 2000), options, answer, explain: String(x.explain ?? "").slice(0, 2000), ...(lec ? { lectureId: lec.id } : {}) });
      if (!checked) continue;
      questions.push(checked);
      if (questions.length >= count) break;
    }
    if (!questions.length) throw Object.assign(new Error("The model did not return usable questions. Try again, or another model."), { statusCode: 502 });
    const quiz: StudyQuiz = { id: randomUUID(), t: Date.now(), questions, ...(p.level ? { level: p.level } : {}) };
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
  /** Grades her written answers to an open or case quiz, one by one, against each model answer and her lecture. */
  async answerOpenQuiz(id: string, quizId: string, texts: string[], signal?: AbortSignal): Promise<StudyQuiz> {
    const d = await this.get(id);
    const z = d.quizzes.find((q) => q.id === quizId);
    if (!z?.kind) throw Object.assign(new Error("No such open quiz."), { statusCode: 404 });
    const m = this.model(d.course.model);
    if (!m) throw Object.assign(new Error("Choose a chat model first (Models page)."), { statusCode: 409 });
    const he = /[\u0590-\u05ff]/.test(z.questions.map((q) => q.q).join(" "));
    const marks: number[] = [];
    const feedback: string[] = [];
    for (const [i, q] of z.questions.entries()) {
      const text = String(texts?.[i] ?? "").trim().slice(0, 3000);
      if (!text) { marks.push(0); feedback.push(he ? "✗ לא נענתה." : "✗ Not answered."); continue; }
      const raw = (await m.turn({ messages: openGradeMessages({ lectures: d.lectures, question: q, text }), tools: [] }, signal ?? AbortSignal.timeout(180_000), () => undefined)).text;
      const r = openMark(raw, he);
      marks.push(r?.mark ?? 0);
      feedback.push(r?.line ?? (he ? "לא הצלחתי לבדוק את התשובה הזאת." : "Could not check this answer."));
    }
    const fresh = await this.get(id);
    const fz = fresh.quizzes.find((q) => q.id === quizId) ?? z;
    fz.texts = z.questions.map((_, i) => String(texts?.[i] ?? "").slice(0, 3000));
    fz.marks = marks;
    fz.feedback = feedback;
    fz.answers = z.questions.map(() => -1);
    fz.score = marks.reduce((a, b) => a + b, 0);
    await this.save(fresh);
    return fz;
  }

  /** Grades her multiple-choice answers by code. */
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
