import { test } from "node:test";
import assert from "node:assert/strict";
import { fileIcon, folderUploadPlan, namedDocuments, splitAttachments } from "./attach-lines.js";

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
  assert.equal(fileIcon("z.zip"), "box");
  assert.equal(fileIcon("shared/talk.m4a"), "speaker");
  assert.equal(fileIcon("clip.MP4"), "play");
  assert.equal(fileIcon("src/Move.cs"), "code");
  assert.equal(fileIcon("C:\\Games\\MyGame"), "folder");
  assert.equal(fileIcon("model.blend"), "paperclip");
});

test("an answer's Office files, tables and PDFs become chips; web addresses do not", () => {
  const text = "Saved it as `out/sales.xlsx` and report.docx. See https://x.com/a/b.pdf and (data.csv), sales.xlsx again; C:\\x\\y.pptx";
  assert.deepEqual(namedDocuments(text), ["out/sales.xlsx", "report.docx", "data.csv", "sales.xlsx"]); // a full Windows path is outside the chat folder: no chip
  assert.deepEqual(namedDocuments("no files here, just a .xlsx mention"), []);
});

test("folderUploadPlan leaves out dependency, build and hidden folders and empty files, and stops at the limits", () => {
  const files = [
    { path: "Game/README.md", size: 10 },
    { path: "Game/node_modules/x/index.js", size: 10 },
    { path: "Game/.git/HEAD", size: 10 },
    { path: "Game/src/__init__.py", size: 0 },
    { path: "Game/src/main.ts", size: 10 },
    { path: "Game/src/big.bin", size: 100 },
    { path: "Game/.env.example", size: 5 },
  ];
  assert.deepEqual(folderUploadPlan(files), { take: [0, 4, 5, 6], overLimit: 0 });
  assert.deepEqual(folderUploadPlan(files, { maxBytes: 30 }), { take: [0, 4, 6], overLimit: 1 });
  assert.deepEqual(folderUploadPlan(files, { maxFiles: 1 }), { take: [0], overLimit: 3 });
});
