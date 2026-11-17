import { test } from "node:test";
import assert from "node:assert/strict";
import { sentences } from "./ReadAlong.js";

test("read-along splits into sentences and leaves out code and markup", () => {
  assert.deepEqual(sentences("## כותרת\nאינסולין מוריד סוכר. הוא הורמון!\n```js\nx()\n```\n- **נקודה** אחת"), ["כותרת", "אינסולין מוריד סוכר.", "הוא הורמון!", "נקודה אחת"]);
});
