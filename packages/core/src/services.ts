/**
 * `KesherServices`: the one object every route receives (`s` in routes/*.ts). It holds the live parts of the
 * app (provider registry, conversation manager, engine, guard, notifier, downloads, config…), so a route never
 * creates its own and everything shares one state.
 */
import type { ModelUse } from "./pc-fix.js";
import type { MemoryStore } from "./memory-store.js";
import type { ProjectFacts } from "./project-facts.js";
import type { SelfWork } from "./self-work.js";
import type { TaskBoard } from "./task-board.js";
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
import type { OneDrive } from "./onedrive.js";
import type { GpuGuard } from "./gpu-guard.js";
import type { UnrealBridge } from "./unreal-bridge.js";
import type { UnityCli } from "./unity-cli.js";
import type { Copilot } from "./copilot.js";
import type { BusinessPolicy } from "./business.js";
import type { Tunnel } from "./tunnel.js";
import type { SdEngine } from "./sdcpp.js";
import type { BrowserBridge } from "./browser-bridge.js";
import type { Speakers } from "./speakers.js";
import type { Kokoro } from "./kokoro.js";
import type { Coach } from "./coach.js";
import type { ComputerControl } from "./computer.js";
import type { WhisperEngine } from "./whisper.js";
import type { McpManager } from "./mcp.js";
import type { GitHubAuth } from "./github.js";
import type { Runtimes } from "./runtimes.js";
import type { Devices } from "./devices.js";
import type { Speeds } from "./speeds.js";
import type { Journal } from "./journal.js";
import type { Libraries } from "./libraries.js";
import type { Knowledge } from "./knowledge.js";
import type { Personas } from "./personas.js";
import type { Prompts } from "./prompts.js";
import type { Notifier } from "./notify.js";
import type { SkillStore } from "./skill-store.js";
import type { Pipelines } from "./pipelines.js";
import type { Routines } from "./routines.js";
import type { ComfyManager } from "./comfy-manager.js";
import type { ConversationSearch } from "./conversation-search.js";
import type { Semantic } from "./semantic.js";

/**
 * Everything a route needs, created once in `createKesherServer` and passed
 * to every route module. Routes never create services themselves, which
 * keeps them easy to test with fakes.
 */
export interface KesherServices {
  /** Facts learned per project from its chats (project-facts.ts). */
  projectFacts: ProjectFacts;
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
  /** Microsoft sign-in and OneDrive access. */
  onedrive: OneDrive;
  /** Keeps the library in step with OneDrive. */
  onedriveSync: DriveSync;
  /** Protects the graphics card: temperature limit, pause, unloading idle models. */
  guard: GpuGuard;
  /** Tor for blocked pages. */
  tor: import("./tor.js").Tor;
  /** KesherAI's fault log. */
  faults: import("./fault-log.js").FaultLog;
  /** The Unreal Editor's connection (KesherAI Bridge plugin) and saved Blueprints. */
  unreal: UnrealBridge;
  /** Unity projects through Unity's CLI (KesherAI Bridge package). */
  unity: UnityCli;
  /** Microsoft 365 Copilot sign-in. */
  copilot: Copilot;
  /** Business mode in force (an administrator's policy.json, else Settings). */
  business: () => BusinessPolicy;
  /** Whether business mode comes from policy.json (and cannot be changed in the app). */
  businessManaged: () => boolean;
  /** Applies business mode to the provider registry after a change. */
  applyBusiness: () => void;
  /** The built-in image engine (stable-diffusion.cpp). */
  sd: SdEngine;
  /** The link to the KesherAI browser extension. */
  browser: BrowserBridge;
  /** Speech to text (whisper.cpp). */
  whisper: WhisperEngine;
  /** Tells speakers apart in meeting recordings. */
  speakers: Speakers;
  /** A natural English voice on this computer (Kokoro). */
  kokoro: Kokoro;
  /** Computer control (screen, mouse, keyboard) with its app approvals, stop switch and log. */
  computer: ComputerControl;
  /** Suggests better prompts, tools and models from how conversations went; learns the user's habits. */
  coach: Coach;
  /** The user's memory by topic (see memory-store.ts). */
  memory: MemoryStore;
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
  /** The library store: documentation downloaded once for offline work (each one a knowledge base). */
  libraries: Libraries;
  /** Saved personas: instructions, model and knowledge base per assistant. */
  personas: Personas;
  /** The prompt library, run with `/command` in a message box. */
  prompts: Prompts;
  /** Notifications on the phone (ntfy) and this computer. */
  notifier: Notifier;
  /** The phone app's own notifications (phone-push.ts). */
  phonePush: import("./phone-push.js").PhonePush;
  /** SKILL.md skills. */
  skills: SkillStore;
  /** Pipelines: chains of steps with conditions and loops. */
  pipelines: Pipelines;
  /** Pipelines and prompts on a schedule. */
  routines: Routines;
  /** KesherAI working on a git project by itself (set once the chats exist). */
  selfWork?: SelfWork;
  /** When each model was last loaded (PC Health's "Fix it for me"). */
  modelUse?: ModelUse;
  /** The task board self-work shares with Claude. */
  board?: TaskBoard;
  /** Set in worker mode: its version, and "move to the newer version after the current item". */
  worker?: { version: string; upgrade: () => void };
  /** Set in the main desktop app: starts the worker and says where it is. */
  workerHost?: { ensure: () => Promise<string>; url: () => string | undefined };
  /** KesherAI's managed ComfyUI. */
  comfy: ComfyManager;
  /** Paired devices' own keys (set once the server is built). */
  deviceKeys?: import("./device-keys.js").DeviceKeys;
  /** Search across conversations. */
  conversationSearch: ConversationSearch;
  /** When the model APIs last answered another app or device (ms), for staying awake while serving. */
  lastServed?: () => number;
  /** Brings the desktop app's window to the front (after signing in in the browser). */
  focusApp?: () => void;
  /** Restarts the desktop app (and installs a downloaded update); absent when run from the command line. */
  restartApp?: () => void;
  /** Set while KesherAI restarts (the tunnel is kept for the next start). */
  restarting?: boolean;
  /** Search by meaning (embeddings). */
  semantic: Semantic;
  /** "Access from anywhere" (Cloudflare tunnel). */
  tunnel: Tunnel;
  /** Ids of providers found by auto-detection (not saved in the config file). */
  autodetected: Set<string>;
  /** Persists `config` to disk. */
  saveConfig(): Promise<void>;
  /** Registers (or re-registers) the `llamacpp` provider for the running engine. */
  registerEngineProvider(): void;
}
