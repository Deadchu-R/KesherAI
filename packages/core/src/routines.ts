import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Routines: work that runs by itself on a schedule — a pipeline, or a
 * prompt to a model (a new chat each time) — with a notification when it
 * is done. For example: every weekday at 8:00, "summarize my unread mail
 * and today's meetings"; every hour, a pipeline that checks a folder.
 * They run while KesherAI runs (start it with the computer to never miss one).
 */

/** When a routine runs. */
export type Schedule =
  | { kind: "daily"; time: string; days?: number[] }
  | { kind: "every"; minutes: number }
  /** Once each time KesherAI starts, a few minutes after (in the background). */
  | { kind: "startup"; delayMinutes?: number };

/** What it does. */
export type RoutineAction =
  | { type: "pipeline"; pipelineId: string; inputs?: Record<string, string> }
  | {
      type: "prompt";
      prompt: string;
      modelId?: string;
      personaId?: string;
      /** A heartbeat (like OpenClaw's): look, and speak only when something needs the user; otherwise no chat and no notification. */
      quiet?: boolean;
      /** The chat may search the web. */
      web?: boolean;
      /** A folder on this computer the chat may read and write (e.g. a list it keeps up to date). */
      folder?: string;
      /** In the background: starts only when no chat is working, so it never slows the user's own work. */
      background?: boolean;
    }
  /** Self-work on a git project (e.g. every night: "do the open [CoolDown] tasks"), with the same rules as the panel's Start. */
  | { type: "self-work"; repo: string; goal: string; hours: number; check: string; modelId?: string };

/** A saved routine. */
export interface Routine {
  id: string;
  name: string;
  enabled: boolean;
  schedule: Schedule;
  action: RoutineAction;
  notify: boolean;
  /** Also send what it found to the paired Telegram chats (off by default: Telegram is not end-to-end encrypted). */
  telegram?: boolean;
  lastRun?: string;
  lastStatus?: "done" | "error";
  lastMessage?: string;
  /** The chat or pipeline run it made last time. */
  lastLink?: string;
}

/** What routines run on. */
export interface RoutineDeps {
  runPipeline(id: string, inputs: Record<string, string>): Promise<{ ok: boolean; message: string; link: string }>;
  runPrompt(name: string, prompt: string, modelId?: string, personaId?: string, opts?: { web?: boolean; folder?: string }): Promise<{ ok: boolean; message: string; link: string }>;
  /** Starts a self-work run (it goes on by itself; this returns once it started). */
  startSelfWork?(o: { repo: string; goal: string; hours: number; check: string; modelId?: string }): Promise<{ ok: boolean; message: string; link: string }>;
  /** Whether any chat is working now (background routines wait until none is). */
  busy?(): boolean;
  notify(title: string, body: string, path: string): Promise<void>;
  /** Removes the chat a quiet run made when it found nothing. */
  discard?(link: string): Promise<void>;
  /** Sends a message to the paired Telegram chats. */
  telegram?(text: string): Promise<void>;
}

/** What a heartbeat's model is told, after the user's own words. */
export const QUIET_NOTE =
  "\n\nThis is a scheduled check-in. Use your tools to look. If nothing needs the user's attention right now, answer exactly NOTHING and nothing else. Otherwise answer in a few short lines: only what needs them, and what to do.";

/** Whether a quiet run found nothing. */
export const foundNothing = (message: string): boolean => /^\W*nothing\W*$/i.test(message.trim()) || /^nothing\b/i.test(message.trim());

/**
 * The next time a schedule fires after a moment.
 *
 * @param s - The schedule.
 * @param after - From when (ms).
 * @param last - The last run (ms), for "every N minutes".
 * @returns The time in ms.
 */
export function nextRun(s: Schedule, after: number, last?: number, startedAt?: number): number {
  if (s.kind === "startup") {
    // Once per start: a few minutes after KesherAI started, and not again until the next start.
    const at = (startedAt ?? after) + Math.min(120, Math.max(0, s.delayMinutes ?? 3)) * 60_000;
    // Restarts for updates or Terminate are not new days: not again within 6 hours of the last run (found on the
    // PC: 15 restarts in a day ran it 15 times, each a new chat and a notification).
    if (last && startedAt && last >= startedAt) return Infinity;
    return last ? Math.max(after, at, last + 6 * 3_600_000) : Math.max(after, at);
  }
  if (s.kind === "every") {
    const step = Math.max(5, s.minutes) * 60_000;
    return last ? Math.max(after, last + step) : after + step;
  }
  const [h, m] = s.time.split(":").map(Number);
  const d = new Date(after);
  for (let i = 0; i < 8; i++) {
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, h ?? 8, m ?? 0, 0, 0);
    if (t.getTime() > after && (!s.days?.length || s.days.includes(t.getDay()))) return t.getTime();
  }
  return after + 86_400_000;
}

/** Keeps routines and runs them on time. */
export class Routines {
  private list_: Routine[] = [];
  private loaded?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private running = new Set<string>();
  private due = new Map<string, number>();
  private readonly startedAt: number;

  /**
   * @param file - routines.json.
   * @param deps - Pipelines, models and notifications.
   * @param now - The clock (tests move it).
   */
  constructor(
    private readonly file: string,
    private readonly deps: RoutineDeps,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  /** Reads the routines and starts the clock (once). */
  start(): Promise<void> {
    this.loaded ??= readFile(this.file, "utf8")
      .then((t) => void (this.list_ = JSON.parse(t) as Routine[]), () => undefined)
      .then(() => {
        this.plan();
        this.timer = setInterval(() => void this.tick(), 30_000);
        this.timer.unref?.();
      });
    return this.loaded;
  }

  private plan() {
    for (const r of this.list_) this.due.set(r.id, nextRun(r.schedule, this.now(), r.lastRun ? Date.parse(r.lastRun) : undefined, this.startedAt));
  }

  /** @returns The routines with when each runs next. */
  async list(): Promise<Array<Routine & { nextRun: string | null; running: boolean }>> {
    await this.start();
    return this.list_.map((r) => {
      const at = this.due.get(r.id) ?? nextRun(r.schedule, this.now(), undefined, this.startedAt);
      return { ...r, nextRun: r.enabled && Number.isFinite(at) ? new Date(at).toISOString() : null, running: this.running.has(r.id) };
    });
  }

  /**
   * Saves a routine (new when it has no id).
   *
   * @param r - The routine.
   * @returns It, saved.
   */
  async save(r: Partial<Routine> & { name: string; schedule: Schedule; action: RoutineAction }): Promise<Routine> {
    await this.start();
    if (!r.name.trim()) throw new Error("Give the routine a name.");
    if (r.schedule.kind === "daily" && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(r.schedule.time)) throw new Error("The time is like 08:30.");
    if (r.schedule.kind === "every" && !(r.schedule.minutes >= 5)) throw new Error("Every 5 minutes at most often.");
    if (r.action.type === "prompt" && !r.action.prompt.trim()) throw new Error("Write what to ask.");
    if (r.action.type === "pipeline" && !r.action.pipelineId) throw new Error("Choose a pipeline.");
    if (r.action.type === "self-work" && (!r.action.repo || !r.action.goal.trim())) throw new Error("Choose the project and what to work on.");
    if (r.schedule.kind === "startup" && r.schedule.delayMinutes !== undefined && !(r.schedule.delayMinutes >= 0 && r.schedule.delayMinutes <= 120)) throw new Error("Start 0–120 minutes after KesherAI starts.");
    const old = r.id ? this.list_.find((x) => x.id === r.id) : undefined;
    const saved: Routine = { ...(old ?? {}), id: old?.id ?? randomUUID(), name: r.name.trim().slice(0, 80), enabled: r.enabled ?? true, schedule: r.schedule, action: r.action, notify: r.notify ?? true, telegram: r.telegram === true };
    this.list_ = old ? this.list_.map((x) => (x.id === saved.id ? saved : x)) : [...this.list_, saved];
    this.due.set(saved.id, nextRun(saved.schedule, this.now(), saved.lastRun ? Date.parse(saved.lastRun) : undefined, this.startedAt));
    await this.persist();
    return saved;
  }

  /** Deletes a routine. */
  async remove(id: string): Promise<void> {
    await this.start();
    this.list_ = this.list_.filter((r) => r.id !== id);
    this.due.delete(id);
    await this.persist();
  }

  /** Runs what is due. */
  async tick(): Promise<void> {
    const t = this.now();
    // A background routine waits (checked every 30 s) while any chat is working, so it never slows the user's own work.
    const busy = this.deps.busy?.() ?? false;
    const due = this.list_.filter((r) => r.enabled && (this.due.get(r.id) ?? Infinity) <= t && !(busy && r.action.type === "prompt" && r.action.background));
    await Promise.all(due.map((r) => this.runNow(r.id)));
  }

  /**
   * Runs a routine now (the "Run now" button, or when it is due).
   *
   * @param id - The routine.
   */
  async runNow(id: string): Promise<void> {
    const r = this.list_.find((x) => x.id === id);
    if (!r || this.running.has(id)) return;
    this.running.add(id);
    // The next time is planned from now, so a routine that runs long does not start twice.
    this.due.set(id, nextRun(r.schedule, this.now() + 1000, this.now(), this.startedAt));
    try {
      const quiet = r.action.type === "prompt" && r.action.quiet === true;
      const a = r.action;
      const res =
        a.type === "self-work"
          ? await (this.deps.startSelfWork ?? (async () => ({ ok: false, message: "Self-work is not available here.", link: "#/code" })))({ repo: a.repo, goal: a.goal, hours: a.hours, check: a.check, ...(a.modelId ? { modelId: a.modelId } : {}) })
          : a.type === "pipeline" ? await this.deps.runPipeline(a.pipelineId, a.inputs ?? {}) : await this.deps.runPrompt(r.name, a.prompt + (quiet ? QUIET_NOTE : ""), a.modelId, a.personaId, { ...(a.web ? { web: true } : {}), ...(a.folder ? { folder: a.folder } : {}) });
      if (quiet && res.ok && foundNothing(res.message)) {
        // Nothing needs the user: no chat left behind, no notification.
        await this.deps.discard?.(res.link).catch(() => undefined);
        Object.assign(r, { lastRun: new Date(this.now()).toISOString(), lastStatus: "done", lastMessage: "Nothing new.", lastLink: undefined });
        return;
      }
      Object.assign(r, { lastRun: new Date(this.now()).toISOString(), lastStatus: res.ok ? "done" : "error", lastMessage: res.message.slice(0, 300), lastLink: res.link });
      if (r.notify) await this.deps.notify(`${res.ok ? "✓" : "⚠"} ${r.name}`, res.message.slice(0, 300) || (res.ok ? "Done." : "It did not finish."), res.link).catch(() => undefined);
      if (r.telegram && res.ok) await this.deps.telegram?.(`${r.name}\n\n${res.message}`).catch(() => undefined);
    } catch (e) {
      Object.assign(r, { lastRun: new Date(this.now()).toISOString(), lastStatus: "error", lastMessage: (e as Error).message.slice(0, 300) });
      if (r.notify) await this.deps.notify(`⚠ ${r.name}`, (e as Error).message.slice(0, 300), "#/pipelines").catch(() => undefined);
    } finally {
      this.running.delete(id);
      await this.persist().catch(() => undefined);
    }
  }

  private async persist() {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.list_, null, 2));
  }

  /** Stops the clock. */
  close(): void {
    clearInterval(this.timer);
  }
}
