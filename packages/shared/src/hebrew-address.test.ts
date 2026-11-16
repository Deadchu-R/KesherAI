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
