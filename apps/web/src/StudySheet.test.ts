import { test } from "node:test";
import assert from "node:assert/strict";
import { keyPoints } from "./StudySheet";

test("the sheet's main points: list lines first, else sentences", () => {
  assert.deepEqual(keyPoints("## כותרת\n- **חוסמי בטא** מורידים דופק\n- זהירות באסתמה\n1. משמשים ביתר לחץ דם\nעוד טקסט."), ["חוסמי בטא מורידים דופק", "זהירות באסתמה", "משמשים ביתר לחץ דם"]);
  assert.deepEqual(keyPoints("Beta blockers slow the heart rate. They are used for hypertension. Careful with asthma patients."), ["Beta blockers slow the heart rate.", "They are used for hypertension.", "Careful with asthma patients."]);
});
