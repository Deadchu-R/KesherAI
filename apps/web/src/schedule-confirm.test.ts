import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSchedulePreview, scheduleEditNote } from "./schedule-confirm";

const PREVIEW = "schedule\nname: Morning news\nwhen: daily 08:30\nnext: 1796000000000\nnewChat: true\n---\nSummarise the news.\nKeep it short: 5 lines.";

test("the confirm card reads the server's preview", () => {
  assert.deepEqual(parseSchedulePreview(PREVIEW), { name: "Morning news", when: "daily 08:30", next: 1796000000000, newChat: true, prompt: "Summarise the news.\nKeep it short: 5 lines." });
});

test("a preview that is not a schedule one is left to the ordinary card", () => {
  assert.equal(parseSchedulePreview("--- a/x\n+++ b/x"), undefined);
  assert.equal(parseSchedulePreview("schedule\nname: x\n---\np"), undefined);
});

test("Edit tells the model the values to send again", () => {
  const n = scheduleEditNote({ name: "N", when: "daily 09:00", prompt: 'say "hi"', newChat: false });
  assert.match(n, /Call schedule_task again/);
  assert.ok(n.includes('prompt="say \\"hi\\""'));
});
