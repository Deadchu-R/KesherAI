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
