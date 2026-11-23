/**
 * Research → tasks: reads the task lists that research reports end with (a `## Tasks` section, or the bold
 * `**ID Title** — STATUS. … Size S. Who LOCAL.` blocks of a synthesis file) and decides who runs each one.
 *
 * Pure: no files, no git. The inbox runner reads the reports from origin/main and feeds the queue from the backlog
 * this module builds (see inbox-runner.ts `importResearch` and `feedFromResearch`).
 */

/** Who runs a research task: the local model (self-work), Antigravity, or the lead (Claude/Roee decide; never run). */
export type ResearchWho = "local" | "antigravity" | "lead";

/** One task read from a report. */
export interface ResearchTask {
  /** The id the report gave it (CD-1, T3, …), with the report's name in front: `<report>#<id>`. */
  key: string;
  title: string;
  /** The task's text as the report wrote it (what to build, files, checks), at most 3000 characters. */
  body: string;
  size: "S" | "M" | "L";
  who: ResearchWho;
  /** The report said it already exists (DONE) or partly (PARTIAL); NEW otherwise. */
  status: "new" | "partial" | "done";
  /** The report's file name, for example `c-20261122-35.md`. */
  source: string;
}

/** A block start: `**CD-1 Title** — …`, `### T1: Title`, `### T1 — Title`, `- **T1** Title: …`, `- T1: Title`. */
const STARTS: RegExp[] = [
  /^\*\*([A-Z]{1,4}-?\d{1,3}[a-z]?)[.:]?\s+(.+?)\*\*\s*(.*)$/,
  /^#{3,4}\s+([A-Z]{1,4}-?\d{1,3}[a-z]?)\s*[.:—–-]+\s*(.+?)\s*$/,
  /^[-*]\s+\*\*([A-Z]{1,4}-?\d{1,3}[a-z]?)\*\*[.:]?\s*[—–-]?\s*(.+?)(?::\s+(.*))?$/,
  /^[-*]\s+([A-Z]{1,4}-?\d{1,3}[a-z]?)\s*[:—–]\s*(.+?)(?::\s+(.*))?$/,
];

/**
 * The tasks in one report. In a normal report only the `## Tasks` section is read; a synthesis file (bold
 * `**ID Title** —` blocks anywhere) is read whole. DONE tasks are returned too (status "done") so callers can skip them.
 *
 * @param md - The report's Markdown.
 * @param source - Its file name (kept on each task).
 */
export function parseResearchTasks(md: string, source: string): ResearchTask[] {
  const lines = md.split(/\r?\n/);
  let from = lines.findIndex((l) => /^##\s+Tasks\b/i.test(l.trim()));
  let to = lines.length;
  if (from >= 0) {
    const end = lines.findIndex((l, i) => i > from && /^##\s+\S/.test(l.trim()));
    if (end > 0) to = end;
    from += 1;
  } else if (lines.some((l) => STARTS[0]!.test(l.trim()))) from = 0;
  else return [];
  const out: ResearchTask[] = [];
  let cur: { id: string; title: string; text: string[] } | undefined;
  const flush = () => {
    if (!cur) return;
    const text = cur.text.join("\n").trim();
    const all = `${cur.title} ${text}`;
    out.push({
      key: `${source}#${cur.id}`,
      title: cur.title.replace(/[*`]/g, "").trim().slice(0, 180),
      body: text.slice(0, 3000),
      size: sizeOf(all),
      who: whoOf(all, sizeOf(all)),
      status: /\bDONE\b/.test(text.slice(0, 40)) ? "done" : /\bPARTIAL\b/.test(text.slice(0, 40)) ? "partial" : "new",
      source,
    });
    cur = undefined;
  };
  for (let i = from; i < to; i++) {
    const line = lines[i]!.trim();
    if (/^##\s+\S/.test(line)) { flush(); if (from > 0) break; continue; }
    const m = STARTS.map((r) => r.exec(line)).find(Boolean);
    if (m) {
      flush();
      cur = { id: m[1]!, title: m[2]!, text: m[3] ? [m[3]] : [] };
    } else if (cur && line) cur.text.push(line);
  }
  flush();
  return out;
}

/** S, M or L from "Size S" / "size: M" / "(L)"; M when the report gives none. */
function sizeOf(text: string): "S" | "M" | "L" {
  const m = /\bsize\W{0,3}([SML])\b/i.exec(text) ?? /\(([SML])\)/.exec(text);
  return (m?.[1]?.toUpperCase() as "S" | "M" | "L" | undefined) ?? "M";
}

/** Who from "Who LOCAL/AGY/LEAD" (or the words local, Antigravity, Claude), else by size: S local, M Antigravity, L lead. */
function whoOf(text: string, size: "S" | "M" | "L"): ResearchWho {
  const m = /\bwho\W{0,3}(LOCAL|AGY|LEAD|local|antigravity|claude|lead)\b/i.exec(text);
  const w = m?.[1]?.toLowerCase();
  if (w === "local") return "local";
  if (w === "agy" || w === "antigravity") return "antigravity";
  if (w === "lead" || w === "claude") return "lead";
  return size === "S" ? "local" : size === "M" ? "antigravity" : "lead";
}

/**
 * A title in a comparable form (lower case, letters and digits only, no filler words), for spotting the same task
 * twice.
 *
 * @param title - A task title.
 */
export function normTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((w) => w.length > 2 && !["the", "and", "for", "with", "from", "into", "add"].includes(w))
    .sort()
    .join(" ");
}

/**
 * Whether two titles name the same task: the same normalized words, or one's words almost all inside the other's.
 *
 * @param a - A title.
 * @param b - Another title.
 */
export function sameTask(a: string, b: string): boolean {
  const x = normTitle(a).split(" ").filter(Boolean);
  const y = normTitle(b).split(" ").filter(Boolean);
  if (!x.length || !y.length) return false;
  if (x.join(" ") === y.join(" ")) return true;
  const [small, big] = x.length <= y.length ? [x, new Set(y)] : [y, new Set(x)];
  const hit = small.filter((w) => big.has(w)).length;
  return small.length >= 3 && hit / small.length >= 0.85;
}

/** The hand-written research backlog's file name in docs/research/ (its tasks are picked first). */
export const BACKLOG_FILE = "BACKLOG.md";

/** The order the backlog is worked in: co-developer, one chat, game engines, the rest; then the report's own order. */
const SECTION_ORDER = ["CD", "CH", "GE"];

/**
 * The backlog's next task for an executor, in priority order (see {@link SECTION_ORDER}). Lead tasks are never picked.
 *
 * @param backlog - Tasks not yet made into inbox tasks (in the order they were read).
 * @param who - The executor whose line has room.
 */
export function nextForExecutor(backlog: readonly ResearchTask[], who: "local" | "antigravity"): ResearchTask | undefined {
  const rank = (t: ResearchTask) => {
    const id = t.key.split("#")[1] ?? "";
    // The hand-written backlog (docs/research/BACKLOG.md) comes before the reports' own tasks.
    if (t.source === BACKLOG_FILE) return -1;
    const i = SECTION_ORDER.findIndex((p) => id.startsWith(`${p}-`));
    return i < 0 ? SECTION_ORDER.length : i;
  };
  return backlog
    .map((t, i) => ({ t, i }))
    .filter((x) => x.t.who === who && x.t.status !== "done")
    .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)[0]?.t;
}

/**
 * The inbox goal text for a research task: what the report says, where it came from, and the rules for the agent.
 *
 * @param t - The task.
 */
export function goalFor(t: ResearchTask): string {
  return [
    `From research: docs/research/${t.source} (${t.key.split("#")[1]}). Read that part of the report first.`,
    t.status === "partial" ? "Part of this already exists (the report names the files): build on it, do not duplicate it." : "",
    "",
    t.body,
    "",
    "Search the code first; if it is already done, say so and change nothing. Keep the change small and tested (node:test next to the code). Texts the user sees: Hebrew and English. When done, update docs/WORK_LIST.md with what is done and what is left.",
  ]
    .filter((l, i, a) => l !== "" || a[i - 1] !== "")
    .join("\n")
    .slice(0, 6000);
}
