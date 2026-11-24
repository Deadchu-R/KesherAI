/**
 * Claude Code as a task-inbox executor (docs/WORK_LIST.md "Claude as a KesherAI executor"; docs/RESEARCH_LOG.md
 * 2026-11-24): the user's own `claude` CLI on the PC, signed in with their own Claude subscription (never an API key),
 * run headless in a worktree. These are the settings, the state the pages show, and the quota rule both sides share.
 *
 * @packageDocumentation
 */

/** Settings > Task inbox > Claude Code (config `taskInbox.claude`). */
export interface ClaudeSettings {
  /** Claude Code may take tasks (off: its tasks wait). */
  enabled: boolean;
  /** Each task waits for the user's Run tap (default on, like Antigravity); off: they start by themselves. */
  askRun: boolean;
  /** Claude Code tasks a day (default 5). */
  dailyCap: number;
  /** No new task while the 5-hour window is at or above this percent (default 80). */
  fiveHourMax: number;
  /** No new task while the weekly window is at or above this percent (default 85). */
  weekMax: number;
  /** The model alias or id passed to `--model` (empty: Claude Code's own default). */
  model: string;
}

/** The defaults (Roee, 2026-11-24). */
export const CLAUDE_DEFAULTS: ClaudeSettings = { enabled: true, askRun: true, dailyCap: 5, fiveHourMax: 80, weekMax: 85, model: "" };

/** One usage window of the subscription: how much of it is used and when it resets. */
export interface ClaudeWindow {
  /** 0–100. */
  usedPercentage: number;
  /** When the window resets (ms since epoch). */
  resetsAt: number;
}

/**
 * The last reading of the subscription's limits, from Claude Code itself (its status-line JSON or its stream's
 * `rate_limit_event`): the whole account, the Claude app included. A window may be missing ("unknown").
 */
export interface ClaudeQuota {
  fiveHour?: ClaudeWindow;
  sevenDay?: ClaudeWindow;
  /** When it was read (ms since epoch). */
  at: number;
}

/** What Settings › Connections and the inbox show about Claude Code on this PC. */
export interface ClaudeState {
  /** The `claude` program was found and answered `--version`. */
  installed: boolean;
  version?: string;
  /** `claude auth status`: signed in (undefined: not known yet). */
  loggedIn?: boolean;
  /** How it is signed in: the user's subscription (allowed), an API key (refused), or none. */
  account?: "subscription" | "api-key" | "none";
  /** The plan's name when Claude Code says it (`max`, `pro`). */
  plan?: string;
  /** The last quota reading with its time (absent: none yet). */
  quota?: ClaudeQuota;
  /** Why no Claude task starts now, and until when (absent: it can start). */
  blocked?: { why: string; until?: number };
  /** Tasks started today. */
  used: number;
  /** When the install and login were last checked (ms since epoch). */
  checkedAt?: number;
}

/**
 * Whether the quota holds back a new Claude Code task: a window at or above its threshold that has not reset yet. A
 * missing window is unknown and holds nothing back (a usage-limit message from the CLI still stops the run).
 *
 * @param q - The last reading (undefined: unknown).
 * @param s - The thresholds.
 * @param now - The clock (ms).
 * @returns The window that blocks, its percent and its reset, or undefined.
 */
export function claudeQuotaBlock(q: ClaudeQuota | undefined, s: Pick<ClaudeSettings, "fiveHourMax" | "weekMax">, now: number): { window: "five_hour" | "seven_day"; used: number; until: number } | undefined {
  if (!q) return undefined;
  const over = (w: ClaudeWindow | undefined, max: number) => !!w && w.resetsAt > now && w.usedPercentage >= max;
  // The weekly window first: it lasts longer, so its reset is the real "until".
  if (over(q.sevenDay, s.weekMax)) return { window: "seven_day", used: q.sevenDay!.usedPercentage, until: q.sevenDay!.resetsAt };
  if (over(q.fiveHour, s.fiveHourMax)) return { window: "five_hour", used: q.fiveHour!.usedPercentage, until: q.fiveHour!.resetsAt };
  return undefined;
}

/**
 * A window's percent for a card: rounded, or undefined when unknown or already reset.
 *
 * @param w - The window.
 * @param now - The clock (ms).
 */
export function claudeWindowPercent(w: ClaudeWindow | undefined, now: number): number | undefined {
  return w && w.resetsAt > now ? Math.round(w.usedPercentage) : undefined;
}
