import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chatSlug, chatStats, parseInstagram, parseWhatsApp, writePeopleChat } from "./people-chats.js";

test("WhatsApp: Android and iPhone lines, multi-line messages, notices skipped, day-first dates", () => {
  const android = ["13/11/2026, 16:20 - Messages and calls are end-to-end encrypted.", "13/11/2026, 16:20 - דנה: היי", "מה שלומך?", "13/11/2026, 16:21 - Roee: בסדר: ואת?", "14/11/2026, 9:05 - דנה: <Media omitted>"].join("\n");
  const a = parseWhatsApp(android, "דנה");
  assert.deepEqual(a.messages, [
    { at: "2026-11-13T16:20:00", sender: "דנה", text: "היי\nמה שלומך?" },
    { at: "2026-11-13T16:21:00", sender: "Roee", text: "בסדר: ואת?" },
    { at: "2026-11-14T09:05:00", sender: "דנה", text: "<Media omitted>" },
  ]);
  const ios = "‎[11/13/26, 4:20:11 PM] Dana: hi\n[11/13/26, 12:01:00 AM] Roee: late";
  assert.deepEqual(parseWhatsApp(ios).messages.map((m) => m.at), ["2026-11-13T16:20:11", "2026-11-13T00:01:00"]);
  assert.deepEqual(parseWhatsApp("2026-11-13, 16:20 - A: x").messages[0]!.at, "2026-11-13T16:20:00");
});

test("Instagram: text put back from Latin-1, oldest first, media named", () => {
  const he = Buffer.from("שלום", "utf8").toString("latin1");
  const chat = parseInstagram([{ title: "Dana", messages: [{ sender_name: "Dana", timestamp_ms: 1794579700000, photos: [{}] }, { sender_name: "Roee", timestamp_ms: 1794579611000, content: he }] }]);
  assert.deepEqual(chat.messages.map((m) => [m.sender, m.text]), [["Roee", "שלום"], ["Dana", "[photo]"]]);
  assert.throws(() => parseInstagram([{ nothing: true }]), /no Instagram messages/);
});

test("a chat is written as month files and a summary", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "kesher-people-")), "c");
  const chat = parseWhatsApp("31/10/2026, 10:00 - A: one two\n01/11/2026, 10:00 - B: three\n01/11/2026, 10:01 - A: four", "A and B");
  const stats = await writePeopleChat(dir, chat);
  assert.deepEqual(stats, chatStats(chat));
  assert.equal(stats.people[0]!.name, "A");
  assert.deepEqual((await readdir(dir)).sort(), ["2026-10.md", "2026-11.md", "summary.md"]);
  assert.match(await readFile(join(dir, "2026-11.md"), "utf8"), /\[2026-11-01 10:00\] B: three/);
  assert.equal(chatSlug("whatsapp", "דנה / work!"), "whatsapp-דנה-work");
});
