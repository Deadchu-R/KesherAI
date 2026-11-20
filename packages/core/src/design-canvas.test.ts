import { test } from "node:test";
import assert from "node:assert/strict";
import { applyBoardNotes, boardHtml, diffRenders, emptyCanvas, mergeCanvas, notePlace, readCanvas, type Canvas, type RenderedBoard } from "./design-canvas.js";

const rb = (hash: string, title = "t"): RenderedBoard => ({ title, group: "g", viewport: "desktop", w: 1200, h: 700, hash, changedAt: "2026-11-20T10:00:00Z" });

test("change detection: new, changed picture or title, same, removed", () => {
  const d = diffRenders({ A: rb("1"), B: rb("2"), C: rb("3"), Gone: rb("4") }, { A: rb("1"), B: rb("9"), C: rb("3", "new title"), N: rb("5") });
  assert.deepEqual(d, { added: ["N"], changed: ["B", "C"], same: ["A"], removed: ["Gone"] });
});

const base = (): Canvas => ({ ...emptyCanvas(), boards: { "Old.dc.html": { x: 0, y: 0, w: 1200, h: 800, title: "old" } }, order: ["Old.dc.html"], notes: { "mk-newest0": { x: 0, y: -368, w: 1256, text: "🆕 הכי חדש · old", fill: "orange" }, keep: { x: 5, y: 5, w: 100, text: "his" } }, noteOrder: ["keep", "mk-newest0"], extra: 7 });

test("merge: new boards in a row below, computer first; old ones keep their place; other keys kept", () => {
  const c = mergeCanvas(base(), [
    { name: "NPhone.dc.html", title: "n · בטלפון", group: "G", w: 390, h: 900 },
    { name: "N.dc.html", title: "n", group: "G", w: 1200, h: 700 },
    { name: "Old.dc.html", title: "old 2", group: "G", w: 1200, h: 900 },
  ], { added: ["N.dc.html", "NPhone.dc.html"], changed: ["Old.dc.html"] });
  assert.equal(c.extra, 7);
  assert.deepEqual(c.boards["Old.dc.html"], { x: 0, y: 0, w: 1200, h: 900, title: "old 2" });
  const n = c.boards["N.dc.html"]!, p = c.boards["NPhone.dc.html"]!;
  assert.ok(n.y > 900 && n.y === p.y, "one row under everything");
  assert.ok(n.x === 0 && p.x > n.x + n.w, "computer first, phone after with side room");
  assert.ok(c.notes["dg-G"], "group title");
  assert.ok(c.notes.keep, "his notes stay");
  const marks = Object.entries(c.notes).filter(([k]) => k.startsWith("mk-")).map(([, v]) => v.text);
  assert.equal(marks.length, 3);
  assert.ok(marks.some((t) => t.includes("עודכן: old 2")) && marks.some((t) => t.includes("חדש: n")));
  // No note covers any board.
  for (const [k, m] of Object.entries(c.notes)) {
    if (!k.startsWith("mk-")) continue;
    for (const b of Object.values(c.boards)) assert.ok(!(m.x < b.x + b.w && b.x < m.x + m.w && m.y < b.y + b.h && b.y < m.y + 300), `${k} covers a board`);
  }
});

test("merge with nothing new keeps the newest notes", () => {
  const c = mergeCanvas(base(), [{ name: "Old.dc.html", title: "old", group: "G", w: 1200, h: 800 }], { added: [], changed: [] });
  assert.equal(c.notes["mk-newest0"]!.text, "🆕 הכי חדש · old");
});

test("the newest note goes beside a board when the space above is taken", () => {
  const c: Canvas = { ...emptyCanvas(), boards: { A: { x: 0, y: 0, w: 1200, h: 800, title: "a" }, B: { x: 0, y: 900, w: 1200, h: 800, title: "b" } } };
  assert.deepEqual(notePlace(c, "B"), { x: 1240, y: 900, w: 260 });
  assert.equal(notePlace(c, "A").y, -368);
});

test("board notes go beside the board and are removed when cleared", () => {
  let c = applyBoardNotes(base(), { "Old.dc.html": "  bigger button " });
  assert.deepEqual(c.notes["dn-Old"], { x: 1240, y: 320, w: 260, text: "💬 bigger button" });
  assert.ok(c.noteOrder.includes("dn-Old"));
  c = applyBoardNotes(c, { "Old.dc.html": "" });
  assert.equal(c.notes["dn-Old"], undefined);
  assert.ok(!c.noteOrder.includes("dn-Old"));
});

test("boards are escaped and sized; canvas text is read safely", () => {
  const h = boardHtml('a "<b>"', 390, 900, "AAAA");
  assert.match(h, /<title>a &quot;&lt;b&gt;&quot;<\/title>/);
  assert.match(h, /"\$preview":\{"width":390,"height":900\}/);
  assert.deepEqual(readCanvas("").boards, {});
  assert.throws(() => readCanvas("[]"), /not an object/);
});
