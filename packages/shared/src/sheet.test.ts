import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanCells, colIndex, colName, computeSheet, csvCells, markdownTableCsv, parseFormula, parseRef, sheetCsv, showValue } from "./sheet.js";

test("addresses", () => {
  assert.equal(colName(0), "A");
  assert.equal(colName(27), "AB");
  assert.equal(colIndex("AB"), 27);
  assert.deepEqual(parseRef("$b$3"), { c: 1, r: 2 });
  assert.equal(parseRef("ZZ9"), undefined);
  assert.equal(parseRef("A0"), undefined);
});

test("formulas compute, by our own parser", () => {
  const v = computeSheet({ A1: "5", A2: "4", A3: "3", B1: "88", B2: "91", B3: "78", C1: "=A1*B1", D1: "=SUM(A1:A3)", D2: "=ROUND(SUMPRODUCT, 1)", D3: "=ROUND((A1*B1+A2*B2+A3*B3)/D1, 2)", E1: '=IF(D3>=85, "טוב", "לשפר")', E2: "=2^3^2", E3: "=-A1+10%", F1: '="a"&A1', F2: "=AVERAGE(B1:B3)", F3: "=MAX(B1:B3)-MIN(B1:B3)" });
  assert.equal(v.C1, 440);
  assert.equal(v.D1, 12);
  assert.equal(v.D2, "#ERR");
  assert.equal(v.D3, 86.5);
  assert.equal(v.E1, "טוב");
  assert.equal(v.E2, 512);
  assert.equal(v.E3, -4.9);
  assert.equal(v.F1, "a5");
  assert.equal(showValue(v.F2), "85.6666666667");
  assert.equal(v.F3, 13);
});

test("errors: division by zero, cycles, bad text, and nothing runs as code", () => {
  const v = computeSheet({ A1: "=1/0", B1: "=C1+1", C1: "=B1", D1: "=A1+1", E1: '=constructor("return 1")()', F1: "=alert(1)", G1: '="x"*2', H1: "=SUM(" });
  assert.equal(v.A1, "#DIV/0");
  assert.equal(v.B1, "#CYCLE");
  assert.equal(v.C1, "#CYCLE");
  assert.equal(v.D1, "#DIV/0");
  assert.equal(v.E1, "#ERR");
  assert.equal(v.F1, "#ERR");
  assert.equal(v.G1, "#VALUE");
  assert.equal(v.H1, "#ERR");
  assert.throws(() => parseFormula("A1;B1"));
});

test("CSV in and out, and clean cells", () => {
  const cells = csvCells('קורס,ציון\n"פיזיולוגיה, א",88\nסטטיסטיקה,"7""8"');
  assert.deepEqual(cells, { A1: "קורס", B1: "ציון", A2: "פיזיולוגיה, א", B2: "88", A3: "סטטיסטיקה", B3: '7"8' });
  assert.equal(sheetCsv({ cells: { ...cells, C2: "=B2*2" }, cols: 3, rows: 3 }), 'קורס,ציון,\n"פיזיולוגיה, א",88,176\nסטטיסטיקה,"7""8",');
  assert.equal(sheetCsv({ cells: { A1: '="=cmd|calc"', B1: "-5", C1: "@x" }, cols: 3, rows: 1 }), "'=cmd|calc,-5,'@x");
  assert.deepEqual(cleanCells({ a1: 5, "../x": "1", B2: "", ZZ1: "x", C3: { x: 1 } }), { A1: "5" });
});

test("markdownTableCsv: a comparison table becomes CSV for a sheet", () => {
  const md = "Here:\n\n| | Beta blockers | Calcium blockers |\n|---|:---:|---|\n| **Mechanism** | block β1 | block L-type, \"slow\" |\n| Use | angina | angina |\n\nThe main difference…";
  assert.equal(markdownTableCsv(md), ',Beta blockers,Calcium blockers\nMechanism,block β1,"block L-type, ""slow"""\nUse,angina,angina');
  assert.equal(markdownTableCsv("no table"), "");
});

test("MEDIAN, COUNTIF and SUMIF, with criteria parsed by hand", () => {
  const cells: Record<string, string> = { A1: "90", A2: "70", A3: "85", A4: "done", B1: "1", B2: "2", B3: "3", B4: "4" };
  const v = (f: string) => computeSheet({ ...cells, C1: f }).C1;
  assert.equal(v("=MEDIAN(A1:A3)"), 85);
  assert.equal(v("=MEDIAN(B1:B4)"), 2.5);
  assert.equal(v('=COUNTIF(A1:A4,">80")'), 2);
  assert.equal(v('=COUNTIF(A1:A4,"done")'), 1);
  assert.equal(v('=COUNTIF(A1:A4,"<>done")'), 3);
  assert.equal(v("=COUNTIF(A1:A4,70)"), 1);
  assert.equal(v('=SUMIF(A1:A3,">=85",B1:B3)'), 4);
  assert.equal(v('=SUMIF(A1:A3,"<80")'), 70);
});
