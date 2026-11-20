import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { AgentLabel, AgentMessage, HelperKind, HelperPlanRef, HelperRunInfo, HelperUsage } from "@kesher/shared";

/**
 * The helper runs of every chat (docs/RESEARCH_LOG.md, "Helper agents in the chat", plan steps 3, 5 and 6): a queue
 * with a limit, a time cap and a step count per run, stop for one or for all of a chat's, and the short report of
 * each. Local helpers share the graphics card, so at most `limit()` of them run at once (the rest wait, in order);
 * cloud and outside helpers do not use the card and are capped at 4 apart.
 *
 * Events: `change` (chatId) whenever a run of that chat changed, `end` (the run's info) when one ended, `ask` (the
 * run's info) when one starts waiting for the user, `answered` (the run's info) when that wait ends, `save` (chatId)
 * when a run's transcript grew (helper-store.ts writes `change` and `save` to disk, so runs survive a restart).
 *
 * Steer and continue (docs/RESEARCH_LOG.md, "Gap list: agents and chat-first", A5 and A6; like Claude Code's
 * subagents and ChatGPT agent's "interrupt and redirect"): `message` hands a running helper a note at its next model
 * turn (queued while a tool runs, or while it waits to start), and `continueRun` starts an ended one again from its
 * kept conversation with a follow-up, on the same model and role, its token totals going on.
 */

/** What a running helper may do with its own run. */
export interface HelperControl {
  /** The run's id (an approval card in the chat names it). */
  id: string;
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
  update(p: Partial<Pick<HelperRunInfo, "model" | "modelNote" | "modelNoteHe" | "swap" | "cloudFiles" | "cloud" | "runAsk" | "approval" | "tests">>): void;
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
  /** Its conversation from before a restart or before it ended (it continues from there), absent on a fresh run. */
  resumed?: AgentMessage[];
  /** A continued run's follow-up: sent as its next message after `resumed` (instead of the restart note). */
  followUp?: string;
  /**
   * Where notes the user or the lead send while it runs go (its session's next turn); notes sent before this was set
   * are handed over at once. `undefined` takes it away again (the run is finishing: later notes wait unread).
   */
  notes(sink: ((text: string) => void) | undefined): void;
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
  /** The plan it belongs to (two or more sub-agents for one job, or a deep research). */
  plan?: HelperPlanRef;
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

/**
 * The findings pack: the longest report handed to the chat's model at once (about 1,500 tokens). A longer one is kept
 * whole (the card opens it, and the model reads the rest with helper_result's `from`), so one helper never fills the
 * lead's context.
 */
export const REPORT_CHARS = 6000;

/**
 * Where a long report is cut: at the last line break before the limit when there is one in its last third, so the
 * pack ends with whole lines.
 *
 * @param text - The whole report.
 * @param from - Where this part starts.
 * @returns The end of the part (exclusive).
 */
export function packEnd(text: string, from = 0): number {
  const limit = from + REPORT_CHARS;
  if (text.length <= limit) return text.length;
  const nl = text.lastIndexOf("\n", limit);
  return nl > from + REPORT_CHARS * 0.66 ? nl : limit;
}

/**
 * One part of a long report, for the chat's model.
 *
 * @param text - The whole report.
 * @param id - The run's id (for the "rest" line).
 * @param from - The first character.
 * @returns The part, with where the rest starts when there is more.
 */
export function reportPart(text: string, id: string, from: number): string {
  const start = Math.max(0, Math.min(Math.floor(from) || 0, text.length));
  const end = packEnd(text, start);
  return `${text.slice(start, end)}${end < text.length ? `\n(characters ${start}-${end} of ${text.length}; the rest: helper_result id "${id}" from ${end})` : ""}`;
}
/** Outside helpers and cloud helpers at once. */
const OTHER_LIMIT = 4;
/** Ended runs kept per chat. */
const KEEP_ENDED = 20;
/** Ended runs per chat that keep their conversation, so they can be continued (the newest ones). */
const KEEP_TRANSCRIPTS = 5;
/** The longest note or follow-up (characters). */
export const NOTE_CHARS = 2000;

/** Who sent a note or a follow-up: the user (card, phone sheet) or the lead model (its tools). */
export type NoteFrom = "user" | "lead";

/**
 * What the helper's model reads for a note sent while it works.
 *
 * @param text - The note.
 * @param from - Who sent it.
 */
export function noteText(text: string, from: NoteFrom): string {
  return `${from === "user" ? "A note from the user" : "A note from the assistant that started you"} while you work (it changes or adds to your task; follow it, and say in your report what you did about it):\n${text}`;
}

/**
 * What the helper's model reads when it is continued after it ended.
 *
 * @param text - The follow-up.
 * @param from - Who sent it.
 */
export function followUpText(text: string, from: NoteFrom): string {
  return `${from === "user" ? "The user" : "The assistant that started you"} continues your task with this follow-up. Your earlier work and report are above; go on from them (do not redo what is done) and finish with a new short report:\n${text}`;
}

interface Run {
  info: HelperRunInfo;
  job: HelperJob;
  chatId: string;
  abort: AbortController;
  /** Why it was aborted: the user, the chat's Stop, or the time cap. */
  why?: "stop" | "time";
  full?: string;
  /** A build helper's whole diff, when the card's `info.diff` is shortened (kept in memory only). */
  fullDiff?: string;
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
  /** Notes sent before it could take them (waiting, or between its steps before its session started). */
  notes: string[];
  /** Hands a note to its running session. */
  noteSink?: (text: string) => void;
  /** A continued run's follow-up, handed to its work at its next start. */
  followUp?: string;
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
  /** Notes sent to it that it had not read yet. */
  notes?: string[];
  /** A build run's whole diff, read back from its own file by the store (never part of the chat's JSON file). */
  fullDiff?: string;
}

/** The queue and the runs. */
export class HelperRuns extends EventEmitter {
  private readonly runs = new Map<string, Run>();
  private readonly now: () => number;
  /** The owner's name and note of a run (agent-labels.ts), merged into what the screens get; set by the app. */
  labelOf?: (id: string) => AgentLabel | undefined;

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
      info: { id, kind: job.kind, title: job.title.replace(/\s+/g, " ").trim().slice(0, 120), model: job.model, state: "waiting", queuedAt: this.now(), step: 0, maxSteps: job.maxSteps, steps: [], background: job.background, ...(job.agent ? { agent: job.agent } : {}), ...(job.callId ? { callId: job.callId } : {}), ...(job.modelNote ? { modelNote: job.modelNote } : {}), ...(job.modelNoteHe ? { modelNoteHe: job.modelNoteHe } : {}), ...(job.cloud ? { cloud: true } : {}), ...(job.plan ? { plan: { ...job.plan } } : {}) },
      job,
      chatId: job.chatId,
      abort: new AbortController(),
      ended,
      end,
      notes: [],
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
      .map((r) => this.toSaved(r));
  }

  /**
   * The whole diffs of the chat's build runs that are longer than their card copy (the store keeps them in files).
   *
   * @param chatId - The chat.
   * @returns Run id to whole diff.
   */
  fullDiffs(chatId: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const r of this.runs.values()) if (r.chatId === chatId && r.fullDiff) out.set(r.info.id, r.fullDiff);
    return out;
  }

  /** One run as it is saved (and as a continue builds its work again from). */
  private toSaved(r: Run): SavedHelperRun {
    const info: HelperRunInfo = { ...r.info, ...(r.full ? { report: r.full, cut: false } : {}) };
    delete info.canContinue;
    return {
      chatId: r.chatId,
      info,
      local: r.job.local,
      timeMs: r.job.timeMs,
      ...(r.delivered ? { delivered: true } : {}),
      ...(r.job.resume ? { resume: r.job.resume } : {}),
      // A going run's conversation (for a restart), and an ended one's that can still be continued.
      ...(r.transcript ? { transcript: r.transcript } : {}),
      ...(this.going(r) && r.notes.length ? { notes: r.notes } : {}),
    };
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
      delete info.canContinue;
      const job: HelperJob = { chatId: s.chatId, kind: info.kind, title: info.title, background: info.background, maxSteps: info.maxSteps, timeMs: s.timeMs, local: s.local, model: info.model, ...(s.resume ? { resume: s.resume } : {}), run: async () => Promise.reject(new Error("Not resumed yet.")) };
      const run: Run = { info, job, chatId: s.chatId, abort: new AbortController(), ended, end, notes: [...(s.notes ?? [])], ...(s.delivered ? { delivered: true } : {}), ...(s.transcript ? { transcript: s.transcript } : {}), ...(s.fullDiff ? { fullDiff: s.fullDiff } : {}) };
      this.setReport(run, info.report ?? "");
      if (!info.report) delete info.report;
      this.runs.set(info.id, run);
      if (!this.going(run)) {
        end({ ...info });
        continue;
      }
      // Its model's state (a swap, a model beside the chat's) is gone with the restart.
      delete info.swap;
      // A part the chat's model waited for ended with its turn; a background one goes on.
      if (s.resume && info.background) {
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
    return [...this.runs.values()].filter((r) => r.chatId === chatId).map((r) => this.view(r));
  }

  /** @returns One run, with its whole report (`full`) when the card's is cut. */
  get(id: string): (HelperRunInfo & { chatId: string; full?: string }) | undefined {
    const r = this.runs.get(id);
    return r ? { ...this.view(r), chatId: r.chatId, ...(r.full ? { full: r.full } : {}) } : undefined;
  }

  /** A run's info for the screen and the model, with whether it can be continued and the owner's label. */
  private view(r: Run): HelperRunInfo {
    const l = this.labelOf?.(r.info.id);
    return { ...r.info, ...(this.continuable(r) ? { canContinue: true } : {}), ...(l?.name ? { name: l.name } : {}), ...(l?.note ? { note: l.note } : {}), ...(l?.at ? { labelAt: l.at } : {}) };
  }

  /**
   * Tells the screens a run changed without a change of its own (its name or note was set).
   *
   * @param id - The run.
   * @returns Whether the run is known.
   */
  touch(id: string): boolean {
    const r = this.runs.get(id);
    if (r) this.changed(r);
    return !!r;
  }

  /** It ended, kept its conversation, and its work can be built again. */
  private continuable(r: Run): boolean {
    return !this.going(r) && !!r.transcript?.length && !!r.job.resume;
  }

  /**
   * Sends a running (or waiting) helper a note: its model reads it at its next turn, after the tool it runs now. The
   * note shows in its steps.
   *
   * @param id - The run.
   * @param text - The note (cut to {@link NOTE_CHARS}).
   * @param from - Who sends it.
   * @returns Whether it was still going (an ended run takes no notes: continue it instead).
   */
  message(id: string, text: string, from: NoteFrom): boolean {
    const r = this.runs.get(id);
    const t = text.trim().slice(0, NOTE_CHARS);
    if (!r || !t || !this.going(r) || r.job.kind === "external") return false;
    const note = noteText(t, from);
    if (r.noteSink) r.noteSink(note);
    else r.notes.push(note);
    this.noteStep(r, "note", from, t);
    return true;
  }

  /**
   * Continues an ended helper with a follow-up: it starts again (in the background, so its report reaches the chat's
   * model as a background helper's does) from its kept conversation, on the same model and role; its step count starts
   * over, its token totals go on.
   *
   * @param id - The run.
   * @param text - The follow-up (cut to {@link NOTE_CHARS}).
   * @param from - Who sends it.
   * @param build - Builds its work again from the run as saved (delegate.ts); undefined when it cannot.
   * @returns Its info (waiting or running), or undefined when it cannot be continued.
   */
  continueRun(id: string, text: string, from: NoteFrom, build: (saved: SavedHelperRun) => HelperJob["run"] | undefined): HelperRunInfo | undefined {
    const r = this.runs.get(id);
    const t = text.trim().slice(0, NOTE_CHARS);
    if (!r || !t || !this.continuable(r)) return undefined;
    const work = build(this.toSaved(r));
    if (!work) return undefined;
    let end!: (i: HelperRunInfo) => void;
    r.ended = new Promise<HelperRunInfo>((res) => (end = res));
    r.end = end;
    r.abort = new AbortController();
    r.why = undefined;
    r.full = undefined;
    r.delivered = false;
    r.held = false;
    r.notes = [];
    r.followUp = followUpText(t, from);
    r.job = { ...r.job, run: work, background: true };
    const i = r.info;
    for (const k of ["endedAt", "startedAt", "error", "report", "cut", "diff", "review", "waitReason", "waitLimit", "restart", "swap", "runAsk", "approval", "tests"] as const) delete i[k];
    delete r.fullDiff;
    i.state = "waiting";
    i.background = true;
    i.queuedAt = this.now();
    i.step = 0;
    i.continued = (i.continued ?? 0) + 1;
    this.noteStep(r, "continue", from, t);
    this.pump();
    if (i.state === "waiting") this.changed(r);
    return this.view(r);
  }

  /** Adds a note or a follow-up to the run's steps (not counted as a step). */
  private noteStep(r: Run, what: "note" | "continue", from: NoteFrom, text: string): void {
    r.info.steps = [...r.info.steps, `${what}(${from}): ${text.replace(/\s+/g, " ").slice(0, 150)}`].slice(-30);
    this.changed(r);
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

  /**
   * Revises a plan: changes its goal, stage or report on every run of it (the Plan card shows the new one).
   *
   * @param chatId - The plan's chat.
   * @param planId - The plan.
   * @param patch - What changes.
   * @param revised - The lead revised it (the goal changed, or a sub-agent was added or removed): `rev` counts up.
   * @returns How many runs belong to the plan (0: no such plan in this chat).
   */
  revisePlan(chatId: string, planId: string, patch: Partial<Omit<HelperPlanRef, "id" | "kind">>, revised = false): number {
    const mine = [...this.runs.values()].filter((r) => r.chatId === chatId && r.info.plan?.id === planId);
    if (!mine.length) return 0;
    const rev = (mine[0]!.info.plan!.rev ?? 0) + (revised ? 1 : 0);
    for (const r of mine) r.info.plan = { ...r.info.plan!, ...patch, ...(rev ? { rev } : {}) };
    this.emit("change", chatId);
    return mine.length;
  }

  /**
   * The plan a chat's runs belong to, as its newest run has it.
   *
   * @returns The plan, or undefined when no run of the chat belongs to it.
   */
  plan(chatId: string, planId: string): HelperPlanRef | undefined {
    for (const r of this.runs.values()) if (r.chatId === chatId && r.info.plan?.id === planId) return { ...r.info.plan };
    return undefined;
  }

  /**
   * Takes a sub-agent off its plan (the lead revised the plan): it stops if it is still going, and the card shows it
   * struck through.
   *
   * @returns Whether it belonged to a plan.
   */
  removeFromPlan(id: string): boolean {
    const r = this.runs.get(id);
    if (!r?.info.plan) return false;
    r.info.removed = true;
    if (!this.stop(id)) this.changed(r);
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

  /** @returns A build run's whole diff (the card's shortened one after a restart), or undefined. */
  diffOf(id: string): string | undefined {
    const r = this.runs.get(id);
    return r ? r.fullDiff ?? r.info.diff : undefined;
  }

  /**
   * Keeps the user's decisions on a build run's hunks (shown on its card, saved with the run).
   *
   * @param id - The run.
   * @param decisions - Per file path, per hunk index: kept or rejected.
   */
  setReview(id: string, decisions: Record<string, Record<number, "accepted" | "rejected">>): void {
    const r = this.runs.get(id);
    if (!r) return;
    const review = (r.info.review ??= {});
    for (const [path, hunks] of Object.entries(decisions)) review[path] = { ...review[path], ...hunks };
    this.changed(r);
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
    const followUp = r.followUp;
    r.followUp = undefined;
    const ctl: HelperControl = {
      id: r.info.id,
      signal: r.abort.signal,
      ...(r.transcript?.length ? { resumed: r.transcript } : {}),
      ...(followUp ? { followUp } : {}),
      notes: (sink) => {
        r.noteSink = sink;
        if (sink) for (const n of r.notes.splice(0)) sink(n);
      },
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
      if (out.diff && out.diff.length > 30_000) r.fullDiff = out.diff.slice(0, 5_000_000);
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
      r.info.report = `${t.slice(0, packEnd(t))}…`;
      r.info.cut = true;
    } else r.info.report = t;
  }

  private finish(r: Run, state: "done" | "failed" | "stopped"): void {
    clearTimeout(r.timer);
    // Stopped while it asked: the question is gone too (its notification is cleared).
    if (r.answer || r.info.state === "asking") this.emit("answered", { ...r.info, chatId: r.chatId });
    r.answer = undefined;
    r.noteSink = undefined;
    r.notes = [];
    // A run whose work can be built again keeps its conversation, so it can be continued with a follow-up.
    if (!r.job.resume) r.transcript = undefined;
    r.info.state = state;
    r.info.endedAt = this.now();
    delete r.info.waitReason;
    delete r.info.approval;
    this.prune(r.chatId);
    this.changed(r);
    this.emit("end", { ...this.view(r), chatId: r.chatId });
    r.end(this.view(r));
    this.pump();
  }

  /** Keeps the newest ended runs of a chat, and the conversations of the newest of those. */
  private prune(chatId: string): void {
    // Oldest end first (a continued run ends again later than runs started after it).
    const ended = [...this.runs.values()].filter((r) => r.chatId === chatId && !this.going(r)).sort((a, b) => (a.info.endedAt ?? 0) - (b.info.endedAt ?? 0));
    const drop = Math.max(0, ended.length - KEEP_ENDED);
    for (const r of ended.slice(0, drop)) this.runs.delete(r.info.id);
    for (const r of ended.slice(drop, Math.max(drop, ended.length - KEEP_TRANSCRIPTS))) r.transcript = undefined;
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
