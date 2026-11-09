/**
 * Copilot-style suggestions in the code editor: the model gets the code
 * around the cursor and answers with what comes next (a line or a short
 * block), shown greyed out; Tab inserts it. Any chat model works; a small
 * fast coder model (e.g. Qwen2.5-Coder 1.5B–7B) keeps it quick.
 */

/** What the model is asked: the code before and after the cursor, the answer is only the missing part. */
export function inlinePrompt(o: { language: string; path: string; prefix: string; suffix: string }): string {
  return [
    `Complete the code at <CURSOR> in ${o.path || "this file"} (${o.language}).`,
    "Answer with ONLY the text to insert at <CURSOR>: no explanations, no code fences, no repeating the code before it. Usually the rest of the line, or a few lines when a block clearly starts. Answer with nothing if nothing fits.",
    "",
    `${o.prefix}<CURSOR>${o.suffix}`,
  ].join("\n");
}

/** The model's answer made safe to insert: fences, thinking and repeated text before the cursor removed, at most 12 lines. */
export function cleanInline(answer: string, prefix: string, suffix: string): string {
  let t = answer.replace(/<think>[\s\S]*?<\/think>/g, "");
  const fence = /```[\w+#-]*[^\S\n]*\n([\s\S]*?)(?:```|$)/.exec(t);
  if (fence) t = fence[1]!;
  t = t.replace(/<CURSOR>/g, "").replace(/^\n+/, "").replace(/\s+$/, "");
  // A model that writes the current line again from its start: keep only what follows the cursor.
  const line = prefix.slice(prefix.lastIndexOf("\n") + 1);
  if (line.trim() && t.startsWith(line.trimStart())) t = t.slice(line.trimStart().length);
  else if (line.trim() && t.startsWith(line)) t = t.slice(line.length);
  // Nothing that only repeats what is already after the cursor.
  const next = suffix.trimStart().split("\n")[0]!.trim();
  if (next && t.trim() === next) return "";
  return t.split("\n").slice(0, 12).join("\n");
}
