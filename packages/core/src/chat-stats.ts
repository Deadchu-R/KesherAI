import { readFile } from "node:fs/promises";
import type { AgentTool } from "@kesher/agent";
import { resolveForTool } from "@kesher/agent";

/**
 * The numbers behind a conversation between people (for the relationship
 * analyst persona): who writes more, who starts conversations, how fast
 * each side answers, who asks questions, late-night messages, emojis, and
 * how it changed month by month. Read from an exported chat — WhatsApp
 * (.txt, both date styles), Telegram (result.json) or plain "Name: text"
 * lines — entirely on this computer: the chat never leaves it.
 */

/** One message of an exported chat. */
export interface ChatMessage {
  at?: Date;
  from: string;
  text: string;
}

/** How long a silence starts a new conversation. */
const NEW_TALK_MS = 4 * 3600_000;

/** WhatsApp: "[31/12/2023, 21:41:02] Name: text", "12/31/23, 9:41 PM - Name: text", and similar. */
const WA = /^‎?\[?(\d{1,4})[./-](\d{1,2})[./-](\d{1,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?\]?\s*(?:-|–)?\s*([^:]{1,60}):\s?(.*)$/;

function waDate(a: string, b: string, c: string, h: string, mi: string, s: string | undefined, ampm: string | undefined, dayFirst: boolean): Date | undefined {
  let [d, m, y] = dayFirst ? [Number(a), Number(b), Number(c)] : [Number(b), Number(a), Number(c)];
  if (a.length === 4) [y, m, d] = [Number(a), Number(b), Number(c)];
  if (y < 100) y += 2000;
  let hour = Number(h);
  if (ampm) {
    const pm = /p/i.test(ampm);
    if (pm && hour < 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
  }
  const date = new Date(y, m - 1, d, hour, Number(mi), Number(s ?? 0));
  return Number.isNaN(date.getTime()) || m < 1 || m > 12 || d < 1 || d > 31 ? undefined : date;
}

/**
 * Reads an exported chat in any of the formats above.
 *
 * @returns The messages in order (system lines like "Messages are end-to-end encrypted" left out).
 */
export function parseChat(raw: string): ChatMessage[] {
  const text = raw.replace(/^\uFEFF/, "");
  // Telegram's export (Settings → Export chat history → JSON).
  if (/^\s*\{/.test(text)) {
    try {
      const j = JSON.parse(text) as { messages?: Array<{ type?: string; date?: string; from?: string; text?: unknown }> };
      return (j.messages ?? [])
        .filter((m) => m.type === "message" && m.from)
        .map((m) => ({
          ...(m.date ? { at: new Date(m.date) } : {}),
          from: String(m.from),
          text: Array.isArray(m.text) ? m.text.map((p) => (typeof p === "string" ? p : String((p as { text?: string }).text ?? ""))).join("") : String(m.text ?? ""),
        }));
    } catch {
      // not JSON after all
    }
  }
  const lines = text.split(/\r?\n/);
  // Day first (most of the world) unless a first number is above 12 only in the second place.
  const firsts = lines.map((l) => WA.exec(l)).filter((m): m is RegExpExecArray => !!m);
  const dayFirst = !firsts.some((m) => Number(m[2]) > 12) || firsts.some((m) => Number(m[1]) > 12);
  const out: ChatMessage[] = [];
  for (const line of lines) {
    const m = WA.exec(line);
    if (m) {
      const at = waDate(m[1]!, m[2]!, m[3]!, m[4]!, m[5]!, m[6], m[7], dayFirst);
      out.push({ ...(at ? { at } : {}), from: m[8]!.trim(), text: m[9]!.trim() });
      continue;
    }
    const plain = /^([^:\n]{1,40}):\s(.+)$/.exec(line);
    if (plain && !firsts.length) out.push({ from: plain[1]!.trim(), text: plain[2]!.trim() });
    else if (out.length && line.trim()) out[out.length - 1]!.text += `\n${line}`;
  }
  return out.filter((m) => !/end-to-end encrypted|<Media omitted>|added|left|changed (the )?(subject|this group|their phone)/i.test(m.text) || m.text.length > 80);
}

const EMOJI = /\p{Extended_Pictographic}/gu;

/** The numbers for one chat. */
export function chatStats(messages: ChatMessage[]) {
  const people = new Map<string, { messages: number; words: number; starts: number; questions: number; lateNight: number; emojis: Map<string, number>; replyMs: number[]; longest: number }>();
  const get = (n: string) => {
    let p = people.get(n);
    if (!p) people.set(n, (p = { messages: 0, words: 0, starts: 0, questions: 0, lateNight: 0, emojis: new Map(), replyMs: [], longest: 0 }));
    return p;
  };
  const months = new Map<string, Map<string, number>>();
  let prev: ChatMessage | undefined;
  for (const m of messages) {
    const p = get(m.from);
    p.messages++;
    p.words += m.text.split(/\s+/).filter(Boolean).length;
    p.longest = Math.max(p.longest, m.text.length);
    if (/\?/.test(m.text)) p.questions++;
    for (const e of m.text.match(EMOJI) ?? []) p.emojis.set(e, (p.emojis.get(e) ?? 0) + 1);
    if (m.at) {
      const h = m.at.getHours();
      if (h >= 0 && h < 5) p.lateNight++;
      const key = `${m.at.getFullYear()}-${String(m.at.getMonth() + 1).padStart(2, "0")}`;
      const mm = months.get(key) ?? new Map<string, number>();
      mm.set(m.from, (mm.get(m.from) ?? 0) + 1);
      months.set(key, mm);
    }
    const gap = m.at && prev?.at ? m.at.getTime() - prev.at.getTime() : undefined;
    if (!prev || (gap !== undefined && gap > NEW_TALK_MS)) p.starts++;
    else if (prev.from !== m.from && gap !== undefined && gap >= 0) p.replyMs.push(gap);
    prev = m;
  }
  const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : undefined);
  const total = messages.length || 1;
  return {
    messages: messages.length,
    from: messages.find((m) => m.at)?.at?.toISOString().slice(0, 10),
    to: [...messages].reverse().find((m) => m.at)?.at?.toISOString().slice(0, 10),
    people: [...people.entries()]
      .sort((a, b) => b[1].messages - a[1].messages)
      .map(([name, p]) => ({
        name,
        messages: p.messages,
        share: Math.round((p.messages / total) * 100),
        wordsPerMessage: Math.round((p.words / Math.max(1, p.messages)) * 10) / 10,
        startsConversations: p.starts,
        medianReplyMinutes: median(p.replyMs) !== undefined ? Math.round(median(p.replyMs)! / 60_000) : undefined,
        questions: p.questions,
        lateNightMessages: p.lateNight,
        topEmojis: [...p.emojis.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([e, n]) => `${e}×${n}`),
      })),
    byMonth: [...months.entries()].sort().map(([month, m]) => ({ month, ...Object.fromEntries(m) })),
  };
}

/** The chat tool: the numbers of an exported chat the user attached (or pasted). */
export const analyzeChatTool: AgentTool = {
  risk: "read",
  spec: {
    name: "analyze_chat",
    description: "Count what happens in a conversation between people, from an exported chat the user attached (WhatsApp .txt, Telegram result.json) or pasted text: messages and share per person, who starts conversations, median reply time, questions, late-night messages, top emojis, and messages per month. Runs on this computer; use its numbers in the analysis.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The attached file (as \"[Attached: …]\" names it)." },
        text: { type: "string", description: "Or the chat pasted as text." },
      },
    },
  },
  async run(input, ctx) {
    let raw = typeof input.text === "string" ? input.text : "";
    if (!raw && input.path) {
      const rel = String(input.path).replace(/^\[?Attached:\s*/i, "").replace(/\]$/, "").trim();
      const file = await resolveForTool(ctx.workspace, ctx.extraRoots ?? [], rel);
      raw = await readFile(file, "utf8");
    }
    if (!raw.trim()) return { output: "Attach the exported chat (WhatsApp: the chat → ⋮ → More → Export chat → Without media) or paste it." };
    const messages = parseChat(raw.slice(0, 20_000_000));
    if (messages.length < 2) return { output: "Could not read messages from that. For WhatsApp, export the chat as a .txt (Without media); for Telegram, the JSON export." };
    const s = chatStats(messages);
    const json = JSON.stringify(s, null, 1);
    return { output: json.length > 12_000 ? `${json.slice(0, 12_000)}\n… (cut)` : json };
  },
};
