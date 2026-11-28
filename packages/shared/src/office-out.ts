/**
 * A small Excel (.xlsx) writer: a sheet's cells as an Excel sheet with its formulas and their values, as the files
 * (path → text) to zip with any zip library. Right-to-left text is set right-to-left. (Word files are written by the
 * server, packages/core/src/docx-io.ts, so the page and the phone give the same .docx.)
 */
import { computeSheet, parseRef, type Sheet } from "./sheet.js";

const xmlSafe = (s: string) => [...s].filter((c) => { const n = c.charCodeAt(0); return n >= 32 || n === 9 || n === 10 || n === 13; }).join("");
const esc = (s: string) => xmlSafe(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rtlText = (s: string) => /[֐-ࣿ]/.test(s);

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
