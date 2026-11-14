import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32, deflateRawSync } from "node:zlib";
import { documentText } from "./documents.js";
import { openZip, pptxSlides, xlsxSheets } from "./office.js";

/** A small zip (deflated entries), the way Office writes one. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, "utf8");
    const packed = deflateRawSync(raw);
    const n = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, packed);
    centrals.push(central, n);
    offset += 30 + n.length + packed.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const XLSX = zip({
  "xl/workbook.xml": '<workbook><sheets><sheet name="Budget &amp; plan" sheetId="1" r:id="rId1"/><sheet name="Empty" sheetId="2" r:id="rId2"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
  "xl/sharedStrings.xml": "<sst><si><t>Item</t></si><si><t>Cost</t></si><si><r><t>Rent </t></r><r><t>(monthly)</t></r></si><si><t>שכירות</t></si></sst>",
  "xl/worksheets/sheet1.xml":
    '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>4500.5</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Paid?</t></is></c><c r="B3" t="b"><v>1</v></c><c r="D3" t="s"><v>3</v></c></row></sheetData></worksheet>',
  "xl/worksheets/sheet2.xml": "<worksheet><sheetData/></worksheet>",
});

test("an Excel workbook: sheet names, shared and rich strings, gaps between cells, booleans, Hebrew", () => {
  const sheets = xlsxSheets(XLSX);
  assert.deepEqual(sheets.map((s) => s.name), ["Budget & plan", "Empty"]);
  assert.deepEqual(sheets[0]!.rows, [["Item", "Cost"], ["Rent (monthly)", "", "4500.5"], ["Paid?", "TRUE", "", "שכירות"]]);
  assert.deepEqual(sheets[1]!.rows, []);
});

test("rows past the limit are counted, not read", () => {
  const rows = Array.from({ length: 12 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join("");
  const big = zip({ "xl/workbook.xml": '<sheet name="S" r:id="r1"/>', "xl/_rels/workbook.xml.rels": '<Relationship Id="r1" Target="worksheets/sheet1.xml"/>', "xl/worksheets/sheet1.xml": `<sheetData>${rows}</sheetData>` });
  const [s] = xlsxSheets(big, 10);
  assert.equal(s!.rows.length, 10);
  assert.equal(s!.more, 2);
});

test("a PowerPoint deck: slides in number order (10 after 2), one line per paragraph", () => {
  const deck = zip({
    "ppt/slides/slide10.xml": "<p:sld><a:p><a:r><a:t>Last</a:t></a:r></a:p></p:sld>",
    "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>Title</a:t></a:r></a:p><a:p><a:r><a:t>Sub</a:t></a:r><a:r><a:t>title</a:t></a:r></a:p></p:sld>",
    "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>A &lt; B</a:t></a:r></a:p></p:sld>",
  });
  assert.deepEqual(pptxSlides(deck), ["Title\nSubtitle", "A < B", "Last"]);
});

test("documentText reads Excel and PowerPoint for the model", async () => {
  const doc = await documentText(XLSX, "budget.xlsx");
  assert.equal(doc.kind, "xlsx");
  assert.match(doc.pages[0]!, /^Sheet "Budget & plan"\nItem\tCost\nRent \(monthly\)\t\t4500\.5/);
});

test("not a zip, and an entry that unpacks bigger than it says, are refused safely", () => {
  assert.throws(() => openZip(Buffer.from("hello, not a zip")), /not a valid Office file/);
  const z = zip({ "a.xml": "x".repeat(10_000) });
  // Lie in the central directory: say it unpacks to 10 bytes.
  const at = z.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  z.writeUInt32LE(10, at + 24);
  const out = openZip(z).read("a.xml");
  assert.ok(out === undefined || out.length <= 10);
});
