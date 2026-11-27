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
import type { HelperEngine } from "./chat-helpers.js";
import type { FreeCloudPool } from "./free-cloud.js";

/** Services the conversation manager needs. */
export interface ConversationDeps {
  registry: ProviderRegistry;
  /** Free cloud helpers: a chat's fallback when its local model is off, if the user allowed it (free-cloud.ts). */
  freeCloud?: FreeCloudPool;
  library: Library;
  assets: AssetStore;
  plugins: PluginHost;
  config: KesherConfig;
  /** Folder for the files chats make (one sub-folder per conversation). */
  outputsDir: string;
  /** Saves the project folder before each message in coding sessions. */
  checkpoints?: Checkpoints;
  /** Checkpoints of the game-project files a chat's engine tools write (one per turn). */
  gameCheckpoints?: import("./game-checkpoints.js").GameCheckpoints;
  /** A Unity scene's stand-in (read, list, queue moves), for the level-design tools: it lives with the routes. */
  unityScenes?: Pick<import("./level-design-tools.js").LevelDesignDeps, "readUnity" | "unityScenes" | "queueUnity">;
  /** Where each agent run's earlier files are kept, for "Undo all" on its receipt. */
  undoDir?: string;
  /**
   * Finds an image model that runs on this computer when none usable is
   * active: uses a downloaded one, or starts downloading the best fit.
   */
  ensureImageModel?(): Promise<{ modelId?: string; message?: string }>;
  /** Video generation (Wan on stable-diffusion.cpp): finds or downloads the model, and makes a clip. */
  video?: {
    ensure(): Promise<{ path?: string; message?: string }>;
    generate(path: string, req: { prompt: string; negativePrompt?: string; seconds?: number; seed: number }, signal?: AbortSignal, onProgress?: (p: import("@kesher/shared").JobProgress) => void): Promise<{ data: Uint8Array; mimeType: string; meta?: Record<string, unknown> }>;
  };
  /** The ready-made ComfyUI flows (music, 3D), run from the chat. */
  flows?: {
    state(id: string): { ready: boolean; downloading: boolean; missingGb: number; installed: boolean; allowed: boolean };
    setup(id: string): Promise<void>;
    run(
      id: string,
      edit: (flow: Record<string, { class_type: string; inputs: Record<string, unknown> }>, upload: (data: Uint8Array, name: string, subfolder?: string) => Promise<string>) => Promise<void> | void,
      signal: AbortSignal,
      /** Live steps and preview frames (ComfyUI's socket), for the chat bubble. */
      onProgress?: (p: import("@kesher/shared").JobProgress) => void,
    ): Promise<Array<{ data: Uint8Array; mimeType: string; filename: string }>>;
  };
  /** ComfyUI for graphs KesherAI builds itself (pbr-flow.ts: the tileable PBR texture). */
  comfyGraph?: import("./pbr-flow.js").ComfyGraphRunner;
  /** Unity's CLI: the chat's Unity tools (when the CLI is installed). */
  unity?: UnityCli;
  /** The task board shared with Claude (self-work). */
  board?: TaskBoard;
  /** The KesherAI Bridge plugin in Unreal: the chat's Blueprint tools (when the editor is connected). */
  unreal?: UnrealBridge;
  /** The Godot editor's link: the chat's Godot tools. */
  godot?: import("./godot-bridge.js").GodotBridge;
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
  /** The user's name and how to address her, as a note for the model ("" when not set). */
  aboutUser?(): string;
  /** The remember / forget tools for the user's memory (none when memory is off). */
  memoryTools?(convId?: string): AgentTool[];
  /** Search and read past chats (past-chat-tools.ts); none in an incognito chat. */
  pastChatTools?(convId?: string): AgentTool[];
  /** Travel search and price watches (travel/tools.ts); the group's words decide when a message gets them. */
  travelTools?(): AgentTool[];
  /** set_timer and notify_user for a chat (chat-timers.ts). */
  timerTools?(convId: string): AgentTool[];
  /** The `canvas` tool for a chat (canvas.ts). */
  canvasTools?(convId: string): AgentTool[];
  /**
   * Saves a deep research's report as a new document of the chat (docs.ts), opened beside the chat.
   *
   * @returns Its id and version, or undefined when the chat keeps no documents (incognito).
   */
  writeReport?(convId: string, title: string, body: string): Promise<{ id: string; ver: number } | undefined>;
  /** The user's memory by topic: read into prompts, filled after turns. */
  memory?: MemoryStore;
  /** Saved personas. */
  personas?: Personas;
  /** SKILL.md skills, listed in the prompt and loaded with use_skill. */
  skills?: SkillStore;
  /** The built-in engine's JSON call for the tool router (tool-router.ts), or undefined while no model is loaded. */
  routeAsk?(): import("./tool-router.js").AskJson | undefined;
  /** The small model loaded beside the main one as a JSON call (side-engine.ts), for Auto's router; undefined when none. */
  besideAsk?(): import("./tool-router.js").AskJson | undefined;
  /** The context each chat gets on KesherAI's own engine, as it reported it (2 chats at once share it). */
  engineSlotTokens?(): number | undefined;
  /** Facts learned per project from its chats' failing commands (project-facts.ts). */
  projectFacts?: ProjectFacts;
  /** Every event of every open conversation (for notifications). */
  onEvent?(conversationId: string, event: AgentEvent, title: () => string, lastAnswer: () => string | undefined): void;
  /** Whether KesherAI's own browser pane (the desktop app) is there. */
  browserPane?(): boolean;
  /** Browser and computer decisions (safety v2's action log), shared with the routes. */
  controlLog?: import("./control-policy.js").ControlLog;
  /** Keeps a picture as an asset (approval card v2's crop of the target); its id. */
  saveImage?(data: Buffer, mimeType: string): Promise<string>;
  /** The built-in engine as helpers need it (chat-helpers.ts): what is loaded, the card, model files, loading. */
  helperEngine?: HelperEngine;
  /** The translator's model id: a GGUF translator (TranslateGemma) is loaded beside the main model when needed. */
  translatorModel?(pick: string): Promise<string>;
  /** KesherAI's translator (translate.ts): English prompts for image, video and music models. */
  translator?: import("./translate.js").Translator;
  /**
   * Model size per turn: the small model loaded beside the main one (side-engine.ts), when one is running and is
   * smaller than the main model; never loads one by itself.
   */
  smallModel?(): string | undefined;
  /** An attached recording or video, read for the model: its transcript and a few frames (speech-tools.ts readMedia). */
  readMedia?(path: string): Promise<{ transcript: string; engine?: string; frames: Buffer[] }>;
  /** Tor, for pages that do not open directly (when installed). */
  tor?: import("./tor.js").Tor;
  /** KesherAI's fault log (failed chats are written to it; the doctor tool reads it). */
  faults?: import("./fault-log.js").FaultLog;
  /** KesherAI's state for the doctor tool. */
  doctorState?(): Promise<Record<string, unknown>>;
  /** Saves the settings (after "Always allow on this site" adds a site). */
  saveConfig?(): Promise<void> | void;
}
