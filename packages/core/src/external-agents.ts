/**
 * Live notifications for outside agents ("Claude helpers"): runs that KesherAI does not run itself, but that the lead
 * Claude registers with `POST /api/agents/external` at a helper's start and end (docs/HELPERS.md). Each run is
 *
 *  - one row in the agent activity (agent-activity.ts; source "claude-chat", shown in the hub's "Claude" curtain),
 *  - one live notification on the phone (the same per-id progress path as an Antigravity task, inbox-progress.ts),
 *  - and its steps come from git: while a run is open, KesherAI fetches `origin main` every minute and every new
 *    commit with a trailer `Helper: <id>` becomes a step of that run (subject and short sha). No model is involved,
 *    so a helper's mid-run updates cost no Claude tokens.
 *
 * Privacy: titles, step subjects and a short result only (all length-limited); never a prompt, a diff or file text.
 */
import { execFile } from "node:child_process";
import type { RunSnapshot } from "./agent-activity.js";
import { MIN_GAP_MS, PROGRESS_EVERY_MS, textBar } from "./inbox-progress.js";

/** What a caller may send. */
export interface ExternalInput {
  id: string;
  title?: string;
  status: "running" | "done" | "failed";
  step?: string;
  steps?: number;
  result?: string;
}

/** One step of a run: what happened, and the commit it came from (when it came from git). */
export interface ExternalStep {
  text: string;
  sha?: string;
  at: number;
}

/** One outside run. */
export interface ExternalRun {
  id: string;
  title: string;
  status: "running" | "done" | "failed";
  steps: ExternalStep[];
  /** How many steps are expected, when the lead said so. */
  of?: number;
  result?: string;
  startedAt: number;
  endedAt?: number;
  /** The last report or commit (an open run with none for {@link STALE_MS} is closed as failed). */
  touchedAt: number;
}

/** What the phone gets (the same fields as inbox-progress.ts's note). */
export interface ExternalNote {
  ref: string;
  title: string;
  body: string;
  progress?: { v: number; max: number };
}

export const EXTERNAL_LIMITS = { title: 120, step: 120, result: 400, steps: 200, runs: 30, id: 40 } as const;
/** An open run nobody reported on or committed for, for this long, is closed as failed. */
export const STALE_MS = 3 * 3_600_000;
/** How often the commit watcher fetches while a run is open. */
export const WATCH_MS = 60_000;
/** A run caught up from git alone that ended longer ago than this gets no notification (only its row). */
export const CATCHUP_NOTE_MS = 12 * 3_600_000;
const CATCHUP_SINCE = "12 hours ago";

/** Text with control characters and line breaks turned into single spaces, trimmed and cut. */
const clean = (v: unknown, max: number): string =>
  String(v ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/**
 * Checks and limits a request body.
 *
 * @param body - The JSON the route received.
 * @returns The clean input, or the reason it is refused.
 */
export function cleanExternalInput(body: unknown): { ok: true; input: ExternalInput } | { ok: false; error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const id = typeof b.id === "string" ? b.id : "";
  if (!/^[\w.-]{1,40}$/.test(id)) return { ok: false, error: "id is needed: letters, digits, . _ - (at most 40)." };
  if (b.status !== "running" && b.status !== "done" && b.status !== "failed") return { ok: false, error: "status is running, done or failed." };
  if (b.title !== undefined && typeof b.title !== "string") return { ok: false, error: "title is text." };
  if (b.step !== undefined && typeof b.step !== "string") return { ok: false, error: "step is text." };
  if (b.result !== undefined && typeof b.result !== "string") return { ok: false, error: "result is text." };
  if (b.steps !== undefined && (!Number.isInteger(b.steps) || (b.steps as number) < 1 || (b.steps as number) > EXTERNAL_LIMITS.steps)) return { ok: false, error: `steps is a whole number from 1 to ${EXTERNAL_LIMITS.steps}.` };
  const title = clean(b.title, EXTERNAL_LIMITS.title);
  const step = clean(b.step, EXTERNAL_LIMITS.step);
  const result = clean(b.result, EXTERNAL_LIMITS.result);
  return { ok: true, input: { id, status: b.status, ...(title ? { title } : {}), ...(step ? { step } : {}), ...(typeof b.steps === "number" ? { steps: b.steps } : {}), ...(result ? { result } : {}) } };
}

/**
 * The helper id in a commit message's trailer (`Helper: <id>`, the last one wins), or undefined.
 *
 * @param message - The full commit message.
 */
export function parseHelperTrailer(message: string): string | undefined {
  let id: string | undefined;
  for (const m of message.matchAll(/^Helper:[ \t]*([\w.-]{1,40})[ \t]*$/gim)) id = m[1];
  return id;
}

/** The notification's id for a run. */
export const externalRef = (id: string): string => `claude-${id}`;

const mins = (ms: number): number => Math.max(0, Math.floor(ms / 60_000));

/**
 * The phone notification of a run: "Claude: <title>", the latest step, the steps so far and the time; once it ended, a
 * summary with the result.
 *
 * @param r - The run.
 * @param now - The time.
 */
export function externalNote(r: ExternalRun, now: number): ExternalNote {
  const title = `Claude: ${r.title}`;
  const took = mins((r.endedAt ?? now) - r.startedAt);
  const n = r.steps.length;
  if (r.status !== "running") {
    const head = r.status === "done" ? "✓ הסתיים · Done" : "✕ נכשל · Failed";
    return { ref: externalRef(r.id), title, body: [head, ...(r.result ? [r.result] : []), `${n} צעדים · ${took} דק'`].join("\n") };
  }
  const last = r.steps.at(-1)?.text;
  const bar = `${textBar(r.of ? Math.min(1, n / r.of) : 0)} ${n}${r.of ? `/${r.of}` : ""} · ${took} דק'`;
  return {
    ref: externalRef(r.id),
    title,
    body: [bar, ...(last ? [`שלב: ${last}`] : []), "▶ רץ · Running", r.of ? `${n} בוצעו · ${Math.max(0, r.of - n)} נותרו` : `${n} צעדים עד עכשיו`].join("\n"),
    progress: { v: r.of ? Math.min(n, r.of) : n, max: r.of ?? 0 },
  };
}

/** The run as an activity snapshot (the hub page and Google Drive "last seen" read it). */
export function externalSnapshot(r: ExternalRun): RunSnapshot {
  const last = r.steps.at(-1)?.text;
  return {
    runId: `ext-${r.id}`,
    source: "claude-chat",
    title: `Claude: ${r.title}`,
    state: r.status === "running" ? "running" : r.status,
    step: r.steps.length,
    ...(r.of ? { of: r.of } : {}),
    ...(last ? { label: last } : {}),
    startedAt: r.startedAt,
    ...(r.endedAt ? { endedAt: r.endedAt } : {}),
    ...(r.status === "failed" ? { failReason: r.result ?? "Failed" } : {}),
  };
}

/** Runs `git` with an argument list in a folder (fetch and log only). */
export type GitRun = (args: string[]) => Promise<string>;

/**
 * A {@link GitRun} for a folder: no prompts, 30 seconds at most.
 *
 * @param cwd - The git project.
 */
export function gitIn(cwd: string): GitRun {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile("git", args, { cwd, timeout: 30_000, maxBuffer: 4_000_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, out) => (err ? reject(err) : resolve(String(out))));
    });
}

/** What the registry needs from the app. */
export interface ExternalAgentsOptions {
  /** Reports a run's state to the agent activity (hub page, Drive). */
  observe: (s: RunSnapshot) => void;
  /** Sends a note to the phone app only (one notification per `ref`, each replacing the last). */
  phone: (n: ExternalNote) => void;
  /** The git runner for the watched project, or undefined when none is set (then there are no commit steps). */
  git: () => GitRun | undefined;
  /** Remembers the last origin/main commit looked at, across restarts (so a catch-up starts where it stopped). */
  store?: { load: () => Promise<string | undefined>; save: (sha: string) => void };
  now?: () => number;
  /** Timers off (tests call {@link ExternalAgents.tick} and {@link ExternalAgents.watch}). */
  manual?: boolean;
}

/** The registry of outside runs, their phone notes and the commit watcher. One instance per app. */
export class ExternalAgents {
  private readonly runs = new Map<string, ExternalRun>();
  private readonly lastSent = new Map<string, { at: number; key: string }>();
  private readonly seen = new Set<string>();
  private readonly now: () => number;
  private timer?: ReturnType<typeof setInterval>;
  private watchTimer?: ReturnType<typeof setInterval>;
  /** The origin/main commit the next log starts after. */
  private base?: string;
  private watching = false;

  /** @param o - Where the states and notes go, and the git runner. */
  constructor(private readonly o: ExternalAgentsOptions) {
    this.now = o.now ?? Date.now;
  }

  /** @returns The runs, newest first (tests and the app). */
  list(): ExternalRun[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Stops the timers (the app is closing). */
  close(): void {
    clearInterval(this.timer);
    clearInterval(this.watchTimer);
    this.timer = this.watchTimer = undefined;
  }

  /**
   * Registers or updates a run (the route's work).
   *
   * @param input - The checked body ({@link cleanExternalInput}).
   * @returns The run as it is now.
   */
  report(input: ExternalInput): ExternalRun {
    const t = this.now();
    let r = this.runs.get(input.id);
    // A new start (or a run that ended and starts again) opens a fresh run.
    if (!r || (r.status !== "running" && input.status === "running")) {
      r = { id: input.id, title: input.title || r?.title || input.id, status: "running", steps: [], startedAt: t, touchedAt: t };
      this.runs.set(r.id, r);
      this.trim();
    }
    if (input.title) r.title = input.title;
    if (input.steps) r.of = input.steps;
    if (input.step) this.addStep(r, { text: input.step, at: t });
    r.touchedAt = t;
    if (input.status !== "running") this.end(r, input.status, input.result);
    else if (input.result) r.result = input.result;
    this.publish(r, true);
    this.arm();
    if (r.status === "running" && !this.base && !this.o.manual) void this.prime();
    return r;
  }

  /** A step from a commit (or the lead), with the limits. */
  private addStep(r: ExternalRun, s: ExternalStep): void {
    if (r.status !== "running") return;
    if (s.sha && r.steps.some((x) => x.sha === s.sha)) return;
    r.steps.push({ ...s, text: clean(s.text, EXTERNAL_LIMITS.step) });
    if (r.steps.length > EXTERNAL_LIMITS.steps) r.steps.shift();
    r.touchedAt = this.now();
  }

  private end(r: ExternalRun, status: "done" | "failed", result?: string): void {
    r.status = status;
    r.endedAt = this.now();
    if (result) r.result = result;
  }

  /** Keeps at most {@link EXTERNAL_LIMITS.runs} runs; the oldest ended ones go first. */
  private trim(): void {
    while (this.runs.size > EXTERNAL_LIMITS.runs) {
      const old = [...this.runs.values()].filter((x) => x.status !== "running").sort((a, b) => a.startedAt - b.startedAt)[0] ?? [...this.runs.values()][0]!;
      this.runs.delete(old.id);
      this.lastSent.delete(old.id);
    }
  }

  /**
   * Sends the run's state to the activity and its note to the phone: at once when `force` or the step changed
   * (at most one per 3 s), otherwise only on the 20 s tick.
   */
  private publish(r: ExternalRun, force = false): void {
    this.o.observe(externalSnapshot(r));
    const note = externalNote(r, this.now());
    const key = `${r.status}|${r.steps.length}|${r.steps.at(-1)?.text ?? ""}`;
    const prev = this.lastSent.get(r.id);
    const t = this.now();
    const ended = r.status !== "running";
    if (!force && !ended && prev && t - prev.at < (key !== prev.key ? MIN_GAP_MS : PROGRESS_EVERY_MS - 500)) return;
    this.lastSent.set(r.id, { at: t, key });
    this.o.phone(note);
  }

  /** The timers run while a run is open (and stop when none is). */
  private arm(): void {
    const open = [...this.runs.values()].some((r) => r.status === "running");
    if (!open) return this.close();
    if (this.o.manual || this.timer) return;
    this.timer = setInterval(() => this.tick(), PROGRESS_EVERY_MS);
    this.watchTimer = setInterval(() => void this.watch(), WATCH_MS);
    this.timer.unref?.();
    this.watchTimer.unref?.();
  }

  /** Every 20 seconds: closes silent runs and refreshes the elapsed time of the open ones. */
  tick(): void {
    const t = this.now();
    for (const r of this.runs.values()) {
      if (r.status !== "running") continue;
      if (t - r.touchedAt > STALE_MS) {
        this.end(r, "failed", "No report for 3 hours");
        this.publish(r, true);
      } else this.publish(r);
    }
    this.arm();
  }

  /**
   * One round of the commit watcher: `git fetch origin main`, then `git log` of what came after the last one seen;
   * each commit with a `Helper: <id>` trailer of an open run becomes a step of it, and commits of an id no run knows
   * (KesherAI was off when the lead started it) become a finished run ({@link fromLog}). Errors are ignored (offline).
   * KesherAI never sends anything about a run back to Claude: this only reads git.
   *
   * @param always - Also without an open run (the catch-up when the app starts).
   * @returns How many steps were added.
   */
  async watch(always = false): Promise<number> {
    const git = this.o.git();
    const open = [...this.runs.values()].some((r) => r.status === "running");
    if (!git || (!open && !always) || this.watching) return 0;
    this.watching = true;
    try {
      if (!this.base && this.o.store) this.base = (await this.o.store.load().catch(() => undefined)) || undefined;
      await git(["fetch", "--quiet", "origin", "main"]).catch(() => undefined);
      const head = (await git(["rev-parse", "origin/main"])).trim();
      if (!/^[0-9a-f]{40}$/.test(head)) return 0;
      const from = this.base;
      this.base = head;
      if (from !== head) this.o.store?.save(head);
      if (from === head) return 0;
      // With no earlier look, only a catch-up reads back (12 hours); an open run's first round just learns the head.
      if (!from && !always) return 0;
      const range = from ? [`${from}..${head}`] : ["--since", CATCHUP_SINCE, head];
      const log = await git(["log", "--reverse", "--max-count=300", "--format=%H%x1f%ct%x1f%B%x1e", ...range]).catch(() => "");
      return this.fromLog(log);
    } catch {
      return 0;
    } finally {
      this.watching = false;
    }
  }

  /**
   * Adds the steps for the commits of a `git log --format=%H%x1f%ct%x1f%B%x1e` listing (oldest first). Commits of an
   * open run are steps of it; commits of an id with no run make one finished run per id, with a single summary note
   * (none when it ended more than 12 hours ago).
   *
   * @param log - The listing.
   * @returns How many steps were added.
   */
  fromLog(log: string): number {
    let added = 0;
    const unknown = new Map<string, ExternalStep[]>();
    for (const entry of log.split("\x1e")) {
      const [sha, ct, ...rest] = entry.trim().split("\x1f");
      const message = rest.join("\x1f");
      if (!sha || !/^[0-9a-f]{40}$/.test(sha) || this.seen.has(sha)) continue;
      const id = parseHelperTrailer(message);
      if (!id) continue;
      const r = this.runs.get(id);
      if (r && r.status !== "running") continue;
      this.seen.add(sha);
      if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value!);
      const step = { text: clean(message.split("\n")[0], EXTERNAL_LIMITS.step), sha: sha.slice(0, 8), at: Number(ct) * 1000 || this.now() };
      if (r) {
        this.addStep(r, step);
        this.publish(r);
      } else unknown.set(id, [...(unknown.get(id) ?? []), step]);
      added++;
    }
    for (const [id, steps] of unknown) this.caughtUp(id, steps);
    return added;
  }

  /** A run nobody reported (KesherAI was off): finished, from its commits alone. */
  private caughtUp(id: string, steps: ExternalStep[]): void {
    const kept = steps.slice(-EXTERNAL_LIMITS.steps);
    const endedAt = kept.at(-1)!.at;
    const r: ExternalRun = { id, title: id, status: "done", steps: kept, result: `${steps.length} commits (caught up from git)`, startedAt: kept[0]!.at, endedAt, touchedAt: endedAt };
    this.runs.set(id, r);
    this.trim();
    if (this.now() - endedAt < CATCHUP_NOTE_MS) this.o.phone(externalNote(r, this.now()));
  }

  /** Learns where origin/main is when the first run opens, so the commits of the run are the ones after it. */
  async prime(): Promise<void> {
    await this.watch();
  }

  /** At the app's start: runs the lead could not report (KesherAI was off) are found from git alone. */
  async catchUp(): Promise<number> {
    return this.watch(true);
  }
}
