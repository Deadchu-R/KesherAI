import { test } from "node:test";
import assert from "node:assert/strict";
import { answerInUserLanguage, needsTranslation, protect, restore, userLanguage } from "./answer-language.js";

test("the user's language by script", () => {
  assert.equal(userLanguage("תקן לי את הבאג ב-Player.cs"), "he");
  assert.equal(userLanguage("fix the bug"), undefined);
});

test("an English or mixed answer to a Hebrew message needs translating; a Hebrew one with code does not", () => {
  assert.equal(needsTranslation("I fixed the null check in the Update method and added a guard so the player cannot move while paused.", "he"), true);
  assert.equal(needsTranslation("הצ'אט מראה זוג שبنוי על רתיחות 反复", "he"), true);
  assert.equal(needsTranslation("תיקנתי את הבדיקה ב-`Update()`:\n```csharp\nif (player == null) return; // guard against missing player reference here\n```", "he"), false);
  assert.equal(needsTranslation("Done.", "he"), false);
});

test("code and links are kept out and put back; a lost marker keeps the original", () => {
  const { text, kept } = protect("Use `speed` here:\n```cs\nx = 1;\n```\nSee https://docs.unity3d.com/x");
  assert.equal(kept.length, 3);
  assert.equal(restore(text.replace("Use", "השתמש ב"), kept), "השתמש ב `speed` here:\n```cs\nx = 1;\n```\nSee https://docs.unity3d.com/x");
  assert.equal(restore("בלי סימנים", kept), undefined);
});

test("answerInUserLanguage translates the prose only", async () => {
  const answer = "I changed the movement so the player keeps a constant speed on every computer. Use `Time.deltaTime` in Update.";
  const out = await answerInUserLanguage(answer, "למה השחקן זז מהר מדי?", async (_s, t) => t.replace("I changed the movement so the player keeps a constant speed on every computer. Use", "שיניתי את התנועה כך שלשחקן תהיה מהירות קבועה בכל מחשב. השתמש ב").replace("in Update.", "בתוך Update."));
  assert.equal(out, "שיניתי את התנועה כך שלשחקן תהיה מהירות קבועה בכל מחשב. השתמש ב `Time.deltaTime` בתוך Update.");
  assert.equal(await answerInUserLanguage(answer, "why is it fast?", async () => "x"), undefined);
});
