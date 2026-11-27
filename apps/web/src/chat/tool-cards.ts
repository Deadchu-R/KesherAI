/**
 * Pure helpers for the chat's tool cards (docs/research/c-20261121-38.md, "Transparent Tool Call Formatting"):
 * a friendly name and icon per tool, a one-line summary of its main parameter (secrets masked), grouping of
 * consecutive calls of one tool, durations, and a structured reading of a result. No React and no i18n imports,
 * so they run in `node:test`; callers pass `he` (true for Hebrew).
 */

/** How a tool is shown: an icon, its name in both languages and, optionally, a plural title for grouped calls. */
export interface ToolInfo {
  icon: string;
  he: string;
  en: string;
  /** Title of a group of `{n}` calls ("{n} חיפושים ברשת"); without it the group reads "{n}× name". */
  hePlural?: string;
  enPlural?: string;
}

const TOOLS: Record<string, ToolInfo> = {
  web_search: { icon: "🔎", he: "חיפוש ברשת", en: "Web search", hePlural: "{n} חיפושים ברשת", enPlural: "{n} web searches" },
  web_fetch: { icon: "🌐", he: "קריאת עמוד", en: "Read web page", hePlural: "{n} עמודים נקראו", enPlural: "{n} web pages read" },
  download_file: { icon: "⬇️", he: "הורדת קובץ", en: "Download file", hePlural: "{n} הורדות", enPlural: "{n} downloads" },
  send_file: { icon: "📤", he: "שליחת קובץ", en: "Send file", hePlural: "{n} קבצים נשלחו", enPlural: "{n} files sent" },
  read_file: { icon: "📄", he: "קריאת קובץ", en: "Read file", hePlural: "{n} קבצים נקראו", enPlural: "{n} files read" },
  read_document: { icon: "📄", he: "קריאת מסמך", en: "Read document" },
  list_files: { icon: "📁", he: "רשימת קבצים", en: "List files" },
  search: { icon: "🔍", he: "חיפוש בקוד", en: "Search code", hePlural: "{n} חיפושים בקוד", enPlural: "{n} code searches" },
  write_file: { icon: "✏️", he: "כתיבת קובץ", en: "Write file", hePlural: "{n} קבצים נכתבו", enPlural: "{n} files written" },
  edit_file: { icon: "✏️", he: "עריכת קובץ", en: "Edit file", hePlural: "{n} עריכות", enPlural: "{n} edits" },
  run_command: { icon: "⌨️", he: "הרצת פקודה", en: "Run command", hePlural: "{n} פקודות", enPlural: "{n} commands" },
  build_executable: { icon: "🔨", he: "בניית תוכנה", en: "Build program" },
  install_tool: { icon: "📦", he: "התקנת כלי", en: "Install tool" },
  check_tools: { icon: "🧰", he: "בדיקת כלים", en: "Check tools" },
  document: { icon: "📝", he: "מסמך", en: "Document" },
  sheet: { icon: "📊", he: "גיליון", en: "Spreadsheet" },
  slides: { icon: "🖼️", he: "מצגת", en: "Slides" },
  generate_image: { icon: "🖼️", he: "יצירת תמונה", en: "Generate image", hePlural: "{n} תמונות", enPlural: "{n} images" },
  generate_video: { icon: "🎬", he: "יצירת וידאו", en: "Generate video" },
  make_music: { icon: "🎵", he: "יצירת מוזיקה", en: "Make music" },
  make_3d: { icon: "🧊", he: "יצירת מודל תלת־ממד", en: "Make 3D model" },
  make_pbr_texture: { icon: "🧱", he: "יצירת טקסטורה", en: "Make texture" },
  make_ui_sprite: { icon: "🎨", he: "יצירת ספרייט", en: "Make sprite" },
  search_chats: { icon: "🕘", he: "חיפוש בשיחות קודמות", en: "Search past chats", hePlural: "{n} חיפושים בשיחות קודמות", enPlural: "{n} past-chat searches" },
  recent_chats: { icon: "🕘", he: "שיחות אחרונות", en: "Recent chats" },
  read_chat: { icon: "🕘", he: "קריאת שיחה קודמת", en: "Read a past chat" },
  travel_search_flights: { icon: "✈️", he: "חיפוש טיסות", en: "Search flights" },
  travel_search_stays: { icon: "🏨", he: "חיפוש מלונות", en: "Search stays" },
  travel_watch: { icon: "🔔", he: "מעקב מחיר", en: "Watch a price" },
  travel_watches: { icon: "🔔", he: "מעקבי מחיר", en: "Price watches" },
  remember: { icon: "🧠", he: "שמירה בזיכרון", en: "Save to memory" },
  delegate: { icon: "👥", he: "הפניה לעוזרים", en: "Delegate to helpers" },
  deep_research: { icon: "🔬", he: "מחקר מעמיק", en: "Deep research" },
  request_access: { icon: "🔑", he: "בקשת גישה", en: "Request access" },
  offer_install: { icon: "📦", he: "הצעת התקנה", en: "Offer install" },
  android_run_on_phone: { icon: "📱", he: "הרצה בטלפון", en: "Run on phone" },
};

/** Tools by name prefix (browser, computer, engines), used when the exact name is not in the map. */
const FAMILIES: [RegExp, ToolInfo][] = [
  [/^browser_/, { icon: "🧭", he: "דפדפן", en: "Browser", hePlural: "{n} פעולות בדפדפן", enPlural: "{n} browser actions" }],
  [/^computer_/, { icon: "🖥️", he: "שליטה במחשב", en: "Computer", hePlural: "{n} פעולות במחשב", enPlural: "{n} computer actions" }],
  [/^unity_/, { icon: "🎮", he: "Unity", en: "Unity", hePlural: "{n} פעולות ב-Unity", enPlural: "{n} Unity actions" }],
  [/^unreal_/, { icon: "🎮", he: "Unreal", en: "Unreal", hePlural: "{n} פעולות ב-Unreal", enPlural: "{n} Unreal actions" }],
  [/^godot_/, { icon: "🎮", he: "Godot", en: "Godot", hePlural: "{n} פעולות ב-Godot", enPlural: "{n} Godot actions" }],
];

/**
 * How a tool is shown. Unknown tools get a generic icon and their raw name.
 *
 * @param name - The tool's name as the model called it.
 */
export function toolInfo(name: string): ToolInfo {
  return TOOLS[name] ?? FAMILIES.find(([re]) => re.test(name))?.[1] ?? { icon: "🛠️", he: name, en: name };
}

/**
 * The tool's friendly name in the UI language; for a family tool with a specific action the action follows
 * ("Browser · open"). Falls back to the raw name.
 *
 * @param name - The tool's name.
 * @param he - True for Hebrew.
 */
export function toolLabel(name: string, he: boolean): string {
  const info = toolInfo(name);
  const base = he ? info.he : info.en;
  const fam = FAMILIES.find(([re]) => re.test(name));
  return fam && !TOOLS[name] ? `${base} · ${name.replace(fam[0], "").replace(/_/g, " ")}` : base;
}

/**
 * The title of a group of `n` consecutive calls of one tool ("3 web searches").
 *
 * @param name - The tool's name.
 * @param n - How many calls.
 * @param he - True for Hebrew.
 */
export function groupTitle(name: string, n: number, he: boolean): string {
  const info = toolInfo(name);
  const plural = he ? info.hePlural : info.enPlural;
  return plural ? plural.replace("{n}", String(n)) : `${n}× ${toolLabel(name, he)}`;
}

/** Input keys that hold secrets: never shown, whatever their value. */
const SECRET_KEY = /(token|secret|passw(or)?d|passwd|api[-_]?key|authorization|cookie|credential|private[-_]?key|bearer)/i;

/**
 * Hides secrets inside free text: bearer tokens, well-known key prefixes, `key=value` pairs, and the password
 * in a URL. A summary line must never leak one, even from a command or URL the model wrote.
 *
 * @param text - Any text.
 */
export function maskSecrets(text: string): string {
  return text
    .replace(/(\/\/[^\s/:@]+:)[^\s/@]+@/g, "$1•••@")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 •••")
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, "$1-•••")
    .replace(/\b(gh[pousr]_|github_pat_|xox[abpr]-|AIza|AKIA|hf_)[A-Za-z0-9_-]{8,}/g, "$1•••")
    .replace(/\b([A-Za-z0-9_-]{0,40}(?:token|secret|passw(?:or)?d|api[-_]?key|apikey|auth|key)[A-Za-z0-9_-]{0,40})(=|:\s*)(?!•)[^\s&"']+/gi, "$1$2•••");
}

/** Collapses whitespace and cuts to `max` characters with an ellipsis. */
export function cut(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/** Cuts the front of a long path, keeping its end (the file name): ".../src/chat/Activity.tsx". */
function cutPath(path: string, max: number): string {
  const one = path.replace(/\s+/g, " ").trim();
  return one.length > max ? `…${one.slice(one.length - max + 1)}` : one;
}

/** The keys that carry a call's main parameter, in priority order. */
const KEY_PARAMS = ["query", "url", "path", "command", "pattern", "prompt", "title", "name", "app", "target", "entry", "package", "text", "question", "id"];

/**
 * One short line for a call's main parameter: the query, URL, file path, command or the first words of a prompt.
 * Secret-looking keys are skipped and secrets inside the value are masked; long text is cut with "…".
 *
 * @param input - The call's arguments.
 * @param max - The longest result, in characters.
 * @returns The line, or "" when nothing fits.
 */
export function paramSummary(input: Record<string, unknown> | undefined, max = 80): string {
  if (!input) return "";
  for (const k of KEY_PARAMS) {
    if (SECRET_KEY.test(k)) continue;
    const v = input[k];
    if (typeof v !== "string" || !v.trim()) continue;
    const safe = maskSecrets(v);
    return k === "path" ? cutPath(safe, max) : cut(safe, max);
  }
  return "";
}

/** A tool call or its result, as far as the helpers read them. */
interface Timed { at?: string }

/**
 * How long a call took (or has taken so far).
 *
 * @param call - The tool_call event (its `at`).
 * @param result - The tool_result event, when it came.
 * @param now - The time to count to while there is no result (ms since epoch).
 * @returns Milliseconds, or undefined when the times are not known.
 */
export function callDuration(call: Timed, result: Timed | undefined, now: number): number | undefined {
  const start = call.at ? Date.parse(call.at) : NaN;
  const end = result ? (result.at ? Date.parse(result.at) : NaN) : now;
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined;
}

/** "0.8s", "12s", "1m 05s". */
export function formatDuration(ms: number): string {
  if (ms < 10_000) return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Tools whose cards stay single (they have their own card or are not tools to the reader). */
const NEVER_GROUPED = /^(ask_user|ask_member|delegate|deep_research)$/;

/** One run of calls in a group of steps: one call (shown as a card) or several of the same tool. */
export interface ToolRun<S> { name: string; steps: S[] }

/**
 * Splits steps into runs of consecutive calls of the same tool, so "web_search x3" shows as one card.
 *
 * @param steps - The steps, in order.
 */
export function groupCalls<S extends { call: { name: string } }>(steps: S[]): ToolRun<S>[] {
  const runs: ToolRun<S>[] = [];
  for (const s of steps) {
    const last = runs.at(-1);
    if (last && last.name === s.call.name && !NEVER_GROUPED.test(s.call.name)) last.steps.push(s);
    else runs.push({ name: s.call.name, steps: [s] });
  }
  return runs;
}

/** One hit of a web search. */
export interface SearchHit { title: string; url: string }

/**
 * Reads a web_search result ("1. Title\n   https://…\n   snippet") into a list of hits.
 *
 * @param output - The tool's output.
 * @returns The hits (http and https only); empty when the text is not a numbered list.
 */
export function searchHits(output: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const lines = output.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*\d+\.\s+(.+)$/.exec(lines[i]!);
    const url = /^\s+(https?:\/\/\S+)\s*$/.exec(lines[i + 1] ?? "")?.[1];
    if (m && url) hits.push({ title: m[1]!.trim(), url });
  }
  return hits;
}

/** A chat a past-chat tool found: its id, title and day. */
export interface PastChatHit { id: string; title: string; day: string }

/**
 * Reads a search_chats / recent_chats result ("1. Title\n   chat:ID · 2026-11-26 · user …") into the chats found,
 * so the card can link to each one.
 *
 * @param output - The tool's output.
 * @returns The chats, in order; empty for any other text.
 */
export function pastChatHits(output: string): PastChatHit[] {
  const hits: PastChatHit[] = [];
  const lines = output.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^\d+\.\s+(.+)$/.exec(lines[i]!);
    const c = /^\s+chat:([\w-]+)(?: · (\d{4}-\d{2}-\d{2}))?/.exec(lines[i + 1] ?? "");
    if (m && c) hits.push({ id: c[1]!, title: m[1]!.trim(), day: c[2] ?? "" });
  }
  return hits;
}

/**
 * The one-line title of a past-chat tool's card: "Searched past chats: 'X' · 3 results" (while it runs, "Searching…").
 *
 * @param name - The tool's name.
 * @param input - The call's arguments.
 * @param hits - How many chats it found (undefined while it runs).
 * @param he - True for Hebrew.
 * @returns The title, or `undefined` for any other tool.
 */
export function pastChatTitle(name: string, input: Record<string, unknown>, hits: number | undefined, he: boolean): string | undefined {
  if (name === "search_chats") {
    const q = cut(maskSecrets(String(input.query ?? "")), 30);
    if (hits === undefined) return he ? `מחפש בשיחות קודמות: '${q}'` : `Searching past chats: '${q}'`;
    const n = he ? (hits === 1 ? "תוצאה אחת" : `${hits} תוצאות`) : `${hits} result${hits === 1 ? "" : "s"}`;
    return he ? `חיפוש בשיחות: '${q}' · ${n}` : `Searched past chats: '${q}' · ${n}`;
  }
  if (name === "recent_chats") return he ? "עיון בשיחות האחרונות" : "Looked at recent chats";
  if (name === "read_chat") return he ? "קריאת שיחה קודמת" : "Read a past chat";
  return undefined;
}

/** A flight or stay search result as a table: the header line, the columns, the rows and the lines after the table. */
export interface TravelTable { head: string; columns: string[]; rows: string[][]; foot: string[] }

/**
 * Reads a travel_search_flights / travel_search_stays result (a header line, a Markdown table, then notes) into a table
 * for the card.
 *
 * @param output - The tool's output.
 * @returns The table, or undefined for any other text (an error, "add a key", no flights).
 */
export function travelTable(output: string): TravelTable | undefined {
  const lines = output.split("\n");
  const cells = (l: string) => l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const first = lines.findIndex((l) => l.startsWith("|"));
  if (first < 1 || !lines[first + 1]?.startsWith("| -")) return undefined;
  let end = first + 2;
  while (end < lines.length && lines[end]!.startsWith("|")) end++;
  const rows = lines.slice(first + 2, end).map(cells);
  if (!rows.length) return undefined;
  return { head: lines.slice(0, first).join(" "), columns: cells(lines[first]!), rows, foot: lines.slice(end).filter((l) => l.trim() && !/^\(\d+ more/.test(l)) };
}

/**
 * A result for reading: JSON is pretty-printed, text is kept. Cut at `max` characters so a huge result stays light.
 *
 * @param output - The tool's output.
 * @param max - The longest result.
 */
export function prettyOutput(output: string, max = 6000): string {
  let text = output;
  const t = output.trim();
  if (/^[[{]/.test(t)) {
    try {
      text = JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      /* not JSON: keep the text */
    }
  }
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

/** An error in one line: "Error:" removed, the first non-empty line, cut. */
export function errorLine(output: string, max = 160): string {
  const first = output.replace(/^\s*Error:\s*/i, "").split("\n").find((l) => l.trim()) ?? "";
  return cut(first, max);
}
