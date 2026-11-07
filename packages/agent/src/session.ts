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
  ToolSpec,
} from "@kesher/shared";
import { decide } from "./permissions.js";
import { ASK_USER_TOOL, REQUEST_ACCESS_TOOL, askUserSpec, requestAccessSpec, truncate, type AgentTool, type ToolContext } from "./tools.js";
import { stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { displayPath } from "./workspace.js";

/** One model turn: give it the conversation and tools, get text and tool calls back. */
export type ModelTurn = (
  request: { messages: AgentMessage[]; tools: ToolSpec[] },
  signal: AbortSignal,
  onText: (delta: string) => void,
) => Promise<{ text: string; toolCalls: ToolCall[] }>;

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
  private readonly changes: Array<{ path: string; before: string | null }> = [];
  private toolsUnsupported = false;

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
   * @throws Error if the agent is still busy with the previous message.
   */
  send(text: string): void {
    if (this.busy) throw new Error("The agent is still working. Wait for it, or press Stop.");
    this.messages.push({ role: "user", content: text });
    this.push({ type: "user", text });
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
   * Whether the agent stopped before finishing what the user asked for:
   * it was asked for a program to run (.exe) and did not build one, or it
   * tells the user to save, install or run things itself although it has
   * the tools to do that.
   *
   * @param finalText - The model's last answer.
   * @returns What to tell the model (and a note for the user), or `undefined`.
   */
  private unfinished(finalText: string): { message: string; note: string } | undefined {
    if (this.toolsUnsupported) return undefined;
    const lastUser = [...this.events].reverse().find((e) => e.type === "user");
    if (!lastUser || lastUser.type !== "user") return undefined;
    const since = this.events.filter((e) => e.seq > lastUser.seq);
    const built = since.some((e) => e.type === "tool_result" && e.name === "build_executable" && e.ok);
    const triedBuild = since.some((e) => e.type === "tool_call" && e.name === "build_executable");
    const wantsProgram = /\bexe\b|\.exe|executable|installer|setup file|installable|איאקסאי|אקסה|קובץ הפעלה|קובץ הרצה|להתקנה|תוכנה שאפשר להתקין/i.test(lastUser.text);
    if (wantsProgram && !built && !triedBuild && this.tools.has("build_executable")) {
      return {
        note: "KesherAI asked the model to finish: build the program.",
        message:
          "[KesherAI] The user asked for a program they can run (an .exe), and you have not built it yet. Do it now yourself: make sure the .py file is saved with write_file, check Python with check_tools (install it with install_tool if missing), then call build_executable. Do not tell the user to save, install or build anything themselves.",
      };
    }
    const handsOff = /save (the|this) (code|file)|copy (the|this) code|open (a |the )?(command prompt|terminal|cmd)|run:?\s*`?(python|node|java|npm)|install python from|שמור את הקוד|העתק את הקוד|פתח (את )?שורת הפקודה/i.test(finalText);
    if (handsOff && this.tools.has("run_command")) {
      return {
        note: "KesherAI asked the model to do the steps itself instead of handing them to you.",
        message:
          "[KesherAI] Do not ask the user to save files, install tools, open a terminal or run commands: you can do all of that yourself with write_file, install_tool, run_command and build_executable (the user approves commands). Do the remaining steps now, then summarise what you did and where the result is.",
      };
    }
    return undefined;
  }

  private specs(): ToolSpec[] {
    if (this.toolsUnsupported) return [];
    return [askUserSpec, requestAccessSpec, ...[...this.tools.values()].map((t) => t.spec)];
  }

  private async run(): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    this.setStatus("running");
    try {
      let nudged = false;
      for (let step = 0; step < this.maxSteps; step++) {
        abort.signal.throwIfAborted();
        const turn = ++this.turn;
        const conversation: AgentMessage[] = [{ role: "system", content: this.systemPrompt }, ...this.messages];
        let result: { text: string; toolCalls: ToolCall[] };
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
        if (result.text) this.push({ type: "assistant", turn, text: result.text });
        this.messages.push({ role: "assistant", content: result.text, ...(result.toolCalls.length ? { toolCalls: result.toolCalls } : {}) });
        if (result.toolCalls.length === 0) {
          const nudge = nudged ? undefined : this.unfinished(result.text);
          if (nudge) {
            // Local models often stop and tell the user to do the rest. Send them back to work, once per message.
            nudged = true;
            this.push({ type: "note", text: nudge.note });
            this.messages.push({ role: "user", content: nudge.message });
            continue;
          }
          this.setStatus("idle");
          return;
        }
        for (const call of result.toolCalls) {
          const output = await this.execute(call, abort.signal);
          this.messages.push({ role: "tool", toolCallId: call.id, toolName: call.name, content: output });
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
    const verdict = decide(this.mode, tool.risk, this.alwaysAllowed.has(tool.spec.name), tool.commandOf?.(call.arguments));
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
        this.push({ type: "approval_request", requestId, callId: call.id, name: call.name, input: call.arguments, preview, reason: verdict.reason });
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
      this.push({
        type: "tool_result",
        callId: call.id,
        name: call.name,
        ok: true,
        output,
        ...(out.diff ? { diff: out.diff } : {}),
        ...(out.assetIds?.length ? { assetIds: out.assetIds } : {}),
      });
      return output;
    } catch (err) {
      if (signal.aborted) throw err;
      return fail(err instanceof Error ? err.message : String(err));
    }
  }
}
