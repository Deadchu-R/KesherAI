import { test } from "node:test";
import assert from "node:assert/strict";
import { hasRtl, isolateRuns } from "./bidi.js";

const isolated = (s: string) => isolateRuns(s).filter((r) => r.iso).map((r) => r.text);

test("English-only text is left as it is", () => {
  assert.deepEqual(isolateRuns("Open src/app.ts at 85%"), [{ text: "Open src/app.ts at 85%", iso: false }]);
  assert.ok(hasRtl("שלום") && !hasRtl("hello"));
});

test("English words, paths and percentages inside Hebrew are isolated and the parts join back", () => {
  const s = "הקובץ src/app.ts נשמר ב-Unreal Engine 5. הצלחה של 85% מהבדיקות.";
  assert.deepEqual(isolated(s), ["src/app.ts", "Unreal Engine 5", "85%"]);
  assert.equal(isolateRuns(s).map((r) => r.text).join(""), s);
});

test("a number keeps its unit, a range and a time stay whole, a full stop stays outside", () => {
  assert.deepEqual(isolated("הזיכרון הוא 2.5 GB בלבד."), ["2.5 GB"]);
  assert.deepEqual(isolated("בין 10-20 שניות ובשעה 12:30."), ["10-20", "12:30"]);
  assert.deepEqual(isolated("גרסה v1.2.3."), ["v1.2.3"]);
  assert.deepEqual(isolated("כתוב C++ או node_modules."), ["C++", "node_modules"]);
});

test("Windows paths are one run", () => {
  assert.deepEqual(isolated("הנתיב C:\\Games\\Unreal\\a.uproject נמצא"), ["C:\\Games\\Unreal\\a.uproject"]);
});

test("a sign belongs to the number only when it stands alone, not after a Hebrew prefix", () => {
  assert.deepEqual(isolated("רק ב-85% מהמקרים"), ["85%"]);
  assert.deepEqual(isolated("הטמפרטורה -5 מעלות"), ["-5"]);
});

test("the direction of a line comes from its first strong letter, skipping code and links", async () => {
  const { textDir } = await import("./bidi.js");
  assert.equal(textDir("Note: זה בסדר"), "ltr");
  assert.equal(textDir("`code` שלום"), "rtl");
  assert.equal(textDir("**שלום** world"), "rtl");
  assert.equal(textDir("[Docs](https://a.b) שלום"), "ltr");
  assert.equal(textDir("12.5%"), "auto");
});
