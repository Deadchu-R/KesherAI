import { test } from "node:test";
import assert from "node:assert/strict";
import { messageVersions, takeVersionScroll } from "./branch-versions";

const orig = { id: "o", createdAt: "2026-11-21T10:00:00Z" };
const e1 = { id: "e1", createdAt: "2026-11-21T10:05:00Z", branchOf: { id: "o", seq: 5 } };
const e2 = { id: "e2", createdAt: "2026-11-21T10:09:00Z", branchOf: { id: "o", seq: 5 } };
const here = { id: "h", createdAt: "2026-11-21T10:07:00Z", branchOf: { id: "o", seq: 8 } };
const all = [e2, orig, here, e1];

test("the original message lists its edits, oldest first", () => {
  assert.deepEqual(messageVersions(orig, 5, all), { ids: ["o", "e1", "e2"], at: 0 });
});

test("an edit branch finds its siblings and the original at the same seq", () => {
  assert.deepEqual(messageVersions(e2, 5, all), { ids: ["o", "e1", "e2"], at: 2 });
});

test("a message never edited has one version; a branch made at another seq does not count", () => {
  assert.deepEqual(messageVersions(orig, 1, all), { ids: ["o"], at: 0 });
  assert.deepEqual(messageVersions(e1, 7, all), { ids: ["e1"], at: 0 });
});

test("a deleted original is left out", () => {
  assert.deepEqual(messageVersions(e1, 5, [e1, e2]), { ids: ["e1", "e2"], at: 0 });
});

test("takeVersionScroll answers once, only for the chat switched to", () => {
  assert.equal(takeVersionScroll("x"), undefined);
});
