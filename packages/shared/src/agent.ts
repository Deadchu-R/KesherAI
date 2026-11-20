/**
 * Types for agent sessions — the engine behind every conversation.
 *
 * A plain chat is an agent session whose only tools are the media tools of
 * the active models (generate an image, …). A code session adds file and
 * terminal tools inside a workspace folder. Both stream the same
 * {@link AgentEvent}s, so one UI renders both.
 *
 * @packageDocumentation
 */

/** A media job's progress, as a tool reports it (ComfyUI's `/ws` messages, the built-in engine's console). */
export interface JobProgress {
  /** What it is doing: "queued", "loading", "sampling", "decoding", "saving"; free text from the engine otherwise. */
  phase?: string;
  /** Step x of `steps` (sampling). */
  step?: number;
  steps?: number;
  /** The newest preview frame, a small `data:image/jpeg` or `data:image/png` URL (at most about 200 KB). */
  preview?: string;
}

/** A tool call a model asked for. */
export interface ToolCall {
  /** Id from the model, echoed back with the result. */
  id: string;
  /** Tool name. */
  name: string;
  /** Parsed JSON arguments. */
  arguments: Record<string, unknown>;
}

/** One message in an agent conversation, in a provider-neutral shape. */
export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** Text content. Empty for an assistant turn that only calls tools. */
  content: string;
  /** Tool calls made in an assistant turn. */
  toolCalls?: ToolCall[];
  /** For `tool` messages: which call this answers. */
  toolCallId?: string;
  /** For `tool` messages: the tool's name (Anthropic needs it). */
  toolName?: string;
  /** Pictures the model should see (e.g. a screenshot a tool took), base64. Only models with vision use them. */
  images?: Array<{ mimeType: string; data: string }>;
}

/** A tool as offered to a model. */
export interface ToolSpec {
  /** `snake_case` name. */
  name: string;
  /** What the tool does and when to use it, written for a model. */
  description: string;
  /** JSON Schema for the arguments. */
  inputSchema: Record<string, unknown>;
}

/**
 * How much the agent may do without asking.
 *
 * - `ask`: reading is free; every file change and command needs approval.
 * - `auto-edit`: file changes inside the folder are approved automatically; commands still ask.
 * - `auto`: file changes and commands run automatically; dangerous commands still ask.
 */
/** `plan`: the agent only looks around and writes a plan for the user to approve; nothing is changed. */
export type PermissionMode = "plan" | "ask" | "auto-edit" | "auto";

/** How risky a tool is, which decides when it needs approval. */
export type ToolRisk = "safe" | "read" | "write" | "exec";

/** The user's answer to an approval request. `expired` = the session restarted before an answer. */
export type ApprovalDecision = "allow" | "always" | "deny" | "expired";

/** Lifecycle of an agent session. */
export type AgentStatus = "idle" | "running" | "waiting" | "error";

/** Fields every event has. */
interface EventBase {
  /** Position in the session, starting at 1. */
  seq: number;
  /** ISO time. */
  at: string;
}

/** One question in a card of questions (ask_user with `questions`). */
export interface AskItem {
  /** A short label (a few words), shown as a chip. */
  header?: string;
  question: string;
  /** 2–4 answers; the recommended one first. */
  options: Array<{ label: string; description?: string }>;
  /** She may pick several. */
  multiSelect?: boolean;
}

/**
 * A helper's job type (docs/RESEARCH_LOG.md, "Helper agents in the chat"): looks, researches, builds, uses the browser
 * and the computer for the user (`operate`, every changing action approved), or an outside agent.
 */
export type HelperKind = "lookup" | "research" | "build" | "operate" | "external";

/**
 * Approval card v2 for a browser or computer action (safety v2, Phase 4): where it acts, on what, a picture of the
 * target, why it is asked, and when an unanswered card counts as denied. The same card shows on the phone.
 */
export interface ControlCard {
  kind: "browser" | "computer";
  /** The site's host ("mail.example.com"), for browser actions. */
  site?: string;
  /** The app's process name and its window's title, for computer actions. */
  app?: string;
  window?: string;
  /** What it acts on, e.g. `button "Send"`. */
  target?: string;
  /** The tool's action, e.g. click, type, open (the card words it in the user's language). */
  verb: string;
  /** Asset id of a small picture of the target, cut from a screenshot. */
  crop?: string;
  /** Why it is asked: manual, sensitive, origin, js, always-ask, review. */
  why: string[];
  /** The sensitive list's reason (bank, payment, email, account, government, user). */
  sensitive?: string;
  /** When an unanswered card counts as denied (ISO time). */
  expiresAt: string;
}

/** The sub-agent behind an approval request shown in its chat (the card and the notification name it). */
export interface HelperAsker {
  /** The helper run's id. */
  id: string;
  /** Its task in a few words. */
  title: string;
  kind: HelperKind;
  /** A named agent (a persona or an agent file), when one was used. */
  agent?: string;
}

/** Where a helper run is: queued, asking the user once (a cloud model and the project's files), working, or ended. */
export type HelperState = "waiting" | "asking" | "running" | "done" | "failed" | "stopped";

/** What one helper run used, summed over its model calls (its session's `usage` events). */
export interface HelperUsage {
  /** Prompt tokens, all calls together (`cached` of them came from the server's prompt cache). */
  input: number;
  output: number;
  cached: number;
  /** Model calls. */
  calls: number;
  /** Some counts were estimated from the text (the provider did not report them). */
  estimated: boolean;
}

/** One helper run, as the chat's helpers strip and its card show it (sent live in a `helpers` event, never saved). */
export interface HelperRunInfo {
  id: string;
  /** The `delegate` call that started it (its card in the thread); absent when the user started it. */
  callId?: string;
  kind: HelperKind;
  /** A named helper (a persona or an agent file), when one was used. */
  agent?: string;
  /** The task in a few words. */
  title: string;
  /** The owner's own name and note for the run, and when set (agent-label.ts; kept by the PC, not in the run). */
  name?: string;
  note?: string;
  labelAt?: number;
  /** The model's short name, e.g. `Qwen3-4B`. */
  model: string;
  /** Why this model: "same as the chat", "ran on X, no swap", "fits beside the chat's model" (and in Hebrew). */
  modelNote?: string;
  modelNoteHe?: string;
  /** It runs on a cloud model. */
  cloud?: boolean;
  /** A cloud helper may read the project's files (the user said yes for this project). */
  cloudFiles?: boolean;
  state: HelperState;
  /** Why it waits (the queue and its limit), and the limit (how many at once). */
  waitReason?: string;
  waitLimit?: number;
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
  step: number;
  maxSteps: number;
  /** The last steps, in order (at most 30). */
  steps: string[];
  /** A build helper's one model swap: to its model, and back to the chat's after. */
  swap?: { from: string; to: string; phase: "loading" | "running" | "back" | "done"; sizeGiB?: number; backMs?: number };
  /** Its short report (the start of it when long; `cut` says so). */
  report?: string;
  cut?: boolean;
  /** The changes a build helper made in its own copy, as a diff (shortened). */
  diff?: string;
  /** The user's review of `diff` (diff-review.ts): per file path, per hunk index, kept or rejected. */
  review?: Record<string, Record<number, "accepted" | "rejected">>;
  /** It waits for the user's approval of one of its steps: the request in its chat (hub snapshots answer it there). */
  approval?: { requestId: string; chatId: string; tool: string };
  /** A build helper's last test run in its copy (the `run_tests` tool): passed or not, and the command. */
  tests?: { ok: boolean; command: string };
  error?: string;
  /** The chat goes on while it runs; its report reaches the chat's model at its next turn. */
  background: boolean;
  /**
   * An outside agent's message waits for "Run this in Antigravity?" (one ask per message, 30 minutes, answered on the
   * card, the phone or through the hub; `POST /api/task-inbox/run-answer`).
   */
  runAsk?: { requestId: string; until: number; left: number; text: string };
  /** Tokens it used so far (absent until its first model call; an outside agent reports none). */
  usage?: HelperUsage;
  /**
   * A restart (an update, the PC restarting) stopped it while it ran: `paused` until the app is ready again, then
   * `resumed` once it continues from its saved steps (helper-store.ts).
   */
  restart?: "paused" | "resumed";
  /** How many times it was continued with a follow-up after it ended ("Continue with…", or the lead's helper_continue). */
  continued?: number;
  /** It ended and kept its conversation, so it can be continued with a follow-up (same model, role and token totals). */
  canContinue?: boolean;
  /** One of a plan's sub-agents (the chat shows the plan's card instead of a card per sub-agent). */
  plan?: HelperPlanRef;
  /** The lead took it off its plan (stopped, shown struck through on the plan's card). */
  removed?: boolean;
}

/**
 * A job the lead split among two or more sub-agents (docs/RESEARCH_LOG.md, "Gap list: agents and chat-first", A15 and
 * A16): the chat's Plan card shows its goal and each sub-agent's task, role, model and state, live. Kept on each of
 * its runs (so it is saved and restored with them); a revision changes it on all of them.
 */
export interface HelperPlanRef {
  id: string;
  /** What the whole job is for, in the lead's words. */
  goal: string;
  /** `research`: a deep research, whose findings become a report document. */
  kind: "plan" | "research";
  /** A deep research's stage: sub-agents researching, the lead writing the report, done, or failed. */
  phase?: "researching" | "writing" | "done" | "failed";
  /** The report document (a deep research), opened in the side panel beside the chat. */
  doc?: { id: string; title: string; ver?: number };
  /** How many times the lead revised the plan (added or removed sub-agents, changed the goal). */
  rev?: number;
}

/**
 * Everything that happens in a session, in order. Clients replay the list
 * to draw the conversation and follow new events live over SSE.
 */
export type AgentEvent = EventBase &
  (
    | { type: "user"; text: string }
    | { type: "assistant_delta"; turn: number; text: string }
    | { type: "assistant"; turn: number; text: string; /** The model's own words, when the model team's translator put them into the user's language. */ original?: string }
    | { type: "tool_call"; callId: string; name: string; input: Record<string, unknown> }
    /**
     * Live output of a tool that is still running (a build, a command), as it comes. Not saved: the
     * result has the output that matters. Clients show the last lines under the running step.
     */
    | { type: "tool_output"; callId: string; text: string }
    /**
     * A running media job's progress (not saved): a picture, video, song or 3D model from ComfyUI or the built-in
     * engine. The chat bubble shows the step, the newest preview frame and Cancel; the result comes as `tool_result`.
     */
    | { type: "tool_progress"; callId: string; progress: JobProgress }
    | {
        type: "approval_request";
        requestId: string;
        callId: string;
        name: string;
        input: Record<string, unknown>;
        /** What will happen: a diff for file changes, the command for commands. */
        preview: string;
        /** Why approval is needed, in one sentence. */
        reason: string;
        /** What the agent says it is doing and why (its own words), if it said. */
        purpose?: string;
        /** The folder the command runs in. */
        folder?: string;
        /** What "Always" covers for this tool: a web site (browser tools), so Always means "on this site". */
        scope?: string;
        /** A sub-agent of this chat asks (its own step, shown in the chat): its rules are kept apart from the chat's. */
        helper?: HelperAsker;
        /** The card offers no "Always" (a helper on a web site, while Settings → Browser keeps helpers asking each time). */
        noAlways?: boolean;
        /** A browser or computer action: approval card v2 (site or app, target, picture, why, time limit). */
        control?: ControlCard;
      }
    | { type: "approval_result"; requestId: string; decision: ApprovalDecision; feedback?: string }
    /** Plan mode: the agent's plan, for the user to approve (then it runs) or change. */
    | { type: "plan"; callId: string; text: string }
    | {
        type: "question";
        questionId: string;
        question: string;
        options?: string[];
        /** Several questions in one card (up to 4), each with options that may carry a line of explanation. */
        items?: AskItem[];
        /** `access`: the agent asks for a folder or file outside its own; the answer is a path, or empty to refuse. */
        kind?: "access";
        /** For `access`: the path the agent suggested. */
        path?: string;
      }
    /**
     * Older messages (before index `upTo` of the model messages) were too long
     * for the model and are sent as this summary instead. Nothing is deleted.
     */
    | { type: "compacted"; upTo: number; summary: string; manual?: boolean }
    /** The message queue changed (not saved; the info that follows has the queue). */
    | { type: "queue" }
    /** The session may now read and change files under `path` (given by the user, or approved when the agent asked). */
    | { type: "access"; path: string }
    /** "Another answer": the answer to the user message `ofUser` (its seq) is written again; earlier ones stay, as versions. */
    | { type: "regenerated"; ofUser: number }
    | { type: "answer"; questionId: string; text: string }
    | {
        type: "tool_result";
        callId: string;
        name: string;
        ok: boolean;
        output: string;
        /** Unified diff for file changes. */
        diff?: string;
        /** Assets produced, e.g. generated images. */
        assetIds?: string[];
        /** Video assets produced (shown as players). */
        videoIds?: string[];
        /** Sound assets produced (music), shown as players. */
        audioIds?: string[];
        /** Files made for the user, relative to the conversation's folder (e.g. a built .exe). */
        files?: string[];
        /** An MCP App: the tool's own view (a `ui://` resource on that server), with the call's input and result. */
        app?: McpAppRef;
      }
    | { type: "undo"; path: string; restored: "previous" | "deleted" }
    /** The chat's helper runs changed (not saved; `GET /api/conversations/:id/helpers` has them too). */
    | { type: "helpers"; runs: HelperRunInfo[] }
    /** A helper run ended: what it used, saved so the Usage page can count helpers apart from the chat's own model. */
    | ({ type: "helper_usage"; runId: string; kind: HelperKind; agent?: string; model: string; state: HelperState } & HelperUsage)
    /** After a run that changed files: what changed (paths as shown), with "Undo all" for the run. */
    | { type: "receipt"; run: string; files: Array<{ path: string; kind: "new" | "changed" | "deleted"; added: number; removed: number }> }
    /** A run's changes were undone. */
    | { type: "undo_run"; run: string; files: string[] }
    | { type: "status"; status: AgentStatus; message?: string }
    | { type: "note"; text: string }
    /**
     * The user pinned (or unpinned) one tool result: a pinned result is always sent to the model in full, never
     * pruned to its summary line (packages/agent/src/budget.ts).
     */
    | { type: "tool_pin"; callId: string; pinned: boolean }
    /** A saved state of the project folder, taken before the next message (coding sessions). */
    | { type: "checkpoint"; id: string; files: number }
    | {
        /** What one model call cost, in tokens (reported by the provider, or `estimated` from the text). */
        type: "usage";
        modelId: string;
        role: "main" | TeamRole;
        input: number;
        output: number;
        estimated: boolean;
        /** The tools this call asked for (its action). */
        tools: string[];
        /** Main model: milliseconds until its first word (reading the prompt), and spent writing after it. */
        waitMs?: number;
        writeMs?: number;
        /**
         * Of `input`, the tokens the server read from its prompt cache (llama.cpp `timings.cache_n`, OpenAI
         * `cached_tokens`). Only when the provider reported it; older servers and clients leave it out.
         */
        cached?: number;
        /**
         * Tokens this call did not send because of the token budget (main model only): older tool results sent as
         * one summary line, and tool instructions over the per-turn cap. Estimated from the text.
         */
        pruned?: number;
      }
    | {
        /** A teammate model's contribution: a plan before the work, or a review after it. */
        type: "teammate";
        role: TeamRole;
        modelId: string;
        text: string;
        /** For reviews: whether the reviewer accepted the answer. */
        approved?: boolean;
      }
  );

/** What a client needs to know about a session besides its events. */
export interface AgentSessionInfo {
  id: string;
  status: AgentStatus;
  modelId: string;
  mode: PermissionMode;
  /** Absolute path of the folder the agent works in; absent for plain chats. */
  workspace?: string;
  /** Approval requests still waiting for an answer. */
  pendingApprovals: string[];
  /** Questions still waiting for an answer. */
  pendingQuestions: string[];
  /** Whether there is a file change that `undo` can revert. */
  canUndo: boolean;
  /** Folders or files outside the workspace this conversation was given access to. */
  grants: string[];
  /** Messages waiting their turn: sent one by one as soon as the agent is free. */
  queued: Array<{ id: string; text: string }>;
  /** Whether the queue waits (after Stop) until the user sends again. */
  queuePaused?: boolean;
}

/**
 * A teammate's job in a multi-model chat. The main model does the work and
 * talks to the user; a `planner` writes a short plan before each request;
 * a `reviewer` checks the finished answer and sends it back with notes
 * (up to twice) until it is right.
 */
export type TeamRole = "planner" | "reviewer";

/** A model that helps the main one in a conversation. */
export interface Teammate {
  role: TeamRole;
  modelId: string;
}

/** A tool's own view (MCP Apps): which server and `ui://` resource, and what the view is given. */
export interface McpAppRef {
  /** The MCP server's id in KesherAI. */
  server: string;
  /** The view, e.g. `ui://weather/forecast`. */
  uri: string;
  /** The tool's input. */
  input: unknown;
  /** The tool's raw result (content and structuredContent). */
  result: unknown;
}
