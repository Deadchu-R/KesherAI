/**
 * `KesherServices`: the one object every route receives (`s` in routes/*.ts). It holds the live parts of the
 * app (provider registry, conversation manager, engine, guard, notifier, downloads, config…), so a route never
 * creates its own and everything shares one state.
 */
import type { ModelUse } from "./pc-fix.js";
import type { ControlWatchers } from "./control-live.js";
import type { MemoryStore } from "./memory-store.js";
import type { ProjectFacts } from "./project-facts.js";
import type { SelfWork } from "./self-work.js";
import type { TaskBoard } from "./task-board.js";
import type { HubClient } from "./hub-client.js";
import type { ProviderRegistry } from "@kesher/providers";
import type { DownloadManager } from "@kesher/downloads";
import type { KesherConfig, DataPaths } from "./config.js";
import type { AssetStore } from "./assets.js";
import type { PluginHost } from "./plugins.js";
import type { InstallRequests } from "./plugin-store.js";
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
import type { Journal, ScreenSource } from "./journal.js";
import type { Study } from "./study.js";
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
  /** Folders that hold the bundled plugins (and the store's `index.json`). */
  pluginRoots: string[];
  /** Install requests from paired devices, waiting for the computer's approval. */
  pluginInstallRequests: InstallRequests;
  /** The built-in llama.cpp engine. */
  engine: LlamaEngine;
  /** The chat model files on this computer (KesherAI's own and the scanned folders), cached for 5 minutes. */
  localModels?: () => Promise<Array<{ path: string; name: string; size: number }>>;
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
  /** Frees the graphics card while a game plays in Unity or Unreal (set when the engines start). */
  playStandby?: import("./play-standby.js").PlayStandby;
  /** Tor for blocked pages. */
  tor: import("./tor.js").Tor;
  /** KesherAI's fault log. */
  faults: import("./fault-log.js").FaultLog;
  /** The Unreal Editor's connection (KesherAI Bridge plugin) and saved Blueprints. */
  unreal: UnrealBridge;
  /** The Godot editor's connection (KesherAI Bridge addon). */
  godot: import("./godot-bridge.js").GodotBridge;
  /** Unity projects through Unity's CLI (KesherAI Bridge package). */
  unity: UnityCli;
  /** Checkpoints around engine writes (the touched files, binaries too, on the heavy-data drive). */
  gameCheckpoints: import("./game-checkpoints.js").GameCheckpoints;
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
  /** Which chats a screen shows now (browser/computer approvals skip the phone notification then). */
  controlWatchers: ControlWatchers;
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
  /** Study (students): courses, lectures, flashcards and quizzes. */
  study: Study;
  /** Study model calls running now (a summary, a quiz, the tutor): an update waits for them. */
  studyBusy?: () => number;
  /** Lip sync for the avatar camera (optional, strong NVIDIA cards). */
  lipSync: import("./lipsync.js").LipSync;
  /** The avatar camera as a camera device (the Windows desktop app), when there is one. */
  virtualCamera?: import("./server/options.js").VirtualCamera;
  /** The screen, from the desktop app (the Game Helper's picture); absent without it. */
  screen?: ScreenSource;
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
  /** The link to the Kesher Cloud hub (off until the user turns it on). */
  hub?: HubClient;
  /** Tasks on all your devices: the inbox in the user's Google Drive (tasks-sync.ts; off until turned on). */
  tasksSync?: import("./tasks-sync.js").TasksSync;
  /** "Who does it": gives a task or a work-list item to another executor (task-assign.ts). */
  assignTask?: (taskId: string, to: import("@kesher/shared").AssignTo, confirm: boolean) => Promise<import("@kesher/shared").AssignResult>;
  /** The owner's names and notes for agent runs (agent-labels.ts). */
  agentLabels?: import("./agent-labels.js").AgentLabels;
  /** The task inbox (Claude's tasks on the kesher-inbox branch; Antigravity on the user's Run). */
  taskInbox?: import("./inbox-runner.js").TaskInbox;
  /** Set in worker mode: its version, and "move to the newer version after the current item". */
  worker?: { version: string; upgrade: () => void };
  /** Set in the main desktop app: starts the worker and says where it is. */
  workerHost?: { ensure: () => Promise<string>; url: () => string | undefined };
  /** KesherAI's managed ComfyUI. */
  comfy: ComfyManager;
  /** Paired devices' own keys (set once the server is built). */
  deviceKeys?: import("./device-keys.js").DeviceKeys;
  /** Who has which engine scene open (scene-rooms.ts), one set shared by the owner's and the guests' routes. */
  sceneRooms?: import("./scene-rooms.js").SceneRooms;
  /** Guests' answers per day (guests.ts), one count for their own chats and their replies in shared chats. */
  guestQuota?: import("./guests.js").GuestQuota;
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
  /** "Continue what was running" after a restart (resume-board.ts); the main app only, never a worker. */
  resume?: import("./resume-board.js").ResumeBoard;
  /** Search by meaning (embeddings). */
  semantic: Semantic;
  /** KesherAI's translator (translate.ts): the Translate page and English prompts for media models. */
  translator?: import("./translate.js").Translator;
  /** "Access from anywhere" (Cloudflare tunnel). */
  tunnel: Tunnel;
  /** Ids of providers found by auto-detection (not saved in the config file). */
  autodetected: Set<string>;
  /** Persists `config` to disk. */
  saveConfig(): Promise<void>;
  /** Registers (or re-registers) the `llamacpp` provider for the running engine. */
  registerEngineProvider(): void;
}
