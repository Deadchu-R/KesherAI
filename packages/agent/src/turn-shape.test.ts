import { test } from "node:test";
import assert from "node:assert/strict";
import { hasStepRecap, needsShortening, needsHebrewRewrite, shapeFollowUp, silentToolStart, stripCode } from "./turn-shape.js";

const lines = (n: number, s = "line of text") => Array.from({ length: n }, () => s).join("\n");

test("recap detector: English and Hebrew recaps are found", () => {
  assert.equal(hasStepRecap("First I read the file. Then I edited it."), true);
  assert.equal(hasStepRecap("1. Created the folder\n2. Ran the tests\n3. Wrote the report"), true);
  assert.equal(hasStepRecap("שלב 1: קראתי את הקובץ\nשלב 2: ערכתי אותו"), true);
  assert.equal(hasStepRecap("- קראתי את הקובץ\n- עדכנתי את הקוד"), true);
});

test("recap detector: normal answers pass, one phrase is not enough", () => {
  assert.equal(hasStepRecap("The report is ready: report.pdf. Next: send it to the team?"), false);
  assert.equal(hasStepRecap("First I would say the answer is 42."), false);
  assert.equal(hasStepRecap("הקובץ מוכן: report.pdf. השלב הבא: לשלוח אותו?"), false);
});

test("recap detector ignores code blocks", () => {
  const code = "```\nFirst I read\nThen I wrote\nstep 1\nstep 2\n```";
  assert.equal(hasStepRecap(code), false);
  assert.equal(stripCode("a `First I` b").includes("First"), false);
});

test("needsShortening wants both: long and a recap", () => {
  const recap = "First I read the file. Then I edited it.\n";
  assert.equal(needsShortening(recap + lines(30)), true);
  assert.equal(needsShortening(recap), false);
  assert.equal(needsShortening(lines(40)), false);
  assert.equal(needsShortening(recap + lines(12), 10), true);
});

test("language detector: Hebrew user, Latin answer", () => {
  const en = "I created the file and the tests pass. The summary is ready for you to read now.";
  assert.equal(needsHebrewRewrite("תכין לי קובץ", en), true);
  assert.equal(needsHebrewRewrite("make me a file", en), false);
  assert.equal(needsHebrewRewrite("תכין לי קובץ", "יצרתי את `parser.ts` והטסטים עוברים."), false);
  // Code, paths and URLs do not count as Latin prose.
  assert.equal(needsHebrewRewrite("תכין לי קובץ", "הכנתי את הקובץ C:\\Users\\a\\report_final.docx https://example.com/some/long/path\n```ts\nconst longName = compute(valueOne, valueTwo, valueThree);\n```"), false);
});

test("the follow-up: Hebrew first, then shortening, else nothing", () => {
  assert.equal(shapeFollowUp("I made it and it works fine, here is the whole summary of the work.", "בנה לי משהו")?.kind, "hebrew");
  assert.equal(shapeFollowUp("First I read it. Then I wrote it.\n" + lines(30), "build it")?.kind, "shorten");
  assert.equal(shapeFollowUp("Done: out.txt", "build it"), undefined);
});

test("silent tool start is recorded for a tool call with no text", () => {
  assert.equal(silentToolStart("", 1), true);
  assert.equal(silentToolStart("Reading the file.", 1), false);
  assert.equal(silentToolStart("", 0), false);
});
