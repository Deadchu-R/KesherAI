import { createHash, randomBytes } from "node:crypto";
import { AGENT_GIT_IDENTITY } from "@kesher/agent";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { RELAY_PIN, matchModel, isSecurityFile, antigravityQuotaSummary, type AntigravityQuota, defaultFamilyFor, familyOf, isModelUnavailable, type ModelFamily, modelChain, pickableModels, BUSY_RUN_TEXT, INBOX_GIT_MISSING, OPENCODE_DEFAULTS, isFreeOpencodeModel, OPENCODE_PROVIDER, FREE_PROVIDERS, RELAY_PROVIDERS, relayProviderOf, safeForRelay, stepNote, relayReport, type RelayRun, type RelayProbe, freeModelsFor, freeProviderOf, inboxModelAllowed, safeForTrainingProvider, trainingRiskOf, type FreeProviderState, opencodeFreeFirst, opencodeFreeModel, opencodeModelFor, opencodeModelOrder, opencodeModelName, type OpencodeSettings, type OpencodeState, type InboxApprovalAsk, type InboxBusy, type InboxRunAsk, type InboxCheck, type InboxModel, type InboxSettings, type InboxState, type InboxStatus, type InboxTaskSpec, type InboxTaskView, CLAUDE_DEFAULTS, claudeQuotaBlock, type ClaudeQuota, type ClaudeSettings, type ClaudeState } from "@kesher/shared";
import type { AcpAgent, AcpHandlers, AcpPermission } from "./acp.js";
import { optionFor } from "./acp-chat.js";
import { changesVersion, checkPaths, decideStep, isResearchReport, redactReport, scanDiff } from "./inbox-policy.js";
import { isPrivacySkip } from "./privacy-guard.js";
import { createSessionWorktree, excludeWorktrees, sweepWorktrees, tidyWorktreesRoot, worktreeFolder, type Git } from "./session-worktrees.js";
import { heavyGate } from "./heavy-gate.js";
import { UsageLog, baselineOf, overBaseline, type UsageEntry } from "./usage-log.js";
import { findSavings } from "./savings.js";
import type { ClaudeEvent, ClaudeRunEnd } from "./claude-exec.js";
import { limitsFor, parseReview, parseWatchVerdict, reviewPrompt, rescuePrompt, RunGuard, RunWatch, stopNote, watchdogPrompt, type AgentStep, type GuardHooks, type StopReason } from "./agent-watch.js";
import { retryAfterMs } from "./free-cloud.js";
import { nextUtcMidnight, type FreeUsage } from "./openrouter-free.js";
import { freedSlotNote, periodicDue, PERIODIC_STANDING, queueStep, standingId, standingPlan, STANDING_TEMPLATE_ID, TaskLines, QUEUE_EXECUTORS, type QueueExecutor } from "./inbox-queue.js";
import { ProgressTicker, progressRef, type ProgressNote } from "./inbox-progress.js";
import { goalFor, nextForExecutor, parseResearchTasks, sameTask, type ResearchTask } from "./research-tasks.js";
import { publishResearch } from "./research-publish.js";
import { DRAIN_NOTE } from "./update-drain.js";
import { dailySummary, LINE_TARGET, localDay, LOOP_TICK_MS, loopState, standingDue, STANDING_LOOP_NOTE, summaryDue, type LoopState } from "./work-loop.js";
import type { TaskBoard } from "./task-board.js";
import { agentPrompt, boardSizeFor, branchFor, checkParts, INBOX_DEFAULTS, parseTaskFile, pushRef, resultFileText, routeTask, slugOf, taskFileText, taskSize, validBranchName, validTaskId } from "./task-inbox.js";

/**
 * The task inbox on the PC (docs/RESEARCH_LOG.md, "A task inbox", plan steps 2, 4 and 6): fetches the `kesher-inbox`
 * branch, puts each new task in the queue and on the shared task board, and runs an Antigravity task **only when the
 * user presses Run on this computer**, one task per press, one prompt per task, never in parallel (Roee's decision and
 * Google's terms for a personal plan; see the 2026-11-19 terms entry). The agent works in its own worktree with no
 * secrets; KesherAI answers its permission requests by the inbox policy, then checks the work itself (paths, secrets
 * and privacy, version fields, the allowed check commands), commits it, and pushes only that `agy/*` branch and the
 * result file on the inbox branch. Local-model tasks go to self-work through the board; Opus tasks stay for Claude.
 */

/**
 * Runs a command: arguments as a list, never through a shell. For {@link TaskInboxDeps.git} the list holds only git's
 * arguments (`["fetch", …]`, without "git"); for {@link TaskInboxDeps.run} the program comes first.
 */
export type RunCmd = (cwd: string, args: string[], timeoutMs?: number) => Promise<{ code: number; out: string }>;

/** What the inbox needs from KesherAI (injected, so it can be tested with a local bare repo and a fake agent). */
export interface TaskInboxDeps {
  /** Settings > Task inbox (already filled with defaults). */
  settings: () => Partial<InboxSettings>;
  /**
   * Whether an update waits for a free moment (update-drain.ts): no new run starts (the running one finishes), and
   * waiting tasks show {@link DRAIN_NOTE}. Absent: never.
   */
  draining?: () => boolean;
  /** Where the queue is kept (KesherAI's data folder). */
  file: string;
  /** Runs git with these arguments (the program is git itself; the list starts with the git command, e.g. "fetch"). */
  git: RunCmd;
  /** Runs one check command (an argument list), at low priority. */
  run: RunCmd;
  /** Starts the unmodified `agy acp` in the folder (it signs in by itself; no token passes through KesherAI). */
  startAgent: (cwd: string, h: AcpHandlers) => Promise<AcpAgent>;
  board?: TaskBoard;
  /** Tells the user (PC and phone); `path` is where a tap on it goes in the app (default Settings). */
  notify: (title: string, body: string, opts?: { path?: string; actions?: Array<{ label: string; path: string }>; ref?: string }) => void;
  /**
   * The live progress notification of a running Antigravity task, to the phone app only (inbox-progress.ts); the same
   * `ref` as the task's started and freed-slot notifications, so each one replaces the last. Absent: none.
   */
  progress?: (n: ProgressNote) => void;
  busy: () => Promise<InboxBusy>;
  /** This computer's user name and home folder, which the privacy scan looks for. */
  me?: { username?: string; home?: string };
  /**
   * Small research tasks with the user's free "gemini" provider (route B; absent: none can run). `ready` says whether
   * that provider is configured; `run` writes the report for a question (deep-research.ts `researchReport`) and throws
   * the provider's own error, so a quota or billing error can be told apart here.
   */
  research?: { ready: () => boolean; run: (question: string, signal: AbortSignal) => Promise<string> };
  /**
   * Code tasks on the user's flat OpenCode Go plan (absent: none can run). `ready`: its connection exists and has a key.
   * `models`: the models its connection lists. `run`: one task in a self-work style code chat (auto mode, unattended) in
   * the worktree, on the model; it resolves with the model's last answer, or throws the provider's error (a 429 carries
   * `retryAfterMs` when the answer said how long to wait).
   */
  /** Reads Antigravity's quota on this PC (antigravity-quota.ts); absent in tests. */
  agQuota?: (why?: (step: string) => void) => Promise<AntigravityQuota | undefined>;
  coder?: {
    ready: () => boolean;
    models: () => Promise<string[]>;
    /**
     * The free services after Beam Free (shared `FREE_PROVIDERS`), by connection id: `ready` (connection with a key),
     * its chat `models`, and `usage` (OpenRouter's own count of today's free requests, when it can say).
     */
    free?: Record<string, { ready: () => boolean; models: () => Promise<string[]>; usage?: () => Promise<FreeUsage | undefined>; probe?: (model: string, signal: AbortSignal) => Promise<string> }>;
    /**
     * `onStep` gets the step count and, when known, the step itself (tool and arguments) for the run guard.
     * `attach` is called once with a function that sends a user message into the running chat (the rescue hint).
     */
    run: (o: { worktree: string; title: string; prompt: string; model: string; signal: AbortSignal; onStep: (steps: number, step?: AgentStep) => void; attach?: (send: (text: string) => Promise<void>) => void }) => Promise<{ text: string }>;
  };
  /**
   * Claude Code on this PC (claude-exec.ts; absent: none can run), signed in with the user's own subscription. `check`:
   * installed and signed in (Claude Code's own `auth status`; the token is never read). `quota`: the last reading of the
   * subscription's limits. `run`: one task headless in the worktree; it resolves with how the run ended (a usage-limit
   * message in `limit`) and rejects only when the program could not start.
   */
  claude?: {
    check: () => Promise<Pick<ClaudeState, "installed" | "version" | "loggedIn" | "account" | "plan">>;
    quota: () => Promise<ClaudeQuota | undefined>;
    run: (o: { worktree: string; prompt: string; model: string; commands: readonly string[]; signal: AbortSignal; onEvent: (e: ClaudeEvent) => void; attach: (send: (text: string) => Promise<void>) => void }) => Promise<ClaudeRunEnd>;
  };
  /**
   * Second models for the run guard (agent-watch.ts). `ask`: a model other than the agent's, for one rescue hint and the
   * end review: the local chat model when loaded and idle, else an open free provider, never a paid one; `canTrain`
   * false means a service that may train on prompts must not get it. `look`: the small local router model for the
   * watchdog (undefined when it is not available). Absent: no rescue, no review, no watchdog (the hard rules stay).
   */
  helpers?: {
    ask: (o: { system: string; prompt: string; signal: AbortSignal; canTrain: boolean }) => Promise<{ text: string; model: string } | undefined>;
    look: (o: { system: string; prompt: string; signal: AbortSignal }) => Promise<string | undefined>;
  };
  /** The usage log (usage-log.ts): what every run used and every warning of the guard. Absent: nothing is logged. */
  usage?: UsageLog;
  /** How often the guard looks at a run (default 30 s) and how often the watchdog asks (default 3 min); tests make them short. */
  watchEveryMs?: number;
  lookEveryMs?: number;
  now?: () => number;
  /** The heavy job that runs now (default: the app's heavy-job gate); a queued task waits while there is one. */
  heavy?: () => string | undefined;
  /** How long an asked step waits before it is denied (default 30 minutes). */
  approvalMs?: number;
}

/** The commit author for everything the inbox commits (never the user's own name or email). */
const AUTHOR = ["-c", `user.name=${AGENT_GIT_IDENTITY.GIT_AUTHOR_NAME}`, "-c", `user.email=${AGENT_GIT_IDENTITY.GIT_AUTHOR_EMAIL}`, "-c", "commit.gpgsign=false"];

/** What is kept in the queue file. */
interface Saved {
  tasks: InboxTaskView[];
  /** The relay's attempts (GhostCLI trial), the last 200. */
  relayLog?: RelayRun[];
  /** The relay's last small "are you there" message (every 15 minutes): it gets tasks only while this answered. */
  relayHealth?: RelayProbe;
  /** Antigravity's quota, last read on this PC (every few minutes). */
  agQuota?: AntigravityQuota;
  /** Why the last reading of Antigravity's quota found nothing (shown on the page, to fix it from there). */
  agQuotaWhy?: string;
  today: { date: string; used: number };
  quota?: InboxState["quota"];
  /** The free Gemini key's limit ran out: no free-Gemini task starts before this (ms since epoch). */
  geminiUntil?: number;
  lastFetch?: number;
  lastError?: string;
  /** The models Antigravity listed in its last session, and when (the per-task picker shows the available ones). */
  models?: InboxModel[];
  modelsAt?: number;
  /** A model family whose quota ran out, and until when (ms): later tasks start on the next model of their chain. */
  familyUntil?: Partial<Record<ModelFamily, number>>;
  /** Families whose `familyUntil` came from Antigravity's own words ("Individual quota reached … Resets in 1h19m"), not a guess. */
  familySure?: Partial<Record<ModelFamily, boolean>>;
  /** OpenCode Go: tasks started today, and the end of its plan's limit after a 429 (ms since epoch). */
  opencode?: { date: string; used: number; modelUntil?: Record<string, number> };
  /** Claude Code: tasks started today (UTC), and the end of a usage limit its CLI reported (ms since epoch). */
  claude?: { date: string; used: number; until?: number };
  /** The free services (shared FREE_PROVIDERS), by connection id: today's requests (UTC; failed ones too), the day's limit when known, and a stop until a time (402, 429 or the limit). */
  free?: Record<string, { date: string; used: number; limit?: number; until?: number }>;
  /** Research → tasks (research-tasks.ts): reports read (path → blob id), tasks not made yet, and the ones made. */
  research?: { seen: Record<string, string>; backlog: ResearchTask[]; made: string[]; at?: number };
  /** The work loop (work-loop.ts): the local day it last offered the standing task and sent the summary, and when. */
  loop?: { standingDay?: string; summaryDay?: string; summaryAt?: number; offer?: string[] };
}

/** What a message ask shows: the agent's task in a few words, the message, and where it runs. */
export interface MessageAskInfo {
  title: string;
  text: string;
  /** The project or copy it runs in (a name, never a full path). */
  where: string;
}

/** An error with an HTTP status for the route. */
const fail = (msg: string, code: number) => Object.assign(new Error(msg), { code });

/** Statuses a task can be Run from. */
const RUNNABLE = new Set<InboxStatus>(["waiting", "failed", "partial", "deferred-quota"]);

/** The run in progress. */
interface Active {
  id: string;
  agent?: AcpAgent;
  why?: "stop" | StopReason;
  /** A rescue hint waiting to be sent as the next prompt (the turn was cancelled to send it). */
  hint?: string;
  answer?: (decision: "allow" | "deny" | "timeout") => void;
  /** Started from the queue: no "started" notification of its own (the freed-slot one says it). */
  quiet?: boolean;
  done: Promise<void>;
}

/**
 * When the plan's quota resets, from the agent's error text ("retry in 1h35m", "try again in 20 minutes").
 *
 * @param msg - The error.
 * @param now - The time.
 * @returns The time, and whether it is a guess (an hour) because the text did not say.
 */
export function quotaUntil(msg: string, now: number): { until: number; estimated: boolean } {
  const after = /(?:retry|try again|resets?|available)([\s\S]{0,40})/i.exec(msg)?.[1] ?? "";
  const h = Number(/(\d{1,2})\s*h/i.exec(after)?.[1] ?? 0);
  const min = Number(/(\d{1,3})\s*m/i.exec(after)?.[1] ?? 0);
  if (h || min) return { until: now + (h * 60 + min) * 60_000, estimated: false };
  return { until: now + 60 * 60_000, estimated: true };
}

/**
 * Whether an agent's or provider's error is its plan's quota or rate limit, or an offer to pay (credits, an upgrade,
 * billing). Never paid for, ever (Roee, 2026-11-21): the task is deferred to the reset instead of failing or buying.
 * The free Gemini key must stay without a billing account, so it can never charge.
 */
export function isQuotaError(msg: string): boolean {
  return /quota|rate.?limit|resource.?exhausted|\b429\b|usage limit|limit reached|exceeded your|ai credits?|(buy|purchase|top.?up|add|get)\s+(more\s+)?credits?|\bpurchase\b|upgrade\s+(your\s+|to\s+|the\s+)?(a\s+)?(plan|subscription|pro|ultra|tier)|\bbilling\b/i.test(msg);
}

/**
 * The title of the ask after a task ended ("Done: X. Next in line: Y — Start?"), at most 160 characters: each title is
 * cut so the sentence always fits.
 *
 * @param done - The title of the task that ended.
 * @param next - The title of the task that is next in line.
 */
export function nextInLineTitle(done: string, next: string): string {
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
  return `Done: ${cut(done, 60)}. Next in line: ${cut(next, 60)} — Start?`;
}

/** The queue, its runs and the inbox branch. */
export class TaskInbox {
  private saved: Saved = { tasks: [], today: { date: "", used: 0 } };
  private loaded = false;
  private active?: Active;
  /**
   * Tasks the user pressed Run on while another ran, in order. Nothing in it starts by itself: when the running task
   * ends, the first one gets the ask "Next in line — Start?" and starts only on the user's own Start. Kept in memory:
   * a restart empties it (see {@link load}), the safe choice since nothing may start without a fresh answer.
   */
  /** The user's lines per executor (inbox-queue.ts), in memory only. */
  private readonly lines = new TaskLines();
  /** The title of the task that just ended, per executor, until its next queued task was asked about or started. */
  private readonly pendingDone: Partial<Record<QueueExecutor, string>> = {};
  private queueTimer?: ReturnType<typeof setInterval>;
  /** Counts how often the Antigravity slot was taken: a freed-slot Run button is only good for the slot it was made for. */
  private slotEpoch = 0;
  /** The freed-slot notification's one-time Run codes: the task, the slot it belongs to and when it expires. */
  private readonly quickRuns = new Map<string, { id: string; epoch: number; expires: number }>();
  private timer?: ReturnType<typeof setInterval>;
  /** The work loop's one light timer (every {@link LOOP_TICK_MS}): feeds the lines, the standing task, the summary. */
  private loopTimer?: ReturnType<typeof setInterval>;
  /** Asks for one message to Antigravity from a chat's agent (kept in memory: a restart drops them, nothing runs). */
  private readonly messageAsks = new Map<string, { ask: InboxRunAsk; info: MessageAskInfo; done: (a: "allow" | "deny" | "timeout") => void }>();
  private saving: Promise<void> = Promise.resolve();
  private syncing?: Promise<void>;
  /** The free-Gemini research loop (one task at a time) and the stop for its current model call. */
  private geminiRun?: Promise<void>;
  private geminiStop?: AbortController;
  /** The OpenCode Go loop (one task at a time) and the stop for its running task. */
  private opencodeRun?: Promise<void>;
  /** The Claude Code run going on now (one at a time), and how to stop it. */
  private claudeRun?: Promise<void>;
  private claudeStop?: { id: string; ctl: AbortController; why?: "stop" | StopReason };
  private opencodeStop?: { id: string; ctl: AbortController; why?: "stop" | StopReason };

  /** @param d - What it needs from KesherAI. */
  constructor(private readonly d: TaskInboxDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private get s(): InboxSettings {
    // Unset fields (lists the user never changed) keep the defaults.
    const given = Object.fromEntries(Object.entries(this.d.settings()).filter(([, v]) => v !== undefined));
    const ask = { ...INBOX_DEFAULTS.askBeforeNext, ...((given.askBeforeNext as Partial<InboxSettings["askBeforeNext"]> | undefined) ?? {}) };
    const opencode = { ...OPENCODE_DEFAULTS, ...((given.opencode as Partial<OpencodeSettings> | undefined) ?? {}) };
    const claude = { ...CLAUDE_DEFAULTS, ...((given.claude as Partial<ClaudeSettings> | undefined) ?? {}) };
    return { ...INBOX_DEFAULTS, ...given, askBeforeNext: ask, opencode, claude } as InboxSettings;
  }

  /** The Claude Code settings, with the defaults filled in. */
  private get cs(): ClaudeSettings {
    return this.s.claude ?? CLAUDE_DEFAULTS;
  }

  /** Today's Claude Code count (UTC); a usage limit's end stays across the day. */
  private claudeToday(): { date: string; used: number; until?: number } {
    const date = new Date(this.now()).toISOString().slice(0, 10);
    if (this.saved.claude?.date !== date) this.saved.claude = { date, used: 0, ...(this.saved.claude?.until ? { until: this.saved.claude.until } : {}) };
    return this.saved.claude;
  }

  /** The OpenCode Go settings, with the defaults filled in. */
  private get oc(): OpencodeSettings {
    return this.s.opencode ?? OPENCODE_DEFAULTS;
  }

  /** Today's OpenCode Go count, reset at midnight (UTC, like Antigravity's). */
  private ocToday(): { date: string; used: number; modelUntil?: Record<string, number> } {
    const date = new Date(this.now()).toISOString().slice(0, 10);
    if (this.saved.opencode?.date !== date) this.saved.opencode = { date, used: 0, ...(this.saved.opencode?.modelUntil ? { modelUntil: this.saved.opencode.modelUntil } : {}) };
    return this.saved.opencode;
  }

  /** One free service's counters for today (UTC); the day resets the count, an unexpired stop stays. */
  private freeDay(id: string): { date: string; used: number; limit?: number; until?: number } {
    const date = new Date(this.now()).toISOString().slice(0, 10);
    const all = (this.saved.free ??= {});
    const cur = all[id];
    if (cur?.date === date) {
      if (cur.until !== undefined && cur.until <= this.now()) delete cur.until;
      return cur;
    }
    return (all[id] = { date, used: 0, ...(cur?.until && cur.until > this.now() ? { until: cur.until } : {}) });
  }

  /** Whether a free service may take a request now: not stopped, and under its day's limit. */
  private freeOpen(id: string): boolean {
    const d = this.freeDay(id);
    const limit = d.limit ?? FREE_PROVIDERS.find((f) => f.id === id)?.dailyLimit;
    return !d.until && (limit === undefined || d.used < limit);
  }

  /**
   * The free service models to try first for a small (S) task, in order (Z.ai, OpenRouter, then Mistral, NVIDIA and the
   * contributor models only with `freeTrainingOk`): only what each connection lists now, from services that are not
   * stopped or at their day's limit. OpenRouter's own request count is read first when it can say.
   *
   * @param c - The coder (its free connections).
   * @param opencodeListed - The OpenCode Go connection's models (for its contributor ones).
   * @param trainOk - Services that may train on prompts may be used (the setting is on and this task passed the safety gate).
   */
  private async freeServiceModels(c: NonNullable<TaskInboxDeps["coder"]>, opencodeListed: readonly string[], trainOk: boolean): Promise<string[]> {
    if (this.oc.useFree === false) return [];
    const listed: Record<string, readonly string[]> = { [OPENCODE_PROVIDER]: opencodeListed };
    for (const f of FREE_PROVIDERS) {
      const conn = c.free?.[f.id];
      if (f.id === OPENCODE_PROVIDER || !conn?.ready()) continue;
      listed[f.id] = await this.connModels(f.id, conn);
      await this.syncFreeUsage(f.id, conn);
    }
    return freeModelsFor(listed, trainOk).filter((m) => this.freeOpen(freeProviderOf(m)!.id));
  }

  /**
   * The relays' models to try (GhostCLI): what each relay connection with a key lists now, best first.
   *
   * @param c - The coder (its connections).
   */
  private async relayModels(c: NonNullable<TaskInboxDeps["coder"]>, pinned = false): Promise<string[]> {
    const out: string[] = [];
    // Only while the last small message answered (a relay that hangs would burn each task it gets); a task the user
    // gave to GhostCLI tries anyway.
    if (!pinned && !this.saved.relayHealth?.ok) return out;
    for (const r of RELAY_PROVIDERS) {
      const conn = c.free?.[r.id];
      if (!conn?.ready()) continue;
      const listed = await this.connModels(r.id, conn);
      const fine = pinned ? undefined : this.saved.relayHealth?.answered;
      out.push(...r.pick(listed).filter((m) => !fine || fine.includes(m)));
    }
    return out;
  }

  /** Takes a service's own count of today's requests (OpenRouter: `free_model_daily_requests`) when it answers; else the local count stays. */
  /** Model lists per connection, kept {@link CONN_CACHE_MS}: the page polls state(), which must not hit the network each time. */
  private modelsCache = new Map<string, { at: number; list: string[] }>();
  private usageAt = new Map<string, number>();

  private async connModels(id: string, conn: { models: () => Promise<string[]> }): Promise<string[]> {
    const hit = this.modelsCache.get(id);
    if (hit && this.now() - hit.at < CONN_CACHE_MS) return hit.list;
    const list = await Promise.race([conn.models().catch(() => [] as string[]), new Promise<string[]>((r) => setTimeout(() => r([]), 5000).unref?.())]);
    this.modelsCache.set(id, { at: this.now(), list });
    return list;
  }

  private async syncFreeUsage(id: string, conn: { usage?: () => Promise<FreeUsage | undefined> }): Promise<void> {
    if (this.now() - (this.usageAt.get(id) ?? -Infinity) < CONN_CACHE_MS) return;
    this.usageAt.set(id, this.now());
    const u: FreeUsage | undefined = await conn.usage?.().catch(() => undefined);
    if (!u) return;
    const d = this.freeDay(id);
    d.used = u.used;
    d.limit = u.limit;
  }

  /** Stops a free service until `until` (ms): the given models of it cool down, and the card shows it. */
  private stopFreeService(id: string, until: number, models: readonly string[]): void {
    this.freeDay(id).until = until;
    for (const m of models) if (freeProviderOf(m)?.id === id) this.blockOpencodeModel(m, until - this.now());
  }

  /**
   * Whether Antigravity cannot take a task now: every model family's quota is spent, its plan's quota ran out, or
   * today's cap is reached.
   */
  private antigravityOut(): boolean {
    const now = this.now();
    const families = (["opus", "sonnet", "flash"] as ModelFamily[]).every((f) => (this.saved.familyUntil?.[f] ?? 0) > now);
    return families || (this.saved.quota?.until ?? 0) > now || this.today().used >= this.s.dailyCap;
  }

  /**
   * Why OpenCode Go cannot take a task now, or undefined when it can: turned off, no connection with a key, today's cap
   * reached, or its plan's limit (a 429) not over yet.
   */
  private opencodeBlocked(): string | undefined {
    if (!this.oc.enabled) return "OpenCode Go is off (Settings > Task inbox).";
    if (!this.d.coder?.ready()) return "Waiting for the OpenCode Go connection: add it with your key (Settings > Connections).";
    const day = this.ocToday();
    const out = this.opencodeFamilyUntil();
    if (out) return `OpenCode Go limit reached until ${new Date(out).toISOString()}.`;
    const freeOpen = this.opencodeFreeOpen();
    if (day.used >= this.oc.dailyCap && !freeOpen) return `Today's limit of ${this.oc.dailyCap} OpenCode Go tasks is reached (Settings > Task inbox).`;
    return undefined;
  }

  /** The models still cooling down after a 429 (model id → end, ms); expired ones are dropped. */
  private opencodeCooldowns(): Record<string, number> {
    const day = this.ocToday();
    const now = this.now();
    const live = Object.fromEntries(Object.entries(day.modelUntil ?? {}).filter(([, u]) => u > now));
    if (Object.keys(live).length) day.modelUntil = live;
    else delete day.modelUntil;
    return live;
  }

  /**
   * Blocks one OpenCode Go model after its 429: until the reset the answer named, else 5 hours. The others stay open.
   *
   * @param model - The model id that answered 429.
   * @param wait - The wait the answer's headers or text gave (ms), when it did.
   */
  private blockOpencodeModel(model: string, wait?: number): void {
    const day = this.ocToday();
    day.modelUntil = { ...day.modelUntil, [model]: this.now() + (wait && wait > 0 ? wait : OPENCODE_LIMIT_MS) };
  }

  /** When OpenCode Go as a whole is free again (the earliest model's end), or undefined while any model is free. */
  private opencodeFamilyUntil(): number | undefined {
    const cool = this.opencodeCooldowns();
    const order = opencodeModelOrder(this.oc);
    if (opencodeFreeModel(order, cool, this.now())) return undefined;
    return Math.min(...order.map((m) => cool[m] ?? 0));
  }

  /**
   * The executor for a new task: the routing table, then the gap filler: an S/M code task that would wait for
   * Antigravity goes to OpenCode Go while Antigravity is out (quota or cap) and OpenCode Go can take it. L tasks stay.
   *
   * @param spec - The task.
   */
  private routeFor(spec: InboxTaskSpec): Exclude<InboxTaskSpec["executor"], "auto"> {
    const runBy = routeTask(spec);
    // Big work stays with Antigravity and its one Run tap (Roee, 21.11), and so does a task OpenCode Go can't take
    // (no connection, or turned off).
    if (spec.executor === "auto" && runBy === "opencode" && (taskSize(spec) === "L" || !this.d.coder?.ready() || this.oc.enabled === false)) return "antigravity";
    return runBy;
  }

  /** Reads the queue file once; a run cut off by a restart is marked failed (its worktree stays for a look). */
  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.d.file, "utf8")) as Saved;
      this.saved = { tasks: Array.isArray(raw.tasks) ? raw.tasks : [], today: raw.today ?? { date: "", used: 0 }, ...(raw.quota ? { quota: raw.quota } : {}), ...(raw.geminiUntil ? { geminiUntil: raw.geminiUntil } : {}), ...(raw.opencode ? { opencode: raw.opencode } : {}), ...(raw.claude ? { claude: raw.claude } : {}), ...(raw.free ? { free: raw.free } : {}), ...(raw.lastFetch ? { lastFetch: raw.lastFetch } : {}), ...(Array.isArray(raw.relayLog) ? { relayLog: raw.relayLog } : {}), ...(raw.relayHealth ? { relayHealth: raw.relayHealth } : {}) };
    } catch {
      this.saved = { tasks: [], today: { date: "", used: 0 } };
    }
    for (const t of this.saved.tasks) {
      if (t.status === "running" || t.status === "needs-approval") {
        // Cut off by a restart, not by the agent: back in line where it was (creation order), ready for Run again.
        t.status = t.runBy === "local" ? "queued" : "waiting";
        t.note = t.runBy === "opencode" || (t.runBy === "claude" && !this.cs.askRun) ? "KesherAI restarted during the run; it starts again by itself." : "KesherAI restarted during the run; it is back in line — press Run again.";
        delete t.pending;
      } else if (t.note?.startsWith("Queued") && RUNNABLE.has(t.status)) {
        // The line was in memory only: it is gone, the task waits for Run again.
        t.note = "The queue was cleared when KesherAI restarted; press Run again.";
      }
      // An open ask does not survive a restart either (its answer would start a task nobody is waiting on).
      if (t.runAsk?.next) delete t.runAsk;
    }
  }

  private readonly listeners = new Set<() => void>();

  /**
   * Calls back after every change of the queue (the hub's live agent activity watches it).
   *
   * @param cb - The callback (must not throw).
   * @returns A function that stops it.
   */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** An executor's queued task ids in priority order: oldest created first (Roee, 2026-11-22), not the order of the taps. */
  private ordered(ex: QueueExecutor): string[] {
    const inLine = new Set(this.lines.ids(ex));
    return this.saved.tasks.filter((t) => inLine.has(t.id)).map((t) => t.id);
  }

  /** The next queued task of an executor (the oldest created), taken out of its line. */
  private takeHead(ex: QueueExecutor): string | undefined {
    const id = this.ordered(ex)[0] ?? this.lines.first(ex);
    if (id) this.lines.remove(id);
    return id;
  }

  /** A copy of a task with its place in the user's line (never stored). */
  private withPlace<T extends InboxTaskView>(t: T): T {
    const ex: QueueExecutor | undefined = t.runBy === "antigravity" || t.runBy === "local" ? t.runBy : undefined;
    const queued = ex && this.lines.has(t.id) ? this.ordered(ex).indexOf(t.id) + 1 : 0;
    return queued ? { ...t, queued } : { ...t };
  }

  /** The tasks as they are now, oldest first, without their diffs. */
  async list(): Promise<InboxTaskView[]> {
    await this.load();
    return this.saved.tasks.map(({ diff: _d, ...t }) => this.withPlace(t));
  }

  /** Writes the queue file (one write at a time, write then rename). */
  private save(): Promise<void> {
    for (const cb of this.listeners) cb();
    const body = JSON.stringify(this.saved, null, 1);
    this.saving = this.saving.then(async () => {
      await mkdir(dirname(this.d.file), { recursive: true });
      const tmp = `${this.d.file}.${process.pid}.tmp`;
      await writeFile(tmp, body);
      await rename(tmp, this.d.file);
    }).catch(() => undefined);
    return this.saving;
  }

  /** Today's Antigravity count, reset at midnight. */
  private today(): { date: string; used: number } {
    const date = new Date(this.now()).toISOString().slice(0, 10);
    if (this.saved.today.date !== date) this.saved.today = { date, used: 0 };
    return this.saved.today;
  }

  private find(id: string): InboxTaskView {
    const t = this.saved.tasks.find((x) => x.id === id);
    if (!t) throw fail("No such task.", 404);
    return t;
  }

  /** A git wrapper that rejects on failure (for session-worktrees.ts). */
  private gitStrict: Git = async (cwd, args) => {
    const r = await this.d.git(cwd, args);
    if (r.code !== 0) throw new Error(r.out.slice(0, 400));
    return r.out;
  };

  /**
   * The queue and its state for the page.
   *
   * @param here - The request comes from this computer itself (Run works only then).
   */
  async state(here: boolean): Promise<InboxState> {
    await this.load();
    const busy = await this.d.busy().catch(() => ({ free: true, reasons: [] }) as InboxBusy);
    const quota = this.saved.quota && this.saved.quota.until > this.now() ? this.saved.quota : undefined;
    this.expireAsks();
    return {
      settings: this.s,
      today: { ...this.today() },
      // Newest first; the diff is only on the task page.
      tasks: [...this.saved.tasks].reverse().map(({ diff: _d, ...t }) => this.withPlace(t)),
      busy,
      ...(this.saved.lastFetch ? { lastFetch: this.saved.lastFetch } : {}),
      ...(this.saved.lastError ? { lastError: this.saved.lastError } : {}),
      ...(quota ? { quota } : {}),
      runHere: here,
      ...(this.s.repo ? { project: basename(this.s.repo) } : {}),
      models: pickableModels(this.saved.models),
      opencode: await this.opencodeState(),
      ...(this.saved.agQuota ? { agQuota: this.saved.agQuota } : {}),
      ...(this.saved.agQuotaWhy ? { agQuotaWhy: this.saved.agQuotaWhy } : {}),
      ...(this.saved.relayLog?.length ? { relay: { ...relayReport(this.saved.relayLog), ...(this.saved.relayHealth ? { health: this.saved.relayHealth } : {}) } } : {}),
      ...(this.d.claude ? { claude: await this.claudeState() } : {}),
      ...(await this.freeStates()),
      loop: this.loopNow(),
    };
  }

  /** The models the OpenCode Go connection listed when last asked (for "is a free model open" without waiting). */
  private ocListed: string[] = [];

  /** The models the OpenCode Go connection lists now (asked for at most 5 s; empty when it could not be asked). */
  private async opencodeListed(c: NonNullable<TaskInboxDeps["coder"]>): Promise<string[]> {
    this.ocListed = await this.connModels(OPENCODE_PROVIDER, c);
    return this.ocListed;
  }

  /** OpenCode Go's state for the settings card (its models are asked from the connection, never more than 5 s). */
  private async opencodeState(): Promise<OpencodeState> {
    const c = this.d.coder;
    const day = this.ocToday();
    const ready = !!c?.ready();
    const models = ready ? await this.opencodeListed(c!) : [];
    const until = this.opencodeFamilyUntil();
    const cooldowns = this.opencodeCooldowns();
    return { ready, used: day.used, ...(until ? { until } : {}), ...(Object.keys(cooldowns).length ? { cooldowns } : {}), models: models.slice(0, 100) };
  }

  /** The connected free services for the settings card (`free`, left out when none is connected). */
  private async freeStates(): Promise<{ free?: FreeProviderState[] }> {
    const out: FreeProviderState[] = [];
    for (const f of FREE_PROVIDERS) {
      const conn = this.d.coder?.free?.[f.id];
      if (!conn?.ready()) continue;
      await this.syncFreeUsage(f.id, conn);
      const d = this.freeDay(f.id);
      const limit = d.limit ?? f.dailyLimit;
      out.push({ id: f.id, name: f.name, used: d.used, ...(limit !== undefined ? { limit } : {}), ...(d.until ? { until: d.until } : {}), trainsOnData: f.trainsOnData });
    }
    return out.length ? { free: out } : {};
  }

  /** Resolves when no run is going on (its result written). */
  async idle(): Promise<void> {
    await this.active?.done;
    await this.geminiRun;
    await this.opencodeRun;
    await this.claudeRun;
  }

  /**
   * The task running now, for the "Continue what was running" record written on shutdown (after the start it is
   * marked failed, and runs again only on the user's Run).
   *
   * @returns Its id and title, or undefined when none runs.
   */
  runningTask(): { id: string; title: string } | undefined {
    const t = this.active && this.saved.tasks.find((x) => x.id === this.active!.id);
    return t ? { id: t.id, title: t.title } : undefined;
  }

  /** One task with its diff. */
  async task(id: string): Promise<InboxTaskView> {
    await this.load();
    return this.find(id);
  }

  /** Starts fetching every few minutes while the inbox is on (Settings); call again after a settings change. */
  start(): void {
    void this.load();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.loopTimer) clearInterval(this.loopTimer);
    this.loopTimer = undefined;
    const s = this.s;
    if (!s.enabled || s.paused || !s.repo) return;
    this.timer = setInterval(() => void this.sync().catch(() => undefined), Math.max(1, s.fetchMinutes) * 60_000);
    this.timer.unref?.();
    // The work loop looks every 5 minutes even when fetching is slower (Settings › Task inbox › Look for new tasks).
    if (s.loop !== false) {
      this.loopTimer = setInterval(() => void this.loopTick().catch(() => undefined), LOOP_TICK_MS);
      this.loopTimer.unref?.();
    }
    void this.sync().catch(() => undefined);
    // Once after each start (an update restarts the app): clear finished worktrees, after the queue has loaded.
    if (!this.sweptAtStart) {
      this.sweptAtStart = true;
      setTimeout(() => void this.sweepWorktreesOnce().catch(() => undefined), 60_000).unref?.();
    }
  }

  private sweptAtStart = false;

  /** Stops fetching (Off is the kill switch: it also stops a run). */
  async stopAll(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.loopTimer) clearInterval(this.loopTimer);
    this.loopTimer = undefined;
    this.geminiStop?.abort();
    if (this.claudeStop) {
      this.claudeStop.why = "stop";
      this.claudeStop.ctl.abort();
    }
    if (this.opencodeStop) {
      this.opencodeStop.why = "stop";
      this.opencodeStop.ctl.abort();
    }
    if (this.active) await this.stop(this.active.id).catch(() => undefined);
  }

  /** The inbox branch, checked. */
  private branch(): string {
    const b = this.s.branch || "kesher-inbox";
    if (!validBranchName(b) || b.includes("/") || ["main", "master", "release"].includes(b)) throw fail("The inbox branch name is not allowed.", 400);
    return b;
  }

  /** The project folder, checked. */
  private repo(): string {
    const r = this.s.repo;
    if (!r || !existsSync(join(r, ".git"))) throw fail("Pick the git project for the inbox in Settings > Task inbox.", 400);
    return r;
  }

  /**
   * Fetches the inbox branch, adds new tasks to the queue (and the board), follows self-work's board items, and
   * writes results that were not written yet. Only reads `tasks/*.md` through git (nothing is checked out from it).
   */
  sync(): Promise<void> {
    void this.probeRelays().catch(() => undefined);
    void this.readAgQuota().catch(() => undefined);
    this.syncing ??= this.doSync().finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }

  /**
   * Claude's work list (`docs/WORK_LIST.md` on `main` of the inbox's project), for "Tasks on all your devices"
   * (work-list-sync.ts). Fetches only `main` into its remote-tracking ref and reads the file through git (nothing is
   * checked out).
   *
   * @returns The file's text, or undefined when there is no project, the fetch failed or the file is missing or over 512 KB.
   */
  async workList(): Promise<string | undefined> {
    await this.load();
    let repo: string;
    try {
      repo = this.repo();
    } catch {
      return undefined;
    }
    const ref = "refs/remotes/origin/main";
    const fetched = await this.d.git(repo, ["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/main:${ref}`], 60_000);
    // Offline: the last fetched copy still counts (it is what the PC knew).
    if (fetched.code !== 0 && (await this.d.git(repo, ["rev-parse", "--verify", "--quiet", ref])).code !== 0) return undefined;
    const size = await this.d.git(repo, ["cat-file", "-s", `${ref}:docs/WORK_LIST.md`]);
    if (size.code !== 0 || Number(size.out.trim()) > 512 * 1024) return undefined;
    const body = await this.d.git(repo, ["show", `${ref}:docs/WORK_LIST.md`]);
    return body.code === 0 ? body.out : undefined;
  }

  private async doSync(): Promise<void> {
    await this.load();
    const s = this.s;
    if (!s.enabled) return;
    const repo = this.repo();
    const br = this.branch();
    const fetched = await this.d.git(repo, ["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${br}:refs/remotes/origin/${br}`], 60_000);
    this.saved.lastFetch = this.now();
    if (fetched.code !== 0) {
      // No inbox branch yet is not an error: nothing was sent.
      // Git itself missing comes first: its message would otherwise read as "no inbox branch yet".
      this.saved.lastError = fetched.out === INBOX_GIT_MISSING ? INBOX_GIT_MISSING : /couldn't find remote ref|not found/i.test(fetched.out) ? undefined : `git fetch: ${fetched.out.slice(0, 200)}`;
      if (!this.saved.lastError) delete this.saved.lastError;
    } else {
      delete this.saved.lastError;
      const ls = await this.d.git(repo, ["ls-tree", "--name-only", `refs/remotes/origin/${br}`, "tasks/"]);
      const names = ls.code === 0 ? ls.out.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^tasks\/[a-z0-9-]+\.md$/.test(l)).slice(0, 200) : [];
      for (const name of names) {
        const id = name.slice(6, -3);
        if (!validTaskId(id) || this.saved.tasks.some((t) => t.id === id)) continue;
        const size = await this.d.git(repo, ["cat-file", "-s", `refs/remotes/origin/${br}:${name}`]);
        if (size.code !== 0 || Number(size.out.trim()) > 32 * 1024) {
          this.declined(id, "The task file is bigger than 32 KB.");
          continue;
        }
        const body = await this.d.git(repo, ["show", `refs/remotes/origin/${br}:${name}`]);
        if (body.code !== 0) continue;
        const parsed = parseTaskFile(body.out, id, s);
        if ("error" in parsed) this.declined(id, parsed.error);
        else await this.enqueue(parsed.spec);
      }
    }
    await this.closeReplaced();
    await this.followBoard();
    await this.syncStanding().catch(() => undefined);
    await this.publishDoneResearch().catch(() => undefined);
    await this.loopWork().catch(() => undefined);
    for (const t of this.saved.tasks) if (isEnded(t.status) && !t.resultWritten && t.from !== "hub") await this.writeResult(t).catch(() => undefined);
    await this.save();
    void this.pumpGemini().catch(() => undefined);
    void this.pumpOpencode().catch(() => undefined);
    void this.pumpClaude().catch(() => undefined);
    void this.pump().catch(() => undefined);
  }

  /**
   * Skips the tasks a newer task `replaces` (its frontmatter list), with a note naming the new one. Only a task that has
   * not started (waiting, queued, deferred) is closed; a running or ended one is left alone. Safe to repeat.
   */
  private async closeReplaced(): Promise<void> {
    for (const n of this.saved.tasks) {
      for (const oldId of n.replaces ?? []) {
        const old = this.saved.tasks.find((x) => x.id === oldId);
        if (!old || old.id === n.id || !(old.status === "waiting" || old.status === "queued" || old.status === "deferred-quota")) continue;
        await this.skip(old.id, `Replaced by ${n.id}.`).catch(() => undefined);
      }
    }
  }

  /** A task file that could not be read: shown as declined, with why. */
  private declined(id: string, note: string): void {
    this.saved.tasks.push({ id, title: id, executor: "auto", risk: "high", from: "claude", base: "", allowedPaths: [], forbiddenPaths: [], check: "", maxMinutes: 0, maxFiles: 0, goal: "", status: "declined", runBy: "opus", branch: "", note, resultWritten: false });
  }

  /** Adds a checked task to the queue and the board. */
  private async enqueue(spec: InboxTaskSpec, boardId?: string): Promise<InboxTaskView> {
    const runBy = this.routeFor(spec);
    const t: InboxTaskView = {
      ...spec,
      runBy,
      branch: branchFor(spec, runBy),
      status: runBy === "antigravity" || runBy === "gemini" || runBy === "opencode" || runBy === "claude" ? "waiting" : "queued",
      ...(runBy === "claude" ? { note: this.claudeNote() } : runBy === "opus" ? { note: "Claude runs it with its own Opus agent." } : runBy === "local" ? { note: "Self-work takes it from the task board." } : runBy === "gemini" ? { note: "Runs by itself with the free Gemini key." } : runBy === "opencode" ? { note: opencodeNote(spec, this.oc, spec.executor === "auto") } : {}),
    };
    if (boardId) t.boardId = boardId;
    else if (this.d.board) {
      const b = await this.d.board.change("claude", [{ op: "add", title: `[Inbox ${spec.id}] ${spec.title}`, details: [`From the task inbox (tasks/${spec.id}.md on ${this.s.branch}).`, `Executor: ${runBy}${runBy === "antigravity" ? " (waits for Run on the PC)" : runBy === "gemini" ? " (automatic, free Gemini)" : runBy === "opencode" ? ` (automatic, OpenCode Go · ${opencodeModelName(opencodeModelFor({ ...spec, size: taskSize(spec) }, this.oc))})` : runBy === "claude" ? ` (Claude Code on the PC${this.cs.askRun ? ", waits for Run" : ", automatic"})` : ""}.`, ...(runBy === "gemini" ? [] : [`Branch: ${t.branch}`])].join("\n"), size: boardSizeFor(spec, runBy) }]).catch(() => undefined);
      const added = b?.tasks.at(-1);
      if (added) {
        t.boardId = added.id;
        if (runBy === "local") await this.d.board.change("roee", [{ op: "edit", id: added.id, forKesher: true }]).catch(() => undefined);
        // "local ok": the cooldown hand-off may give it to the local model while Claude is cooling down.
        else if (spec.localOk && runBy === "opus") await this.d.board.change("roee", [{ op: "edit", id: added.id, localOk: true }]).catch(() => undefined);
      }
    }
    this.saved.tasks.push(t);
    if (this.saved.tasks.length > 300) this.saved.tasks = this.saved.tasks.slice(-300);
    // An Antigravity task: the PC asks right away (on the PC and the phone); it starts only on the user's tap.
    // (A task the work loop makes is offered later, one ask at a time: see offerWaiting.)
    if (!this.feeding && ((runBy !== "antigravity" && !(runBy === "claude" && this.cs.askRun)) || !this.makeAsk(t))) this.d.notify("📥 A new task in the inbox", `${spec.id}: ${spec.title}`);
    if (runBy === "claude" && !this.cs.askRun) void this.pumpClaude().catch(() => undefined);
    return t;
  }

  /** Local-model tasks end when self-work marks their board item done or blocked. */
  private async followBoard(): Promise<void> {
    if (!this.d.board) return;
    const board = await this.d.board.read().catch(() => undefined);
    if (!board) return;
    for (const t of this.saved.tasks) {
      if (t.runBy !== "local" || t.status !== "queued" || !t.boardId) continue;
      const item = board.tasks.find((x) => x.id === t.boardId);
      if (item && (item.status === "open" || item.status === "claimed")) {
        // Shown on the hub: open = waits for the local agent, claimed = it is working on it.
        if (t.boardState !== item.status) t.boardState = item.status;
        continue;
      }
      if (!item || (item.status !== "done" && item.status !== "blocked")) continue;
      t.status = item.status === "done" ? "done" : "failed";
      t.summary = (item.result ?? "").slice(0, 2000);
      t.endedAt = this.now();
      t.resultWritten = false;
      // A local task ended: the next one of its line is asked about or started (queue pump).
      if (this.lines.size("local")) this.pendingDone.local = t.title;
    }
  }

  /**
   * A task from the Kesher Cloud hub that targets Antigravity: prepared in the queue (linked to its board item, whose
   * result goes back to the hub), and it waits for Run on the PC like every Antigravity task. The phone may see it,
   * never start it.
   *
   * @param t - The hub's task (its spec is data).
   * @param boardId - The board item hub-client.ts made for it.
   */
  async fromHub(t: { taskId: string; title: string; spec: string }, boardId: string | undefined): Promise<void> {
    await this.load();
    const id = `h-${slugOf(t.taskId).slice(0, 40)}`;
    if (!validTaskId(id) || this.saved.tasks.some((x) => x.id === id)) return;
    const s = this.s;
    await this.enqueue({ id, title: t.title.slice(0, 200), executor: "antigravity", risk: "medium", from: "hub", base: "origin/main", allowedPaths: [...s.allowedPaths], forbiddenPaths: [...s.forbiddenPaths], check: "", maxMinutes: s.maxMinutes, maxFiles: 15, goal: t.spec.slice(0, 6000) }, boardId);
    await this.save();
  }

  /**
   * A task another of the user's devices wrote to Google Drive (tasks-sync.ts): checked like a task file and queued
   * once (an id already in the queue is left alone), marked as from `device`. Nothing the PC runs by itself may take
   * it (security scan 167: anyone holding the Drive app-folder token could write one): it goes to Antigravity, which
   * waits for the user's Run on the PC or the phone, or, when Claude was asked, stays for Claude (the PC never runs
   * those). Self-work (the local model) never takes it by itself.
   *
   * @param t - The queue id (made by tasks sync), title, goal and the executor the device asked for (data only).
   * @returns Whether it was added.
   */
  async fromDrive(t: { id: string; title: string; goal: string; executor: string }): Promise<boolean> {
    await this.load();
    if (!validTaskId(t.id) || this.saved.tasks.some((x) => x.id === t.id)) return false;
    const s = this.s;
    const executor: InboxTaskSpec["executor"] = t.executor === "claude" || t.executor === "opus" ? "opus" : "antigravity";
    const spec: InboxTaskSpec = { id: t.id, title: t.title.trim().slice(0, 200) || "Task", executor, risk: "medium", from: "device", base: "origin/main", allowedPaths: [...s.allowedPaths], forbiddenPaths: [...s.forbiddenPaths], check: "", maxMinutes: s.maxMinutes, maxFiles: 15, goal: t.goal.trim().slice(0, 6000) || t.title.trim().slice(0, 200) };
    const parsed = parseTaskFile(taskFileText(spec), spec.id, s);
    if ("error" in parsed) return false;
    await this.enqueue(parsed.spec);
    await this.save();
    return true;
  }

  /**
   * A task the user writes in the app ("+ Task", also from the phone): added to the queue and written to the inbox
   * branch so Claude sees it too.
   *
   * @param input - Title, goal and the rest; paths and limits default to Settings. `extraPaths`: more folders the task
   *   may change, only `integrations/<engine>/<folder>/**` (an engine plugin's AI-converted copy, engine-support.ts). `maxFiles`: 1–60 (default 15).
   */
  async add(input: { title: string; goal: string; executor?: string; risk?: string; check?: string; acceptance?: string; extraPaths?: string[]; maxFiles?: number; size?: string; kind?: string }): Promise<InboxTaskView> {
    await this.load();
    const s = this.s;
    const title = String(input.title ?? "").trim().slice(0, 200);
    const goal = String(input.goal ?? "").trim().slice(0, 6000);
    if (!title || !goal) throw fail("A task needs a title and a goal.", 400);
    const day = new Date(this.now()).toISOString().slice(0, 10).replace(/-/g, "");
    let n = 1;
    while (this.saved.tasks.some((t) => t.id === `r-${day}-${String(n).padStart(2, "0")}`)) n++;
    // A research task ("research only", no code) is marked so: free Gemini and Antigravity take it (25.11: four research
    // tasks went to the Claude queue as code tasks).
    const research = input.kind === "research" || (input.kind === undefined && /^research\b|^מחקר/i.test(input.title.trim()) && /research only|no code|רק מחקר/i.test(input.goal));
    const executor = ["auto", "antigravity", "local", "opus", "opencode", "claude", "gemini"].includes(String(input.executor)) ? (input.executor as InboxTaskSpec["executor"]) : "auto";
    const size = ["S", "M", "L"].includes(String(input.size)) ? (input.size as InboxTaskSpec["size"]) : undefined;
    const risk = ["low", "medium", "high"].includes(String(input.risk)) ? (input.risk as InboxTaskSpec["risk"]) : "medium";
    const spec: InboxTaskSpec = { id: `r-${day}-${String(n).padStart(2, "0")}`, title, executor, risk, from: "roee", base: "origin/main", allowedPaths: [...s.allowedPaths, ...(input.extraPaths ?? []).filter((x) => /^integrations\/[a-z]+\/[\w.-]+\/\*\*$/.test(x) && !x.includes("..")).slice(0, 2)], forbiddenPaths: [...s.forbiddenPaths], check: String(input.check ?? "").trim().slice(0, 300), maxMinutes: s.maxMinutes, maxFiles: Math.min(60, Math.max(1, Math.round(Number(input.maxFiles) || 15))), goal, ...(size ? { size } : {}), ...(research ? { kind: "research" as const } : {}), ...(input.acceptance?.trim() ? { acceptance: input.acceptance.trim().slice(0, 3000) } : {}) };
    // The same checks as a file from git (the text is data either way).
    const parsed = parseTaskFile(taskFileText(spec), spec.id, s);
    if ("error" in parsed) throw fail(parsed.error, 400);
    const t = await this.enqueue(parsed.spec);
    await this.save();
    void this.pumpGemini().catch(() => undefined);
    void this.pumpOpencode().catch(() => undefined);
    if (s.enabled && s.repo) await this.commitToInbox([[`tasks/${spec.id}.md`, taskFileText(parsed.spec)]], `inbox: task ${spec.id}`).catch((e) => {
      this.saved.lastError = `Could not write the task to ${s.branch}: ${(e as Error).message.slice(0, 160)}`;
    });
    return t;
  }

  /**
   * Writes files to the inbox branch in its own worktree (`.kesher/worktrees/inbox`), commits them as KesherAI and
   * pushes that one branch. One writer per file (Claude writes tasks/, KesherAI results/), so a rebase never conflicts.
   */
  private async commitToInbox(files: Array<[string, string]>, message: string): Promise<void> {
    const repo = this.repo();
    const br = this.branch();
    const wt = worktreeFolder(repo, "inbox");
    const remote = (await this.d.git(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${br}`])).code === 0;
    if (!existsSync(wt)) {
      await excludeWorktrees(repo, this.gitStrict);
      await mkdir(dirname(wt), { recursive: true });
      await this.d.git(repo, ["worktree", "prune"]);
      const local = (await this.d.git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${br}`])).code === 0;
      const made = local ? await this.d.git(repo, ["worktree", "add", wt, br]) : remote ? await this.d.git(repo, ["worktree", "add", "-b", br, wt, `refs/remotes/origin/${br}`]) : await this.d.git(repo, ["worktree", "add", "--orphan", "-b", br, wt]);
      if (made.code !== 0) throw new Error(made.out.slice(0, 300));
    }
    if (remote) await this.d.git(wt, ["-c", "rebase.autoStash=true", ...AUTHOR, "pull", "--quiet", "--rebase", "origin", br], 60_000);
    for (const [path, text] of files) {
      if (!/^(tasks|results)\/[a-z0-9-]+\.md$/.test(path)) throw new Error("Bad inbox path.");
      const reasons = scanDiff(text.split("\n").map((l) => `+${l}`).join("\n"), this.d.me);
      if (reasons.length) throw new Error(`The file would show ${reasons.map((r) => r.kind).join(", ")}; not written.`);
      await mkdir(dirname(join(wt, path)), { recursive: true });
      await writeFile(join(wt, path), text);
      await this.d.git(wt, ["add", "--", path]);
    }
    const c = await this.d.git(wt, [...AUTHOR, "commit", "--quiet", "--no-verify", "-m", message]);
    if (c.code !== 0 && !/nothing to commit|no changes added/i.test(c.out)) throw new Error(c.out.slice(0, 300));
    await pushRef(this.d.git, wt, br, br);
  }

  /**
   * Runs the free-Gemini research tasks (route B) by themselves, one at a time: no Run press is needed, because the
   * free Gemini key is the user's own API key and not an agent's account. A task waits with a note when no "gemini"
   * provider is configured. When the key's limit is reached the run stops and the task is deferred to the reset; it
   * gets at most one automatic retry after that, never a loop.
   *
   * @returns Resolves when no task is left to run now.
   */
  pumpGemini(): Promise<void> {
    this.geminiRun ??= this.doGemini().finally(() => {
      this.geminiRun = undefined;
    });
    return this.geminiRun;
  }

  private async doGemini(): Promise<void> {
    await this.load();
    const s = this.s;
    if (!s.enabled || s.paused) return;
    for (;;) {
      const now = this.now();
      const due = (x: InboxTaskView) => x.runBy === "gemini" && (x.status === "waiting" || (x.status === "deferred-quota" && !x.autoRetried && x.retryAt !== undefined && x.retryAt <= now));
      const t = this.saved.tasks.find(due);
      if (!t || (this.saved.geminiUntil ?? 0) > now) return;
      const r = this.d.research;
      if (!r?.ready()) {
        const note = "Waiting for a Gemini connection: add Google Gemini with a free AI Studio key (Settings > Connections).";
        if (t.note !== note) {
          t.note = note;
          await this.save();
        }
        return;
      }
      await this.runGemini(t, r);
    }
  }

  /** One free-Gemini research run, to its end (done, failed or deferred by the quota). */
  private async runGemini(t: InboxTaskView, r: NonNullable<TaskInboxDeps["research"]>): Promise<void> {
    if (t.status === "deferred-quota") t.autoRetried = true;
    Object.assign(t, { status: "running" as InboxStatus, startedAt: this.now(), resultWritten: false });
    for (const k of ["endedAt", "note", "summary", "retryAt", "researchReport"] as const) delete t[k];
    await this.save();
    this.d.notify("✦ Research started (free Gemini)", `${t.id}: ${t.title}`);
    const stop = (this.geminiStop = new AbortController());
    // A research run has no steps or files to watch: only the safety ceiling stops it.
    const timer = setTimeout(() => stop.abort(), limitsFor(t.maxMinutes, this.s).ceilingMs);
    let status: InboxStatus = "done";
    try {
      const question = [t.title, t.goal, t.acceptance ? `Acceptance:\n${t.acceptance}` : "", t.outOfScope ? `Out of scope:\n${t.outOfScope}` : ""].filter(Boolean).join("\n\n");
      // The time limit holds even if a search or a page read ignores the signal (a run once hung for two hours).
      const report = (await Promise.race([
        r.run(question, stop.signal),
        new Promise<never>((_, rej) => stop.signal.addEventListener("abort", () => rej(new Error("Stopped at the safety limit.")), { once: true })),
      ])).trim();
      if (!report) throw new Error("The model wrote no report.");
      t.researchReport = report;
      t.summary = report.slice(0, 2000);
    } catch (e) {
      const msg = (e as Error).message || String(e);
      if (isQuotaError(msg)) {
        // A limit, quota or billing offer: stop here and wait for the reset. Never retried in a loop, never paid.
        const q = quotaUntil(msg, this.now());
        this.saved.geminiUntil = q.until;
        status = "deferred-quota";
        if (!t.autoRetried) t.retryAt = q.until;
        t.note = `The free Gemini limit was reached; ${t.autoRetried ? "run it again later." : `it tries once more after ${new Date(q.until).toISOString()}.`}`;
      } else if (!stop.signal.aborted && /\b(500|502|503|504)\b|UNAVAILABLE|overloaded|try again later/i.test(msg)) {
        // Google busy (the free tier answers 503 "overloaded" at peak hours): not a failure, wait and try once more.
        status = "deferred-quota";
        if (!t.autoRetried) t.retryAt = this.now() + 15 * 60_000;
        t.note = `Gemini is busy right now (${/\b(5\d\d)\b/.exec(msg)?.[1] ?? "busy"}); ${t.autoRetried ? "run it again later." : "it tries once more in 15 minutes."}`;
      } else {
        status = "failed";
        t.note = stop.signal.aborted ? `${this.stopText(t, "ceiling")} (or stopped by you.)` : `The research failed: ${msg.slice(0, 300)}`;
      }
    } finally {
      clearTimeout(timer);
      this.geminiStop = undefined;
    }
    t.status = status;
    t.endedAt = this.now();
    await this.save();
    if (t.boardId && this.d.board) {
      const line = `${status}${t.note ? ` — ${t.note}` : ""}`.slice(0, 1000);
      await this.d.board.change("kesher", [status === "done" ? { op: "done", id: t.boardId, result: `done: report in results/${t.id}.md` } : status === "deferred-quota" ? { op: "note", text: line, task: t.boardId } : { op: "block", id: t.boardId, result: line }]).catch(() => undefined);
    }
    if (t.from !== "hub") await this.writeResult(t).catch((e) => {
      this.saved.lastError = `Could not write the result: ${(e as Error).message.slice(0, 160)}`;
    });
    await this.save();
    this.d.notify(`${endIcon(status)} ${t.id} ${endWord(t, status)}`, endBody(t, status), { path: `#/task-inbox/${t.id}` });
    rememberFail(t, status, this.now());
    await this.save();
    await this.retryLater(t);
  }

  /**
   * Runs the OpenCode Go code tasks by themselves, one at a time: no Run press is needed, because OpenCode Go is the
   * user's own flat-plan API key in KesherAI's own code chat, not an outside agent's account. A task waits with a note
   * while OpenCode Go is off, has no key, is at today's cap or at its plan's limit (after a 429, until the reset).
   *
   * @returns Resolves when no task is left to run now.
   */
  pumpOpencode(): Promise<void> {
    this.opencodeRun ??= this.doOpencode().finally(() => {
      this.opencodeRun = undefined;
    });
    return this.opencodeRun;
  }

  private async doOpencode(): Promise<void> {
    await this.load();
    const s = this.s;
    if (!s.enabled || s.paused || !s.repo) return;
    for (;;) {
      // A task its plan's limit cut off goes again by itself once the limit is over (opencodeBlocked holds it until then).
      const t = this.saved.tasks.find((x) => x.runBy === "opencode" && (x.status === "waiting" || x.status === "deferred-quota"));
      if (!t) return;
      if (await this.drainNote(t)) return;
      // A task given to GhostCLI does not wait for OpenCode Go's own limits or the relay's health check: it tries now.
      const no = t.model === RELAY_PIN ? (this.oc.enabled ? undefined : "OpenCode Go is off (Settings > Task inbox).") : this.opencodeBlocked();
      if (no) {
        if (t.note !== no) {
          t.note = no;
          await this.save();
        }
        return;
      }
      await this.runOpencode(t, this.d.coder!);
    }
  }

  /**
   * While an update waits for a free moment, a task that would start now waits with a note instead.
   *
   * @param t - The task that was about to start.
   * @returns True when it must not start (the update waits).
   */
  private async drainNote(t: InboxTaskView): Promise<boolean> {
    if (!this.d.draining?.()) return false;
    if (t.note !== DRAIN_NOTE) {
      t.note = DRAIN_NOTE;
      await this.save();
    }
    return true;
  }

  /** One OpenCode Go code task: its own worktree and `ocgo/*` branch, the code chat, then the same checks, commit and push as Antigravity's. */
  private async runOpencode(t: InboxTaskView, c: NonNullable<TaskInboxDeps["coder"]>): Promise<void> {
    const listed = await this.opencodeListed(c);
    // The free services (Z.ai, OpenRouter, ...) take S tasks only (a coding agent burns many requests); right after Beam Free.
    // Services that may train on prompts get a task only when the setting allows it, the task is low-risk and not about
    // security (safeForTrainingProvider), and the privacy scan finds nothing in the prompt.
    const prompt = agentPrompt(t, t.branch);
    const safe = safeForTrainingProvider({ ...t, size: taskSize(t) });
    const trainOk = this.oc.freeTrainingOk !== false && safe.ok && scanDiff(prompt.split("\n").map((l) => `+${l}`).join("\n"), this.d.me).length === 0;
    // Free services take small tasks; larger ones too once the paid day is used up (better than waiting for midnight).
    const services = taskSize(t) === "S" || this.ocToday().used >= this.oc.dailyCap ? await this.freeServiceModels(c, listed, trainOk) : [];
    // A flat-rate relay (GhostCLI) for tasks without sensitive content: first for medium and large tasks (what it is paid
    // for), after the free services for small ones. Its prompt is scanned like a training service's.
    const relayOk = this.oc.useRelay !== false && safeForRelay(t).ok && scanDiff(prompt.split("\n").map((l) => `+${l}`).join("\n"), this.d.me).length === 0;
    const pinned = t.model === RELAY_PIN;
    // Given to GhostCLI, the relay setting does not matter (the user chose it), but the content checks still do.
    const pinnedOk = pinned && safeForRelay(t).ok && scanDiff(prompt.split("\n").map((l) => `+${l}`).join("\n"), this.d.me).length === 0;
    const relays = pinned ? (pinnedOk ? await this.relayModels(c, true) : []) : relayOk ? await this.relayModels(c) : [];
    if (pinned && !relays.length) {
      // Given to GhostCLI, but it cannot take it: its prompt holds sensitive content, or no GhostCLI key or model is there.
      t.note = pinnedOk ? "GhostCLI has no model to offer now (check its key in Settings > Connections)." : "Not sent to GhostCLI: the task's text looks sensitive (the privacy scan found something).";
      t.status = "failed";
      t.endedAt = this.now();
      rememberFail(t, "failed", this.now());
      await this.save();
      return;
    }
    // Free services first, Beam Free last of the free ones: on 23.11 it ended 3 of 3 real tasks without changing a file.
    const freeFirst = pinned ? relays : taskSize(t) === "S" ? [...services, ...relays, ...opencodeFreeFirst(this.oc, listed)] : [...relays, ...services, ...opencodeFreeFirst(this.oc, listed)];
    const paidLeft = !pinned && this.ocToday().used < this.oc.dailyCap;
    // The plan's free models go first (they do not count toward the daily cap); paid ones only while the cap allows.
    const order = [...freeFirst, ...(paidLeft ? opencodeModelOrder(this.oc) : [])];
    const wanted = pinned ? relays[0]! : opencodeModelFor({ ...t, size: taskSize(t) }, this.oc);
    // A free model first; else the task's own pick, unless it is cooling down after a 429: then the next free one.
    // A task given to GhostCLI tries its first model even while it cools down (the user asked for a try now).
    let model = opencodeFreeModel(freeFirst, this.opencodeCooldowns(), this.now()) ?? (pinned ? wanted : opencodeFreeModel(order, this.opencodeCooldowns(), this.now(), wanted) ?? wanted);
    if (!pinned && !paidLeft && !opencodeFreeModel(freeFirst, this.opencodeCooldowns(), this.now())) {
      // The daily cap is reached and no free model can take it: the task waits for tomorrow (nothing was started).
      const back = Math.min(...freeFirst.map((m) => this.opencodeCooldowns()[m] ?? Infinity));
      const when = Number.isFinite(back) ? ` A free model opens again at ${new Date(back).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.` : " It runs again after midnight.";
      Object.assign(t, { status: "deferred-quota" as InboxStatus, note: `Today's limit of ${this.oc.dailyCap} OpenCode Go tasks is reached, and no free model is open.${when}` });
      await this.save();
      return;
    }
    const repo = this.repo();
    await this.d.git(repo, ["fetch", "--quiet", "--no-tags", "origin"], 60_000);
    const taskBase = t.base.startsWith("origin/") ? `refs/remotes/${t.base}` : t.base;
    // A partial attempt's pushed branch is where this one continues from (its work is kept, not redone).
    const resume = await this.resumeRef(repo, t);
    const base = resume ?? taskBase;
    let attempt = t.startedAt ? Number(/-r(\d+)$/.exec(t.branch.replace(/-partial$/, ""))?.[1] ?? 1) + 1 : 1;
    const named = (n: number): string => `${branchFor(t, "opencode")}${n > 1 ? `-r${n}` : ""}`;
    // A run that failed before saving its branch name left that branch behind (2026-11-23: "a branch named
    // ocgo/…-r2 already exists" failed 12 tasks in a row): take the next free name; never delete the old branch.
    for (let i = 0; i < 20 && (await this.d.git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${named(attempt)}`])).code === 0; i++) attempt++;
    const branch = named(attempt);
    let wt: Awaited<ReturnType<typeof createSessionWorktree>>;
    try {
      if (!validBranchName(branch)) throw new Error("Bad branch name.");
      wt = await createSessionWorktree(repo, `ocgo-${t.id}-${attempt}`.slice(0, 60), this.gitStrict, { branch, base, copyIncluded: false });
    } catch (e) {
      Object.assign(t, { status: "failed" as InboxStatus, endedAt: this.now(), note: `Could not make the work folder: ${(e as Error).message.slice(0, 200)}` });
      await this.save();
      return;
    }
    // The diff and the path check are against the task's own base, also when the work continues from a partial branch.
    const baseSha = resume ? await this.commitOf(repo, taskBase) : undefined;
    Object.assign(t, { status: "running" as InboxStatus, branch, startedAt: this.now(), steps: 0, checks: [], files: [], pushed: false, resultWritten: false, modelUsed: modelLabel(model), ...(trainingRiskOf(model) ? { mayTrain: true } : {}) });
    for (const k of ["endedAt", "note", "summary", "headSha", "diff", "modelFallback", "mayTrain", "retryAt", "plan", "decisions", "watchLog", "review"] as const) delete t[k];
    if (resume) t.note = `Continuing from the partial branch ${resume.replace(/^refs\/(heads|remotes\/origin)\//, "")}.`;
    await this.save();
    this.d.notify("◈ OpenCode Go התחיל משימה", `${t.title} · ${opencodeModelName(model)}`, { path: `#/task-inbox/${t.id}` });
    if (existsSync(join(wt.path, "pnpm-lock.yaml"))) await this.d.run(wt.path, ["pnpm", "install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts"], 10 * 60_000).catch(() => undefined);
    const run: { id: string; ctl: AbortController; why?: "stop" | StopReason } = { id: t.id, ctl: new AbortController() };
    this.opencodeStop = run;
    // No wall-clock kill: the guard stops a run that makes no progress, repeats itself or spends its request budget; the
    // safety ceiling is the longest of the task's minutes, the setting and 120 (agent-watch.ts).
    let send: ((text: string) => Promise<void>) | undefined;
    const { guard, end } = this.startGuard(t, wt.path, {
      stop: (r) => {
        run.why ??= r;
        run.ctl.abort();
      },
      inject: () => send,
      canTrain: trainOk,
      signal: run.ctl.signal,
    });
    let seq = 0;
    let attemptAt = this.now();
    let text = "";
    let error = "";
    const tried: string[] = [];
    // Every free model failed or is cooling and no paid one may run (cap reached): the task waits instead of failing.
    let exhausted = false;
    try {
      const stopped = new Promise<never>((_, rej) => run.ctl.signal.addEventListener("abort", () => rej(new Error("stopped")), { once: true }));
      for (;;) {
        let attemptSteps = 0;
        guard.watch.newAttempt();
        attemptAt = this.now();
        try {
          // Only the plan's own models and the free ones may run unattended (never a paid OpenRouter id; the training-prone
          // services only when allowed): refused here, before anything is sent.
          // A task given to GhostCLI passed the same content checks (pinnedOk) without the relay setting.
          if (!inboxModelAllowed(model, trainOk, relayOk || pinnedOk)) throw new Error(`The task inbox may not use ${model}.`);
          // Every attempt counts toward the service's day, failed ones too (OpenRouter's docs); each tool call is another request.
          const attemptFree = freeProviderOf(model);
          if (attemptFree) this.freeDay(attemptFree.id).used++;
          const r = await Promise.race([
            c.run({
              worktree: wt.path,
              title: `◈ OpenCode Go · ${t.title}`.slice(0, 120),
              prompt,
              model,
              signal: run.ctl.signal,
              attach: (fn) => {
                send = fn;
              },
              onStep: (n, step) => {
                t.steps = n;
                // The card's "what it does": the last 12 steps in short (task-steps.ts).
                if (step) t.stepLog = [...(t.stepLog ?? []), stepNote(step.tool, step.args, this.now(), !!step.error)].slice(-12);
                if (attemptFree) this.freeDay(attemptFree.id).used += Math.max(0, n - attemptSteps);
                // Each new step goes to the guard: the real one when the coder says it, else a step that is never a repeat.
                for (let i = attemptSteps; i < n; i++) guard.step(i === n - 1 && step ? step : { tool: "step", args: ++seq });
                attemptSteps = n;
                void this.save();
              },
            }),
            stopped,
          ]);
          // A free model that ended without changing anything (23.11: Beam Free answered nothing and touched no file)
          // did not do the work: the task goes on to a paid model like after any free-model failure.
          if ((isFreeOpencodeModel(model) || relayProviderOf(model)) && !run.why && !(await this.d.git(wt.path, ["status", "--porcelain"])).out.trim()) {
            throw new Error(`${opencodeModelName(model)} changed no files.`);
          }
          text = r.text;
          error = "";
          break;
        } catch (e) {
          error = (e as Error).message || String(e);
          const quota = isQuotaError(error);
          // The relay's trial report: a failed attempt, or a "too many requests" answer (is "unlimited" real?).
          if (relayProviderOf(model)) {
            this.noteRelay({ at: this.now(), id: t.id, model, status: quota ? "rate-limited" : "failed", ms: this.now() - attemptAt });
            // Its server failed (25.11: a 502 Bad Gateway 10 minutes into a run): no more tasks to it until the next
            // availability check answers again.
            if (/\b(5\d\d|bad gateway|timeout|timed out|did not complete|unavailable|ECONNRESET)\b/i.test(error) && this.saved.relayHealth) this.saved.relayHealth = { ...this.saved.relayHealth, ok: false, note: `${opencodeModelName(model)}: ${error.slice(0, 120)}` };
          }
          const fp = freeProviderOf(model);
          // A negative balance blocks OpenRouter's free models (402): that service is out until the next UTC midnight.
          const pay = !!fp && /\b402\b|payment required|insufficient (credits|balance)|negative balance/i.test(error);
          // A file the task read holds a secret (privacy-guard.ts): no service that may train gets it. The next model
          // that does not train takes the task; the model itself is fine (no cooldown).
          const privacy = isPrivacySkip(error);
          // A free model that fails in any way (the offer ended, it is overloaded) hands the task to the paid order.
          if (!privacy && (run.why || (!quota && !isFreeOpencodeModel(model) && !relayProviderOf(model)))) break;
          // A 429 blocks only this model (until its reset, else 5 hours; a failing free model 1 hour); the task goes
          // on to the next model that is not cooling down: at most one paid retry after the free ones.
          if (privacy) {
            tried.push(model);
            const next = opencodeFreeModel(order.filter((m) => !trainingRiskOf(m)), this.opencodeCooldowns(), this.now(), undefined, tried);
            if (!next) break;
            const prev = model;
            model = next;
            delete t.mayTrain;
            Object.assign(t, { modelUsed: modelLabel(model), modelFallback: `${opencodeModelName(prev)} → ${opencodeModelName(model)}` });
            await this.save();
            continue;
          }
          const wait = pay ? nextUtcMidnight(this.now()) - this.now() : quota ? retryAfterMs((e as { rateHeaders?: Record<string, string> }).rateHeaders ?? {}, error, this.now()) : 60 * 60_000;
          // A free service that answers 402 or 429 cools down as a whole (Z.ai allows one request at a time).
          if (fp && (pay || quota)) this.stopFreeService(fp.id, this.now() + (wait && wait > 0 ? wait : OPENCODE_LIMIT_MS), order);
          this.blockOpencodeModel(model, wait);
          tried.push(model);
          const paidTried = tried.filter((m) => !isFreeOpencodeModel(m)).length;
          const next = paidTried < 2 ? opencodeFreeModel(order, this.opencodeCooldowns(), this.now(), undefined, tried) : undefined;
          if (!next) {
            exhausted = paidTried < 2 && isFreeOpencodeModel(model);
            break;
          }
          const prev = model;
          model = next;
          t.modelUsed = modelLabel(model);
          if (trainingRiskOf(model)) t.mayTrain = true;
          else delete t.mayTrain;
          t.modelFallback = `${opencodeModelName(prev)} → ${opencodeModelName(model)}`;
          await this.save();
        }
      }
    } finally {
      end();
      this.opencodeStop = undefined;
    }
    // Only paid models count toward the daily cap (a task that ended on a free one cost nothing).
    if (!isFreeOpencodeModel(model) && !relayProviderOf(model)) this.ocToday().used++;
    this.paidRuns.set(t.id, !isFreeOpencodeModel(model));
    t.summary = text.trim().slice(-2000) || undefined;
    const limited = !run.why && !!error && (isQuotaError(error) || exhausted);
    if (limited) this.log(t, "quota", "warning", { requests: t.steps ?? 0 }, error.slice(0, 160));
    // The earliest cooldown (a free model back, 1 hour for a failed one), else the paid cap's reset at the next UTC midnight.
    const cools = Object.values(this.opencodeCooldowns());
    const until = limited ? (exhausted ? (cools.length ? Math.min(...cools) : nextUtcMidnight(this.now())) : this.ocToday().modelUntil?.[model]) : undefined;
    const why = exhausted && limited ? `No free model could do it (${opencodeModelName(model)}: ${error.slice(0, 120)}) and today's paid limit is reached: it goes again by itself at ${new Date(until ?? this.now()).toISOString()} or when a free model is open.` : limited ? `OpenCode Go limit reached until ${new Date(until ?? this.now()).toISOString()} (${opencodeModelName(model)}).` : run.why === "stop" ? "Stopped by you." : run.why ? this.stopText(t, run.why) : error ? `OpenCode Go failed: ${error.slice(0, 300)}` : "";
    await this.finish(t, wt.path, baseSha ?? wt.base, repo, !error && !run.why, why, limited ? "deferred-quota" : undefined);
    if (relayProviderOf(model) && !error) {
      this.noteRelay({ at: this.now(), id: t.id, model, status: t.status, ms: this.now() - attemptAt });
      await this.save();
    }
  }

  /**
   * Sends the relay a small "reply with ok" every 15 minutes (Roee, 25.11: keep checking it answers): the relay gets tasks
   * only while the last one answered, and the phone is told when it starts or stops answering.
   */
  /** Antigravity's quota for the hub's cards: the summary of the last reading, when it is under an hour old. */
  agQuotaSummary(): { left: number; resetAt?: number } | undefined {
    const q = this.saved.agQuota;
    return q && this.now() - q.at < 60 * 60_000 ? antigravityQuotaSummary(q) : undefined;
  }

  private agReading = false;

  /** Whether the last reading of Antigravity's quota (under 15 minutes old) shows any model with quota left. */
  private agQuotaLeft(): boolean {
    const q = this.saved.agQuota;
    return !!q && this.now() - q.at < 15 * 60_000 && q.models.some((m) => m.left > 0);
  }
  private agTriedAt = -Infinity;
  private probeTriedAt = -Infinity;

  /**
   * Reads Antigravity's quota from its local language server (every {@link AG_QUOTA_MS}), read-only. All models used
   * up → the inbox's quota stop is set to the real reset (not a guess from an error text); quota back → the stop is
   * lifted, so put-off Antigravity tasks can run again.
   */
  private async readAgQuota(): Promise<void> {
    if (!this.d.agQuota || this.agReading) return;
    const last = this.saved.agQuota;
    if (last && this.now() - last.at < AG_QUOTA_MS) return;
    // Also after a failed reading (no language server): do not spawn powershell/netstat on every sync.
    if (this.now() - this.agTriedAt < AG_QUOTA_MS) return;
    this.agTriedAt = this.now();
    this.agReading = true;
    try {
      let why = "";
      const q = await this.d.agQuota((w) => (why = w));
      if (!q) {
        if (why !== this.saved.agQuotaWhy) {
          this.saved.agQuotaWhy = why || undefined;
          await this.save();
        }
        return;
      }
      delete this.saved.agQuotaWhy;
      // A model family with quota left is open again, whatever an earlier error text made the inbox guess (26.11: the
      // line stayed paused for "every model's quota" while Antigravity showed 70-100% left). Gemini models share one
      // quota: any of them with quota opens the Flash family.
      const open = new Set(q.models.filter((m) => m.left > 0).map((m) => familyOf(m.name) ?? (/gemini/i.test(m.name) ? "flash" : undefined)).filter(Boolean));
      if (this.saved.familyUntil) for (const f of open) delete this.saved.familyUntil[f as ModelFamily];
      if (this.saved.familySure) for (const f of open) delete this.saved.familySure[f as ModelFamily];
      const was = last ? antigravityQuotaSummary(last).left : undefined;
      this.saved.agQuota = q;
      const s = antigravityQuotaSummary(q);
      if (s.left <= 0 && s.resetAt && s.resetAt > this.now()) this.saved.quota = { until: s.resetAt, estimated: false, ...(this.saved.quota?.taskId ? { taskId: this.saved.quota.taskId } : {}) };
      else if (s.left > 0 && this.saved.quota && this.saved.quota.until > this.now()) delete this.saved.quota;
      await this.save();
      if (was !== undefined && was <= 0 && s.left > 0) this.d.notify("✦ Antigravity is back", `Its quota renewed (${Math.round(s.left * 100)}% left).`, { path: "#/task-inbox" });
    } finally {
      this.agReading = false;
    }
  }

  private async probeRelays(): Promise<void> {
    const c = this.d.coder;
    if (!c || this.oc.useRelay === false || this.probing) return;
    const last = this.saved.relayHealth;
    if (last && this.now() - last.at < RELAY_PROBE_MS) return;
    if (this.now() - this.probeTriedAt < RELAY_PROBE_MS) return;
    this.probeTriedAt = this.now();
    this.probing = true;
    try {
      for (const r of RELAY_PROVIDERS) {
        const conn = c.free?.[r.id];
        if (!conn?.ready() || !conn.probe) continue;
        // Each candidate in turn, best first (25.11: Opus and Sonnet came back empty while GLM 5.3 answered).
        const candidates = r.pick(await conn.models().catch(() => [] as string[]));
        if (!candidates.length) continue;
        const t0 = this.now();
        const answered: string[] = [];
        let note = "";
        for (const model of candidates) {
          try {
            const text = (await conn.probe(model, AbortSignal.timeout(90_000))).trim();
            if (text) {
              answered.push(model);
              if (!note) note = `${opencodeModelName(model)}: ${text.slice(0, 60)}`;
            } else if (!answered.length) note = `${opencodeModelName(model)}: an empty answer`;
          } catch (e) {
            if (!answered.length) note = `${opencodeModelName(model)}: ${((e as Error).message || String(e)).slice(0, 120)}`;
          }
        }
        const ok = answered.length > 0;
        const model = answered[0] ?? candidates[0]!;
        const was = this.saved.relayHealth?.ok;
        this.saved.relayHealth = { at: this.now(), ok, ms: this.now() - t0, model, note, answered };
        this.saved.relayLog = [...(this.saved.relayLog ?? []), { at: this.now(), id: "probe", model, status: (ok ? "probe-ok" : "probe-failed") as RelayRun["status"], ms: this.now() - t0 }].slice(-200);
        await this.save();
        // A model that answered is not cooling down any more (25.11: after a 502 the models stayed out for an hour
        // although the next check answered).
        const until = this.ocToday().modelUntil;
        if (answered.length && until) for (const m of answered) delete until[m];
        // It answers again: load it right away (Roee, 25.11: "when they are available, load them up").
        if (ok && !was) void this.pumpOpencode();
        if (was !== ok && (was !== undefined || ok)) this.d.notify(ok ? `✓ ${r.name} עונה` : `✕ ${r.name} לא עונה`, ok ? `${opencodeModelName(model)} answered in ${Math.round((this.now() - t0) / 1000)} s; heavy tasks go to it again.` : `${note}. No tasks go to it until it answers again (checked every 15 minutes).`, { path: "#/settings/task-inbox" });
      }
    } finally {
      this.probing = false;
    }
  }

  private probing = false;

  /** Adds one relay attempt to the trial report (the last 200 are kept). */
  private noteRelay(r: RelayRun): void {
    this.saved.relayLog = [...(this.saved.relayLog ?? []), r].slice(-200);
  }

  /** The note on a Claude Code task that waits. */
  private claudeNote(): string {
    return this.cs.askRun ? "Claude Code runs it on this PC after your Run (uses the same limits as your Claude app)." : "Claude Code runs it on this PC by itself (uses the same limits as your Claude app).";
  }

  /** The last install/login check and quota reading of Claude Code (refreshed by {@link refreshClaude}). */
  private claudeCache: { check?: Awaited<ReturnType<NonNullable<TaskInboxDeps["claude"]>["check"]>>; checkedAt?: number; quota?: ClaudeQuota } = {};

  /**
   * Reads Claude Code's quota file, and checks the install and login again when the last check is older than 10
   * minutes (or `force`), so the sync checks of {@link claudeBlocked} see fresh values.
   */
  private async refreshClaude(force = false): Promise<void> {
    const c = this.d.claude;
    if (!c) return;
    if (force || !this.claudeCache.checkedAt || this.now() - this.claudeCache.checkedAt > 10 * 60_000) {
      this.claudeCache.check = await c.check().catch(() => ({ installed: false }));
      this.claudeCache.checkedAt = this.now();
    }
    const q = await c.quota().catch(() => undefined);
    if (q) this.claudeCache.quota = q;
    else delete this.claudeCache.quota;
  }

  /**
   * Why a Claude Code task cannot start now, from the last check and reading (undefined: it can): off, not installed,
   * not signed in or signed in with an API key, a usage limit the CLI reported, today's cap, the quota thresholds, or
   * another Claude Code task running.
   */
  private claudeBlocked(): { msg: string; code: number; until?: number } | undefined {
    const cs = this.cs;
    if (!this.d.claude) return { msg: "Claude Code is not available in this KesherAI.", code: 409 };
    if (!this.s.enabled) return { msg: "The inbox is off (Settings > Task inbox).", code: 409 };
    if (this.s.paused) return { msg: "The inbox is paused.", code: 409 };
    if (!cs.enabled) return { msg: "Claude Code is off (Settings › Task inbox › Claude Code).", code: 409 };
    const c = this.claudeCache.check;
    if (c && !c.installed) return { msg: "Claude Code is not installed on this PC (Settings › Connections › Claude Code).", code: 409 };
    if (c?.account === "api-key") return { msg: "Claude Code is signed in with an API key. KesherAI runs it only with your Claude subscription: run claude, then /login with your Claude account.", code: 409 };
    if (c?.loggedIn === false) return { msg: "Claude Code is not signed in: run claude once and sign in with your Claude account.", code: 409 };
    const day = this.claudeToday();
    if (day.until && day.until > this.now()) return { msg: `Claude's usage limit was reached; it can run again at ${new Date(day.until).toISOString()}.`, code: 429, until: day.until };
    if (day.used >= cs.dailyCap) return { msg: `Today's limit of ${cs.dailyCap} Claude Code tasks is reached (Settings › Task inbox › Claude Code).`, code: 429, until: nextUtcMidnight(this.now()) };
    const b = claudeQuotaBlock(this.claudeCache.quota, cs, this.now());
    if (b) return { msg: `Claude's ${b.window === "five_hour" ? "5-hour" : "weekly"} usage is at ${Math.round(b.used)}% (KesherAI stops at ${b.window === "five_hour" ? cs.fiveHourMax : cs.weekMax}%): no new task until ${new Date(b.until).toISOString()}.`, code: 429, until: b.until };
    if (this.claudeRun) return { msg: "Claude Code is running another task; one at a time.", code: 409 };
    return undefined;
  }

  /**
   * Checks Claude Code's install and login now (Settings › Connections › "Check again").
   *
   * @returns Its state (undefined when this KesherAI has no Claude Code support).
   */
  async claudeCheckNow(): Promise<ClaudeState | undefined> {
    if (!this.d.claude) return undefined;
    await this.load();
    await this.refreshClaude(true);
    return this.claudeState();
  }

  /** Claude Code's state for Settings › Connections and the inbox card. */
  private async claudeState(): Promise<ClaudeState> {
    await this.refreshClaude();
    const c = this.claudeCache.check ?? { installed: false };
    const no = this.claudeBlocked();
    // "Another task is running" is not a block to show on the card.
    const blocked = no && !this.claudeRun ? { why: no.msg, ...(no.until ? { until: no.until } : {}) } : undefined;
    return { ...c, used: this.claudeToday().used, ...(this.claudeCache.quota ? { quota: this.claudeCache.quota } : {}), ...(blocked ? { blocked } : {}), ...(this.claudeCache.checkedAt ? { checkedAt: this.claudeCache.checkedAt } : {}) };
  }

  /**
   * Starts a Claude Code task after the user's Run (the press on this PC or the "Run" answer to its ask; checked by
   * {@link run}). Returns at once; the run goes on in the background.
   *
   * @param t - The task.
   * @returns The task, marked as starting.
   */
  private async startClaude(t: InboxTaskView): Promise<InboxTaskView> {
    if (t.status === "running" && this.claudeStop?.id === t.id) return t;
    await this.refreshClaude(true);
    const no = RUNNABLE.has(t.status) ? this.claudeBlocked() : { msg: "This task cannot be run now.", code: 409 };
    if (no) throw fail(no.msg, no.code);
    delete t.runAsk;
    this.claudeRun = this.runClaudeTask(t).catch(async (e: unknown) => {
      this.claudeStop = undefined;
      if (t.status !== "running") return;
      Object.assign(t, { status: "failed" as InboxStatus, endedAt: this.now(), note: `Claude Code could not run: ${((e as Error).message || String(e)).slice(0, 200)}` });
      await this.save();
    }).finally(() => {
      this.claudeRun = undefined;
      // Run tap off: the next waiting task starts by itself.
      if (!this.cs.askRun) void this.pumpClaude().catch(() => undefined);
    });
    return t;
  }

  /**
   * With "Run tap per task" off: runs the waiting Claude Code tasks by themselves, one at a time, while nothing blocks
   * (the task keeps the reason as its note). With it on this does nothing: each task waits for the user's Run.
   *
   * @returns Resolves when no task is left to start now.
   */
  async pumpClaude(): Promise<void> {
    await this.load();
    const s = this.s;
    if (!this.d.claude || this.cs.askRun || !s.enabled || s.paused || !s.repo || this.claudeRun) return;
    const t = this.saved.tasks.find((x) => x.runBy === "claude" && (x.status === "waiting" || x.status === "deferred-quota"));
    if (!t) return;
    if (await this.drainNote(t)) return;
    await this.refreshClaude();
    const no = this.claudeBlocked();
    if (no) {
      if (t.note !== no.msg) {
        t.note = no.msg;
        await this.save();
      }
      return;
    }
    await this.startClaude(t);
  }

  /**
   * One Claude Code task: its own worktree and `claude/*` branch, Claude Code headless in it with every step on the
   * task and the run guard (stall, repeat, budget, rescue through stdin, watchdog), then the same checks, review,
   * commit and push as the others'. A usage-limit message defers it until the reset.
   */
  private async runClaudeTask(t: InboxTaskView): Promise<void> {
    const c = this.d.claude!;
    const repo = this.repo();
    // Stop works from here on (also while the worktree is made and the packages are installed).
    const run: { id: string; ctl: AbortController; why?: "stop" | StopReason } = { id: t.id, ctl: new AbortController() };
    this.claudeStop = run;
    t.status = "running";
    t.note = "Starting…";
    await this.save();
    await this.d.git(repo, ["fetch", "--quiet", "--no-tags", "origin"], 60_000);
    const taskBase = t.base.startsWith("origin/") ? `refs/remotes/${t.base}` : t.base;
    const resume = await this.resumeRef(repo, t);
    const base = resume ?? taskBase;
    let attempt = t.startedAt ? Number(/-r(\d+)$/.exec(t.branch.replace(/-partial$/, ""))?.[1] ?? 1) + 1 : 1;
    const named = (n: number): string => `${branchFor(t, "claude")}${n > 1 ? `-r${n}` : ""}`;
    // A branch left by an earlier failed start: take the next free name; never delete the old branch.
    for (let i = 0; i < 20 && (await this.d.git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${named(attempt)}`])).code === 0; i++) attempt++;
    const branch = named(attempt);
    let wt: Awaited<ReturnType<typeof createSessionWorktree>>;
    try {
      if (!validBranchName(branch)) throw new Error("Bad branch name.");
      wt = await createSessionWorktree(repo, `claude-${t.id}-${attempt}`.slice(0, 60), this.gitStrict, { branch, base, copyIncluded: false });
    } catch (e) {
      this.claudeStop = undefined;
      Object.assign(t, { status: "failed" as InboxStatus, endedAt: this.now(), note: `Could not make the work folder: ${(e as Error).message.slice(0, 200)}` });
      await this.save();
      return;
    }
    const baseSha = resume ? await this.commitOf(repo, taskBase) : undefined;
    const cs = this.cs;
    Object.assign(t, { status: "running" as InboxStatus, branch, startedAt: this.now(), steps: 0, checks: [], files: [], pushed: false, resultWritten: false, modelUsed: `Claude Code${cs.model ? ` · ${cs.model}` : ""}` });
    for (const k of ["endedAt", "note", "summary", "headSha", "diff", "modelFallback", "mayTrain", "retryAt", "plan", "decisions", "watchLog", "review"] as const) delete t[k];
    if (resume) t.note = `Continuing from the partial branch ${resume.replace(/^refs\/(heads|remotes\/origin)\//, "")}.`;
    // A started task counts toward today's cap (a failed one too: it used the limits).
    this.claudeToday().used++;
    await this.save();
    this.d.notify("✳ Claude Code התחיל משימה", t.title, { path: `#/task-inbox/${t.id}` });
    if (existsSync(join(wt.path, "pnpm-lock.yaml"))) await this.d.run(wt.path, ["pnpm", "install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts"], 10 * 60_000).catch(() => undefined);
    const prompt = agentPrompt(t, branch);
    const canTrain = this.s.opencode?.freeTrainingOk !== false && safeForTrainingProvider({ ...t, size: taskSize(t) }).ok && scanDiff(prompt.split("\n").map((l) => `+${l}`).join("\n"), this.d.me).length === 0;
    let send: ((text: string) => Promise<void>) | undefined;
    const { guard, end } = this.startGuard(t, wt.path, {
      stop: (r) => {
        run.why ??= r;
        run.ctl.abort();
      },
      inject: () => send,
      canTrain,
      signal: run.ctl.signal,
    });
    let out: ClaudeRunEnd;
    try {
      if (run.ctl.signal.aborted) throw new Error("Stopped before Claude Code started.");
      out = await c.run({
        worktree: wt.path,
        prompt,
        model: cs.model,
        commands: this.s.commands,
        signal: run.ctl.signal,
        attach: (fn) => {
          send = fn;
        },
        onEvent: (e) => {
          if (e.kind === "init" && e.model) t.modelUsed = `Claude Code · ${e.model}`;
          if (e.kind !== "step") return;
          t.steps = (t.steps ?? 0) + 1;
          guard.step(e.step);
          void this.save();
        },
      });
    } catch (e) {
      out = { code: -1, stderr: (e as Error).message };
    } finally {
      end();
      this.claudeStop = undefined;
    }
    this.paidRuns.set(t.id, false);
    t.summary = out.result?.text.trim().slice(-2000) || undefined;
    const limited = !run.why && !!out.limit;
    let why = "";
    if (limited) {
      // The reset the CLI said, else the quota file's window that is full, else 5 hours (estimated).
      await this.refreshClaude();
      const q = this.claudeCache.quota;
      const full = [q?.fiveHour, q?.sevenDay].filter((w) => w && w.resetsAt > this.now() && w.usedPercentage >= 99).map((w) => w!.resetsAt);
      const until = out.limit!.until ?? (full.length ? Math.max(...full) : this.now() + OPENCODE_LIMIT_MS);
      this.claudeToday().until = until;
      this.log(t, "quota", "warning", { requests: t.steps ?? 0 }, (out.result?.text || out.stderr).slice(0, 160));
      why = `Claude's usage limit was reached; it can run again at ${new Date(until).toISOString()}${out.limit!.until || full.length ? "" : " (estimated)"}.`;
    } else if (run.why === "stop") why = "Stopped by you.";
    else if (run.why) why = this.stopText(t, run.why);
    else if (!out.result?.ok) why = `Claude Code failed: ${(out.result?.text || out.stderr || `exit code ${out.code}`).slice(0, 300)}`;
    await this.finish(t, wt.path, baseSha ?? wt.base, repo, !!out.result?.ok && !run.why && !limited, why, limited ? "deferred-quota" : undefined);
  }

  /**
   * Starts the run guard for one run (agent-watch.ts): the hard rules (stall, repeat, request budget, safety ceiling), the
   * rescue and the watchdog. It stops the run only through `stop`; the timer is checked every {@link TaskInboxDeps.watchEveryMs}.
   *
   * @param t - The task.
   * @param worktree - Where the agent works (a changed file there is progress).
   * @param o.stop - Ends the run for that reason.
   * @param o.inject - Sends the rescue hint into the running agent (absent: no rescue).
   * @param o.canTrain - A service that may train on prompts may see this task's text.
   * @param o.signal - Ends the helper calls.
   * @returns The guard and `end`, which stops its timer.
   */
  private startGuard(t: InboxTaskView, worktree: string, o: { stop: (r: StopReason) => void; inject?: () => ((hint: string) => Promise<void>) | undefined; canTrain: boolean; signal: AbortSignal }): { guard: RunGuard; end: () => void } {
    const lim = limitsFor(t.maxMinutes, { ...this.s, maxRequests: requestBudget({ size: taskSize(t) }, this.s.maxRequests) });
    const probe = async () => {
      const status = (await this.d.git(worktree, ["status", "--porcelain"])).out;
      const diff = (await this.d.git(worktree, ["diff", "HEAD"])).out;
      return { fp: createHash("sha1").update(status).update("\0").update(diff).digest("hex"), files: status.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.slice(3).trim()).slice(0, 40) };
    };
    const h = this.d.helpers;
    const goal = `${t.title}\n${t.goal}`;
    // The usage meter (usage-log.ts): the baseline of this executor and size, taken from the log; concurrency checks.
    const size = taskSize(t);
    let base: ReturnType<typeof baselineOf>;
    void this.d.usage?.read({ since: this.now() - 14 * 86_400_000, limit: 5000 }).then((all) => void (base = baselineOf(all, t.runBy, size)));
    const same = [...this.guarded.entries()].filter(([id]) => id === t.id).length;
    const sameExecutor = [...this.guarded.entries()].filter(([id, ex]) => id !== t.id && ex === t.runBy).length;
    this.guarded.set(t.id, t.runBy);
    this.log(t, "run-start", "info", { requests: 0 });
    if (same) this.log(t, "anomaly", "warning", {}, "Two runs of the same task at once.");
    if (sameExecutor) this.log(t, "anomaly", "warning", { running: sameExecutor + 1 }, `More agents running than allowed for ${t.runBy} (one at a time).`);
    const hooks: GuardHooks = {
      log: (text) => {
        t.watchLog = [...(t.watchLog ?? []), { at: this.now(), text }].slice(-30);
        void this.save();
        this.log(t, /^Rescued/.test(text) ? "rescue" : "anomaly", /^Rescued/.test(text) ? "info" : "warning", {}, text);
      },
      anomaly: (detail) => this.log(t, "anomaly", "warning", { requests: t.steps ?? 0 }, detail),
      stop: (r) => {
        this.log(t, "stop", "warning", { requests: t.steps ?? 0 }, this.stopText(t, r));
        o.stop(r);
      },
      ...(h
        ? {
            rescue: async ({ reason, steps }) => {
              const p = rescuePrompt({ goal, reason, steps });
              const r = await h.ask({ ...p, signal: o.signal, canTrain: o.canTrain });
              const hint = r?.text.trim();
              return r && hint ? { hint: hint.slice(0, 800), model: r.model } : undefined;
            },
            look: async ({ steps, files, flags }) => {
              // Never while a heavy job (a game, a render) needs the graphics card; no steps, nothing to look at.
              if (this.heavyJob() || !steps.length) return undefined;
              const p = watchdogPrompt({ goal, allowedPaths: t.allowedPaths, steps, files, flags });
              const text = await h.look({ ...p, signal: o.signal });
              return text ? parseWatchVerdict(text) : undefined;
            },
          }
        : {}),
      inject: async (hint) => {
        const send = o.inject?.();
        if (!send) throw new Error("This run cannot take a hint.");
        await send(hint);
      },
    };
    if (!o.inject) delete hooks.rescue;
    const guard = new RunGuard(new RunWatch(lim, () => this.now(), probe), hooks, () => this.now(), this.d.lookEveryMs, (requests) => overBaseline({ requests }, base));
    const timer = setInterval(() => void guard.tick().catch(() => undefined), this.d.watchEveryMs ?? 30_000);
    return {
      guard,
      end: () => {
        clearInterval(timer);
        this.guarded.delete(t.id);
        if (guard.offTask) this.offTask.set(t.id, guard.offTask);
        else this.offTask.delete(t.id);
      },
    };
  }

  /** The day the savings finder last ran (once a day, in memory: a restart may run it once more, never twice the same text). */
  private savingsDay = "";

  /** Task ids whose run was on a free or local model (false) for the usage log; absent: paid. */
  private paidRuns = new Map<string, boolean>();

  /** The usage log for the API (empty when none is set). */
  async usageLog(q: import("./usage-log.js").UsageQuery): Promise<{ entries: UsageEntry[]; totals: import("./usage-log.js").UsageDay[] }> {
    const log = this.d.usage;
    return log ? { entries: await log.read(q), totals: await log.totals(q.since) } : { entries: [], totals: [] };
  }

  /** Runs the guard watches now: task id → executor (for the concurrency check). */
  private guarded = new Map<string, string>();

  /** Writes one usage-log entry for a task (never throws; nothing when no log is set). */
  private log(t: InboxTaskView, event: UsageEntry["event"], level: UsageEntry["level"], numbers: Record<string, number> = {}, why?: string): void {
    void this.d.usage?.append({ level, executor: t.runBy, ...(t.modelUsed ? { model: t.modelUsed } : {}), task: t.id, size: taskSize(t), event, numbers, ...(why ? { why } : {}) });
  }

  /**
   * The savings finder (usage-log.ts, savings.ts): looks over the last week's log for ways to reach the same result with
   * less quota and writes `suggestion` entries (not twice for the same text). The small model words each in one plain
   * sentence when it is available. Nothing is applied. Runs once a day from the loop and on demand.
   *
   * @returns The new suggestions.
   */
  async savingsPass(): Promise<string[]> {
    const log = this.d.usage;
    if (!log) return [];
    const week = await log.read({ since: this.now() - 7 * 86_400_000, limit: 5000 });
    const known = new Set(week.filter((e) => e.level === "suggestion").map((e) => `${e.executor}|${e.task ?? ""}|${e.size ?? ""}|${e.numbers?.saved ?? 0}`));
    const fresh = findSavings(week).filter((s) => !known.has(`${s.executor}|${s.task ?? ""}|${s.size ?? ""}|${s.numbers?.saved ?? 0}`));
    const out: string[] = [];
    for (const s of fresh) {
      let why = s.why ?? "";
      const said = await this.d.helpers?.look({ system: "Write ONE plain sentence (max 30 words) telling a user how to save quota, from this evidence. No preface.", prompt: why, signal: AbortSignal.timeout(60_000) }).catch(() => undefined);
      if (said?.trim()) why = `${said.trim().split(/\r?\n/)[0]!.slice(0, 200)} (${why})`;
      await log.append({ ...s, why });
      out.push(why);
    }
    return out;
  }

  /** The note of a guard stop, with this task's numbers. */
  private stopText(t: InboxTaskView, r: StopReason): string {
    const l = limitsFor(t.maxMinutes, { ...this.s, maxRequests: requestBudget({ size: taskSize(t) }, this.s.maxRequests) });
    return stopNote(r, { stallMinutes: l.stallMinutes, maxRequests: l.maxRequests, ceilingMinutes: l.ceilingMinutes });
  }

  /**
   * The end review (agent-watch.ts): a second model reads the diff against the goal and the allowed paths. A service that
   * may train on prompts gets the diff only when the task is safe for it and the privacy scan finds nothing.
   *
   * @returns Nothing; the review is put on the task (absent when no model could review).
   */
  private async reviewDiff(t: InboxTaskView, diff: string): Promise<void> {
    const h = this.d.helpers;
    if (!h) return;
    const canTrain = this.s.opencode?.freeTrainingOk !== false && safeForTrainingProvider({ ...t, size: taskSize(t) }).ok && scanDiff(diff, this.d.me).length === 0;
    try {
      const p = reviewPrompt({ goal: `${t.title}\n${t.goal}`, ...(t.acceptance ? { acceptance: t.acceptance } : {}), allowedPaths: t.allowedPaths, diff, ...(this.offTask.get(t.id) ? { offTask: this.offTask.get(t.id)! } : {}) });
      const r = await h.ask({ ...p, signal: AbortSignal.timeout(90_000), canTrain });
      const v = r ? parseReview(r.text) : undefined;
      if (r && v) {
        t.review = { ...v, model: r.model, ...(this.offTask.get(t.id) ? { offTask: this.offTask.get(t.id)! } : {}) };
        this.log(t, "review", v.verdict === "ok" ? "info" : "warning", { requests: t.steps ?? 0 }, `${v.verdict}${v.reasons.length ? `: ${v.reasons.join("; ")}` : ""}`);
      }
    } catch {
      // No reviewer now: the checks above still decide.
    }
  }

  /**
   * Where a new attempt of a task starts: the partial branch the last attempt pushed (its work continues), else undefined
   * (the task's own base, normally main).
   *
   * @param repo - The project.
   * @param t - The task, before its fields are reset.
   */
  private async resumeRef(repo: string, t: InboxTaskView): Promise<string | undefined> {
    if (!t.branch.endsWith("-partial") || !t.headSha || !validBranchName(t.branch)) return undefined;
    for (const ref of [`refs/heads/${t.branch}`, `refs/remotes/origin/${t.branch}`]) {
      if ((await this.d.git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).code === 0) return ref;
    }
    return undefined;
  }

  /** The commit a ref points to, or undefined. */
  private async commitOf(repo: string, ref: string): Promise<string | undefined> {
    const r = await this.d.git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    const sha = r.out.trim();
    return r.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
  }

  /** Task ids whose watchdog said "off-task" in this run (kept for the end review). */
  private offTask = new Map<string, string>();

  /** Writes a task's result file to the inbox branch. */
  private async writeResult(t: InboxTaskView, checkTail = ""): Promise<void> {
    if (!this.s.enabled || !this.s.repo || !validTaskId(t.id)) return;
    await this.commitToInbox([[`results/${t.id}.md`, resultFileText(t, checkTail)]], `inbox: result ${t.id} (${t.status})`);
    t.resultWritten = true;
  }

  /**
   * Why an Antigravity task cannot start now, or undefined when it can (the busy check aside).
   *
   * @param t - The task.
   */
  /**
   * After a task ended: asks "Done: X. Next in line: Y — Start?" for the first task in line (a stopped or limited one
   * is dropped from the line with its reason). It never starts the task: only the user's Start does (answerRun).
   *
   * @param done - The title of the task that just ended.
   */
  private async askNext(done: string, ex: QueueExecutor = "antigravity", quiet = false): Promise<string | undefined> {
    while (this.lines.size(ex) && (ex === "local" || !this.active)) {
      const id = this.takeHead(ex)!;
      const t = this.saved.tasks.find((x) => x.id === id);
      if (!t) continue;
      const no = this.cannotRun(t, false, true);
      if (no) {
        t.note = `Not asked from the queue: ${no.msg}`;
        await this.save();
        continue;
      }
      this.makeAsk(t, { done, more: this.lines.size(ex) }, quiet);
      await this.save();
      return t.title;
    }
    return undefined;
  }

  /**
   * Empties an executor's line: every queued task goes back to waiting for Run (the user's "Clear the queue").
   *
   * @param why - The note the tasks get.
   * @param ex - The executor (Antigravity's line by default).
   */
  private clearQueue(why = "The queue was cleared; press Run when you want it.", ex: QueueExecutor = "antigravity"): void {
    for (const id of this.lines.clear(ex)) {
      const t = this.saved.tasks.find((x) => x.id === id);
      if (t && t.note?.startsWith("Queued")) t.note = why;
    }
  }

  /**
   * @param ignoreActive - For a press that will wait in the queue: everything but "another task is running".
   * @param viaQueue - The task comes from a line: a local-model task may then be started too (handed to the board).
   */
  private cannotRun(t: InboxTaskView, ignoreActive = false, viaQueue = false): { msg: string; code: number } | undefined {
    const s = this.s;
    if (!s.enabled) return { msg: "The inbox is off (Settings > Task inbox).", code: 409 };
    if (s.paused) return { msg: "The inbox is paused.", code: 409 };
    if (viaQueue && t.runBy === "local") return RUNNABLE.has(t.status) ? undefined : { msg: "This task cannot be run now.", code: 409 };
    if (t.runBy === "claude") return RUNNABLE.has(t.status) ? this.claudeBlocked() : { msg: "This task cannot be run now.", code: 409 };
    if (t.runBy !== "antigravity") return { msg: t.runBy === "local" ? "Self-work runs this task from the board." : t.runBy === "gemini" ? "This research runs by itself with the free Gemini key." : "Claude runs this task.", code: 409 };
    if (this.active && !ignoreActive) return { msg: BUSY_RUN_TEXT.he, code: 409 };
    if (!RUNNABLE.has(t.status)) return { msg: "This task cannot be run now.", code: 409 };
    if (this.saved.quota && this.saved.quota.until > this.now()) return { msg: `Antigravity's quota ran out; it can run again at ${new Date(this.saved.quota.until).toISOString()}.`, code: 429 };
    if (this.today().used >= s.dailyCap) return { msg: `Today's limit of ${s.dailyCap} Antigravity tasks is reached (Settings > Task inbox).`, code: 429 };
    return undefined;
  }

  /** Drops asks whose 30 minutes are over. */
  private expireAsks(): void {
    for (const t of this.saved.tasks) {
      if (!t.runAsk || t.runAsk.until > this.now()) continue;
      // An unanswered "Next in line" ask leaves nothing running on its own: the rest of the line is cleared too.
      if (t.runAsk.next) this.clearQueue("The ask expired and the queue was cleared; press Run when you want it.", t.runBy === "local" ? "local" : "antigravity");
      delete t.runAsk;
    }
  }

  /**
   * Makes a fresh ask for a task and tells the phone; false when the task cannot run now.
   *
   * @param t - The task.
   * @param next - For the ask after a finished task: its title and how many more are in line.
   */
  private makeAsk(t: InboxTaskView, next?: { done: string; more: number }, quiet = false): boolean {
    if (this.cannotRun(t, false, !!next)) return false;
    const now = this.now();
    const left = t.runBy === "claude" ? this.cs.dailyCap - this.claudeToday().used : this.s.dailyCap - this.today().used;
    t.runAsk = { requestId: randomBytes(12).toString("hex"), at: now, until: now + (this.d.approvalMs ?? 30 * 60_000), left: Math.max(0, left), ...(next ? { next } : {}) };
    if (next) {
      if (!quiet) this.d.notify("✦ Next in line — Start?", nextInLineTitle(next.done, t.title));
    }
    else if (t.runBy === "claude") this.d.notify("✳ Run this task in Claude Code?", `${t.id}: ${t.title} · ${t.runAsk.left} left today · uses your Claude limits`, { path: `#/task-inbox/${t.id}` });
    else this.d.notify("✦ Run this task in Antigravity?", `${t.id}: ${t.title} · ${t.runAsk.left} left today`);
    return true;
  }

  /**
   * Asks again "Run this task in Antigravity?" (the earlier ask expired or was answered "Not now").
   *
   * @param id - The task.
   * @returns The task with its new ask.
   */
  async askRun(id: string): Promise<InboxTaskView> {
    await this.load();
    const t = this.find(id);
    const no = this.cannotRun(t);
    if (no) throw fail(no.msg, no.code);
    this.makeAsk(t);
    await this.save();
    return t;
  }

  /** The open asks, for the hub (sent to the phone as approval requests). */
  openAsks(): Array<{ title: string; text: string; where: string; ask: InboxRunAsk }> {
    const messages = [...this.messageAsks.values()].map((m) => ({ title: m.info.title, text: m.info.text, where: m.info.where, ask: m.ask }));
    if (!this.loaded) return messages;
    this.expireAsks();
    return [...this.saved.tasks.filter((t) => t.runAsk).map((t) => ({ title: t.title, text: t.goal, where: t.branch, ask: t.runAsk! })), ...messages];
  }

  /**
   * Asks "Run this in Antigravity?" before one message a chat's agent sends to Antigravity (the `@antigravity`
   * sub-agent): the same ask as an inbox task (the PC, the phone in remote, the hub), one ask for one message, 30
   * minutes, never remembered, and a yes counts against the same daily limit.
   *
   * @param info - What the message is, for the card and the phone.
   * @returns The ask, and its answer when it comes ("timeout" after 30 minutes; "deny" when cancelled).
   * @throws When today's limit is reached or the quota ran out (nothing is asked).
   */
  askMessage(info: MessageAskInfo): { ask: InboxRunAsk; answer: Promise<"allow" | "deny" | "timeout">; cancel: () => void } {
    const now = this.now();
    if (this.saved.quota && this.saved.quota.until > now) throw fail(`Antigravity's quota ran out; it can run again at ${new Date(this.saved.quota.until).toISOString()}.`, 429);
    const cap = this.s.dailyCap;
    if (this.today().used >= cap) throw fail(`Today's limit of ${cap} Antigravity runs is reached (Settings > Task inbox).`, 429);
    const ms = this.d.approvalMs ?? 30 * 60_000;
    const ask: InboxRunAsk = { requestId: randomBytes(12).toString("hex"), at: now, until: now + ms, left: Math.max(0, cap - this.today().used) };
    let finish!: (a: "allow" | "deny" | "timeout") => void;
    const answer = new Promise<"allow" | "deny" | "timeout">((resolve) => (finish = resolve));
    const timer = setTimeout(() => done("timeout"), ms);
    const done = (a: "allow" | "deny" | "timeout") => {
      if (!this.messageAsks.delete(ask.requestId)) return;
      clearTimeout(timer);
      finish(a);
    };
    this.messageAsks.set(ask.requestId, { ask, info: { title: info.title.slice(0, 200), text: info.text.slice(0, 2000), where: info.where.slice(0, 200) }, done });
    this.d.notify("✦ Run this in Antigravity?", `${info.title.slice(0, 120)} · ${ask.left} left today`);
    return { ask, answer, cancel: () => done("deny") };
  }

  /**
   * The answer to a message ask (same verification as {@link answerRun}: the caller passes the verified sender).
   *
   * @returns Whether such an ask was open (it is used up either way).
   */
  async answerMessage(requestId: string, decision: "allow" | "deny", by: string): Promise<boolean> {
    const m = this.messageAsks.get(requestId);
    if (!m || !by) return false;
    if (m.ask.until <= this.now()) {
      m.done("timeout");
      return false;
    }
    if (decision === "allow") {
      await this.load();
      // The limit may have been reached since it was asked.
      if (this.today().used >= this.s.dailyCap) {
        m.done("deny");
        return true;
      }
      this.today().used++;
      await this.save();
    }
    m.done(decision);
    return true;
  }

  /**
   * The answer to an ask, from the user's own tap on the phone (remote, with its paired key, or through the hub,
   * sealed and signed by the paired phone) or on the PC. The ask is used up either way: one yes is one run, and an
   * expired or unknown ask starts nothing.
   *
   * @param requestId - The ask.
   * @param decision - `allow`: Run / Start. `deny`: Not now (for a "Next in line" ask the same as `skip`). `skip`: leave
   *   this one and ask about the one after. `clear`: empty the queue (its tasks wait for Run again).
   * @param by - Who answered, as verified by the caller (the paired device's id or name, or "pc").
   * @returns The task, or undefined when no such ask is open.
   */
  async answerRun(requestId: string, decision: "allow" | "deny" | "skip" | "clear", by: string): Promise<InboxTaskView | undefined> {
    await this.load();
    this.expireAsks();
    const t = this.saved.tasks.find((x) => x.runAsk?.requestId === requestId);
    if (!t || !by) return undefined;
    const next = t.runAsk?.next;
    delete t.runAsk;
    if (next && decision !== "allow") {
      if (decision === "clear") {
        t.note = "The queue was cleared; press Run when you want it.";
        this.clearQueue(undefined, t.runBy === "local" ? "local" : "antigravity");
      } else {
        t.note = "Skipped for now; press Run when you want it.";
        // The one after it gets its own ask ("asks again").
        await this.askNext(next.done, t.runBy === "local" ? "local" : "antigravity");
      }
      await this.save();
      return t;
    }
    if (decision !== "allow") {
      t.note = "Not now.";
      await this.save();
      return t;
    }
    return t.runBy === "local" ? this.handToLocal(t) : this.run(t.id, { approvedBy: by });
  }

  /**
   * Runs an Antigravity task, only from the user's own action: a press of Run on this computer, or a "Run" answer to
   * the PC's ask (see {@link answerRun}); one at a time, within the daily cap and the quota (a game or a busy PC doesn't hold it back: it runs in the cloud).
   * Returns at once; the run goes on in the background.
   *
   * @param id - The task.
   * @param how - `here`: the press came from this computer itself; `approvedBy`: the verified device that answered the ask.
   */
  async run(id: string, how: { here: boolean } | { approvedBy: string }): Promise<InboxTaskView> {
    await this.load();
    const t = this.find(id);
    // Google's terms for a personal plan: every message to Antigravity comes from the user's own press.
    if ("here" in how ? !how.here : !how.approvedBy) throw fail("On the phone, Run answers the PC's ask: tap Run on its card.", 403);
    if (t.runBy === "claude") return this.startClaude(t);
    // A second press on a task that is already starting or running (a hub card and the phone's ask both tapped): nothing more to start.
    if (t.status === "running" && this.active?.id === id) {
      delete t.runAsk;
      return t;
    }
    // Another task is running: Run does not start or queue anything silently (a double tap must not start two). The
    // page says so and offers "Add to queue" (queueAdd).
    if (this.active && this.active.id !== id && !this.lines.has(id)) throw fail(BUSY_RUN_TEXT.he, 409);
    const no = this.cannotRun(t);
    if (no) throw fail(no.msg, no.code);
    // Drop the ask for good and show the task as started at once (the hub and the phone follow every save): the fetch
    // below can take a while, and until then the hub page would still list the task as "waiting for Run" and offer
    // Run (and the phone's "Run this?" ask) a second time.
    const before = { status: t.status, note: t.note };
    delete t.runAsk;
    // The slot is taken: an old "Next in line - Start?" ask of another task is void (it must not start a second run).
    for (const o of this.saved.tasks) if (o.id !== id && o.runAsk?.next && o.runBy === "antigravity") delete o.runAsk;
    t.status = "running";
    t.note = "Starting…";
    // The task holds the one run slot from now on (another press queues behind it, as for a running task).
    let end!: () => void;
    const active: Active = { id, ...("approvedBy" in how && how.approvedBy === "queue" ? { quiet: true } : {}), done: new Promise<void>((r) => (end = r)) };
    this.active = active;
    this.slotEpoch++;
    this.quickRuns.clear();
    await this.save();
    try {
      return await this.begin(t, active, end);
    } catch (e) {
      this.active = undefined;
      end();
      // It did not start: back to waiting, so it can be run again (with the reason as its note).
      t.status = before.status;
      if (before.note) t.note = before.note;
      else delete t.note;
      await this.save();
      throw e;
    }
  }

  /** The start of {@link run}: the worktree, the counters and the background work. */
  private async begin(t: InboxTaskView, active: Active, end: () => void): Promise<InboxTaskView> {
    const now = this.now();
    const today = this.today();
    // No "PC is busy" gate here: Antigravity works in Google's cloud, and the PC only fetches and writes a git
    // worktree, so a game, an open editor or a busy card doesn't hold it back (Roee, 2026-11-20). The busy rules
    // still hold back work that runs on this PC itself (the local model, self-work).
    const repo = this.repo();
    // Start from the newest base on GitHub (fetch only reads).
    await this.d.git(repo, ["fetch", "--quiet", "--no-tags", "origin"], 60_000);
    const taskBase = t.base.startsWith("origin/") ? `refs/remotes/${t.base}` : t.base;
    // A partial attempt's pushed branch is where this one continues from.
    const resume = await this.resumeRef(repo, t);
    const base = resume ?? taskBase;
    const attempt = (t.decisions?.length || t.startedAt) ? (Number(/-r(\d+)$/.exec(t.branch.replace(/-partial$/, ""))?.[1] ?? 1) + 1) : 1;
    const branch = `${branchFor(t, "antigravity")}${attempt > 1 ? `-r${attempt}` : ""}`;
    if (!validBranchName(branch)) throw fail("Bad branch name.", 400);
    const wt = await createSessionWorktree(repo, `agy-${t.id}-${attempt}`.slice(0, 60), this.gitStrict, { branch, base, copyIncluded: false });
    const baseSha = resume ? await this.commitOf(repo, taskBase) : undefined;
    Object.assign(t, { status: "running" as InboxStatus, branch, startedAt: now, plan: [], steps: 0, decisions: [], checks: [], files: [], pushed: false, resultWritten: false });
    delete t.endedAt;
    delete t.watchLog;
    delete t.review;
    if (resume) t.note = `Continuing from the partial branch ${resume.replace(/^refs\/(heads|remotes\/origin)\//, "")}.`;
    else delete t.note;
    delete t.summary;
    delete t.headSha;
    delete t.diff;
    today.used++;
    await this.save();
    if (!active.quiet) this.d.notify("✦ Antigravity started", `${t.id}: ${t.title}`, { path: `#/task-inbox/${t.id}`, ref: progressRef(t.id) });
    void this.work(t, active, wt.path, baseSha ?? wt.base, repo).finally(async () => {
      this.active = undefined;
      // The next task of the line is asked about or started by the user's own queue tap (the ask is made before `idle` resolves).
      await this.slotFreed(t).catch(() => undefined);
      end();
    });
    return t;
  }

  /** The run itself: one prompt, the policy on each step, then KesherAI's own checks, commit and push. */
  private async work(t: InboxTaskView, a: Active, worktree: string, base: string, repo: string): Promise<void> {
    const s = this.s;
    // Packages for the checks (the project's own lockfile, from the store; no new ones).
    if (existsSync(join(worktree, "pnpm-lock.yaml"))) await this.d.run(worktree, ["pnpm", "install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts"], 10 * 60_000).catch(() => undefined);
    const ctx = { worktree, allowedPaths: t.allowedPaths, forbiddenPaths: t.forbiddenPaths, commands: s.commands, ...(t.kind === "research" ? { research: true } : {}) };
    const toolIds = new Set<string>();
    let text = "";
    let error = "";
    let stop = "";
    const progress = this.d.progress;
    const ticker = progress ? new ProgressTicker(() => ({ t, past: this.saved.tasks }), progress, () => this.now()) : undefined;
    // The run guard (agent-watch.ts): stall, repeat, request budget and safety ceiling stop the run by cancelling the
    // turn; a rescue hint is sent as the next prompt (an ACP turn cannot take a message while it runs).
    const prompt0 = agentPrompt(t, t.branch);
    const trainOk = this.s.opencode?.freeTrainingOk !== false && safeForTrainingProvider({ ...t, size: taskSize(t) }).ok && scanDiff(prompt0.split("\n").map((l) => `+${l}`).join("\n"), this.d.me).length === 0;
    const guardStop = new AbortController();
    const { guard, end: endGuard } = this.startGuard(t, worktree, {
      stop: (r) => {
        a.why ??= r;
        void a.agent?.cancel().catch(() => undefined);
      },
      inject: () => async (hint) => {
        a.hint = hint;
        await a.agent?.cancel().catch(() => undefined);
      },
      canTrain: trainOk,
      signal: guardStop.signal,
    });
    const handlers: AcpHandlers = {
      update: (u) => {
        if (u.kind === "plan") t.plan = u.entries.slice(0, 40).map((e) => ({ content: e.content.slice(0, 200), status: e.status }));
        else if (u.kind === "tool") {
          if (!toolIds.has(u.id)) guard.step({ tool: u.toolKind ?? "tool", args: u.title ?? u.id });
          toolIds.add(u.id);
          t.steps = toolIds.size;
        } else if (u.kind === "text") text = (text + u.text).slice(-6000);
        if (u.kind !== "text") ticker?.tick();
        void this.save();
      },
      permission: (p) => this.permission(t, a, p, ctx),
    };
    try {
      const agent = await this.d.startAgent(worktree, handlers);
      a.agent = agent;
      await agent.newSession(worktree);
      ticker?.start();
      await agent.setMode("accept-edits").catch(() => false);
      this.keepModels(agent);
      // The task's model (frontmatter or the picker), else the inbox's, else the default for its kind; on a quota or
      // unavailable answer the next one of the chain (Opus → Sonnet → Flash). Only models the plan lists.
      const chain = modelChain(agent.models, t.model || s.model, defaultFamilyFor(t));
      const tried: string[] = [];
      let at = 0;
      // Skip models whose quota is known to be spent (from an earlier task today): start on the next one at once.
      const spent = (i: number) => {
        const f = chain[i] ? familyOf(chain[i]!.name) : undefined;
        return f !== undefined && (this.saved.familyUntil?.[f] ?? 0) > this.now();
      };
      // A model the user picked for this task is tried even when the inbox guessed its family out (26.11: a wrong
      // "quota spent" guess sent every run to Gemini Flash while Claude had 70% left); a real quota answer still
      // moves on to the next one.
      const picked = !!t.model && !!chain[0] && matchModel(agent.models, t.model)?.id === chain[0].id;
      const sure = (i: number) => {
        const f = chain[i] ? familyOf(chain[i]!.name) : undefined;
        return f !== undefined && !!this.saved.familySure?.[f];
      };
      while (at + 1 < chain.length && spent(at) && !(picked && at === 0 && !sure(0))) {
        tried.push(`${chain[at]!.name} (quota)`);
        at++;
      }
      const use = async (): Promise<void> => {
        const m = chain[at];
        if (m) await agent.setModel(m.id).catch(() => undefined);
        t.modelUsed = agent.models.find((x) => x.id === agent.model)?.name ?? (agent.model || undefined);
        void this.save();
      };
      await use();
      while (a.why !== "stop") {
        try {
          const before = text.length;
          stop = await agent.prompt(agentPrompt(t, t.branch));
          // agy answers a spent quota as plain text ("⚠ Individual quota reached … Resets in 4h32m") and ends the turn,
          // not as an error: treat that answer like the quota error, so the next model of the chain gets the task.
          const said = text.slice(before);
          if (!a.why && stop === "end_turn" && said.length < 600 && isQuotaError(said)) throw new Error(said.trim());
          break;
        } catch (e) {
          const msg = (e as Error).message || String(e);
          // The turn was cancelled to send a rescue hint: not a failure.
          if (a.hint && !a.why) break;
          if (a.why || at + 1 >= chain.length || !isModelUnavailable(msg)) throw e;
          tried.push(`${t.modelUsed ?? chain[at]!.name} (${isQuotaError(msg) ? "quota" : "unavailable"})`);
          const fam = chain[at] ? familyOf(chain[at]!.name) : undefined;
          if (fam && isQuotaError(msg)) {
            // Opus and Sonnet share Antigravity's "Claude and GPT models" quota: one spent means both are.
            const until = quotaUntil(msg, this.now()).until;
            this.saved.familyUntil = { ...this.saved.familyUntil, ...(fam === "flash" ? { flash: until } : { opus: until, sonnet: until }) };
          }
          at++;
          await use();
          t.modelFallback = `${tried.join(" → ")} → ${t.modelUsed ?? chain[at]!.name}`;
        }
      }
      // A rescue hint: the cancelled turn is followed by one that carries it (once per run).
      while (a.hint && !a.why) {
        const hint = a.hint;
        delete a.hint;
        stop = await agent.prompt(`A colleague suggests: ${hint}\n\nContinue the task with that in mind.`);
      }
      // A research agent sometimes gives up after one refused step and writes nothing: ask once more, in the same
      // session, for the report with what it has (two deep-research runs ended this way).
      const report = t.kind === "research" ? t.allowedPaths[0] : undefined;
      if (report && !a.why && stop === "end_turn" && !existsSync(join(worktree, report))) {
        stop = await agent.prompt(researchNudge(report));
      }
      // A code task that ends having changed nothing gets the same one more chance (same session).
      if (!report && !a.why && stop === "end_turn" && !(await worktreeChanged(worktree))) {
        stop = await agent.prompt(codeNudge());
      }
    } catch (e) {
      error = (e as Error).message || String(e);
    } finally {
      endGuard();
      guardStop.abort();
      ticker?.stop();
      a.agent?.close();
    }
    t.summary = text.trim().slice(-2000) || undefined;
    // Antigravity also says its quota in its answer text, not as an error (26.11: "⚠ Individual quota reached. Please
    // upgrade your subscription … Resets in 1h19m10s." — the run then counted as "changed no files" and failed).
    const said = /^⚠[^\n]*(quota|limit)[^\n]*$/im.exec(text)?.[0];
    const quota = error && isQuotaError(error) ? quotaUntil(error, this.now()) : said ? quotaUntil(said, this.now()) : undefined;
    if (quota && said && !error) {
      // Only that model group is out (Claude and GPT share one quota, Gemini another), until the time it gave.
      const fam = t.modelUsed ? familyOf(t.modelUsed) ?? (/gemini/i.test(t.modelUsed) ? "flash" : undefined) : undefined;
      const fams: ModelFamily[] = fam === "flash" ? ["flash"] : ["opus", "sonnet"];
      for (const f of fams) {
        this.saved.familyUntil = { ...this.saved.familyUntil, [f]: quota.until };
        this.saved.familySure = { ...this.saved.familySure, [f]: !quota.estimated };
      }
    } else if (quota) this.saved.quota = { ...quota, taskId: t.id };
    const ok = !error && stop === "end_turn" && !a.why;
    const why = quota ? "Antigravity's quota ran out." : a.why === "stop" ? "Stopped by you." : a.why ? this.stopText(t, a.why) : error ? `The agent failed: ${error.slice(0, 300)}` : stop !== "end_turn" ? `The agent ended with ${stop || "no answer"}.` : "";
    await this.finish(t, worktree, base, repo, ok, why, quota ? "deferred-quota" : undefined);
  }

  /** Keeps the models the agent listed (for the pickers) and logs what its session sent, to see a new agy's shape. */
  private keepModels(agent: AcpAgent): void {
    if (!agent.models.length) {
      console.info(`[task-inbox] Antigravity's session lists no models (keys: ${agent.sessionKeys.join(", ") || "none"}).`);
      return;
    }
    // Kept as a union (26.11: one session listed 3 models, so GPT-OSS and the Gemini 4 variants vanished from the
    // picker and a pick of them was refused): this session's models first, then earlier ones it did not list.
    const now = agent.models.map((m) => ({ id: m.id, name: m.name, available: m.available }));
    const list = [...now, ...(this.saved.models ?? []).filter((o) => !now.some((m) => m.id === o.id))].slice(0, 40);
    if (JSON.stringify(list) !== JSON.stringify(this.saved.models)) {
      console.info(`[task-inbox] Antigravity models (${agent.models[0]!.via}): ${list.map((m) => `${m.name}${m.available ? "" : " [unavailable]"}`).join("; ")}`);
    }
    this.saved.models = list;
    this.saved.modelsAt = this.now();
  }

  /** The names of the models the pickers offer (see {@link InboxState.models}), for the hub page. */
  modelNames(): string[] {
    return pickableModels(this.saved.models).map((m) => m.name);
  }

  /**
   * Picks the model a task runs on ("Who does it" → model, on the PC, the phone or the hub page). Empty: the default
   * for its kind. Only a model Antigravity lists as available (or a known name before it was asked once).
   *
   * @param id - The task (waiting, queued or ended; a running task keeps its model).
   * @param model - A model's name or id from {@link InboxState.models}, or "" for the default.
   * @returns The task.
   */
  async setModel(id: string, model: string): Promise<InboxTaskView> {
    await this.load();
    const t = this.find(id);
    if (t.status === "running" || t.status === "needs-approval") throw fail("The task is running; its model cannot change now.", 409);
    const want = model.trim();
    if (want) {
      const m = pickableModels(this.saved.models).find((x) => x.id === want || x.name === want);
      if (!m) throw fail("Antigravity does not offer that model.", 400);
      t.model = m.name;
    } else delete t.model;
    await this.save();
    return t;
  }

  /** One permission request: the policy decides, or the user does (the task waits; denied after 30 minutes). */
  private async permission(t: InboxTaskView, a: Active, p: AcpPermission, ctx: Parameters<typeof decideStep>[1]): Promise<string | undefined> {
    const v = decideStep(p, ctx);
    const rec = { at: this.now(), verdict: v.verdict, what: v.what, rule: v.rule } as NonNullable<InboxTaskView["decisions"]>[number];
    t.decisions = [...(t.decisions ?? []), rec].slice(-60);
    if (v.verdict !== "ask") {
      void this.save();
      return optionFor(p, v.verdict === "allow" ? "allow" : "deny");
    }
    // One approval per task (the Run press): an unsure step is refused, not asked, unless the user wants step asks.
    if (a.why || !this.s.askSteps) {
      rec.answer = "deny";
      void this.save();
      return optionFor(p, "deny");
    }
    const ms = this.d.approvalMs ?? 30 * 60_000;
    const pending: InboxApprovalAsk = { requestId: `${t.id}-${t.decisions.length}`, what: v.what, ...(p.title ? { why: p.title.slice(0, 300) } : {}), where: t.branch, rule: v.rule, until: this.now() + ms };
    t.pending = pending;
    t.status = "needs-approval";
    await this.save();
    this.d.notify("🔔 Antigravity asks", `${t.id}: ${v.what}`);
    const answer = await new Promise<"allow" | "deny" | "timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), ms);
      a.answer = (d) => {
        clearTimeout(timer);
        resolve(d);
      };
    });
    a.answer = undefined;
    rec.answer = answer;
    delete t.pending;
    if (t.status === "needs-approval") t.status = "running";
    await this.save();
    return optionFor(p, answer === "allow" ? "allow" : "deny");
  }

  /**
   * The user's answer to an asked step.
   *
   * @param id - The task.
   * @param requestId - From its `pending`.
   * @param decision - Allow once or deny.
   */
  async answer(id: string, requestId: string, decision: "allow" | "deny"): Promise<boolean> {
    await this.load();
    const t = this.find(id);
    if (!this.active || this.active.id !== id || t.pending?.requestId !== requestId || !this.active.answer) return false;
    this.active.answer(decision === "allow" ? "allow" : "deny");
    return true;
  }

  /** Stops a running task: the agent's turn is cancelled, the work so far is kept as a `-partial` branch. */
  async stop(id: string): Promise<boolean> {
    await this.load();
    const cl = this.claudeStop;
    if (cl?.id === id) {
      cl.why = "stop";
      cl.ctl.abort();
      await this.claudeRun;
      return true;
    }
    const oc = this.opencodeStop;
    if (oc?.id === id) {
      oc.why = "stop";
      oc.ctl.abort();
      await this.opencodeRun;
      return true;
    }
    const a = this.active;
    if (!a || a.id !== id) return false;
    a.why = "stop";
    a.answer?.("deny");
    await a.agent?.cancel().catch(() => undefined);
    await a.done;
    return true;
  }

  /**
   * "Add to queue": puts a task in its executor's line (Antigravity or the local model). The tap is the user's own
   * start for it: when the executor's slot is free (and no heavy job runs) it starts at once, and otherwise the next
   * one starts by itself when the slot frees, or the PC asks "Next in line - Start?" when that executor's
   * "ask before the next task" setting is on.
   *
   * @param id - The task (waiting, failed, partial or deferred).
   * @param by - Who tapped, as verified by the caller (this computer or a paired device).
   * @returns The task with its note and place.
   */
  async queueAdd(id: string, by: string): Promise<InboxTaskView> {
    await this.load();
    const t = this.find(id);
    if (!by) throw fail("Only your paired phone or this computer can queue a task.", 403);
    if (t.runBy === "opencode" && (t.status === "waiting" || t.status === "deferred-quota" || t.status === "failed" || t.status === "partial")) {
      // OpenCode Go takes the first waiting task in the list: queuing one moves it to the front. A failed or partial
      // one goes back to waiting (a partial run continues from its pushed branch).
      if (t.status === "failed" || t.status === "partial") Object.assign(t, { status: "waiting", resultWritten: false });
      const i = this.saved.tasks.indexOf(t);
      if (i > 0) this.saved.tasks.unshift(...this.saved.tasks.splice(i, 1));
      t.note = "Next for OpenCode Go.";
      await this.save();
      void this.pumpOpencode();
      return this.withPlace(t);
    }
    if (t.runBy !== "antigravity" && t.runBy !== "local") throw fail(t.runBy === "gemini" ? "Free-Gemini research runs by itself; no queue is needed." : t.runBy === "claude" ? "Claude Code runs one task per Run; press Run on it." : t.runBy === "opencode" ? "This OpenCode Go task cannot be queued now (it is running or finished)." : "Claude runs this task; it has no queue here.", 409);
    const no = this.cannotRun(t, true, true);
    if (no) throw fail(no.msg, no.code);
    const ex: QueueExecutor = t.runBy;
    delete t.runAsk;
    const place = this.lines.add(ex, id);
    t.note = `Queued (${place} in line): it starts when ${ex === "local" ? "the local model" : "the task now running"} is free.`;
    this.ensureQueueTimer();
    await this.save();
    await this.pump(ex, false, true);
    return this.withPlace(t);
  }

  /**
   * Takes a task out of its line (it waits for Run again).
   *
   * @param id - The task.
   * @returns The task.
   */
  async queueRemove(id: string): Promise<InboxTaskView> {
    await this.load();
    const t = this.find(id);
    if (this.lines.remove(id) && t.note?.startsWith("Queued")) t.note = "Taken out of the queue; add it again when you want it.";
    await this.save();
    return t;
  }

  /** The lines now: the task ids per executor, first in line first. */
  queues(): Record<QueueExecutor, string[]> {
    return { antigravity: this.lines.ids("antigravity"), local: this.lines.ids("local") };
  }

  /** Looks at the lines every 15 seconds while one has a task (a heavy job or a board item may free its slot). */
  private ensureQueueTimer(): void {
    if (this.queueTimer) return;
    this.queueTimer = setInterval(() => {
      if (this.lines.empty) {
        clearInterval(this.queueTimer);
        this.queueTimer = undefined;
        return;
      }
      void this.followBoard().then(() => this.pump()).catch(() => undefined);
    }, 15_000);
    this.queueTimer.unref?.();
  }

  /** Whether an executor's slot is free: Antigravity runs nothing, the local model has nothing open or claimed on the board. */
  private slotFree(ex: QueueExecutor): boolean {
    if (ex === "antigravity") return !this.active;
    return !this.saved.tasks.some((t) => t.runBy === "local" && t.status === "queued" && (t.boardState === "open" || t.boardState === "claimed"));
  }

  /**
   * Moves the lines forward: for each executor whose slot is free, starts the first queued task, waits while a heavy
   * job runs, or asks "Next in line - Start?" after a task ended when the setting is on (see {@link queueStep}).
   *
   * Antigravity never starts from here by itself (Google's terms: only the user's own press): unless `tapped` (the
   * user's "Add to queue" tap on a free slot, which is their own start), its head is asked about, one ask at a time,
   * whatever the "ask before the next task" setting says.
   *
   * @param only - One executor, or both.
   * @param quiet - No notification for the ask (the caller sends one note for the freed slot).
   * @param tapped - The call is the user's own tap (queueAdd).
   */
  async pump(only?: QueueExecutor, quiet = false, tapped = false): Promise<{ started?: string; asked?: string }> {
    await this.load();
    const out: { started?: string; asked?: string } = {};
    // An update waits for a free moment: nothing new starts from the lines (the user's own tap still does).
    if (!tapped && this.d.draining?.()) {
      for (const ex of only ? [only] : QUEUE_EXECUTORS) {
        const head = this.saved.tasks.find((x) => x.id === (this.ordered(ex)[0] ?? this.lines.first(ex)));
        if (head) await this.drainNote(head);
      }
      return out;
    }
    for (const ex of only ? [only] : QUEUE_EXECUTORS) {
      for (;;) {
        const id = this.ordered(ex)[0] ?? this.lines.first(ex);
        if (!id) break;
        const t = this.saved.tasks.find((x) => x.id === id);
        if (!t || !RUNNABLE.has(t.status)) {
          this.lines.remove(id);
          continue;
        }
        const mustAsk = ex === "antigravity" && !tapped;
        const step = queueStep({ queued: this.lines.size(ex), slotFree: this.slotFree(ex), heavy: this.heavyJob(), ask: mustAsk || this.s.askBeforeNext[ex], afterEnd: mustAsk || this.pendingDone[ex] !== undefined });
        if (step.kind === "idle") break;
        if (step.kind === "wait") {
          const note = `Queued: waiting for ${step.job} to finish (a heavy job runs).`;
          if (t.note !== note) {
            t.note = note;
            await this.save();
          }
          break;
        }
        const done = this.pendingDone[ex];
        delete this.pendingDone[ex];
        if (step.kind === "ask") {
          // One ask at a time: while an Antigravity ask is open, the rest of the line waits for its answer.
          if (ex === "antigravity" && this.saved.tasks.some((x) => x.runBy === "antigravity" && x.runAsk)) {
            if (done !== undefined) this.pendingDone[ex] = done;
            break;
          }
          const asked = await this.askNext(done ?? "", ex, quiet);
          if (asked) out.asked = asked;
          break;
        }
        this.lines.remove(id);
        try {
          if (ex === "local") await this.handToLocal(t);
          else await this.run(id, { approvedBy: "queue" });
          out.started = t.title;
        } catch (e) {
          t.note = `Not started from the queue: ${(e as Error).message}`.slice(0, 300);
          await this.save();
          continue;
        }
        break;
      }
    }
    if (this.lines.empty && this.queueTimer) {
      clearInterval(this.queueTimer);
      this.queueTimer = undefined;
    }
    return out;
  }

  /**
   * An Antigravity task ended and its slot is free: the line moves on (the next one starts by itself or is asked
   * about) and the user gets ONE notification for the freed slot (see {@link freedSlotNote}).
   *
   * @param ended - The task that ended.
   */
  private async slotFreed(ended: InboxTaskView): Promise<void> {
    if (this.lines.size("antigravity")) this.pendingDone.antigravity = ended.title;
    await this.syncStanding().catch(() => undefined);
    const r = await this.pump("antigravity", true).catch(() => ({}) as { started?: string; asked?: string });
    const waiting = !r.started && !r.asked ? this.saved.tasks.find((x) => x.runBy === "antigravity" && x.status === "waiting" && !x.standing && x.id !== ended.id && this.cannotRun(x) === undefined) : undefined;
    // The first waiting task gets a fresh "Next in line - Start?" ask: the phone's notification shows its Run button
    // (hub ask note, answered with the paired key). One ask is one run and ends at 30 minutes or when a task starts.
    if (waiting) {
      this.makeAsk(waiting, { done: ended.title, more: 0 }, true);
      await this.save();
    }
    const n = freedSlotNote({ ended: { title: ended.title, ok: ended.status === "done" }, ...(r.started ? { started: r.started } : {}), ...(r.asked ? { asked: r.asked } : {}), ...(waiting ? { waiting: waiting.title } : {}) });
    const target = r.asked ? this.saved.tasks.find((x) => x.runAsk?.next && x.title === r.asked) : waiting;
    // The phone app's notification gets a Run button (it POSTs to this computer, also from anywhere): one code, one task, this slot.
    const run = target && target.status === "waiting" ? this.quickRunCode(target.id) : undefined;
    // The same id as the ended task's progress notification: this one replaces it on the phone.
    this.d.notify(n.title, n.body, { path: target ? `#/task-inbox/${target.id}` : "#/task-inbox", ...(run ? { actions: [{ label: "▶ Run", path: `api/quick-run/${run}` }] } : {}), ref: progressRef(ended.id) });
  }

  /**
   * A one-time code for the freed-slot notification's Run button. It works once, for this task, while this slot stays
   * free (starting any task voids it) and for 30 minutes at most.
   *
   * @param id - The task the button starts.
   * @returns The code (32 URL-safe characters).
   */
  private quickRunCode(id: string): string {
    const now = this.now();
    for (const [k, v] of this.quickRuns) if (v.expires < now) this.quickRuns.delete(k);
    const code = randomBytes(24).toString("base64url");
    this.quickRuns.set(code, { id, epoch: this.slotEpoch, expires: now + 30 * 60_000 });
    return code;
  }

  /**
   * The freed-slot notification's Run button: starts the next Antigravity task, as the user's own tap, once. The phone
   * then gets a follow-up notification "<task> started" or why not (e.g. a task is running).
   *
   * @param code - The button's code.
   * @returns Whether the task was started.
   */
  async quickRun(code: string): Promise<boolean> {
    await this.load();
    const q = this.quickRuns.get(code);
    this.quickRuns.delete(code);
    if (!q || q.expires < this.now() || q.epoch !== this.slotEpoch) return false;
    const t = this.saved.tasks.find((x) => x.id === q.id);
    if (!t) return false;
    try {
      await this.run(q.id, { approvedBy: "notification" });
      this.d.notify(`🟢 ${t.title.slice(0, 80)} התחילה`, "Antigravity started.", { path: `#/task-inbox/${t.id}` });
      return true;
    } catch (e) {
      this.d.notify("✕ ההרצה לא התחילה", `${(e as Error).message}`.slice(0, 200), { path: `#/task-inbox/${t.id}` });
      return false;
    }
  }

  /**
   * The standing "what to research next" task (see {@link standingPlan}): makes a fresh copy of the template task
   * when Antigravity is idle, or withdraws an unstarted copy when real work appears. Never runs it.
   */
  private async syncStanding(): Promise<void> {
    const tasks = this.saved.tasks;
    const real = tasks.filter((t) => t.runBy === "antigravity" && !t.standing);
    const busy = real.some((t) => t.status === "waiting" || t.status === "running" || t.status === "needs-approval") || this.lines.size("antigravity") > 0;
    await this.syncPeriodic();
    const copies = tasks.filter((t) => t.standing && !t.standingOf);
    const tpl = tasks.find((t) => t.id === STANDING_TEMPLATE_ID);
    const plan = standingPlan({ busy, copies: copies.map((c) => ({ ended: isEnded(c.status), ...(c.endedAt !== undefined ? { endedAt: c.endedAt } : {}) })), hasTemplate: !!tpl, now: this.now() });
    if (plan === "withdraw") {
      const gone = copies.filter((c) => c.status === "waiting");
      if (!gone.length) return;
      this.saved.tasks = tasks.filter((t) => !gone.includes(t));
      await this.save();
    } else if (plan === "create" && tpl) {
      const id = standingId(this.now(), copies.length + 1);
      if (!validTaskId(id) || tasks.some((t) => t.id === id)) return;
      const { diff: _d, runAsk: _a, ...spec } = tpl;
      const copy: InboxTaskView = { ...spec, id, standing: true, from: "self-work", status: "waiting", runBy: "antigravity", executor: "antigravity", branch: branchFor({ id, title: tpl.title }, "antigravity"), note: "Standing task: what to research next. Run starts it." };
      for (const k of ["startedAt", "endedAt", "summary", "plan", "steps", "decisions", "checks", "files", "headSha", "pushed", "boardId", "boardState", "resultWritten", "modelUsed", "modelFallback", "researchReport", "retryAt", "autoRetried", "pending"] as const) delete (copy as unknown as Record<string, unknown>)[k];
      this.saved.tasks.push(copy);
      await this.save();
    }
  }

  /**
   * Merges finished research reports into main by themselves (research-publish.ts): a free-Gemini report from the
   * task, an Antigravity report from its pushed branch. Each once (`merged` on the task); a failure is noted and tried
   * again at the next sync. Settings › Task inbox › loop: false turns it off.
   */
  private async publishDoneResearch(): Promise<void> {
    if (this.s.loop === false) return;
    const repo = this.repo();
    for (const t of this.saved.tasks) {
      if (t.kind !== "research" || t.status !== "done" || t.merged || t.standing) continue;
      // Already on main (merged by hand before this existed): note it and leave the file as it is.
      if ((await this.d.git(repo, ["cat-file", "-e", `refs/remotes/origin/main:docs/research/${t.id}.md`])).code === 0) {
        t.merged = "main";
        continue;
      }
      let text = t.researchReport;
      if (!text && t.pushed && t.branch) {
        const shown = await this.d.git(repo, ["show", `refs/remotes/origin/${t.branch}:docs/research/${t.id}.md`]);
        if (shown.code === 0) text = shown.out;
      }
      if (!text?.trim()) continue;
      const wt = worktreeFolder(repo, "research-main");
      if (!existsSync(wt)) {
        await excludeWorktrees(repo, this.gitStrict);
        await mkdir(dirname(wt), { recursive: true });
        await this.d.git(repo, ["worktree", "prune"]);
        const made = await this.d.git(repo, ["worktree", "add", "--detach", wt, "refs/remotes/origin/main"]);
        if (made.code !== 0) return;
      }
      try {
        const sha = await publishResearch(
          this.d.git,
          wt,
          { id: t.id, title: t.title, text: redactReport(text, this.d.me).text },
          AUTHOR,
          async (rel, body) => {
            await mkdir(dirname(join(wt, ...rel.split("/"))), { recursive: true });
            await writeFile(join(wt, ...rel.split("/")), body, "utf8");
          },
          async (rel) => readFile(join(wt, ...rel.split("/")), "utf8").catch(() => ""),
        );
        t.merged = sha.slice(0, 12);
      } catch (e) {
        t.note = `The report is not on main yet: ${(e as Error).message.slice(0, 160)}`;
      }
    }
    await this.save();
  }

  /**
   * Reads the task lists of research reports on origin/main (docs/research/*.md, each report once per version) into
   * the backlog, skipping tasks the report marks DONE and ones already in the inbox or the backlog. At most every 30 min.
   */
  private async importResearch(): Promise<void> {
    if (this.s.loop === false) return;
    const r = (this.saved.research ??= { seen: {}, backlog: [], made: [] });
    if (r.at && this.now() - r.at < 30 * 60_000) return;
    r.at = this.now();
    const repo = this.repo();
    const ref = "refs/remotes/origin/main";
    await this.d.git(repo, ["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/main:${ref}`], 60_000);
    const ls = await this.d.git(repo, ["ls-tree", ref, "docs/research/"]);
    if (ls.code !== 0) return;
    for (const line of ls.out.split(/\r?\n/)) {
      const m = /^\d+ blob ([0-9a-f]{7,64})\t(docs\/research\/[\w.-]+\.md)$/.exec(line.trim());
      // INDEX.md lists reports; BACKLOG.md is read like a report (its `## Tasks`), and its tasks come first.
      if (!m || /\/INDEX\.md$/.test(m[2]!) || r.seen[m[2]!] === m[1]) continue;
      const size = await this.d.git(repo, ["cat-file", "-s", m[1]!]);
      if (size.code !== 0 || Number(size.out.trim()) > 512 * 1024) continue;
      const body = await this.d.git(repo, ["show", m[1]!]);
      if (body.code !== 0) continue;
      r.seen[m[2]!] = m[1]!;
      for (const t of parseResearchTasks(body.out, m[2]!.slice("docs/research/".length))) {
        if (t.status === "done" || r.made.includes(t.key) || r.backlog.some((b) => b.key === t.key || sameTask(b.title, t.title))) continue;
        if (this.saved.tasks.some((x) => sameTask(x.title, t.title))) continue;
        r.backlog.push(t);
      }
    }
    await this.save();
  }

  /** True while the work loop makes a task: it gets no ask of its own (see offerWaiting). */
  private feeding = false;

  /**
   * Keeps the lines fed from the research backlog: while an executor has fewer than 3 tasks in line (and, for
   * Antigravity, today's cap and the model quota allow it), the next backlog task becomes an inbox task and is queued.
   * Lead tasks (size L) stay in the backlog for Claude and Roee. Settings › Task inbox › loop: false turns it off.
   */
  private async feedFromResearch(): Promise<void> {
    const r = this.saved.research;
    if (this.s.loop === false || !r?.backlog.length) return;
    for (const ex of ["antigravity", "local"] as const) {
      // The gap filler: while Antigravity is out (quota or today's cap), its S/M tasks go to OpenCode Go when it can
      // take them (on, a key, under its own cap and limit); otherwise they wait in the backlog as before.
      const gap = ex === "antigravity" && this.antigravityOut();
      if (gap && this.opencodeBlocked()) continue;
      // Antigravity's tasks wait for the user's Run (they are never queued from here); the local line is automatic.
      const waiting = () => (gap ? this.saved.tasks.filter((t) => t.runBy === "opencode" && t.status === "waiting").length : ex === "antigravity" ? this.saved.tasks.filter((t) => t.runBy === "antigravity" && t.status === "waiting" && !t.standing).length : this.lines.size(ex));
      for (let n = 0; n < 3 && waiting() < 3; n++) {
        const next = nextForExecutor(r.backlog, ex);
        if (!next) break;
        r.backlog = r.backlog.filter((b) => b !== next);
        r.made.push(next.key);
        try {
          this.feeding = true;
          const t = await this.add({ title: next.title, goal: goalFor(next), executor: gap ? "opencode" : ex, risk: next.size === "S" ? "low" : "medium", check: "pnpm -s typecheck && pnpm -s lint", size: next.size });
          if (gap) continue;
          if (ex === "antigravity") await this.setModel(t.id, "Claude Opus 4.6 (Thinking)").catch(() => undefined);
          if (ex === "local") await this.queueAdd(t.id, "research loop");
          else (this.saved.loop ??= {}).offer = [...((this.saved.loop ??= {}).offer ?? []), t.id].slice(-50);
        } catch {
          // A task that cannot be made or queued stays made (no retry storm); the backlog moves on.
        } finally {
          this.feeding = false;
        }
      }
    }
    // OpenCode Go's free models cost nothing: while one is open, Antigravity's S/M tasks beyond its own line of 3 go to
    // OpenCode Go too (up to 3 waiting there). While Antigravity is out, the gap filler above already does this.
    if (!this.antigravityOut() && this.opencodeFreeOpen() && !this.opencodeBlocked()) {
      const waiting = () => this.saved.tasks.filter((t) => t.runBy === "opencode" && t.status === "waiting").length;
      for (let n = 0; n < LINE_TARGET && waiting() < LINE_TARGET; n++) {
        const next = nextForExecutor(r.backlog, "antigravity");
        if (!next || next.size === "L") break;
        r.backlog = r.backlog.filter((b) => b !== next);
        r.made.push(next.key);
        await this.add({ title: next.title, goal: goalFor(next), executor: "opencode", risk: next.size === "S" ? "low" : "medium", check: "pnpm -s typecheck && pnpm -s lint", size: next.size }).catch(() => undefined);
      }
    }
    await this.save();
  }

  /** Whether one of OpenCode Go's free models (Settings › Task inbox › free first) is open now (not cooling down). */
  private opencodeFreeOpen(): boolean {
    if (opencodeFreeModel(opencodeFreeFirst(this.oc, this.ocListed), this.opencodeCooldowns(), this.now())) return true;
    // A free service with a key (Z.ai, OpenRouter, Cloudflare…), or the relay while it answers, can take the task too
    // (25.11: with the paid day used up and Beam Free failing, the inbox sat idle though three free keys were in).
    const free = this.d.coder?.free ?? {};
    if (this.oc.useFree !== false && FREE_PROVIDERS.some((f) => f.id !== OPENCODE_PROVIDER && free[f.id]?.ready())) return true;
    return this.oc.useRelay !== false && !!this.saved.relayHealth?.ok && RELAY_PROVIDERS.some((r) => free[r.id]?.ready());
  }

  /** The work loop's state now (work-loop.ts): running, paused until Antigravity can work again, or off. */
  loopNow(): LoopState {
    return loopState({
      on: this.s.loop !== false,
      inboxOn: this.s.enabled && !this.s.paused,
      quotaUntil: this.saved.quota?.until,
      familyUntil: this.saved.familyUntil,
      families: ["opus", "sonnet", "flash"],
      capReached: this.today().used >= this.s.dailyCap,
      now: this.now(),
    });
  }

  /**
   * One look of the work loop's 5-minute timer, in the same slot as a sync (they never overlap): the loop's work, then
   * the lines move. Cheap when nothing is due (the research import itself waits 30 minutes between fetches).
   */
  loopTick(): Promise<void> {
    this.syncing ??= (async () => {
      await this.load();
      await this.loopWork();
      await this.save();
      void this.pumpOpencode().catch(() => undefined);
      void this.pumpClaude().catch(() => undefined);
      void this.pump().catch(() => undefined);
    })().finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }

  /**
   * Once a day: removes finished worktrees of the project (session-worktrees.ts `sweepWorktrees`: pushed, clean, no task
   * running, over a day old), each logged to the usage log (info).
   *
   * @returns The folders removed.
   */
  async sweepWorktreesOnce(): Promise<string[]> {
    const ids = this.saved.tasks.filter((t) => t.status === "running" || t.status === "needs-approval" || t.status === "waiting").map((t) => `-${t.id}-`);
    const gone = await sweepWorktrees(this.repo(), async (cwd, args) => {
      const r = await this.d.git(cwd, args);
      if (r.code) throw new Error(r.out.trim());
      return r.out;
    }, { isBusy: (p) => ids.some((id) => p.includes(id)) });
    await tidyWorktreesRoot();
    for (const w of gone) void this.d.usage?.append({ level: "info", executor: "inbox", event: "cleanup", why: `Removed ${w.orphan ? "leftover worktree folder" : "finished worktree"} ${basename(w.path)}${w.branch ? ` (${w.branch})` : ""}${w.orphan ? "" : ": pushed and clean"}.` });
    return gone.map((w) => w.path);
  }

  /**
   * The work loop (Settings › Task inbox › Keep the work loop running, `loop`): read new research tasks, keep the lines
   * fed, offer the standing "what to research next" task when the backlog is empty, and send the 21:00 summary.
   */
  private async loopWork(): Promise<void> {
    if (this.s.loop === false) return;
    await this.importResearch().catch(() => undefined);
    const day = localDay(this.now());
    if (this.savingsDay !== day) {
      this.savingsDay = day;
      await this.savingsPass().catch(() => undefined);
      await this.sweepWorktreesOnce().catch(() => undefined);
    }
    await this.feedFromResearch().catch(() => undefined);
    await this.offerWaiting().catch(() => undefined);
    await this.loopStanding().catch(() => undefined);
    await this.loopSummary().catch(() => undefined);
  }

  /**
   * Offers the first waiting Antigravity task the loop made with the usual "Run this task in Antigravity?" ask (PC and
   * phone), one ask at a time and each task once (an expired or declined ask is not repeated by the loop). Starts
   * nothing: only the user's Run answer does. The tasks to offer are the ones {@link feedFromResearch} made.
   */
  private async offerWaiting(): Promise<void> {
    const l = this.saved.loop;
    if (!l?.offer?.length || this.active || this.loopNow().state !== "running") return;
    if (this.saved.tasks.some((t) => t.runBy === "antigravity" && t.runAsk)) return;
    // Ids that are gone, started or finished drop out; the first one still waiting gets its ask (once).
    while (l.offer.length) {
      const t = this.saved.tasks.find((x) => x.id === l.offer![0]);
      if (t && t.status === "waiting" && t.runBy === "antigravity" && !this.makeAsk(t)) return;
      l.offer.shift();
      if (t && t.status === "waiting" && t.runAsk) break;
    }
    await this.save();
  }

  /**
   * Offers the standing "what to research next" copy (made by {@link syncStanding}) when the backlog has nothing for
   * Antigravity, at most once a day and never while the loop is paused: "Run this task in Antigravity?" on the PC and
   * the phone. It starts only on the user's tap (the standing task never runs by itself).
   */
  private async loopStanding(): Promise<void> {
    await this.syncStanding();
    const now = this.now();
    const r = this.saved.research;
    const idle = !this.saved.tasks.some((t) => t.runBy === "antigravity" && !t.standing && (t.status === "waiting" || t.status === "running" || t.status === "needs-approval"));
    if (!standingDue({ running: this.loopNow().state === "running", backlogEmpty: !r || !nextForExecutor(r.backlog, "antigravity"), idle, lastDay: this.saved.loop?.standingDay, now })) return;
    const copy = this.saved.tasks.find((t) => t.standing && !t.standingOf && t.status === "waiting" && !t.runAsk);
    if (!copy) return;
    if (!copy.goal.includes("## Loop focus")) copy.goal += STANDING_LOOP_NOTE;
    if (!this.makeAsk(copy)) return;
    (this.saved.loop ??= {}).standingDay = localDay(now);
    await this.save();
  }

  /** The daily summary on the phone at 21:00 (local): done, failed, branches to review, what is next. Once a day. */
  private async loopSummary(): Promise<void> {
    const now = this.now();
    const l = (this.saved.loop ??= {});
    if (!summaryDue(now, l.summaryDay)) return;
    const title = (id: string) => this.saved.tasks.find((t) => t.id === id)?.title;
    const r = this.saved.research;
    const next = [
      ...[...this.lines.ids("antigravity"), ...this.lines.ids("local")].map(title),
      ...(r ? (["antigravity", "local"] as const).map((ex) => nextForExecutor(r.backlog, ex)?.title) : []),
    ].filter((t): t is string => !!t);
    const n = dailySummary({ tasks: this.saved.tasks, next, since: l.summaryAt ?? now - 24 * 60 * 60_000, state: this.loopNow() });
    l.summaryDay = localDay(now);
    l.summaryAt = now;
    await this.save();
    this.d.notify(n.title, n.body, { path: "#/task-inbox" });
  }

  /** The research backlog for the hub and the phone: counts by executor, and the lead tasks waiting for a decision. */
  researchBacklog(): { byWho: Record<string, number>; lead: Array<{ key: string; title: string; source: string }>; made: number } {
    const r = this.saved.research ?? { seen: {}, backlog: [], made: [] };
    const byWho: Record<string, number> = {};
    for (const t of r.backlog) byWho[t.who] = (byWho[t.who] ?? 0) + 1;
    return { byWho, lead: r.backlog.filter((t) => t.who === "lead").map((t) => ({ key: t.key, title: t.title, source: t.source })), made: r.made.length };
  }

  /**
   * Periodic standing tasks ({@link PERIODIC_STANDING}): a fresh copy of each template once per period, waiting for
   * Run in the normal line (made even while Antigravity is busy). Never runs it.
   */
  private async syncPeriodic(): Promise<void> {
    for (const p of PERIODIC_STANDING) {
      const tasks = this.saved.tasks;
      const tpl = tasks.find((t) => t.id === p.template);
      if (!tpl) continue;
      const copies = tasks.filter((t) => t.standingOf === p.template);
      // The template's own run counts as the first copy.
      const seen = [tpl, ...copies].map((c) => ({ ended: isEnded(c.status) || (c === tpl && c.status === "waiting" && copies.length > 0), at: c.endedAt ?? c.startedAt }));
      if (tpl.status === "waiting" && !copies.length) continue;
      if (!periodicDue(seen, p.everyDays, this.now())) continue;
      const id = `c-${new Date(this.now()).toISOString().slice(0, 10).replace(/-/g, "")}-${p.tag}-${copies.length + 1}`;
      if (!validTaskId(id) || tasks.some((t) => t.id === id)) continue;
      const { diff: _d, runAsk: _a, ...spec } = tpl;
      const copy: InboxTaskView = { ...spec, id, standing: true, standingOf: p.template, from: "self-work", status: "waiting", runBy: "antigravity", executor: "antigravity", branch: branchFor({ id, title: tpl.title }, "antigravity"), note: p.note };
      for (const k of ["startedAt", "endedAt", "summary", "plan", "steps", "decisions", "checks", "files", "headSha", "pushed", "boardId", "boardState", "resultWritten", "modelUsed", "modelFallback", "researchReport", "retryAt", "autoRetried", "pending"] as const) delete (copy as unknown as Record<string, unknown>)[k];
      this.saved.tasks.push(copy);
      await this.save();
    }
  }

  /** The heavy job that runs now, in English, or undefined. */
  private heavyJob(): string | undefined {
    return this.d.heavy ? this.d.heavy() : heavyGate.runningLabel()?.en;
  }

  /** Hands a task to the local model: its board item is opened for self-work, which takes it in its own order. */
  private async handToLocal(t: InboxTaskView): Promise<InboxTaskView> {
    await this.reassign(t.id, "local", { again: true });
    t.boardState = "open";
    await this.save();
    return t;
  }

  /**
   * Skips a waiting task (its board item is blocked with why).
   *
   * @param id - The task.
   * @param note - What the task shows (default: skipped by the user; a replaced task names its replacement).
   */
  async skip(id: string, note = "Skipped by you."): Promise<InboxTaskView> {
    await this.load();
    const t = this.find(id);
    if (t.status === "running" || t.status === "needs-approval") throw fail("Stop it first.", 409);
    if (isEnded(t.status) && t.status !== "deferred-quota" && t.status !== "failed") throw fail("It has already ended.", 409);
    t.status = "skipped";
    t.endedAt = this.now();
    t.note = note;
    this.lines.remove(id);
    delete t.runAsk;
    t.resultWritten = false;
    if (t.boardId) await this.d.board?.change("roee", [{ op: "block", id: t.boardId, result: "Skipped in the task inbox." }]).catch(() => undefined);
    await this.save();
    await this.writeResult(t).catch(() => undefined);
    await this.save();
    return t;
  }

  /**
   * Redacts the research reports (`docs/research/*.md`) a change adds or edits: this computer's home folder becomes
   * `~` and its user name in a path `<user>` (see {@link redactReport}). The privacy scan then runs on the result, so
   * a report still blocks for an email address, a key or a token.
   *
   * @param worktree - The task's worktree.
   * @param paths - The changed paths (relative, `/`).
   * @returns The reports that changed.
   */
  private async redactReports(worktree: string, paths: string[]): Promise<string[]> {
    const changed: string[] = [];
    for (const rel of paths.map((p) => p.trim()).filter(isResearchReport)) {
      const file = join(worktree, ...rel.split("/"));
      const text = await readFile(file, "utf8").catch(() => undefined);
      if (text === undefined) continue;
      const r = redactReport(text, this.d.me);
      if (!r.count) continue;
      await writeFile(file, r.text, "utf8");
      changed.push(rel);
    }
    return changed;
  }

  /** After the turn: KesherAI's own checks, commit, push of that one branch, the result file and the board. */
  private async finish(t: InboxTaskView, worktree: string, base: string, repo: string, ok: boolean, why: string, forced?: InboxStatus): Promise<void> {
    const git = (args: string[]) => this.d.git(worktree, args);
    const checks: InboxCheck[] = [];
    await git(["add", "-A"]);
    // A research report is redacted, not blocked, for this computer's paths and user name (code files still block).
    const redacted = await this.redactReports(worktree, (await git(["diff", "--cached", "--name-only", base])).out.split(/\r?\n/));
    if (redacted.length) {
      await git(["add", "-A"]);
      checks.push({ name: "report redaction", ok: true, note: `personal paths and the user name replaced with ~ and <user> in ${redacted.slice(0, 5).join(", ")}` });
    }
    // Scratch output the agent made (a test log piped into base-out.txt): dropped, not a reason to lose the whole run
    // (25.11: s-20261122-01 was blocked by two such files, which also held personal paths from the logs).
    const added = (await git(["diff", "--cached", "--name-only", "--diff-filter=A", base])).out.split(/\r?\n/).filter(Boolean);
    const scratch = added.filter((f) => isScratchFile(f) && checkPaths([f], t).outside.length > 0);
    if (scratch.length) {
      await git(["rm", "--cached", "-q", "-f", "--", ...scratch]);
      await Promise.all(scratch.map((f) => rm(join(worktree, ...f.split("/")), { force: true }).catch(() => undefined)));
      checks.push({ name: "scratch files", ok: true, note: `left out of the commit: ${scratch.slice(0, 5).join(", ")}` });
    }
    const numstat = await git(["diff", "--cached", "--numstat", base]);
    const files = numstat.out.split(/\r?\n/).filter((l) => l.trim()).map((l) => {
      const [a, r, ...p] = l.split("\t");
      return { path: p.join("\t"), added: Number(a) || 0, removed: Number(r) || 0 };
    });
    t.files = files.slice(0, 200);
    const diff = (await git(["diff", "--cached", base])).out;
    t.diff = diff.slice(0, 60_000);
    const paths = checkPaths(files.map((f) => f.path), t);
    checks.push({ name: "paths", ok: !paths.outside.length && !paths.tooMany, note: paths.outside.length ? `outside the allowed paths: ${paths.outside.slice(0, 5).join(", ")}` : paths.tooMany ? `${files.length} files, more than ${t.maxFiles}` : `${files.length} files inside the allowed paths` });
    const found = scanDiff(diff, this.d.me);
    checks.push({ name: "secrets and privacy", ok: !found.length, note: found.length ? found.map((f) => `${f.kind} in ${f.file}`).slice(0, 5).join(", ") : "nothing found" });
    // A run on a relay or a service that may train (third parties) must not change security files: checked on the real
    // files, since the path patterns can be broad (security scan 26.11).
    const thirdParty = t.model === RELAY_PIN || /ghostcli/i.test(t.modelUsed ?? "") || !!t.mayTrain;
    const touched = thirdParty ? files.map((f) => f.path).filter(isSecurityFile) : [];
    if (touched.length) checks.push({ name: "security files", ok: false, note: `a third-party model changed security files: ${touched.slice(0, 5).join(", ")}` });
    const version = changesVersion(diff);
    if (version) checks.push({ name: "version fields", ok: false, note: "a package.json version changed (releases are the lead's)" });
    const blocked = !!paths.outside.length || paths.tooMany || !!found.length || version || !!touched.length;
    let tail = "";
    if (files.length && !blocked) {
      const parts = checkParts(t.check, this.s.commands);
      for (const r of parts.refused) checks.push({ name: "check", command: r, ok: false, note: "not on the allowed command list, so KesherAI did not run it" });
      for (const argv of parts.run.slice(0, 6)) {
        const r = await this.d.run(worktree, argv, 10 * 60_000).catch((e) => ({ code: 1, out: (e as Error).message }));
        const last = r.out.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 200);
        tail += `$ ${argv.join(" ")}\n${r.out.slice(-1500)}\n`;
        checks.push({ name: argv.slice(0, 3).join(" "), command: argv.join(" "), ok: r.code === 0, note: r.code === 0 ? last || "ok" : last || `exit ${r.code}` });
      }
    }
    t.checks = checks;
    const allOk = checks.every((c) => c.ok);
    let status: InboxStatus;
    if (blocked) status = "failed";
    // Not when it took real steps (26.11: 22 steps on Gemini 4 Hydrogen, no change, read as "quota" and every family
    // was marked out), nor when the quota just read on the PC shows quota left.
    else if (!files.length && !forced && t.runBy === "antigravity" && !why && this.now() - (t.startedAt ?? this.now()) < 4 * 60_000 && (t.steps ?? 0) <= 3 && !this.agQuotaLeft()) {
      // Antigravity with a spent weekly quota sometimes ends at once with no text we recognise and no change
      // (2026-11-23: 11 research-loop tasks in a row, 1–2 minutes each). Treat it as the quota: the task waits, and the
      // family is marked out for 6 hours so the loop stops feeding Antigravity instead of failing task after task.
      const fam = t.modelUsed ? familyOf(t.modelUsed) : undefined;
      const until = this.now() + 6 * 3600_000;
      this.saved.familyUntil = { ...this.saved.familyUntil, ...(fam === "flash" ? { flash: until } : { opus: until, sonnet: until, ...(fam ? {} : { flash: until }) }) };
      status = "deferred-quota";
      why = "Antigravity ended at once without changing anything (its quota is likely spent); it waits and tries again later.";
    } else if (!files.length) status = forced ?? "failed";
    else status = forced ?? (ok && allOk ? "done" : "partial");
    // A second model reads the finished diff (done or partial); "reject" keeps a done task from being called done.
    if (files.length && !blocked && (status === "done" || status === "partial")) {
      await this.reviewDiff(t, diff);
      if (t.review?.verdict === "reject") {
        if (status === "done") status = "partial";
        why = `${why ? `${why} ` : ""}Reviewer: ${t.review.reasons.join("; ") || "the change does not fit the task"}.`;
      }
    }
    if (status === "partial" || (status === "deferred-quota" && files.length)) {
      const partial = `${t.branch}-partial`;
      if (validBranchName(partial) && (await git(["branch", "-m", partial])).code === 0) t.branch = partial;
    }
    t.note = blocked ? `${why ? `${why} ` : ""}Not committed or pushed: ${checks.filter((c) => !c.ok).map((c) => c.note).join("; ")}. The work stays on this PC only (${t.branch}).` : why || (files.length ? undefined : "The agent changed no files.");
    if (!t.note) delete t.note;
    if (files.length && !blocked) {
      const msg = [`${status === "partial" ? "partial: " : ""}Inbox ${t.id}: ${t.title}`.slice(0, 120), "", `From the task inbox (${t.from}), run by ${t.runBy === "opencode" ? "OpenCode Go" : t.runBy === "claude" ? "Claude Code" : "Antigravity"}${t.modelUsed ? ` (${t.modelUsed})` : ""}; checked by KesherAI: ${checks.map((c) => `${c.name} ${c.ok ? "ok" : "failed"}`).join(", ")}.`, ...(status !== "done" ? [`Status: ${status}.`] : []), "", `Desktop-he: משימה מתיבת המשימות: ${t.title}`.slice(0, 200), `Phone-he: משימה מתיבת המשימות: ${t.title}`.slice(0, 200)].join("\n");
      const c = await git([...AUTHOR, "commit", "--quiet", "--no-verify", "-m", msg]);
      if (c.code === 0) {
        t.headSha = (await git(["rev-parse", "HEAD"])).out.trim().slice(0, 40);
        try {
          await pushRef(this.d.git, repo, t.branch, this.branch());
          t.pushed = true;
        } catch (e) {
          t.note = `${t.note ? `${t.note} ` : ""}${(e as Error).message.slice(0, 200)}`;
        }
      }
    }
    t.status = status;
    t.endedAt = this.now();
    this.log(t, "run-end", status === "failed" ? "error" : status === "done" ? "info" : "warning", { requests: t.steps ?? 0, minutes: Math.round(((t.endedAt - (t.startedAt ?? t.endedAt)) / 60_000) * 10) / 10, files: files.length, ok: status === "done" ? 1 : 0, paid: this.paidRuns.get(t.id) === false ? 0 : 1 }, `${status}${t.note ? `: ${t.note}` : ""}`);
    this.paidRuns.delete(t.id);
    delete t.pending;
    // The branch keeps the work; the folder goes once the work is pushed or there is nothing to keep. It stays when the
    // work was blocked or the push failed (the only copy), until the daily sweep finds it safe on the remote.
    if (!blocked && (t.pushed || !files.length)) {
      await this.d.git(repo, ["worktree", "remove", "--force", worktree]).catch(() => undefined);
      await this.d.git(repo, ["worktree", "prune"]).catch(() => undefined);
      await tidyWorktreesRoot();
    }
    await this.save();
    if (t.boardId && this.d.board) {
      const line = `${status}${t.pushed ? `: branch ${t.branch} (${(t.headSha ?? "").slice(0, 7)})` : ""}${t.note ? ` — ${t.note}` : ""}`.slice(0, 1000);
      await this.d.board.change("kesher", [status === "done" ? { op: "done", id: t.boardId, result: line } : status === "deferred-quota" ? { op: "note", text: line, task: t.boardId } : { op: "block", id: t.boardId, result: line }]).catch(() => undefined);
    }
    if (t.from !== "hub") await this.writeResult(t, tail).catch((e) => {
      this.saved.lastError = `Could not write the result: ${(e as Error).message.slice(0, 160)}`;
    });
    await this.save();
    const icon = endIcon(status);
    const body = endBody(t, status);
    // An Antigravity task's end is told by the freed-slot notification (slotFreed), one per slot.
    if (t.runBy === "claude") this.d.notify(`${icon} Claude Code ${endWord(t, status)}`, body, { path: `#/task-inbox/${t.id}` });
    else if (t.runBy === "opencode") this.d.notify(`${icon} OpenCode Go ${endWord(t, status)}`, body, { path: `#/task-inbox/${t.id}` });
    else if (t.runBy !== "antigravity") this.d.notify(`${icon} ${t.id} ${endWord(t, status)}`, body, { path: `#/task-inbox/${t.id}` });
    rememberFail(t, status, this.now());
    await this.save();
    await this.retryLater(t);
  }

  /**
   * A failed task goes back to the queue (Roee, 25.11: "after a failure it should be pending"), at most
   * {@link AUTO_RETRIES} times; a run stopped by a safety rule (privacy, paths, a model it may not use) stays failed.
   *
   * @param t - The task that just ended.
   */
  private async retryLater(t: InboxTaskView): Promise<void> {
    if (t.status !== "failed" || (t.autoRetries ?? 0) >= AUTO_RETRIES || !retryable(t.note)) return;
    t.autoRetries = (t.autoRetries ?? 0) + 1;
    t.note = `Failed: ${(t.note ?? "").slice(0, 200)} — back in the queue (try ${t.autoRetries + 1} of ${AUTO_RETRIES + 1}).`;
    t.status = t.runBy === "local" || t.runBy === "opus" ? "queued" : "waiting";
    delete t.endedAt;
    t.resultWritten = false;
    await this.save();
    if (t.runBy === "opencode") void this.pumpOpencode().catch(() => undefined);
    if (t.runBy === "gemini") void this.pumpGemini().catch(() => undefined);
    if (t.runBy === "antigravity") this.makeAsk(t);
  }

  /**
   * Hands a task to another executor ("Who does it", and the quota card's "move to the local model" / "give back to
   * Claude"): it goes back in the queue for the new one, and its board item is opened again for it. A running task is
   * refused (the caller asks the user, then stops it first); a finished one only with `again` (the user said yes).
   *
   * @param id - The task.
   * @param to - The local model (self-work, through the board), Claude's Opus agent, or Antigravity (waits for Run).
   * @param o.again - Run a finished task again with the new executor (the user confirmed).
   */
  async reassign(id: string, to: "local" | "opus" | "antigravity" | "gemini" | "opencode" | "claude", o: { again?: boolean; relay?: boolean } = {}): Promise<InboxTaskView> {
    await this.load();
    const t = this.find(id);
    if (t.status === "running" || t.status === "needs-approval") throw fail("Stop it first.", 409);
    if ((t.status === "done" || t.status === "partial") && !o.again) throw fail("It is done.", 409);
    if (to === "gemini" && t.kind !== "research") throw fail("Free Gemini does only research tasks.", 409);
    if (to === "opencode" && t.kind === "research") throw fail("OpenCode Go does only code tasks.", 409);
    if (to === "claude" && t.kind === "research") throw fail("Claude Code here does only code tasks.", 409);
    this.lines.remove(id);
    delete t.boardState;
    t.runBy = to;
    t.executor = to;
    // Given to GhostCLI (Roee, 26.11): an OpenCode task pinned to the relay's models; any other choice drops the pin.
    if (o.relay && to === "opencode") {
      const safe = safeForRelay(t);
      if (!safe.ok) throw fail(`Not for GhostCLI: ${safe.why}`, 409);
      t.model = RELAY_PIN;
    } else if (t.model === RELAY_PIN) delete t.model;
    t.status = to === "antigravity" || to === "gemini" || to === "opencode" || to === "claude" ? "waiting" : "queued";
    // A partial attempt's branch stays: the next attempt continues from it (resumeRef).
    if (!(t.headSha && t.branch.endsWith("-partial") && (to === "opencode" || to === "antigravity" || to === "claude"))) t.branch = branchFor(t, to);
    delete t.endedAt;
    delete t.runAsk;
    t.resultWritten = false;
    t.note = t.model === RELAY_PIN ? "Runs only on GhostCLI (its models, no sensitive content)." : to === "claude" ? this.claudeNote() : to === "opencode" ? opencodeNote(t, this.oc, false) : to === "gemini" ? "Runs by itself with the free Gemini key." : to === "local" ? "Self-work takes it from the task board." : to === "opus" ? "Claude runs it with its own Opus agent." : "Antigravity runs it after your Run.";
    if (t.boardId) await this.d.board?.change("roee", [{ op: "reopen", id: t.boardId }, { op: "edit", id: t.boardId, size: to === "local" ? "small" : "big", forKesher: to === "local" }]).catch(() => undefined);
    await this.save();
    // Antigravity asks "Run this?" on the PC and the phone, as for a new task.
    if (to === "antigravity" || (to === "claude" && this.cs.askRun)) this.makeAsk(t);
    if (to === "claude" && !this.cs.askRun) void this.pumpClaude().catch(() => undefined);
    if (to === "gemini") void this.pumpGemini().catch(() => undefined);
    if (to === "opencode") void this.pumpOpencode().catch(() => undefined);
    return t;
  }

  /**
   * Marks a task as moved out of the inbox (to a chat's sub-agent): it ends here as skipped, with where it went.
   *
   * @param id - The task.
   * @param where - Where it went, in a few words.
   */
  async movedOut(id: string, where: string): Promise<InboxTaskView> {
    await this.load();
    const t = this.find(id);
    if (t.status === "running" || t.status === "needs-approval") throw fail("Stop it first.", 409);
    t.status = "skipped";
    t.endedAt = this.now();
    t.note = `Moved: ${where}`.slice(0, 300);
    delete t.runAsk;
    if (t.boardId) await this.d.board?.change("roee", [{ op: "block", id: t.boardId, result: t.note }]).catch(() => undefined);
    await this.save();
    return t;
  }
}

/** How long OpenCode Go waits after a 429 that does not say (its plan's shortest window is 5 hours). */
/** A task's model, as shown on its card: the free service's name, else OpenCode Go. */
const modelLabel = (model: string): string => `${freeProviderOf(model)?.name ?? "OpenCode Go"} · ${opencodeModelName(model)}`;

export const OPENCODE_LIMIT_MS = 5 * 3_600_000;

/** An OpenCode Go task's end, in Hebrew, for the notification. */
const OPENCODE_END_HE: Partial<Record<InboxStatus, string>> = { done: "סיים משימה", partial: "סיים חלקית", failed: "נכשל", "deferred-quota": "הגיע למגבלה" };

/**
 * A task's request budget: the setting for a small task, half again for a medium one and twice for a large one (found
 * 25.11: medium tasks spent all 80 requests reading before their first edit, so nothing was saved).
 *
 * @param t - The task (its size).
 * @param base - The setting (default 80).
 * @returns The budget.
 */
export function requestBudget(t: { size?: string }, base = 80): number {
  return Math.round(base * (t.size === "L" ? 2 : t.size === "M" ? 1.5 : 1));
}

/**
 * Whether a new file is an agent's scratch output rather than work: a log or text dump at the top of the repo, or a file
 * named like one (`*-out.txt`, `*.log`, `*.tmp`, `output.txt`).
 *
 * @param path - The file, relative to the repo.
 */
export function isScratchFile(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  if (/\.(log|tmp|out|bak|orig|old)$/i.test(name) || /([-_.]out|output|stdout|stderr)\.txt$/i.test(name)) return true;
  // A copy an agent kept of a file it changed (26.11: "prev_llamacpp.test.ts" at the top blocked a whole task).
  if (/^(prev|old|orig|backup|bak|copy)[_-]|[_.-](prev|old|orig|backup|bak|copy)(\.[\w]+)?$/i.test(name.replace(/\.(test|spec)(?=\.[\w]+$)/i, ""))) return true;
  return !path.includes("/") && /\.txt$/i.test(name) && !/^(license|notice|readme|changelog|requirements|robots)/i.test(name);
}

/** How often the relay gets its small "are you there" message. */
const RELAY_PROBE_MS = 15 * 60_000;
/** How long a connection's model list / usage reading is reused (the page polls state()). */
const CONN_CACHE_MS = 30_000;
/** How often Antigravity's quota is read on the PC (a local request; the watchers poll every 1-5 minutes). */
const AG_QUOTA_MS = 5 * 60_000;

/**
 * The words of a task's end notice: "reached its limit" only when it was a limit; a task put off by an error (a free
 * model's 400, 25.11) says it was put off (the reason follows in the body).
 *
 * @param t - The task (its note).
 * @param status - How it ended.
 */
const endWord = (t: { note?: string }, status: InboxStatus): string =>
  status === "deferred-quota" && !/limit|quota|429|rate|too many/i.test(t.note ?? "") ? "נדחתה" : (OPENCODE_END_HE[status] ?? status);

/** How many times a failed task goes back to the queue by itself. */
const AUTO_RETRIES = 2;

/**
 * Whether a failure may be tried again by itself: not when a safety rule stopped it.
 *
 * @param note - Why it failed.
 */
export function retryable(note?: string): boolean {
  return !/privacy guard|may not use|outside the allowed paths|personal path|user name|declined|security|forbidden/i.test(note ?? "");
}

/** The icon of a task's end notice. */
const endIcon = (status: InboxStatus): string => (status === "done" ? "✓" : status === "deferred-quota" ? "⏸" : status === "partial" ? "◐" : "✕");

/** Keeps why a run did not succeed on the task (its box shows it even after it goes back to the queue); a done run clears it. */
export function rememberFail(t: InboxTaskView, status: InboxStatus, at: number): void {
  if (status === "done") delete t.lastFail;
  else t.lastFail = { at, status, note: (t.note ?? "").slice(0, 400) || status };
}

/**
 * The body of a task's end notice: the task, its branch when pushed, and, when it did not finish, why (the note the
 * task card shows), so the phone never says less than the card (found on the phone: "reached its limit" with no reason).
 *
 * @param t - The task.
 * @param status - How it ended.
 * @returns The text.
 */
export function endBody(t: { title: string; pushed?: boolean; branch?: string; note?: string }, status: InboxStatus): string {
  const head = `${t.title}${t.pushed ? ` · ${t.branch}` : ""}`;
  const why = status !== "done" && t.note ? t.note.replace(/\s+/g, " ").trim() : "";
  return why ? `${head}\n${why.length > 160 ? `${why.slice(0, 159)}…` : why}` : head;
}

/**
 * The note an OpenCode Go task shows in the queue: the model it runs on, and why it went there.
 *
 * @param t - The task (its size and model).
 * @param oc - The OpenCode Go settings.
 * @param gap - It was routed there because Antigravity is out.
 */
export function opencodeNote(t: Pick<InboxTaskSpec, "size" | "model" | "maxFiles" | "risk">, oc: OpencodeSettings, gap: boolean): string {
  const name = opencodeModelName(opencodeModelFor({ ...t, size: taskSize(t) }, oc));
  return `Runs by itself on OpenCode Go · ${name}${gap ? " (Antigravity is out)" : ""}.`;
}

/** Whether a status is an end. */
function isEnded(s: InboxStatus): boolean {
  return s === "done" || s === "partial" || s === "failed" || s === "declined" || s === "deferred-quota" || s === "skipped";
}

/**
 * The second prompt to a research agent that ended without writing its report.
 *
 * @param report - The report's path in the worktree.
 */
export function researchNudge(report: string): string {
  return [
    `You ended without writing the report file ${report}. Write it now.`,
    "A refused step is not a reason to stop: use your file tools (read, list, search) and web search instead of shell commands.",
    "Write everything you found so far, mark the parts you could not finish as \"not done\", and save the file before you end.",
  ].join("\n");
}

/** The second prompt to a code agent that ended without changing any file. */
export function codeNudge(): string {
  return [
    "You ended without changing any file, so nothing was done. Continue the task now.",
    "A refused step is not a reason to stop: read and list files with your file tools (or Get-ChildItem / Get-Content without pipes), then write the changes the task asks for.",
    "End only when the files are changed, or explain in one line why the task cannot be done.",
  ].join("\n");
}

/** Whether the agent changed anything in its worktree (tracked changes or new files). */
async function worktreeChanged(worktree: string): Promise<boolean> {
  try {
    const { execFile } = await import("node:child_process");
    const out = await new Promise<string>((res, rej) => execFile("git", ["status", "--porcelain"], { cwd: worktree, windowsHide: true }, (e, so) => (e ? rej(e) : res(so))));
    return out.trim().length > 0;
  } catch {
    return true;
  }
}
