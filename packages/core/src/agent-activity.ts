/**
 * Live agent activity for the Kesher Cloud hub (docs/RESEARCH_LOG.md, "Live agent activity in the Kesher Cloud hub",
 * plan step 2). It watches this PC's agents (the chats' helper runs and the task inbox's Antigravity runs), turns each
 * change into small metadata events, and hands the hub client one batch per run every 2 seconds at most, which the
 * client seals to the owner's phones. Claude cloud runs are fired by the hub itself, so the hub page draws those.
 *
 * Coalescing: at most one step event per run per second (a newer step replaces the one not yet sent), file events
 * only when file names are reported (at most 5 per batch; the rest are counted), one batch per run per flush, and a
 * heartbeat batch (no events) every 25 seconds for a going run, so a viewer can tell a frozen run (`stale`).
 *
 * Privacy: events carry titles, tool names, step numbers, relative paths (only with `reportFileNames`) and counts,
 * never a prompt, a file's text, a diff or the model's output; paths pass `cleanAgentPath` (no home, no `..`).
 */
import { cleanAgentPath, HUB_LIMITS, type ActivityEvent, type AgentFile, type AgentRunState, type AgentSource, type AgentWaiting, type HelperRunInfo, type InboxRunAsk, type InboxTaskView } from "@kesher/shared";

/** One run as an adapter sees it now (the activity works out the events from the change). */
export interface RunSnapshot {
  runId: string;
  source: AgentSource;
  title: string;
  model?: string;
  state: AgentRunState["state"];
  step: number;
  of?: number;
  /** The current step's label (a tool name, never its arguments). */
  label?: string;
  startedAt: number;
  endedAt?: number;
  tokensIn?: number;
  tokensOut?: number;
  /** Files touched so far (paths as the agent named them; cleaned here). */
  files?: AgentFile[];
  waiting?: AgentWaiting;
  branch?: string;
  link?: string;
  failReason?: string;
}

/** One run's batch, ready to seal. */
export interface ActivityBatch {
  runId: string;
  state: AgentRunState;
  events: ActivityEvent[];
}

/** What the activity needs from the app. */
export interface AgentActivityOptions {
  /** Hands the batches to the hub client (sealed there to each viewer). */
  send: (batches: ActivityBatch[]) => void;
  /** Whether activity is reported at all (the PC's `reportActivity` opt-in), read each time. */
  enabled: () => boolean;
  /** Whether file names are reported (`reportFileNames`), read each time. */
  fileNames: () => boolean;
  now?: () => number;
  /** Timers off (tests call {@link AgentActivity.flush} and {@link AgentActivity.beat}). */
  manual?: boolean;
}

interface Tracked {
  snap: RunSnapshot;
  seq: number;
  pending: ActivityEvent[];
  lastStepAt: number;
  lastSentAt: number;
  files: number;
  fileNames: string[];
  seenFiles: Set<string>;
  lastEventAt: number;
  stop?: () => Promise<boolean>;
}

const FLUSH_MS = 2000;
const SLOW_FLUSH_MS = 10_000;
const STEP_GAP_MS = 1000;
const FILES_PER_BATCH = 5;
const ENDED_KEEP = 500;
const GOING = new Set<RunSnapshot["state"]>(["queued", "running", "waiting"]);

/** Watches the agents and makes the batches. One instance per app. */
export class AgentActivity {
  private readonly runs = new Map<string, Tracked>();
  /** Runs that ended (and were reported, or ended before they were seen), so a later listing does not start them again. */
  private readonly ended = new Set<string>();
  private readonly now: () => number;
  private flushTimer?: NodeJS.Timeout;
  private beatTimer?: NodeJS.Timeout;
  private slowUntil = 0;

  /** @param o - Where batches go, the opt-ins and the clock. */
  constructor(private readonly o: AgentActivityOptions) {
    this.now = o.now ?? Date.now;
    if (!o.manual) {
      this.beatTimer = setInterval(() => this.beat(), HUB_LIMITS.agentBeatMs);
      this.beatTimer.unref?.();
    }
  }

  /** Stops the timers (the app is closing). */
  close(): void {
    clearInterval(this.beatTimer);
    clearTimeout(this.flushTimer);
  }

  /** The hub refused for the rate: batches go every 10 seconds for the next 5 minutes. */
  slowDown(): void {
    this.slowUntil = this.now() + 5 * 60_000;
  }

  /**
   * Stops a run from the hub page (a sealed `cancel` from a paired phone).
   *
   * @param runId - The run.
   * @returns Whether it was going and was stopped.
   */
  async cancel(runId: string): Promise<boolean> {
    const r = this.runs.get(runId);
    if (!r?.stop || !GOING.has(r.snap.state)) return false;
    return r.stop().catch(() => false);
  }

  /** @returns Whether a run id is one this activity reports. */
  has(runId: string): boolean {
    return this.runs.has(runId);
  }

  /**
   * One run as it is now: compared with what was seen, the difference becomes events.
   *
   * @param s - The snapshot.
   * @param stop - How to stop it (Stop on the hub page).
   */
  observe(s: RunSnapshot, stop?: () => Promise<boolean>): void {
    if (!this.o.enabled()) {
      if (this.runs.size) this.runs.clear();
      return;
    }
    const t = this.now();
    let r = this.runs.get(s.runId);
    const before = r?.snap;
    if (!r) {
      // A run that ended before it was seen (old history, or before reporting was turned on) is not reported.
      if (this.ended.has(s.runId) || !GOING.has(s.state)) return void this.remember(s.runId);
      r = { snap: s, seq: 0, pending: [], lastStepAt: 0, lastSentAt: 0, files: 0, fileNames: [], seenFiles: new Set(), lastEventAt: t };
      this.runs.set(s.runId, r);
      this.add(r, { type: "started", title: s.title.slice(0, 120), source: s.source, ...(s.model ? { model: s.model } : {}) });
    }
    if (stop) r.stop = stop;
    r.snap = s;
    if (s.step > (before?.step ?? 0)) this.step(r, s, t);
    if (s.tokensIn !== undefined && (s.tokensIn !== before?.tokensIn || s.tokensOut !== before?.tokensOut)) this.usage(r, s);
    this.files(r, s.files ?? []);
    if (s.state !== before?.state || s.waiting?.requestId !== before?.waiting?.requestId) this.stateChanged(r, s);
    this.soon();
  }

  /** A step event, at most one per second per run (a newer step replaces the one not yet sent). */
  private step(r: Tracked, s: RunSnapshot, t: number): void {
    const ev = { type: "step" as const, n: s.step, ...(s.of ? { of: s.of } : {}), label: (s.label ?? "").slice(0, 80) };
    const queued = r.pending.findLast((e) => e.type === "step");
    if (queued && t - r.lastStepAt < STEP_GAP_MS) return void Object.assign(queued, ev, { t });
    r.lastStepAt = t;
    this.add(r, ev);
  }

  private usage(r: Tracked, s: RunSnapshot): void {
    const ev = { type: "usage" as const, tokensIn: s.tokensIn ?? 0, tokensOut: s.tokensOut ?? 0 };
    const queued = r.pending.findLast((e) => e.type === "usage");
    if (queued) return void Object.assign(queued, ev);
    this.add(r, ev);
  }

  /** Files are counted always; their names go out only with `reportFileNames`, at most 5 per batch. */
  private files(r: Tracked, files: AgentFile[]): void {
    const names = this.o.fileNames();
    for (const f of files) {
      const path = cleanAgentPath(f.path);
      if (!path || r.seenFiles.has(`${f.op}:${path}`)) continue;
      r.seenFiles.add(`${f.op}:${path}`);
      r.files++;
      if (!names) continue;
      r.fileNames = [...r.fileNames.filter((p) => p !== path), path].slice(-5);
      if (r.pending.filter((e) => e.type === "file").length < FILES_PER_BATCH) this.add(r, { type: "file", path, op: f.op });
    }
  }

  private stateChanged(r: Tracked, s: RunSnapshot): void {
    switch (s.state) {
      case "waiting":
        if (s.waiting) this.add(r, { type: "waiting", ...s.waiting });
        return;
      case "done":
        return this.add(r, { type: "done", steps: s.step, ...(s.branch ? { branch: s.branch } : {}), ...(s.link ? { link: s.link } : {}) });
      case "failed":
        return this.add(r, { type: "failed", reason: (s.failReason ?? "").slice(0, 200) });
      case "cancelled":
        return this.add(r, { type: "cancelled" });
      default:
        return;
    }
  }

  private add(r: Tracked, e: DistributiveOmit<ActivityEvent, "seq" | "t">): void {
    const t = this.now();
    r.lastEventAt = t;
    r.pending.push({ ...e, seq: ++r.seq, t } as ActivityEvent);
  }

  private remember(runId: string): void {
    this.ended.add(runId);
    if (this.ended.size > ENDED_KEEP) this.ended.delete(this.ended.values().next().value!);
  }

  /** A flush in 2 seconds (10 while slowed), unless one is due already. */
  private soon(): void {
    if (this.o.manual || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, this.now() < this.slowUntil ? SLOW_FLUSH_MS : FLUSH_MS);
    this.flushTimer.unref?.();
  }

  private stateOf(r: Tracked): AgentRunState {
    const s = r.snap;
    return {
      runId: s.runId,
      title: s.title.slice(0, 120),
      source: s.source,
      state: s.state,
      ...(s.model ? { model: s.model } : {}),
      step: s.step,
      ...(s.of ? { of: s.of } : {}),
      ...(s.label ? { label: s.label.slice(0, 80) } : {}),
      startedAt: s.startedAt,
      lastEventAt: r.lastEventAt,
      ...(s.endedAt ? { endedAt: s.endedAt } : {}),
      ...(s.tokensIn !== undefined ? { tokensIn: s.tokensIn, tokensOut: s.tokensOut ?? 0 } : {}),
      files: r.files,
      fileNames: this.o.fileNames() ? r.fileNames : [],
      ...(s.state === "waiting" && s.waiting ? { waiting: s.waiting } : {}),
      ...(s.branch ? { branch: s.branch } : {}),
      ...(s.link ? { link: s.link } : {}),
    };
  }

  /**
   * Sends one batch for every run with new events; an ended run is then forgotten.
   *
   * @returns The batches sent (tests).
   */
  flush(): ActivityBatch[] {
    const out: ActivityBatch[] = [];
    const t = this.now();
    for (const r of this.runs.values()) {
      if (!r.pending.length) continue;
      out.push({ runId: r.snap.runId, state: this.stateOf(r), events: r.pending.splice(0, HUB_LIMITS.agentBatchEvents) });
      r.lastSentAt = t;
    }
    for (const [id, r] of this.runs) {
      if (!GOING.has(r.snap.state) && !r.pending.length) {
        this.runs.delete(id);
        this.remember(id);
      }
    }
    if (out.length) this.o.send(out);
    // Events left over (more than one batch holds) go with the next flush.
    if ([...this.runs.values()].some((r) => r.pending.length)) this.soon();
    return out;
  }

  /**
   * The heartbeat: a batch without events for each going run that sent nothing for 25 seconds.
   *
   * @returns The batches sent (tests).
   */
  beat(): ActivityBatch[] {
    if (!this.o.enabled()) return [];
    const t = this.now();
    const out: ActivityBatch[] = [];
    for (const r of this.runs.values()) {
      if (!GOING.has(r.snap.state) || r.pending.length || t - r.lastSentAt < HUB_LIMITS.agentBeatMs - 1000) continue;
      out.push({ runId: r.snap.runId, state: this.stateOf(r), events: [] });
      r.lastSentAt = t;
    }
    if (out.length) this.o.send(out);
    return out;
  }
}

/** `Omit` over each member of a union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// ---- adapters ----

/** The conversation id of a helper's yes/no ask when it is answered through the hub (`approval_answer`). */
export const HELPER_ASKS = "helper-asks";
/** The conversation id of an inbox run's tool approval answered through the hub. */
export const INBOX_APPROVALS = "inbox-approvals";

const FILE_TOOL: Record<string, AgentFile["op"]> = { read_file: "read", edit_file: "edit", write_file: "create", delete_file: "delete" };

/**
 * A helper run as a snapshot. Its step texts are `tool: argument`; only the tool's name becomes the label, and the
 * argument becomes a file only for the file tools.
 *
 * @param r - The run's info.
 * @param inboxAsks - The conversation id the PC uses for Antigravity run asks.
 * @returns The snapshot.
 */
export function helperSnapshot(r: HelperRunInfo, inboxAsks: string): RunSnapshot {
  const tool = (s: string) => {
    const name = s.split(":")[0]!.trim();
    return /^[\w.-]{1,60}$/.test(name) ? name : "step";
  };
  const files: AgentFile[] = [];
  for (const s of r.steps) {
    const i = s.indexOf(":");
    const op = FILE_TOOL[tool(s)];
    if (op && i > 0) files.push({ path: s.slice(i + 1).trim(), op });
  }
  const state = ({ waiting: "queued", asking: "waiting", running: "running", done: "done", failed: "failed", stopped: "cancelled" } as const)[r.state];
  const waiting: AgentWaiting | undefined = r.state !== "asking" ? undefined : r.runAsk ? { reason: "run-press", requestId: r.runAsk.requestId, conversationId: inboxAsks, summary: "Run this message in Antigravity?" } : { reason: "ask", requestId: r.id, conversationId: HELPER_ASKS, summary: (r.waitReason ?? "").slice(0, 200) };
  const last = r.steps.at(-1);
  return {
    runId: r.id,
    source: r.kind === "external" ? "antigravity" : "chat-helper",
    title: r.title,
    model: r.model,
    state,
    step: r.step,
    of: r.maxSteps,
    ...(last ? { label: tool(last) } : {}),
    startedAt: r.startedAt ?? r.queuedAt,
    ...(r.endedAt ? { endedAt: r.endedAt } : {}),
    files,
    ...(waiting ? { waiting } : {}),
    ...(r.state === "failed" ? { failReason: r.error?.startsWith("Took longer") ? "Took too long" : "Failed" } : {}),
  };
}

/** The run id of an inbox task (letters, digits, `_`, `-`; at most 64). */
export const inboxRunId = (taskId: string): string => `in-${taskId.replace(/[^\w-]/g, "-").slice(0, 60)}`;

/**
 * An inbox task run by Antigravity as a snapshot (other executors do not run in the inbox runner). A waiting task
 * with an open "Run this?" ask is `waiting` for a Run press; without one it is `queued`.
 *
 * @param t - The task.
 * @param ask - Its open run ask, if any.
 * @param inboxAsks - The conversation id the PC uses for those asks.
 * @returns The snapshot, or undefined when the task is not an Antigravity run.
 */
export function inboxSnapshot(t: InboxTaskView, ask: InboxRunAsk | undefined, inboxAsks: string): RunSnapshot | undefined {
  if (t.runBy !== "antigravity") return undefined;
  const state = (
    {
      waiting: ask ? "waiting" : "queued",
      queued: "queued",
      "deferred-quota": "queued",
      running: "running",
      "needs-approval": "waiting",
      done: "done",
      partial: "done",
      failed: "failed",
      declined: "cancelled",
      skipped: "cancelled",
    } as const
  )[t.status];
  const waiting: AgentWaiting | undefined =
    t.status === "needs-approval" && t.pending ? { reason: "approval", requestId: t.pending.requestId, conversationId: INBOX_APPROVALS, summary: "Antigravity asks to do a step" } : t.status === "waiting" && ask ? { reason: "run-press", requestId: ask.requestId, conversationId: inboxAsks, summary: "Waiting for Run" } : undefined;
  const lastStep = t.decisions?.at(-1)?.what;
  return {
    runId: inboxRunId(t.id),
    source: "antigravity",
    title: t.title,
    ...(t.modelUsed ? { model: t.modelUsed } : {}),
    state,
    step: t.steps ?? t.decisions?.length ?? 0,
    // Only the verb of the agent's step ("edit", "run"), never its arguments.
    ...(lastStep ? { label: lastStep.split(/\s+/)[0]!.slice(0, 20) } : t.status === "deferred-quota" ? { label: "quota" } : {}),
    startedAt: t.startedAt ?? 0,
    ...(t.endedAt ? { endedAt: t.endedAt } : {}),
    files: (t.files ?? []).map((f) => ({ path: f.path, op: "edit" as const })),
    ...(waiting ? { waiting } : {}),
    ...(t.status === "done" || t.status === "partial" ? { branch: t.branch } : {}),
    ...(t.status === "failed" ? { failReason: "Failed" } : {}),
  };
}
