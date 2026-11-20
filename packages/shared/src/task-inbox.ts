/**
 * The task inbox (docs/RESEARCH_LOG.md, "A task inbox"): coding tasks Claude (or Roee from the phone, or the Kesher
 * Cloud hub) writes to the `kesher-inbox` git branch; KesherAI on the PC lists them, runs each one with the executor it
 * names, checks the work itself and returns it as a branch for Claude to review. These are the shapes the server
 * sends to the page (`GET /api/task-inbox`), shared so the page and the server agree.
 */

/** Who does a task: `auto` resolves by the routing table (see `routeTask` in packages/core/src/task-inbox.ts). */
export type InboxExecutor = "auto" | "antigravity" | "local" | "opus";

/** How risky a task is (security, git, auth, releases are always `high`). */
export type InboxRisk = "low" | "medium" | "high";

/** Where a task came from (`device`: another of the user's devices, through Google Drive; it always waits for Run). */
export type InboxFrom = "claude" | "roee" | "self-work" | "hub" | "device";

/**
 * A task's state in the queue:
 * - `waiting`: ready; an Antigravity task waits for the user's Run on the PC, a local one for self-work.
 * - `queued`: handed on (to self-work through the board, or kept for Claude's own Opus agent).
 * - `running`, `needs-approval` (an agent step waits for the user), then one of the ends:
 * - `done`, `partial` (work kept as a `-partial` branch), `failed`, `declined` (refused by a rule),
 *   `deferred-quota` (the plan's quota ran out; Run again later), `skipped` (the user skipped it).
 */
export type InboxStatus = "waiting" | "queued" | "running" | "needs-approval" | "done" | "partial" | "failed" | "declined" | "deferred-quota" | "skipped";

/** A task as written in `tasks/<id>.md` (frontmatter and sections), after checking. */
export interface InboxTaskSpec {
  id: string;
  title: string;
  executor: InboxExecutor;
  risk: InboxRisk;
  from: InboxFrom;
  /** The branch or commit to start from (default `origin/main`). */
  base: string;
  allowedPaths: string[];
  forbiddenPaths: string[];
  /** The check KesherAI runs after the agent (only parts that are on the allowed command list). */
  check: string;
  maxMinutes: number;
  maxFiles: number;
  /** A model the task asks for (inside Antigravity); empty = the inbox's default. */
  model?: string;
  goal: string;
  readFirst?: string;
  acceptance?: string;
  outOfScope?: string;
  report?: string;
}

/** What KesherAI decided about one agent step (a permission request). */
export interface InboxDecision {
  at: number;
  verdict: "allow" | "deny" | "ask";
  /** The step as the agent named it, e.g. `pnpm add fuse.js` or `edit DownloadsHistory.tsx`. */
  what: string;
  /** Which rule decided, in English (the page translates the known ones). */
  rule: string;
  /** For `ask`: the user's answer. */
  answer?: "allow" | "deny" | "timeout";
}

/** An agent step waiting for the user's answer. */
export interface InboxApprovalAsk {
  requestId: string;
  what: string;
  /** The agent's own words for why (its step title), if any. */
  why?: string;
  /** The working folder it runs in (shown as the branch, never a personal path). */
  where: string;
  /** Why KesherAI asks instead of deciding. */
  rule: string;
  /** When it is denied without an answer (ms since epoch). */
  until: number;
}

/** One check KesherAI ran on the work. */
export interface InboxCheck {
  name: string;
  command?: string;
  ok: boolean;
  /** A short result ("0 errors", "4 files inside the allowed paths") or the output's tail. */
  note: string;
}

/** A task with everything the queue and the task page show. */
export interface InboxTaskView extends InboxTaskSpec {
  status: InboxStatus;
  /** The executor after routing (`auto` resolved). */
  runBy: Exclude<InboxExecutor, "auto">;
  /** The branch the work goes to (`agy/<id>-<slug>`, `-partial` when kept unfinished). */
  branch: string;
  /** The board item it was put on (the shared task board). */
  boardId?: string;
  /** The model it ran on, as the agent named it. */
  modelUsed?: string;
  plan?: Array<{ content: string; status: string }>;
  steps?: number;
  decisions?: InboxDecision[];
  pending?: InboxApprovalAsk;
  checks?: InboxCheck[];
  files?: Array<{ path: string; added: number; removed: number }>;
  /** The diff (cut to about 60 KB) for the task page. */
  diff?: string;
  headSha?: string;
  pushed?: boolean;
  /** The agent's own short report. */
  summary?: string;
  /** Why it failed, was declined or deferred. */
  note?: string;
  startedAt?: number;
  endedAt?: number;
  /** Whether the result file was written to the inbox branch. */
  resultWritten?: boolean;
  /**
   * The PC asks "Run this task in Antigravity?" (shown on the PC and the phone, and sent through the hub): one ask is
   * one run, it is used up by the answer and expires after 30 minutes; a "yes" is never remembered.
   */
  runAsk?: InboxRunAsk;
}

/** A waiting "Run this task in Antigravity?" question. */
export interface InboxRunAsk {
  requestId: string;
  at: number;
  /** It expires then (ms since epoch). */
  until: number;
  /** Antigravity tasks left today when it was asked. */
  left: number;
}

/** Settings > Task inbox (config `taskInbox`). */
export interface InboxSettings {
  /** Off: no fetching, no runs (the kill switch). */
  enabled: boolean;
  paused: boolean;
  /** The git project on this computer whose `origin` holds the inbox branch. */
  repo?: string;
  /** The inbox branch's name (default `kesher-inbox`). */
  branch: string;
  fetchMinutes: number;
  /** Antigravity tasks a day (default 10). */
  dailyCap: number;
  maxMinutes: number;
  /** The model inside Antigravity (empty: Gemini's default). */
  model: string;
  allowedPaths: string[];
  forbiddenPaths: string[];
  /** Commands the agent may run without asking, and the only ones KesherAI runs as a task's check. */
  commands: string[];
  /** Busy rules: Run waits while a game, an editor, or a busy graphics card is on. */
  notWhileGame: boolean;
  notWhileEditor: boolean;
  /** Percent; 0 = off. */
  gpuBusyPercent: number;
}

/** Why the PC is busy now, or free. */
export interface InboxBusy {
  free: boolean;
  reasons: string[];
  gpu?: number;
  games?: number;
}

/**
 * The inbox's `lastError` when the git program cannot be started (not installed, or not on PATH). The page shows its
 * own Hebrew and English text for it instead of the raw system message (on Windows, cmd.exe's "is not recognized").
 */
export const INBOX_GIT_MISSING = "Git for Windows is not installed / not found: install it from git-scm.com (or `winget install Git.Git`) and restart KesherAI.";

/** `GET /api/task-inbox`: the queue and its state. */
export interface InboxState {
  settings: InboxSettings;
  today: { date: string; used: number };
  tasks: InboxTaskView[];
  busy: InboxBusy;
  lastFetch?: number;
  lastError?: string;
  /** The plan's quota ran out: Antigravity can run again after this time. */
  quota?: { until: number; taskId?: string; estimated: boolean };
  /** The page runs on this computer itself (Run starts at once); elsewhere Run answers the PC's ask. */
  runHere: boolean;
  /** The project's folder name (never its full path), for the ask card. */
  project?: string;
}
