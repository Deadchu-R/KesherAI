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
  /** How code sessions in this project get ready and what they can run (like Codex's local environments). */
  environment?: ProjectEnvironment;
  createdAt: string;
  updatedAt: string;
}

/** A chat's web search settings. */
export interface WebPrefs {
  /** Search only these sites (domains). */
  only?: string[];
  /** Never these sites. */
  never?: string[];
  /** quick: a few results, answer from them; normal; deep: more results and several pages read. */
  depth?: "quick" | "normal" | "deep";
  /** false: never open a blocked page through Tor in this chat (by default it tries, when Tor is installed). */
  tor?: boolean;
  /** From Settings → Web (not kept per chat): the search engine's safe search level. */
  safeSearch?: "strict" | "moderate" | "off";
  /** From Settings → Web: .onion sites may be opened (through Tor). */
  onion?: boolean;
}

/** Which buttons a chat's bar shows: button keys to shown (true) or hidden (false), over Settings' default. */
export type ChatBar = Record<string, boolean>;

/** Settings → Web: the user's own filter for every chat's web search and pages. */
export interface WebFilter {
  /** The search engine's safe search (default moderate). */
  safeSearch: "strict" | "moderate" | "off";
  /** Open .onion (dark web) sites through Tor (off by default). */
  onion: boolean;
  /** Sites never searched or opened, in any chat. */
  blocked: string[];
}

/** A project's environment for its code sessions. */
export interface ProjectEnvironment {
  /** Runs once in a new session worktree before the first message (e.g. `npm install`). */
  setup?: string;
  /** The same for Windows, when it differs. */
  setupWindows?: string;
  /** Named commands the session's page can start in its terminal (Dev server, Tests). */
  actions?: Array<{ name: string; command: string }>;
  /** Variables for the session's commands (not shown to the model). */
  env?: Record<string, string>;
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
  /** A code session in its own git worktree: the user's checkout, the worktree folder (= workspace), its branch. */
  worktree?: { repo: string; path: string; branch: string; base: string };
  /** How this chat searches the web: only / never these sites, and how deep (how many pages it reads). */
  web?: WebPrefs;
  /** Which buttons this chat's bar shows (over Settings' default). */
  bar?: ChatBar;
  /** Incognito: memory is neither read nor filled, and the chat is left out of search (like Claude's incognito chats). */
  incognito?: boolean;
  /** Watching the session's pull request: fix failing checks and/or merge when all checks pass (like Claude Code). */
  prWatch?: { autoFix: boolean; autoMerge: boolean; fixedSha?: string };
  /** A named environment picked when the session started (see namedEnvironments); else the folder's. */
  envId?: string;
  /** The folder the session was started in (its environment is that folder's; with a worktree, not the worktree). */
  envFolder?: string;
  /** Other models that plan or review alongside the main one. */
  team?: Teammate[];
  /** Agent group: personas the chat's model leads, asking each for its part of a task. */
  group?: string[];
  /** The persona this chat talks as (its instructions join the system prompt). */
  personaId?: string;
  /** For a branch: the conversation and event it was branched from. */
  branchOf?: { id: string; seq: number; title: string };
  /** Where the chat is written from: `telegram` chats ask before every change and get no computer or browser control. */
  source?: "telegram";
  /** For a chat imported from another assistant: which one. */
  importedFrom?: "chatgpt" | "claude" | "gemini" | "openwebui" | "jan" | "claude-code";
  /** A code chat on an outside agent (Antigravity): its own session id, resumed after a restart. */
  agentSession?: string;
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
