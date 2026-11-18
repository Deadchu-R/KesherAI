/** What the Study page's parts share: the language helper, the row shapes, and small helpers. */
import { type BacklogPlan, type ExamPlan, type StudySyllabus, type StudyCourseSummary, type StudyDrug, type StudyCourse, type StudyFormat, type StudyLecture } from "@kesher/shared";
import { getLocale, he$ } from "../../i18n";
import { toast } from "../../library";

export const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

export type CourseRow = StudyCourse & { lectures: number; cards: number; due: number; daysLeft?: number; perDay?: number; backlog?: { steady: BacklogPlan; gentle: BacklogPlan } };
export type LectureRow = Omit<StudyLecture, "text" | "summary"> & { chars: number; summarized: boolean; cards: number };
export interface CourseInfo { course: StudyCourse; lectures: LectureRow[]; cards: number; due: number; drugs: StudyDrug[]; quizzes: Array<{ id: string; t: number; score?: number; of: number }>; plan: ExamPlan | null; pastExams?: Array<{ id: string; title: string; t: number; chars: number }>; syllabus?: StudySyllabus | null; courseSummary?: StudyCourseSummary | null; mocks?: Array<{ t: number; grade: number }> }
export interface Progress { formats: Array<{ format: StudyFormat; n: number; recall: number; enough: boolean }>; byKind: Array<{ kind: string; formats: Progress["formats"] }>; weak: Array<{ lectureId: string; title: string; correct: number; n: number }>; mastery?: Array<{ lectureId: string; title: string; mastery: number; n: number; change: number }>; reviews: number; quizzed?: string[] }

export const FORMAT_NAME: Record<StudyFormat, [string, string]> = {
  text: ["טקסט", "Text"],
  diagram: ["תרשים", "Diagram"],
  audio: ["קול", "Audio"],
  example: ["דוגמה מהמחלקה", "Worked example"],
  explain: ["להסביר במילים שלי", "Explain it back"],
};
export const fmtName = (f: StudyFormat) => L(...FORMAT_NAME[f]);
export const go = (h: string) => (location.hash = h);
/** Opens a new chat with the question ready in the box (the chat can search the web and give links). */
export const askChat = (q: string) => go(`#/?ask=${encodeURIComponent(q)}`);

/** Student life: practical questions that need current, official answers. */
export const LIFE: Array<[string, string, boolean?]> = [
  ["אילו חיסונים צריך סטודנט/ית לסיעוד בישראל לפני ההתנסות הקלינית, ואיפה ואיך קובעים תור?", "Which vaccinations does a nursing student in Israel need before clinical practice, and where and how do I book them?", true],
  ["אילו מסמכים ואישורים צריך להביא לפני ההתנסות הקלינית בבית החולים?", "Which documents and certificates do I need before clinical practice at the hospital?", true],
  ["איך מגישים בקשה למועד מיוחד או להתאמות בבחינה?", "How do I apply for a special exam date or exam accommodations?"],
];
export const LIFE_RULE = L(
  "חפש ברשת ותן תשובה עדכנית עם קישור למקור רשמי (משרד הבריאות, gov.il, קופות החולים או המוסד שלי) ותאריך הבדיקה. אם זה משתנה בין מוסדות, כתוב מה לבדוק מול התוכנית שלי.",
  "Search the web and give a current answer with a link to an official source (the Ministry of Health, gov.il, the health funds or my school) and the date checked. Where it differs between schools, say what to check with my programme.",
);

/** Calls the computer, with a toast on failure; `undefined` when it failed. */
export async function call<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (e) {
    toast((e as Error).message);
    return undefined;
  }
}
