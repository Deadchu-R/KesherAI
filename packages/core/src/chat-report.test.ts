import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PeopleChat } from "./people-chats.js";
import { ChatReports, chatNumbers, chatParts, checkReport, findQuote, realMessages } from "./chat-report.js";

const chat = (): PeopleChat => {
  const messages = [];
  // Two days: Dana opens each morning, Roee answers in 5 minutes; a 10-day silence after.
  for (const [day, hh] of [["2026-01-01", "08"], ["2026-01-02", "08"], ["2026-01-13", "21"]] as const) {
    for (let i = 0; i < 10; i++) {
      const mm = String(i * 5).padStart(2, "0");
      messages.push({ at: `${day}T${hh}:${mm}:00`, sender: "Dana", text: i === 0 ? "בוקר טוב! מה שלומך?" : `הודעה ${i} חחחח` });
      messages.push({ at: `${day}T${hh}:${String(i * 5 + 2).padStart(2, "0")}:00`, sender: "Roee", text: i === 3 ? "אוהב אותך ❤️" : `תשובה ${i}` });
    }
  }
  messages.push({ at: "2026-01-13T22:00:00", sender: "Roee", text: "<Media omitted>" });
  return { source: "whatsapp", title: "Dana", messages };
};

test("chat numbers are counted exactly (media out, starts, reply times, silence, streak)", () => {
  const n = chatNumbers(chat());
  assert.equal(n.messages, 60);
  assert.equal(realMessages(chat()).length, 60);
  const dana = n.people.find((p) => p.name === "Dana")!;
  const roee = n.people.find((p) => p.name === "Roee")!;
  assert.equal(dana.starts, 3);
  assert.equal(roee.starts, 0);
  assert.equal(roee.replyMinutes, 2);
  assert.equal(dana.questions, 3);
  assert.equal(dana.laughs, 27);
  assert.equal(roee.love, 3);
  assert.equal(n.longestSilence?.days, 11);
  assert.equal(n.longestStreak, 2);
  assert.equal(n.hours[8], 40);
});

test("quotes are found in the chat, and an invented one is dropped", () => {
  const msgs = realMessages(chat());
  assert.equal(findQuote(msgs, "בוקר טוב! מה שלומך", "Dana")?.who, "Dana");
  assert.equal(findQuote(msgs, "\"אוהב אותך\"")?.who, "Roee");
  assert.equal(findQuote(msgs, "אני עוזב אותך מחר"), undefined);
  const r = checkReport({ headline: "**שניכם**", findings: [{ title: "בוקר", body: "היא פותחת.", quotes: [{ who: "Dana", text: "בוקר טוב" }, { who: "Roee", text: "משהו שלא נכתב מעולם" }] }], scores: [{ name: "חום", value: "גבוה" }] }, msgs, chatNumbers(chat()), "he");
  assert.equal(r.headline, "שניכם");
  assert.equal(r.findings[0]!.quotes.length, 1);
  assert.equal(r.scores[0]!.measured, true);
  assert.equal(r.scores[0]!.value, "50/50");
  assert.equal(r.scores.at(-1)!.name, "חום");
});

test("a long chat is read in parts spread over all of it", () => {
  const lines = Array.from({ length: 1000 }, (_, i) => `line ${i} ${"x".repeat(90)}`);
  const { parts, total } = chatParts(lines, 10_000, 4);
  assert.equal(parts.length, 4);
  assert.ok(total > 4);
  assert.ok(parts[3]!.includes("line 7"));
});

test("a report is written from the model's notes, with checked quotes, and a follow-up answers from the chat", async () => {
  const reports = new ChatReports(await mkdtemp(join(tmpdir(), "chat-reports-")));
  const ask = async (system: string) => (system.includes("part of a chat")
    ? JSON.stringify({ notes: ["Dana opens the mornings"], quotes: [{ who: "Dana", text: "בוקר טוב! מה שלומך?" }] })
    : system.includes("one question")
      ? JSON.stringify({ answer: "היא שואלת לשלומך כל בוקר.", quotes: [{ who: "Dana", text: "מה שלומך" }] })
      : JSON.stringify({ headline: "הבוקר שלה, הלילה שלך", read: "קצר.", findings: [{ title: "בוקר", body: "היא פותחת.", measured: true, quotes: [{ who: "Dana", text: "בוקר טוב" }] }], roles: [{ name: "Dana", role: "פותחת" }], next: "תפתח אתה מחר." }));
  const r = await reports.start(chat(), { kind: "couple", voice: "friend", lang: "he", me: "Roee" }, ask);
  for (let i = 0; i < 50 && (await reports.get(r.id)).status !== "done"; i++) await new Promise((x) => setTimeout(x, 20));
  const done = await reports.get(r.id);
  assert.equal(done.status, "done");
  assert.equal(done.report?.headline, "הבוקר שלה, הלילה שלך");
  assert.equal(done.report?.findings[0]?.quotes[0]?.who, "Dana");
  const f = await reports.followUp(r.id, "מי שואל לשלום?", ask);
  assert.equal(f.quotes.length, 1);
  assert.equal((await reports.list()).length, 1);
  await reports.remove(r.id);
  assert.equal((await reports.list()).length, 0);
});
