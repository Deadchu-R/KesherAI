import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isQuotaError, quotaUntil } from "./inbox-runner.js";

/**
 * The local model carries tasks while Claude cools down (WORK_LIST "Local model carries tasks during Claude's weekly
 * cooldown"). When Claude (the Claude path in KesherAI, or Claude's own cloud runs) is out of usage or rate-limited,
 * board tasks marked "local ok" (and inbox tasks with `local_ok: true`, which become such board tasks) are handed to
 * self-work on the local model, a few at a time, one after another; when Claude is back, what was not finished goes
 * back to Claude. Antigravity tasks are never handed (they still need Run on the PC).
 *
 * - Crash-safe: the state is written after every step (write then rename). Self-work resumes its own run after a
 *   restart; a run that is gone gives its unfinished tasks back and the next batch starts.
 * - A daily cap (Settings) on how many tasks the local model takes per day.
 * - A banner ("running on the local model because Claude is cooling down until HH:MM") and a notification.
 *
 * {@link stepHandoff} is the whole decision as a pure function (tested table-driven); {@link CooldownHandoff} reads
 * the board and self-work, runs the decided actions and keeps the file.
 */

/** Why KesherAI thinks Claude is cooling down. */
export interface Cooldown {
  /** When Claude is expected back (ms). */
  until: number;
  since: number;
  /** `manual`: set on the page; `claude`: Claude said so (connector, API); `error`: a Claude chat hit a limit. */
  source: "manual" | "claude" | "error";
  reason?: string;
}

/** A task handed to the local model in this cooldown. */
export interface HandedTask {
  boardId: string;
  /** Set when it came from the task inbox (it is reassigned there too). */
  inboxId?: string;
  title: string;
  at: number;
  /** `working`: with the local model; `done`/`blocked`: as self-work marked it; `returned`: given back to Claude. */
  status: "working" | "done" | "blocked" | "returned";
}

/** What is kept in the file. */
export interface HandoffState {
  cooldown?: Cooldown;
  /** `working`: a self-work run started by the hand-off is going. */
  phase: "idle" | "working";
  handed: HandedTask[];
  /** Tasks taken today (the daily cap), by the local date. */
  today: { date: string; used: number };
  /** Self-work could not start: no new batch before this time (ms), so a broken start is not tried every minute. */
  retryAt?: number;
}

/** A task that may be handed: open, marked local ok, not Claude's claim, not Fable's. */
export interface HandoffCandidate {
  boardId: string;
  inboxId?: string;
  title: string;
  /** An Antigravity task: never handed. */
  antigravity?: boolean;
}

/** What one step sees. */
export interface HandoffInput {
  now: number;
  /** The hand-off is on and has a project to work in (Settings). */
  enabled: boolean;
  /** Tasks per day. */
  cap: number;
  /** Tasks per run (one after another inside it). */
  batch: number;
  candidates: HandoffCandidate[];
  /** The board's status of each handed task (undefined: gone from the board). */
  boardStatus: Record<string, "open" | "claimed" | "done" | "blocked" | undefined>;
  /** Self-work: nothing running, our run going, or another run (the user's own) going. */
  selfWork: "idle" | "ours" | "other";
}

/** One thing the runner does. */
export type HandoffAction =
  | { type: "hand"; tasks: HandedTask[] }
  | { type: "start"; tasks: HandedTask[]; until: number }
  | { type: "giveBack"; tasks: HandedTask[] }
  | { type: "stop" }
  | { type: "notify"; title: string; body: string };

/** The first state. */
export const EMPTY_HANDOFF: HandoffState = { phase: "idle", handed: [], today: { date: "", used: 0 } };

/** The local date (YYYY-MM-DD) of a time, for the daily cap. */
export function localDate(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "18:30" (local time). */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Whether Claude is cooling down now.
 *
 * @param s - The state.
 * @param now - The time now (ms).
 */
export function coolingDown(s: Pick<HandoffState, "cooldown">, now: number): boolean {
  return !!s.cooldown && s.cooldown.until > now;
}

/**
 * The state after a new cooldown signal: an active cooldown is extended (never shortened by a later, shorter
 * guess); a new one starts with an empty hand-off list (tasks still working stay on it).
 *
 * @param s - The state.
 * @param c - Until when, why, and who said so.
 * @param now - The time now (ms).
 */
export function withCooldown(s: HandoffState, c: { until: number; source: Cooldown["source"]; reason?: string }, now: number): HandoffState {
  if (!(c.until > now)) return s;
  if (coolingDown(s, now)) return { ...s, cooldown: { ...s.cooldown!, until: Math.max(s.cooldown!.until, c.until), ...(c.reason ? { reason: c.reason.slice(0, 200) } : {}) } };
  return { ...s, cooldown: { until: c.until, since: now, source: c.source, ...(c.reason ? { reason: c.reason.slice(0, 200) } : {}) }, handed: s.handed.filter((t) => t.status === "working") };
}

/**
 * One step of the hand-off: from what the board and self-work say now, the next state and what to do.
 *
 * | Claude | phase | self-work | does |
 * | --- | --- | --- | --- |
 * | cooling | idle | idle | hand the next batch (within the daily cap), start a run, notify |
 * | cooling | idle | other | wait (the user's own run goes first) |
 * | cooling | working | ours | wait (the run goes one task after another) |
 * | cooling | working | idle/other | give back what is unfinished, then the next batch |
 * | cooling | idle | idle, after a failed start | wait until `retryAt` |
 * | back | working | any | stop our run, give back what is unfinished, notify |
 *
 * @param prev - The state.
 * @param i - What the step sees.
 */
export function stepHandoff(prev: HandoffState, i: HandoffInput): { state: HandoffState; actions: HandoffAction[] } {
  const actions: HandoffAction[] = [];
  const date = localDate(i.now);
  const s: HandoffState = { ...prev, handed: prev.handed.map((t) => ({ ...t })), today: prev.today.date === date ? { ...prev.today } : { date, used: 0 } };
  // What self-work finished, as the board says.
  for (const t of s.handed) {
    if (t.status !== "working") continue;
    const b = i.boardStatus[t.boardId];
    if (b === "done" || b === "blocked") t.status = b;
  }
  const giveBack = () => {
    const back = s.handed.filter((t) => t.status === "working");
    for (const t of back) t.status = "returned";
    if (back.length) actions.push({ type: "giveBack", tasks: back });
    return back;
  };
  const cooling = i.enabled && coolingDown(s, i.now);
  if (!cooling) {
    if (s.cooldown && s.cooldown.until <= i.now) delete s.cooldown;
    if (s.phase === "working") {
      if (i.selfWork === "ours") actions.push({ type: "stop" });
      const back = giveBack();
      const done = s.handed.filter((t) => t.status === "done").length;
      actions.push({ type: "notify", title: "Claude is back", body: `The local model finished ${done} task${done === 1 ? "" : "s"}${back.length ? `; ${back.length} went back to Claude` : ""}.` });
      s.phase = "idle";
    }
    return { state: s, actions };
  }
  if (s.phase === "working") {
    if (i.selfWork === "ours") return { state: s, actions };
    // The run ended (or is gone after a restart): what it did not finish goes back, then the next batch.
    giveBack();
    s.phase = "idle";
  }
  if (i.selfWork !== "idle" || (s.retryAt !== undefined && s.retryAt > i.now)) return { state: s, actions };
  delete s.retryAt;
  const left = Math.max(0, i.cap - s.today.used);
  const seen = new Set(s.handed.map((t) => t.boardId));
  const next = i.candidates.filter((c) => !c.antigravity && !seen.has(c.boardId)).slice(0, Math.min(left, Math.max(1, i.batch)));
  if (!next.length) return { state: s, actions };
  const tasks: HandedTask[] = next.map((c) => ({ boardId: c.boardId, ...(c.inboxId ? { inboxId: c.inboxId } : {}), title: c.title.slice(0, 200), at: i.now, status: "working" }));
  s.handed.push(...tasks);
  s.today.used += tasks.length;
  s.phase = "working";
  const until = s.cooldown!.until;
  actions.push({ type: "hand", tasks }, { type: "start", tasks, until });
  actions.push({ type: "notify", title: "Running on the local model", body: `Claude is cooling down until ${clock(until)}, so the local model took ${tasks.length} task${tasks.length === 1 ? "" : "s"}: ${tasks.map((t) => t.title).join(", ").slice(0, 300)}` });
  return { state: s, actions };
}

/**
 * Self-work's goal for a batch: the handed tasks in order, one after another, ending with ALL DONE.
 *
 * @param tasks - The batch.
 * @param until - When Claude is expected back (ms).
 */
export function handoffGoal(tasks: HandedTask[], until: number): string {
  return [
    `Claude is cooling down until ${clock(until)}, so these board tasks were handed to you (marked {for self-work}). Do them one after another, in this order:`,
    ...tasks.map((t, n) => `${n + 1}. [${t.boardId}] ${t.title}`),
    "Claim each before you start it and mark it done (or blocked, with why) on the board. Take no other tasks. When these are done, that is ALL DONE.",
  ].join("\n");
}

/** Whether a model id is Claude's (the Claude path: Claude Code agent, Anthropic API). */
export function isClaudeModel(modelId: string | undefined): boolean {
  return !!modelId && /^(agent\/claude|anthropic\/|claude[-/])/i.test(modelId);
}

/** Who hears about a Claude chat's errors (the hand-off, once it is running); see {@link reportClaudeError}. */
let errorListener: ((modelId: string | undefined, message: string) => void) | undefined;

/**
 * Lets the hand-off hear chats' errors (one listener; a later call replaces it, undefined removes it).
 *
 * @param fn - Called with the chat's model and the error text.
 */
export function onClaudeError(fn: ((modelId: string | undefined, message: string) => void) | undefined): void {
  errorListener = fn;
}

/**
 * A chat's error, from the conversations' event stream: the hand-off checks whether it is a Claude usage limit.
 *
 * @param modelId - The chat's model.
 * @param message - The error text.
 */
export function reportClaudeError(modelId: string | undefined, message: string): void {
  if (isClaudeModel(modelId)) errorListener?.(modelId, message);
}

/** The hand-off's settings (Settings › Self-work). */
export interface HandoffSettings {
  enabled: boolean;
  /** The git project self-work works in. */
  repo: string;
  check: string;
  dailyCap: number;
  batch: number;
}

/** What the runner needs from KesherAI. */
export interface HandoffDeps {
  /** Where the state is kept. */
  file: string;
  settings(): HandoffSettings;
  /** The board's tasks (id, title, status, owner, category, local ok, for self-work). */
  board(): Promise<Array<{ id: string; title: string; status: "open" | "claimed" | "done" | "blocked"; owner?: string; category?: string; localOk?: boolean; forKesher?: boolean }>>;
  /** The inbox's tasks linked to board items (to skip Antigravity ones and reassign the rest). */
  inbox(): Promise<Array<{ id: string; boardId?: string; runBy: string; status: string }>>;
  /** Self-work now: whether a run is going, and its goal (ours start with the hand-off's first line). */
  selfWork(): Promise<{ running: boolean; goal?: string }>;
  startSelfWork(o: { repo: string; goal: string; hours: number; check: string }): Promise<void>;
  stopSelfWork(): Promise<void>;
  /** Hands a task over (true) or back (false): the board's "for self-work" mark, and the inbox's executor. */
  mark(t: HandedTask, toLocal: boolean): Promise<void>;
  notify(title: string, body: string): Promise<void>;
  now?: () => number;
}

/** How long after a failed start the next batch may be tried. */
const RETRY_MS = 30 * 60_000;

/** The first line of every goal the hand-off gives self-work (how its own runs are told apart from the user's). */
const GOAL_MARK = "Claude is cooling down until";

/**
 * Runs the hand-off: a step every minute and after every signal, one at a time, the state kept in a file.
 */
export class CooldownHandoff {
  private s: HandoffState = { ...EMPTY_HANDOFF };
  private loaded = false;
  private chain: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;

  /** @param d - What the runner needs from KesherAI. */
  constructor(private readonly d: HandoffDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const raw = await readFile(this.d.file, "utf8").catch(() => "");
    try {
      const j = raw ? (JSON.parse(raw) as Partial<HandoffState>) : {};
      this.s = { phase: j.phase === "working" ? "working" : "idle", handed: Array.isArray(j.handed) ? j.handed.slice(-200) : [], today: j.today ?? { date: "", used: 0 }, ...(j.cooldown && Number.isFinite(j.cooldown.until) ? { cooldown: j.cooldown } : {}), ...(Number.isFinite(j.retryAt) ? { retryAt: j.retryAt } : {}) };
    } catch {
      this.s = { ...EMPTY_HANDOFF };
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.d.file), { recursive: true });
    const tmp = `${this.d.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.s, null, 2));
    await rename(tmp, this.d.file);
  }

  /** Runs `fn` after everything before it (steps and signals never overlap). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  /** Starts the minute timer (a step at once too, so a run that was going carries on after a restart). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => undefined), 60_000);
    this.timer.unref?.();
    void this.tick().catch(() => undefined);
  }

  /** Stops the timer (the server closes). */
  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The state for the banner and the page, with the settings it runs by. */
  async view(): Promise<HandoffState & { cooling: boolean; settings: HandoffSettings }> {
    return this.serial(async () => {
      await this.load();
      return { ...this.s, cooling: coolingDown(this.s, this.now()), settings: this.d.settings() };
    });
  }

  /**
   * Claude is cooling down until a time (from the page, Claude itself through the API, or a Claude chat's limit).
   *
   * @param until - When it is expected back (ms).
   * @param source - Who said so.
   * @param reason - Its words, if any.
   */
  async set(until: number, source: Cooldown["source"], reason?: string): Promise<void> {
    await this.serial(async () => {
      await this.load();
      this.s = withCooldown(this.s, { until, source, ...(reason ? { reason } : {}) }, this.now());
      await this.save();
    });
    await this.tick();
  }

  /** Claude is back: unfinished tasks go back to it now. */
  async clear(): Promise<void> {
    await this.serial(async () => {
      await this.load();
      if (this.s.cooldown) this.s.cooldown = { ...this.s.cooldown, until: this.now() };
      await this.save();
    });
    await this.tick();
  }

  /**
   * A Claude chat's error: when it is a usage or rate limit, Claude is cooling down until the time the error says
   * (or an hour when it does not say).
   *
   * @param modelId - The chat's model.
   * @param message - The error.
   * @returns Whether it counted as a limit.
   */
  async noteError(modelId: string | undefined, message: string): Promise<boolean> {
    if (!isClaudeModel(modelId) || !isQuotaError(message)) return false;
    const q = quotaUntil(message, this.now());
    await this.set(q.until, "error", message.slice(0, 200));
    return true;
  }

  /** One step: read the board and self-work, decide, act, keep the state. */
  tick(): Promise<HandoffAction[]> {
    return this.serial(async () => {
      await this.load();
      const set = this.d.settings();
      const now = this.now();
      const enabled = set.enabled && !!set.repo;
      // Nothing to do and nothing to undo: no reads at all (the timer runs every minute).
      if (!(enabled && coolingDown(this.s, now)) && this.s.phase === "idle" && !this.s.cooldown) return [];
      const [board, inbox, sw] = await Promise.all([this.d.board(), this.d.inbox().catch(() => []), this.d.selfWork().catch(() => ({ running: false }) as { running: boolean; goal?: string })]);
      const byBoard = new Map(inbox.filter((t) => t.boardId).map((t) => [t.boardId!, t]));
      const candidates: HandoffCandidate[] = board
        .filter((t) => t.status === "open" && t.localOk && t.category !== "fable")
        .map((t) => {
          const ib = byBoard.get(t.id);
          return { boardId: t.id, title: t.title, ...(ib ? { inboxId: ib.id } : {}), ...(ib?.runBy === "antigravity" ? { antigravity: true } : {}) };
        });
      const boardStatus = Object.fromEntries(board.map((t) => [t.id, t.status]));
      const ours = sw.running && (sw.goal ?? "").startsWith(GOAL_MARK);
      const r = stepHandoff(this.s, { now, enabled, cap: set.dailyCap, batch: set.batch, candidates, boardStatus, selfWork: !sw.running ? "idle" : ours ? "ours" : "other" });
      this.s = r.state;
      // Kept before acting: after a crash mid-way the next step sees the run (or its absence) and goes on from there.
      await this.save();
      // A failed start skips the "running on the local model" notice that follows it.
      let startFailed = false;
      for (const a of r.actions) {
        if (startFailed && a.type === "notify") continue;
        if (a.type === "hand") for (const t of a.tasks) await this.d.mark(t, true).catch(() => undefined);
        else if (a.type === "giveBack") for (const t of a.tasks) await this.d.mark(t, false).catch(() => undefined);
        else if (a.type === "stop") await this.d.stopSelfWork().catch(() => undefined);
        else if (a.type === "notify") await this.d.notify(a.title, a.body).catch(() => undefined);
        else if (a.type === "start") {
          const hours = Math.min(12, Math.max(0.25, (a.until - now) / 3_600_000));
          await this.d.startSelfWork({ repo: set.repo, goal: handoffGoal(a.tasks, a.until), hours: Math.round(hours * 4) / 4, check: set.check }).catch(async (e: Error) => {
            // Could not start (a full disk, no model): the tasks go back at once, the next try is in 30 minutes, and
            // the user is told.
            const ids = new Set(a.tasks.map((t) => t.boardId));
            for (const h of this.s.handed) if (ids.has(h.boardId)) h.status = "returned";
            for (const t of a.tasks) await this.d.mark(t, false).catch(() => undefined);
            this.s.phase = "idle";
            this.s.retryAt = now + RETRY_MS;
            startFailed = true;
            await this.save();
            await this.d.notify("The local model could not start", e.message.slice(0, 300)).catch(() => undefined);
          });
        }
      }
      return r.actions;
    });
  }
}
