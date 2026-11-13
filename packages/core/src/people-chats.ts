import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Chats with people (WhatsApp, Instagram), brought in to be read and analysed by the models on this computer.
 *
 * How the exports look (researched first):
 * - **WhatsApp**: chat → ⋮ → More → "Export chat" gives a `.txt` (or a zip with the `.txt` and media). One
 *   message per line, the date written in the phone's own format: Android `13/11/2026, 16:20 - Dana: hi`,
 *   iPhone `[13/11/2026, 16:20:11] Dana: hi`; some locales use dots or a 12-hour clock. A line that does not
 *   start with a date continues the message above it. Lines with no "Name:" are WhatsApp's own notices.
 * - **Instagram**: Settings → Accounts Center → "Download your information" (JSON) gives
 *   `messages/inbox/<thread>/message_1.json` (more files for long chats), newest message first, with text that
 *   was UTF-8 written out as Latin-1 (Hebrew shows as "×©×"), which is put back here.
 *
 * What is kept: one text file per month, plus a summary (who, how many messages, when), in KesherAI's data
 * folder, as a knowledge base the models search. Nothing is sent anywhere: these are other people's words too,
 * so they stay on this computer (a cloud model, if the user picks one, gets only the passages a chat reads).
 */

/** One message. */
export interface PersonMessage {
  /** ISO time; "" when the line's date could not be read. */
  at: string;
  sender: string;
  text: string;
}

/** A chat with people. */
export interface PeopleChat {
  source: "whatsapp" | "instagram";
  title: string;
  messages: PersonMessage[];
}

const MARKS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
// [13/11/2026, 16:20:11] Name: text   |   13/11/2026, 16:20 - Name: text   (dots, dashes, 12-hour clocks too)
const WA_LINE = /^\[?(\d{1,4})[./-](\d{1,2})[./-](\d{1,4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*([AaPp]\.?[Mm]\.?|לפנה״צ|אחה״צ)?\]?\s*(?:-\s*)?(.*)$/;

/**
 * Reads a WhatsApp "Export chat" text file.
 *
 * @param text - The file's text.
 * @param title - The chat's name (from the file's name).
 * @returns The chat.
 */
export function parseWhatsApp(text: string, title = "WhatsApp"): PeopleChat {
  const rows: Array<{ a: number; b: number; c: number; h: number; mi: number; s: number; pm?: boolean; am?: boolean; rest: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(MARKS, "").replace(/[\u202f\u00a0]/g, " ");
    const m = WA_LINE.exec(line);
    if (m) {
      const half = m[7] ?? "";
      rows.push({ a: Number(m[1]), b: Number(m[2]), c: Number(m[3]), h: Number(m[4]), mi: Number(m[5]), s: Number(m[6] ?? 0), ...(/^p|אחה/i.test(half) ? { pm: true } : /^a|לפנה/i.test(half) ? { am: true } : {}), rest: m[8] ?? "" });
    } else if (rows.length && line.trim()) {
      rows[rows.length - 1]!.rest += `\n${line}`;
    }
  }
  // Which number is the day? A year first means year-month-day; otherwise a number above 12 settles it; with no
  // such number, day first (how most of the world, Israel included, writes dates).
  const yearFirst = rows.some((r) => r.a > 31);
  const monthFirst = !yearFirst && !rows.some((r) => r.a > 12) && rows.some((r) => r.b > 12);
  const messages: PersonMessage[] = [];
  for (const r of rows) {
    const sep = r.rest.indexOf(": ");
    // WhatsApp's own notices ("Messages are end-to-end encrypted", "Dana added Noa") have no sender.
    if (sep < 1 || sep > 60) continue;
    const sender = r.rest.slice(0, sep).trim();
    const body = r.rest.slice(sep + 2).trim();
    if (!body) continue;
    const [y, mo, d] = yearFirst ? [r.a, r.b, r.c] : monthFirst ? [r.c, r.a, r.b] : [r.c, r.b, r.a];
    const year = y < 100 ? 2000 + y : y;
    const hour = r.pm && r.h < 12 ? r.h + 12 : r.am && r.h === 12 ? 0 : r.h;
    const ok = mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && hour < 24;
    const pad = (n: number) => String(n).padStart(2, "0");
    messages.push({ at: ok ? `${year}-${pad(mo)}-${pad(d)}T${pad(hour)}:${pad(r.mi)}:${pad(r.s)}` : "", sender, text: body });
  }
  return { source: "whatsapp", title, messages };
}

/** Instagram writes UTF-8 bytes as Latin-1 characters: put the text back ("×©×" → "ש…"). */
function fixInstagramText(s: string): string {
  if (![...s].some((c) => c.charCodeAt(0) >= 0x80) || [...s].some((c) => c.charCodeAt(0) > 0xff)) return s;
  const fixed = Buffer.from(s, "latin1").toString("utf8");
  return fixed.includes("�") ? s : fixed;
}

/**
 * Reads Instagram's `message_N.json` files of one thread.
 *
 * @param parts - The parsed files (any order).
 * @returns The chat, oldest message first.
 */
export function parseInstagram(parts: unknown[]): PeopleChat {
  const messages: PersonMessage[] = [];
  let title = "";
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    const o = p as { title?: unknown; messages?: unknown };
    if (!title && typeof o.title === "string") title = fixInstagramText(o.title);
    for (const m of Array.isArray(o.messages) ? o.messages : []) {
      const x = m as { sender_name?: unknown; timestamp_ms?: unknown; content?: unknown; share?: { link?: unknown }; photos?: unknown; videos?: unknown; audio_files?: unknown };
      const sender = typeof x.sender_name === "string" ? fixInstagramText(x.sender_name) : "";
      const t = typeof x.timestamp_ms === "number" ? x.timestamp_ms : NaN;
      let text = typeof x.content === "string" ? fixInstagramText(x.content) : "";
      if (!text) text = Array.isArray(x.photos) ? "[photo]" : Array.isArray(x.videos) ? "[video]" : Array.isArray(x.audio_files) ? "[voice message]" : typeof x.share?.link === "string" ? `[shared] ${x.share.link}` : "";
      if (!sender || !text) continue;
      messages.push({ at: Number.isFinite(t) ? new Date(t).toISOString().slice(0, 19) : "", sender, text });
    }
  }
  if (!messages.length) throw new Error("This file has no Instagram messages. Use message_1.json from messages/inbox/<the chat> in Instagram's export (JSON format).");
  messages.sort((a, b) => a.at.localeCompare(b.at));
  return { source: "instagram", title: title || "Instagram", messages };
}

/** What a chat holds, in numbers. */
export interface PeopleChatStats {
  messages: number;
  from: string;
  to: string;
  people: Array<{ name: string; messages: number; words: number }>;
  months: Array<{ month: string; messages: number }>;
}

/**
 * @param chat - The chat.
 * @returns Who wrote how much, and when.
 */
export function chatStats(chat: PeopleChat): PeopleChatStats {
  const people = new Map<string, { messages: number; words: number }>();
  const months = new Map<string, number>();
  for (const m of chat.messages) {
    const p = people.get(m.sender) ?? { messages: 0, words: 0 };
    p.messages++;
    p.words += m.text.split(/\s+/).filter(Boolean).length;
    people.set(m.sender, p);
    const month = m.at.slice(0, 7) || "unknown";
    months.set(month, (months.get(month) ?? 0) + 1);
  }
  const dated = chat.messages.filter((m) => m.at);
  return {
    messages: chat.messages.length,
    from: dated[0]?.at.slice(0, 10) ?? "",
    to: dated.at(-1)?.at.slice(0, 10) ?? "",
    people: [...people].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.messages - a.messages),
    months: [...months].map(([month, messages]) => ({ month, messages })).sort((a, b) => a.month.localeCompare(b.month)),
  };
}

/** A folder-safe name. */
export function chatSlug(source: string, title: string): string {
  const base = title.normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "chat";
  return `${source}-${base}`;
}

/**
 * Writes a chat as text files (one per month, and a summary) for a knowledge base.
 *
 * @param dir - The chat's own folder (emptied first).
 * @param chat - The chat.
 * @returns Its numbers.
 */
export async function writePeopleChat(dir: string, chat: PeopleChat): Promise<PeopleChatStats> {
  const stats = chatStats(chat);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const byMonth = new Map<string, string[]>();
  for (const m of chat.messages) {
    const month = m.at.slice(0, 7) || "unknown";
    const list = byMonth.get(month) ?? [];
    list.push(`[${m.at ? m.at.replace("T", " ").slice(0, 16) : "?"}] ${m.sender}: ${m.text}`);
    byMonth.set(month, list);
  }
  for (const [month, lines] of byMonth) {
    await writeFile(join(dir, `${month}.md`), `# ${chat.title}: ${month}\n\n${lines.join("\n")}\n`, "utf8");
  }
  const app = chat.source === "whatsapp" ? "WhatsApp" : "Instagram";
  const summary = [
    `# ${chat.title} (${app}): summary`,
    "",
    `A chat between people, brought in from ${app}. ${stats.messages} messages, from ${stats.from || "?"} to ${stats.to || "?"}. The messages are in the files next to this one, one file per month (named YYYY-MM).`,
    "",
    "## Who wrote how much",
    ...stats.people.map((p) => `- ${p.name}: ${p.messages} messages, ${p.words} words`),
    "",
    "## Messages per month",
    ...stats.months.map((m) => `- ${m.month}: ${m.messages}`),
    "",
  ].join("\n");
  await writeFile(join(dir, "summary.md"), summary, "utf8");
  return stats;
}
