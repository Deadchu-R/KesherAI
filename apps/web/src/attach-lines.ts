/** The attachment lines a message carries ("[Attached: path]", in English or Hebrew), apart from its words. */
const LINE = /\[(?:Attached|קובץ מצורף|מצורף)\s*:\s*([^\]\n]+)\]/g;

/**
 * Splits a message into what the user wrote and the files they attached.
 *
 * @param text - The message.
 * @returns The words (attachment lines removed) and the paths, in order, without repeats.
 */
export function splitAttachments(text: string): { body: string; files: string[] } {
  const files: string[] = [];
  for (const m of text.matchAll(LINE)) {
    const p = m[1]!.trim();
    if (p && !files.includes(p)) files.push(p);
  }
  return { body: text.replace(LINE, "").replace(/\n{3,}/g, "\n\n").trim(), files };
}

/** Which line icon stands for a file (by its extension). */
export function fileIcon(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
  if (/^(png|jpe?g|webp|gif|bmp)$/.test(ext)) return "image";
  if (/^(xlsx|csv|tsv)$/.test(ext)) return "grid";
  if (ext === "pptx") return "monitor";
  if (/^(html?)$/.test(ext)) return "globe";
  if (/^(pdf|docx|txt|md)$/.test(ext)) return "page";
  return "paperclip";
}

/**
 * Office files, tables and PDFs an answer names (say "Saved it as `out/sales.xlsx`"), for chips under it that open a
 * preview: files a command made (a Python script, say) are not on the run's receipt. Web addresses are left out; a name
 * of a file that is not in the chat's folder shows "not found" in its preview.
 *
 * @param text - The answer.
 * @returns Up to six paths, each once.
 */
export function namedDocuments(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s`'"([*])((?:[\w.-]+[\\/])*[\w.-]+\.(?:xlsx|docx|pptx|pdf|csv|tsv|glb))(?=$|[\s`'")\],.:;*!?])/gim)) {
    const path = m[1]!;
    const at = m.index ?? 0;
    if (/[a-z]+:\/\/\S*$/i.test(text.slice(Math.max(0, at - 200), at + 1))) continue;
    found.add(path.replace(/\\/g, "/"));
    if (found.size === 6) break;
  }
  return [...found];
}
