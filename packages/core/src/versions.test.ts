import { test } from "node:test";
import assert from "node:assert/strict";
import { keepVersion, MAX_VERSIONS, versionNumber, type VersionEntry, type Versioned } from "./versions.js";

type Entry = VersionEntry & { body: string };
const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();

test("the first change keeps a version and numbers both", () => {
  const item: Versioned<Entry> = {};
  assert.equal(versionNumber(item), 1);
  assert.equal(keepVersion(item, { rev: 0, at: at(0), body: "a" }), true);
  assert.deepEqual(item.versions, [{ rev: 0, at: at(0), body: "a", ver: 1 }]);
  assert.equal(item.ver, 2);
});

test("typing within a minute merges; a tool edit always keeps its own version", () => {
  const item: Versioned<Entry> = {};
  keepVersion(item, { rev: 0, at: at(0), body: "a" });
  assert.equal(keepVersion(item, { rev: 1, at: at(10), body: "ab" }), false);
  assert.equal(item.ver, 2);
  assert.equal(keepVersion(item, { rev: 2, at: at(11), body: "abc" }, true), true);
  assert.equal(item.ver, 3);
  assert.equal(item.versions?.at(-1)?.ver, 2);
  // The typing right after the tool's edit keeps the tool's text; the typing after that merges again.
  assert.equal(keepVersion(item, { rev: 3, at: at(12), body: "abcd" }), true);
  assert.equal(keepVersion(item, { rev: 4, at: at(13), body: "abcde" }), false);
  assert.equal(item.ver, 4);
});

test("only the last versions are kept, and the numbers go on", () => {
  const item: Versioned<Entry> = {};
  for (let i = 0; i < MAX_VERSIONS + 5; i++) keepVersion(item, { rev: i, at: at(i), body: String(i) }, true);
  assert.equal(item.versions?.length, MAX_VERSIONS);
  assert.equal(item.versions?.[0]?.ver, 6);
  assert.equal(item.ver, MAX_VERSIONS + 6);
});

test("an older file without numbers counts from its kept versions", () => {
  const item: Versioned<Entry> = { versions: [{ rev: 0, at: at(0), body: "a" }, { rev: 1, at: at(100), body: "b" }] };
  assert.equal(versionNumber(item), 3);
  keepVersion(item, { rev: 2, at: at(300), body: "c" });
  assert.equal(item.versions?.at(-1)?.ver, 3);
  assert.equal(item.ver, 4);
});
