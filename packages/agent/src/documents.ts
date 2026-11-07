import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { AgentTool } from "./tools.js";
import { resolveForTool } from "./workspace.js";

/**
 * Reading PDF and Word documents, page by page, so the model can answer
 * from them and say where each answer came from ("report.pdf, p. 4").
 */

/** A document's text, by page (Word documents have one "page" per ~3000 characters). */
export interface DocumentText {
  name: string;
  pages: string[];
  kind: "pdf" | "docx" | "text";
}

/**
 * Extracts the text of a PDF, Word (.docx) or text file.
 *
 * @param data - The file's bytes.
 * @param name - Its name (the extension picks the reader).
 * @returns The text by page.
 */
export async function documentText(data: Uint8Array, name: string): Promise<DocumentText> {
  const ext = extname(name).toLowerCase();
  if (ext === ".pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const { text } = await extractText(pdf, { mergePages: false });
    return { name, kind: "pdf", pages: (text as string[]).map((p) => p.replace(/[ \t]+\n/g, "\n").trim()) };
  }
  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(data) });
    return { name, kind: "docx", pages: chunk(value.replace(/\n{3,}/g, "\n\n").trim(), 3000) };
  }
  return { name, kind: "text", pages: chunk(Buffer.from(data).toString("utf8"), 3000) };
}

function chunk(text: string, size: number): string[] {
  if (!text) return [""];
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    // Cut at a paragraph or sentence end near the size.
    let cut = rest.lastIndexOf("\n\n", size);
    if (cut < size * 0.5) cut = rest.lastIndexOf(". ", size) + 1;
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  out.push(rest.trim());
  return out;
}

/**
 * Formats pages for the model, each marked with its page number.
 *
 * @param doc - The document.
 * @param from - First page (1-based).
 * @param to - Last page.
 * @param budget - Characters at most.
 * @returns The text, and the last page included.
 */
export function formatPages(doc: DocumentText, from = 1, to = doc.pages.length, budget = 40_000): { text: string; last: number } {
  const label = doc.kind === "pdf" ? "page" : "part";
  const parts: string[] = [];
  let used = 0;
  let last = from - 1;
  for (let i = Math.max(1, from); i <= Math.min(to, doc.pages.length); i++) {
    const body = doc.pages[i - 1] ?? "";
    const block = `--- ${doc.name}, ${label} ${i} ---\n${body || "(no text on this page — it may be a picture)"}`;
    if (used + block.length > budget && parts.length) break;
    parts.push(block);
    used += block.length;
    last = i;
  }
  return { text: parts.join("\n\n"), last };
}

/** `read_document`: a PDF or Word file, by page, for answering with sources. */
export const readDocumentTool: AgentTool = {
  risk: "read",
  spec: {
    name: "read_document",
    description:
      "Read a PDF or Word (.docx) document by page. Answer from it and cite where each fact came from, like (report.pdf, p. 4). Long documents come in parts: pass `from_page` to read on, or `query` to get only the pages that mention some words.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The document (in the project or a folder the user gave)." },
        from_page: { type: "number" },
        to_page: { type: "number" },
        query: { type: "string", description: "Only pages containing these words." },
      },
      required: ["path"],
    },
  },
  async run(input, ctx) {
    const path = await resolveForTool(ctx.workspace, ctx.extraRoots ?? [], String(input.path ?? ""));
    const st = await stat(path);
    if (st.size > 200 * 1024 * 1024) throw new Error("The document is too big (over 200 MB).");
    const doc = await documentText(await readFile(path), basename(path));
    const total = doc.pages.length;
    const query = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
    if (query) {
      const words = query.split(/\s+/).filter(Boolean);
      const hits = doc.pages.map((p, i) => ({ i: i + 1, p })).filter(({ p }) => words.every((w) => p.toLowerCase().includes(w)));
      if (!hits.length) return { output: `"${query}" is not in ${doc.name} (${total} ${doc.kind === "pdf" ? "pages" : "parts"}).` };
      const picked: DocumentText = { ...doc, pages: doc.pages };
      const text = hits
        .slice(0, 15)
        .map(({ i }) => formatPages(picked, i, i, 8000).text)
        .join("\n\n");
      return { output: `${doc.name}: ${hits.length} page(s) mention it${hits.length > 15 ? " (first 15 shown)" : ""}.\n\n${text}` };
    }
    const from = Math.max(1, Number(input.from_page) || 1);
    const to = Math.min(total, Number(input.to_page) || total);
    const { text, last } = formatPages(doc, from, to);
    const more = last < to ? `\n\n(Read up to ${doc.kind === "pdf" ? "page" : "part"} ${last} of ${total}. Call again with from_page: ${last + 1} to read on.)` : "";
    return { output: `${doc.name}: ${total} ${doc.kind === "pdf" ? "pages" : "parts"}.\n\n${text}${more}` };
  },
};
