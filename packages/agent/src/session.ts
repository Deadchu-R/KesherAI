import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import type {
  AgentEvent,
  AgentMessage,
  AgentSessionInfo,
  AgentStatus,
  ApprovalDecision,
  PermissionMode,
  ToolCall,
  TeamRole,
  ToolSpec,
} from "@kesher/shared";
import { decide } from "./permissions.js";
import { CHARS_PER_TOKEN, SUMMARY_PROMPT, cutPoint, shortenOldToolOutputs, sizeOf, transcript } from "./context.js";
import { ASK_USER_TOOL, PRESENT_PLAN_TOOL, REQUEST_ACCESS_TOOL, askUserSpec, presentPlanSpec, requestAccessSpec, truncate, type AgentTool, type ToolContext } from "./tools.js";

/** Added to the system prompt in plan mode. */
const PLAN_NOTE =
  "PLAN MODE is on. Do not change anything: no file edits, no commands that change things (those tools are refused). Look around with the read-only tools (list, read and search files) until you understand what is needed, ask the user with ask_user if a choice is theirs, then call present_plan with a clear, numbered plan. After that, stop and wait.";
import { stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { displayPath } from "./workspace.js";

/** One model turn: give it the conversation and tools, get text and tool calls back. */
export type ModelTurn = (
  request: { messages: AgentMessage[]; tools: ToolSpec[] },
  signal: AbortSignal,
  onText: (delta: string) => void,
) => Promise<{ text: string; toolCalls: ToolCall[]; usage?: { inputTokens?: number; outputTokens?: number } }>;

/** A helper model, already resolved to something the session can call. */
export interface TeamMember {
  role: TeamRole;
  modelId: string;
  model: ModelTurn;
}

const PLANNER_PROMPT =
  "You are the planner in a team of AI models. Another model (the worker) will do the task with tools (files, commands, building programs, images, web). Write a short numbered plan (at most 7 steps) for the worker: what to do, in what order, what to check. Mention the pitfalls. Do not do the task yourself and do not write the final answer. Reply in the user's language.";
const REVIEWER_PROMPT =
  "You are the reviewer in a team of AI models. Another model (the worker) did the user's request; you see the request, what it did and its answer. Check that the answer is correct, complete, and actually does what was asked (files really made, programs really built, no instructions left for the user to do by hand). If it is good, reply with the single word APPROVED on the first line, optionally followed by one sentence. Otherwise reply with a short list of concrete problems and how to fix them. Reply in the user's language.";

/** Everything needed to start (or resume) a session. */
export interface AgentSessionOptions {
  id: string;
  modelId: string;
  model: ModelTurn;
  mode: PermissionMode;
  /** Absolute folder for file and terminal tools. */
  workspace?: string;
  /** Tools besides `ask_user`, which every session has. */
  tools: AgentTool[];
  /** System prompt, rebuilt by the caller for every session. */
  systemPrompt: string;
  /** Stop after this many model turns per user message (default 60). */
  maxSteps?: number;
  /** Saved conversation to resume. */
  messages?: AgentMessage[];
  events?: AgentEvent[];
  /** Called after every event worth saving. */
  onChange?(session: AgentSession): void;
  /**
   * Permanent approvals the user gave (for this conversation, this model, or
   * everywhere). Called before asking; return true to run without asking.
   * Dangerous commands still always ask.
   */
  isAlwaysAllowed?(tool: string, modelId: string): boolean;
  /** How many tokens the model can read (default 12 000, which fits a 16k-context local model). */
  contextTokens?: number;
  /** Models that plan before and review after the main one (multi-model chat). Read on every request. */
  team?: () => TeamMember[];
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event before it gets its `seq` and `at`. */
type NewEvent = DistributiveOmit<AgentEvent, "seq" | "at">;

/**
 * An agent conversation: runs the model, executes the tools it asks for,
 * stops to ask the user for approval or answers, and keeps the full history.
 *
 * Every visible thing that happens is an {@link AgentEvent}, emitted as
 * `"event"` and kept in {@link events} (except streaming text deltas, which
 * are only emitted). Clients replay the events to draw the conversation.
 *
 * @example
 * ```ts
 * const s = new AgentSession({ id, modelId, model, mode: "ask", workspace, tools: [...CODE_TOOLS], systemPrompt });
 * s.on("event", (e) => console.log(e.type));
 * s.send("Add a README");
 * ```
 */
export class AgentSession extends EventEmitter<{ event: [AgentEvent] }> {
  readonly id: string;
  modelId: string;
  mode: PermissionMode;
  readonly workspace?: string;
  systemPrompt: string;
  readonly events: AgentEvent[];
  readonly messages: AgentMessage[];
  private model: ModelTurn;
  private tools: Map<string, AgentTool>;
  private readonly maxSteps: number;
  private readonly onChange?: (s: AgentSession) => void;
  private statusValue: AgentStatus = "idle";
  private abort?: AbortController;
  private turn = 0;
  private readonly approvals = new Map<string, (d: { decision: ApprovalDecision; feedback?: string }) => void>();
  private readonly questions = new Map<string, (text: string) => void>();
  private readonly alwaysAllowed = new Set<string>();
  private readonly isAlwaysAllowed?: (tool: string, modelId: string) => boolean;
  /** Tokens the model can read; see {@link AgentSessionOptions.contextTokens}. */
  contextTokens: number;
  private readonly changes: Array<{ path: string; before: string | null }> = [];
  private toolsUnsupported = false;
  private readonly team?: () => TeamMember[];
  /** Messages sent while the agent was busy, in order; the owner (the conversation manager) drains it. */
  queued: Array<{ id: string; text: string; data?: unknown }> = [];
  /** Set after Stop: the queue waits until the user sends again. */
  queuePaused = false;

  /** Tells listeners the queue changed (a `queue` event, not saved, followed by info). */
  queueChanged(): void {
    this.push({ type: "queue" }, false);
  }
  /** Pictures the tool that just ran returned, for its tool message. */
  private pendingImages?: Array<{ mimeType: string; data: string }>;
  /** What the model said in its latest answer, shown on approval cards as the reason for the action. */
  private lastSaid = "";

  /** @param opts - See {@link AgentSessionOptions}. */
  constructor(opts: AgentSessionOptions) {
    super();
    this.id = opts.id;
    this.modelId = opts.modelId;
    this.model = opts.model;
    this.mode = opts.mode;
    if (opts.workspace) this.workspace = opts.workspace;
    this.systemPrompt = opts.systemPrompt;
    this.tools = new Map(opts.tools.map((t) => [t.spec.name, t]));
    this.maxSteps = opts.maxSteps ?? 60;
    this.onChange = opts.onChange;
    this.isAlwaysAllowed = opts.isAlwaysAllowed;
    this.contextTokens = opts.contextTokens ?? 12_000;
    this.team = opts.team;
    this.events = [...(opts.events ?? [])];
    this.messages = [...(opts.messages ?? [])];
    this.turn = this.events.reduce((n, e) => (e.type === "assistant" ? Math.max(n, e.turn) : n), 0);
    this.expireUnanswered();
  }

  /** @returns The session's current state, for clients. */
  info(): AgentSessionInfo {
    return {
      id: this.id,
      status: this.statusValue,
      modelId: this.modelId,
      mode: this.mode,
      ...(this.workspace ? { workspace: this.workspace } : {}),
      pendingApprovals: [...this.approvals.keys()],
      pendingQuestions: [...this.questions.keys()],
      canUndo: this.changes.length > 0,
      grants: this.grants,
      queued: this.queued.map(({ id, text }) => ({ id, text })),
      ...(this.queuePaused ? { queuePaused: true } : {}),
    };
  }

  /** @returns Folders and files this conversation was given access to (from its `access` events). */
  get grants(): string[] {
    return [...new Set(this.events.filter((e): e is Extract<AgentEvent, { type: "access" }> => e.type === "access").map((e) => e.path))];
  }

  /**
   * Gives the agent access to a folder or file outside its workspace, for
   * the rest of this conversation. The user does this by attaching a file
   * or approving a request.
   *
   * @param path - Absolute path that exists.
   * @throws Error if the path does not exist.
   */
  async grant(path: string): Promise<string> {
    const abs = resolvePath(path);
    await stat(abs).catch(() => {
      throw new Error(`${path} does not exist.`);
    });
    if (!this.grants.includes(abs)) this.push({ type: "access", path: abs });
    return abs;
  }

  /** @returns `true` while the agent is working or waiting for the user. */
  get busy(): boolean {
    return this.statusValue === "running" || this.statusValue === "waiting";
  }

  /**
   * Switches the model, e.g. when the user picks another one mid-conversation.
   *
   * @param modelId - Global model id.
   * @param model - Turn function for it.
   */
  setModel(modelId: string, model: ModelTurn): void {
    this.modelId = modelId;
    this.model = model;
    this.toolsUnsupported = false;
    this.onChange?.(this);
  }

  /**
   * Replaces the tools (e.g. after the active models change).
   *
   * @param tools - New tool list, without `ask_user`.
   */
  setTools(tools: AgentTool[]): void {
    this.tools = new Map(tools.map((t) => [t.spec.name, t]));
  }

  /** @param mode - New permission mode; applies to the next tool call. */
  setMode(mode: PermissionMode): void {
    this.mode = mode;
    this.onChange?.(this);
  }

  /**
   * Sends a user message and starts working on it in the background.
   *
   * @param text - The message.
   * @param context - Extra material for the model only (web results), shown to it after the message.
   * @param note - A line for the user about it, e.g. "Searched the web".
   * @throws Error if the agent is still busy with the previous message.
   */
  send(text: string, context?: string, note?: string): void {
    if (this.busy) throw new Error("The agent is still working. Wait for it, or press Stop.");
    // `context` (e.g. web search results) goes to the model with the message, not into the user's bubble.
    this.messages.push({ role: "user", content: context ? `${text}\n\n---\n${context}` : text });
    this.push({ type: "user", text });
    if (note) this.push({ type: "note", text: note });
    void this.run();
  }

  /**
   * Answers an approval request.
   *
   * @param requestId - From the `approval_request` event.
   * @param decision - `allow` once, `always` for the rest of the session, or `deny`.
   * @param feedback - Optional note for the model, e.g. why you denied.
   * @returns `false` if no such request is waiting.
   */
  approve(requestId: string, decision: "allow" | "always" | "deny", feedback?: string): boolean {
    const resolve = this.approvals.get(requestId);
    if (!resolve) return false;
    this.approvals.delete(requestId);
    resolve({ decision, ...(feedback ? { feedback } : {}) });
    return true;
  }

  /**
   * Answers a question the agent asked.
   *
   * @param questionId - From the `question` event.
   * @param text - The answer.
   * @returns `false` if no such question is waiting.
   */
  answer(questionId: string, text: string): boolean {
    const resolve = this.questions.get(questionId);
    if (!resolve) return false;
    this.questions.delete(questionId);
    resolve(text);
    return true;
  }

  /** Stops the current work: aborts the model and the running tool, denies open requests. */
  stop(): void {
    this.abort?.abort();
    for (const id of [...this.approvals.keys()]) this.approve(id, "deny", "The user pressed Stop.");
    for (const id of [...this.questions.keys()]) this.answer(id, "(The user pressed Stop without answering.)");
  }

  /**
   * Reverts the most recent file change the agent made.
   *
   * @returns The reverted path, or `undefined` if there is nothing to undo.
   * @throws Error while the agent is busy.
   */
  async undo(): Promise<string | undefined> {
    if (this.busy) throw new Error("Stop the agent before undoing.");
    const change = this.changes.pop();
    if (!change) return undefined;
    if (change.before === null) await rm(change.path, { force: true });
    else await writeFile(change.path, change.before, "utf8");
    const path = this.workspace ? displayPath(this.workspace, change.path) : change.path;
    this.push({ type: "undo", path, restored: change.before === null ? "deleted" : "previous" });
    this.messages.push({ role: "user", content: `(The user undid your last change to ${path}.)` });
    return path;
  }

  /** Adds a short note to the conversation (shown in grey). */
  note(text: string): void {
    this.push({ type: "note", text });
  }

  /** Records a checkpoint (the app saved the project folder before the next message). */
  checkpoint(id: string, files: number): void {
    this.push({ type: "checkpoint", id, files });
  }

  private push(e: NewEvent, persist = true): AgentEvent {
    const event = { ...e, seq: persist ? this.events.length + 1 : 0, at: new Date().toISOString() } as AgentEvent;
    if (persist) this.events.push(event);
    this.emit("event", event);
    if (persist) this.onChange?.(this);
    return event;
  }

  private setStatus(status: AgentStatus, message?: string): void {
    this.statusValue = status;
    this.push({ type: "status", status, ...(message ? { message } : {}) }, status === "error");
  }

  private expireUnanswered(): void {
    const answered = new Set(this.events.flatMap((e) => (e.type === "approval_result" ? [e.requestId] : e.type === "answer" ? [e.questionId] : [])));
    for (const e of [...this.events]) {
      if (e.type === "approval_request" && !answered.has(e.requestId)) this.push({ type: "approval_result", requestId: e.requestId, decision: "expired" });
      if (e.type === "question" && !answered.has(e.questionId)) this.push({ type: "answer", questionId: e.questionId, text: "(expired)" });
    }
  }

  /**
   * Asks a teammate model (no tools) and shows its answer in the chat.
   *
   * @param member - The teammate.
   * @param system - Its role prompt.
   * @param content - What it should look at.
   * @param signal - Stops it with the session.
   * @param review - Whether this is a review (marks approval).
   * @returns Its text, or `undefined` if it failed (the work goes on without it).
   */
  private async askTeammate(member: TeamMember, system: string, content: string, signal: AbortSignal, review = false): Promise<string | undefined> {
    try {
      const asked: AgentMessage[] = [{ role: "system", content: system }, { role: "user", content }];
      const r = await member.model({ messages: asked, tools: [] }, signal, () => undefined);
      this.recordUsage(member.modelId, member.role, asked, r);
      const text = r.text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (!text) return undefined;
      const approved = review ? /^\s*\**APPROVED/i.test(text) : undefined;
      this.push({ type: "teammate", role: member.role, modelId: member.modelId, text, ...(approved !== undefined ? { approved } : {}) });
      return text;
    } catch (err) {
      if (signal.aborted) throw err;
      this.push({ type: "note", text: `The ${member.role} (${member.modelId}) could not answer: ${(err as Error).message}` });
      return undefined;
    }
  }

  /**
   * Records what one model call cost, as reported by the provider or
   * estimated from the text (about 4 characters per token).
   *
   * @param modelId - The model called.
   * @param role - `main`, or a teammate's role.
   * @param sent - Messages sent.
   * @param result - What came back.
   */
  private recordUsage(modelId: string, role: "main" | TeamRole, sent: AgentMessage[], result: Awaited<ReturnType<ModelTurn>>): void {
    const reported = result.usage?.inputTokens !== undefined && result.usage?.outputTokens !== undefined;
    const input = result.usage?.inputTokens ?? Math.round(sizeOf(sent) / CHARS_PER_TOKEN);
    const output = result.usage?.outputTokens ?? Math.round((result.text.length + JSON.stringify(result.toolCalls).length) / CHARS_PER_TOKEN);
    this.push({ type: "usage", modelId, role, input, output, estimated: !reported, tools: result.toolCalls.map((c) => c.name) });
  }

  /**
   * What the reviewer sees: the request, the actions taken this request
   * (with short results), and the final answer.
   *
   * @param request - The user's message.
   * @param answer - The worker's final answer.
   * @returns The brief.
   */
  private reviewBrief(request: string, answer: string): string {
    const lastUser = this.messages.map((m) => m.role === "user" && m.content === request).lastIndexOf(true);
    const actions = this.messages
      .slice(lastUser + 1)
      .flatMap((m) =>
        m.role === "assistant" && m.toolCalls?.length
          ? m.toolCalls.map((c) => `- ${c.name} ${JSON.stringify(c.arguments).slice(0, 300)}`)
          : m.role === "tool"
            ? [`  → ${m.content.slice(0, 400).replace(/\s+/g, " ")}`]
            : [],
      )
      .slice(-40)
      .join("\n");
    return `The user's request:\n${request}\n\nWhat the worker did:\n${actions || "(no tools used)"}\n\nThe worker's answer:\n${answer}`;
  }

  /**
   * Whether the agent stopped before finishing what the user asked for:
   * it was asked for a program to run (.exe) and did not build one, or it
   * tells the user to save, install or run things itself although it has
   * the tools to do that.
   *
   * @param finalText - The model's last answer.
   * @returns What to tell the model (and a note for the user), or `undefined`.
   */
  private unfinished(finalText: string, nudges: number): { message: string; note: string } | undefined {
    if (this.toolsUnsupported) return undefined;
    const users = this.events.filter((e): e is Extract<AgentEvent, { type: "user" }> => e.type === "user");
    const lastUser = users.at(-1);
    if (!lastUser) return undefined;
    const since = this.events.filter((e) => e.seq > lastUser.seq);
    const built = this.events.some((e) => e.type === "tool_result" && e.name === "build_executable" && e.ok && e.seq > (users.at(-3) ?? lastUser).seq);
    const buildFailed = since.some((e) => e.type === "tool_result" && e.name === "build_executable" && !e.ok);
    // The request may have been made a message or two earlier ("make it an exe" … "continue").
    const wantsProgram = users.slice(-3).some((u) => /\bexe\b|\.exe|executable|installer|setup file|installable|איאקסאי|אקסה|קובץ הפעלה|קובץ הרצה|להתקנה|תוכנה שאפשר להתקין/i.test(u.text));
    if (wantsProgram && !built && buildFailed && this.tools.has("build_executable")) {
      return {
        note: "KesherAI asked the model to fix the build and try again.",
        message:
          "[KesherAI] build_executable failed. Read its error, fix the cause yourself (fix the code, install what is missing with install_tool, or use run_command), then call build_executable again. Do not hand the steps to the user.",
      };
    }
    if (wantsProgram && !built && this.tools.has("build_executable")) {
      return {
        note: "KesherAI asked the model to finish: build the program.",
        message:
          "[KesherAI] The user asked for a program they can run (an .exe), and you have not built it yet. Do it now yourself: make sure the .py file is saved with write_file, check Python with check_tools (install it with install_tool if missing), then call build_executable. Do not tell the user to save, install or build anything themselves.",
      };
    }
    void nudges;
    const handsOff =
      /save (the|this) (code|file)|copy (the|this) code|open (a |the )?(command prompt|terminal|cmd|powershell)|in (a |the |your )?(terminal|command prompt|cmd)|run:?\s*`?(python|py |node|java|npm|pip|pyinstaller)|pip install|pyinstaller --|run the following|type the following|install python from|שמור את הקוד|העתק את הקוד|פתח (את )?(שורת הפקודה|הטרמינל)|בטרמינל|הקלד|הרץ את הפקודה|הרץ:/i.test(finalText);
    if (handsOff && this.tools.has("run_command")) {
      return {
        note: "KesherAI asked the model to do the steps itself instead of handing them to you.",
        message:
          "[KesherAI] Do not ask the user to save files, install tools, open a terminal or run commands: you can do all of that yourself with write_file, install_tool, run_command and build_executable (the user approves commands). Do the remaining steps now, then summarise what you did and where the result is.",
      };
    }
    return undefined;
  }

  /**
   * The messages to send this turn: everything, or — when it is too long for
   * the model — a summary of the oldest part plus the recent turns in full.
   * The stored conversation is never changed.
   */
  private async fitContext(signal: AbortSignal): Promise<AgentMessage[]> {
    const system: AgentMessage = { role: "system", content: this.mode === "plan" ? `${this.systemPrompt}\n\n${PLAN_NOTE}` : this.systemPrompt };
    const budget = this.contextTokens * CHARS_PER_TOKEN - this.systemPrompt.length - 2000;
    const msgs = shortenOldToolOutputs(this.messages);
    if (sizeOf(msgs) <= budget) return [system, ...msgs];
    const cut = cutPoint(msgs, Math.floor(budget * 0.6));
    if (cut <= 0) return [system, ...msgs];
    const last = [...this.events].reverse().find((e): e is Extract<AgentEvent, { type: "compacted" }> => e.type === "compacted");
    let summary = last && last.upTo === cut ? last.summary : undefined;
    if (!summary) {
      // Summarise what is new since the last summary, together with that summary.
      const from = last && last.upTo < cut ? last.upTo : 0;
      const earlier = last && last.upTo < cut ? `Earlier summary:\n${last.summary}\n\nThen:\n` : "";
      try {
        const r = await this.model(
          { messages: [{ role: "system", content: SUMMARY_PROMPT }, { role: "user", content: earlier + transcript(msgs.slice(from, cut), Math.floor(budget * 0.8)) }], tools: [] },
          signal,
          () => undefined,
        );
        summary = r.text.trim();
      } catch {
        summary = undefined;
      }
      if (!summary) return [system, ...msgs.slice(cut)];
      this.push({ type: "compacted", upTo: cut, summary });
    }
    return [{ role: "system", content: `${this.systemPrompt}\n\nSummary of the earlier part of this conversation (the user still sees all of it):\n${summary}` }, ...msgs.slice(cut)];
  }

  private specs(): ToolSpec[] {
    if (this.toolsUnsupported) return [];
    return [askUserSpec, requestAccessSpec, ...(this.mode === "plan" ? [presentPlanSpec] : []), ...[...this.tools.values()].map((t) => t.spec)];
  }

  private async run(): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    this.setStatus("running");
    try {
      let nudges = 0;
      let reviews = 0;
      const team = this.team?.() ?? [];
      const planner = team.find((m) => m.role === "planner");
      const reviewer = team.find((m) => m.role === "reviewer");
      const request = [...this.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      if (planner) {
        const plan = await this.askTeammate(planner, PLANNER_PROMPT, `The user's request:\n${request}`, abort.signal);
        if (plan) this.messages.push({ role: "user", content: `(A plan from your teammate ${planner.modelId}; follow it where it makes sense, the user's words come first.)\n${plan}` });
      }
      for (let step = 0; step < this.maxSteps; step++) {
        abort.signal.throwIfAborted();
        const turn = ++this.turn;
        const conversation = await this.fitContext(abort.signal);
        let result: Awaited<ReturnType<ModelTurn>>;
        try {
          result = await this.model({ messages: conversation, tools: this.specs() }, abort.signal, (text) =>
            this.push({ type: "assistant_delta", turn, text }, false),
          );
        } catch (err) {
          // Many local models reject the `tools` field. Retry once without tools.
          if (!this.toolsUnsupported && /tool|function/i.test((err as Error).message) && !abort.signal.aborted) {
            this.toolsUnsupported = true;
            this.push({ type: "note", text: "This model does not support tools, so it will answer without them (no files, commands or images)." });
            result = await this.model({ messages: conversation, tools: [] }, abort.signal, (text) =>
              this.push({ type: "assistant_delta", turn, text }, false),
            );
          } else throw err;
        }
        this.recordUsage(this.modelId, "main", conversation, result);
        if (result.text) this.push({ type: "assistant", turn, text: result.text });
        this.lastSaid = result.text.trim();
        this.messages.push({ role: "assistant", content: result.text, ...(result.toolCalls.length ? { toolCalls: result.toolCalls } : {}) });
        if (result.toolCalls.length === 0) {
          const nudge = nudges >= 3 ? undefined : this.unfinished(result.text, nudges);
          if (nudge) {
            // Local models often stop and tell the user to do the rest. Send them back to work (up to three times).
            nudges++;
            this.push({ type: "note", text: nudge.note });
            this.messages.push({ role: "user", content: nudge.message });
            continue;
          }
          if (reviewer && reviews < 2) {
            reviews++;
            const review = await this.askTeammate(reviewer, REVIEWER_PROMPT, this.reviewBrief(request, result.text), abort.signal, true);
            if (review && !/^\s*\**APPROVED/i.test(review)) {
              this.messages.push({ role: "user", content: `Your teammate ${reviewer.modelId} reviewed your answer and found problems. Fix them (use your tools), then answer the user again:\n${review}` });
              continue;
            }
          }
          this.setStatus("idle");
          return;
        }
        for (const call of result.toolCalls) {
          this.pendingImages = undefined;
          const output = await this.execute(call, abort.signal);
          const images = this.pendingImages as Array<{ mimeType: string; data: string }> | undefined;
          if (images) {
            // Screenshots are big: only the newest one stays in the conversation.
            for (const m of this.messages) if (m.images) delete m.images;
          }
          this.messages.push({ role: "tool", toolCallId: call.id, toolName: call.name, content: output, ...(images ? { images } : {}) });
        }
        this.onChange?.(this);
      }
      this.push({ type: "note", text: `Stopped after ${this.maxSteps} steps. Send a message to let it continue.` });
      this.setStatus("idle");
    } catch (err) {
      if (abort.signal.aborted) {
        this.push({ type: "note", text: "Stopped." });
        this.setStatus("idle");
      } else {
        this.setStatus("error", err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (this.abort === abort) this.abort = undefined;
      this.onChange?.(this);
    }
  }

  /** Runs one tool call, asking for approval when needed. Returns what the model sees. */
  private async execute(call: ToolCall, signal: AbortSignal): Promise<string> {
    this.push({ type: "tool_call", callId: call.id, name: call.name, input: call.arguments });
    const fail = (message: string) => {
      this.push({ type: "tool_result", callId: call.id, name: call.name, ok: false, output: message });
      return `Error: ${message}`;
    };
    if (typeof call.arguments._invalidJson === "string") return fail("Your tool arguments were not valid JSON. Send them again as a JSON object.");

    if (call.name === ASK_USER_TOOL) {
      const question = typeof call.arguments.question === "string" ? call.arguments.question : "";
      if (!question) return fail('ask_user needs a "question".');
      const options = Array.isArray(call.arguments.options) ? call.arguments.options.filter((o): o is string => typeof o === "string") : undefined;
      const questionId = randomUUID();
      const answer = await new Promise<string>((resolve) => {
        this.questions.set(questionId, resolve);
        this.push({ type: "question", questionId, question, ...(options?.length ? { options } : {}) });
        this.setStatus("waiting");
      });
      this.push({ type: "answer", questionId, text: answer });
      this.setStatus("running");
      this.push({ type: "tool_result", callId: call.id, name: call.name, ok: true, output: answer });
      return answer;
    }

    if (call.name === PRESENT_PLAN_TOOL) {
      const plan = typeof call.arguments.plan === "string" ? call.arguments.plan.trim() : "";
      if (!plan) return fail('present_plan needs a "plan".');
      this.push({ type: "plan", callId: call.id, text: plan });
      this.push({ type: "tool_result", callId: call.id, name: call.name, ok: true, output: "Shown to the user." });
      return "The plan is shown to the user. Stop now: reply with one short sentence and wait. They will approve it (then you carry it out) or ask for changes.";
    }

    if (call.name === REQUEST_ACCESS_TOOL) {
      const reason = typeof call.arguments.reason === "string" ? call.arguments.reason : "";
      const path = typeof call.arguments.path === "string" && call.arguments.path.trim() ? call.arguments.path.trim() : undefined;
      const questionId = randomUUID();
      const answer = await new Promise<string>((resolve) => {
        this.questions.set(questionId, resolve);
        this.push({ type: "question", questionId, question: reason || "The agent asks for access to a folder.", kind: "access", ...(path ? { path } : {}) });
        this.setStatus("waiting");
      });
      this.push({ type: "answer", questionId, text: answer });
      this.setStatus("running");
      const chosen = answer.trim();
      if (!chosen || chosen.startsWith("(")) {
        this.push({ type: "tool_result", callId: call.id, name: call.name, ok: false, output: "Refused." });
        return "The user did not give access. Do not ask again for the same place; continue without it or ask what they prefer.";
      }
      try {
        const granted = await this.grant(chosen);
        this.push({ type: "tool_result", callId: call.id, name: call.name, ok: true, output: granted });
        return `Access granted to ${granted}. Use absolute paths inside it with the file tools.`;
      } catch (err) {
        return fail((err as Error).message);
      }
    }

    const tool = this.tools.get(call.name);
    if (!tool) return fail(`There is no tool called "${call.name}".`);

    const ctx: ToolContext = {
      ...(this.workspace ? { workspace: this.workspace } : {}),
      extraRoots: this.grants,
      signal,
      recordChange: (path, before) => this.changes.push({ path, before }),
    };
    const always = this.alwaysAllowed.has(tool.spec.name) || !!this.isAlwaysAllowed?.(tool.spec.name, this.modelId);
    const verdict = decide(this.mode, tool.risk, always, tool.commandOf?.(call.arguments));
    if (verdict.action === "deny") return fail(verdict.reason);
    if (verdict.action === "ask") {
      let preview = "";
      try {
        preview = (await tool.preview?.(call.arguments, ctx)) ?? JSON.stringify(call.arguments, null, 2);
      } catch (err) {
        return fail((err as Error).message);
      }
      const requestId = randomUUID();
      const { decision, feedback } = await new Promise<{ decision: ApprovalDecision; feedback?: string }>((resolve) => {
        this.approvals.set(requestId, resolve);
        const given = typeof call.arguments.purpose === "string" ? call.arguments.purpose.trim() : "";
        const purpose = (given || this.lastSaid).slice(0, 400);
        const folder = tool.risk === "exec" ? this.workspace : undefined;
        this.push({ type: "approval_request", requestId, callId: call.id, name: call.name, input: call.arguments, preview, reason: verdict.reason, ...(purpose ? { purpose } : {}), ...(folder ? { folder } : {}) });
        this.setStatus("waiting");
      });
      this.push({ type: "approval_result", requestId, decision, ...(feedback ? { feedback } : {}) });
      if (decision === "deny" || decision === "expired") {
        const msg = `The user denied this action.${feedback ? ` Their note: ${feedback}` : ""} Do not retry it unchanged; ask or try another way.`;
        this.push({ type: "tool_result", callId: call.id, name: call.name, ok: false, output: "Denied by you." });
        if (!signal.aborted) this.setStatus("running");
        return msg;
      }
      if (decision === "always") this.alwaysAllowed.add(tool.spec.name);
      this.setStatus("running");
    }

    try {
      const out = await tool.run(call.arguments, ctx);
      const output = truncate(out.output);
      if (out.images?.length) this.pendingImages = out.images;
      this.push({
        type: "tool_result",
        callId: call.id,
        name: call.name,
        ok: true,
        output,
        ...(out.diff ? { diff: out.diff } : {}),
        ...(out.assetIds?.length ? { assetIds: out.assetIds } : {}),
        ...(out.videoIds?.length ? { videoIds: out.videoIds } : {}),
        ...(out.files?.length ? { files: out.files } : {}),
      });
      return output;
    } catch (err) {
      if (signal.aborted) throw err;
      return fail(err instanceof Error ? err.message : String(err));
    }
  }
}
