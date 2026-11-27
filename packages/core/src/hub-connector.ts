/**
 * The PC's side of the Claude connector's line (shared/hub-connector.ts; Roee, 27.11): answers the hub's sealed
 * questions while "Claude connector may read and run" is on (Settings › Kesher Cloud, off by default).
 *
 * This is the real gate, not the hub: every query is refused while the opt-in is off; only the ops in
 * {@link CONNECTOR_OPS} exist (read tasks / one task / quotas / agents, add a task, and Run / queue / take out of the
 * queue / Stop / "Who does it"); at most {@link CONNECTOR_LIMITS.perMinute} a minute; each is noted in the app's log
 * (op, task id and the outcome; never a title, goal or result). Board edits, agent names and settings are not reachable
 * from here. Approval cards of chats (`approvals`, `approve`; 27.11) are the one addition: listed while the opt-in is
 * on, answered only when the user also let connected apps answer cards (Settings › Use KesherAI from other apps, the same
 * switch as the MCP server's `kesher_approve`), and never a dangerous command or screen control. Every text field is scrubbed (home folder, user name, keys, e-mails) before it is sealed.
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
  type ConnectorApproval,
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
import { HELPER_ASKS, INBOX_APPROVALS } from "./agent-activity.js";
import { hubInboxTask, type PendingApproval } from "./hub-client.js";

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
  /** The approval cards waiting on this PC and how to answer one (hub-client.ts `approvals`). */
  approvals?: {
    pending(): PendingApproval[];
    answer(conversationId: string, requestId: string, decision: "allow" | "deny", from: { id: string; kind: string }, forMinutes?: number): Promise<boolean>;
  };
  /** Whether the user let connected apps answer approval cards (`mcpServer.allowApprovals`). */
  allowApprovals?: () => boolean;
  /** One line to the app's log. */
  log?: (line: string) => void;
}

/** The connector's actions as the hub page's commands. */
const ACTION_COMMAND: Record<"run" | "queue" | "unqueue" | "stop", HubCommandAction> = { run: "inbox-run", queue: "inbox-queue", unqueue: "inbox-unqueue", stop: "inbox-cancel" };

/** Who pressed it, as the inbox records it (`hub:connector`). */
const FROM = { id: "connector", kind: "connector" };

/** The inbox's executor for an agent kind the PC reports (to put a running task on its agent). */
/** Chats' own cards are the connector's; Antigravity's "Run?" asks and helper cards have their own paths (a paired phone). */
const OTHER_ASKS = new Set([HELPER_ASKS, INBOX_APPROVALS, "task-inbox"]);

/** Tools whose approval is the user's alone, whoever asks (as in the MCP server's `kesher_approve`). */
const USER_ONLY_TOOLS = /^computer_use_app$/;

/** The guard's words for a command that always needs the user's own approval (hub-approvals.ts `isDangerousReason`). */
const DANGER = /always needs your approval/i;

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
    const what = `${q.op}${q.action ? `:${q.action}` : ""}${q.decision ? `:${q.decision}` : ""}${q.taskId ? ` ${q.taskId}` : ""}`;
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

  /**
   * A refused answer without reading or doing anything (a stale query: see connectorQueryStale), noted in the log.
   *
   * @param q - The query.
   * @param why - Why, in one short line.
   * @returns The answer to seal to the hub.
   */
  refuse(q: ConnectorQuery, why: string): ConnectorAnswer {
    this.deps.log?.(`Claude connector: ${q.op}${q.action ? `:${q.action}` : ""}${q.decision ? `:${q.decision}` : ""}${q.taskId ? ` ${q.taskId}` : ""} -> refused (stale)`);
    return { queryId: q.queryId, ok: false, text: why, at: this.now() };
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
      case "approvals": {
        if (!this.deps.approvals) return { ok: false, text: "This PC has no approvals to show." };
        return { ok: true, approvals: this.waiting().map(toConnectorApproval), canAnswer: this.canAnswer() };
      }
      case "approve": {
        const found = this.waiting().find((a) => a.conversationId === q.conversationId && a.requestId === q.requestId);
        if (!this.deps.approvals || !found) return { ok: false, text: "That card is no longer waiting." };
        if (q.decision === "allow") {
          if (!this.canAnswer()) return { ok: false, text: "The user has not let connected apps answer KesherAI's approval cards (KesherAI › Settings › Use KesherAI from other apps). Ask them to approve it in KesherAI." };
          if (lockedToUser(found)) return { ok: false, text: "This one needs the user's own approval in KesherAI (a dangerous command, screen control, or a step on a sensitive site)." };
        }
        const minutes = q.decision === "allow" && found.forWhile !== false ? q.forMinutes : undefined;
        const done = await this.deps.approvals.answer(found.conversationId, found.requestId, q.decision === "allow" ? "allow" : "deny", FROM, minutes);
        if (!done) return { ok: false, text: "That card is no longer waiting." };
        return { ok: true, text: q.decision === "deny" ? "Denied." : minutes ? `Allowed, and ${found.tool} stays allowed in that chat for ${minutes} minutes.` : q.forMinutes ? "Allowed once (a longer allowance does not apply to this one)." : "Allowed once." };
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

  /** Whether the user let connected apps answer approval cards. */
  private canAnswer(): boolean {
    return this.deps.allowApprovals?.() === true;
  }

  /** The chats' own approval cards waiting now (oldest first), not Antigravity's asks or helpers' cards. */
  private waiting(): PendingApproval[] {
    return (this.deps.approvals?.pending() ?? []).filter((a) => a.kind !== "run" && !OTHER_ASKS.has(a.conversationId)).slice(0, CONNECTOR_LIMITS.approvals);
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

/** Whether only the user may allow this card (a dangerous command, screen control). */
function lockedToUser(a: Pick<PendingApproval, "tool" | "reason" | "userOnly">): boolean {
  return a.userOnly === true || DANGER.test(a.reason) || USER_ONLY_TOOLS.test(a.tool);
}

/** An approval card as the connector lists it (cut short; the PC's own card keeps the whole text). */
function toConnectorApproval(a: PendingApproval): ConnectorApproval {
  return {
    conversationId: a.conversationId,
    requestId: a.requestId,
    title: a.title.slice(0, CONNECTOR_LIMITS.titleChars),
    tool: a.tool.slice(0, 60),
    preview: a.preview.slice(0, CONNECTOR_LIMITS.previewChars),
    reason: a.reason.slice(0, CONNECTOR_LIMITS.reasonChars),
    ...(a.who ? { who: a.who.slice(0, 80) } : {}),
    ...(a.forWhile !== false ? { forWhile: true } : {}),
    ...(lockedToUser(a) ? { locked: true } : {}),
    ...(a.at ? { at: a.at } : {}),
  };
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
