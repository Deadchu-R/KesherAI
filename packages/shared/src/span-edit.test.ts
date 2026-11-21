import { test } from "node:test";
import assert from "node:assert/strict";
import { applySpan, cleanSpanAnswer, locateSpan, spanContext, spanEditPrompt, wordDiff } from "./span-edit.js";

test("locateSpan finds an exact match, the nearest of repeats", () => {
  const src = "one cat. two cat. three cat.";
  assert.deepEqual(locateSpan(src, "cat"), { start: 4, end: 7 });
  assert.deepEqual(locateSpan(src, " cat ", 20), { start: 24, end: 27 });
  assert.equal(locateSpan(src, "dog"), null);
  assert.equal(locateSpan(src, "   "), null);
});

test("locateSpan matches a rendered selection across markdown marks and line breaks", () => {
  const src = "# Title\n\nThis is **very** important\nand _true_.";
  const s = locateSpan(src, "This is very important and true.");
  assert.ok(s);
  assert.equal(src.slice(s.start, s.end), "This is **very** important\nand _true_.");
});

test("applySpan replaces only the span and keeps its surrounding spaces", () => {
  const src = "Hello big world, bye.";
  assert.equal(applySpan(src, { start: 5, end: 10 }, "small"), "Hello small world, bye.");
  assert.equal(applySpan(src, { start: 6, end: 9 }, "huge"), "Hello huge world, bye.");
  assert.equal(applySpan(src, { start: 5, end: 10 }, ""), "Helloworld, bye.");
  assert.throws(() => applySpan(src, { start: 3, end: 99 }, "x"), RangeError);
});

test("locate then apply rewrites a markdown span and nothing else", () => {
  const src = "Intro line.\n\nThe **old** text here.\n\nOutro line.";
  const s = locateSpan(src, "The old text here.")!;
  assert.equal(applySpan(src, s, "The new text."), "Intro line.\n\nThe new text.\n\nOutro line.");
});

test("spanContext keeps whole lines near the cut and the exact selection", () => {
  const src = `${"a".repeat(50)}\nline before\nPICK\nline after\n${"b".repeat(50)}`;
  const s = locateSpan(src, "PICK")!;
  const c = spanContext(src, s, 20);
  assert.equal(c.selected, "PICK");
  assert.equal(c.before, "line before\n");
  assert.equal(c.after, "\nline after");
  const p = spanEditPrompt({ kind: "code", language: "html", before: c.before, selected: c.selected, after: c.after, instruction: "bold it" });
  assert.match(p, /<SELECTED>PICK<\/SELECTED>/);
  assert.match(p, /Instruction: bold it/);
});

test("cleanSpanAnswer drops thinking, fences and repeated tags", () => {
  assert.equal(cleanSpanAnswer("<think>hmm</think>\nNew text  \n"), "New text");
  assert.equal(cleanSpanAnswer("```html\n<b>x</b>\n```"), "<b>x</b>");
  assert.equal(cleanSpanAnswer("Sure: <SELECTED>only this</SELECTED>"), "only this");
});

test("wordDiff marks removed and added words and rebuilds both sides", () => {
  const a = "the quick brown fox";
  const b = "the slow brown dog";
  const d = wordDiff(a, b);
  assert.equal(d.filter((p) => p.op !== "add").map((p) => p.text).join(""), a);
  assert.equal(d.filter((p) => p.op !== "del").map((p) => p.text).join(""), b);
  assert.deepEqual(d.filter((p) => p.op === "del").map((p) => p.text), ["quick", "fox"]);
  assert.deepEqual(wordDiff("x", "x"), [{ op: "same", text: "x" }]);
});
