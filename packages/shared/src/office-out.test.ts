import { test } from "node:test";
import assert from "node:assert/strict";
import { docxFiles, xlsxFiles } from "./office-out.js";

test("Word: headings, lists, tables and escaped text; Excel: formulas with values, right to left", () => {
  const d = docxFiles("חוסמי בטא", "## מנגנון\n\nחוסמים **β1** & <x>\u0001\n\n| א | ב |\n|---|---|\n| 1 | 2 |");
  const xml = d["word/document.xml"]!;
  assert.match(xml, /<w:pStyle w:val="Heading2"\/>/);
  assert.match(xml, /<w:b\/><w:bCs\/><w:rtl\/><\/w:rPr><w:t xml:space="preserve">β1/);
  assert.match(xml, /&amp; &lt;x&gt;<\/w:t>/);
  assert.doesNotMatch(xml, /\u0001/);
  assert.match(xml, /<w:tblGrid><w:gridCol w:w="2400"\/><w:gridCol w:w="2400"\/><\/w:tblGrid>/);
  const x = xlsxFiles({ title: "a/b:c", cells: { A1: "שם", B1: "5", C1: "=B1*2", D1: '="<"&A1' } })["xl/worksheets/sheet1.xml"]!;
  assert.match(x, /rightToLeft="1"/);
  assert.match(x, /<c r="B1"><v>5<\/v><\/c><c r="C1"><f>B1\*2<\/f><v>10<\/v><\/c>/);
  assert.match(x, /<c r="D1" t="str"><f>&quot;&lt;&quot;&amp;A1<\/f><v>&lt;שם<\/v><\/c>/);
  assert.match(xlsxFiles({ title: "a/b:c", cells: {} })["xl/workbook.xml"]!, /name="abc"/);
});
