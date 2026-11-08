/**
 * Reads chat history exported from other assistants, so it can be kept and
 * continued in KesherAI:
 *
 * - **ChatGPT**: Settings → Data controls → Export data. The zip has
 *   `conversations.json` (each chat is a tree of messages; the branch the
 *   user last saw is kept).
 * - **Claude**: Settings → Privacy → Export data. The zip has
 *   `conversations.json` (each chat has `chat_messages`).
 * - **Gemini**: Google Takeout → "My Activity" → "Gemini Apps", in JSON
 *   format. It has `MyActivity.json`: one entry per prompt and answer, with
 *   no chat ids, so prompts less than 30 minutes apart are joined into one chat.
 */

/** Where an imported chat came from. */
export type ImportSource = "chatgpt" | "claude" | "gemini";

/** One message of an imported chat. */
export interface ImportedMessage {
  role: "user" | "assistant";
  text: string;
  /** ISO time, when the export has it. */
  at?: string;
}

/** One chat, ready to save. */
export interface ImportedChat {
  source: ImportSource;
  /** The chat's id in the other app (keeps a second import from adding it again). */
  originalId: string;
  title: string;
  createdAt: string;
  messages: ImportedMessage[];
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Seconds (ChatGPT) or an ISO string to ISO. */
function iso(v: unknown, fallback = new Date(0).toISOString()): string {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v * 1000).toISOString();
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return fallback;
}

/**
 * Which app an export is from.
 *
 * @param data - The parsed JSON file.
 * @returns The source, or undefined when it is none of them.
 */
export function detectSource(data: unknown): ImportSource | undefined {
  if (!Array.isArray(data) || !data.length) return undefined;
  const first = data.find(isObj);
  if (!first) return undefined;
  if (isObj(first.mapping)) return "chatgpt";
  if (Array.isArray(first.chat_messages)) return "claude";
  if (typeof first.header === "string" && /gemini|bard/i.test(first.header)) return "gemini";
  if (data.some((d) => isObj(d) && typeof d.header === "string" && /gemini|bard/i.test(d.header))) return "gemini";
  return undefined;
}

/** The text of a ChatGPT message's content (text parts only; images and files are left out). */
function chatgptText(content: unknown): string {
  if (!isObj(content)) return "";
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const text = parts.map((p) => (typeof p === "string" ? p : isObj(p) && typeof p.text === "string" ? p.text : "")).filter(Boolean).join("\n");
  return text || str(content.text);
}

function fromChatGpt(data: unknown[]): ImportedChat[] {
  const out: ImportedChat[] = [];
  for (const c of data) {
    if (!isObj(c) || !isObj(c.mapping)) continue;
    const mapping = c.mapping as Record<string, Json>;
    // The branch the user last saw: from current_node up to the root.
    let node = str(c.current_node) || Object.keys(mapping).find((k) => !(mapping[k]?.children as unknown[] | undefined)?.length) || "";
    const chain: Json[] = [];
    const seen = new Set<string>();
    while (node && mapping[node] && !seen.has(node)) {
      seen.add(node);
      chain.push(mapping[node]!);
      node = str(mapping[node]!.parent);
    }
    chain.reverse();
    const messages: ImportedMessage[] = [];
    for (const n of chain) {
      const m = n.message;
      if (!isObj(m) || !isObj(m.author)) continue;
      const role = m.author.role;
      if (role !== "user" && role !== "assistant") continue;
      if (isObj(m.metadata) && m.metadata.is_visually_hidden_from_conversation) continue;
      if (isObj(m.content) && m.content.content_type && !["text", "multimodal_text"].includes(str(m.content.content_type))) continue;
      const text = chatgptText(m.content).trim();
      if (!text) continue;
      messages.push({ role, text, ...(m.create_time ? { at: iso(m.create_time) } : {}) });
    }
    if (!messages.length) continue;
    out.push({ source: "chatgpt", originalId: str(c.conversation_id) || str(c.id) || `${c.create_time}`, title: str(c.title) || messages[0]!.text.slice(0, 60), createdAt: iso(c.create_time), messages });
  }
  return out;
}

function fromClaude(data: unknown[]): ImportedChat[] {
  const out: ImportedChat[] = [];
  for (const c of data) {
    if (!isObj(c) || !Array.isArray(c.chat_messages)) continue;
    const messages: ImportedMessage[] = [];
    for (const m of c.chat_messages) {
      if (!isObj(m)) continue;
      const role = m.sender === "human" ? "user" : m.sender === "assistant" ? "assistant" : undefined;
      if (!role) continue;
      const parts = Array.isArray(m.content) ? m.content.filter((p): p is Json => isObj(p) && p.type === "text").map((p) => str(p.text)) : [];
      const text = (parts.join("\n").trim() || str(m.text)).trim();
      if (!text) continue;
      messages.push({ role, text, ...(m.created_at ? { at: iso(m.created_at) } : {}) });
    }
    if (!messages.length) continue;
    out.push({ source: "claude", originalId: str(c.uuid) || str(c.created_at), title: str(c.name) || messages[0]!.text.slice(0, 60), createdAt: iso(c.created_at), messages });
  }
  return out;
}

/** HTML (Gemini's answers in Takeout) to plain text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|pre|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function fromGemini(data: unknown[]): ImportedChat[] {
  const entries = data
    .filter((d): d is Json => isObj(d) && /gemini|bard/i.test(str(d.header)) && /^Prompted /.test(str(d.title)))
    .map((d) => ({
      at: iso(d.time),
      prompt: str(d.title).replace(/^Prompted\s+/, "").trim(),
      answer: htmlToText((Array.isArray(d.safeHtmlItem) ? d.safeHtmlItem : []).map((h) => (isObj(h) ? str(h.html) : "")).join("\n")),
    }))
    .filter((e) => e.prompt)
    .sort((a, b) => a.at.localeCompare(b.at));
  const out: ImportedChat[] = [];
  let current: ImportedChat | undefined;
  let last = 0;
  for (const e of entries) {
    const t = Date.parse(e.at);
    if (!current || t - last > 30 * 60_000) {
      current = { source: "gemini", originalId: e.at, title: e.prompt.slice(0, 60), createdAt: e.at, messages: [] };
      out.push(current);
    }
    last = t;
    current.messages.push({ role: "user", text: e.prompt, at: e.at });
    if (e.answer) current.messages.push({ role: "assistant", text: e.answer, at: e.at });
  }
  return out;
}

/**
 * Reads the chats in an export.
 *
 * @param data - The parsed `conversations.json` or `MyActivity.json`.
 * @returns The source and its chats.
 * @throws Error when the file is not an export KesherAI knows.
 */
export function readExport(data: unknown): { source: ImportSource; chats: ImportedChat[] } {
  const source = detectSource(data);
  if (!source) throw new Error("This is not a chat export KesherAI knows. Use conversations.json from ChatGPT or Claude, or MyActivity.json (JSON format) from Google Takeout for Gemini.");
  const list = data as unknown[];
  const chats = source === "chatgpt" ? fromChatGpt(list) : source === "claude" ? fromClaude(list) : fromGemini(list);
  return { source, chats };
}
