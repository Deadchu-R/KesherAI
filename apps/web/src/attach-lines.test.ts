import { test } from "node:test";
import assert from "node:assert/strict";
import { fileIcon, splitAttachments } from "./attach-lines.js";

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
