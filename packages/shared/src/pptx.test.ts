import { test } from "node:test";
import assert from "node:assert/strict";
import { pptxFiles } from "./pptx.js";

test("a deck: a title slide, one slide each with notes, Hebrew set right to left, text escaped", () => {
  const f = pptxFiles("חוסמי בטא", [{ title: "איך <זה> עובד", bullets: ["א & ב"], notes: "הערות\u0001" }]);
  assert.ok(f["ppt/slides/slide1.xml"]!.includes("חוסמי בטא"));
  assert.ok(f["ppt/slides/slide2.xml"]!.includes('rtl="1"'));
  assert.ok(f["ppt/slides/slide2.xml"]!.includes("איך &lt;זה&gt; עובד"));
  assert.ok(f["ppt/slides/slide2.xml"]!.includes("א &amp; ב"));
  assert.ok(f["ppt/notesSlides/notesSlide2.xml"]!.includes(">הערות<"));
  assert.match(f["ppt/presentation.xml"]!, /sldId id="257"/);
});
