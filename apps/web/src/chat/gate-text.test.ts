import { test } from "node:test";
import assert from "node:assert/strict";
import { dangerWhat, gateNoteText, reviewHeldText, splitReview } from "./gate-text.js";

const he = (h: string) => h;
const en = (_h: string, e: string) => e;

test("always-ask reasons read in Hebrew; unknown ones stay as they came", () => {
  assert.equal(dangerWhat("deletes files outside the project folder", he), "מוחקת קבצים מחוץ לתיקיית הפרויקט");
  assert.equal(dangerWhat("turns off a security protection", en), "turns off a security protection");
  assert.equal(dangerWhat("something new", he), "something new");
});

test("the reviewer's 'left it to you' note is split from the reason", () => {
  assert.deepEqual(splitReview("The agent wants to run a command on your computer. The reviewer left it to you: not asked for."), {
    base: "The agent wants to run a command on your computer.",
    review: "not asked for",
  });
  assert.deepEqual(splitReview("The agent wants to change a file."), { base: "The agent wants to change a file.", review: "" });
  assert.equal(reviewHeldText("x", he), "הבודק השאיר לך את ההחלטה: x");
});

test("gate notes in the chat read in the user's language", () => {
  assert.equal(gateNoteText("✓ Approved by the reviewer: pnpm test (part of the task)", he), "✓ הבודק אישר: pnpm test (part of the task)");
  assert.equal(gateNoteText("✓ Approved by the local reviewer: click «Save» on example.com", he), "✓ הבודק המקומי אישר: click «Save» on example.com");
  assert.equal(gateNoteText("✓ Approved by the reviewer: ls", en), "✓ Approved by the reviewer: ls");
  assert.equal(gateNoteText("Something else", he), "Something else");
});
