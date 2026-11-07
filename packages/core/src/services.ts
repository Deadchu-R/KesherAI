import type { ProviderRegistry } from "@kesher/providers";
import type { DownloadManager } from "@kesher/downloads";
import type { KesherConfig, DataPaths } from "./config.js";
import type { AssetStore } from "./assets.js";
import type { PluginHost } from "./plugins.js";
import type { LlamaEngine } from "./llamacpp.js";
import type { Library } from "./library.js";
import type { ConversationManager } from "./conversations.js";
import type { Updater } from "./updates.js";
import type { GoogleDrive } from "./google.js";
import type { DriveSync } from "./drive-sync.js";
import type { Tunnel } from "./tunnel.js";
import type { SdEngine } from "./sdcpp.js";
import type { Coach } from "./coach.js";
import type { ComputerControl } from "./computer.js";
import type { WhisperEngine } from "./whisper.js";
import type { McpManager } from "./mcp.js";
import type { GitHubAuth } from "./github.js";
import type { Runtimes } from "./runtimes.js";
import type { Devices } from "./devices.js";
import type { Speeds } from "./speeds.js";
import type { Journal } from "./journal.js";
import type { Knowledge } from "./knowledge.js";
import type { Personas } from "./personas.js";
import type { Prompts } from "./prompts.js";
import type { Notifier } from "./notify.js";
import type { SkillStore } from "./skill-store.js";
import type { Pipelines } from "./pipelines.js";
import type { ComfyManager } from "./comfy-manager.js";
import type { ConversationSearch } from "./conversation-search.js";

/**
 * Everything a route needs, created once in `createKesherServer` and passed
 * to every route module. Routes never create services themselves, which
 * keeps them easy to test with fakes.
 */
export interface KesherServices {
  config: KesherConfig;
  paths: DataPaths;
  registry: ProviderRegistry;
  assets: AssetStore;
  downloads: DownloadManager;
  plugins: PluginHost;
  /** The built-in llama.cpp engine. */
  engine: LlamaEngine;
  /** Saved projects and conversations. */
  library: Library;
  /** Live conversations. */
  conversations: ConversationManager;
  /** Checks for and applies updates. */
  updater: Updater;
  /** Google sign-in and Drive access. */
  google: GoogleDrive;
  /** Keeps the library in step with Google Drive. */
  driveSync: DriveSync;
  /** The built-in image engine (stable-diffusion.cpp). */
  sd: SdEngine;
  /** Speech to text (whisper.cpp). */
  whisper: WhisperEngine;
  /** Computer control (screen, mouse, keyboard) with its app approvals, stop switch and log. */
  computer: ComputerControl;
  /** Suggests better prompts, tools and models from how conversations went; learns the user's habits. */
  coach: Coach;
  /** MCP servers and their tools. */
  mcp: McpManager;
  /** Node.js and uv for MCP servers, installed by KesherAI on request. */
  runtimes: Runtimes;
  /** Measured writing speed per model on this computer. */
  speeds: Speeds;
  /** "My devices": the user's other computers, through their Google account. */
  devices: Devices;
  /** "Connect with GitHub". */
  github: GitHubAuth;
  /** "My day": the opt-in journal of the screen. */
  journal: Journal;
  /** Knowledge bases: folders and web pages the models search, with sources. */
  knowledge: Knowledge;
  /** Saved personas: instructions, model and knowledge base per assistant. */
  personas: Personas;
  /** The prompt library, run with `/command` in a message box. */
  prompts: Prompts;
  /** Notifications on the phone (ntfy) and this computer. */
  notifier: Notifier;
  /** SKILL.md skills. */
  skills: SkillStore;
  /** Pipelines: chains of steps with conditions and loops. */
  pipelines: Pipelines;
  /** KesherAI's managed ComfyUI. */
  comfy: ComfyManager;
  /** Search across conversations. */
  conversationSearch: ConversationSearch;
  /** "Access from anywhere" (Cloudflare tunnel). */
  tunnel: Tunnel;
  /** Ids of providers found by auto-detection (not saved in the config file). */
  autodetected: Set<string>;
  /** Persists `config` to disk. */
  saveConfig(): Promise<void>;
  /** Registers (or re-registers) the `llamacpp` provider for the running engine. */
  registerEngineProvider(): void;
}
