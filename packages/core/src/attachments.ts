/**
 * Files attached to a message ("[Attached: path]", from the + menu, the phone, or the Noctalia panel), read before
 * the model answers, the way Claude and ChatGPT take an attachment: a picture goes to the model as a picture, a PDF or
 * Word or text file as its text. Before, the model got only the path and had to think of view_image or
 * read_document itself; a local model often did not (Roee's brother: "it does not know what is in the picture, or the
 * PDF").
 *
 * Only files inside the chat's own folder or the folders opened to it are read.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { documentText, formatPages } from "@kesher/agent";

const LINE = /\[(?:Attached|קובץ מצורף|מצורף)\s*:\s*([^\]\n]+)\]/gi;
const PICTURES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const DOCUMENTS = new Set([".pdf", ".docx", ".txt", ".md", ".csv", ".json", ".log", ".xml", ".html", ".htm", ".yaml", ".yml", ".ini", ".cfg", ".toml"]);
const MAX_PICTURES = 4;
const MAX_PICTURE_BYTES = 8 * 1024 * 1024;
const DOC_BUDGET = 24_000;

/** What the model gets with the message. */
export interface ReadAttachments {
  images: Array<{ mimeType: string; data: string }>;
  /** The documents' text, for the model only (the user's bubble keeps the attachment line). */
  context?: string;
}

const inside = (root: string, path: string) => {
  const r = relative(root, path);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

/**
 * Reads the files a message attaches.
 *
 * @param text - The message as the user wrote it.
 * @param roots - The chat's folder first (relative paths start there), then the folders opened to it.
 */
export async function readAttachments(text: string, roots: string[]): Promise<ReadAttachments> {
  const out: ReadAttachments = { images: [] };
  const parts: string[] = [];
  let budget = DOC_BUDGET;
  const seen = new Set<string>();
  for (const m of text.matchAll(LINE)) {
    const given = m[1]!.trim();
    const path = isAbsolute(given) ? resolve(given) : roots[0] ? resolve(roots[0], given) : "";
    if (!path || seen.has(path)) continue;
    seen.add(path);
    // The real places (a link inside the chat's folder must not lead outside it).
    const real = await realpath(path).catch(() => "");
    const realRoots = await Promise.all(roots.map((r) => realpath(r).catch(() => r)));
    if (!real || !realRoots.some((r) => inside(r, real))) continue;
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) continue;
    const ext = extname(path).toLowerCase();
    const name = basename(path);
    if (PICTURES[ext]) {
      if (out.images.length >= MAX_PICTURES || info.size > MAX_PICTURE_BYTES) {
        parts.push(`(${name}: a picture not shown to you here; look at it with view_image.)`);
        continue;
      }
      out.images.push({ mimeType: PICTURES[ext]!, data: (await readFile(path)).toString("base64") });
      parts.push(`(${name}: the picture is attached to this message; look at it.)`);
    } else if (DOCUMENTS.has(ext)) {
      if (info.size > 50 * 1024 * 1024 || budget < 500) {
        parts.push(`(${name}: read it with read_document.)`);
        continue;
      }
      try {
        const doc = await documentText(await readFile(path), name);
        const words = doc.pages.join("").trim();
        if (!words) {
          parts.push(`(${name}: a ${doc.kind === "pdf" ? "PDF with no text in it (a scan or pictures)" : "file with no text"}. Say so: its text cannot be read here.)`);
          continue;
        }
        const { text: body, last } = formatPages(doc, 1, doc.pages.length, budget);
        budget -= body.length;
        const unit = doc.kind === "pdf" ? "page" : "part";
        parts.push(`The attached file ${name} (${doc.pages.length} ${unit}${doc.pages.length === 1 ? "" : "s"}):\n${body}${last < doc.pages.length ? `\n(Shown up to ${unit} ${last}; read the rest with read_document, from_page ${last + 1}.)` : ""}`);
      } catch (err) {
        parts.push(`(${name}: could not be read: ${(err as Error).message}.)`);
      }
    }
  }
  if (parts.length) out.context = parts.join("\n\n");
  return out;
}
