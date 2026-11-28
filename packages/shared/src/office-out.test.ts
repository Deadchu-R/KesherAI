import { test } from "node:test";
import assert from "node:assert/strict";
import { xlsxFiles } from "./office-out.js";

test("Excel: formulas with values, right to left", () => {
  const x = xlsxFiles({ title: "a/b:c", cells: { A1: "שם", B1: "5", C1: "=B1*2", D1: '="<"&A1' } })["xl/worksheets/sheet1.xml"]!;
  assert.match(x, /rightToLeft="1"/);
  assert.match(x, /<c r="B1"><v>5<\/v><\/c><c r="C1"><f>B1\*2<\/f><v>10<\/v><\/c>/);
  assert.match(x, /<c r="D1" t="str"><f>&quot;&lt;&quot;&amp;A1<\/f><v>&lt;שם<\/v><\/c>/);
  assert.match(xlsxFiles({ title: "a/b:c", cells: {} })["xl/workbook.xml"]!, /name="abc"/);
});
