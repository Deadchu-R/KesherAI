import type { Teammate, AgentEvent, AgentMessage, PermissionMode } from "./agent.js";

/**
 * A project groups conversations. It can carry a workspace folder (code
 * conversations in it work there) and instructions added to every
 * conversation's system prompt.
 */
export interface Project {
  id: string;
  name: string;
  /** Absolute folder for code conversations. */
  workspace?: string;
  /** Extra instructions for every conversation in the project. */
  instructions?: string;
  createdAt: string;
  updatedAt: string;
}

/** Which kind of conversation: plain chat, or a coding agent in a folder. */
export type ConversationKind = "chat" | "code";

/** A saved conversation, with everything needed to resume it. */
export interface Conversation {
  id: string;
  /** `null` = not in a project. */
  projectId: string | null;
  title: string;
  kind: ConversationKind;
  modelId: string;
  mode: PermissionMode;
  /** For code conversations: the folder. Falls back to the project's. */
  workspace?: string;
  /** Other models that plan or review alongside the main one. */
  team?: Teammate[];
  /** What the model sees. */
  messages: AgentMessage[];
  /** What the user sees. */
  events: AgentEvent[];
  createdAt: string;
  updatedAt: string;
}

/** A conversation without its messages and events, for lists. */
export type ConversationSummary = Omit<Conversation, "messages" | "events">;

/** User settings that live outside the provider list. */
export interface AppSettings {
  /**
   * Active model per category id (`chat`, `image`, `video`, …). Chat models
   * get a tool for every active model whose category has one.
   */
  activeModels: Record<string, string>;
  /**
   * A folder kept in sync by a cloud app (Google Drive for desktop, OneDrive,
   * Dropbox). Projects and conversations are mirrored there.
   */
  syncFolder?: string;
}
