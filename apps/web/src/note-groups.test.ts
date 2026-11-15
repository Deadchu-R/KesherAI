import assert from "node:assert/strict";
import { test } from "node:test";
import { groupNotes } from "./note-groups.js";

test("notes in a row from the same place become one with a count", () => {
  const g = groupNotes([
    { title: "Download done", path: "#/models", at: 5 },
    { title: "Download done", path: "#/models", at: 4 },
    { title: "Self-work needs you", path: "#/self-work", at: 3 },
    { title: "Download done", path: "#/models", at: 2 },
  ]);
  assert.deepEqual(g.map((x) => [x.title, x.count, x.at]), [["Download done", 2, 5], ["Self-work needs you", 1, 3], ["Download done", 1, 2]]);
});

test("a different place or an answered note is not joined", () => {
  const g = groupNotes([
    { title: "A", path: "#/x", at: 3 },
    { title: "A", path: "#/y", at: 2 },
    { title: "A", path: "#/y", at: 1, resolved: "allowed" },
  ]);
  assert.equal(g.length, 3);
});
