/**
 * A fixed set of short questions with known answers, run after the speed test (audit F11, like PocketPal's and
 * Locally Uncensored's benchmarks): "8 of 10 right, 66 tokens a second" next to a model says more than speed alone.
 * The answers are checked by pattern, so a model that adds a word or a full stop still counts as right.
 */

/** One question and what a right answer contains. */
export interface BenchQuestion {
  q: string;
  /** Matches a right answer (case-insensitive). */
  a: RegExp;
}

/** The ten questions: arithmetic, facts, text, code, time and one in Hebrew. */
export const BENCH_SET: BenchQuestion[] = [
  { q: "What is 17 * 23?", a: /\b391\b/ },
  { q: "What is the capital city of Australia?", a: /canberra/i },
  { q: 'Write the word "kesher" backwards.', a: /\brehsek\b/i },
  { q: "How many days are in a leap year?", a: /\b366\b/ },
  { q: "What is the smallest prime number greater than 89?", a: /\b97\b/ },
  { q: "What is the chemical symbol for gold?", a: /\bau\b/i },
  { q: "A train leaves at 14:40 and the trip takes 95 minutes. At what time does it arrive (HH:MM)?", a: /\b16:15\b/ },
  { q: "In Python, what is len([1, [2, 3], 4])?", a: /\b3\b/ },
  { q: 'Sort the letters of "dcab" alphabetically.', a: /\babcd\b/i },
  { q: "מה עיר הבירה של צרפת?", a: /פריז|paris/i },
];

/** The instruction sent with every question. */
export const BENCH_SYSTEM = "Answer with only the answer: no explanation, no reasoning, one short line.";

/**
 * Whether an answer is right: thinking (`<think>…</think>`) is dropped first.
 *
 * @param answer - What the model wrote.
 * @param q - The question.
 * @returns True when the answer holds the right one.
 */
export function benchRight(answer: string, q: BenchQuestion): boolean {
  const text = answer.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/i, "").trim();
  return q.a.test(text);
}
