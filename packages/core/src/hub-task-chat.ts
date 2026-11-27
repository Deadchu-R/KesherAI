/**
 * The PC's side of the hub's Task chat (shared/hub-task-chat.ts; Roee, 27.11): answers the owner's sealed messages with
 * the CPU pool's `chat` model, and applies a proposal only after the owner presses Apply.
 *
 * Gates, in order: the sender must be a paired phone or hub page (checked by the caller); an ask older than five minutes
 * is refused (a replayed one does nothing); at most {@link TASK_CHAT_LIMITS.perMinute} a minute; one model call at a time.
 * The model has no tools of its own: its text is mapped to the fixed action list (`parseModelReply`), and the proposal is
 * kept here by id. Apply runs the PC's own copy of the actions through the same functions as the hub page's buttons
 * (add task, Who does it, queue, take out of the queue, skip), re-checking each task's state first. Nothing the owner
 * typed or the model said is written to a log (only the op and counts).
 */
import { randomBytes } from "node:crypto";
import {
  TASK_CHAT_LIMITS,
  TASK_CHAT_SYSTEM,
  boardContext,
  parseModelReply,
  taskChatStale,
  type AssignResult,
  type AssignTo,
  type ChatBoardTask,
  type HubCommandAction,
  type InboxTaskView,
  type TaskChatAction,
  type TaskChatAnswer,
  type TaskChatAsk,
} from "@kesher/shared";

/** What the chat reads and does (the same functions the connector and the hub page's commands use). */
export interface TaskChatDeps {
  /** The task inbox's tasks (oldest first). */
  inboxTasks?: () => Promise<InboxTaskView[]>;
  /** A completion on the CPU pool's `chat` role; undefined when the pool is off or has no chat model on this PC. */
  complete?: (messages: Array<{ role: "system" | "user" | "assistant"; content: string }>, o: { maxTokens: number; temperature: number }) => Promise<string>;
  /** Whether a chat model is on this PC (so the page can say so before the model loads). */
  hasModel?: () => boolean;
  /** "+ Task" (inbox-runner.ts `add`). */
  addTask?: (t: { title: string; goal: string; executor: string }) => Promise<InboxTaskView>;
  /** "Who does it" (task-assign.ts). */
  assign?: (taskId: string, to: AssignTo, confirm: boolean) => Promise<AssignResult>;
  /** Queue / take out / skip, as from the phone (hub-commands.ts). */
  inboxCommand?: (action: HubCommandAction, taskId: string, from: { id: string; kind: string }) => Promise<{ ok: boolean; text: string }>;
  /** One line to the app's log (never any text of the chat). */
  log?: (line: string) => void;
}

/** A proposal kept for Apply. */
interface Kept {
  actions: TaskChatAction[];
  at: number;
}

/** Skip is the inbox's cancel of a task that has not started (a running one is never stopped from the chat). */
const COMMAND_OF: Record<"queue" | "unqueue" | "skip", HubCommandAction> = { queue: "inbox-queue", unqueue: "inbox-unqueue", skip: "inbox-cancel" };

/** The sender as the inbox records it. */
const FROM = { id: "task-chat", kind: "hub-chat" };

/** The words of a refusal (short; the page shows them as they are). */
const REASON = {
  stale: "This message is too old. Send it again.",
  rate: "Too many messages. Wait a minute.",
  busy: "The small model is still answering. Wait a moment.",
  noModel: "No small chat model on this PC. Settings › CPU models.",
  noInbox: "This PC has no task inbox.",
  gone: "That proposal is no longer waiting (it expired or was used).",
  failed: "The small model did not answer. Try again.",
} as const;

/**
 * Answers the Task chat's messages on one PC.
 */
export class TaskChatDesk {
  private readonly proposals = new Map<string, Kept>();
  private readonly recent: number[] = [];
  private busy = false;

  /**
   * @param deps - The inbox, the CPU pool's chat model and the actions.
   * @param now - The clock (ms; a fake in tests).
   */
  constructor(
    private readonly deps: TaskChatDeps,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * One ask from the owner's page. The caller has checked the sender is a paired phone or hub page.
   *
   * @param ask - The ask (checked by parseTaskChatAsk).
   * @returns The answer to seal back.
   */
  async handle(ask: TaskChatAsk): Promise<TaskChatAnswer> {
    const t = this.now();
    if (taskChatStale(ask.at, t)) return this.no(ask, REASON.stale);
    while (this.recent.length && t - this.recent[0]! > 60_000) this.recent.shift();
    if (this.recent.length >= TASK_CHAT_LIMITS.perMinute) return this.no(ask, REASON.rate);
    this.recent.push(t);
    this.forget(t);
    if (ask.op === "cancel") {
      this.proposals.delete(ask.proposalId ?? "");
      return { chatId: ask.chatId, kind: "cancelled", text: "OK", ...(ask.proposalId ? { proposalId: ask.proposalId } : {}) };
    }
    if (ask.op === "apply") return this.apply(ask);
    return this.say(ask);
  }

  /** A refusal. */
  private no(ask: TaskChatAsk, text: string): TaskChatAnswer {
    this.deps.log?.(`Task chat: ${ask.op} -> refused`);
    return { chatId: ask.chatId, kind: "refused", text };
  }

  /** Drops proposals past their time and the oldest beyond the cap. */
  private forget(t: number): void {
    for (const [id, p] of this.proposals) if (t - p.at > TASK_CHAT_LIMITS.keepMs) this.proposals.delete(id);
    while (this.proposals.size > TASK_CHAT_LIMITS.keepProposals) this.proposals.delete(this.proposals.keys().next().value as string);
  }

  /** The inbox's tasks as the chat's context lists them. */
  private async board(): Promise<ChatBoardTask[]> {
    const tasks = (await this.deps.inboxTasks?.()) ?? [];
    return tasks.map((x) => ({ taskId: x.id, title: x.title, state: x.status === "waiting" && x.queued ? "queued" : x.status, executor: x.runBy }));
  }

  /** A message: the model reads the board and the message, and its text becomes a reply with maybe a proposal. */
  private async say(ask: TaskChatAsk): Promise<TaskChatAnswer> {
    if (!this.deps.inboxTasks) return this.no(ask, REASON.noInbox);
    if (!this.deps.complete || this.deps.hasModel?.() === false) return this.no(ask, REASON.noModel);
    if (this.busy) return this.no(ask, REASON.busy);
    this.busy = true;
    try {
      const ctx = boardContext(await this.board());
      let raw: string;
      try {
        raw = await this.deps.complete(
          [
            { role: "system", content: `${TASK_CHAT_SYSTEM}\n\nBoard (number | title | executor | state):\n${ctx.text}` },
            { role: "user", content: ask.text ?? "" },
          ],
          { maxTokens: TASK_CHAT_LIMITS.maxTokens, temperature: 0.2 },
        );
      } catch {
        return this.no(ask, REASON.failed);
      }
      const r = parseModelReply(raw, ctx.tasks);
      this.deps.log?.(`Task chat: say -> ${r.ok ? `${r.actions.length} proposed, ${r.refused} refused` : "unreadable"}`);
      if (!r.ok) return { chatId: ask.chatId, kind: "reply", text: REASON.failed };
      const text = r.reply || (r.actions.length ? "OK" : "…");
      if (!r.actions.length) return { chatId: ask.chatId, kind: "reply", text };
      const id = randomBytes(9).toString("base64url");
      this.proposals.set(id, { actions: r.actions, at: this.now() });
      return { chatId: ask.chatId, kind: "reply", text, proposal: { id, actions: r.actions } };
    } finally {
      this.busy = false;
    }
  }

  /** Apply: runs the PC's own copy of a proposal, once, each step checked against the inbox as it is now. */
  private async apply(ask: TaskChatAsk): Promise<TaskChatAnswer> {
    const id = ask.proposalId ?? "";
    const kept = this.proposals.get(id);
    // Used at once: a second Apply (a double tap, a replay) finds nothing.
    this.proposals.delete(id);
    if (!kept) return this.no(ask, REASON.gone);
    let done = 0;
    let failed = 0;
    const why: string[] = [];
    for (const a of kept.actions) {
      const r = await this.run(a).catch((e: Error) => ({ ok: false, text: e.message || "It did not work." }));
      if (r.ok) done++;
      else {
        failed++;
        if (why.length < 2) why.push(r.text.slice(0, 120));
      }
    }
    this.deps.log?.(`Task chat: apply -> ${done} done, ${failed} failed`);
    const text = failed ? `${done}/${done + failed}. ${why.join(" ")}` : `${done}/${done}`;
    return { chatId: ask.chatId, kind: "applied", text, proposalId: id, done, failed };
  }

  /** One action, after checking the task is still in a state it fits. */
  private async run(a: TaskChatAction): Promise<{ ok: boolean; text: string }> {
    if (a.op === "add") return this.add(a.title, a.goal, a.executor);
    const now = (await this.board()).find((t) => t.taskId === a.taskId);
    if (!now) return { ok: false, text: "The task is gone." };
    if (a.op === "assign") {
      if (!this.deps.assign) return { ok: false, text: "This PC cannot give tasks to others yet." };
      // confirm=false: a running or finished task asks first, and the chat never says yes for the owner.
      return this.deps.assign(a.taskId, a.to, false);
    }
    if (!this.deps.inboxCommand) return { ok: false, text: REASON.noInbox };
    if (a.op === "split") {
      if (now.state === "running") return { ok: false, text: "It started running." };
      // Parts first, then the original: a failure to add leaves the original as it was.
      for (const p of a.parts) {
        const r = await this.add(p.title, p.goal, a.executor);
        if (!r.ok) return r;
      }
      return this.deps.inboxCommand("inbox-cancel", a.taskId, FROM);
    }
    if (now.state === "running") return { ok: false, text: "It is running now." };
    return this.deps.inboxCommand(COMMAND_OF[a.op], a.taskId, FROM);
  }

  /** A new task through the inbox's own "+ Task". */
  private async add(title: string, goal: string | undefined, executor: string): Promise<{ ok: boolean; text: string }> {
    if (!this.deps.addTask) return { ok: false, text: REASON.noInbox };
    await this.deps.addTask({ title, goal: goal ?? title, executor });
    return { ok: true, text: "added" };
  }
}
