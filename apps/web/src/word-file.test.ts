import { test } from "node:test";
import assert from "node:assert/strict";
import { wordExportPath, wordFileName, wordFromResult, wordSaveState } from "./word-file.js";
import { BUILT_IN, buildSurfaces, itemFromResult, openTarget } from "./surfaces.js";

const list = buildSurfaces(BUILT_IN, { parts: [], pluginPages: [] });

test("a .docx chat file opens in the Word surface (its Open in chat chip), in any letter case and with Hebrew names", () => {
  for (const name of ["Plan.docx", "דוח שנתי.DOCX", "shared/a b.docx"]) {
    const t = openTarget(BUILT_IN, list, name);
    assert.equal(t && "surface" in t ? t.surface.id : "", "word", name);
  }
  assert.notEqual((openTarget(BUILT_IN, list, "a.doc") as { surface?: { id: string } } | undefined)?.surface?.id, "word");
  assert.equal((openTarget(BUILT_IN, list, "a.docx.bak") as { surface?: { id: string } } | undefined)?.surface?.id, undefined);
});

test("docx_open opens the Word surface on the document it made; a failure or another tool does not", () => {
  const out = 'Opened "Plan" as document d-1 (120 words). The user sees it at #/docs/d-1. Read it with the document tool (id: d-1).';
  assert.deepEqual(wordFromResult("docx_open", true, out), { kind: "word", id: "d-1", title: "Plan" });
  assert.deepEqual(itemFromResult(list, "docx_open", true, out), { surface: "word", kind: "word", id: "d-1", title: "Plan" });
  assert.equal(wordFromResult("docx_open", false, out), undefined);
  assert.equal(wordFromResult("document", true, out), undefined);
  assert.equal(itemFromResult(list, "docx_save", true, "Saved the Word file C:\\a\\b.docx."), undefined);
  const he = wordFromResult("docx_open", true, 'Opened "דוח" as document x9 (3 words).');
  assert.equal(he?.title, "דוח");
});

test("the Word surface: both tools, edits on the phone, saved on the server", () => {
  const s = BUILT_IN.find((x) => x.id === "word")!;
  assert.deepEqual([...s.tools], ["docx_open", "docx_save"]);
  assert.equal(s.phone, "edit");
  assert.equal(s.versions, "server");
});

test("Save to Word: a dot with unsaved changes, quiet when saved, disabled without a file or while saving", () => {
  assert.equal(wordSaveState({ hasFile: true, rev: 3, savedRev: 3, saving: false }), "clean");
  assert.equal(wordSaveState({ hasFile: true, rev: 4, savedRev: 3, saving: false }), "dirty");
  assert.equal(wordSaveState({ hasFile: true, rev: 4, savedRev: 3, saving: true }), "saving");
  assert.equal(wordSaveState({ hasFile: false, rev: 4, savedRev: 3, saving: false }), "no-file");
});

test("the panel shows only a file name (no folder), and the download is the server's .docx address", () => {
  assert.equal(wordFileName("C:\\Users\\x\\Documents\\דוח.docx"), "דוח.docx");
  assert.equal(wordFileName("/home/x/Plan.docx"), "Plan.docx");
  assert.equal(wordFileName(undefined), "");
  assert.equal(wordExportPath("a b/c"), "/api/docs/a%20b%2Fc/export.docx");
});
