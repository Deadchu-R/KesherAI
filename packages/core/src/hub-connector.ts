/**
 * The PC's side of the Claude connector's line (shared/hub-connector.ts; Roee, 27.11): answers the hub's sealed
 * questions while "Claude connector may read and run" is on (Settings › Kesher Cloud, off by default).
 *
 * This is the real gate, not the hub: every query is refused while the opt-in is off; only the ops in
 * {@link CONNECTOR_OPS} exist (read tasks / one task / quotas / agents, add a task, and Run / queue / take out of the
 * queue / Stop / "Who does it"); at most {@link CONNECTOR_LIMITS.perMinute} a minute; each is noted in the app's log
 * (op, task id and the outcome; never a title, goal or result). Approvals, board edits, agent names and settings are
 * not reachable from here. Every text field is scrubbed (home folder, user name, keys, e-mails) before it is sealed.
 */
import { homedir, userInfo } from "node:os";
import {
  CONNECTOR_FILTER_STATES,
  CONNECTOR_LIMITS,
  fitConnectorAnswer,
  mapConnectorText,
  redactLeaks,
  type AssignResult,
  type AssignTo,
  type ConnectorAgent,
  type ConnectorAnswer,
  type ConnectorQuery,
  type ConnectorTaskDetail,
  type ConnectorTaskRow,
  type HubAgent,
  type HubCommandAction,
  type HubInboxTask,
  type InboxTaskView,
  type ProviderQuota,
} from "@kesher/shared";
import { hubInboxTask } from "./hub-client.js";

/** What the connector's answers read and do (the same functions the hub page's commands use). */
export interface ConnectorDeps {
  /** The task inbox's tasks (oldest first). */
  inboxTasks?: () => Promise<InboxTaskView[]>;
  /** What is left of each provider (provider-quotas.ts). */
  quotas?: () => Promise<ProviderQuota[]>;
  /** The agents this PC has. */
  agents?: () => HubAgent[];
  /** Run / queue / take out / cancel-or-stop, as from the phone (hub-commands.ts). */
  inboxCommand?: (action: HubCommandAction, taskId: string, from: { id: string; kind: string }) => Promise<{ ok: boolean; text: string }>;
  /** "Who does it" (task-assign.ts). */
  assign?: (taskId: string, to: AssignTo, confirm: boolean) => Promise<AssignResult>;
  /** "+ Task": a new inbox task (inbox-runner.ts `add`). */
  addTask?: (t: { title: string; goal: string; executor: string }) => Promise<InboxTaskView>;
  /** One line to the app's log. */
  log?: (line: string) => void;
}

/** The connector's actions as the hub page's commands. */
const ACTION_COMMAND: Record<"run" | "queue" | "unqueue" | "stop", HubCommandAction> = { run: "inbox-run", queue: "inbox-queue", unqueue: "inbox-unqueue", stop: "inbox-cancel" };

/** Who pressed it, as the inbox records it (`hub:connector`). */
const FROM = { id: "connector", kind: "connector" };

/** The inbox's executor for an agent kind the PC reports (to put a running task on its agent). */
const AGENT_OF: Record<string, string> = { antigravity: "antigravity", local: "local-model" };

/**
 * Answers the Claude connector's questions on this PC.
 */
export class ConnectorDesk {
  private calls: number[] = [];
  private readonly scrub: (s: string) => string;

  /**
   * @param deps - What it reads and does.
   * @param now - The clock (a fake in tests).
   * @param leak - The home folder and user name to hide (default: this computer's).
   */
  constructor(
    private readonly deps: ConnectorDeps,
    private readonly now: () => number = Date.now,
    leak: { home?: string; username?: string } = safeLeakContext(),
  ) {
    this.scrub = (s) => redactLeaks(s, leak).text;
  }

  /**
   * One question: checked against the opt-in and the rate limit, noted in the log, answered (scrubbed, fitted).
   *
   * @param q - The query (already checked by parseConnectorQuery when the envelope was opened).
   * @param optedIn - The PC's `connector` opt-in now.
   * @returns The answer to seal to the hub.
   */
  async answer(q: ConnectorQuery, optedIn: boolean): Promise<ConnectorAnswer> {
    const at = this.now();
    const what = `${q.op}${q.action ? `:${q.action}` : ""}${q.taskId ? ` ${q.taskId}` : ""}`;
    const done = (a: Omit<ConnectorAnswer, "queryId" | "at">): ConnectorAnswer => {
      this.deps.log?.(`Claude connector: ${what} -> ${a.ok ? "ok" : "refused"}`);
      return fitConnectorAnswer(mapConnectorText({ queryId: q.queryId, at, ...a }, this.scrub));
    };
    if (!optedIn) return done({ ok: false, text: "This PC does not let the Claude connector in (on the PC: Settings › Kesher Cloud › Claude connector may read and run)." });
    this.calls = this.calls.filter((t) => at - t < 60_000);
    if (this.calls.length >= CONNECTOR_LIMITS.perMinute) return done({ ok: false, text: "Too many requests in a minute; try again shortly." });
    this.calls.push(at);
    try {
      return done(await this.run(q, at));
    } catch (e) {
      return done({ ok: false, text: ((e as Error).message || "It did not work.").slice(0, 300) });
    }
  }

  /** The op itself. */
  private async run(q: ConnectorQuery, at: number): Promise<Omit<ConnectorAnswer, "queryId" | "at">> {
    switch (q.op) {
      case "tasks": {
        const reports = await this.reports(at);
        const states = q.filter && q.filter !== "all" ? CONNECTOR_FILTER_STATES[q.filter] : undefined;
        const rows = reports.filter(({ r }) => (!states || states.includes(r.state)) && (!q.executor || r.executor === q.executor)).map(({ r }) => rowOf(r));
        return { ok: true, tasks: rows.slice(-CONNECTOR_LIMITS.tasks) };
      }
      case "task": {
        const found = (await this.reports(at)).find(({ r }) => r.taskId === q.taskId);
        if (!found) return { ok: false, text: "This PC has no task with that id (kesher_tasks lists them)." };
        return { ok: true, task: detailOf(found.r, found.t) };
      }
      case "quotas":
        if (!this.deps.quotas) return { ok: false, text: "This PC does not report quotas." };
        return { ok: true, quotas: await this.deps.quotas() };
      case "agents":
        return { ok: true, agents: await this.agents(at) };
      case "add": {
        if (!this.deps.addTask) return { ok: false, text: "This PC has no task inbox." };
        const t = await this.deps.addTask({ title: q.title ?? "", goal: q.goal ?? q.title ?? "", executor: q.executor ?? "auto" });
        const r = hubInboxTask(asReported(t), at);
        return { ok: true, text: `Added to the task inbox as ${t.id}.`, ...(r ? { task: detailOf(r, t) } : {}) };
      }
      case "action": {
        const id = q.taskId ?? "";
        if (q.action === "assign") {
          if (!this.deps.assign || !q.to) return { ok: false, text: "This PC cannot give tasks to others yet." };
          const r = await this.deps.assign(id, q.to, q.confirm === true);
          return { ok: r.ok, text: r.ask ? `${r.text} (call again with confirm: true to go on)` : r.text };
        }
        if (!this.deps.inboxCommand || !q.action) return { ok: false, text: "This PC has no task inbox." };
        return this.deps.inboxCommand(ACTION_COMMAND[q.action], id, FROM);
      }
    }
  }

  /** The inbox's tasks as the hub lists them, with their queue places (oldest first). */
  private async reports(at: number): Promise<Array<{ r: HubInboxTask; t: InboxTaskView }>> {
    const tasks = (await this.deps.inboxTasks?.()) ?? [];
    let place = 0;
    return tasks.flatMap((t) => {
      const base = hubInboxTask(asReported(t), at);
      if (!base) return [];
      const waits = base.state === "waiting" || base.state === "waiting-run";
      const r = waits ? hubInboxTask(asReported(t), at, { queuePos: ++place }) ?? base : base;
      return [{ r, t }];
    });
  }

  /** The PC's agents, each with the running task it works on and that task's last step. */
  private async agents(at: number): Promise<ConnectorAgent[]> {
    const out: ConnectorAgent[] = (this.deps.agents?.() ?? []).map((a) => ({ kind: a.kind, state: a.state, ...(a.label ? { label: a.label } : {}) }));
    for (const { r } of await this.reports(at)) {
      if (r.state !== "running") continue;
      const task = { taskId: r.taskId, title: r.title.slice(0, CONNECTOR_LIMITS.titleChars), ...(r.steps ? { steps: r.steps } : {}), ...(r.estSteps ? { estSteps: r.estSteps } : {}), ...(r.now ? { now: r.now } : {}) };
      const own = out.find((a) => a.kind === (AGENT_OF[r.executor] ?? r.executor) && !a.task);
      if (own) own.task = task;
      else out.push({ kind: r.executor.replace(/[^a-z0-9-]/g, "").slice(0, 40) || "agent", state: "busy", ...(r.model ? { label: r.model } : {}), task });
    }
    return out.slice(0, CONNECTOR_LIMITS.agents);
  }
}

/** A task from the hub is listed too here (the hub page leaves those out because it sent them; the connector did not). */
function asReported(t: InboxTaskView): InboxTaskView {
  return t.from === "hub" ? { ...t, from: "claude" } : t;
}

/** A list row: short fields only. */
function rowOf(r: HubInboxTask): ConnectorTaskRow {
  return { taskId: r.taskId, title: r.title.slice(0, CONNECTOR_LIMITS.titleChars), state: r.state, executor: r.executor, ...(r.queuePos ? { queuePos: r.queuePos } : {}), ...(r.steps ? { steps: r.steps } : {}), ...(r.estSteps ? { estSteps: r.estSteps } : {}), ...(r.model ? { model: r.model } : {}) };
}

/** One task in full: the row, branch, result, cause, times and the newest steps. */
function detailOf(r: HubInboxTask, t: InboxTaskView): ConnectorTaskDetail {
  return {
    ...rowOf(r),
    title: r.title,
    ...(r.branch ? { branch: r.branch } : {}),
    ...(r.result ? { result: r.result } : {}),
    ...(r.cause ? { cause: r.cause } : {}),
    ...(r.kind ? { kind: r.kind } : {}),
    ...(r.startedAt ? { startedAt: r.startedAt } : {}),
    ...(r.endedAt ? { endedAt: r.endedAt } : {}),
    stepLog: (t.stepLog ?? []).slice(-CONNECTOR_LIMITS.steps),
  };
}

/** This computer's home folder and user name, for the scrub (empty when the system will not tell). */
function safeLeakContext(): { home?: string; username?: string } {
  try {
    return { home: homedir(), username: userInfo().username };
  } catch {
    return {};
  }
}
