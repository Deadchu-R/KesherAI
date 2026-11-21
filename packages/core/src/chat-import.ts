/**
 * Reads chat history exported from other assistants, so it can be kept and
 * continued in KesherAI (research: docs/RESEARCH_LOG.md, "Import from other apps", 2026-11-21):
 *
 * - **ChatGPT**: Settings → Data controls → Export data. The zip has
 *   `conversations.json` (newer exports split it into `conversations-000.json`, …). Each chat is a tree of
 *   messages (`mapping`): the branch the user last saw (`current_node`) becomes the chat, and every other branch
 *   (an edited message, another answer) becomes a KesherAI branch of it. Pictures are files in the zip, pointed to
 *   by `file-service://file-…` or `sediment://file_…`.
 * - **Claude**: Settings → Privacy → Export data. The zip has `conversations.json` (each chat has `chat_messages`;
 *   attachments carry their text, not their bytes) and `projects.json` (each project's instructions → a persona).
 * - **Gemini**: Google Takeout → "My Activity" → "Gemini Apps" (`MyActivity.json`, or the default HTML). One entry
 *   per prompt and answer. When an entry links its chat (`titleUrl` …/app/<id>) chats are rebuilt from those ids;
 *   otherwise they are a guess by time (see {@link GeminiSplit}).
 * - **Open WebUI**: Settings → Data Controls → Export Chats: a tree of messages (`parentId`), read like ChatGPT's.
 * - **LM Studio**: a chat's `.conversation.json` (in LM Studio's `conversations` folder): each message has
 *   `versions` (the one shown is `currentlySelected`; the others become branches).
 *
 * Each item of an export is read on its own ({@link ExportReader}), so a big export is read in a stream
 * (import-stream.ts) and never held whole.
 */

import { createHash } from "node:crypto";

/** Where an imported chat came from. */
export type ImportSource = "chatgpt" | "claude" | "gemini" | "openwebui" | "lmstudio" | "jan" | "claude-code" | "phone";

/** The apps an export file can come from (the ones the import page reads). */
export const EXPORT_SOURCES = ["chatgpt", "claude", "gemini", "openwebui", "lmstudio", "jan"] as const;

/** A file a message had in the other app. */
export interface ImportedFile {
  /** Its name, as the user saw it. */
  name: string;
  /** Where its bytes are in the export's zip: a ChatGPT pointer (`file-service://file-…`) or `gemini:<name>`. */
  ref?: string;
  /** Its bytes, when the export holds them inline (base64; Open WebUI's pictures). */
  data?: string;
  /** Its text, when the export holds only that (Claude's attachments). */
  text?: string;
}

/** One message of an imported chat. */
export interface ImportedMessage {
  role: "user" | "assistant";
  text: string;
  /** ISO time, when the export has it. */
  at?: string;
  /** Pictures and files the message had. */
  files?: ImportedFile[];
}

/** One chat, ready to save. */
export interface ImportedChat {
  source: ImportSource;
  /** The chat's id in the other app (keeps a second import from adding it again). */
  originalId: string;
  title: string;
  createdAt: string;
  messages: ImportedMessage[];
  /** A coding session's folder: it becomes a code chat there. */
  workspace?: string;
  /**
   * Another branch of a chat in the other app (an edited message or another answer): the chat it splits from and
   * the place it splits at (1-based, as KesherAI's event `seq`). Everything before that place is the same in both.
   */
  branchOf?: { originalId: string; seq: number };
  /** For a branch: the `originalId` of the chat it belongs to (picking that chat picks its branches). */
  root?: string;
}

/** Instructions found in an export (ChatGPT's custom instructions, a Claude project, an LM Studio chat's prompt). */
export interface ExportPersona {
  name: string;
  instructions: string;
  params?: { temperature?: number; topP?: number };
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const numOr = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** The most branches kept for one chat (a chat regenerated 200 times does not become 200 chats). */
const MAX_BRANCHES = 20;

/** Seconds (ChatGPT, Open WebUI), milliseconds (LM Studio) or an ISO string to ISO. */
function iso(v: unknown, fallback = new Date(0).toISOString()): string {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v > 1e12 ? v : v * 1000).toISOString();
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return fallback;
}

/**
 * The KesherAI id an imported chat gets: the same every time, so importing the same export again skips it.
 *
 * @param source - Where it came from.
 * @param originalId - Its id there.
 * @returns A UUID-shaped id.
 */
export function importedChatId(source: ImportSource, originalId: string): string {
  const h = createHash("sha256").update(`${source}:${originalId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Which app one item of an export is from (the item is a chat, a project or an activity entry).
 *
 * @param item - One element of the export's list (or the file's single object).
 * @returns The source, `claude-projects` for Claude's projects.json, or undefined.
 */
export function detectItem(item: unknown): ImportSource | "claude-projects" | undefined {
  if (!isObj(item)) return undefined;
  if (isObj(item.mapping)) return "chatgpt";
  // Open WebUI: `{ chat: { title, history: { currentId, messages } } }` (older files have no `chat` wrapper).
  if (isObj(item.chat) && isObj((item.chat as Json).history)) return "openwebui";
  if (isObj(item.history) && isObj((item.history as Json).messages)) return "openwebui";
  if (Array.isArray(item.chat_messages)) return "claude";
  if (typeof item.header === "string" && /gemini|bard/i.test(item.header)) return "gemini";
  if (Array.isArray(item.messages) && item.messages.some((m) => isObj(m) && Array.isArray(m.versions))) return "lmstudio";
  if (typeof item.uuid === "string" && "prompt_template" in item) return "claude-projects";
  return undefined;
}

/**
 * Which app an export is from.
 *
 * @param data - The parsed JSON file.
 * @returns The source, or undefined when it is none of them.
 */
export function detectSource(data: unknown): ImportSource | undefined {
  const list = Array.isArray(data) ? data : isObj(data) ? [data] : [];
  for (const item of list.slice(0, 50)) {
    const s = detectItem(item);
    if (s && s !== "claude-projects") return s;
  }
  return undefined;
}

/** A message tree (ChatGPT's `mapping`, Open WebUI's `history.messages`) as plain nodes. */
interface TreeNode { parent: string; children: string[] }

/**
 * The paths through a message tree: the one the user last saw first, then every other leaf's (up to
 * {@link MAX_BRANCHES}), each from the root down.
 */
function treePaths(nodes: Record<string, TreeNode>, current: string): string[][] {
  const up = (leaf: string): string[] => {
    const chain: string[] = [];
    const seen = new Set<string>();
    for (let n = leaf; n && nodes[n] && !seen.has(n); n = nodes[n]!.parent) {
      seen.add(n);
      chain.push(n);
    }
    return chain.reverse();
  };
  const leaves = Object.keys(nodes).filter((k) => !nodes[k]!.children.some((c) => nodes[c]));
  const main = current && nodes[current] ? current : leaves.at(-1) ?? "";
  if (!main) return [];
  return [up(main), ...leaves.filter((l) => l !== main).slice(0, MAX_BRANCHES).map(up)];
}

/**
 * Turns the paths of a tree into a chat and its branches. Each node becomes zero or one message (`toMessage`);
 * a branch splits at the first node where it leaves the path it shares most with, and keeps going only when it
 * has a message of its own after that.
 */
function treeChats(base: Omit<ImportedChat, "messages">, paths: string[][], toMessage: (id: string) => ImportedMessage | undefined): ImportedChat[] {
  const memo = new Map<string, ImportedMessage | undefined>();
  const msg = (id: string) => (memo.has(id) ? memo.get(id) : (memo.set(id, toMessage(id)), memo.get(id)));
  const out: Array<{ chat: ImportedChat; path: string[] }> = [];
  for (const [i, path] of paths.entries()) {
    const messages = path.map(msg).filter((m): m is ImportedMessage => !!m);
    if (!messages.length) continue;
    if (i === 0 || !out.length) {
      out.push({ chat: { ...base, messages }, path });
      continue;
    }
    // The chat this branch shares the longest start with.
    let best = out[0]!;
    let shared = 0;
    for (const o of out) {
      let k = 0;
      while (k < path.length && k < o.path.length && path[k] === o.path[k]) k++;
      if (k > shared) [best, shared] = [o, k];
    }
    const before = path.slice(0, shared).map(msg).filter(Boolean).length;
    if (messages.length <= before) continue;
    const leaf = path.at(-1)!;
    out.push({ chat: { ...base, originalId: `${base.originalId}#${leaf}`, messages, branchOf: { originalId: best.chat.originalId, seq: before + 1 }, root: base.originalId, title: base.title }, path });
  }
  return out.map((o) => o.chat);
}

/** A ChatGPT picture pointer's name for the file (`file-service://file-Ab12` → `file-Ab12`). */
const pointerName = (p: string) => p.replace(/^[a-z-]+:\/\//i, "");

/** One ChatGPT node as a message (text, code, pictures), or undefined for system, hidden and tool-only steps. */
function chatgptMessage(node: Json | undefined): ImportedMessage | undefined {
  const m = node?.message;
  if (!isObj(m) || !isObj(m.author)) return undefined;
  const role = str(m.author.role);
  const content = isObj(m.content) ? m.content : {};
  const type = str(content.content_type) || "text";
  if (isObj(m.metadata) && m.metadata.is_visually_hidden_from_conversation) return undefined;
  const files: ImportedFile[] = [];
  const texts: string[] = [];
  if (type === "text" || type === "multimodal_text") {
    for (const p of Array.isArray(content.parts) ? content.parts : []) {
      if (typeof p === "string") texts.push(p);
      else if (isObj(p) && p.content_type === "image_asset_pointer" && typeof p.asset_pointer === "string") files.push({ name: pointerName(p.asset_pointer), ref: p.asset_pointer });
      else if (isObj(p) && typeof p.text === "string") texts.push(p.text);
    }
    if (!texts.length && typeof content.text === "string") texts.push(content.text);
  } else if (type === "code" && role === "assistant") {
    // Code the assistant ran (Code Interpreter): kept as a code block.
    const lang = str(content.language) === "unknown" ? "" : str(content.language);
    if (str(content.text).trim()) texts.push(`\`\`\`${lang || "python"}\n${str(content.text).trim()}\n\`\`\``);
  } else return undefined;
  // Files the user attached (named in metadata; pictures among them are also parts above).
  const meta = isObj(m.metadata) ? m.metadata : {};
  for (const a of Array.isArray(meta.attachments) ? meta.attachments : []) {
    if (!isObj(a) || typeof a.id !== "string") continue;
    const ref = `file-service://${a.id}`;
    const have = files.find((f) => pointerName(f.ref ?? "") === a.id);
    if (have) have.name = str(a.name) || have.name;
    else files.push({ name: str(a.name) || a.id, ref });
  }
  // A picture made by a tool (DALL·E) belongs to the assistant's answer.
  const as = role === "user" ? "user" : role === "assistant" || (role === "tool" && files.length && !texts.join("").trim()) ? "assistant" : undefined;
  if (!as) return undefined;
  const text = texts.join("\n").trim();
  if (!text && !files.length) return undefined;
  return { role: as, text, ...(m.create_time ? { at: iso(m.create_time) } : {}), ...(files.length ? { files } : {}) };
}

/** One ChatGPT conversation: the chat and its branches. */
function chatgptChats(c: Json): ImportedChat[] {
  const mapping = (isObj(c.mapping) ? c.mapping : {}) as Record<string, Json>;
  const nodes: Record<string, TreeNode> = {};
  for (const [k, n] of Object.entries(mapping)) if (isObj(n)) nodes[k] = { parent: str(n.parent), children: Array.isArray(n.children) ? n.children.map(str) : [] };
  const paths = treePaths(nodes, str(c.current_node));
  const originalId = str(c.conversation_id) || str(c.id) || `${c.create_time}`;
  const chats = treeChats({ source: "chatgpt", originalId, title: str(c.title), createdAt: iso(c.create_time) }, paths, (id) => chatgptMessage(mapping[id]));
  for (const ch of chats) ch.title ||= ch.messages[0]!.text.slice(0, 60) || "ChatGPT";
  return chats;
}

/** ChatGPT's custom instructions, which ride along in each chat as a hidden `user_editable_context` message. */
function chatgptInstructions(c: Json): { at: number; persona: ExportPersona } | undefined {
  let best: { at: number; persona: ExportPersona } | undefined;
  for (const n of Object.values(isObj(c.mapping) ? c.mapping : {})) {
    const m = isObj(n) ? n.message : undefined;
    if (!isObj(m) || !isObj(m.content) || m.content.content_type !== "user_editable_context") continue;
    const profile = str(m.content.user_profile).trim();
    const how = str(m.content.user_instructions).trim();
    if (!profile && !how) continue;
    const at = numOr(m.create_time) ?? numOr(c.update_time) ?? 0;
    if (!best || at > best.at) best = { at, persona: { name: "ChatGPT custom instructions", instructions: [profile, how].filter(Boolean).join("\n\n") } };
  }
  return best;
}

/** One Claude conversation. Artifacts (code the assistant wrote in a side panel) are kept as code blocks. */
function claudeChat(c: Json): ImportedChat | undefined {
  const messages: ImportedMessage[] = [];
  for (const m of Array.isArray(c.chat_messages) ? c.chat_messages : []) {
    if (!isObj(m)) continue;
    const role = m.sender === "human" ? "user" : m.sender === "assistant" ? "assistant" : undefined;
    if (!role) continue;
    const parts: string[] = [];
    for (const p of Array.isArray(m.content) ? m.content : []) {
      if (!isObj(p)) continue;
      if (p.type === "text") parts.push(str(p.text));
      else if (p.type === "tool_use" && isObj(p.input) && typeof p.input.content === "string" && p.input.content.trim()) {
        const lang = str(p.input.language) || (/markdown/.test(str(p.input.type)) ? "markdown" : /html/.test(str(p.input.type)) ? "html" : "");
        parts.push(`${str(p.input.title) ? `**${str(p.input.title)}**\n\n` : ""}\`\`\`${lang}\n${p.input.content.trim()}\n\`\`\``);
      }
    }
    const text = (parts.join("\n\n").trim() || str(m.text)).trim();
    const files: ImportedFile[] = [];
    for (const a of Array.isArray(m.attachments) ? m.attachments : []) if (isObj(a) && str(a.file_name)) files.push({ name: str(a.file_name), ...(str(a.extracted_content) ? { text: str(a.extracted_content) } : {}) });
    for (const f of Array.isArray(m.files) ? m.files : []) if (isObj(f) && str(f.file_name) && !files.some((x) => x.name === f.file_name)) files.push({ name: str(f.file_name) });
    if (!text && !files.length) continue;
    messages.push({ role, text, ...(m.created_at ? { at: iso(m.created_at) } : {}), ...(files.length ? { files } : {}) });
  }
  if (!messages.length) return undefined;
  return { source: "claude", originalId: str(c.uuid) || str(c.created_at), title: str(c.name) || messages[0]!.text.slice(0, 60) || "Claude", createdAt: iso(c.created_at), messages };
}

/** One Open WebUI chat: the chat and its branches. Pictures sent inline (`data:` URLs) are kept. */
function openWebUiChats(c: Json): { chats: ImportedChat[]; persona?: ExportPersona } {
  const chat = (isObj(c.chat) ? c.chat : c) as Json;
  const history = isObj(chat.history) ? chat.history : {};
  const msgs = (isObj(history.messages) ? history.messages : {}) as Record<string, Json>;
  const nodes: Record<string, TreeNode> = {};
  for (const [k, m] of Object.entries(msgs)) if (isObj(m)) nodes[k] = { parent: str(m.parentId), children: Array.isArray(m.childrenIds) ? m.childrenIds.map(str) : [] };
  // Older files have no childrenIds: rebuild them from the parents.
  for (const [k, n] of Object.entries(nodes)) if (n.parent && nodes[n.parent] && !nodes[n.parent]!.children.includes(k)) nodes[n.parent]!.children.push(k);
  const toMessage = (id: string): ImportedMessage | undefined => {
    const m = msgs[id];
    if (!m || (m.role !== "user" && m.role !== "assistant")) return undefined;
    const files: ImportedFile[] = [];
    for (const f of Array.isArray(m.files) ? m.files : []) {
      if (!isObj(f)) continue;
      const url = str(f.url);
      const data = /^data:[^;]+;base64,/.exec(url) ? url.slice(url.indexOf(",") + 1) : "";
      const ext = /^data:image\/(\w+)/.exec(url)?.[1] ?? "";
      const name = str(f.name) || (ext ? `image-${files.length + 1}.${ext === "jpeg" ? "jpg" : ext}` : "");
      const text = isObj(f.file) && isObj(f.file.data) ? str(f.file.data.content) : "";
      if (name) files.push({ name, ...(data ? { data } : {}), ...(text ? { text } : {}) });
    }
    const text = str(m.content).trim();
    if (!text && !files.length) return undefined;
    return { role: m.role, text, ...(typeof m.timestamp === "number" ? { at: iso(m.timestamp) } : {}), ...(files.length ? { files } : {}) };
  };
  const base = { source: "openwebui" as const, originalId: str(c.id) || `${c.created_at ?? chat.timestamp}`, title: str(chat.title), createdAt: iso(c.created_at ?? chat.timestamp) };
  const chats = treeChats(base, treePaths(nodes, str(history.currentId)), toMessage);
  for (const ch of chats) ch.title ||= ch.messages[0]!.text.slice(0, 60) || "Open WebUI";
  const params = isObj(chat.params) ? chat.params : {};
  const system = str(params.system).trim() || str(chat.system).trim();
  return { chats, ...(system ? { persona: { name: `Open WebUI: ${(str(chat.title) || "chat").slice(0, 40)}`, instructions: system, params: cleanTemps(params.temperature, params.top_p) } } : {}) };
}

/** Temperature and top-p, when they are numbers in range. */
function cleanTemps(temperature: unknown, topP: unknown): ExportPersona["params"] {
  const t = numOr(temperature);
  const p = numOr(topP);
  const out = { ...(t !== undefined && t >= 0 && t <= 2 ? { temperature: t } : {}), ...(p !== undefined && p > 0 && p <= 1 ? { topP: p } : {}) };
  return Object.keys(out).length ? out : undefined;
}

/** The words of one LM Studio message version (`singleStep` content, or a `multiStep` answer's blocks). */
function lmStudioVersion(v: unknown): ImportedMessage | undefined {
  if (!isObj(v) || (v.role !== "user" && v.role !== "assistant")) return undefined;
  const texts: string[] = [];
  const files: ImportedFile[] = [];
  const read = (parts: unknown) => {
    if (typeof parts === "string") return void texts.push(parts);
    for (const p of Array.isArray(parts) ? parts : []) {
      if (!isObj(p)) continue;
      if (p.type === "text" && typeof p.text === "string") texts.push(p.text);
      else if (p.type === "file") files.push({ name: str(p.name) || str(p.fileIdentifier) || "file" });
    }
  };
  read(v.content);
  for (const s of Array.isArray(v.steps) ? v.steps : []) if (isObj(s) && s.type === "contentBlock") read(s.content);
  const text = texts.join("").trim();
  if (!text && !files.length) return undefined;
  return { role: v.role, text, ...(files.length ? { files } : {}) };
}

/** One LM Studio chat file: the chat (each message's selected version) and a branch for each other version. */
function lmStudioChats(c: Json, fileName = ""): { chats: ImportedChat[]; persona?: ExportPersona } {
  const rows = (Array.isArray(c.messages) ? c.messages : []).filter(isObj);
  const pick = (r: Json, i: number) => (Array.isArray(r.versions) ? r.versions[i] : i === 0 ? r : undefined);
  const selected = (r: Json) => (Array.isArray(r.versions) ? Math.min(Math.max(0, numOr(r.currentlySelected) ?? 0), r.versions.length - 1) : 0);
  const createdAt = iso(c.createdAt ?? c.created_at);
  const name = str(c.name) || fileName.replace(/^.*[\\/]/, "").replace(/\.conversation\.json$|\.json$/i, "");
  const originalId = `${numOr(c.createdAt) ?? str(c.createdAt)}:${fileName.replace(/^.*[\\/]/, "") || name}`;
  const main = rows.map((r) => lmStudioVersion(pick(r, selected(r))));
  const messages = main.filter((m): m is ImportedMessage => !!m);
  if (!messages.length) return { chats: [] };
  const chats: ImportedChat[] = [{ source: "lmstudio", originalId, title: name || messages[0]!.text.slice(0, 60), createdAt, messages }];
  rows.forEach((r, i) => {
    const versions = Array.isArray(r.versions) ? r.versions : [];
    versions.forEach((v, k) => {
      if (k === selected(r) || chats.length > MAX_BRANCHES) return;
      const alt = lmStudioVersion(v);
      if (!alt) return;
      const before = main.slice(0, i).filter((m): m is ImportedMessage => !!m);
      chats.push({ ...chats[0]!, originalId: `${originalId}#${i}.${k}`, messages: [...before, alt], branchOf: { originalId, seq: before.length + 1 }, root: originalId });
    });
  });
  // Settings this chat had of its own (LM Studio keeps them as `{ key, value }` fields).
  const fields = new Map(((isObj(c.perChatPredictionConfig) && Array.isArray(c.perChatPredictionConfig.fields) ? c.perChatPredictionConfig.fields : []) as unknown[]).filter(isObj).map((f) => [str(f.key), f.value]));
  const unwrap = (v: unknown) => (isObj(v) && "value" in v ? v.value : v);
  const system = (str(c.systemPrompt) || str(fields.get("llm.prediction.systemPrompt"))).trim();
  const params = cleanTemps(fields.get("llm.prediction.temperature"), unwrap(fields.get("llm.prediction.topPSampling")));
  return { chats, ...(system ? { persona: { name: `LM Studio: ${chats[0]!.title.slice(0, 40)}`, instructions: system, ...(params ? { params } : {}) } } : {}) };
}

/** A Gemini activity entry, read from either JSON shape Google has used, or Takeout's HTML (see geminiHtmlToActivity). */
interface GeminiEntry { at: string; prompt: string; answer: string; chat?: string; files: ImportedFile[] }

function geminiEntry(d: Json): GeminiEntry | undefined {
  if (!/gemini|bard/i.test(str(d.header))) return undefined;
  let prompt = /^Prompted /.test(str(d.title)) ? str(d.title).replace(/^Prompted\s+/, "").trim() : "";
  let answer = htmlToText((Array.isArray(d.safeHtmlItem) ? d.safeHtmlItem : []).map((h) => (isObj(h) ? str(h.html) : "")).join("\n"));
  // Newer exports: `details: [{ name: "Request" | "Response", value }]`.
  for (const x of Array.isArray(d.details) ? d.details : []) {
    if (!isObj(x)) continue;
    if (/^request$/i.test(str(x.name)) && !prompt) prompt = str(x.value).trim();
    if (/^response$/i.test(str(x.name)) && !answer) answer = htmlToText(str(x.value));
  }
  if (!prompt) return undefined;
  const chat = /\/app\/(?:c\/)?([A-Za-z0-9_-]{6,})/.exec(str(d.titleUrl))?.[1];
  const files = (Array.isArray(d.attachedFiles) ? d.attachedFiles : []).map(str).filter(Boolean).map((name) => ({ name, ref: `gemini:${name}` }));
  return { at: iso(d.time), prompt, answer, ...(chat ? { chat } : {}), files };
}

function geminiChats(entries: GeminiEntry[], split: GeminiSplit = "day"): ImportedChat[] {
  const out: ImportedChat[] = [];
  const byId = new Map<string, ImportedChat>();
  let current: ImportedChat | undefined;
  let last = 0;
  for (const e of [...entries].sort((a, b) => a.at.localeCompare(b.at))) {
    let chat: ImportedChat | undefined;
    if (e.chat) {
      // The export names the chat: no guessing.
      chat = byId.get(e.chat);
      if (!chat) {
        chat = { source: "gemini", originalId: `c:${e.chat}`, title: e.prompt.slice(0, 60), createdAt: e.at, messages: [] };
        byId.set(e.chat, chat);
        out.push(chat);
      }
    } else {
      const t = Date.parse(e.at);
      const newChat = split === "one" ? false : split === "gap" ? t - last > 30 * 60_000 : new Date(t).toDateString() !== new Date(last).toDateString();
      if (!current || newChat) {
        // The id says how it was split, so importing again with another split adds its own chats.
        current = { source: "gemini", originalId: split === "gap" ? e.at : `${split}:${e.at}`, title: split === "gap" ? e.prompt.slice(0, 60) : `${e.at.slice(0, 10)} · ${e.prompt.slice(0, 46)}`, createdAt: e.at, messages: [] };
        out.push(current);
      }
      last = t;
      chat = current;
    }
    chat.messages.push({ role: "user", text: e.prompt, at: e.at, ...(e.files.length ? { files: e.files } : {}) });
    if (e.answer) chat.messages.push({ role: "assistant", text: e.answer, at: e.at });
  }
  return out;
}

/**
 * Reads an export one item at a time, so a big file is never held whole: give it each element of each JSON list
 * in the export (and each zip entry's name), then call {@link ExportReader.end}. Chats come out through `onChat`
 * as soon as they are read (Gemini's at the end: its entries are grouped first). Instructions found on the way
 * (custom instructions, Claude projects, chat prompts) are collected in `personas`, once each.
 */
export class ExportReader {
  /** The app the export is from (the first item that tells). */
  source: ImportSource | undefined;
  /** Instructions found in the export, without repeats. */
  readonly personas: ExportPersona[] = [];
  private gemini: GeminiEntry[] = [];
  private instructions: { at: number; persona: ExportPersona } | undefined;

  /**
   * @param onChat - Called with each chat (a chat's branches right after it).
   * @param geminiSplit - How Gemini prompts with no chat id are grouped.
   */
  constructor(private readonly onChat: (chat: ImportedChat) => void, private readonly geminiSplit: GeminiSplit = "day") {}

  private persona(p: ExportPersona | undefined): void {
    if (p && p.instructions.trim() && !this.personas.some((x) => x.instructions.trim() === p.instructions.trim())) this.personas.push({ ...p, name: p.name.slice(0, 60), instructions: p.instructions.slice(0, 20_000) });
  }

  private take(source: ImportSource, chats: ImportedChat[]): void {
    this.source ??= source;
    for (const c of chats) this.onChat(c);
  }

  /**
   * Reads one item.
   *
   * @param item - One element of a list in the export, or a file's single object.
   * @param fileName - The file it came from (names LM Studio chats, which have no id).
   */
  item(item: unknown, fileName = ""): void {
    if (!isObj(item)) return;
    const kind = detectItem(item);
    if (kind === "chatgpt") {
      const ins = chatgptInstructions(item);
      if (ins && (!this.instructions || ins.at > this.instructions.at)) this.instructions = ins;
      this.take("chatgpt", chatgptChats(item));
    } else if (kind === "claude") {
      const c = claudeChat(item);
      this.take("claude", c ? [c] : []);
    } else if (kind === "openwebui") {
      const r = openWebUiChats(item);
      this.persona(r.persona);
      this.take("openwebui", r.chats);
    } else if (kind === "lmstudio") {
      const r = lmStudioChats(item, fileName);
      this.persona(r.persona);
      this.take("lmstudio", r.chats);
    } else if (kind === "gemini") {
      this.source ??= "gemini";
      const e = geminiEntry(item);
      if (e) this.gemini.push(e);
    } else if (kind === "claude-projects") {
      const ins = str(item.prompt_template).trim();
      if (ins) this.persona({ name: str(item.name).trim() || "Claude project", instructions: ins });
    }
  }

  /** Ends the reading: Gemini's chats come out now, and ChatGPT's newest custom instructions join the personas. */
  end(): void {
    if (this.gemini.length) for (const c of geminiChats(this.gemini, this.geminiSplit)) this.onChat(c);
    this.gemini = [];
    if (this.instructions) this.persona(this.instructions.persona);
    this.instructions = undefined;
  }
}

/**
 * Reads the chats in an export that is already parsed (small files, and the old import route).
 *
 * @param data - The parsed `conversations.json`, `MyActivity.json`, Open WebUI export or LM Studio chat.
 * @param geminiSplit - How Gemini prompts with no chat id are grouped.
 * @returns The source, its chats (branches after their chat) and the instructions found.
 * @throws Error when the file is not an export KesherAI knows.
 */
export function readExport(data: unknown, geminiSplit: GeminiSplit = "day"): { source: ImportSource; chats: ImportedChat[]; personas: ExportPersona[] } {
  const chats: ImportedChat[] = [];
  const reader = new ExportReader((c) => chats.push(c), geminiSplit);
  for (const item of Array.isArray(data) ? data : [data]) reader.item(item);
  reader.end();
  if (!reader.source && !reader.personas.length) throw new Error(NOT_AN_EXPORT);
  return { source: reader.source ?? "claude", chats, personas: reader.personas };
}

/** What a file that is no known export gets told. */
export const NOT_AN_EXPORT = "This is not a chat export KesherAI knows. Use the zip (or conversations.json) from ChatGPT or Claude, the chats export of Open WebUI, an LM Studio .conversation.json, or Google Takeout's My Activity for Gemini.";

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

/** One activity of Google's "My Activity", as `MyActivity.json` holds it. */
export type GeminiActivity = { header: string; title: string; time: string; safeHtmlItem: Array<{ html: string }> };

/** The biggest single card of Takeout's HTML read (a bigger one is skipped; a real card is a few KB). */
export const MAX_HTML_CARD_CHARS = 4 * 1024 * 1024;

/** Where each card of Takeout's HTML starts. */
const CARD_MARK = /<div class="outer-cell\b/g;

/**
 * Google Takeout's "My Activity" in its default format, HTML (`MyActivity.html`), read card by card as it streams in,
 * so a file of hundreds of MB is never held whole: only the card being read is kept (at most MAX_HTML_CARD_CHARS).
 * Each activity is one card: a header ("Gemini Apps"), then a cell with the prompt on its first line, the time on the
 * second, and the answer after it. Times are written in the account's language; one that cannot be read keeps the
 * card's place in the file (the file is newest first).
 */
export class GeminiHtmlCards {
  private buf = "";
  /** Where to look for the next card's start (the text before it was searched already). */
  private from = 1;
  private last = Date.now();

  /**
   * @param onActivity - Each Gemini activity, in the file's order.
   * @param maxCard - The biggest card kept (characters).
   */
  constructor(
    private readonly onActivity: (a: GeminiActivity) => void,
    private readonly maxCard = MAX_HTML_CARD_CHARS,
  ) {}

  /** Adds text of the file; every card that is now complete is read. */
  push(text: string): void {
    this.buf += text;
    for (;;) {
      CARD_MARK.lastIndex = Math.max(1, this.from);
      const m = CARD_MARK.exec(this.buf);
      // A mark at the very end may still go on in the next piece ("outer-cells"): wait for more.
      if (!m || m.index + m[0].length >= this.buf.length) break;
      this.card(this.buf.slice(0, m.index));
      this.buf = this.buf.slice(m.index);
      this.from = 1;
    }
    this.from = Math.max(1, this.buf.length - 32);
    // A card past the limit is skipped: its text is dropped (the tail is kept, in case a mark starts in it).
    if (this.buf.length > this.maxCard) {
      this.buf = this.buf.slice(-32);
      this.from = 1;
    }
  }

  /** The file ended: the last card is read. */
  end(): void {
    this.card(this.buf);
    this.buf = "";
    this.from = 1;
  }

  private card(card: string): void {
    if (!card.startsWith('<div class="outer-cell')) return;
    const header = htmlToText(/class="[^"]*mdl-typography--title[^"]*">([\s\S]*?)<\/p>/.exec(card)?.[1] ?? "");
    if (!/gemini|bard/i.test(header)) return;
    const cell = /class="content-cell[^"]*mdl-typography--body-1[^"]*">([\s\S]*?)<\/div>\s*<div class="content-cell/.exec(card)?.[1] ?? /class="content-cell[^"]*mdl-typography--body-1[^"]*">([\s\S]*)/.exec(card)?.[1] ?? "";
    const parts = cell.split(/<br\s*\/?>/i);
    const first = htmlToText(parts[0] ?? "");
    const when = htmlToText(parts[1] ?? "").replace(/[\u202f\u00a0]/g, " ");
    const answer = parts.slice(2).join("<br>").trim();
    const parsed = Date.parse(when) || Date.parse(when.replace(/\s[A-Z]{2,5}$/, ""));
    this.last = Number.isNaN(parsed) || !parsed ? this.last - 60_000 : parsed;
    // English exports say "Prompted …"; in another language the first line is kept whole when an answer follows it.
    const prompt = /^Prompted\s/.test(first) ? first.replace(/^Prompted\s+/, "") : answer ? first : "";
    if (!prompt.trim()) return;
    this.onActivity({ header, title: `Prompted ${prompt.trim()}`, time: new Date(this.last).toISOString(), safeHtmlItem: answer ? [{ html: answer }] : [] });
  }
}

/**
 * Takeout's "My Activity" HTML read whole (GeminiHtmlCards on one piece), as the same list the JSON format holds.
 *
 * @param html - The file's text.
 * @returns Activities shaped like `MyActivity.json`'s.
 */
export function geminiHtmlToActivity(html: string): GeminiActivity[] {
  const out: GeminiActivity[] = [];
  const cards = new GeminiHtmlCards((a) => out.push(a));
  cards.push(html);
  cards.end();
  return out;
}

/**
 * How Gemini's activity becomes chats. Google's export has no chat ids, only prompts with times, so the chats
 * are a guess: `day` puts each day in one chat, `gap` starts a new chat after 30 quiet minutes (many small
 * chats), `one` puts everything in a single chat.
 */
export type GeminiSplit = "day" | "gap" | "one";

/** The text of a Jan message: a string, or OpenAI-style parts (`{ type: "text", text: { value } }`). */
function janText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p) => (isObj(p) ? (typeof p.text === "string" ? p.text : isObj(p.text) ? str(p.text.value) : "") : "")).filter(Boolean).join("\n");
}

/**
 * Jan's chats, from its data folder: `threads/<id>/thread.json` (title,
 * created) and `messages.jsonl` (one message a line). Only read.
 *
 * @param threadsDir - Jan's `threads` folder.
 * @returns Chats.
 */
export async function readJanThreads(threadsDir: string): Promise<ImportedChat[]> {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const out: ImportedChat[] = [];
  for (const d of await readdir(threadsDir, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory()) continue;
    const thread = await readFile(join(threadsDir, d.name, "thread.json"), "utf8").then((t) => JSON.parse(t) as Json, () => ({}) as Json);
    const lines = (await readFile(join(threadsDir, d.name, "messages.jsonl"), "utf8").catch(() => "")).split(/\r?\n/).filter(Boolean);
    const messages: ImportedMessage[] = [];
    for (const line of lines) {
      let m: Json;
      try {
        m = JSON.parse(line) as Json;
      } catch {
        continue;
      }
      if (m.role !== "user" && m.role !== "assistant") continue;
      const text = janText(m.content).trim();
      if (text) messages.push({ role: m.role, text, ...(typeof m.created_at === "number" || typeof m.created === "number" ? { at: iso(m.created_at ?? m.created) } : {}) });
    }
    if (!messages.length) continue;
    out.push({ source: "jan", originalId: str(thread.id) || d.name, title: str(thread.title) || messages[0]!.text.slice(0, 60), createdAt: iso(thread.created ?? thread.created_at ?? Date.now() / 1000), messages });
  }
  return out;
}
