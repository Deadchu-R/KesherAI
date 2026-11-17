/**
 * The model team's language layer (RESEARCH_LOG "Hebrew answers while coding", design ModelTeam): the coding model
 * gets the user's own words and may answer in English or in weak Hebrew; this layer finds such an answer and has a
 * small translation model (or the chat's own model) put its prose into the user's language. Code blocks, inline
 * code, links and paths are kept out of the translation and put back exactly as they were.
 */

/** The user's language by the script of their message, or undefined for English and other Latin-script text. */
export function userLanguage(text: string): "he" | "ar" | "ru" | undefined {
  const letters = text.replace(/```[\s\S]*?```|`[^`]*`|\[[^\]]*\]|https?:\/\/\S+/g, "");
  if ((letters.match(/\p{Script=Hebrew}/gu) ?? []).length >= 3) return "he";
  if ((letters.match(/\p{Script=Arabic}/gu) ?? []).length >= 3) return "ar";
  if ((letters.match(/\p{Script=Cyrillic}/gu) ?? []).length >= 3) return "ru";
  return undefined;
}

const NAMES = { he: "Hebrew", ar: "Arabic", ru: "Russian" } as const;

/** The answer's prose: without code, links, paths and markup. */
function prose(text: string): string {
  return text.replace(/```[\s\S]*?(```|$)/g, " ").replace(/`[^`]*`/g, " ").replace(/https?:\/\/\S+/g, " ").replace(/[\w.-]*[\\/][\w./\\-]+/g, " ");
}

/**
 * Whether an answer to a message in `lang` needs translating: its prose is mostly Latin letters (written in English),
 * or it has letters of other alphabets mixed in (Arabic or Chinese in a Hebrew answer: "language confusion").
 *
 * @param answer - The model's answer.
 * @param lang - The user's language.
 */
export function needsTranslation(answer: string, lang: "he" | "ar" | "ru"): boolean {
  const p = prose(answer);
  const own = { he: /\p{Script=Hebrew}/gu, ar: /\p{Script=Arabic}/gu, ru: /\p{Script=Cyrillic}/gu }[lang];
  const mine = (p.match(own) ?? []).length;
  const latin = (p.match(/[A-Za-z]/g) ?? []).length;
  const foreign = (p.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Devanagari}]/gu) ?? []).length + (lang === "ar" ? 0 : (p.match(/\p{Script=Arabic}/gu) ?? []).length) + (lang === "ru" ? 0 : (p.match(/\p{Script=Cyrillic}/gu) ?? []).length);
  if (foreign >= 2) return true;
  // A short English answer with a few words ("Done.") is fine to leave; a real paragraph in English is not.
  return latin >= 40 && latin > mine * 1.5;
}

/**
 * Takes code, links and paths out of an answer, leaving markers ⟦0⟧, ⟦1⟧… the translator keeps as they are.
 *
 * @returns The text to translate and the pieces to put back.
 */
export function protect(answer: string): { text: string; kept: string[] } {
  const kept: string[] = [];
  const keep = (m: string) => `⟦${kept.push(m) - 1}⟧`;
  const text = answer
    .replace(/```[\s\S]*?(```|$)/g, keep)
    .replace(/`[^`\n]*`/g, keep)
    .replace(/https?:\/\/[^\s)]+/g, keep);
  return { text, kept };
}

/** Puts the kept pieces back; undefined when the translation lost or changed one of them (then the answer stays). */
export function restore(text: string, kept: string[]): string | undefined {
  for (let i = 0; i < kept.length; i++) if (!text.includes(`⟦${i}⟧`)) return undefined;
  return text.replace(/⟦(\d+)⟧/g, (m, n: string) => kept[Number(n)] ?? m);
}

/** The translator's instructions. */
export function translatePrompt(lang: "he" | "ar" | "ru"): string {
  return `Translate the text the user sends into ${NAMES[lang]}. Keep its meaning, its Markdown (headings, lists, bold, tables) and its tone. Leave every marker like ⟦0⟧ exactly as it is, in its place. Leave names of programs, functions, files and commands in their original form. Write only the translation, nothing before or after it.`;
}

/**
 * The answer in the user's language, or undefined to leave it as it is.
 *
 * @param answer - The model's final answer.
 * @param userText - What the user wrote.
 * @param translate - Calls the translation model (system prompt, text) and returns its text.
 */
export async function answerInUserLanguage(answer: string, userText: string, translate: (system: string, text: string) => Promise<string>): Promise<string | undefined> {
  const lang = userLanguage(userText);
  if (!lang || !answer.trim() || !needsTranslation(answer, lang)) return undefined;
  const { text, kept } = protect(answer);
  const out = (await translate(translatePrompt(lang), text)).trim();
  if (!out) return undefined;
  const back = restore(out, kept);
  // A translation that is still not in the language (a weak translator) is not shown.
  return back && !needsTranslation(back, lang) ? back : undefined;
}
