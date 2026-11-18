import { test } from "node:test";
import assert from "node:assert/strict";
import { undoHunk } from "./tools.js";

const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

test("undoHunk puts back one change and keeps the other", () => {
  const now = before.replace("line 2\n", "line 2 changed\n").replace("line 25\n", "line 25 changed\n");
  const first = undoHunk(before, now, 0);
  assert.equal(first, before.replace("line 25\n", "line 25 changed\n"));
  const second = undoHunk(before, now, 1);
  assert.equal(second, before.replace("line 2\n", "line 2 changed\n"));
});

test("undoHunk handles added and removed lines", () => {
  const now = before.replace("line 10\n", "").replace("line 20\n", "line 20\nnew a\nnew b\n");
  assert.equal(undoHunk(before, now, 1), before.replace("line 10\n", ""));
  assert.equal(undoHunk(before, undoHunk(before, now, 1)!, 0), before);
});

test("undoHunk gives undefined for a hunk that is not there", () => {
  assert.equal(undoHunk(before, before, 0), undefined);
});
