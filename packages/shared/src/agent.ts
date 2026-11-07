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
export type PermissionMode = "ask" | "auto-edit" | "auto";

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

/**
 * Everything that happens in a session, in order. Clients replay the list
 * to draw the conversation and follow new events live over SSE.
 */
export type AgentEvent = EventBase &
  (
    | { type: "user"; text: string }
    | { type: "assistant_delta"; turn: number; text: string }
    | { type: "assistant"; turn: number; text: string }
    | { type: "tool_call"; callId: string; name: string; input: Record<string, unknown> }
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
      }
    | { type: "approval_result"; requestId: string; decision: ApprovalDecision; feedback?: string }
    | { type: "question"; questionId: string; question: string; options?: string[] }
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
      }
    | { type: "undo"; path: string; restored: "previous" | "deleted" }
    | { type: "status"; status: AgentStatus; message?: string }
    | { type: "note"; text: string }
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
}
