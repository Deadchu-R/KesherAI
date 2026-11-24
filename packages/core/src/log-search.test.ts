import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLog } from "./log-parse.js";
import { makeMatcher, MAX_HITS, searchEntries } from "./log-search.js";

const log = parseLog(
  [
    "2026-11-24T10:00:00Z [INFO] start",
    "2026-11-24T10:01:00Z [ERROR] Cannot open file",
    "    at open (fs.js:1:1)",
    "2026-11-24T10:02:00Z [WARN] slow disk",
    "LogBlueprint: Error: Missing node",
    "2026-11-24T10:03:00Z [INFO] done",
  ].join("\n"),
);

test("text search is case-insensitive and looks into stack traces and categories", () => {
  assert.equal(searchEntries(log, { q: "cannot OPEN" }).matched, 1);
  assert.equal(searchEntries(log, { q: "fs.js" }).hits[0]!.entry.msg, "Cannot open file");
  assert.equal(searchEntries(log, { q: "logblueprint" }).matched, 1);
});

test("regex, levels, categories and time", () => {
  assert.equal(searchEntries(log, { q: "^(slow|done)", regex: true }).matched, 2);
  assert.equal(searchEntries(log, { levels: ["error"] }).matched, 2);
  assert.equal(searchEntries(log, { cats: ["LogBlueprint"] }).matched, 1);
  // The Unreal line has no time: it takes 10:02 from the line before it.
  const r = searchEntries(log, { since: Date.parse("2026-11-24T10:02:00Z"), until: Date.parse("2026-11-24T10:02:30Z") });
  assert.deepEqual(r.hits.map((h) => h.entry.msg), ["slow disk", "Missing node"]);
});

test("context lines and limits keep the newest hits", () => {
  const r = searchEntries(log, { levels: ["error"], context: 1 });
  assert.equal(r.hits[0]!.before[0]!.msg, "start");
  assert.equal(r.hits[0]!.after[0]!.msg, "slow disk");
  const big = parseLog(Array.from({ length: 2000 }, (_, i) => `E: e${i}`).join("\n"));
  const all = searchEntries(big, { limit: 100000 });
  assert.equal(all.hits.length, MAX_HITS);
  assert.equal(all.matched, 2000);
  assert.equal(all.truncated, true);
  assert.equal(all.hits.at(-1)!.entry.msg, "e1999");
  assert.equal(searchEntries(big, { limit: 3, context: 99 }).hits[0]!.before.length, 5);
});

test("risky, broken and too long patterns are refused", () => {
  assert.throws(() => makeMatcher("(a+)+$", true), /repeat/);
  assert.throws(() => makeMatcher("(", true), /valid/);
  assert.throws(() => makeMatcher("x".repeat(201)), /longer/);
  assert.equal(makeMatcher("a.c", false)("abc"), false);
  assert.equal(makeMatcher("a.c", true)("abc"), true);
});
