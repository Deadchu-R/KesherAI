/**
 * The shape of a chat turn, like Claude's (Roee 27.11, "usability just like Claude"): one short sentence before the
 * first tool, no "shall I?" for a clear request, little talk between tools, and a final message with the outcome, the
 * file and at most one next step, in the user's language. The prompt block tells the model; the cheap post-checks here
 * (no extra model call) find the two things weaker local models get wrong most: a long step-by-step recap, and an
 * answer in the wrong script.
 */

import { todoOpenNudge, type TodoItem } from "@kesher/shared";

/** The block offered on turns that have tools (session.ts). Short, English, model-agnostic. */
export const TURN_SHAPE_PROMPT = [
  "How to shape a turn:",
  "- ALWAYS write one short sentence in your message before your first tool call, saying what you are about to do (for example \"I'll read notes.txt.\"). A tool call with no words before it is wrong.",
  "- A clear request: start at once. Do not ask \"shall I?\" and do not wait for approval of a plan.",
  "- Only when the request is both ambiguous and expensive: ask ONE question first, with ask_user and options.",
  "- Between tool calls say almost nothing.",
  "- The final message: what came out, the file or link, and at most one next step. Do not list the steps you took.",
  "- Write in the user's language.",
].join("\n");

/** Default longest final answer, in lines, before a step-by-step recap is cut (Settings › Chats). */
export const DEFAULT_SHORT_LINES = 25;

/** Takes fenced and inline code out, so code and its comments are never judged as prose. */
export function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?(```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
}

/** "First I… then I…", "שלב 1", or a numbered/bulleted list whose lines are actions the model took. */
const RECAP_WORDS = /\b(first,? i|then,? i|next,? i|after that,? i|finally,? i|step \d+)\b|(^|\n)\s*(\d+[.)]|[-*•])\s*(i |i'|created|ran|read|wrote|opened|installed|checked|searched|edited|updated|added)|שלב \d+|(^|\n)\s*(\d+[.)]|[-*•])\s*(קראתי|יצרתי|הרצתי|כתבתי|פתחתי|התקנתי|בדקתי|חיפשתי|ערכתי|עדכנתי|הוספתי)|קודם כל[^\n]*אחר כך|ראשית[^\n]*לאחר מכן/i;

/**
 * Whether prose describes the steps the model took (a recap), judged outside code blocks. Two or more matches are
 * needed, so one "first I" in a real explanation passes.
 *
 * @param text - The final answer.
 * @returns True when it reads as a step-by-step recap.
 */
export function hasStepRecap(text: string): boolean {
  const prose = stripCode(text);
  const re = new RegExp(RECAP_WORDS.source, "gi");
  let n = 0;
  while (re.exec(prose)) if (++n >= 2) return true;
  return false;
}

/** Lines of prose (non-empty, outside code blocks). */
export function proseLines(text: string): number {
  return stripCode(text).split("\n").filter((l) => l.trim()).length;
}

/**
 * Whether the final answer is too long AND recaps the steps: then one rewrite is asked for.
 *
 * @param text - The final answer.
 * @param maxLines - The threshold (default {@link DEFAULT_SHORT_LINES}).
 */
export function needsShortening(text: string, maxLines = DEFAULT_SHORT_LINES): boolean {
  return proseLines(text) > maxLines && hasStepRecap(text);
}

/** Takes code, paths, URLs and file names out: what is left is what the model said in words. */
function wordsOnly(text: string): string {
  return stripCode(text)
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/(?:[A-Za-z]:)?[\\/][\w.\-\\/]+/g, " ")
    .replace(/\b[\w-]+\.[A-Za-z0-9]{1,5}\b/g, " ");
}

/**
 * Whether the user wrote Hebrew and the answer is mostly Latin letters (code, paths and URLs left out).
 *
 * @param userText - What the user wrote.
 * @param answer - The final answer.
 */
export function needsHebrewRewrite(userText: string, answer: string): boolean {
  const heb = (userText.match(/[\u0590-\u05FF]/g) ?? []).length;
  const lat = (userText.match(/[A-Za-z]/g) ?? []).length;
  if (heb < 3 || heb < lat) return false;
  const w = wordsOnly(answer);
  const aLat = (w.match(/[A-Za-z]/g) ?? []).length;
  const aHeb = (w.match(/[\u0590-\u05FF]/g) ?? []).length;
  return aLat >= 40 && aLat > aHeb * 2;
}

/** What the post-check asks for, or undefined when the answer is fine. */
export type ShapeFollowUp = { kind: "shorten" | "hebrew"; message: string };

/**
 * The one follow-up instruction for a final answer, if any. The caller sends it at most once per message
 * (a `used` flag), only for a local model, and only when "Keep answers short like Claude" is on.
 *
 * @param answer - The final answer.
 * @param userText - What the user wrote.
 * @param maxLines - The length threshold.
 */
export function shapeFollowUp(answer: string, userText: string, maxLines = DEFAULT_SHORT_LINES): ShapeFollowUp | undefined {
  if (needsHebrewRewrite(userText, answer)) {
    return { kind: "hebrew", message: "[KesherAI] Rewrite your last answer in Hebrew (the user writes Hebrew). Keep code, file names, paths and links as they are. Do not call tools." };
  }
  if (needsShortening(answer, maxLines)) {
    return { kind: "shorten", message: "[KesherAI] Shorten your last answer to the outcome, the file or link, and at most one next step. Do not list the steps you took. Keep the user's language. Do not call tools." };
  }
  return undefined;
}

/** Words that make an action risky: asking first is right there (delete, push, pay, send, publish, reset). */
const DESTRUCTIVE = /\b(delet\w*|remov\w*|wipe|erase|overwrit\w*|push|force|deploy|publish|pay\w*|purchas\w*|buy|send|email|post|merge|drop|reset|uninstall|format|rm)\b|(^|[^\u0590-\u05FF])(למחוק|מחק|למחוק|הסר|להסיר|לדחוף|דחוף|לפרסם|פרסם|לשלם|שלם|לשלוח|שלח|לאפס|אפס|להתקין מחדש|לפרמט)/i;

/** A question that only asks leave to go on ("Shall I…?", "Do you want me to…?", "רוצה שאמשיך…?", "שאתחיל?"). */
const PERMISSION_Q = /\b(shall i|should i|do you want me to|would you like me to|want me to|would you like (?:me )?to|may i|can i go ahead|is it ok(?:ay)? (?:if|for) me)\b|רוצה ש(?:אני )?(?:אמשיך|אתחיל|אעשה|אבנה|אכתוב|אצור|אריץ|אעדכן|אתקן|אוסיף|אבצע|אתקין)|תרצה ש|שאתחיל|שאמשיך|שאעשה|שאבצע|האם (?:להמשיך|להתחיל|לבצע)|להמשיך\?|לבצע\?/i;

/** A request the user made: an imperative or "can you…" in English, a Hebrew imperative or "אפשר/תוכל". */
const REQUEST = /(?:^|[\s,.;:!])(?:please|make|build|create|write|add|fix|implement|change|update|run|set up|generate|refactor|rename|install|open|find|check|test|do it|do this|continue|go on|start|finish|edit|convert|remove|delete|can you|could you|will you)\b|(?:^|[\s,.;:!(])(?:תכין|תבנה|צור|תיצור|כתוב|תכתוב|הוסף|תוסיף|תקן|תתקן|תעשה|עשה|הרץ|תריץ|עדכן|תעדכן|שנה|תשנה|תתקין|התקן|פתח|תפתח|מצא|תמצא|בדוק|תבדוק|המשך|תמשיך|תתחיל|התחל|בנה|סיים|תסיים|אפשר ל|תוכל|תוכלי|בבקשה)(?=$|[\s,.;:!?)])/i;

/**
 * Whether a final answer only asks permission for work the user already clearly asked for ("act, don't ask"). Fires
 * only for a short answer whose last sentence is a permission question; never when the model used ask_user, when the
 * user's message holds no request (a question, so the model may be unsure), or when the action is destructive.
 *
 * @param answer - The final answer.
 * @param userText - What the user wrote.
 * @param askedUser - Whether ask_user was used since the user's message.
 */
export function asksPermission(answer: string, userText: string, askedUser: boolean): boolean {
  if (askedUser || !REQUEST.test(userText)) return false;
  const prose = stripCode(answer).trim();
  if (!prose || prose.length > 400) return false;
  const sentences = prose.split(/(?<=[.!?؟])\s+|\n+/).filter((s) => s.trim());
  const last = sentences.at(-1)?.trim() ?? "";
  if (!/[?؟]\s*$/.test(last) || !PERMISSION_Q.test(last)) return false;
  return !DESTRUCTIVE.test(sentences.slice(-2).join(" "));
}

/** What a final answer's post-check asks for. */
export type FinishFollowUp = { kind: "open-steps" | "act" | "send-file"; message: string };

/** The user asks for a thing to keep: "make me a summary file", "write a report", "תכין לי קובץ סיכום". */
const DELIVERABLE = /\b(?:file|files|summary|report|document|doc|script|spreadsheet|csv|pdf|readme|notes?)\b|קובץ|קבצים|סיכום|דוח|מסמך|סקריפט|טבלה/i;

/**
 * Whether the model made a file for a request that asks for one and never posted it to the chat with send_file (28.11:
 * the "summary file" check failed on the PC: the file was written, the card never came). Needs a request, not a question.
 *
 * @param userText - What the user wrote.
 * @param madeFile - Whether write_file ran since the user's message.
 * @param sentFile - Whether send_file ran since the user's message.
 * @param canSend - Whether send_file is among the chat's tools.
 */
export function forgotSendFile(userText: string, madeFile: boolean, sentFile: boolean, canSend: boolean): boolean {
  return canSend && madeFile && !sentFile && REQUEST.test(userText) && DELIVERABLE.test(userText);
}

/**
 * The one place for the "finish the job" checks on a final answer: (1) the `todo` list still has open steps, (2) the
 * answer only asks permission. Each is sent at most once per user message (the caller keeps `used`), never when the user
 * stopped the turn or it hit its step budget, and only when "Answer like Claude" is on.
 *
 * @param o.answer - The final answer.
 * @param o.userText - What the user wrote.
 * @param o.todo - The chat's list.
 * @param o.askedUser - Whether ask_user was used since the user's message.
 * @param o.used - The kinds already sent for this message.
 * @param o.skip - True when the turn was stopped or hit its budget.
 */
export function finishFollowUp(o: { answer: string; userText: string; todo?: readonly TodoItem[]; askedUser: boolean; used: ReadonlySet<string>; skip: boolean; madeFile?: boolean; sentFile?: boolean; canSend?: boolean }): FinishFollowUp | undefined {
  if (o.skip) return undefined;
  const open = todoOpenNudge(o.todo);
  if (open && !o.used.has("open-steps")) return { kind: "open-steps", message: open };
  if (!o.used.has("act") && asksPermission(o.answer, o.userText, o.askedUser)) {
    return { kind: "act", message: "[KesherAI] The user already asked for this — do it. Do not ask for permission; use your tools now and finish with the outcome." };
  }
  if (!o.used.has("send-file") && forgotSendFile(o.userText, !!o.madeFile, !!o.sentFile, !!o.canSend)) {
    return { kind: "send-file", message: "[KesherAI] You made the file but did not send it to the user. Call send_file with its path now (one call per file), then say in one line what it is." };
  }
  return undefined;
}

/** The line a local model gets when its first step was a bare tool call (asked once per message, see {@link needsSayFirst}). */
export const SAY_FIRST_NUDGE = "[KesherAI] Start again: write one short sentence saying what you are about to do (in the user's language), then make the tool call.";

/** The same re-ask for a job with several steps: the first call is the task list (see {@link asksManySteps}). */
export const SAY_FIRST_STEPS_NUDGE = `${SAY_FIRST_NUDGE.slice(0, -1)}. For this job with several steps, the first call is todo with the whole list.`;

/** The line added to a message that asks for a job in several steps, when the chat has the todo tool. */
export const STEPS_NOTE = "[KesherAI] This job has several steps: write one short sentence, then your first tool call is todo with the whole list (one short title per step). Then do the steps and mark each one done.";

/** Words that join steps: "then", "after that", "finally", Hebrew "ואז / אחר כך / לאחר מכן / ולבסוף". */
const STEP_WORDS = /\b(?:then|after that|afterwards|next|finally|and lastly)\b|(?<![א-ת])ו?(?:אז|אחר כך|לאחר מכן|לבסוף|בסוף)(?![א-ת])/gi;
/** A file name in the message ("a.txt", "summary.md"). */
const FILE_NAME = /(?<![\w/])[\w-]+\.[A-Za-z0-9]{1,5}\b/g;
/** "three files", "4 pages", "שלושה קבצים", "5 דפים": a count of 3 to 9 things to make. */
const COUNTED = /\b(?:three|four|five|six|seven|eight|nine|[3-9])\s+(?:new\s+)?(?:files?|pages?|screens?|components?|tests?|sections?|steps?|tasks?|folders?)\b|(?:שלושה|ארבעה|חמישה|שישה|שבעה|[3-9])\s+(?:קבצים|דפים|מסכים|רכיבים|בדיקות|חלקים|שלבים|משימות|תיקיות)/i;

/**
 * Whether a message clearly asks for a job in several steps (at least three): a numbered list, a count of things to
 * make with a "then", several file names joined by "then", or two or more "then / ואז" joints. Such a job starts with
 * the task list, like Claude's. A guess from words only: a wrong "yes" costs one list, so it errs on the clear cases.
 *
 * @param text - What the user wrote.
 * @returns True when the job has three or more steps.
 */
export function asksManySteps(text: string): boolean {
  const t = stripCode(text);
  if ((t.match(/(?:^|\n)\s*\d+[.)]\s+\S/g) ?? []).length >= 3) return true;
  const joints = (t.match(STEP_WORDS) ?? []).length;
  if (joints >= 2) return true;
  const files = new Set(t.match(FILE_NAME) ?? []).size;
  return joints >= 1 && (files >= 3 || COUNTED.test(t));
}

/**
 * The cheap say-first ask (28.11, measured on the PC: the old re-ask threw the whole first step away and wrote it again,
 * 3-6 s per turn). The first step's tool calls are kept and run; only this short question is added to a copy of the
 * conversation (same start, so the engine's cache serves it), and the model's one sentence becomes the words before them.
 */
export const SAY_ONLY_NUDGE = "[KesherAI] Before you make the tool call, write ONE short sentence saying what you are about to do (in the user's language, e.g. \"I'll read notes.txt.\"). Only that sentence: no tool call, no list.";

/**
 * Cleans the model's answer to {@link SAY_ONLY_NUDGE}: its first line, trimmed, at most 200 characters. Nothing is made
 * up: an empty answer (or one that is only a tool-call tag) gives `undefined` and the tool runs without words.
 *
 * @param text - What the model wrote.
 * @returns The sentence, or `undefined` when there is none.
 */
export function cleanSaid(text: string): string | undefined {
  const line = stripCode(text).split(/\n+/).map((l) => l.trim()).find((l) => l && !/^<\/?[a-z_|][^>]*>?$/i.test(l));
  if (!line) return undefined;
  return line.length > 200 ? `${line.slice(0, 197).trimEnd()}...` : line;
}

/**
 * Whether a first model step should be asked again: it started tools and wrote no words, and at least one call is real
 * work (a lone question to the user needs no opening sentence). No text is ever made up for the model.
 *
 * @param text - What the model wrote in this step.
 * @param toolNames - The tools it called.
 */
export function needsSayFirst(text: string, toolNames: readonly string[]): boolean {
  return silentToolStart(text, toolNames.length) && toolNames.some((n) => n !== "ask_user");
}

/** Whether a turn's first output starts a tool with no text before it (only recorded, never fixed). */
export function silentToolStart(text: string, toolCalls: number): boolean {
  return toolCalls > 0 && !text.trim();
}
