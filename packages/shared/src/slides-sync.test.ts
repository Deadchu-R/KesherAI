import { test } from "node:test";
import assert from "node:assert/strict";
import { alignSlides, stampedChunks } from "./study.js";

test("slides line up with the recording, in order", () => {
  const chunks = stampedChunks("[00:00] שלום לכולם, היום נדבר על הלב\n[05:00] חוסמי בטא חוסמים קולטני בטא בלב\nוהדופק יורד\n[12:00] משתנים מורידים נפח דם וכליות\n[20:00] סיכום ושאלות");
  assert.equal(chunks.length, 4);
  assert.match(chunks[1]!.text, /והדופק יורד$/);
  const at = alignSlides(["חוסמי בטא: קולטני בטא, דופק", "משתנים: נפח דם, כליות", "גלוקוז ואינסולין"], chunks);
  assert.deepEqual(at, [300, 720, undefined]);
  // Never out of order: a later slide that echoes an earlier minute stays at or after it.
  const at2 = alignSlides(["משתנים", "הלב"], chunks);
  assert.ok((at2[1] ?? 9999) >= (at2[0] ?? 0));
  assert.deepEqual(alignSlides([], chunks), []);
});
