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

/**
 * Which line icon stands for an attachment, by its extension: a picture, table, slides, page, recording, video,
 * archive, code or book; a name with no extension is an attached folder.
 *
 * @param path - The attachment's path.
 * @returns A glyph name (ui/glyphs.ts).
 */
export function fileIcon(path: string): string {
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? "";
  if (/^(makefile|dockerfile)$/i.test(name)) return "code";
  if (!/\.[a-z0-9]+$/i.test(name)) return "folder";
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  if (/^(mp3|wav|m4a|ogg|flac|aac|opus|wma|amr)$/.test(ext)) return "speaker";
  if (/^(mp4|webm|mov|m4v|mkv|avi|3gp)$/.test(ext)) return "play";
  if (/^(zip|7z|rar|tar|gz|tgz|bz2|xz)$/.test(ext)) return "box";
  if (ext === "epub") return "book";
  if (/^(ts|tsx|js|jsx|mjs|py|cs|cpp|cc|c|h|hpp|java|kt|go|rs|rb|php|swift|gd|lua|sh|ps1|sql|css|scss|vue|svelte|hlsl|glsl|shader|json|ya?ml|toml|xml)$/.test(ext)) return "code";
  if (/^(png|jpe?g|webp|gif|bmp)$/.test(ext)) return "image";
  if (/^(xlsx|xls|ods|csv|tsv)$/.test(ext)) return "grid";
  if (ext === "pptx" || ext === "odp") return "monitor";
  if (/^(html?)$/.test(ext)) return "globe";
  if (/^(pdf|docx|odt|rtf|txt|md)$/.test(ext)) return "page";
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

/** Folders a folder upload leaves out (dependencies, builds, engine caches), as the computer's outline does. */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "out", ".next", ".venv", "venv", "__pycache__", ".cache", "target", "Library", "Temp", "Binaries", "Intermediate", "DerivedDataCache", "Saved"]);

/**
 * Which files of a folder picked on this device are sent to the computer: dependency and build folders, hidden
 * folders and empty files are left out, and the rest stops at a count and a total size (a phone upload must stay
 * quick). Files are taken in the order given.
 *
 * @param files - Each file's path inside the picked folder ("Game/src/main.ts", as `webkitRelativePath`) and size.
 * @param o.maxFiles - The most files (default 400).
 * @param o.maxBytes - The most bytes in all (default 150 MB).
 * @returns The indexes to send, and how many were left out for the limits.
 */
export function folderUploadPlan(files: Array<{ path: string; size: number }>, o: { maxFiles?: number; maxBytes?: number } = {}): { take: number[]; overLimit: number } {
  const maxFiles = o.maxFiles ?? 400;
  const maxBytes = o.maxBytes ?? 150 * 1024 * 1024;
  const take: number[] = [];
  let bytes = 0;
  let overLimit = 0;
  files.forEach((f, i) => {
    const dirs = f.path.split("/").slice(0, -1);
    if (!f.size || dirs.some((d) => SKIP_DIRS.has(d) || (d.startsWith(".") && d.length > 1))) return;
    if (take.length >= maxFiles || bytes + f.size > maxBytes) {
      overLimit++;
      return;
    }
    bytes += f.size;
    take.push(i);
  });
  return { take, overLimit };
}
