/**
 * The shape of a chat turn, like Claude's (Roee 27.11, "usability just like Claude"): one short sentence before the
 * first tool, no "shall I?" for a clear request, little talk between tools, and a final message with the outcome, the
 * file and at most one next step, in the user's language. The prompt block tells the model; the cheap post-checks here
 * (no extra model call) find the two things weaker local models get wrong most: a long step-by-step recap, and an
 * answer in the wrong script.
 */

/** The block offered on turns that have tools (session.ts). Short, English, model-agnostic. */
export const TURN_SHAPE_PROMPT = [
  "How to shape a turn:",
  "- Before your first tool call, write one short sentence saying what you are about to do.",
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

/** Whether a turn's first output starts a tool with no text before it (only recorded, never fixed). */
export function silentToolStart(text: string, toolCalls: number): boolean {
  return toolCalls > 0 && !text.trim();
}
