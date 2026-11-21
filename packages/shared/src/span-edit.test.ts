import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appliedSpan, applySpan, bubblePlace, cleanSpanAnswer, cleanSpanPartial, fenceAt, hebrewShare, isEditShortcut, locateSpan, QUICK_ACTIONS,
  quickActionInstruction, spanContext, spanEditPrompt, stripContextEcho, undoSpan, withoutFenceLines, wordDiff,
} from "./span-edit.js";

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

test("applySpan in mixed Hebrew and English touches only the span", () => {
  const src = "שלום עולם, this is **mixed** טקסט with code `x = 1` ובסוף.";
  const s = locateSpan(src, "this is mixed טקסט")!;
  assert.equal(src.slice(s.start, s.end), "this is **mixed** טקסט");
  const r = applySpan(src, s, "זה טקסט מעורב");
  assert.equal(r, "שלום עולם, זה טקסט מעורב with code `x = 1` ובסוף.");
  assert.equal(r.slice(0, s.start), src.slice(0, s.start));
  assert.equal(r.slice(r.length - (src.length - s.end)), src.slice(s.end));
});

test("appliedSpan then undoSpan restores the old text, and refuses when the text moved on", () => {
  const src = "אחד שניים שלושה. Four five six.\n\nסוף.";
  const a = appliedSpan(src, locateSpan(src, "Four five six.")!, "Short.");
  assert.equal(a.text, "אחד שניים שלושה. Short.\n\nסוף.");
  assert.equal(undoSpan(a.text, a), src);
  // Edited elsewhere meanwhile (before the span, so offsets moved): not undone blindly.
  assert.equal(undoSpan(`!${a.text}`, a), null);
  // Edited after the span: the undo still puts the old span back and keeps the later edit.
  assert.equal(undoSpan(`${a.text} Later.`, a), `${src} Later.`);
  // An empty replacement (delete) can be undone too, edge spaces included.
  const d = appliedSpan("a b c", { start: 1, end: 4 }, "");
  assert.equal(d.text, "ac");
  assert.equal(undoSpan(d.text, d), "a b c");
});

test("applySpan keeps the span's own line breaks at the edges", () => {
  assert.equal(applySpan("one\ntwo\nthree", { start: 3, end: 8 }, "2"), "one\n2\nthree");
});

test("fenceAt finds the code block that holds the span, and only then", () => {
  const src = "Intro\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nAfter `inline` text.\n\n~~~\nplain\n~~~\n";
  const a = locateSpan(src, "const b = 2;")!;
  assert.deepEqual(fenceAt(src, a), { language: "ts" });
  assert.equal(fenceAt(src, locateSpan(src, "After")!), null);
  assert.equal(fenceAt(src, locateSpan(src, "Intro")!), null);
  assert.deepEqual(fenceAt(src, locateSpan(src, "plain")!), { language: "" });
  // A span that starts in the code and runs out of it is not "inside".
  const across = { start: a.start, end: src.indexOf("After") };
  assert.equal(fenceAt(src, across), null);
  // An unclosed block runs to the end.
  assert.deepEqual(fenceAt("x\n```py\nprint(1)", { start: 8, end: 16 }), { language: "py" });
});

test("a rewrite inside a code block cannot close the document's block", () => {
  const src = "Text\n\n```js\nlet a = 1;\nlet b = 2;\n```\n\nEnd";
  const s = locateSpan(src, "let b = 2;")!;
  const answer = withoutFenceLines("```js\nlet b = 3;\n```\n```");
  assert.equal(answer, "let b = 3;");
  assert.equal(applySpan(src, s, answer), "Text\n\n```js\nlet a = 1;\nlet b = 3;\n```\n\nEnd");
});

test("stripContextEcho removes repeated neighbours but keeps short matches", () => {
  const before = "Intro paragraph.\nThe sentence before the span.";
  const after = " The sentence after the span.\nOutro.";
  assert.equal(stripContextEcho("The sentence before the span.\nNew text.", before, after), "New text.");
  assert.equal(stripContextEcho("New text.\nThe sentence after the span.", before, after), "New text.");
  assert.equal(stripContextEcho("New text.", before, after), "New text.");
  assert.equal(stripContextEcho("Outro.", "x\nHi.", "Outro."), "Outro.");
});

test("quick actions: four of them, with the translate direction following the text", () => {
  assert.deepEqual(QUICK_ACTIONS.map((a) => a.id), ["shorter", "clearer", "translate", "grammar"]);
  for (const a of QUICK_ACTIONS) assert.ok(a.he && a.en);
  assert.match(quickActionInstruction("shorter", "x"), /shorter/i);
  assert.match(quickActionInstruction("clearer", "x"), /clearer/i);
  assert.match(quickActionInstruction("grammar", "x"), /grammar/i);
  assert.match(quickActionInstruction("translate", "שלום לכולם, זה טקסט"), /into English/);
  assert.match(quickActionInstruction("translate", "Hello everyone"), /into Hebrew/);
  assert.match(quickActionInstruction("translate", "שלום עולם, hello"), /into English/);
  assert.match(quickActionInstruction("shorter", "x"), /markdown formatting/);
});

test("quick actions on code keep the code's behaviour and syntax", () => {
  assert.match(quickActionInstruction("grammar", "// helo wrold", "code"), /comments and text strings only/);
  assert.match(quickActionInstruction("translate", "// שלום", "code"), /comments and text strings into English/);
  assert.match(quickActionInstruction("shorter", "x", "code"), /without changing what it does/);
});

test("hebrewShare counts letters only", () => {
  assert.equal(hebrewShare("123 !!"), 0);
  assert.equal(hebrewShare("שלום"), 1);
  assert.equal(hebrewShare("ab שם"), 0.5);
});

test("isEditShortcut: Ctrl or Cmd plus K, also on a Hebrew layout, nothing extra", () => {
  const k = { key: "k", code: "KeyK", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };
  assert.equal(isEditShortcut(k), true);
  assert.equal(isEditShortcut({ ...k, ctrlKey: false, metaKey: true }), true);
  assert.equal(isEditShortcut({ ...k, key: "ל" }), true);
  assert.equal(isEditShortcut({ ...k, ctrlKey: false }), false);
  assert.equal(isEditShortcut({ ...k, shiftKey: true }), false);
  assert.equal(isEditShortcut({ ...k, key: "j", code: "KeyJ" }), false);
});

test("bubblePlace goes above the selection, below when the top is tight, and stays on screen", () => {
  const view = { width: 1200, height: 800 };
  assert.deepEqual(bubblePlace({ top: 300, bottom: 320, left: 400, right: 500 }, view), { top: 248, left: 450 });
  assert.equal(bubblePlace({ top: 20, bottom: 40, left: 400, right: 500 }, view).top, 48);
  assert.equal(bubblePlace({ top: 300, bottom: 320, left: 0, right: 20 }, view).left, 188);
  assert.equal(bubblePlace({ top: 300, bottom: 320, left: 1190, right: 1200 }, view).left, 1012);
  // A narrow panel: the bubble's half width shrinks to the viewport.
  assert.equal(bubblePlace({ top: 300, bottom: 320, left: 0, right: 10 }, { width: 390, height: 800 }).left, 188);
});

test("cleanSpanPartial hides thinking and fences while streaming", () => {
  assert.equal(cleanSpanPartial("<think>hmm"), "");
  assert.equal(cleanSpanPartial("<think>a</think>Hel"), "Hel");
  assert.equal(cleanSpanPartial("```html\n<b>x"), "<b>x");
  assert.equal(cleanSpanPartial("<b>x</b>\n``"), "<b>x</b>");
  assert.equal(cleanSpanPartial("שלום עולם"), "שלום עולם");
});
