import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import type {
  AgentEvent,
  AskItem,
  AgentMessage,
  AgentSessionInfo,
  AgentStatus,
  HelperRunInfo,
  JobProgress,
  ApprovalDecision,
  PermissionMode,
  ToolCall,
  TeamRole,
  ToolSpec,
  QueuedMessage,
} from "@kesher/shared";
import { takeSteers } from "@kesher/shared";
import { dangerReason, decide } from "./permissions.js";
import type { Reviewer } from "./reviewer.js";
import { CHARS_PER_TOKEN, SUMMARY_PROMPT, cutPoint, shortenOldToolOutputs, sizeOf, transcript } from "./context.js";
import { DEFAULT_TOOL_CAP, OPEN_CHARS, PRUNED_MARK, SUPERSEDED_MARK, TOOL_OUTPUT_TOOL, capTools, openToolOutput, pinnedBefore, pinnedOutputs, pruneToolOutputs } from "./budget.js";
import { ASK_USER_TOOL, makeDiff, undoHunk, PRESENT_PLAN_TOOL, REQUEST_ACCESS_TOOL, askUserSpec, presentPlanSpec, requestAccessSpec, truncate, type AgentTool, type GateResult, type ToolContext } from "./tools.js";

/** Added to the system prompt in plan mode. */
const PLAN_NOTE =
  "PLAN MODE is on. Do not change anything: no file edits, no commands that change things (those tools are refused). Look around with the read-only tools (list, read and search files) until you understand what is needed, ask the user with ask_user if a choice is theirs, then call present_plan with a clear, numbered plan. After that, stop and wait.";
import { stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { displayPath } from "./workspace.js";
import { neutralizeLinks } from "./answer-links.js";

/**
 * Tool specs sorted by name (a copy), so the tool list sent to the model does not depend on the order tools were
 * registered in and the prompt's start stays the same between turns (the engine's prompt cache).
 *
 * @param specs - The tool specs.
 * @returns A new array, sorted by `name`.
 */
export function sortSpecs(specs: readonly ToolSpec[]): ToolSpec[] {
  return [...specs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** One model turn: give it the conversation and tools, get text and tool calls back. */
export type ModelTurn = (
  request: { messages: AgentMessage[]; tools: ToolSpec[] },
  signal: AbortSignal,
  onText: (delta: string) => void,
) => Promise<{ text: string; toolCalls: ToolCall[]; usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; cacheWriteTokens?: number }; truncated?: boolean }>;

/**
 * A local server (llama.cpp) refusing the model's whole answer because a tool call in it was not in the model's own
 * format ("The model produced output that does not match the expected peg-native format"; seen after
 * many web searches in one chat). Asking again usually works.
 */
const BROKEN_FORMAT = /does not match the expected [\w-]+ format|failed to parse (?:the )?(?:tool call|model output)/i;

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
/**
 * What an outside coding agent (one that runs its own tools, e.g. Antigravity CLI over ACP) gets to show its
 * turn in the conversation: streamed text, its tool steps, its plan, and approval questions that become
 * KesherAI's own approval cards (so the notifications page and the phone can answer them too).
 */
export interface ExternalIO {
  /** More of the answer. */
  text: (delta: string) => void;
  /** A tool step started or changed. A finished step (`ok` set) shows its output and diff. */
  tool: (step: { id: string; name: string; input?: Record<string, unknown>; ok?: boolean; output?: string; diff?: string }) => void;
  /** The agent's plan (shown like a note). */
  plan: (text: string) => void;
  /** Asks the user; resolves with their answer. */
  approve: (req: { callId: string; name: string; preview: string; reason: string }) => Promise<"allow" | "always" | "deny">;
}

/** An outside agent that answers a message by itself (see {@link ExternalIO}). */
export interface ExternalAgent {
  turn: (text: string, io: ExternalIO, signal: AbortSignal) => Promise<void>;
}

/** How a session is set up. */
export interface AgentSessionOptions {
  id: string;
  /**
   * The model team's language layer (core answer-language.ts): the final answer in the user's language when the model
   * answered in another one or mixed alphabets. Undefined leaves the answer as it is.
   */
  polishAnswer?: (answer: string, userText: string, signal: AbortSignal) => Promise<string | undefined>;
  /** Whether a stored file exists, so a link to a made-up file id is taken out of the answer (answer-links.ts). */
  assetExists?: (id: string) => boolean | Promise<boolean>;
  modelId: string;
  model: ModelTurn;
  /** Set for a conversation run by an outside agent: `model` and the tools are then not used. */
  external?: ExternalAgent;
  mode: PermissionMode;
  /** Absolute folder for file and terminal tools. */
  workspace?: string;
  /** Tools besides `ask_user`, which every session has. */
  tools: AgentTool[];
  /** System prompt, rebuilt by the caller for every session. */
  systemPrompt: string;
  /** Stop after this many model turns per user message (default 60). */
  maxSteps?: number;
  /**
   * The last of `maxSteps` gets no tools and a note to write the report (OpenCode's `steps`): helpers on small
   * models loop otherwise, and end with nothing to hand back.
   */
  finalStepReport?: boolean;
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
  /**
   * Whether a saved rule allows this tool (for a command: its text, matched against command rules; `input`: the
   * call's arguments, for rules kept for one folder, site or app).
   */
  isAlwaysAllowed?(tool: string, modelId: string, command?: string, scope?: string, input?: Record<string, unknown>): boolean;
  /**
   * Smart auto approvals (F10): in "auto-edit", a command that would ask goes to this reviewer first; read on each
   * call, so turning it on or off applies at once. Undefined: the person is asked, as before.
   */
  reviewer?: () => Reviewer | undefined;
  /** "Always" given for a scope (a web site): the app keeps it (Settings lists it and can take it back). */
  onAlwaysScope?(scope: string): void;
  /** A helper's session: its name, for tools that decide by who asks (browser and computer gates). */
  helperName?: string;
  /** Environment variables for the session's commands (read on each command). */
  env?(): Record<string, string>;
  /** The chat's web search settings (read on each tool call). */
  web?(): import("@kesher/shared").WebPrefs | undefined;
  /** Opens a page through Tor (read on each tool call; absent when Tor is off for this chat). */
  viaTor?(): ((url: string, signal: AbortSignal) => Promise<{ url: string; status: number; type: string; body: string }>) | undefined;
  /** How many tokens the model can read (default 12 000, which fits a 16k-context local model). */
  contextTokens?: number;
  /** Models that plan before and review after the main one (multi-model chat). Read on every request. */
  team?: () => TeamMember[];
  /**
   * Tool search (for small local models with many tools): only these tools are
   * sent in full; the others are listed by name in `find_tools`, which loads
   * them when the model needs them. Read on every request; empty = off.
   */
  toolSearch?: () => readonly string[] | undefined;
  /**
   * With tool search: the most tools sent in full per turn (default 24); the rest are listed in `more_tools`. Read on
   * every request. See capTools in budget.ts.
   */
  toolCap?: () => number | undefined;
  /**
   * Routing by meaning: before the model answers a message, the tools it points at (by Hebrew and English words, or a
   * tiny model call) are loaded, and `note` (e.g. "an image model is not installed") goes to the model with it.
   * Read once per message; a failure or no answer leaves the message as it was.
   */
  route?: (text: string, signal: AbortSignal) => Promise<{ tools: readonly string[]; note?: string; /** Tools held back for this message (a pure create request needs no web search). */ hide?: readonly string[]; /** A smaller model for a simple turn (see SMALL_TURN_CHARS). */ small?: { modelId: string; model: ModelTurn } } | undefined>;
  /**
   * Keeps each run's files from before it (for "Undo all" on its receipt, after a restart too). Without it they are
   * kept in memory only.
   */
  undoStore?: UndoStore;
}

/** A run's files as they were before it, and a fingerprint of each as the run left it. */
export interface RunFiles {
  files: Array<{ path: string; before: string | null; after: string }>;
}

/** Where the files a run changed are kept (by run id). */
export interface UndoStore {
  save(run: string, files: RunFiles): Promise<void>;
  load(run: string): Promise<RunFiles | undefined>;
  remove(run: string): Promise<void>;
}

/** Words in many tools' names: they do not point at one tool (loadToolsFor). */
const COMMON_TOOL_WORDS = new Set(["make", "get", "set", "list", "read", "write", "edit", "find", "open", "run", "use", "add", "file", "files", "the", "new", "change", "graph", "graphs", "status", "tool", "tools", "web", "search", "fetch", "computer", "app", "unity", "unreal", "project", "code", "check"]);

/** A content fingerprint ("none" for no file). */
const print = (text: string | null): string => (text === null ? "none" : createHash("sha1").update(text).digest("hex"));

/** Lines added and removed between two texts (each line counted as many times as it appears). */
export function lineDelta(before: string, after: string): { added: number; removed: number } {
  const count = new Map<string, number>();
  // A last line break ends the last line; it does not start one more.
  const lines = (t: string) => (t ? t.replace(/\r?\n$/, "").split(/\r?\n/) : []);
  const a = lines(before);
  const b = lines(after);
  for (const l of a) count.set(l, (count.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of b) {
    const n = count.get(l) ?? 0;
    if (n > 0) count.set(l, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of count.values()) removed += n;
  return { added, removed };
}

/** Opens an older tool output that is sent as a summary line (budget.ts). */
const toolOutputSpec: ToolSpec = {
  name: TOOL_OUTPUT_TOOL,
  description: `Opens the full output of an earlier tool call that is shown to you as a "${PRUNED_MARK} <id>]" line. Use it only when you need that output's details again; at most ${OPEN_CHARS} characters at a time.`,
  inputSchema: { type: "object", properties: { id: { type: "string", description: "The id from the line." }, from: { type: "number", description: "The first character, for the rest of a long output (default 0)." } }, required: ["id"] },
};

/**
 * Model size per turn: a simple message (the router's pick) is answered by a smaller loaded model, with no tools, only
 * while the conversation is this short (characters), since the small model reads it all without a warm cache.
 */
const SMALL_TURN_CHARS = 16_000;

/** The tool that loads the others when tool search is on (the per-turn cap's overflow is listed in it too). */
export const FIND_TOOLS_TOOL = "more_tools";
/** Its earlier name: still answered, for saved chats whose model learned it. */
const OLD_FIND_TOOLS = "find_tools";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** What the model reads on its next turn, for the context explorer. */
export interface ContextView {
  /** How much the model can read. */
  windowTokens: number;
  system: { tokens: number; text: string };
  tools: Array<{ name: string; tokens: number }>;
  messages: Array<{ role: AgentMessage["role"]; tokens: number; text: string; toolCalls?: string[]; toolName?: string; images?: number; shortened?: boolean; summarized?: boolean; /** Sent as a summary line (budget.ts). */ pruned?: boolean }>;
  /** The summary that stands in for the oldest messages, when the conversation is too long. */
  summary?: string;
  /** About how much the next turn sends. */
  totalTokens: number;
}

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
  /**
   * When set, the messages the model gets this turn instead of the stored conversation (which is never changed). A
   * turn a guest started in a shared chat sets it, so only the chat's visible thread goes to the model. The caller
   * clears it when the turn ends.
   */
  viewMessages: ((messages: readonly AgentMessage[]) => AgentMessage[]) | undefined;
  /**
   * When set, how a user message someone other than the owner wrote (a guest in a shared chat) is shown where the
   * session re-reads its own messages for another model (the summary of the earlier part, the reviewer's brief): its
   * speaker named and its words marked as untrusted. Returns undefined for the owner's own messages.
   */
  untrustedUser: ((content: string) => string | undefined) | undefined;
  private model: ModelTurn;
  private readonly external?: ExternalAgent;
  private tools: Map<string, AgentTool>;
  private readonly maxSteps: number;
  private readonly finalStepReport: boolean;
  /** Notes for the model's next turn (a background helper's report), added before it is asked. */
  private readonly inbox: string[] = [];
  private readonly onChange?: (s: AgentSession) => void;
  private statusValue: AgentStatus = "idle";
  private readonly reviewerOf?: () => Reviewer | undefined;
  private readonly polishAnswer?: AgentSessionOptions["polishAnswer"];
  private readonly assetExists?: AgentSessionOptions["assetExists"];
  private abort?: AbortController;
  private turn = 0;
  private readonly approvals = new Map<string, (d: { decision: ApprovalDecision; feedback?: string }) => void>();
  private readonly questions = new Map<string, (text: string) => void>();
  private readonly alwaysAllowed = new Set<string>();
  private readonly isAlwaysAllowed?: (tool: string, modelId: string, command?: string, scope?: string, input?: Record<string, unknown>) => boolean;
  private readonly onAlwaysScope?: (scope: string) => void;
  private readonly helperName?: string;
  private readonly envOf?: () => Record<string, string>;
  private readonly webOf?: () => import("@kesher/shared").WebPrefs | undefined;
  private readonly torOf?: AgentSessionOptions["viaTor"];
  /** Tokens the model can read; see {@link AgentSessionOptions.contextTokens}. */
  contextTokens: number;
  private changes: Array<{ path: string; before: string | null }> = [];
  private readonly undoStore?: UndoStore;
  /** The runs' receipts this session made (kept in memory too, for a store that fails). */
  private readonly runs = new Map<string, RunFiles>();
  private toolsUnsupported = false;
  private readonly team?: () => TeamMember[];
  private readonly toolSearch?: () => readonly string[] | undefined;
  private readonly toolCap?: () => number | undefined;
  private readonly route?: AgentSessionOptions["route"];
  /** Tools not offered for the current message (the router's `hide`). */
  private hidden = new Set<string>();
  /** The message waiting for the router (set by send, routed at the start of the run). */
  private routeText?: string;
  /** How many times each changing action ran for the current message (the loop guard). */
  private readonly repeats = new Map<string, number>();
  /** Tools the model loaded with find_tools in this conversation. */
  private readonly loadedTools = new Set<string>();
  /** When each loaded tool was last loaded (a counter), and the counter at the start of this message (capTools). */
  private readonly toolRank = new Map<string, number>();
  private rankTick = 0;
  private rankSince = 0;
  /** The smaller model for this message's first step, when the router found it simple. */
  private smallTurn?: { modelId: string; model: ModelTurn };
  /** Characters of tool instructions the per-turn cap left out of the last request. */
  private lastCappedChars = 0;

  /** Loads a tool for tool search and marks it as the newest (the per-turn cap ranks by it). */
  private loadTool(name: string): void {
    this.loadedTools.add(name);
    this.toolRank.set(name, ++this.rankTick);
  }
  /**
   * Messages sent while the agent was busy, in order; the owner (the conversation manager) drains it. Those marked
   * `steer` join the running turn at its next step instead (chat-queue.ts); any left when it ends are sent as usual.
   */
  queued: Array<QueuedMessage & { data?: unknown }> = [];
  /** Set after Stop: the queue waits until the user sends again. */
  queuePaused = false;

  /** Whether a running turn takes steering at its next step (an outside agent runs its own loop: it does not). */
  get canSteer(): boolean {
    return !this.external;
  }

  /** Tells listeners the queue changed (a `queue` event, not saved, followed by info). */
  queueChanged(): void {
    this.push({ type: "queue" }, false);
  }

  /**
   * Puts the queued messages marked `steer` into the running turn: each shows as the user's message and the model
   * reads them before its next step, as one note that the user changed course. Called between steps only.
   *
   * @returns How many went in.
   */
  injectSteers(): number {
    const { steer, rest } = takeSteers(this.queued);
    if (!steer.length) return 0;
    this.queued = rest;
    for (const m of steer) this.push({ type: "user", text: m.text, steered: true });
    const said = steer.map((m) => m.text).join("\n\n");
    this.messages.push({ role: "user", content: `[KesherAI] The user wrote this while you were working. Take it into account from now on (it may change what to do next):\n${said}` });
    this.queueChanged();
    return steer.length;
  }
  /** Pictures the tool that just ran returned, for its tool message. */
  private pendingImages?: Array<{ mimeType: string; data: string }>;
  /** The same failure seen in this run, by its key (the loop guard). */
  private failures = new Map<string, number>();
  /** What the model said in its latest answer, shown on approval cards as the reason for the action. */
  private lastSaid = "";

  /** @param opts - See {@link AgentSessionOptions}. */
  constructor(opts: AgentSessionOptions) {
    super();
    this.id = opts.id;
    this.modelId = opts.modelId;
    this.model = opts.model;
    if (opts.external) this.external = opts.external;
    this.mode = opts.mode;
    if (opts.workspace) this.workspace = opts.workspace;
    this.systemPrompt = opts.systemPrompt;
    this.tools = new Map(opts.tools.map((t) => [t.spec.name, t]));
    this.maxSteps = opts.maxSteps ?? 60;
    this.finalStepReport = opts.finalStepReport ?? false;
    this.onChange = opts.onChange;
    this.isAlwaysAllowed = opts.isAlwaysAllowed;
    this.reviewerOf = opts.reviewer;
    this.polishAnswer = opts.polishAnswer;
    this.assetExists = opts.assetExists;
    this.onAlwaysScope = opts.onAlwaysScope;
    this.helperName = opts.helperName;
    this.envOf = opts.env;
    this.webOf = opts.web;
    this.torOf = opts.viaTor;
    this.contextTokens = opts.contextTokens ?? 12_000;
    this.team = opts.team;
    if (opts.undoStore) this.undoStore = opts.undoStore;
    this.toolSearch = opts.toolSearch;
    this.toolCap = opts.toolCap;
    this.route = opts.route;
    this.events = [...(opts.events ?? [])];
    this.messages = [...(opts.messages ?? [])];
    this.turn = this.events.reduce((n, e) => (e.type === "assistant" ? Math.max(n, e.turn) : n), 0);
    this.savedTokens = this.events.reduce((n, e) => (e.type === "usage" && e.pruned ? n + e.pruned : n), 0);
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
      queued: this.queued.map(({ id, text, steer }) => ({ id, text, ...(steer ? { steer: true } : {}) })),
      ...(this.queuePaused ? { queuePaused: true } : {}),
      ...(this.external ? { canSteer: false } : {}),
      contextTokens: this.contextTokens,
      ...(this.savedTokens > 0 ? { savedTokens: this.savedTokens } : {}),
    };
  }

  /** @returns Folders and files this conversation was given access to (from its `access` events). */
  get grants(): string[] {
    return [...new Set(this.events.filter((e): e is Extract<AgentEvent, { type: "access" }> => e.type === "access").map((e) => e.path))];
  }

  /** No one is there to answer (self-work): questions and access requests are answered at once, not waited for. */
  private unattended = false;

  /**
   * Marks the session as running with no one watching (self-work): ask_user gets "decide yourself", and a request
   * for a folder outside the project is refused, instead of the run waiting all night.
   */
  setUnattended(on: boolean): void {
    this.unattended = on;
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

  /** @returns The names of the tools this session has now (sorted). */
  toolNames(): string[] {
    return [...this.tools.keys()].sort();
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
  send(text: string, context?: string, note?: string, steps: NewEvent[] = [], images?: Array<{ mimeType: string; data: string }>): void {
    if (this.busy) throw new Error("The agent is still working. Wait for it, or press Stop.");
    // `context` (e.g. web search results, an attached PDF's text) goes to the model with the message, not into the
    // user's bubble; `images` (attached pictures) go with it too.
    // Pictures are big: only the newest stay in the conversation (as with screenshots).
    if (images?.length) for (const m of this.messages) if (m.images) delete m.images;
    this.messages.push({ role: "user", content: context ? `${text}\n\n---\n${context}` : text, ...(images?.length ? { images } : {}) });
    this.repeats.clear();
    this.rankSince = this.rankTick;
    this.loadToolsFor(text);
    this.routeText = text;
    this.push({ type: "user", text });
    // Steps done for the message before the model starts (the search the globe button asked for), shown like its own.
    for (const st of steps) this.push(st);
    if (note) this.push({ type: "note", text: note });
    void this.run();
  }

  /**
   * Writes the last answer again ("another answer"). The model sees the
   * conversation up to the user's last message; the earlier answer stays in
   * the events, so the user can switch between versions.
   */
  regenerate(): void {
    if (this.busy) throw new Error("The agent is still working. Wait for it, or press Stop.");
    // A steered message (sent during the turn) belongs to that turn: the turn's own message is the one answered again.
    const user = [...this.events].reverse().find((e): e is Extract<AgentEvent, { type: "user" }> => e.type === "user" && !e.steered);
    if (!user) throw new Error("There is no message to answer again.");
    let at = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i]!;
      if (m.role === "user" && typeof m.content === "string" && m.content.startsWith(user.text)) {
        at = i;
        break;
      }
    }
    if (at < 0) throw new Error("That answer is too far back to write again.");
    this.messages.splice(at + 1);
    this.push({ type: "regenerated", ofUser: user.seq });
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
   * Shows another session's approval request in this chat (a sub-agent's step), so the user answers it on the chat's
   * own card, the phone and the notifications, with the same buttons. The answer comes back through `approve`.
   *
   * @param req - The sub-agent's request (its `helper` names who asks), with its own request id when it has one.
   * @param signal - Aborts when the sub-agent stops: the card is closed as expired.
   * @returns The user's decision ("expired" when the sub-agent stopped first).
   */
  relayApproval(req: Omit<Extract<AgentEvent, { type: "approval_request" }>, "type" | "requestId" | "seq" | "at"> & { requestId?: string }, signal?: AbortSignal): Promise<{ decision: ApprovalDecision; feedback?: string }> {
    const requestId = req.requestId && !this.approvals.has(req.requestId) ? req.requestId : randomUUID();
    return new Promise((resolve) => {
      let answered = false;
      const done = (d: { decision: ApprovalDecision; feedback?: string }) => {
        if (answered) return;
        answered = true;
        // `approve` already took it off the list; an expiry takes it off here.
        this.approvals.delete(requestId);
        signal?.removeEventListener("abort", expire);
        this.push({ type: "approval_result", requestId, decision: d.decision, ...(d.feedback ? { feedback: d.feedback } : {}) });
        // Back to working (the chat waits for the sub-agent) or idle, unless something else still waits for the user.
        if (this.statusValue === "waiting" && !this.approvals.size && !this.questions.size) this.setStatus(this.abort ? "running" : "idle");
        resolve(d);
      };
      const expire = () => done({ decision: "expired" });
      this.approvals.set(requestId, done);
      if (signal?.aborted) return expire();
      signal?.addEventListener("abort", expire, { once: true });
      this.push({ type: "approval_request", ...req, requestId });
      this.setStatus("waiting");
    });
  }

  /** The user's last three messages as they typed them (without attached files), oldest first. */
  private askedLately(): string[] {
    return this.messages.filter((m) => m.role === "user" && typeof m.content === "string").slice(-3).map((m) => String(m.content).split("\n\n---\n")[0]!.trim());
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

  /**
   * Remembers a file change made outside the model's tools (a sub-agent's hunks the user accepted), so the chat's
   * Undo can put the file back.
   *
   * @param path - The file's full path.
   * @param before - Its text before the change (`null` when it did not exist).
   */
  rememberChange(path: string, before: string | null): void {
    this.changes.push({ path, before });
  }

  /**
   * Hands the model a note at its next turn (a background helper's report): in this run when it is working,
   * otherwise with the next message. The user sees it in the helper's card, not as a message.
   *
   * @param text - What the model should read, already short.
   */
  deliver(text: string): void {
    this.inbox.push(text);
  }

  /**
   * Wakes the idle model with a note (a background helper ended while the chat was idle, as Claude's lead does): a
   * grey line for the user, and one run of the model with the note, so it goes on with the report. Busy, or an
   * outside agent (which only the user messages), it waits for the next turn instead, as `deliver`.
   *
   * @param text - What the model should read, already short.
   * @param note - The grey line in the thread (both languages).
   * @returns Whether the model was woken.
   */
  wake(text: string, note: string): boolean {
    this.inbox.push(text);
    if (this.busy || this.external) return false;
    this.push({ type: "note", text: note });
    void this.run();
    return true;
  }

  /**
   * Tells the clients the chat's helper runs changed (a `helpers` event, not saved).
   *
   * @param runs - All of the chat's runs now.
   */
  helpersChanged(runs: HelperRunInfo[]): void {
    this.push({ type: "helpers", runs }, false);
  }

  /**
   * Saves what one ended helper run used (a `helper_usage` event, not shown in the thread), for the Usage page.
   *
   * @param u - The run's id, type, model, how it ended and its token totals.
   */
  helperUsage(u: Omit<Extract<AgentEvent, { type: "helper_usage" }>, "type" | "seq" | "at">): void {
    this.push({ type: "helper_usage", ...u });
  }

  /**
   * Shows which model "Auto" picked for the coming reply, and why (a grey line above it).
   *
   * @param modelId - The picked model.
   * @param why - A strength id (model-router.ts) or `general`.
   * @param loadSec - With a swap of the big local model: about how long the load takes.
   */
  routed(modelId: string, why: string, loadSec?: number): void {
    this.push({ type: "routed", modelId, why, ...(loadSec ? { loadSec } : {}) });
  }

  /** Adds a short note to the conversation (shown in grey). */
  note(text: string): void {
    this.push({ type: "note", text });
  }

  /** Records a checkpoint (the app saved the project folder before the next message). */
  checkpoint(id: string, files: number): void {
    this.push({ type: "checkpoint", id, files });
  }

  /**
   * Live output of one running tool, sent to the clients at most every half second (not saved), and at most
   * the last 4000 characters of each batch, so a chatty build does not flood the page.
   */
  private liveOutput(callId: string): (text: string) => void {
    let pending = "";
    let timer: NodeJS.Timeout | undefined;
    return (text: string) => {
      pending = (pending + text).slice(-4000);
      timer ??= setTimeout(() => {
        timer = undefined;
        const t = pending;
        pending = "";
        if (t) this.push({ type: "tool_output", callId, text: t }, false);
      }, 500);
    };
  }

  /**
   * A media job's progress for one running tool, sent to the clients (not saved): the step and phase at once when they
   * change, a new preview frame at most once a second (frames are small pictures, but a fast sampler sends many).
   */
  private jobProgress(callId: string): (p: JobProgress) => void {
    let lastFrame = 0;
    let last = "";
    return (p: JobProgress) => {
      const now = Date.now();
      const frame = p.preview && now - lastFrame >= 1000 && p.preview.length <= 300_000 ? p.preview : undefined;
      const key = `${p.phase ?? ""}|${p.step ?? ""}|${p.steps ?? ""}`;
      if (!frame && key === last) return;
      if (frame) lastFrame = now;
      last = key;
      const { preview: _drop, ...rest } = p;
      this.push({ type: "tool_progress", callId, progress: { ...rest, ...(frame ? { preview: frame } : {}) } }, false);
    };
  }

  /**
   * Runs one tool now, without a model turn: the chat's inline action buttons under a result ("Upscale",
   * "4 variations", "Import to Unity"). The call goes through the same checks as the model's own (mode, always-ask
   * rules, the approval card), shows as a step in the thread, and the model reads about it on its next turn (through
   * the inbox), so pressing a button spends no tokens.
   *
   * @param name - The tool's name: one of the session's tools, or `opts.extra`'s.
   * @param input - Its arguments.
   * @param opts - `extra`: a tool only the buttons offer (not in the model's list); `times`: how many runs, 1–4
   *   (variations), each a new step.
   * @returns Each run's result.
   * @throws Error while the agent is busy, or for a tool the session does not have.
   */
  async runDirect(name: string, input: Record<string, unknown>, opts: { extra?: AgentTool; times?: number } = {}): Promise<Array<{ ok: boolean; output: string }>> {
    if (this.busy) throw new Error("The agent is still working. Wait for it, or press Stop.");
    if (opts.extra && opts.extra.spec.name !== name) throw new Error("The extra tool's name does not match.");
    if (!opts.extra && !this.tools.has(name)) throw new Error(`There is no tool called "${name}" in this chat.`);
    const had = opts.extra ? this.tools.get(name) : undefined;
    if (opts.extra) this.tools.set(name, opts.extra);
    const changedFrom = this.changes.length;
    const abort = new AbortController();
    this.abort = abort;
    this.repeats.clear();
    this.setStatus("running");
    const results: Array<{ ok: boolean; output: string }> = [];
    try {
      const times = Math.min(4, Math.max(1, Math.round(opts.times ?? 1)));
      for (let i = 0; i < times && !abort.signal.aborted; i++) {
        const id = `direct-${randomUUID()}`;
        const output = await this.execute({ id, name, arguments: { ...input } }, abort.signal);
        const done = this.events.findLast((e) => e.type === "tool_result" && e.callId === id);
        results.push({ ok: done?.type === "tool_result" ? done.ok : false, output });
      }
      if (abort.signal.aborted) this.push({ type: "note", text: "Stopped." });
      this.setStatus("idle");
    } catch (err) {
      if (abort.signal.aborted) {
        this.push({ type: "note", text: "Stopped." });
        this.setStatus("idle");
      } else {
        this.setStatus("error", err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (opts.extra) {
        if (had) this.tools.set(name, had);
        else this.tools.delete(name);
      }
      if (this.abort === abort) this.abort = undefined;
      const said = results.map((r) => `${r.ok ? "ok" : "failed"}: ${r.output.slice(0, 300)}`).join("\n");
      this.inbox.push(`The user pressed a button under a result that ran ${name} ${JSON.stringify(input).slice(0, 300)} without you. ${said || "It was stopped."}`);
      await this.receipt(changedFrom).catch(() => undefined);
      this.onChange?.(this);
    }
    return results;
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
   * After the server rejected a malformed answer: ask the same thing once more, and if it breaks again, ask for a
   * plain answer without tools from what the steps already found (so the chat ends with an answer, not an error).
   *
   * @param conversation - What was sent.
   * @param signal - Stops it with the session.
   * @param onText - Streams the new answer.
   * @returns The model's turn.
   */
  private async recoverBrokenFormat(conversation: AgentMessage[], signal: AbortSignal, onText: (delta: string) => void): ReturnType<ModelTurn> {
    this.push({ type: "note", text: "The model wrote a step in a broken format; KesherAI asked it again." });
    try {
      return await this.model({ messages: conversation, tools: this.specs() }, signal, onText);
    } catch (again) {
      if (!BROKEN_FORMAT.test((again as Error).message) || signal.aborted) throw again;
    }
    this.push({ type: "note", text: "It broke again, so it answers from what it already found, without more steps." });
    const plain: AgentMessage = { role: "user", content: "[KesherAI] Your last reply could not be read (a tool call in a broken format). Do not call tools now: answer the user in plain text from what you already found." };
    return await this.model({ messages: [...conversation, plain], tools: [] }, signal, onText);
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
   * @param timing - How long until the first word, and how long the writing took (the main model's calls).
   */
  private recordUsage(modelId: string, role: "main" | TeamRole, sent: AgentMessage[], result: Awaited<ReturnType<ModelTurn>>, timing?: { waitMs: number; writeMs: number }): void {
    // What the model really counted: code and Hebrew have fewer characters per token than English prose, so the
    // window is measured with this model's own ratio from now on.
    if (role === "main" && modelId === this.modelId && (result.usage?.inputTokens ?? 0) > 500) this.learnRatio(sizeOf(sent) + JSON.stringify(this.specs()).length, result.usage!.inputTokens!);
    const reported = result.usage?.inputTokens !== undefined && result.usage?.outputTokens !== undefined;
    const input = result.usage?.inputTokens ?? Math.round(sizeOf(sent) / CHARS_PER_TOKEN);
    const output = result.usage?.outputTokens ?? Math.round((result.text.length + JSON.stringify(result.toolCalls).length) / CHARS_PER_TOKEN);
    const cached = result.usage?.cachedTokens;
    const cacheWrite = result.usage?.cacheWriteTokens;
    // What the token budget left out of this call (main model only; teammates get their own short prompts).
    const pruned = role === "main" ? Math.round((this.lastPrunedChars + this.lastCappedChars) / this.charsPerToken) : 0;
    this.savedTokens += pruned;
    this.push({ type: "usage", modelId, role, input, output, estimated: !reported, tools: result.toolCalls.map((c) => c.name), ...(timing ? { waitMs: timing.waitMs, writeMs: timing.writeMs } : {}), ...(typeof cached === "number" && cached >= 0 ? { cached: Math.min(cached, input) } : {}), ...(typeof cacheWrite === "number" && cacheWrite > 0 ? { cacheWrite: Math.min(cacheWrite, input) } : {}), ...(pruned > 0 ? { pruned } : {}) });
  }

  /** Tokens the token budget left out of all main-model calls of this conversation (the usage events' `pruned`). */
  private savedTokens = 0;

  /** Characters the last fitted prompt left out (pruned tool outputs), for the usage event. */
  private lastPrunedChars = 0;

  /** The conversation as the model gets it: older tool results as summary lines, except the ones the user pinned. */
  private pruned(): ReturnType<typeof pruneToolOutputs> {
    return pruneToolOutputs(this.messages, { pinned: pinnedOutputs(this.events) });
  }

  /**
   * Pins one tool result so it is always sent to the model in full (or unpins it). Kept as a `tool_pin` event, so it
   * survives a restart and every device sees it.
   *
   * @param callId - The tool call's id.
   * @param pinned - True to pin, false to unpin.
   * @throws Error when the conversation has no result with that id.
   */
  pinOutput(callId: string, pinned: boolean): void {
    if (!this.messages.some((m) => m.role === "tool" && m.toolCallId === callId)) throw new Error("No such tool result in this chat.");
    this.push({ type: "tool_pin", callId, pinned });
  }

  /** Characters per token for this model, learned from what it reports (see {@link recordUsage}). */
  private charsPerToken = CHARS_PER_TOKEN;

  private learnRatio(chars: number, tokens: number): void {
    if (tokens > 0) this.charsPerToken = Math.min(6, Math.max(1.5, chars / tokens));
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
    return `The user's request:\n${this.untrustedUser?.(request) ?? request}\n\nWhat the worker did:\n${actions || "(no tools used)"}\n\nThe worker's answer:\n${answer}`;
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
    // A file name that ends in .exe (`tasklist … llama-server.exe`) is not a request for a program.
    const wantsProgram = users.slice(-3).some((u) => /(?<![\w.-])exe\b|\b(into|as|an?|to)\s+\.exe\b|(make|build|create|compile|package|turn|convert|give me|want)\b[^.\n]{0,40}\bexecutable|installer|setup file|installable|איאקסאי|אקסה|קובץ הפעלה|קובץ הרצה|להתקנה|תוכנה שאפשר להתקין/i.test(u.text));
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
   * What the model would read on the next turn, without calling it: the
   * system prompt, the tools, and each message with its size, marking the
   * ones a summary stands in for. For the context explorer.
   *
   * @returns Sizes in tokens (estimated, about 4 characters each).
   */
  contextView(): ContextView {
    const tok = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);
    const system = this.mode === "plan" ? `${this.systemPrompt}\n\n${PLAN_NOTE}` : this.systemPrompt;
    const tools = this.specs().map((t) => ({ name: t.name, tokens: tok(JSON.stringify(t).length) }));
    const budget = this.contextTokens * this.charsPerToken - this.systemPrompt.length - JSON.stringify(this.specs()).length - 2000;
    const msgs = shortenOldToolOutputs(this.pruned().messages);
    let cut = 0;
    let summary: string | undefined;
    if (sizeOf(msgs) > budget) {
      cut = Math.max(0, cutPoint(msgs, Math.floor(budget * 0.6)));
      const last = [...this.events].reverse().find((e): e is Extract<AgentEvent, { type: "compacted" }> => e.type === "compacted");
      summary = last?.summary;
    }
    const messages = msgs.map((m, i) => ({
      role: m.role,
      tokens: tok(sizeOf([m])),
      text: m.content.length > 1200 ? `${m.content.slice(0, 900)}\n…\n${m.content.slice(-250)}` : m.content,
      ...(m.toolCalls?.length ? { toolCalls: m.toolCalls.map((c) => c.name) } : {}),
      ...(m.toolName ? { toolName: m.toolName } : {}),
      ...(m.images?.length ? { images: m.images.length } : {}),
      ...(m.content.length !== (this.messages[i]?.content.length ?? 0) ? { shortened: true } : {}),
      ...(m.role === "tool" && (m.content.startsWith(PRUNED_MARK) || m.content.startsWith(SUPERSEDED_MARK)) ? { pruned: true } : {}),
      ...(i < cut ? { summarized: true } : {}),
    }));
    const sent = messages.filter((m) => !m.summarized).reduce((n, m) => n + m.tokens, 0);
    return {
      windowTokens: this.contextTokens,
      system: { tokens: tok(system.length + (cut && summary ? summary.length : 0)), text: system },
      tools,
      messages,
      ...(cut && summary ? { summary } : {}),
      totalTokens: tok(system.length + (cut && summary ? summary.length : 0)) + tools.reduce((n, t) => n + t.tokens, 0) + sent,
    };
  }

  /**
   * The messages to send this turn: everything, or — when it is too long for
   * the model — a summary of the oldest part plus the recent turns in full.
   * The stored conversation is never changed.
   */
  private async fitContext(signal: AbortSignal): Promise<AgentMessage[]> {
    const out = this.viewMessages ? this.fitView(this.viewMessages(this.messages)) : await this.fitContextRaw(signal);
    // Local models drift into English after long tool runs: say the user's language again, last thing in the instructions.
    const note = languageNote([...this.messages].reverse().find((m) => m.role === "user")?.content ?? "");
    if (note && out[0]?.role === "system") out[0] = { ...out[0], content: `${out[0].content}\n\n${note}` };
    return out;
  }

  /**
   * The system prompt and a caller's view of the conversation (viewMessages), its oldest messages left out until it
   * fits the model's window. No summary is made: a summary would read the stored conversation.
   *
   * @param view - The messages to send.
   */
  private fitView(view: AgentMessage[]): AgentMessage[] {
    const system: AgentMessage = { role: "system", content: this.mode === "plan" ? `${this.systemPrompt}\n\n${PLAN_NOTE}` : this.systemPrompt };
    const budget = this.contextTokens * this.charsPerToken - this.systemPrompt.length - JSON.stringify(this.specs()).length - 2000;
    let msgs = view;
    // Cut at a user message, so no answer or tool result is left without what it answers.
    while (msgs.length > 1 && sizeOf(msgs) > budget) {
      const next = msgs.findIndex((m, i) => i > 0 && m.role === "user");
      if (next <= 0) break;
      msgs = msgs.slice(next);
    }
    return [system, ...msgs];
  }

  private async fitContextRaw(signal: AbortSignal): Promise<AgentMessage[]> {
    const system: AgentMessage = { role: "system", content: this.mode === "plan" ? `${this.systemPrompt}\n\n${PLAN_NOTE}` : this.systemPrompt };
    const budget = this.contextTokens * this.charsPerToken - this.systemPrompt.length - JSON.stringify(this.specs()).length - 2000;
    // One tool output may not take more than a quarter of the window (found on the PC: a whole ScriptNodes.tsx read
    // kept a 24K local model over its limit even after the older steps were summarised).
    const cap = Math.max(4000, Math.floor(budget * 0.25));
    // Shortening older outputs saves room but makes a local engine read the conversation again from there: only
    // when the conversation takes more than half the window, and then in steps of 8 messages (see shortenOldToolOutputs).
    // Tool results from before the last two turns go as one summary line each (budget.ts); the line moves per turn.
    const pruned = this.pruned();
    this.lastPrunedChars = pruned.prunedChars;
    const roomy = sizeOf(pruned.messages) <= budget * 0.5;
    const msgs = (roomy ? pruned.messages : shortenOldToolOutputs(pruned.messages, 8, 8)).map((m) =>
      m.role === "tool" && m.content.length > cap
        ? { ...m, content: `${m.content.slice(0, Math.floor(cap * 0.65))}\n… [${m.content.length - Math.floor(cap * 0.95)} characters left out: too long for this model's context. Read the part you need (read_file with offset and limit, or search for it).] …\n${m.content.slice(-Math.floor(cap * 0.3))}` }
        : m,
    );
    // "/compact": the user asked for the earlier part as a summary; it stays in use while the rest fits.
    const pinned = [...this.events].reverse().find((e): e is Extract<AgentEvent, { type: "compacted" }> => e.type === "compacted");
    if (pinned?.manual && pinned.upTo <= msgs.length && sizeOf(msgs.slice(pinned.upTo)) <= budget) {
      // Results the user pinned in the summarised part stay in full after the summary (budget.ts pinnedBefore).
      const pins = pinnedBefore(this.messages.slice(0, pinned.upTo), pinnedOutputs(this.events), Math.max(2000, Math.floor(budget * 0.2)));
      return [{ role: "system", content: `${system.content}\n\nSummary of the earlier part of this conversation (the user still sees all of it):\n${pinned.summary}${pins ? `\n\n${pins}` : ""}` }, ...msgs.slice(pinned.upTo)];
    }
    if (sizeOf(msgs) <= budget) return [system, ...msgs];
    // A long run inside one message (self-work, a big task) cannot be cut at a user message: shorten all but the last
    // tool output instead.
    const tight = shortenOldToolOutputs(msgs, 1);
    const cut = cutPoint(msgs, Math.floor(budget * 0.6));
    if (cut <= 0) return [system, ...(sizeOf(msgs) > budget ? tight : msgs)];
    const last = [...this.events].reverse().find((e): e is Extract<AgentEvent, { type: "compacted" }> => e.type === "compacted");
    let summary = last && last.upTo === cut ? last.summary : undefined;
    if (!summary) {
      // Summarise what is new since the last summary, together with that summary.
      const from = last && last.upTo < cut ? last.upTo : 0;
      const earlier = last && last.upTo < cut ? `Earlier summary:\n${last.summary}\n\nThen:\n` : "";
      try {
        const r = await this.model(
          { messages: [{ role: "system", content: SUMMARY_PROMPT }, { role: "user", content: earlier + transcript(msgs.slice(from, cut), Math.floor(budget * 0.8), this.untrustedUser) }], tools: [] },
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
    const recent = msgs.slice(cut);
    return [{ role: "system", content: `${this.systemPrompt}\n\nSummary of the earlier part of this conversation (the user still sees all of it):\n${summary}` }, ...(sizeOf(recent) > budget * 0.8 ? shortenOldToolOutputs(recent, 1) : recent)];
  }

  /**
   * "/compact" (as Claude Code and Open WebUI): everything before the last message of the user's becomes a summary the
   * model reads instead, to free the context now rather than when it is full. The user still sees the whole chat.
   *
   * @returns The summary.
   * @throws Error while the agent works, when there is nothing earlier to summarise, or when the model gives none.
   */
  async compactNow(): Promise<{ summary: string }> {
    if (this.busy) throw new Error("Wait until the agent is done, then compact.");
    const cut = this.messages.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i > 0).at(-1) ?? 0;
    const last = [...this.events].reverse().find((e): e is Extract<AgentEvent, { type: "compacted" }> => e.type === "compacted");
    if (cut <= 0 || (last && last.upTo >= cut)) throw new Error("There is nothing earlier to summarise yet.");
    const from = last ? last.upTo : 0;
    const earlier = last ? `Earlier summary:\n${last.summary}\n\nThen:\n` : "";
    const budget = this.contextTokens * this.charsPerToken;
    const r = await this.model(
      { messages: [{ role: "system", content: SUMMARY_PROMPT }, { role: "user", content: earlier + transcript(this.messages.slice(from, cut), Math.floor(budget * 0.8), this.untrustedUser) }], tools: [] },
      AbortSignal.timeout(300_000),
      () => undefined,
    );
    const summary = r.text.trim();
    if (!summary) throw new Error("The model gave no summary. Try again.");
    this.push({ type: "compacted", upTo: cut, summary, manual: true });
    return { summary };
  }

  /**
   * Tool search: the tools a message points at are loaded before the model answers, so a local model does not wander
   * looking for them (seen on the PC: asked to "use make_music", it wrote files and tried a skill before find_tools).
   * A tool the message names, one this conversation used before, or one whose own word is in the message ("music" →
   * make_music, "video" → generate_video).
   */
  private loadToolsFor(text: string): void {
    if (!this.toolSearch?.()?.length) return;
    const lower = text.toLowerCase();
    const words = new Set(lower.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
    const used = new Set(this.events.flatMap((e) => (e.type === "tool_call" ? [e.name] : [])));
    for (const name of this.tools.keys()) {
      const own = name.split("_").filter((w) => w.length > 2 && !COMMON_TOOL_WORDS.has(w));
      if (lower.includes(name) || own.some((w) => words.has(w))) this.loadTool(name);
      else if (used.has(name)) this.loadedTools.add(name);
    }
  }

  /**
   * Routing by meaning ({@link AgentSessionOptions.route}) for the message send() just added: its tools are loaded,
   * and the router's note joins that message for the model.
   */
  private async routeMessage(signal: AbortSignal): Promise<void> {
    const text = this.routeText;
    this.routeText = undefined;
    if (text === undefined || !this.route) return;
    const r = await this.route(text, signal).catch(() => undefined);
    this.hidden = new Set(r?.hide ?? []);
    if (!r) return;
    // The router's first pick ranks highest (loaded last).
    for (const name of [...r.tools].reverse()) if (this.tools.has(name)) this.loadTool(name);
    if (r.small && sizeOf(this.messages) <= SMALL_TURN_CHARS && !this.messages.at(-1)?.images?.length) this.smallTurn = r.small;
    const last = this.messages.at(-1);
    if (r.note && last?.role === "user") last.content += `\n\n${r.note}`;
  }

  private specs(): ToolSpec[] {
    if (this.toolsUnsupported) return [];
    // By name, not by the order tools were registered (MCP servers and plugins connect in any order), so the tool
    // list, which sits at the top of the prompt, stays the same from turn to turn and the engine keeps its cache.
    const all = sortSpecs([...this.tools.values()].map((t) => t.spec).filter((t) => !this.hidden.has(t.name)));
    const core = this.toolSearch?.();
    const base = [askUserSpec, requestAccessSpec, ...(this.mode === "plan" ? [presentPlanSpec] : []), ...(this.pruned().ids.length ? [toolOutputSpec] : [])];
    if (!core?.length) return [...base, ...all];
    // Tool search: the core tools and the ones loaded so far in full; the rest by name only. Loaded tools come after
    // the core ones, so loading one changes only the end of the list.
    const loaded = [...all.filter((t) => core.includes(t.name)), ...all.filter((t) => !core.includes(t.name) && this.loadedTools.has(t.name))];
    // The per-turn cap: past it, the lowest-ranked tools are listed by name in more_tools like the unloaded ones.
    const { keep: full, over } = capTools(loaded, { core, rank: this.toolRank, since: this.rankSince, cap: this.toolCap?.() ?? DEFAULT_TOOL_CAP });
    this.lastCappedChars = over.length ? JSON.stringify(loaded.filter((t) => over.includes(t.name))).length : 0;
    const rest = all.filter((t) => !full.includes(t));
    if (!rest.length) return [...base, ...full];
    const short = (d: string) => (d.split(/(?<=\.)\s/)[0] ?? d).slice(0, 90);
    const find: ToolSpec = {
      name: FIND_TOOLS_TOOL,
      description: `Load more tools before using them (their full instructions come with the next step). Available: ${rest.map((t) => `${t.name} (${short(t.description)})`).join("; ")}`,
      inputSchema: { type: "object", properties: { names: { type: "array", items: { type: "string" }, description: "Tool names from the list." } }, required: ["names"] },
    };
    return [...base, ...full, find];
  }

  /** One turn of an outside agent: its text, steps and approval questions, shown like KesherAI's own. */
  private async runExternal(ext: ExternalAgent): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    this.setStatus("running");
    const turn = ++this.turn;
    let text = "";
    const seen = new Set<string>();
    const request = [...this.messages].reverse().find((m) => m.role === "user")?.content;
    const io: ExternalIO = {
      text: (d) => {
        if (!d) return;
        text += d;
        this.push({ type: "assistant_delta", turn, text: d }, false);
      },
      tool: (st) => {
        if (!seen.has(st.id)) {
          seen.add(st.id);
          this.push({ type: "tool_call", callId: st.id, name: st.name, input: st.input ?? {} });
        }
        if (st.ok !== undefined) this.push({ type: "tool_result", callId: st.id, name: st.name, ok: st.ok, output: truncate(st.output ?? ""), ...(st.diff ? { diff: st.diff } : {}) });
      },
      plan: (t) => this.push({ type: "note", text: t }),
      approve: async (req) => {
        const requestId = randomUUID();
        // The card's "why" is what the agent said in this turn so far (not an older answer).
        const { decision, feedback } = await new Promise<{ decision: ApprovalDecision; feedback?: string }>((resolve) => {
          this.approvals.set(requestId, resolve);
          this.push({ type: "approval_request", requestId, callId: req.callId, name: req.name, input: {}, preview: req.preview, reason: req.reason, ...(text.trim() ? { purpose: text.trim().slice(-400) } : {}), ...(this.workspace ? { folder: this.workspace } : {}) });
          this.setStatus("waiting");
        });
        this.push({ type: "approval_result", requestId, decision, ...(feedback ? { feedback } : {}) });
        if (!abort.signal.aborted) this.setStatus("running");
        return decision === "allow" || decision === "always" ? decision : "deny";
      },
    };
    try {
      await ext.turn(typeof request === "string" ? request : "", io, abort.signal);
      if (text) {
        this.push({ type: "assistant", turn, text });
        this.messages.push({ role: "assistant", content: text });
        this.lastSaid = text;
      }
      if (abort.signal.aborted) this.push({ type: "note", text: "Stopped." });
      this.setStatus("idle");
    } catch (err) {
      if (abort.signal.aborted) {
        this.push({ type: "note", text: "Stopped." });
        this.setStatus("idle");
      } else this.setStatus("error", err instanceof Error ? err.message : String(err));
    } finally {
      if (this.abort === abort) this.abort = undefined;
      this.onChange?.(this);
    }
  }

  private async run(): Promise<void> {
    if (this.external) return this.runExternal(this.external);
    const changedFrom = this.changes.length;
    const abort = new AbortController();
    this.abort = abort;
    this.setStatus("running");
    try {
      let nudges = 0;
      // A turn cut off at the token limit gets one nudge to answer briefly (see `truncated` below).
      let cutNudged = false;
      let reviews = 0;
      const team = this.team?.() ?? [];
      const planner = team.find((m) => m.role === "planner");
      const reviewer = team.find((m) => m.role === "reviewer");
      const request = [...this.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      await this.routeMessage(abort.signal);
      if (planner) {
        const plan = await this.askTeammate(planner, PLANNER_PROMPT, `The user's request:\n${request}`, abort.signal);
        if (plan) this.messages.push({ role: "user", content: `(A plan from your teammate ${planner.modelId}; follow it where it makes sense, the user's words come first.)\n${plan}` });
      }
      this.failures.clear();
      for (let step = 0; step < this.maxSteps; step++) {
        abort.signal.throwIfAborted();
        const turn = ++this.turn;
        // Background helpers that ended since the last turn: their reports go in before the model is asked.
        if (this.inbox.length) this.messages.push({ role: "user", content: `[KesherAI] ${this.inbox.splice(0).join("\n\n")}` });
        // Steering (chat-queue.ts): messages the user sent during this turn to change its course go in before the next step.
        if (step > 0) this.injectSteers();
        // The last step of a helper: no tools, only the report.
        const lastStep = this.finalStepReport && step === this.maxSteps - 1;
        if (lastStep) this.messages.push({ role: "user", content: "[KesherAI] This is your last step: no more tools. Write your report now, from what you found." });
        const conversation = await this.fitContext(abort.signal);
        let result: Awaited<ReturnType<ModelTurn>>;
        // Reading (until the first word) and writing are timed apart: a long prompt on a big model can take half a
        // minute to read and then write fast, and one number for both made a 47 tokens/s model show "2.3 tok/s".
        const askedAt = Date.now();
        let firstAt = 0;
        const onText = (text: string) => {
          if (!firstAt) firstAt = Date.now();
          this.push({ type: "assistant_delta", turn, text }, false);
        };
        // A simple turn: the smaller model answers first, with no tools; when it fails or says nothing, the main one does.
        const small = step === 0 && !lastStep ? this.smallTurn : undefined;
        this.smallTurn = undefined;
        const quick = small ? await small.model({ messages: conversation, tools: [] }, abort.signal, onText).then((r) => (r.text.trim() && !r.toolCalls.length ? r : undefined), () => undefined) : undefined;
        try {
          result = quick ?? (await this.model({ messages: conversation, tools: lastStep ? [] : this.specs() }, abort.signal, onText));
        } catch (err) {
          // Too long for the model after all (the estimate is in characters; a local server may share its context between
          // chats): take the server's own numbers, make the window smaller and send a shorter conversation once.
          // llama.cpp also answers just "Context size has been exceeded." (found on the PC: a chat from Lichii, after two web searches).
          let over = /request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)|exceeds? (?:the )?(?:maximum )?context (?:length|size|window)|context (?:size|length|window) (?:has been |was )?exceeded/i.exec((err as Error).message);
          if (over && !abort.signal.aborted && this.contextTokens > 2000) {
            let sentChars = sizeOf(conversation) + JSON.stringify(this.specs()).length;
            // Up to two tries: learn the model's real characters per token from its own count, then fit again.
            for (let attempt = 0; over && attempt < 2; attempt++) {
              const sent = Number(over[1] ?? 0);
              const room = Number(over[2] ?? 0);
              if (sent) this.learnRatio(sentChars, sent);
              if (room) this.contextTokens = Math.min(this.contextTokens, Math.floor(room * 0.9));
              else this.contextTokens = Math.max(2000, Math.floor(this.contextTokens * 0.7));
              if (attempt === 0) this.push({ type: "note", text: `The conversation was too long for the model; KesherAI shortened it (older steps are summarised) and tried again.` });
              const shorter = await this.fitContext(abort.signal);
              sentChars = sizeOf(shorter) + JSON.stringify(this.specs()).length;
              try {
                result = await this.model({ messages: shorter, tools: this.specs() }, abort.signal, onText);
                over = null;
              } catch (again) {
                over = /request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)|context (?:size|length|window) (?:has been |was )?exceeded/i.exec((again as Error).message);
                if (!over || attempt === 1) throw again;
              }
            }
            result = result!;
          } else if (BROKEN_FORMAT.test((err as Error).message) && !abort.signal.aborted) {
            result = await this.recoverBrokenFormat(conversation, abort.signal, onText);
          } else
          // Many local models reject the `tools` field. Retry once without tools.
          if (!this.toolsUnsupported && /tool|function/i.test((err as Error).message) && !abort.signal.aborted) {
            this.toolsUnsupported = true;
            this.push({ type: "note", text: "This model does not support tools, so it will answer without them (no files, commands or images)." });
            result = await this.model({ messages: conversation, tools: [] }, abort.signal, onText);
          } else throw err;
        }
        this.recordUsage(quick && small ? small.modelId : this.modelId, "main", conversation, result, firstAt ? { waitMs: firstAt - askedAt, writeMs: Date.now() - firstAt } : undefined);
        // The turn hit the token limit (a thinking model that reasoned without end): its tool call, if any, is cut
        // off. Ask once for a brief answer or the next step instead of running a broken call.
        if (result.truncated && !cutNudged && !abort.signal.aborted) {
          cutNudged = true;
          this.push({ type: "note", text: "The model ran out of room while thinking; it was asked to answer briefly." });
          if (result.text.trim()) this.messages.push({ role: "assistant", content: result.text });
          this.messages.push({ role: "user", content: "[KesherAI] You ran out of room while thinking. Do not think any more: answer briefly now, or make the next tool call with short arguments." });
          continue;
        }
        let shown = result.text;
        // The final answer without links the app cannot open (invented players and file addresses).
        if (result.toolCalls.length === 0 && shown) shown = await neutralizeLinks(shown, this.assetExists);
        // The final answer (no more tool calls) in the user's language, when the model wrote it in another one.
        if (result.toolCalls.length === 0 && shown.trim() && this.polishAnswer && !abort.signal.aborted) {
          const asked = [...this.messages].reverse().find((m) => m.role === "user");
          const userText = typeof asked?.content === "string" ? asked.content : "";
          const better = await this.polishAnswer(shown, userText, abort.signal).catch(() => undefined);
          if (better) shown = better;
        }
        if (shown) this.push({ type: "assistant", turn, text: shown, ...(shown !== result.text ? { original: result.text } : {}) });
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
          // The loop guard (from Microsoft's TokenEconomizer): the same step failing the same way three times gets one
          // note to stop and change course, instead of the model trying it again (small local models do).
          const key = failureKey(call.name, output);
          if (key) {
            const n = (this.failures.get(key) ?? 0) + 1;
            this.failures.set(key, n);
            if (n === 3) {
              this.push({ type: "note", text: "The same step failed the same way three times: the agent was told to change course." });
              this.messages.push({ role: "user", content: `[KesherAI] ${call.name} has now failed the same way three times (${key.split("|")[1]}). Do not run it again unchanged. Read the error, check what you assumed (open the file, list the folder, look up the API), then try a different approach, or tell the user what blocks you.` });
            }
          }
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
      await this.receipt(changedFrom).catch(() => undefined);
      this.onChange?.(this);
    }
  }

  /**
   * After a run that changed files, a receipt (as Cursor's "Review changes"): each file with the lines added and removed,
   * and "Undo all" for the run. The files as they were before are kept in the undo store.
   */
  private async receipt(from: number): Promise<void> {
    const made = this.changes.slice(from);
    if (!made.length) return;
    const first = new Map<string, string | null>();
    for (const c of made) if (!first.has(c.path)) first.set(c.path, c.before);
    const shown: Array<{ path: string; kind: "new" | "changed" | "deleted"; added: number; removed: number }> = [];
    const kept: RunFiles = { files: [] };
    for (const [path, before] of first) {
      const now = await readFile(path, "utf8").catch(() => null);
      if (now === before) continue;
      const { added, removed } = lineDelta(before ?? "", now ?? "");
      shown.push({ path: this.workspace ? displayPath(this.workspace, path) : path, kind: before === null ? "new" : now === null ? "deleted" : "changed", added, removed });
      kept.files.push({ path, before, after: print(now) });
    }
    if (!shown.length) return;
    const run = randomUUID().slice(0, 8);
    this.runs.set(run, kept);
    await this.undoStore?.save(run, kept).catch(() => undefined);
    this.push({ type: "receipt", run, files: shown });
  }

  /**
   * Every change of a run in one place (the receipt's "Review", like Zed's multibuffer): each file's diff from before
   * the run to after it, in the run's order. Large diffs are cut so the page stays light.
   *
   * @param run - The id on the run's receipt.
   */
  async runDiff(run: string): Promise<Array<{ path: string; diff: string }>> {
    const kept = this.runs.get(run) ?? (await this.undoStore?.load(run).catch(() => undefined));
    if (!kept) throw new Error("This run's earlier files are no longer kept.");
    const show = (p: string) => (this.workspace ? displayPath(this.workspace, p) : p);
    let room = 400_000;
    const out: Array<{ path: string; diff: string }> = [];
    for (const f of kept.files) {
      // Before the run (kept) to the file as it is now (only a fingerprint of "after" is kept).
      const now = await readFile(f.path, "utf8").catch(() => "");
      const d = makeDiff(show(f.path), f.before, now);
      const diff = d.length > room ? `${d.slice(0, Math.max(0, room))}\n… (cut: the diff is too long to show here)` : d;
      room = Math.max(0, room - diff.length);
      out.push({ path: show(f.path), diff });
    }
    return out;
  }

  /**
   * Puts back every file a run changed, as it was before the run. A file changed since (by the user or a later run)
   * is not touched unless `force`: its name comes back in `conflicts`.
   *
   * @param run - The id on the run's receipt.
   * @throws Error while the agent is busy, or when the run's files are no longer kept.
   */
  async undoRun(run: string, force = false, only?: string): Promise<{ files: string[]; conflicts: string[] }> {
    if (this.busy) throw new Error("Stop the agent before undoing.");
    const kept = this.runs.get(run) ?? (await this.undoStore?.load(run).catch(() => undefined));
    if (!kept) throw new Error("This run's earlier files are no longer kept.");
    const show = (p: string) => (this.workspace ? displayPath(this.workspace, p) : p);
    // One file of the run (its receipt's "undo" on that file, like Cursor's per-file reject), or all of them.
    const chosen = only === undefined ? kept.files : kept.files.filter((f) => show(f.path) === only);
    if (only !== undefined && !chosen.length) throw new Error("That file is not part of this run.");
    const conflicts: string[] = [];
    for (const f of chosen) if (print(await readFile(f.path, "utf8").catch(() => null)) !== f.after) conflicts.push(show(f.path));
    if (conflicts.length && !force) return { files: [], conflicts };
    for (const f of chosen) {
      if (f.before === null) await rm(f.path, { force: true });
      else await writeFile(f.path, f.before, "utf8");
    }
    const paths = new Set(chosen.map((f) => f.path));
    this.changes = this.changes.filter((c) => !paths.has(c.path));
    const left = kept.files.filter((f) => !paths.has(f.path));
    if (left.length) {
      const rest = { ...kept, files: left };
      this.runs.set(run, rest);
      await this.undoStore?.save(run, rest).catch(() => undefined);
    } else {
      this.runs.delete(run);
      await this.undoStore?.remove(run).catch(() => undefined);
    }
    const files = chosen.map((f) => show(f.path));
    this.push({ type: "undo_run", run, files });
    this.messages.push({ role: "user", content: only === undefined && !left.length ? `(The user undid all your changes from one run: ${files.join(", ")}. Those files are as they were before it.)` : `(The user undid your changes to ${files.join(", ")} from one run; that file is as it was before it. Your other changes stay.)` });
    return { files, conflicts };
  }

  /**
   * Puts back one change (hunk) of one file of a run, keeping the rest (as Zed's and Cursor's per-hunk reject).
   * Hunks are counted as in {@link runDiff}'s diff of that file.
   *
   * @throws Error while the agent is busy, when the run's files are no longer kept, or the hunk no longer fits.
   */
  async undoRunHunk(run: string, only: string, hunk: number): Promise<{ files: string[] }> {
    if (this.busy) throw new Error("Stop the agent before undoing.");
    const kept = this.runs.get(run) ?? (await this.undoStore?.load(run).catch(() => undefined));
    if (!kept) throw new Error("This run's earlier files are no longer kept.");
    const show = (p: string) => (this.workspace ? displayPath(this.workspace, p) : p);
    const f = kept.files.find((x) => show(x.path) === only);
    if (!f) throw new Error("That file is not part of this run.");
    if (f.before === null) throw new Error("This file is new in this run; put back the whole file instead.");
    const now = await readFile(f.path, "utf8").catch(() => "");
    const next = undoHunk(f.before, now, hunk);
    if (next === undefined) throw new Error("That change no longer fits the file. Open the review again.");
    await writeFile(f.path, next, "utf8");
    const back = next === f.before;
    const files = back ? kept.files.filter((x) => x !== f) : kept.files.map((x) => (x === f ? { ...x, after: print(next) } : x));
    if (files.length) {
      const rest = { ...kept, files };
      this.runs.set(run, rest);
      await this.undoStore?.save(run, rest).catch(() => undefined);
    } else {
      this.runs.delete(run);
      await this.undoStore?.remove(run).catch(() => undefined);
    }
    if (back) {
      this.changes = this.changes.filter((c) => c.path !== f.path);
      this.push({ type: "undo_run", run, files: [only] });
    }
    this.messages.push({ role: "user", content: `(The user undid one of your changes to ${only} from one run. Read the file again before changing it.)` });
    return { files: back ? [only] : [] };
  }

  /** Runs one tool call, asking for approval when needed. Returns what the model sees. */
  private async execute(call: ToolCall, signal: AbortSignal): Promise<string> {
    this.push({ type: "tool_call", callId: call.id, name: call.name, input: call.arguments });
    const fail = (message: string) => {
      this.push({ type: "tool_result", callId: call.id, name: call.name, ok: false, output: message });
      return `Error: ${message}`;
    };
    if (typeof call.arguments._invalidJson === "string") return fail("Your tool arguments were not valid JSON. Send them again as a JSON object.");

    if (call.name === TOOL_OUTPUT_TOOL) {
      try {
        const output = openToolOutput(this.messages, String(call.arguments.id ?? "").trim(), Number(call.arguments.from ?? 0));
        this.push({ type: "tool_result", callId: call.id, name: call.name, ok: true, output: truncate(output) });
        return output;
      } catch (err) {
        return fail((err as Error).message);
      }
    }
    if (call.name === FIND_TOOLS_TOOL || call.name === OLD_FIND_TOOLS) {
      const names = (Array.isArray(call.arguments.names) ? call.arguments.names : [call.arguments.names]).map(String).filter((n) => this.tools.has(n));
      for (const n of names) this.loadTool(n);
      const output = names.length ? `Loaded: ${names.join(", ")}. Use them now.` : "None of those names is a tool; use names from the list.";
      this.push({ type: "tool_result", callId: call.id, name: call.name, ok: names.length > 0, output });
      return output;
    }
    if (call.name === ASK_USER_TOOL && this.unattended) {
      const output = "No one is here to answer (this run is unattended): decide yourself, say what you chose and why, and go on.";
      this.push({ type: "tool_result", callId: call.id, name: call.name, ok: true, output });
      return output;
    }
    if (call.name === REQUEST_ACCESS_TOOL && this.unattended) {
      const output = "Refused: this run is unattended, so only the project folder (and folders already shared with it) can be used. The repository's own copy of a file is inside the project folder: use that one.";
      this.push({ type: "tool_result", callId: call.id, name: call.name, ok: false, output });
      return output;
    }
    if (call.name === ASK_USER_TOOL) {
      const items = askItems(call.arguments.questions);
      const question = typeof call.arguments.question === "string" && call.arguments.question.trim() ? call.arguments.question : items[0]?.question ?? "";
      if (!question) return fail('ask_user needs a "question" (or "questions").');
      const options = Array.isArray(call.arguments.options) ? call.arguments.options.filter((o): o is string => typeof o === "string") : undefined;
      const questionId = randomUUID();
      const answer = await new Promise<string>((resolve) => {
        this.questions.set(questionId, resolve);
        this.push({ type: "question", questionId, question, ...(options?.length && !items.length ? { options } : {}), ...(items.length ? { items } : {}) });
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
    // Loop guard: the same changing action with the same arguments a third time for one message is refused
    // (seen live: a model started the same build and the same game again and again).
    if (tool.risk === "exec" || tool.risk === "write") {
      const key = `${call.name} ${JSON.stringify(call.arguments)}`;
      const n = (this.repeats.get(key) ?? 0) + 1;
      this.repeats.set(key, n);
      if (n > 2) return fail(`You already ran ${call.name} with exactly these arguments twice for this message. Do not repeat it: tell the user what happened and what you need, or try something different.`);
    }

    const ctx: ToolContext = {
      ...(this.workspace ? { workspace: this.workspace } : {}),
      extraRoots: this.grants,
      signal,
      recordChange: (path, before) => this.changes.push({ path, before }),
      progress: this.liveOutput(call.id),
      jobProgress: this.jobProgress(call.id),
      callId: call.id,
      ...(this.askedLately().at(-1) ? { lastUser: this.askedLately().at(-1)!.split("\n\n[KesherAI]")[0]! } : {}),
      ...(this.envOf ? { env: this.envOf() } : {}),
      ...(this.webOf?.() ? { web: this.webOf()! } : {}),
      ...(this.torOf?.() ? { viaTor: this.torOf()! } : {}),
    };
    // A scoped tool (the browser) is "always allowed" per site, not as a whole.
    let scope: string | undefined;
    try {
      scope = await tool.scopeOf?.(call.arguments, ctx);
    } catch {
      scope = undefined;
    }
    const alwaysKey = scope ?? tool.spec.name;
    const always = this.alwaysAllowed.has(alwaysKey) || !!this.isAlwaysAllowed?.(tool.spec.name, this.modelId, tool.commandOf?.(call.arguments), scope, call.arguments);
    let verdict = decide(this.mode, tool.risk, always, tool.commandOf?.(call.arguments), this.workspace);
    // Browser and computer tools decide themselves (safety v2: modes, sensitive sites, the origin gate, the local
    // reviewer); a gate that fails asks the user.
    const gate = tool.gate
      ? await tool.gate(call.arguments, ctx, { always, ...(scope ? { scope } : {}), ...(this.helperName ? { helper: this.helperName } : {}), asked: this.askedLately(), plan: this.mode === "plan", sessionId: this.id }).catch((e: Error): GateResult => ({ action: "ask", reason: `The safety check failed (${e.message}), so you decide.`, noAlways: true }))
      : undefined;
    if (gate) {
      verdict = gate.action === "allow" ? { action: "allow" } : { action: gate.action, reason: gate.reason };
      if (gate.note) this.push({ type: "note", text: gate.note });
    }
    // A call the tool says the person must agree to (a download of several GB): asked every time, in every mode.
    const mustAsk = gate ? undefined : tool.askFirst?.(call.arguments);
    if (mustAsk && verdict.action !== "deny") verdict = { action: "ask", reason: mustAsk };
    // Smart auto approvals: a plain command in "auto-edit" (not on the always-ask list, not one the tool insists on
    // asking about) goes to the reviewer, which sees only what the person asked and the command. "No", an error or a
    // slow answer leaves the question to the person, as before.
    const command = tool.commandOf?.(call.arguments);
    const reviewer = this.reviewerOf?.();
    if (!gate && reviewer && verdict.action === "ask" && !mustAsk && this.mode === "auto-edit" && tool.risk === "exec" && command && !dangerReason(command, this.workspace)) {
      const asked = this.askedLately();
      const review = await reviewer({ tool: tool.spec.name, command, input: call.arguments, asked, ...(this.workspace ? { folder: this.workspace } : {}) }, signal).catch(() => undefined);
      if (review?.allow) {
        this.push({ type: "note", text: `✓ Approved by the reviewer: ${command.slice(0, 120)}${review.reason ? ` (${review.reason})` : ""}` });
        verdict = { action: "allow" };
      } else if (review) {
        verdict = { action: "ask", reason: `${verdict.reason}${review.reason ? ` The reviewer left it to you: ${review.reason}` : ""}` };
      }
    }
    if (verdict.action === "deny") return fail(verdict.reason);
    if (verdict.action === "ask") {
      let preview = "";
      try {
        preview = (await tool.preview?.(call.arguments, ctx)) ?? JSON.stringify(call.arguments, null, 2);
      } catch (err) {
        return fail((err as Error).message);
      }
      const requestId = randomUUID();
      // No "always" for what is always asked: a gate's sensitive step, a call the tool insists on, a dangerous command.
      const noAlways = gate?.noAlways === true || !!mustAsk || (!!command && !!dangerReason(command, this.workspace));
      const { decision: answered, feedback } = await new Promise<{ decision: ApprovalDecision; feedback?: string }>((resolve) => {
        // A gate's time limit (browser and computer: 5 minutes): no answer counts as denied, and the model is told.
        const timer = gate?.timeoutMs
          ? setTimeout(() => {
              if (this.approvals.get(requestId) !== settle) return;
              this.approvals.delete(requestId);
              settle({ decision: "expired", feedback: "No answer in 5 minutes, so it counts as denied." });
              if (this.statusValue === "waiting" && !this.approvals.size && !this.questions.size) this.setStatus(signal.aborted ? "idle" : "running");
            }, gate.timeoutMs)
          : undefined;
        timer?.unref?.();
        const settle = (d: { decision: ApprovalDecision; feedback?: string }) => {
          if (timer) clearTimeout(timer);
          resolve(d);
        };
        this.approvals.set(requestId, settle);
        const given = typeof call.arguments.purpose === "string" ? call.arguments.purpose.trim() : "";
        const purpose = (given || this.lastSaid).slice(0, 400);
        const folder = tool.risk === "exec" ? this.workspace : undefined;
        this.push({ type: "approval_request", requestId, callId: call.id, name: call.name, input: call.arguments, preview, reason: verdict.reason, ...(purpose ? { purpose } : {}), ...(folder ? { folder } : {}), ...(scope ? { scope } : {}), ...(noAlways ? { noAlways: true } : {}), ...(gate?.control ? { control: gate.control } : {}) });
        this.setStatus("waiting");
      });
      // "Always" where the card offers none (a sensitive site, a helper without the setting) counts as once.
      const decision: ApprovalDecision = answered === "always" && noAlways ? "allow" : answered;
      gate?.decided?.(decision, feedback?.startsWith("No answer in 5 minutes") ? "timeout" : "user");
      this.push({ type: "approval_result", requestId, decision, ...(feedback ? { feedback } : {}) });
      if (decision === "deny" || decision === "expired") {
        const msg = `The user denied this action.${feedback ? ` Their note: ${feedback}` : ""} Do not retry it unchanged; ask or try another way.`;
        this.push({ type: "tool_result", callId: call.id, name: call.name, ok: false, output: "Denied by you." });
        if (!signal.aborted) this.setStatus("running");
        return msg;
      }
      if (decision === "always") {
        // A site the app keeps (and can take back in Settings) is not also kept here, so taking it back works at once.
        if (scope && this.onAlwaysScope) this.onAlwaysScope(scope);
        else this.alwaysAllowed.add(alwaysKey);
      }
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
        ...(out.audioIds?.length ? { audioIds: out.audioIds } : {}),
        ...(out.promptUsed ? { promptUsed: out.promptUsed.slice(0, 2000) } : {}),
        ...(out.files?.length ? { files: out.files } : {}),
        ...(out.app ? { app: out.app } : {}),
      });
      return output;
    } catch (err) {
      if (signal.aborted) throw err;
      return fail(err instanceof Error ? err.message : String(err));
    }
  }
}

/**
 * A reminder of the language the user wrote their last message in, when it is
 * not English (by its script): Hebrew, Arabic, Russian, Greek, Chinese,
 * Japanese, Korean, Hindi, Thai.
 *
 * @param text - The user's last message.
 * @returns The line for the instructions, or "" for English and other Latin-script text.
 */
export function languageNote(text: string): string {
  const scripts: Array<[RegExp, string]> = [
    [/\p{Script=Hebrew}/u, "Hebrew"],
    [/\p{Script=Arabic}/u, "Arabic"],
    [/\p{Script=Cyrillic}/u, "Russian (or the Cyrillic-script language they use)"],
    [/\p{Script=Greek}/u, "Greek"],
    [/\p{Script=Hangul}/u, "Korean"],
    [/[\p{Script=Hiragana}\p{Script=Katakana}]/u, "Japanese"],
    [/\p{Script=Han}/u, "Chinese"],
    [/\p{Script=Devanagari}/u, "Hindi"],
    [/\p{Script=Thai}/u, "Thai"],
  ];
  const letters = text.replace(/```[\s\S]*?```|`[^`]*`|\[[^\]]*\]/g, "");
  for (const [re, name] of scripts) {
    const count = (letters.match(new RegExp(re.source, "gu")) ?? []).length;
    if (count >= 3) return `The user writes in ${name}: write everything you say to them in ${name} (code, commands, file names and tool arguments stay as they are).`;
  }
  return "";
}

/**
 * What makes two tool results "the same failure": the tool and the first line that reads as an error, with numbers,
 * paths' line positions and quoted values smoothed out. Undefined for a result that is not a failure.
 *
 * @param tool - The tool's name.
 * @param output - What it returned.
 */
export function failureKey(tool: string, output: string): string | undefined {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /\b(error|failed|failure|cannot|could not|not found|no such|exception|denied|exit code [1-9]|exited with [1-9]|traceback)\b/i.test(l));
  if (!line) return undefined;
  const norm = line
    .replace(/(["'`]).*?\1/g, "…")
    .replace(/\(\d+,\d+\)|:\d+(:\d+)?/g, "")
    .replace(/\d+/g, "#")
    .slice(0, 160);
  return `${tool}|${norm}`;
}


/**
 * The questions of an ask_user call with `questions`, checked: 1–4, each with a question and 2–4 options (labels
 * trimmed, a line of description at most), so a model's odd arguments still show as a usable card.
 *
 * @param x - The `questions` argument.
 */
export function askItems(x: unknown): AskItem[] {
  if (!Array.isArray(x)) return [];
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  return x
    .map((q): AskItem | undefined => {
      const o = q as { header?: unknown; question?: unknown; options?: unknown; multiSelect?: unknown };
      const question = text(o?.question, 400);
      const options = (Array.isArray(o?.options) ? o.options : [])
        .map((v) => (typeof v === "string" ? { label: text(v, 120) } : { label: text((v as { label?: unknown })?.label, 120), description: text((v as { description?: unknown })?.description, 200) }))
        .filter((v) => v.label)
        .map((v) => (v.description ? v : { label: v.label }))
        .slice(0, 4);
      if (!question || !options.length) return undefined;
      const header = text(o.header, 24);
      return { ...(header ? { header } : {}), question, options, ...(o.multiSelect === true ? { multiSelect: true } : {}) };
    })
    .filter((q): q is AskItem => !!q)
    .slice(0, 4);
}
