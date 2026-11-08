import { test } from "node:test";
import assert from "node:assert/strict";
import { chatStats, parseChat } from "./chat-stats.js";

test("reads WhatsApp exports (both date styles) and Telegram JSON, and counts who does what", () => {
  const wa = [
    "31/12/2023, 21:00 - Dana: hey 😊 how was it?",
    "31/12/2023, 21:10 - Roee: good! you?",
    "31/12/2023, 21:12 - Dana: great 😊",
    "01/01/2024, 02:30 - Roee: still up?",
    "and a second line",
    "01/01/2024, 02:31 - Dana: yes",
  ].join("\n");
  const m = parseChat(wa);
  assert.equal(m.length, 5);
  assert.equal(m[3]!.text, "still up?\nand a second line");
  const s = chatStats(m);
  const dana = s.people.find((p) => p.name === "Dana")!;
  const roee = s.people.find((p) => p.name === "Roee")!;
  assert.equal(dana.messages, 3);
  assert.equal(dana.startsConversations, 1);
  assert.equal(roee.startsConversations, 1, "a new talk after a 5-hour silence (4 hours or more)");
  assert.equal(roee.lateNightMessages, 1);
  assert.equal(roee.medianReplyMinutes, 10);
  assert.deepEqual(dana.topEmojis, ["😊×2"]);
  assert.equal(s.byMonth.length, 2);

  const us = parseChat("[12/31/23, 9:41:02 PM] Alex: hi?\n[12/31/23, 9:45:00 PM] Sam: hello");
  assert.equal(us[0]!.at!.getHours(), 21);
  assert.equal(us[0]!.at!.getMonth(), 11);

  const tg = parseChat(JSON.stringify({ messages: [{ type: "message", date: "2024-01-01T10:00:00", from: "A", text: ["hi ", { type: "bold", text: "there" }] }, { type: "service", from: "A" }, { type: "message", date: "2024-01-01T10:05:00", from: "B", text: "yo" }] }));
  assert.deepEqual(tg.map((x) => x.text), ["hi there", "yo"]);
});
