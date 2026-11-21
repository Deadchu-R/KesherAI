/**
 * Bidirectional text helpers: in a Hebrew sentence, English words, file paths, numbers with units and percentages are
 * left-to-right runs. Left alone, the browser lets the neutral characters around them (spaces, commas, a closing
 * full stop) jump to the wrong side. Wrapping each run in `<bdi dir="ltr">` keeps it in one piece, in its own order.
 */

/** One piece of a text: a plain part, or a left-to-right run to isolate. */
export interface BidiRun { text: string; iso: boolean }

/** True when the text has a Hebrew (or Arabic) letter, so it can be an RTL sentence worth isolating runs in. */
export const hasRtl = (text: string): boolean => /[\u0590-\u05FF\u0600-\u06FF]/.test(text);

// Order matters at one position: a path first (src/app.ts, C:\x\y), then a number (85%, 2.5 GB, 10-20, 12:30, v1.2),
// then a run of English words with the digits and symbols that belong to them (Unreal Engine 5, C++, node_modules).
const RUN = new RegExp(
  [
    String.raw`(?:[A-Za-z]:\\)?(?:\.{1,2}[\\/])?[A-Za-z0-9_.@~-]+(?:[\\/][A-Za-z0-9_.@~-]+)+`,
    String.raw`[$€£]?(?:(?<=^|\s)[+-])?\d[\d,.:]*(?:[-–]\d[\d,.:]*)?(?:\s?(?:%|[A-Za-z]{1,4}\b))?`,
    String.raw`[A-Za-z][A-Za-z0-9_.+#'-]*(?: [A-Za-z0-9][A-Za-z0-9_.+#'-]*)*`,
  ].join("|"),
  "g",
);

/** Punctuation that can end a run but belongs to the sentence (a full stop after "Engine 5."). */
const TRAILING = /[.,;:'+-]+$/;

/**
 * Splits a text into plain parts and left-to-right runs (English words, paths, numbers with units, percentages).
 * Text without a Hebrew letter is returned whole, as one plain part: nothing to isolate there.
 *
 * @param text - The text of one paragraph, list item or cell.
 * @returns The parts in order; joining their `text` gives back the input.
 * @example isolateRuns("הקובץ src/app.ts נשמר ב-85%.") → "הקובץ " | "src/app.ts" | " נשמר ב-" | "85%" | "."
 */
export function isolateRuns(text: string): BidiRun[] {
  if (!text || !hasRtl(text)) return [{ text, iso: false }];
  const out: BidiRun[] = [];
  let last = 0;
  for (const m of text.matchAll(RUN)) {
    let run = m[0];
    // "C++" keeps its plus signs; a sentence's full stop or comma stays outside the run.
    if (!/\+\+$/.test(run)) run = run.replace(TRAILING, "");
    if (!run || !/[A-Za-z0-9]/.test(run)) continue;
    const at = m.index!;
    if (at > last) out.push({ text: text.slice(last, at), iso: false });
    out.push({ text: run, iso: true });
    last = at + run.length;
  }
  if (last < text.length) out.push({ text: text.slice(last), iso: false });
  return out;
}

/**
 * The direction of a Markdown line from its first strong letter, as `dir="auto"` would pick it. It is worked out here
 * because the browser's own "auto" skips an isolated run (`<bdi>`) and elements with a `dir`, so a paragraph that
 * starts with an English word we isolated would be judged by its first Hebrew word instead. Code spans, link
 * addresses and bare URLs do not count.
 *
 * @param raw - The Markdown source of one paragraph, list item, quote or cell.
 * @returns "rtl" or "ltr" for the first strong letter, "auto" when there is none (numbers only).
 */
export function textDir(raw: string): "ltr" | "rtl" | "auto" {
  const plain = raw.replace(/`[^`]*`/g, "").replace(/\]\([^)]*\)/g, "]").replace(/https?:\/\/\S+/g, "");
  const m = /[A-Za-zÀ-ɏ֐-׿؀-ۿ]/.exec(plain);
  if (!m) return "auto";
  return /[֐-׿؀-ۿ]/.test(m[0]) ? "rtl" : "ltr";
}
