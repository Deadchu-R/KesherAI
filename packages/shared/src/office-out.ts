/**
 * Small Word (.docx) and Excel (.xlsx) writers (canvas documents, others as options): a document's Markdown as Word
 * headings, paragraphs, lists and tables; a sheet's cells as an Excel sheet with its formulas and their values. Each
 * returns the files (path → text) to zip with any zip library. Right-to-left text is set right-to-left.
 */
import { computeSheet, parseRef, type Sheet } from "./sheet.js";

const xmlSafe = (s: string) => [...s].filter((c) => { const n = c.charCodeAt(0); return n >= 32 || n === 9 || n === 10 || n === 13; }).join("");
const esc = (s: string) => xmlSafe(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rtlText = (s: string) => /[֐-ࣿ]/.test(s);

/** Inline Markdown (**bold**, *italic*, `code`) as Word runs. */
function runs(text: string, rtl: boolean): string {
  const out: string[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  const run = (t: string, p: string) => t && out.push(`<w:r><w:rPr>${p}${rtl ? "<w:rtl/>" : ""}</w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`);
  for (const m of text.matchAll(re)) {
    run(text.slice(last, m.index), "");
    const s = m[0];
    if (s.startsWith("**")) run(s.slice(2, -2), "<w:b/><w:bCs/>");
    else if (s.startsWith("`")) run(s.slice(1, -1), '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>');
    else run(s.slice(1, -1), "<w:i/><w:iCs/>");
    last = (m.index ?? 0) + s.length;
  }
  run(text.slice(last), "");
  return out.join("");
}

const para = (text: string, style?: string, extra = "") => {
  const rtl = rtlText(text);
  return `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${extra}${rtl ? "<w:bidi/>" : ""}</w:pPr>${runs(text, rtl)}</w:p>`;
};

/**
 * The files of a .docx made from Markdown: # headings (1–3), paragraphs, - and 1. lists (as plain bullets and numbers),
 * > quotes, ``` code, and | tables.
 *
 * @param title - The document's title (its first heading).
 * @param md - The Markdown.
 */
export function docxFiles(title: string, md: string): Record<string, string> {
  const body: string[] = [para(title, "Title")];
  const lines = md.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^```/.test(l)) {
      const code: string[] = [];
      while (++i < lines.length && !/^```/.test(lines[i]!)) code.push(lines[i]!);
      for (const c of code) body.push(`<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr><w:r><w:t xml:space="preserve">${esc(c)}</w:t></w:r></w:p>`);
      continue;
    }
    if (/^\|.*\|\s*$/.test(l)) {
      const rows: string[][] = [];
      for (; i < lines.length && /^\|.*\|\s*$/.test(lines[i]!); i++) if (!/^\|[\s:|-]+\|\s*$/.test(lines[i]!)) rows.push(lines[i]!.trim().slice(1, -1).split("|").map((c) => c.trim()));
      i--;
      const rtl = rows.some((r) => r.some(rtlText));
      body.push(`<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>${rtl ? "<w:bidiVisual/>" : ""}<w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map((b) => `<w:${b} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`).join("")}</w:tblBorders></w:tblPr><w:tblGrid>${Array.from({ length: Math.max(...rows.map((r) => r.length)) }, () => '<w:gridCol w:w="2400"/>').join("")}</w:tblGrid>${rows.map((r, k) => `<w:tr>${r.map((c) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${para(k === 0 ? `**${c}**` : c)}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`);
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(l);
    if (h) body.push(para(h[2]!, `Heading${h[1]!.length}`));
    else if (/^\s*[-*•]\s+/.test(l)) body.push(para(`• ${l.replace(/^\s*[-*•]\s+/, "")}`, undefined, '<w:ind w:start="360"/>'));
    else if (/^\s*\d+[.)]\s+/.test(l)) body.push(para(l.trim(), undefined, '<w:ind w:start="360"/>'));
    else if (/^>\s?/.test(l)) body.push(para(l.replace(/^>\s?/, ""), "Quote"));
    else if (l.trim()) body.push(para(l));
  }
  const style = (id: string, name: string, rpr: string, ppr = "") => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr>${ppr}</w:pPr><w:rPr>${rpr}</w:rPr></w:style>`;
  return {
    "[Content_Types].xml": `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
    "_rels/.rels": `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/_rels/document.xml.rels": `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    "word/styles.xml": `${HEAD}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${style("Title", "Title", '<w:b/><w:bCs/><w:sz w:val="44"/><w:szCs w:val="44"/>')}${style("Heading1", "heading 1", '<w:b/><w:bCs/><w:color w:val="1F3B8F"/><w:sz w:val="34"/><w:szCs w:val="34"/>', '<w:spacing w:before="240"/>')}${style("Heading2", "heading 2", '<w:b/><w:bCs/><w:color w:val="1F3B8F"/><w:sz w:val="28"/><w:szCs w:val="28"/>', '<w:spacing w:before="200"/>')}${style("Heading3", "heading 3", '<w:b/><w:bCs/><w:sz w:val="26"/><w:szCs w:val="26"/>')}${style("Quote", "Quote", '<w:i/><w:iCs/><w:color w:val="555555"/>', '<w:ind w:start="360"/>')}${style("Code", "Code", '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/>', '<w:spacing w:after="0"/>')}<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style></w:styles>`,
    "word/document.xml": `${HEAD}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  };
}

/**
 * The files of an .xlsx with one sheet: numbers as numbers, text as text, formulas with their computed values (Excel
 * recomputes them). Right-to-left when the sheet's text is Hebrew.
 *
 * @param s - The sheet.
 */
export function xlsxFiles(s: Pick<Sheet, "title" | "cells">): Record<string, string> {
  const vals = computeSheet(s.cells);
  const byRow = new Map<number, Array<{ c: number; a: string }>>();
  for (const a of Object.keys(s.cells)) {
    const p = parseRef(a);
    if (p) (byRow.get(p.r) ?? byRow.set(p.r, []).get(p.r)!).push({ c: p.c, a });
  }
  const cell = (a: string) => {
    const raw = s.cells[a]!;
    const v = vals[a];
    if (raw.startsWith("=")) {
      const f = `<f>${esc(raw.slice(1))}</f>`;
      if (typeof v === "number") return `<c r="${a}">${f}<v>${v}</v></c>`;
      if (typeof v === "boolean") return `<c r="${a}" t="b">${f}<v>${v ? 1 : 0}</v></c>`;
      return `<c r="${a}" t="str">${f}<v>${esc(String(v ?? ""))}</v></c>`;
    }
    return typeof v === "number" ? `<c r="${a}"><v>${v}</v></c>` : `<c r="${a}" t="inlineStr"><is><t xml:space="preserve">${esc(raw)}</t></is></c>`;
  };
  const rows = [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([r, cs]) => `<row r="${r + 1}">${cs.sort((a, b) => a.c - b.c).map((x) => cell(x.a)).join("")}</row>`).join("");
  const rtl = Object.values(s.cells).some(rtlText);
  const name = esc(s.title.replace(/[\\/?*[\]:]/g, "").slice(0, 31) || "Sheet1");
  return {
    "[Content_Types].xml": `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    "_rels/.rels": `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/_rels/workbook.xml.rels": `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/workbook.xml": `${HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets><calcPr fullCalcOnLoad="1"/></workbook>`,
    "xl/worksheets/sheet1.xml": `${HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"${rtl ? ' rightToLeft="1"' : ""}/></sheetViews><sheetData>${rows}</sheetData></worksheet>`,
  };
}
