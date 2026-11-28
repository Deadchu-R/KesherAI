/**
 * Fidelity of the Word round trip (import with mammoth, export with docx): ten generated .docx files go through
 * import -> export -> import, and what the export no longer has is counted per feature and printed (the summary in
 * docs/RESEARCH_LOG.md comes from this). The test fails when a feature KesherAI promises is lost, or when a second
 * trip changes the Markdown; features Markdown cannot carry (colour, underline, page breaks, headers) are only reported.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync, crc32 } from "node:zlib";
import { strFromU8, unzipSync } from "fflate";
import { DocStore } from "./docs.js";
import { exportDocx, importDocx, type DocxDeps } from "./docx-service.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A 3x2 red PNG. */
function png(): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(3, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from([255, 0, 0, 255, 0, 0, 255, 0, 0])]);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat([row, row]))), chunk("IEND", Buffer.alloc(0))]));
}

type D = typeof import("docx");
type Child = import("docx").Paragraph | import("docx").Table;
const FIXTURES: Record<string, (D: D) => Child[]> = {
  headings: (D) => [
    new D.Paragraph({ heading: D.HeadingLevel.HEADING_1, children: [new D.TextRun("One")] }),
    new D.Paragraph({ children: [new D.TextRun("text under one")] }),
    new D.Paragraph({ heading: D.HeadingLevel.HEADING_2, children: [new D.TextRun("Two")] }),
    new D.Paragraph({ heading: D.HeadingLevel.HEADING_3, children: [new D.TextRun("Three")] }),
  ],
  "bullets-nested": (D) => [0, 1, 2, 1, 0].map((level, i) => new D.Paragraph({ bullet: { level }, children: [new D.TextRun(`item ${i}`)] })),
  "numbered": (D) => [0, 1, 2].map((i) => new D.Paragraph({ numbering: { reference: "n", level: 0 }, children: [new D.TextRun(`step ${i}`)] })),
  table: (D) => {
    const cell = (t: string, bold = false) => new D.TableCell({ children: [new D.Paragraph({ children: [new D.TextRun({ text: t, bold })] })] });
    return [new D.Table({ rows: [new D.TableRow({ children: [cell("A", true), cell("B", true), cell("C", true)] }), new D.TableRow({ children: [cell("1"), cell("2"), cell("3")] }), new D.TableRow({ children: [cell("x"), cell("y"), cell("z")] })] })];
  },
  "marks": (D) => [new D.Paragraph({ children: [new D.TextRun({ text: "bold", bold: true }), new D.TextRun(" "), new D.TextRun({ text: "italic", italics: true }), new D.TextRun(" "), new D.TextRun({ text: "both", bold: true, italics: true }), new D.TextRun(" "), new D.TextRun({ text: "struck", strike: true }), new D.TextRun(" "), new D.TextRun({ text: "underlined", underline: {} }), new D.TextRun(" "), new D.TextRun({ text: "red", color: "FF0000" })] })],
  "hebrew-rtl": (D) => [
    new D.Paragraph({ heading: D.HeadingLevel.HEADING_1, bidirectional: true, children: [new D.TextRun({ text: "כותרת ראשית", rightToLeft: true })] }),
    new D.Paragraph({ bidirectional: true, children: [new D.TextRun({ text: "פסקה בעברית עם ", rightToLeft: true }), new D.TextRun({ text: "מודגש", bold: true, rightToLeft: true }), new D.TextRun({ text: " ו-English באמצע", rightToLeft: true })] }),
    new D.Paragraph({ bullet: { level: 0 }, bidirectional: true, children: [new D.TextRun({ text: "פריט ראשון", rightToLeft: true })] }),
  ],
  "hebrew-table": (D) => {
    const cell = (t: string) => new D.TableCell({ children: [new D.Paragraph({ bidirectional: true, children: [new D.TextRun({ text: t, rightToLeft: true })] })] });
    return [new D.Table({ visuallyRightToLeft: true, rows: [new D.TableRow({ children: [cell("שם"), cell("כמות")] }), new D.TableRow({ children: [cell("תפוח"), cell("3")] })] })];
  },
  image: (D) => [new D.Paragraph({ children: [new D.TextRun("Before"), new D.ImageRun({ type: "png", data: png(), transformation: { width: 30, height: 20 }, altText: { name: "red", description: "red", title: "red" } }), new D.TextRun("After")] })],
  links: (D) => [new D.Paragraph({ children: [new D.ExternalHyperlink({ link: "https://example.com/a?b=1&c=2", children: [new D.TextRun({ text: "site", style: "Hyperlink" })] }), new D.TextRun(" and "), new D.ExternalHyperlink({ link: "https://example.org", children: [new D.TextRun("second")] })] })],
  "layout-extras": (D) => [
    new D.Paragraph({ alignment: D.AlignmentType.CENTER, children: [new D.TextRun({ text: "centered", size: 40, font: "Arial" })] }),
    new D.Paragraph({ children: [new D.TextRun("line one"), new D.TextRun({ text: "line two", break: 1 }), new D.PageBreak()] }),
    new D.Paragraph({ children: [new D.TextRun("after the page break")] }),
  ],
};

/** The features counted in a document.xml, to compare before and after. */
const FEATURES: Record<string, RegExp> = {
  headings: /<w:pStyle w:val="Heading\d"/g,
  "list items": /<w:numPr>/g,
  tables: /<w:tbl>/g,
  "table cells": /<w:tc>/g,
  bold: /<w:b(?: w:val="(?:1|true)")?\/>/g,
  italic: /<w:i(?: w:val="(?:1|true)")?\/>/g,
  strike: /<w:strike/g,
  underline: /<w:u /g,
  colour: /<w:color /g,
  "right-to-left paragraphs": /<w:bidi\b/g,
  pictures: /<w:drawing>/g,
  links: /<w:hyperlink /g,
  "page breaks": /<w:br w:type="page"/g,
  "line breaks": /<w:br\/>/g,
  centered: /<w:jc w:val="center"/g,
};
/** Features Markdown cannot carry: reported when lost, never a failure. */
const BEYOND_MARKDOWN = new Set(["underline", "colour", "page breaks", "centered"]);
const count = (xml: string, re: RegExp) => (xml.match(re) ?? []).length;

async function deps(): Promise<DocxDeps> {
  const dir = await mkdtemp(join(tmpdir(), "docx-fid-"));
  const files = new Map<string, { data: Buffer; mimeType: string }>();
  let n = 0;
  return {
    docs: new DocStore(join(dir, "docs")),
    roots: async () => [dir],
    assets: {
      async save(data: Uint8Array, mimeType: string) {
        const id = `00000000-0000-0000-0000-${String(++n).padStart(12, "0")}`;
        files.set(id, { data: Buffer.from(data), mimeType });
        return { id, kind: "image", mimeType, createdAt: "" } as never;
      },
      async get(id: string) {
        const f = files.get(id);
        return f ? { asset: { id, mimeType: f.mimeType } as never, data: f.data } : undefined;
      },
    },
  };
}

test("round trip of ten generated Word files: nothing KesherAI promises is lost, and a second trip changes nothing", async () => {
  const D = await import("docx");
  const d = await deps();
  const lost: string[] = [];
  const report: string[] = [];
  for (const [name, build] of Object.entries(FIXTURES)) {
    const doc = new D.Document({ numbering: { config: [{ reference: "n", levels: [{ level: 0, format: D.LevelFormat.DECIMAL, text: "%1.", alignment: D.AlignmentType.START }] }] }, sections: [{ children: build(D) }] });
    const orig = new Uint8Array(await D.Packer.toBuffer(doc));
    const a = await importDocx(d, { name: `${name}.docx`, data: orig });
    const out = await exportDocx(d, a);
    const b = await importDocx(d, { name: `${name}.docx`, data: out });
    // Every import saves its pictures again as new assets: only their ids differ.
    const same = (x: string) => x.replace(/\/api\/assets\/[0-9a-f-]{36}/g, "/api/assets/ID");
    assert.equal(same(b.body), same(a.body), `${name}: a second trip changes the Markdown`);
    const before = strFromU8(unzipSync(orig)["word/document.xml"]!);
    const after = strFromU8(unzipSync(out)["word/document.xml"]!);
    for (const [feature, re] of Object.entries(FEATURES)) {
      const x = count(before, re);
      const y = count(after, re);
      if (x === y) continue;
      report.push(`${name}: ${feature} ${x} -> ${y}`);
      // A list item may gain or lose nothing; more of a feature than before is only noise (Word styles), less is a loss.
      if (y < x && !BEYOND_MARKDOWN.has(feature)) lost.push(`${name}: ${feature} ${x} -> ${y}`);
    }
  }
  if (report.length) console.log(`Word round trip, what differs:\n${report.join("\n")}`);
  assert.deepEqual(lost, []);
});
