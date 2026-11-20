import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { AgentMessage, HelperKind, HelperRunInfo, HelperUsage } from "@kesher/shared";

/**
 * The helper runs of every chat (docs/RESEARCH_LOG.md, "Helper agents in the chat", plan steps 3, 5 and 6): a queue
 * with a limit, a time cap and a step count per run, stop for one or for all of a chat's, and the short report of
 * each. Local helpers share the graphics card, so at most `limit()` of them run at once (the rest wait, in order);
 * cloud and outside helpers do not use the card and are capped at 4 apart.
 *
 * Events: `change` (chatId) whenever a run of that chat changed, `end` (the run's info) when one ended, `ask` (the
 * run's info) when one starts waiting for the user, `answered` (the run's info) when that wait ends, `save` (chatId)
 * when a run's transcript grew (helper-store.ts writes `change` and `save` to disk, so runs survive a restart).
 */

/** What a running helper may do with its own run. */
export interface HelperControl {
  /** Aborts on Stop, on the chat's Stop and at the time cap. */
  signal: AbortSignal;
  /** One step done (a tool it used): counted, and the last ones are shown. */
  step(text: string): void;
  /**
   * Adds one model call's tokens to the run's total (its session's `usage` event).
   *
   * @param u - The call's prompt and answer tokens, the cached part of the prompt, and whether they were estimated.
   */
  usage(u: { input: number; output: number; cached?: number; estimated?: boolean }): void;
  /** Changes what the card shows (the model after a swap, the swap's phase…). */
  update(p: Partial<Pick<HelperRunInfo, "model" | "modelNote" | "modelNoteHe" | "swap" | "cloudFiles" | "cloud" | "runAsk">>): void;
  /**
   * Waits for something the user answers elsewhere (the Antigravity ask): the card says why, and the time cap waits.
   *
   * @param p - The answer.
   * @param why - What the card shows meanwhile.
   * @returns The answer; rejects when the run is stopped first.
   */
  hold<T>(p: Promise<T>, why: string): Promise<T>;
  /**
   * Asks the user a yes/no question on the card (a cloud helper and the project's files); the time cap waits meanwhile.
   *
   * @returns The answer; false when the run is stopped first.
   */
  ask(question: string): Promise<boolean>;
  /**
   * Keeps the helper's conversation so far (after each of its steps), so it can continue after a restart.
   *
   * @param messages - Its session's messages.
   */
  transcript(messages: AgentMessage[]): void;
  /** Its conversation from before a restart (it continues from there), absent on a fresh run. */
  resumed?: AgentMessage[];
}

/** One job to run. */
export interface HelperJob {
  chatId: string;
  kind: HelperKind;
  title: string;
  agent?: string;
  callId?: string;
  background: boolean;
  maxSteps: number;
  /** The time cap (ms). */
  timeMs: number;
  /** It uses this computer's graphics card (counts against the limit). */
  local: boolean;
  model: string;
  modelNote?: string;
  modelNoteHe?: string;
  cloud?: boolean;
  /**
   * What its owner needs to build `run` again after a restart (JSON only: the task, a named agent, an asked model);
   * absent = it cannot continue after a restart and ends as failed.
   */
  resume?: Record<string, unknown>;
  /**
   * The work itself.
   *
   * @returns Its report, and a build helper's diff.
   */
  run(ctl: HelperControl): Promise<{ report: string; diff?: string }>;
}

/** The longest report kept in the card and handed to the chat's model (about 1,500 tokens). */
export const REPORT_CHARS = 6000;
/** Outside helpers and cloud helpers at once. */
const OTHER_LIMIT = 4;
/** Ended runs kept per chat. */
const KEEP_ENDED = 20;

interface Run {
  info: HelperRunInfo;
  job: HelperJob;
  chatId: string;
  abort: AbortController;
  /** Why it was aborted: the user, the chat's Stop, or the time cap. */
  why?: "stop" | "time";
  full?: string;
  timer?: NodeJS.Timeout;
  answer?: (yes: boolean) => void;
  ended: Promise<HelperRunInfo>;
  end: (i: HelperRunInfo) => void;
  /** The chat's model has its report (by helper_result or helper_wait, or at its next turn). */
  delivered?: boolean;
  /** Its conversation so far (for a restart). */
  transcript?: AgentMessage[];
  /** Paused by a restart: the queue skips it until `resume` gives it its work again. */
  held?: boolean;
}

/** One run as it is saved on disk (helper-store.ts). */
export interface SavedHelperRun {
  chatId: string;
  info: HelperRunInfo;
  local: boolean;
  timeMs: number;
  delivered?: boolean;
  resume?: Record<string, unknown>;
  transcript?: AgentMessage[];
}

/** The queue and the runs. */
export class HelperRuns extends EventEmitter {
  private readonly runs = new Map<string, Run>();
  private readonly now: () => number;

  /**
   * @param o.limit - How many local helpers may run at once now (helperLimit, read each time).
   * @param o.now - The clock (tests).
   */
  constructor(private readonly o: { limit: () => number; now?: () => number }) {
    super();
    this.now = o.now ?? Date.now;
  }

  /**
   * Queues a job and starts it when there is room.
   *
   * @param job - What to run.
   * @returns Its info (state `waiting` or `running`).
   */
  start(job: HelperJob): HelperRunInfo {
    const id = `h-${randomUUID().slice(0, 8)}`;
    let end!: (i: HelperRunInfo) => void;
    const ended = new Promise<HelperRunInfo>((r) => (end = r));
    const run: Run = {
      info: { id, kind: job.kind, title: job.title.replace(/\s+/g, " ").trim().slice(0, 120), model: job.model, state: "waiting", queuedAt: this.now(), step: 0, maxSteps: job.maxSteps, steps: [], background: job.background, ...(job.agent ? { agent: job.agent } : {}), ...(job.callId ? { callId: job.callId } : {}), ...(job.modelNote ? { modelNote: job.modelNote } : {}), ...(job.modelNoteHe ? { modelNoteHe: job.modelNoteHe } : {}), ...(job.cloud ? { cloud: true } : {}) },
      job,
      chatId: job.chatId,
      abort: new AbortController(),
      ended,
      end,
    };
    this.runs.set(id, run);
    this.prune(job.chatId);
    this.pump();
    if (run.info.state === "waiting") this.changed(run);
    return { ...run.info };
  }

  /**
   * The chat's runs as they are saved, so they survive a restart (the whole report, not the card's cut).
   *
   * @param chatId - The chat.
   */
  saved(chatId: string): SavedHelperRun[] {
    return [...this.runs.values()]
      .filter((r) => r.chatId === chatId)
      .map((r) => ({
        chatId: r.chatId,
        info: { ...r.info, ...(r.full ? { report: r.full, cut: false } : {}) },
        local: r.job.local,
        timeMs: r.job.timeMs,
        ...(r.delivered ? { delivered: true } : {}),
        ...(r.job.resume ? { resume: r.job.resume } : {}),
        ...(r.transcript && this.going(r) ? { transcript: r.transcript } : {}),
      }));
  }

  /**
   * Puts runs saved before a restart back. Ended ones come back as they were; ones that were going come back paused
   * ("paused by restart") when they can continue, until `resume` gives them their work, and failed otherwise.
   *
   * @param list - The saved runs (any chat's).
   * @returns The ids of the paused ones.
   */
  restore(list: SavedHelperRun[]): string[] {
    const paused: string[] = [];
    for (const s of list) {
      if (this.runs.has(s.info.id)) continue;
      let end!: (i: HelperRunInfo) => void;
      const ended = new Promise<HelperRunInfo>((r) => (end = r));
      const info: HelperRunInfo = { ...s.info, steps: [...(s.info.steps ?? [])] };
      delete info.runAsk;
      delete info.waitReason;
      const job: HelperJob = { chatId: s.chatId, kind: info.kind, title: info.title, background: info.background, maxSteps: info.maxSteps, timeMs: s.timeMs, local: s.local, model: info.model, ...(s.resume ? { resume: s.resume } : {}), run: async () => Promise.reject(new Error("Not resumed yet.")) };
      const run: Run = { info, job, chatId: s.chatId, abort: new AbortController(), ended, end, ...(s.delivered ? { delivered: true } : {}), ...(s.transcript ? { transcript: s.transcript } : {}) };
      this.setReport(run, info.report ?? "");
      if (!info.report) delete info.report;
      this.runs.set(info.id, run);
      if (!this.going(run)) {
        end({ ...info });
        continue;
      }
      // Its model's state (a swap, a model beside the chat's) is gone with the restart.
      delete info.swap;
      if (s.resume) {
        info.state = "waiting";
        info.restart = "paused";
        run.held = true;
        paused.push(info.id);
      } else {
        info.error = "Stopped by a restart of KesherAI (this kind of helper cannot continue by itself).";
        info.state = "failed";
        info.endedAt = this.now();
        end({ ...info });
      }
    }
    for (const chatId of new Set(list.map((s) => s.chatId))) {
      this.prune(chatId);
      this.emit("change", chatId);
    }
    return paused;
  }

  /**
   * Gives a run paused by a restart its work again, and queues it.
   *
   * @param id - The run.
   * @param run - Its work, built again from its saved `resume`; it gets its saved conversation in `ctl.resumed`.
   * @returns Whether it was paused.
   */
  resume(id: string, run: HelperJob["run"]): boolean {
    const r = this.runs.get(id);
    if (!r?.held || r.info.state !== "waiting") return false;
    r.job = { ...r.job, run };
    r.held = false;
    this.pump();
    return true;
  }

  /** @returns The chat's runs, oldest first. */
  list(chatId: string): HelperRunInfo[] {
    return [...this.runs.values()].filter((r) => r.chatId === chatId).map((r) => ({ ...r.info }));
  }

  /** @returns One run, with its whole report (`full`) when the card's is cut. */
  get(id: string): (HelperRunInfo & { chatId: string; full?: string }) | undefined {
    const r = this.runs.get(id);
    return r ? { ...r.info, chatId: r.chatId, ...(r.full ? { full: r.full } : {}) } : undefined;
  }

  /** @returns How many local helpers run now, and how many wait. */
  counts(): { running: number; waiting: number } {
    const all = [...this.runs.values()];
    return { running: all.filter((r) => r.info.state === "running" || r.info.state === "asking").length, waiting: all.filter((r) => r.info.state === "waiting").length };
  }

  /**
   * Stops one run (a waiting one leaves the queue).
   *
   * @returns Whether it was still going.
   */
  stop(id: string): boolean {
    const r = this.runs.get(id);
    if (!r || !this.going(r)) return false;
    if (r.info.state === "waiting") {
      this.finish(r, "stopped");
      return true;
    }
    r.why ??= "stop";
    r.answer?.(false);
    r.abort.abort();
    return true;
  }

  /** Stops every run of a chat (its Stop button). @returns How many were going. */
  stopAll(chatId: string): number {
    let n = 0;
    for (const r of [...this.runs.values()]) if (r.chatId === chatId && this.stop(r.info.id)) n++;
    return n;
  }

  /**
   * Answers a run's question.
   *
   * @returns Whether it was asking.
   */
  answer(id: string, yes: boolean): boolean {
    const r = this.runs.get(id);
    if (!r?.answer) return false;
    r.answer(yes);
    return true;
  }

  /**
   * Waits for runs to end (the chat's model's helper_wait), marking their reports as handed over.
   *
   * @param ids - The runs.
   * @param signal - The chat's Stop.
   */
  async wait(ids: string[], signal?: AbortSignal): Promise<HelperRunInfo[]> {
    const runs = ids.map((id) => this.runs.get(id)).filter((r): r is Run => !!r);
    const all = Promise.all(runs.map((r) => r.ended));
    const out = signal ? await Promise.race([all, new Promise<never>((_, no) => signal.addEventListener("abort", () => no(new Error("Stopped.")), { once: true }))]) : await all;
    for (const r of runs) r.delivered = true;
    return out;
  }

  /** Marks a run's report as handed to the chat's model (so it is not handed again at its next turn). */
  delivered(id: string): void {
    const r = this.runs.get(id);
    if (r) r.delivered = true;
  }

  /** @returns Whether the run's report still has to reach the chat's model. */
  pending(id: string): boolean {
    const r = this.runs.get(id);
    return !!r && !r.delivered && r.info.background;
  }

  private going(r: Run): boolean {
    return r.info.state === "waiting" || r.info.state === "asking" || r.info.state === "running";
  }

  /** Starts waiting runs while there is room, in order. */
  private pump(): void {
    const all = [...this.runs.values()];
    const active = (local: boolean) => all.filter((r) => r.job.local === local && (r.info.state === "running" || r.info.state === "asking")).length;
    let local = active(true);
    let other = active(false);
    for (const r of all) {
      if (r.info.state !== "waiting" || r.held) continue;
      const limit = r.job.local ? this.o.limit() : OTHER_LIMIT;
      const used = r.job.local ? local : other;
      if (used >= limit) {
        const reason = r.job.local
          ? `${local} sub-agent${local === 1 ? "" : "s"} already running (up to ${limit} at once on this graphics card)`
          : `${other} cloud or outside agents already running (up to ${OTHER_LIMIT} at once)`;
        if (r.info.waitReason !== reason) {
          r.info.waitReason = reason;
          r.info.waitLimit = limit;
          this.changed(r);
        }
        continue;
      }
      if (r.job.local) local++;
      else other++;
      void this.begin(r);
    }
  }

  private armTimer(r: Run): void {
    r.timer = setTimeout(() => {
      r.why ??= "time";
      r.abort.abort();
    }, r.job.timeMs);
  }

  private async begin(r: Run): Promise<void> {
    delete r.info.waitReason;
    delete r.info.waitLimit;
    r.info.state = "running";
    if (r.info.restart === "paused") r.info.restart = "resumed";
    // After a restart it keeps its first start (the card's time counts on from there).
    r.info.startedAt ??= this.now();
    this.armTimer(r);
    this.changed(r);
    const ctl: HelperControl = {
      signal: r.abort.signal,
      ...(r.transcript?.length ? { resumed: r.transcript } : {}),
      transcript: (messages) => {
        r.transcript = messages;
        this.emit("save", r.chatId);
      },
      step: (text) => {
        r.info.step++;
        r.info.steps = [...r.info.steps, text.replace(/\s+/g, " ").trim().slice(0, 160)].slice(-30);
        this.changed(r);
      },
      usage: (u) => {
        r.info.usage = addUsage(r.info.usage, u);
        this.changed(r);
      },
      update: (p) => {
        Object.assign(r.info, p);
        for (const k of Object.keys(p) as Array<keyof typeof p>) if (p[k] === undefined) delete r.info[k];
        this.changed(r);
      },
      hold: async (p, why) => {
        clearTimeout(r.timer);
        r.info.state = "asking";
        r.info.waitReason = why;
        this.changed(r);
        this.emit("ask", { ...r.info, chatId: r.chatId });
        const stopped = new Promise<never>((_, reject) => {
          if (r.abort.signal.aborted) reject(new Error("aborted"));
          r.abort.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        try {
          return await Promise.race([p, stopped]);
        } finally {
          delete r.info.waitReason;
          if (r.info.state === "asking") r.info.state = "running";
          if (!r.abort.signal.aborted) this.armTimer(r);
          this.changed(r);
          this.emit("answered", { ...r.info, chatId: r.chatId });
        }
      },
      ask: (question) => {
        if (r.abort.signal.aborted) return Promise.resolve(false);
        clearTimeout(r.timer);
        r.info.state = "asking";
        r.info.waitReason = question;
        this.changed(r);
        this.emit("ask", { ...r.info, chatId: r.chatId });
        return new Promise<boolean>((done) => {
          r.answer = (yes) => {
            r.answer = undefined;
            delete r.info.waitReason;
            if (r.info.state === "asking") r.info.state = "running";
            if (!r.abort.signal.aborted) this.armTimer(r);
            this.changed(r);
            this.emit("answered", { ...r.info, chatId: r.chatId });
            done(yes);
          };
        });
      },
    };
    try {
      const out = await r.job.run(ctl);
      if (r.abort.signal.aborted) throw new Error("aborted");
      this.setReport(r, out.report);
      if (out.diff) r.info.diff = out.diff.slice(0, 30_000);
      this.finish(r, "done");
    } catch (err) {
      if (r.why === "stop") this.finish(r, "stopped");
      else {
        r.info.error = r.why === "time" ? `Took longer than ${Math.round(r.job.timeMs / 60_000)} min, so it was stopped.` : (err as Error).message;
        this.finish(r, "failed");
      }
    }
  }

  private setReport(r: Run, text: string): void {
    const t = text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
    if (t.length > REPORT_CHARS) {
      r.full = t;
      r.info.report = `${t.slice(0, REPORT_CHARS)}…`;
      r.info.cut = true;
    } else r.info.report = t;
  }

  private finish(r: Run, state: "done" | "failed" | "stopped"): void {
    clearTimeout(r.timer);
    // Stopped while it asked: the question is gone too (its notification is cleared).
    if (r.answer || r.info.state === "asking") this.emit("answered", { ...r.info, chatId: r.chatId });
    r.answer = undefined;
    r.transcript = undefined;
    r.info.state = state;
    r.info.endedAt = this.now();
    delete r.info.waitReason;
    this.changed(r);
    this.emit("end", { ...r.info, chatId: r.chatId });
    r.end({ ...r.info });
    this.pump();
  }

  /** Keeps the newest ended runs of a chat. */
  private prune(chatId: string): void {
    const ended = [...this.runs.values()].filter((r) => r.chatId === chatId && !this.going(r));
    for (const r of ended.slice(0, Math.max(0, ended.length - KEEP_ENDED))) this.runs.delete(r.info.id);
  }

  private changed(r: Run): void {
    this.emit("change", r.chatId);
  }
}

/**
 * Adds one model call's tokens to a run's total.
 *
 * @param total - The total so far (none before the first call).
 * @param u - The call's tokens.
 * @returns The new total (a new object).
 */
export function addUsage(total: HelperUsage | undefined, u: { input: number; output: number; cached?: number; estimated?: boolean }): HelperUsage {
  const n = (v: number | undefined) => (Number.isFinite(v) && v! > 0 ? Math.round(v!) : 0);
  const t = total ?? { input: 0, output: 0, cached: 0, calls: 0, estimated: false };
  return { input: t.input + n(u.input), output: t.output + n(u.output), cached: t.cached + n(u.cached), calls: t.calls + 1, estimated: t.estimated || !!u.estimated };
}
