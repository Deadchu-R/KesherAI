/**
 * What the conversation manager, and the tools it gives chats, need from the rest of KesherAI. One named type,
 * so the tool builders that moved out of conversations.ts (t7) take the same services the manager has.
 */
import type { MemoryStore } from "./memory-store.js";
import type { Checkpoints } from "./checkpoints.js";
import { type Personas } from "./personas.js";
import type { ProjectFacts } from "./project-facts.js";
import type { SkillStore } from "./skill-store.js";
import { type AgentTool } from "@kesher/agent";
import { type Appearance, type AgentEvent } from "@kesher/shared";
import type { ProviderRegistry } from "@kesher/providers";
import type { KesherConfig } from "./config.js";
import type { AssetStore } from "./assets.js";
import type { UnityCli } from "./unity-cli.js";
import type { TaskBoard } from "./task-board.js";
import type { UnrealBridge } from "./unreal-bridge.js";
import type { PluginHost } from "./plugins.js";
import type { Library } from "./library.js";

/** Services the conversation manager needs. */
export interface ConversationDeps {
  registry: ProviderRegistry;
  library: Library;
  assets: AssetStore;
  plugins: PluginHost;
  config: KesherConfig;
  /** Folder for the files chats make (one sub-folder per conversation). */
  outputsDir: string;
  /** Saves the project folder before each message in coding sessions. */
  checkpoints?: Checkpoints;
  /**
   * Finds an image model that runs on this computer when none usable is
   * active: uses a downloaded one, or starts downloading the best fit.
   */
  ensureImageModel?(): Promise<{ modelId?: string; message?: string }>;
  /** Video generation (Wan on stable-diffusion.cpp): finds or downloads the model, and makes a clip. */
  video?: {
    ensure(): Promise<{ path?: string; message?: string }>;
    generate(path: string, req: { prompt: string; negativePrompt?: string; seconds?: number; seed: number }): Promise<{ data: Uint8Array; mimeType: string; meta?: Record<string, unknown> }>;
  };
  /** The ready-made ComfyUI flows (music, 3D), run from the chat. */
  flows?: {
    state(id: string): { ready: boolean; downloading: boolean; missingGb: number; installed: boolean; allowed: boolean };
    setup(id: string): Promise<void>;
    run(
      id: string,
      edit: (flow: Record<string, { class_type: string; inputs: Record<string, unknown> }>, upload: (data: Uint8Array, name: string) => Promise<string>) => Promise<void> | void,
      signal: AbortSignal,
    ): Promise<Array<{ data: Uint8Array; mimeType: string; filename: string }>>;
  };
  /** Unity's CLI: the chat's Unity tools (when the CLI is installed). */
  unity?: UnityCli;
  /** The task board shared with Claude (self-work). */
  board?: TaskBoard;
  /** The KesherAI Bridge plugin in Unreal: the chat's Blueprint tools (when the editor is connected). */
  unreal?: UnrealBridge;
  /** How the app looks: the change_look tool reads and changes it (Undo keeps the last looks). */
  look?: {
    get(): Appearance;
    set(next: Appearance): Promise<void>;
    undo(): Promise<boolean>;
  };
  /** Computer-control tools for a conversation (empty when the user has not turned it on). */
  computerTools?(conversationId: string): AgentTool[];
  /** Tools from connected apps: Gmail and Calendar (Google sign-in) and MCP servers. */
  mcpTools?(): AgentTool[];
  /** Notes the coach learned about how the user works, added to every system prompt. */
  userNotes?(): Promise<string[]>;
  /** The remember / forget tools for the user's memory (none when memory is off). */
  memoryTools?(convId?: string): AgentTool[];
  /** The user's memory by topic: read into prompts, filled after turns. */
  memory?: MemoryStore;
  /** Saved personas. */
  personas?: Personas;
  /** SKILL.md skills, listed in the prompt and loaded with use_skill. */
  skills?: SkillStore;
  /** The context each chat gets on KesherAI's own engine, as it reported it (2 chats at once share it). */
  engineSlotTokens?(): number | undefined;
  /** Facts learned per project from its chats' failing commands (project-facts.ts). */
  projectFacts?: ProjectFacts;
  /** Every event of every open conversation (for notifications). */
  onEvent?(conversationId: string, event: AgentEvent, title: () => string, lastAnswer: () => string | undefined): void;
  /** Whether KesherAI's own browser pane (the desktop app) is there. */
  browserPane?(): boolean;
  /** Tor, for pages that do not open directly (when installed). */
  tor?: import("./tor.js").Tor;
  /** Saves the settings (after "Always allow on this site" adds a site). */
  saveConfig?(): Promise<void> | void;
}
