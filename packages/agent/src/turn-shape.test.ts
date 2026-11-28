import { test } from "node:test";
import assert from "node:assert/strict";
import { asksPermission, finishFollowUp, hasStepRecap, needsShortening, needsHebrewRewrite, shapeFollowUp, needsSayFirst, silentToolStart, stripCode } from "./turn-shape.js";

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

test("act, don't ask: permission questions for a clear request are found (English and Hebrew)", () => {
  assert.equal(asksPermission("Shall I go ahead and create the file?", "create a file a.txt", false), true);
  assert.equal(asksPermission("I found the bug. Do you want me to fix it?", "fix the login bug", false), true);
  assert.equal(asksPermission("רוצה שאמשיך?", "תכין לי קובץ", false), true);
  assert.equal(asksPermission("שאתחיל?", "תבנה את הדף", false), true);
});

test("act, don't ask: not for ask_user, no request, destructive, long answers or plain questions", () => {
  assert.equal(asksPermission("Shall I create the file?", "create a file", true), false);
  assert.equal(asksPermission("Shall I create the file?", "what do you think about files?", false), false);
  assert.equal(asksPermission("Shall I delete the old folder?", "clean up the project", false), false);
  assert.equal(asksPermission("רוצה שאמחק את הקבצים?", "תנקה את התיקייה", false), false);
  assert.equal(asksPermission("Do you want me to push to main?", "finish the feature", false), false);
  assert.equal(asksPermission("The file is ready.", "create a file", false), false);
  assert.equal(asksPermission("Here is the whole report. ".repeat(30) + "Want me to continue?", "write a report", false), false);
});

test("finish follow-up: open todo steps first, each kind once, never when skipped", () => {
  const todo = [{ id: "1", title: "Write a", state: "done" as const }, { id: "2", title: "Check b", state: "pending" as const }];
  const base = { answer: "Done.", userText: "make it", todo, askedUser: false, used: new Set<string>(), skip: false };
  const a = finishFollowUp(base);
  assert.equal(a?.kind, "open-steps");
  assert.match(a!.message, /still open: 2\. Check b\. Continue, or mark them done\/dropped with a reason/);
  assert.equal(finishFollowUp({ ...base, used: new Set(["open-steps"]) }), undefined);
  assert.equal(finishFollowUp({ ...base, skip: true }), undefined);
  const b = finishFollowUp({ ...base, todo: undefined, answer: "Shall I start?" });
  assert.equal(b?.kind, "act");
  assert.match(b!.message, /already asked for this — do it/);
  assert.equal(finishFollowUp({ ...base, todo: undefined, answer: "Shall I start?", used: new Set(["act"]) }), undefined);
});

test("says-first: a bare first tool call is asked again; words, no tools, or a lone ask_user are not", () => {
  assert.equal(needsSayFirst("", ["read_file"]), true);
  assert.equal(needsSayFirst("  ", ["ask_user", "read_file"]), true);
  assert.equal(needsSayFirst("I'll read it.", ["read_file"]), false);
  assert.equal(needsSayFirst("", []), false);
  assert.equal(needsSayFirst("", ["ask_user"]), false);
});
