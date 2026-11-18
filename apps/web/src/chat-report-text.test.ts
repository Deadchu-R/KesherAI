import { test } from "node:test";
import assert from "node:assert/strict";
import { originalSections } from "./chat-report-text";

test("an imported report's text in sections: short lines before long ones are headings", () => {
  const long = "זו פסקה ארוכה מספיק כדי להיות גוף של פרק, עם יותר משמונים תווים בתוכה, ככה שהיא לא כותרת בכלל.";
  const s = originalSections(`פתיח קצר.\n\nאיך הכל התחיל\n${long}\n${long}\n\nהשפה הפרטית\n${long}`);
  assert.deepEqual(s.map((x) => x.title), ["", "איך הכל התחיל", "השפה הפרטית"]);
  assert.equal(s[1]!.body.split("\n\n").length, 2);
});
