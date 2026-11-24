/**
 * Progress-based watching of one agent run (Roee, 2026-11-24: "why a time limit at all?"; overnight all 10 paid OpenCode
 * runs were killed at 15 minutes while working and their work was lost).
 *
 * Generic: any agent run (task inbox of every executor, self-work, a chat's agent) can attach a {@link RunGuard}. It has
 * three layers:
 * 1. Hard rules in code ({@link RunWatch}): stop when nothing changed for `stallMs`, when the same step repeats
 *    {@link REPEAT_LIMIT} times in a row, at the request budget, or at the safety ceiling.
 * 2. A rescue: before a stall or repeat stops the run, a different model is asked for ONE concrete hint, which is
 *    injected into the run; at most once per run, and the run gets one more stall window.
 * 3. A light watchdog: every few minutes a small local model looks at the latest steps and answers `ok`, `stuck` or
 *    `off-task`. It never stops a run; `stuck` and `off-task` only trigger the rescue early (and `off-task` is passed on
 *    to the reviewer).
 * A user's own chat uses `advise` instead of `stop`/`inject`: it only reports (the chat shows "the agent may be stuck").
 *
 * Everything takes its clock and model calls as parameters, so tests run with fakes and no real waiting.
 */
import { createHash } from "node:crypto";
import { HEAVY_STEP_CHARS } from "./usage-log.js";

/** Why a run is stopped: no progress, the same step again and again, the request budget, or the safety ceiling. */
export type StopReason = "stall" | "repeat" | "budget" | "ceiling";

/** What makes a rescue or an advice: a hard rule, or the watchdog's verdict. */
export type Worry = StopReason | "stuck" | "off-task";

/** The same step this many times in a row stops the run. */
export const REPEAT_LIMIT = 4;
/** How often the watchdog looks (ms). */
export const LOOK_EVERY_MS = 3 * 60_000;
/** The step lines kept for the rescue and the watchdog. */
const KEEP_LINES = 40;

/** The safety ceiling never goes below this many minutes (older saved settings still say 15). */
export const SAFETY_FLOOR_MINUTES = 120;

/**
 * The limits for one task: the stall window and request budget from the settings, and the safety ceiling as the longest
 * of the task's own minutes, the setting and {@link SAFETY_FLOOR_MINUTES}.
 *
 * @param task - The task's `maxMinutes`.
 * @param s - The settings (`maxMinutes`, `stallMinutes`, `maxRequests`; each may be unset).
 */
export function limitsFor(task: number, s: { maxMinutes?: number; stallMinutes?: number; maxRequests?: number }): WatchLimits & { stallMinutes: number; ceilingMinutes: number } {
  const stallMinutes = Math.max(1, s.stallMinutes ?? 10);
  const ceilingMinutes = Math.max(task || 0, s.maxMinutes ?? 0, SAFETY_FLOOR_MINUTES);
  return { stallMs: stallMinutes * 60_000, maxRequests: Math.max(1, s.maxRequests ?? 80), ceilingMs: ceilingMinutes * 60_000, stallMinutes, ceilingMinutes };
}

/** One step the agent took (a tool call). */
export interface AgentStep {
  tool: string;
  /** The arguments (any shape; compared by hash, shown briefly). */
  args?: unknown;
  /** The error it ended with, if any. */
  error?: string;
}

/** What the worktree looks like now: a hash of its changes and the changed paths. */
export interface WorkProbe {
  fp: string;
  files: string[];
}

/** The numbers of a watch. */
export interface WatchLimits {
  /** No progress for this long stops the run. */
  stallMs: number;
  /** The most steps (requests) one run may take. */
  maxRequests: number;
  /** The safety ceiling for the whole run. */
  ceilingMs: number;
}

/**
 * A stable key for a step: the tool and a short hash of its arguments (same tool + same arguments = same key).
 *
 * @param tool - The tool's name.
 * @param args - Its arguments.
 */
export function stepKey(tool: string, args?: unknown): string {
  const text = typeof args === "string" ? args : JSON.stringify(args ?? null, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : v)) ?? "";
  return `${tool}:${createHash("sha1").update(text).digest("hex").slice(0, 10)}`;
}

/** A step as one short line for a model to read. */
export function stepLine(s: AgentStep): string {
  const a = typeof s.args === "string" ? s.args : s.args === undefined ? "" : JSON.stringify(s.args);
  return `${s.tool}${a ? ` ${a.replace(/\s+/g, " ").slice(0, 120)}` : ""}${s.error ? ` ERROR: ${s.error.replace(/\s+/g, " ").slice(0, 120)}` : ""}`;
}

/** The English note for a stop (shown on the task). */
export function stopNote(reason: StopReason, o: { stallMinutes: number; maxRequests: number; ceilingMinutes: number }): string {
  switch (reason) {
    case "stall":
      return `Stopped: no progress for ${o.stallMinutes} minutes.`;
    case "repeat":
      return `Stopped: the same step repeated ${REPEAT_LIMIT} times.`;
    case "budget":
      return `Stopped at the request budget (${o.maxRequests}).`;
    case "ceiling":
      return `Stopped at the ${o.ceilingMinutes}-minute safety limit.`;
  }
}

/** The hard rules: counts steps, tells progress from no progress, and says when a limit is reached. */
export class RunWatch {
  /** Steps taken so far (every one is a request). */
  requests = 0;
  /** A rescue was already used. */
  rescued = false;
  private readonly start: number;
  private lastProgress: number;
  /** The worktree fingerprint at the first look (not progress by itself); undefined before it. */
  private fp: string | undefined;
  private files: string[] = [];
  private prevKey: string | undefined;
  private streak = 0;
  private lines: string[] = [];
  private unseen: string[] = [];

  /**
   * @param limits - The numbers.
   * @param now - The clock.
   * @param probe - Reads the worktree (a changed file counts as progress); absent: only steps count.
   */
  constructor(readonly limits: WatchLimits, private readonly now: () => number, private readonly probe?: () => Promise<WorkProbe>) {
    this.start = now();
    this.lastProgress = this.start;
  }

  /**
   * Records one step. A step that is not a repeat of the one before counts as progress.
   *
   * @returns `budget` or `repeat` when this step reached that limit.
   */
  step(s: AgentStep): StopReason | undefined {
    this.requests++;
    const key = stepKey(s.tool, s.args);
    if (key === this.prevKey) this.streak++;
    else {
      this.streak = 1;
      this.lastProgress = this.now();
    }
    this.prevKey = key;
    const line = stepLine(s);
    this.lines = [...this.lines, line].slice(-KEEP_LINES);
    this.unseen = [...this.unseen, line].slice(-KEEP_LINES);
    if (this.requests >= this.limits.maxRequests) return "budget";
    if (this.streak >= REPEAT_LIMIT) return "repeat";
    return undefined;
  }

  /**
   * Looks at the clock and the worktree.
   *
   * @returns `ceiling` or `stall` when that limit is reached.
   */
  async check(): Promise<StopReason | undefined> {
    const now = this.now();
    if (now - this.start >= this.limits.ceilingMs) return "ceiling";
    if (this.probe) {
      const p = await this.probe().catch(() => undefined);
      if (p) {
        if (this.fp !== undefined && p.fp !== this.fp) this.lastProgress = this.now();
        this.fp = p.fp;
        this.files = p.files;
      }
    }
    return this.now() - this.lastProgress >= this.limits.stallMs ? "stall" : undefined;
  }

  /** The rescue was given: one more window, and the repeat count starts again. */
  rescue(): void {
    this.rescued = true;
    this.lastProgress = this.now();
    this.streak = 0;
    this.prevKey = undefined;
  }

  /** The last `n` step lines (for the rescue prompt). */
  recent(n = 10): string[] {
    return this.lines.slice(-n);
  }

  /** The step lines since the last call (for the watchdog), and the paths changed now. */
  sinceLastLook(): { steps: string[]; files: string[] } {
    const steps = this.unseen;
    this.unseen = [];
    return { steps, files: this.files };
  }
}

/** The watchdog's answer. */
export interface WatchVerdict {
  state: "ok" | "stuck" | "off-task";
  why: string;
}

/**
 * Reads the small model's answer: JSON `{state, why}`, possibly inside other text or a code fence.
 *
 * @returns The verdict, or undefined when the answer is not one (a model that rambles counts as `ok`: it never stops a run).
 */
export function parseWatchVerdict(text: string): WatchVerdict | undefined {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return undefined;
  try {
    const j = JSON.parse(m[0]) as { state?: unknown; why?: unknown };
    if (j.state !== "ok" && j.state !== "stuck" && j.state !== "off-task") return undefined;
    return { state: j.state, why: typeof j.why === "string" ? j.why.replace(/\s+/g, " ").slice(0, 200) : "" };
  } catch {
    return undefined;
  }
}

/** The system line and prompt for the watchdog's look. */
export function watchdogPrompt(o: { goal: string; allowedPaths: readonly string[]; steps: readonly string[]; files: readonly string[]; flags?: readonly string[] }): { system: string; prompt: string } {
  return {
    system: 'You watch a coding agent. Answer ONLY with JSON: {"state":"ok"|"stuck"|"off-task","why":"<one short sentence>"}. "stuck": it repeats itself, loops on errors, wastes requests (see the flags) or does nothing useful. "off-task": it works on files or things unrelated to the goal. Otherwise "ok". In "why" say what is wasteful, e.g. "re-reading the same large file each step".',
    prompt: [`Goal: ${o.goal.slice(0, 600)}`, `Allowed paths: ${o.allowedPaths.slice(0, 12).join(", ") || "any"}`, `Files changed now: ${o.files.slice(0, 20).join(", ") || "none"}`, ...(o.flags?.length ? [`Usage flags: ${o.flags.join("; ")}`] : []), "Steps since the last look:", ...o.steps.slice(-25).map((l) => `- ${l}`)].join("\n"),
  };
}

/** The system line and prompt for the rescue (one concrete hint from a different model). */
export function rescuePrompt(o: { goal: string; reason: Worry; steps: readonly string[] }): { system: string; prompt: string } {
  return {
    system: "A coding agent seems stuck. Give ONE concrete hint (at most 3 sentences) that would get it moving: a specific next action, file or fix. No preface.",
    prompt: [`Goal: ${o.goal.slice(0, 800)}`, `Why it looks stuck: ${o.reason}`, "Its last steps:", ...o.steps.slice(-10).map((l) => `- ${l}`)].join("\n"),
  };
}

/** What a guard may do. Without `inject`/`stop` (a user's own chat) it only advises. */
export interface GuardHooks {
  /** Asks a different model for one hint (undefined: none could answer). */
  rescue?: (o: { reason: Worry; steps: string[] }) => Promise<{ hint: string; model: string } | undefined>;
  /** Puts the hint into the running agent as a user message. */
  inject?: (hint: string) => Promise<void>;
  /** The watchdog's look (undefined: no small model available now). */
  look?: (o: { steps: string[]; files: string[]; flags: string[] }) => Promise<WatchVerdict | undefined>;
  /** A usage anomaly the code found (a heavy step, far over the usual requests); the watchdog is told, nothing is stopped. */
  anomaly?: (detail: string) => void;
  /** Ends the run. */
  stop?: (reason: StopReason) => void;
  /** Tells the user the agent may be stuck, with the hint when there is one (a user's chat; nothing is stopped). */
  advise?: (o: { reason: Worry; why: string; hint?: string }) => void;
  /** Writes a line to the task's steps. */
  log: (line: string) => void;
}

/** Joins a {@link RunWatch}, the rescue and the watchdog for one run. Call {@link RunGuard.step} per step and {@link RunGuard.tick} on a timer. */
export class RunGuard {
  /** Set once a stop was ordered. */
  stopped: StopReason | undefined;
  /** What the watchdog saw when it said `off-task` (for the reviewer). */
  offTask: string | undefined;
  private busy = false;
  private lastLook: number;
  private advised = false;
  private flags: string[] = [];
  private overFlagged = false;

  /**
   * @param watch - The hard rules.
   * @param hooks - What the guard may do.
   * @param now - The clock.
   * @param lookEveryMs - How often the watchdog looks.
   * @param overBaseline - Says why a request count is far above the usual for this kind of run (usage-log.ts), or undefined.
   */
  constructor(readonly watch: RunWatch, private readonly hooks: GuardHooks, private readonly now: () => number, private readonly lookEveryMs = LOOK_EVERY_MS, private readonly overBaseline?: (requests: number) => string | undefined) {
    this.lastLook = now();
  }

  /** Records one step; a limit reached acts at once. */
  step(s: AgentStep): void {
    if (this.stopped) return;
    const size = (typeof s.args === "string" ? s.args : JSON.stringify(s.args ?? "")).length;
    if (size > HEAVY_STEP_CHARS) this.flag(`Heavy step: ${s.tool} (${size} characters of input)`);
    const r = this.watch.step(s);
    const over = !this.overFlagged ? this.overBaseline?.(this.watch.requests) : undefined;
    if (over) {
      this.overFlagged = true;
      this.flag(`Over the usual: ${over}`);
    }
    if (r) void this.reached(r);
  }

  /** One look at the clock, the worktree and (every few minutes) the watchdog. */
  async tick(): Promise<void> {
    if (this.stopped || this.busy) return;
    const r = await this.watch.check();
    if (r) return this.reached(r);
    if (this.hooks.look && this.now() - this.lastLook >= this.lookEveryMs) {
      this.lastLook = this.now();
      const flags = this.flags;
      this.flags = [];
      const v = await this.hooks.look({ ...this.watch.sinceLastLook(), flags }).catch(() => undefined);
      if (v && v.state !== "ok") {
        this.hooks.log(`Watchdog: ${v.state}${v.why ? ` — ${v.why}` : ""}`);
        if (v.state === "off-task") this.offTask = v.why || "worked on something unrelated";
        await this.help(v.state, v.why);
      }
    }
  }

  private flag(detail: string): void {
    this.flags = [...this.flags, detail].slice(-5);
    this.hooks.anomaly?.(detail);
  }

  private async reached(r: StopReason): Promise<void> {
    if (this.stopped || this.busy) return;
    if ((r === "stall" || r === "repeat") && (await this.help(r, r === "stall" ? "no progress" : "the same step again and again"))) return;
    // A user's chat is never stopped: it is told.
    if (!this.hooks.stop) {
      this.advise(r, r);
      return;
    }
    this.stopped = r;
    this.hooks.stop(r);
  }

  /** One rescue per run (inbox), or one advice (a chat). @returns Whether a hint went to the agent or the user. */
  private async help(reason: Worry, why: string): Promise<boolean> {
    if (this.watch.rescued || this.advised || !this.hooks.rescue || this.busy) return false;
    this.busy = true;
    try {
      const h = await this.hooks.rescue({ reason, steps: this.watch.recent(10) });
      if (this.hooks.inject) {
        if (!h) return false;
        await this.hooks.inject(h.hint);
        this.watch.rescue();
        this.hooks.log(`Rescued by ${h.model}: ${h.hint.split(/\r?\n/)[0]!.slice(0, 160)}`);
        return true;
      }
      this.advise(reason, why, h?.hint);
      return true;
    } catch {
      return false;
    } finally {
      this.busy = false;
    }
  }

  private advise(reason: Worry, why: string, hint?: string): void {
    if (this.advised || !this.hooks.advise) return;
    this.advised = true;
    this.watch.rescue();
    this.hooks.advise({ reason, why, ...(hint ? { hint } : {}) });
  }
}

/** The end reviewer's answer. */
export interface ReviewVerdict {
  verdict: "ok" | "doubtful" | "reject";
  reasons: string[];
}

/**
 * Reads the reviewer's JSON `{verdict, reasons}`.
 *
 * @returns The review, or undefined when the answer is not one.
 */
export function parseReview(text: string): ReviewVerdict | undefined {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return undefined;
  try {
    const j = JSON.parse(m[0]) as { verdict?: unknown; reasons?: unknown };
    if (j.verdict !== "ok" && j.verdict !== "doubtful" && j.verdict !== "reject") return undefined;
    const reasons = Array.isArray(j.reasons) ? j.reasons.map((r) => String(r).replace(/\s+/g, " ").slice(0, 200)).filter(Boolean).slice(0, 5) : [];
    return { verdict: j.verdict, reasons };
  } catch {
    return undefined;
  }
}

/** The system line and prompt for the end reviewer. */
export function reviewPrompt(o: { goal: string; acceptance?: string; allowedPaths: readonly string[]; diff: string; offTask?: string }): { system: string; prompt: string } {
  return {
    system: 'You review a code change against its task. Answer ONLY with JSON: {"verdict":"ok"|"doubtful"|"reject","reasons":["<short>", ...]}. "reject": it does not do the task, breaks something obvious or touches unrelated things. "doubtful": it may be fine but something needs a human look. Otherwise "ok".',
    prompt: [`Goal: ${o.goal.slice(0, 1200)}`, o.acceptance ? `Acceptance: ${o.acceptance.slice(0, 600)}` : "", `Allowed paths: ${o.allowedPaths.slice(0, 20).join(", ") || "any"}`, o.offTask ? `A watcher noted: it worked off-task (${o.offTask}).` : "", "Diff:", o.diff.slice(0, 14_000)].filter(Boolean).join("\n"),
  };
}
