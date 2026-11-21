/**
 * A document as a file to keep or send: Markdown, Word (.docx) or PDF. The chat's "document" tool (action "export")
 * and the Docs route use it, so the file the model says it made is a real one.
 *
 * Markdown and Word are made here (a small .docx written with fflate: headings, paragraphs, lists, quotes, code,
 * tables as text, right to left for Hebrew). A PDF needs a page renderer, which only the desktop app has
 * (Electron prints the page); without one `exportDoc` says so and nothing is claimed.
 */
import { strToU8, zipSync } from "fflate";
import type { Conversation } from "@kesher/shared";
import { conversationHtml, exportFileName } from "./chat-export.js";

/** The formats a document can be exported to. */
export type DocFormat = "pdf" | "docx" | "md";

/** Turns a print-ready HTML page into PDF bytes (the desktop app prints it in a hidden window); undefined when it cannot. */
export type PdfRenderer = (html: string, title: string) => Promise<Uint8Array | undefined>;

/** A finished export. */
export interface ExportedDoc {
  data: Uint8Array;
  mimeType: string;
  /** A file name, without characters file systems refuse. */
  fileName: string;
}

const MIME: Record<DocFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  md: "text/markdown",
};

/**
 * Reads a format name the model or a route gave.
 *
 * @param raw - "pdf", "docx", "word", "md", "markdown" in any case.
 * @returns The format, or undefined when it is not one of the three.
 */
export function parseDocFormat(raw: unknown): DocFormat | undefined {
  const f = String(raw ?? "").trim().toLowerCase().replace(/^\./, "");
  if (f === "pdf" || f === "docx" || f === "md") return f;
  if (f === "word" || f === "doc") return "docx";
  if (f === "markdown") return "md";
  return undefined;
}

const escXml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const HEBREW = /[֐-׿]/;

/** One text run of a Word paragraph, with its marks. */
function run(text: string, o: { bold?: boolean; italic?: boolean; mono?: boolean; size?: number; rtl?: boolean }): string {
  const props = `${o.bold ? "<w:b/>" : ""}${o.italic ? "<w:i/>" : ""}${o.mono ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>' : ""}${o.size ? `<w:sz w:val="${o.size}"/>` : ""}${o.rtl ? "<w:rtl/>" : ""}`;
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${escXml(text)}</w:t></w:r>`;
}

/** The runs of a line: **bold**, *italic*, `code` and plain text; links keep their text. */
function runs(line: string, base: { bold?: boolean; italic?: boolean; size?: number }, rtl: boolean): string {
  const text = line.replace(/\[([^\]]+)\]\([^)\s]*\)/g, "$1");
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`|(?<![*\w])\*[^*\s][^*]*\*)/g)
    .filter(Boolean)
    .map((p) => {
      if (p.startsWith("**") && p.endsWith("**") && p.length > 4) return run(p.slice(2, -2), { ...base, bold: true, rtl });
      if (p.startsWith("`") && p.endsWith("`") && p.length > 2) return run(p.slice(1, -1), { ...base, mono: true });
      if (p.startsWith("*") && p.endsWith("*") && p.length > 2) return run(p.slice(1, -1), { ...base, italic: true, rtl });
      return run(p, { ...base, rtl });
    })
    .join("");
}

/**
 * A document's Markdown as the body of a Word file's `document.xml`.
 *
 * @param title - The title (a large first line).
 * @param md - The Markdown.
 * @returns The XML of the paragraphs.
 */
function wordParagraphs(title: string, md: string): string {
  const out: string[] = [];
  const para = (text: string, o: { bold?: boolean; italic?: boolean; size?: number; mono?: boolean; indent?: number } = {}) => {
    const rtl = HEBREW.test(text);
    const body = o.mono ? run(text, { mono: true, size: o.size }) : runs(text, { ...(o.bold ? { bold: true } : {}), ...(o.italic ? { italic: true } : {}), ...(o.size ? { size: o.size } : {}) }, rtl);
    out.push(`<w:p><w:pPr>${rtl ? "<w:bidi/>" : ""}<w:spacing w:after="120"/>${o.indent ? `<w:ind w:start="${o.indent}"/>` : ""}</w:pPr>${body}</w:p>`);
  };
  para(title, { bold: true, size: 40 });
  let inCode = false;
  for (const raw of md.replace(/\r/g, "").split("\n")) {
    if (/^```/.test(raw)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      para(raw || " ", { mono: true, size: 20 });
      continue;
    }
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) para(h[2]!, { bold: true, size: [36, 32, 28, 26, 24, 24][h[1]!.length - 1]! });
    else if (/^\s*[-*+]\s+/.test(line)) para(`• ${line.replace(/^\s*[-*+]\s+/, "")}`, { indent: 360 });
    else if (/^\s*\d+[.)]\s+/.test(line)) para(line.trim(), { indent: 360 });
    else if (/^>\s?/.test(line)) para(line.replace(/^>\s?/, ""), { italic: true, indent: 360 });
    else if (/^\s*\|?\s*:?-{2,}/.test(line) && line.includes("|")) continue;
    else if (line.includes("|") && /^\s*\|/.test(line)) para(line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).join("   |   "));
    else para(line);
  }
  return out.join("");
}

/**
 * A document as a Word file: a small, valid .docx (one part for the text, no styles file).
 *
 * @param title - The title.
 * @param md - The Markdown body.
 * @returns The file's bytes.
 */
export function docToDocx(title: string, md: string): Uint8Array {
  const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  return zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "_rels/.rels": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${ns}><w:body>${wordParagraphs(title, md)}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`),
  });
}

/**
 * A document as the print-ready page the desktop app turns into a PDF (the chat export's page, with the document as
 * its only block).
 *
 * @param title - The title.
 * @param md - The Markdown body.
 * @returns HTML.
 */
export function docToHtml(title: string, md: string): string {
  const now = new Date().toISOString();
  const asChat = { id: "doc", title, createdAt: now, modelId: "", events: [{ seq: 1, at: now, type: "assistant", turn: 1, text: md }] } as unknown as Conversation;
  return conversationHtml(asChat, true).replace(/<div class="who">[^<]*<\/div>/, "").replace(/<div class="meta">[^<]*<\/div>/, "");
}

/**
 * Exports a document.
 *
 * @param doc - Its title and Markdown body.
 * @param format - pdf, docx or md.
 * @param renderPdf - The page renderer for a PDF (the desktop app's); without it a PDF cannot be made here.
 * @returns The file.
 * @throws When the document is empty, or a PDF is asked for and there is no renderer or it fails.
 */
export async function exportDoc(doc: { title: string; body: string }, format: DocFormat, renderPdf?: PdfRenderer): Promise<ExportedDoc> {
  if (!doc.body.trim()) throw new Error("The document is empty: write it first.");
  const fileName = exportFileName({ title: doc.title } as Conversation, format);
  if (format === "md") return { data: strToU8(`# ${doc.title}\n\n${doc.body}\n`), mimeType: MIME.md, fileName };
  if (format === "docx") return { data: docToDocx(doc.title, doc.body), mimeType: MIME.docx, fileName };
  if (!renderPdf) throw new Error("A PDF cannot be made here (only the KesherAI desktop app on the computer can print one). Export it as Word (docx) or Markdown instead, or use the document's PDF button in the Docs page.");
  const data = await renderPdf(docToHtml(doc.title, doc.body), doc.title);
  if (!data?.length) throw new Error("The PDF could not be made. Try Word (docx) or Markdown instead.");
  return { data, mimeType: MIME.pdf, fileName };
}
