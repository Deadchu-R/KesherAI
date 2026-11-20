/**
 * Claude's work list (`docs/WORK_LIST.md`) as items, so every device can show it next to the tasks (the PC reads the
 * file from git and writes each item to the owner's Google Drive as a `task` record with origin `work-list`;
 * packages/core/src/work-list-sync.ts). Pure: no I/O, no DOM, so the PC and the hub page share it.
 *
 * An item is a list line that starts with a status mark (`- ✅ …`), with the lines under it (more indented) as its
 * text; list lines without a mark and marked lines inside another item stay part of that item's text or are skipped.
 */

/** An item's status, from the mark at the start of its line. */
export type WorkListStatus = "done" | "doing" | "next" | "roee" | "paused";
export const WORK_LIST_STATUSES: readonly WorkListStatus[] = ["done", "doing", "next", "roee", "paused"];

/** The marks the work list uses, and what each one means. */
export const WORK_LIST_MARKS: Readonly<Record<string, WorkListStatus>> = { "✅": "done", "🔨": "doing", "⬜": "next", "👤": "roee", "⏸": "paused" };

/** Limits of one item. */
export const WORK_LIST_LIMITS = {
  /** The title: the item's first sentence. */
  titleChars: 140,
  /** The full text of an item, in UTF-8 bytes. */
  textBytes: 2048,
  /** A section heading. */
  sectionChars: 200,
  /** How much of the item's text goes into its id (edits after it keep the id). */
  idPrefixChars: 60,
} as const;

/** One item of the work list. */
export interface WorkListItem {
  /** Stable: from the section and the start of the text (`w-` and a hash). */
  id: string;
  /** The heading the item is under (markdown removed). */
  section: string;
  status: WorkListStatus;
  /** The first sentence, markdown removed, at most {@link WORK_LIST_LIMITS.titleChars}. */
  title: string;
  /** The whole item with its sub-lines, markdown removed, at most {@link WORK_LIST_LIMITS.textBytes}. */
  text: string;
  /** Its place in the file (0, 1, 2 …), so a device can show the list in order. */
  order: number;
}

/** A list line: indentation, bullet (`-`, `*`, `+` or `1.`), then the rest. */
const BULLET_RE = /^(\s*)(?:[-*+]|\d{1,3}[.)])\s+(.*)$/;
const HEADING_RE = /^#{1,6}\s+(.+?)\s*#*\s*$/;
/** The marks at the start of an item (the pause sign may carry the emoji variation selector). */
const MARK_RE = /^(✅|🔨|⬜|👤|⏸)️?\s*/u;

/**
 * Removes inline markdown: bold, italics with `*`, strike-through, code ticks, links (keeps the label) and HTML tags.
 *
 * @param s - Markdown text.
 * @returns Plain text.
 */
export function stripMarkdown(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/(^|[\s(])\*(\S(?:.*?\S)?)\*(?=[\s).,:;!?]|$)/g, "$1$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/<[^>]{1,100}>/g, "");
}

/**
 * A short stable hash (cyrb53: 53 bits, base 36). Not for security: only to name an item.
 *
 * @param s - The text.
 */
function hash53(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36).padStart(11, "0");
}

/**
 * An item's id: `w-` and a hash of its section and the first {@link WORK_LIST_LIMITS.idPrefixChars} characters of
 * its plain text (so a change near the end, such as "Not run on the PC yet", keeps the id; the status mark is not
 * part of it, so ⬜ → ✅ keeps it too).
 *
 * @param section - The section heading (plain).
 * @param text - The item's plain text, without the mark.
 * @returns An id that fits a sync record (`[\w-]{8,64}`).
 */
export function workListId(section: string, text: string): string {
  const start = text.replace(/\s+/g, " ").trim().slice(0, WORK_LIST_LIMITS.idPrefixChars);
  return `w-${hash53(`${section}\n${start}`)}`;
}

/** Cuts text to at most `bytes` UTF-8 bytes, on a character boundary, with an ellipsis when cut. */
function cutBytes(s: string, bytes: number): string {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= bytes) return s;
  let out = "";
  let used = 3; // the ellipsis
  for (const ch of s) {
    const n = enc.encode(ch).length;
    if (used + n > bytes) break;
    out += ch;
    used += n;
  }
  return `${out.trimEnd()}…`;
}

/** The first sentence of plain text (ends at `.`, `!` or `?` before a space), cut to the title length. */
function firstSentence(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](\s|$)/);
  const one = end >= 0 ? flat.slice(0, end + 1) : flat;
  return one.length <= WORK_LIST_LIMITS.titleChars ? one : `${one.slice(0, WORK_LIST_LIMITS.titleChars - 1).trimEnd()}…`;
}

/** The width of a line's indentation (a tab counts as 4). */
const indentOf = (s: string): number => s.replace(/\t/g, "    ").length;

/**
 * Reads the work list into items, in file order. Lines without a status mark are ignored; an item's sub-lines (more
 * indented than its bullet, blank lines between them allowed) are its text. Two items with the same id in one
 * section (the same start) get `-2`, `-3` … so both stay.
 *
 * @param markdown - The contents of `docs/WORK_LIST.md`.
 * @returns The items.
 */
export function parseWorkList(markdown: string): WorkListItem[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: WorkListItem[] = [];
  const seen = new Map<string, number>();
  let section = "";
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const head = HEADING_RE.exec(line);
    if (head) {
      section = stripMarkdown(head[1]!).trim().slice(0, WORK_LIST_LIMITS.sectionChars);
      continue;
    }
    const bullet = BULLET_RE.exec(line);
    if (!bullet) continue;
    const mark = MARK_RE.exec(bullet[2]!);
    if (!mark) continue;
    const status = WORK_LIST_MARKS[mark[1]!]!;
    const indent = indentOf(bullet[1]!);
    // The item's own paragraph (its first line and unbulleted continuation lines), then its sub-lines.
    const first = [bullet[2]!.slice(mark[0].length)];
    const sub: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const next = lines[j]!;
      if (!next.trim()) {
        const after = lines.slice(j + 1).find((l) => l.trim());
        if (after === undefined || indentOf(/^\s*/.exec(after)![0]) <= indent) break;
        sub.push("");
        continue;
      }
      if (indentOf(/^\s*/.exec(next)![0]) <= indent || HEADING_RE.test(next)) break;
      if (!sub.length && !BULLET_RE.test(next)) first.push(next.trim());
      else sub.push(next.replace(/\t/g, "    ").slice(Math.min(indent + 2, indentOf(/^\s*/.exec(next)![0]))));
    }
    i = j - 1;
    const lead = stripMarkdown(first.join(" ")).trim();
    if (!lead) continue;
    const body = [lead, ...sub.map((s) => stripMarkdown(s).trimEnd())].join("\n").replace(/\n{3,}/g, "\n\n").trim();
    let id = workListId(section, lead);
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    if (n > 1) id = `${id}-${n}`;
    out.push({ id, section, status, title: firstSentence(lead), text: cutBytes(body, WORK_LIST_LIMITS.textBytes), order: out.length });
  }
  return out;
}
