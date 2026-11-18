import { test } from "node:test";
import assert from "node:assert/strict";
import { fileIcon, namedDocuments, splitAttachments } from "./attach-lines.js";

test("attachment lines are taken out of the words, in English and Hebrew, without repeats", () => {
  const r = splitAttachments("Sum this up please\n\n[Attached: uploads/budget.xlsx]\n[קובץ מצורף: uploads/deck.pptx]\n[Attached: uploads/budget.xlsx]");
  assert.equal(r.body, "Sum this up please");
  assert.deepEqual(r.files, ["uploads/budget.xlsx", "uploads/deck.pptx"]);
  assert.deepEqual(splitAttachments("no files here"), { body: "no files here", files: [] });
});

test("icons by kind", () => {
  assert.equal(fileIcon("a/b.XLSX"), "grid");
  assert.equal(fileIcon("x.pptx"), "monitor");
  assert.equal(fileIcon("p.jpeg"), "image");
  assert.equal(fileIcon("r.pdf"), "page");
  assert.equal(fileIcon("z.zip"), "paperclip");
});

test("an answer's Office files, tables and PDFs become chips; web addresses do not", () => {
  const text = "Saved it as `out/sales.xlsx` and report.docx. See https://x.com/a/b.pdf and (data.csv), sales.xlsx again; C:\\x\\y.pptx";
  assert.deepEqual(namedDocuments(text), ["out/sales.xlsx", "report.docx", "data.csv", "sales.xlsx"]); // a full Windows path is outside the chat folder: no chip
  assert.deepEqual(namedDocuments("no files here, just a .xlsx mention"), []);
});
