/**
 * "Running now" half of the Claude agents panel: the lead (Claude) writes `claude/agents.json` on the `claude-status`
 * branch with `tools/hub-report/agents-status.mjs`; the PC reads it from its local clone after the task inbox's fetch.
 * This is the one place that checks that file (it is data from outside: bad JSON, too many entries, unknown states
 * and odd strings are dropped) and decides "maybe stuck". Pure, so it is tested in Node and the phone page shares it.
 * Layout: the design doc's HubAgentsWork board.
 */

/** The branch and path the lead's script writes and the PC reads. */
export const CLAUDE_STATUS_REF = "origin/claude-status";
export const CLAUDE_STATUS_FILE = "claude/agents.json";
/** The most entries the file holds. */
export const CLAUDE_STATUS_MAX = 10;
/** A running agent with no update for this long is "maybe stuck" (ms). */
export const CLAUDE_STUCK_MS = 45 * 60_000;

/** One helper agent in the status file. */
export interface ClaudeAgentStatus {
  /** Short id (letters, digits, `_`, `-`; no personal data). */
  id: string;
  title: string;
  model: string;
  /** When it started (ms since the epoch). */
  startedAt: number;
  state: "running" | "done" | "failed";
  /** When the lead last touched this entry (ms); startedAt when missing. */
  updatedAt?: number;
  lastNote?: string;
}

/** The whole file. */
export interface ClaudeStatusFile {
  updatedAt: number;
  agents: ClaudeAgentStatus[];
}

const STATES: readonly ClaudeAgentStatus["state"][] = ["running", "done", "failed"];
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const oneLine = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const time = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);

/**
 * Checks the file's text. Anything that is not a valid file gives `undefined`; inside a valid file an entry with a bad id,
 * state or start time is dropped, strings are cut to one short line, and entries past {@link CLAUDE_STATUS_MAX} are ignored.
 *
 * @param text - The file's content.
 * @returns The cleaned file, or undefined when it is not usable.
 */
export function parseClaudeStatus(text: string): ClaudeStatusFile | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { agents?: unknown }).agents)) return undefined;
  const r = raw as { updatedAt?: unknown; agents: unknown[] };
  const agents: ClaudeAgentStatus[] = [];
  for (const x of r.agents.slice(0, CLAUDE_STATUS_MAX)) {
    if (!x || typeof x !== "object") continue;
    const a = x as Record<string, unknown>;
    const startedAt = time(a.startedAt);
    if (typeof a.id !== "string" || !ID_RE.test(a.id) || !STATES.includes(a.state as ClaudeAgentStatus["state"]) || !startedAt) continue;
    const updatedAt = time(a.updatedAt);
    const note = oneLine(a.lastNote, 200);
    agents.push({ id: a.id, title: oneLine(a.title, 120) || a.id, model: oneLine(a.model, 40), startedAt, state: a.state as ClaudeAgentStatus["state"], ...(updatedAt ? { updatedAt } : {}), ...(note ? { lastNote: note } : {}) });
  }
  return { updatedAt: time(r.updatedAt) ?? 0, agents };
}

/**
 * Is a running agent "maybe stuck": running, and nothing heard from it for {@link CLAUDE_STUCK_MS}.
 *
 * @param a - The entry.
 * @param now - The time now (ms; tests pass a fake clock).
 */
export function isMaybeStuck(a: ClaudeAgentStatus, now: number): boolean {
  return a.state === "running" && now - (a.updatedAt ?? a.startedAt) > CLAUDE_STUCK_MS;
}

/**
 * The entries to show as "Running now": the running ones, longest-running first.
 *
 * @param file - From {@link parseClaudeStatus}.
 */
export function runningAgents(file: ClaudeStatusFile | undefined): ClaudeAgentStatus[] {
  return (file?.agents ?? []).filter((a) => a.state === "running").sort((a, b) => a.startedAt - b.startedAt);
}

/** Whole minutes since `since` (never negative). */
export function minutesSince(since: number, now: number): number {
  return Math.max(0, Math.floor((now - since) / 60_000));
}
