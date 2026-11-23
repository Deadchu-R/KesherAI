/**
 * The task inbox (docs/RESEARCH_LOG.md, "A task inbox"): coding tasks Claude (or Roee from the phone, or the Kesher
 * Cloud hub) writes to the `kesher-inbox` git branch; KesherAI on the PC lists them, runs each one with the executor it
 * names, checks the work itself and returns it as a branch for Claude to review. These are the shapes the server
 * sends to the page (`GET /api/task-inbox`), shared so the page and the server agree.
 */
import type { InboxModel } from "./inbox-models.js";
import type { AgentLabel } from "./agent-label.js";

/**
 * Who does a task: `auto` resolves by the routing table (see `routeTask` in packages/core/src/task-inbox.ts).
 * `opencode`: a code task on the user's flat OpenCode Go plan, run by itself in a code chat (no Run press: it is the
 * user's own API key, not an agent's account), on a cheap model for size S and a strong one for M and L.
 */
export type InboxExecutor = "auto" | "antigravity" | "local" | "opus" | "gemini" | "opencode";

/** How big a task is (research reports' "Size S/M/L"; picks the OpenCode Go model). */
export type InboxSize = "S" | "M" | "L";

/** The connection id of the user's OpenCode Go plan (packages/providers/src/presets.ts). */
export const OPENCODE_PROVIDER = "opencode-go";

/** Settings > Task inbox > OpenCode Go (config `taskInbox.opencode`). */
export interface OpencodeSettings {
  /** Off: no task goes to OpenCode Go, by hand or as the gap filler. */
  enabled: boolean;
  /** The model for small (S) tasks: cheap and fast. */
  small: string;
  /** The model for medium and large (M, L) tasks: strong. */
  strong: string;
  /** OpenCode Go tasks a day (its plan has one shared monthly allowance; this keeps a day from eating it). */
  dailyCap: number;
  /**
   * Try the plan's free models first (Beam Free, Iceman Contributor Free: unlimited "for a limited time", 2026-11-23).
   * A task on a free model does not count toward `dailyCap`; when they are gone or fail, the paid order takes over.
   */
  useFree?: boolean;
}

/** The defaults: a cheap model for small work, a stronger (still cheap) one for the rest, 15 a day. */
// Defaults by cost (Go plan, 2026-11-22, requests a month): Kimi K3 ~98 (44 requests spent a 5-hour window and 20% of
// the month), MiMo-V2.6-Pro ~3,260, MiMo-V2.6-Flash ~30,100. An agent task makes tens of requests, so the cheap pair.
export const OPENCODE_DEFAULTS: OpencodeSettings = { enabled: true, small: "opencode-go/mimo-v2.6-flash", strong: "opencode-go/mimo-v2.6-pro", dailyCap: 15 };

/**
 * The OpenCode Go model for a task, by its size: the cheap one for S, the strong one for M and L (like OpenCode's own
 * `small_model` beside `model`, and Cline's separate Plan and Act models). A task's own `model` that names an OpenCode
 * Go model wins.
 *
 * @param t - The task's size and model.
 * @param s - The OpenCode Go settings.
 * @returns The KesherAI model id (`opencode-go/<model>`).
 */
export function opencodeModelFor(t: { size?: InboxSize; model?: string }, s: Pick<OpencodeSettings, "small" | "strong">): string {
  if (t.model?.startsWith(`${OPENCODE_PROVIDER}/`)) return t.model;
  return t.size === "S" ? s.small || OPENCODE_DEFAULTS.small : s.strong || OPENCODE_DEFAULTS.strong;
}

/**
 * The models a task falls back to when its own model answers 429, in order (after the configured small and strong
 * ones). Kimi is never here: it has ~98 requests a month, so it runs only when the user configured or chose it.
 */
/** OpenCode Go's free models (unlimited while the offer lasts), tried first when `useFree` is on and the connection lists them. */
export const OPENCODE_FREE_MODELS: readonly string[] = ["opencode-go/beam-free", "opencode-go/iceman-contributor-free"];

/** Whether a model is one of the plan's free ones (does not count toward the daily cap). */
export const isFreeOpencodeModel = (id: string): boolean => OPENCODE_FREE_MODELS.includes(id);

/**
 * The free models to try first: on unless turned off, and only those the connection lists now (the offer is "for a
 * limited time"; an empty or unknown list means none).
 *
 * @param s - The OpenCode Go settings.
 * @param listed - The models the connection lists.
 */
export function opencodeFreeFirst(s: Pick<OpencodeSettings, "useFree">, listed: readonly string[]): string[] {
  return s.useFree === false ? [] : OPENCODE_FREE_MODELS.filter((m) => listed.includes(m));
}

export const OPENCODE_FALLBACKS: readonly string[] = ["opencode-go/mimo-v2.6-flash", "opencode-go/deepseek-v4.1-flash", "opencode-go/glm-5.3", "opencode-go/mimo-v2.6-pro"];

/** What the Go plan ($10) allows a month, per model (approximate, 2026-11-22), shown in the OpenCode card. */
export const OPENCODE_MONTHLY_REQUESTS: ReadonlyArray<{ id: string; name: string; requests: number }> = [
  { id: "opencode-go/beam-free", name: "Beam Free", requests: Infinity },
  { id: "opencode-go/iceman-contributor-free", name: "Iceman Contributor Free", requests: Infinity },
  { id: "opencode-go/kimi-k3", name: "Kimi K3", requests: 98 },
  { id: "opencode-go/mimo-v2.6-pro", name: "MiMo-V2.6-Pro", requests: 3260 },
  { id: "opencode-go/glm-5.3", name: "GLM-5.3", requests: 2640 },
  { id: "opencode-go/mimo-v2.6-flash", name: "MiMo-V2.6-Flash", requests: 30100 },
  { id: "opencode-go/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", requests: 43300 },
];

/**
 * The models OpenCode Go may use for a task, in order: the configured small and strong, then the fallbacks. No
 * duplicates; kimi appears only when configured.
 *
 * @param s - The OpenCode Go settings.
 */
export function opencodeModelOrder(s: Pick<OpencodeSettings, "small" | "strong">): string[] {
  return [...new Set([s.small || OPENCODE_DEFAULTS.small, s.strong || OPENCODE_DEFAULTS.strong, ...OPENCODE_FALLBACKS])];
}

/**
 * The first model that is not cooling down. `first` (the task's own pick) is tried before the order; `skip` models
 * (one that just answered 429) are never returned.
 *
 * @param order - The models in order (opencodeModelOrder).
 * @param until - Each model's cooldown end (ms since epoch); absent or past means free.
 * @param now - Now (ms).
 * @param first - The model to prefer, when free.
 * @param skip - Models to leave out.
 * @returns The model id, or undefined when all are cooling down.
 */
export function opencodeFreeModel(order: readonly string[], until: Readonly<Record<string, number>>, now: number, first?: string, skip: readonly string[] = []): string | undefined {
  const free = (m: string): boolean => !skip.includes(m) && (until[m] ?? 0) <= now;
  if (first && free(first)) return first;
  return order.find(free);
}

/** A model id without its connection (`opencode-go/kimi-k3` → `kimi-k3`), for cards. */
export const opencodeModelName = (id: string): string => id.replace(new RegExp(`^${OPENCODE_PROVIDER}/`), "");

/**
 * What a task is: `code` (the default) changes the project; `research` only writes one report, either with Antigravity
 * (big research, needs the user's Run) or with the free Gemini key (small research, runs by itself).
 */
export type InboxKind = "code" | "research";

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
  /** `research`: the task writes one report (`docs/research/<id>.md`) and nothing else; absent = `code`. */
  kind?: InboxKind;
  /** `size: S|M|L` (absent: guessed from its limits, see `sizeOf` in packages/core/src/task-inbox.ts). */
  size?: InboxSize;
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
  /** `local_ok: true`: the local model may carry it while Claude cools down (never an Antigravity task). */
  localOk?: boolean;
  /** `replaces: [ids]`: older tasks this one supersedes; the PC skips those that have not started, with a note. */
  replaces?: string[];
  /** The standing "what to research next" task (a fresh copy of a template, shown while Antigravity is idle; inbox-queue.ts). */
  standing?: boolean;
  /** For a standing copy: the template task it was copied from (none: the "what to research next" template). */
  standingOf?: string;
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
  /** The owner's own name and note for its agent run (agent-labels.ts; added by the route, not stored with it). */
  label?: AgentLabel;
  /** The executor after routing (`auto` resolved). */
  runBy: Exclude<InboxExecutor, "auto">;
  /** The branch the work goes to (`agy/<id>-<slug>`, `-partial` when kept unfinished). */
  branch: string;
  /** The board item it was put on (the shared task board). */
  boardId?: string;
  /** The place in its executor's queue (1 = next), while the user has it queued (added by the PC's list, never stored). */
  queued?: number;
  /** A local-model task's board item while it is not ended: open = waits for the local agent, claimed = it works on it. */
  boardState?: "open" | "claimed";
  /** The model it ran on, as the agent named it. */
  modelUsed?: string;
  /** Set when the chosen model could not run (quota, unavailable) and another took over, e.g. "Claude Opus 4.6 → Claude Sonnet 4.6 (quota)". */
  modelFallback?: string;
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
  /** A free-Gemini research task's report (the result file carries it whole; the page shows it). */
  researchReport?: string;
  /** The research report is on main (its commit, short), merged by KesherAI itself (research-publish.ts). */
  merged?: string;
  /** For a free-Gemini task deferred by its quota: when it may try once more by itself (ms since epoch). */
  retryAt?: number;
  /** The one automatic retry after the quota reset was used (a second quota stop waits for the user). */
  autoRetried?: boolean;
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
  /**
   * Set when this is the "Next in line — Start?" ask after a task ended (the queue never starts a task by itself):
   * `done` is the title of the task that ended, `more` how many are in line behind this one.
   */
  next?: { done: string; more: number };
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
  /** OpenCode Go: the flat coding plan that takes S/M code tasks while Antigravity is out (absent: the defaults). */
  opencode?: OpencodeSettings;
  /** Research → tasks loop: tasks from research reports fill the Antigravity and local lines by themselves (default on). */
  loop?: boolean;
  maxMinutes: number;
  /** The model inside Antigravity (empty: Gemini's default). */
  model: string;
  /**
   * Ask on the phone for each step the policy is unsure about (true), or approve once per task (false, the default):
   * the Run press approves the task, steps inside the policy go ahead, and unsure steps are refused and listed in the
   * result for review instead of waiting for an answer (Roee, 2026-11-21).
   */
  askSteps?: boolean;
  allowedPaths: string[];
  forbiddenPaths: string[];
  /** Commands the agent may run without asking, and the only ones KesherAI runs as a task's check. */
  commands: string[];
  /**
   * Per executor: ask "Next in line: X - Start?" when a task ends and another is queued (true), or start the next
   * queued task by itself (false). Antigravity defaults to asking (Roee, 2026-11-22); the local model to starting by itself.
   */
  askBeforeNext: { antigravity: boolean; local: boolean };
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
  /** The models Antigravity offered in its last session (inbox-models.ts); empty before it was asked once. */
  models?: InboxModel[];
  /** OpenCode Go now: its connection is set up with a key, today's count, and its limit's end when it answered 429. */
  opencode?: OpencodeState;
  /**
   * The work loop (Settings › Task inbox › Keep the work loop running): running, paused until Antigravity can work
   * again (its quota, every model's quota, or today's cap: `until` in ms), or off.
   */
  loop?: { state: "running" | "paused" | "off"; until?: number; why?: "quota" | "models" | "cap" };
}

/** OpenCode Go's state for the settings card and the queue. */
export interface OpencodeState {
  /** The `opencode-go` connection exists and has a key. */
  ready: boolean;
  /** Tasks started today. */
  used: number;
  /** Its plan's limit was reached: no task starts before this (ms since epoch). */
  until?: number;
  /** Models cooling down after a 429: model id → when it is free again (ms since epoch). Only those still cooling. */
  cooldowns?: Record<string, number>;
  /** The models its connection lists (`opencode-go/<model>`), for the pickers; empty when it could not be asked. */
  models: string[];
}

/** What the PC answers (HTTP 409) when Run is pressed on an Antigravity task while another one runs. */
export const BUSY_RUN_TEXT = { he: "משימה רצה, אין להריץ עד שתסתיים", en: "A task is running; do not run another until it ends" } as const;
