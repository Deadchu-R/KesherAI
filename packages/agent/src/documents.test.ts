import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentText, formatPages, readDocumentTool } from "./documents.js";

/** A minimal two-page PDF with one line of text on each page. */
function tinyPdf(lines: string[]): Buffer {
  const objs: string[] = [];
  const pageIds = lines.map((_, i) => 3 + i * 2);
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${lines.length} >>`;
  const font = 3 + lines.length * 2;
  lines.forEach((line, i) => {
    const content = `BT /F1 18 Tf 50 700 Td (${line}) Tj ET`;
    objs[3 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`;
    objs[4 + i * 2] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  objs[font] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

test("reads a PDF by page and finds pages by words", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-doc-"));
  await writeFile(join(dir, "report.pdf"), tinyPdf(["Revenue grew 12 percent", "Hiring plan for 2027"]));
  const doc = await documentText(tinyPdf(["Revenue grew 12 percent", "Hiring plan for 2027"]), "report.pdf");
  assert.equal(doc.pages.length, 2);
  assert.match(doc.pages[1]!, /Hiring plan/);
  assert.match(formatPages(doc).text, /--- report\.pdf, page 2 ---\nHiring plan/);
  const ctx = { workspace: dir, signal: new AbortController().signal, recordChange: () => undefined };
  const all = await readDocumentTool.run({ path: "report.pdf" }, ctx);
  assert.match(all.output, /2 pages[\s\S]*page 1[\s\S]*Revenue/);
  const found = await readDocumentTool.run({ path: "report.pdf", query: "hiring" }, ctx);
  assert.match(found.output, /1 page\(s\) mention it[\s\S]*page 2/);
  assert.doesNotMatch(found.output, /Revenue/);
});

test("long text comes in parts", async () => {
  const doc = await documentText(Buffer.from(("A sentence about the game. ").repeat(400)), "notes.txt");
  assert.ok(doc.pages.length >= 3);
  const first = formatPages(doc, 1, 99, 4000);
  assert.ok(first.last < doc.pages.length);
});
