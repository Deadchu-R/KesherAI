import { test } from "node:test";
import assert from "node:assert/strict";
import { itemFromResult, selectionMessage } from "./doc-items.js";

test("the item a tool step wrote, with its version", () => {
  assert.deepEqual(itemFromResult("document", true, "Saved v3 (120 words). The user sees it at #/docs/chat-c1."), { kind: "doc", id: "chat-c1", ver: 3 });
  assert.deepEqual(itemFromResult("sheet", true, "Saved v2. The user sees it at #/sheets/abc-1.\nA1: x"), { kind: "sheet", id: "abc-1", ver: 2 });
  assert.deepEqual(itemFromResult("slides", true, "Saved v5: 4 slides. The user sees it at #/slides/d9.\n…"), { kind: "deck", id: "d9", ver: 5 });
  // An older answer without a number still opens.
  assert.deepEqual(itemFromResult("document", true, "Saved (3 words). The user sees it at #/docs/x."), { kind: "doc", id: "x" });
});

test("reads, failures, other tools and mismatched links make no card", () => {
  assert.equal(itemFromResult("document", true, "# Title\n\nsee #/docs/x"), undefined);
  assert.equal(itemFromResult("document", false, "Saved v2 at #/docs/x"), undefined);
  assert.equal(itemFromResult("write_file", true, "Saved v2 at #/docs/x"), undefined);
  assert.equal(itemFromResult("sheet", true, "Saved v2 at #/docs/x"), undefined);
});

test("the selection message: a question, or a change through the item's tool", () => {
  const base = { kind: "doc" as const, id: "d1", title: "Plan", selection: "line one\nline two", instruction: " make it shorter ", he: false };
  const ask = selectionMessage({ ...base, change: false });
  assert.equal(ask, 'In the document "Plan" (#/docs/d1), about this part:\n> line one\n> line two\n\nmake it shorter');
  const change = selectionMessage({ ...base, change: true });
  assert.match(change, /change this part:\n> line one\n> line two\n\nmake it shorter\n\(Use the document tool with id "d1", read first/);
  assert.match(selectionMessage({ ...base, kind: "deck", change: true, he: true }), /^במצגת "Plan" \(#\/slides\/d1\).*\n[\s\S]*בכלי slides/);
  assert.ok(selectionMessage({ ...base, selection: "x".repeat(3000), change: false }).length < 1700, "a long selection is cut");
});
