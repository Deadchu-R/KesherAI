import { test } from "node:test";
import assert from "node:assert/strict";
import { hebrewFor } from "./hebrew-address.js";

test("Hebrew in the form she chose, whole words only", () => {
  assert.equal(hebrewFor("התחילי בקורס ראשון. כתוב הודעה", "f"), "התחילי בקורס ראשון. כתבי הודעה");
  assert.equal(hebrewFor("התחילי בקורס ראשון. כתוב הודעה", "m"), "התחל בקורס ראשון. כתוב הודעה");
  assert.equal(hebrewFor("לחץ ושמור", "p"), "לחצו ושמרו");
  // Inside a longer word nothing changes ("הקלטה", "התחלה", "שמורה").
  assert.equal(hebrewFor("הקלטה, התחלה ושמורה", "f"), "הקלטה, התחלה ושמורה");
  // The object marker "את" never becomes "אתה".
  assert.equal(hebrewFor("את הקובץ", "m"), "את הקובץ");
  assert.equal(hebrewFor("אתה מחובר", "f"), "את מחובר");
  assert.equal(hebrewFor("כתוב הודעה", undefined), "כתוב הודעה");
});

test("study words, and the noun לחץ stays a noun", async () => {
  const { hebrewFor } = await import("./hebrew-address.js");
  assert.equal(hebrewFor("מה את לומדת?", "m"), "מה אתה לומד?");
  assert.equal(hebrewFor("ביום רגיל את עושה בערך 20", "p"), "ביום רגיל אתם עושים בערך 20");
  assert.equal(hebrewFor("בלי לחץ: לא צריך הכול היום.", "p"), "בלי לחץ: לא צריך הכול היום.");
  assert.equal(hebrewFor("בלי לחץ", "f"), "בלי לחץ");
  assert.equal(hebrewFor("לחץ על הכפתור", "p"), "לחצו על הכפתור");
  assert.equal(hebrewFor("מודדים לחץ דם", "p"), "מודדים לחץ דם");
  assert.equal(hebrewFor("לחצי על הכפתור", "m"), "לחץ על הכפתור");
  assert.equal(hebrewFor("הכרטיסיות שלמדת לאחרונה", "p"), "הכרטיסיות שלמדתם לאחרונה");
});
