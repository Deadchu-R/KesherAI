import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { branding } from "@kesher/shared";

/** One provider as stored in the config file. Mirrors `ProviderConfig`. */
const StoredProviderSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string().optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  location: z.enum(["local", "server", "cloud"]).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Schema of `config.json` in the data folder. Every field has a default, so
 * an empty file (or no file) is a valid config.
 */
export const KesherConfigSchema = z.object({
  /** Port of the core server. */
  port: z.number().int().default(branding.defaultPort),
  providers: z.array(StoredProviderSchema).default([]),
  /** Hugging Face access token, for gated repos. */
  huggingFaceToken: z.string().optional(),
  comfyui: z
    .object({
      /** ComfyUI's `models` folder. When set, image downloads go to its sub-folders. */
      modelsDir: z.string().optional(),
      /** The user's own ComfyUI folder for KesherAI to start (empty: KesherAI's own copy). */
      folder: z.string().optional(),
      /** Port KesherAI starts ComfyUI on. */
      port: z.number().int().default(8188),
      /** Start ComfyUI when KesherAI starts. */
      autoStart: z.boolean().default(false),
      /** The graphics card (index, PCI order) ComfyUI runs on; unset: all cards (ComfyUI picks). */
      gpu: z.number().int().min(0).max(15).optional(),
    })
    .prefault({}),
  engines: z
    .object({
      /** Path of the `llama-server` binary from llama.cpp. */
      llamaServerPath: z.string().optional(),
      /** Port KesherAI starts llama-server on. */
      llamaServerPort: z.number().int().default(8081),
      /** Extra arguments, e.g. `["-c", "8192"]`. `--jinja` (tool calling) is always added; the GPU layers are fitted by llama.cpp (see LlamaEngine.gpuArgs). */
      llamaServerArgs: z.array(z.string()).default([]),
      /** llama.cpp release tag KesherAI installed, e.g. `b6500`. */
      llamaVersion: z.string().optional(),
      /** Which build of llama.cpp is installed ("Linux, CPU", "Linux, Vulkan (…)"): a CPU build is replaced when a card shows up. */
      llamaBuild: z.string().optional(),
      /** The GGUF file loaded last, loaded again on start-up when `autoLoadLast` is on. */
      lastModel: z.string().optional(),
      autoLoadLast: z.boolean().default(true),
      /** The last model was unloaded for being unused (or stopped by hand): not loaded again at start-up, only when a
       * request needs it (an update's restart filled the graphics card again with a model nobody was using). */
      lastUnloaded: z.boolean().optional(),
      /** The embedding model file the built-in engine runs for search by meaning. */
      embedModel: z.string().optional(),
      /** How many chats the built-in engine answers at the same time (llama-server slots). */
      // One chat at a time by default: the whole context for it (Roee, Nov 11). Settings → Computer offers up to 8.
      parallel: z.number().int().min(1).max(8).default(1),
      /** Multi-token prediction: tokens guessed ahead (unset: 2; 0: off). */
      mtpDraft: z.number().int().min(0).max(16).optional(),
      /** Graphics memory llama.cpp leaves free when it fits a model (MiB; unset: 2048), for a game or editor on the same card. */
      fitTargetMiB: z.number().int().min(512).max(16384).optional(),
      /** The context memory's type (unset: 8 bits). Set by calibration or by hand. */
      kvType: z.enum(["f16", "q8_0"]).optional(),
      /** Load settings per model file (its name): context, context memory, expert layers on the processor, more arguments. */
      modelSettings: z
        .record(
          z.string(),
          z.object({
            ctx: z.number().int().optional(),
            kv: z.enum(["f16", "q8_0", "q4_0"]).optional(),
            cpuMoe: z.number().int().optional(),
            flash: z.enum(["on", "off"]).optional(),
            extra: z.array(z.string()).optional(),
          }),
        )
        .default({}),
      /** Calibration results, by model file name and graphics card (calibrate.ts). */
      calibrations: z.record(z.string(), z.object({ at: z.string(), gpu: z.string(), rows: z.array(z.object({ kv: z.enum(["f16", "q8_0"]), depth: z.number(), read: z.number().optional(), write: z.number().optional() })), kv: z.enum(["f16", "q8_0"]) })).prefault({}),
      /** How models use the graphics cards (see gpus.ts). */
      gpus: z
        .object({
          mode: z.enum(["auto", "fastest", "all"]).default("auto"),
          use: z.array(z.number().int().min(0)).optional(),
          split: z.array(z.number().positive()).optional(),
          main: z.number().int().min(0).optional(),
        })
        .prefault({}),
    })
    .prefault({}),
  /** Where KesherAI downloads models. Defaults to `models` in the data folder. */
  modelsDir: z.string().optional(),
  /** Where self-work makes its copies of a project (a folder per run). Defaults to `<project>-self-work` next to it. */
  selfWorkDir: z.string().optional(),
  /** The folder for heavy things on another drive (engines, the worker's data, Unreal builds, outputs move there). */
  heavyDir: z.string().optional(),
  /** Heavy folders copied and waiting for the next start to finish moving (heavy-folder.ts). */
  heavyPending: z.array(z.object({ name: z.enum(["engines", "worker", "unreal", "outputs"]), to: z.string() })).default([]),
  /** Other folders with models (from "Scan computer" or added by hand). KesherAI only reads them. */
  modelFolders: z.array(z.object({ folder: z.string(), source: z.string() })).default([]),
  /**
   * Permanent approvals: run a tool without asking, in one conversation, with
   * one model, or everywhere. Dangerous commands always ask anyway.
   */
  permissions: z
    .array(
      z.object({
        tool: z.string(),
        scope: z.enum(["conversation", "model", "everywhere"]),
        conversationId: z.string().optional(),
        modelId: z.string().optional(),
        createdAt: z.string().optional(),
        /** Ends at this time (ISO); none = for good. */
        until: z.string().optional(),
        /** For a command tool: only commands that start with this (e.g. "pnpm test"); none = any command. */
        command: z.string().optional(),
      }),
    )
    .default([]),
  /**
   * Helpers in the chat (Settings > Helpers; docs/RESEARCH_LOG.md, "Helper agents in the chat"): the model per type
   * (`auto`, `inherit`, `small`, `strong` or a model id), steps per type, how many at once (absent = by the card),
   * the time cap, and per project folder whether a cloud helper may read its files (asked once).
   */
  helpers: z
    .object({
      models: z.object({ lookup: z.string().default("auto"), research: z.string().default("auto"), build: z.string().default("auto") }).prefault({}),
      steps: z.object({ lookup: z.number().int().min(2).max(60).default(8), research: z.number().int().min(2).max(60).default(20), build: z.number().int().min(2).max(60).default(30) }).prefault({}),
      atOnce: z.number().int().min(1).max(4).optional(),
      minutes: z.number().int().min(1).max(60).default(10),
      cloudProjects: z.record(z.string(), z.boolean()).prefault({}),
    })
    .prefault({}),
  /** Active model per category id, e.g. `{ "chat": "llamacpp/Qwen3-8B-Q4_K_M", "image": "comfyui/flux1-dev.safetensors" }`. */
  activeModels: z.record(z.string(), z.string()).prefault({}),
  /** Google Drive sign-in. The client id defaults to the one in branding.config.ts. */
  google: z
    .object({
      clientId: z.string().optional(),
      clientSecret: z.string().optional(),
      refreshToken: z.string().optional(),
      email: z.string().optional(),
      /** The account's name and picture, for the account button. */
      name: z.string().optional(),
      picture: z.string().optional(),
      folderId: z.string().optional(),
      lastSync: z.string().optional(),
      lastError: z.string().optional(),
      services: z.array(z.enum(["gmail", "calendar", "drive", "sync"])).optional(),
    })
    .prefault({}),
  /** Unity projects the user added (worked on through Unity's CLI). */
  unity: z
    .object({
      projects: z.array(z.string()).default([]),
      active: z.string().optional(),
    })
    .prefault({}),
  /** Checkpoints around engine writes (game-checkpoints.ts): how long and how much the store keeps. */
  gameCheckpoints: z
    .object({
      days: z.number().int().min(1).max(3650).default(30),
      maxMB: z.number().int().min(50).max(1_000_000).default(4096),
    })
    .prefault({}),
  /** Talking to KesherAI from Telegram through the user's own bot (telegram.ts). */
  telegram: z
    .object({
      enabled: z.boolean().default(false),
      token: z.string().optional(),
      chats: z.array(z.number()).default([]),
      chatInfo: z.record(z.string(), z.object({ name: z.string(), pairedAt: z.string() })).prefault({}),
      conversations: z.record(z.string(), z.string()).prefault({}),
      approveCommands: z.boolean().default(false),
    })
    .prefault({}),
  /** How the app looks (checked by cleanAppearance in @kesher/shared), and the last looks for Undo. */
  appearance: z.record(z.string(), z.unknown()).prefault({}),
  appearanceHistory: z.array(z.record(z.string(), z.unknown())).default([]),
  /**
   * Kesher Cloud hub (hub-client.ts): off until the user turns it on. `token` (the device token) and `key` (this PC's
   * private key, JWK) are secrets: written encrypted, never sent to a page or logged.
   */
  hub: z
    .object({
      enabled: z.boolean().default(false),
      url: z.string().max(300).optional(),
      deviceId: z.string().max(64).optional(),
      token: z.string().max(200).optional(),
      key: z.string().max(1000).optional(),
      /** What this PC accepts from the hub (per-device opt-in; no tasks until turned on). */
      optIn: z
        .object({
          appear: z.boolean().default(true),
          acceptTasks: z.boolean().default(false),
          acceptLocal: z.boolean().default(false),
          acceptAntigravity: z.boolean().default(false),
          reportLinks: z.boolean().default(false),
          /** Live agent activity to the owner's phones (sealed metadata), and with it the touched files' names. */
          reportActivity: z.boolean().default(false),
          reportFileNames: z.boolean().default(false),
        })
        .prefault({}),
      /** Hub task ids whose result was already sent back. */
      reported: z.array(z.string().max(64)).default([]),
      /** Task-inbox reports already sent, as "<phone>/<task>" → a short hash of what was sent (only changes go again). */
      inboxSent: z.record(z.string().max(140), z.string().max(40)).default({}),
    })
    .prefault({}),
  /**
   * The task inbox (inbox-runner.ts; Settings > Task inbox): off until turned on. Antigravity runs only on the user's
   * own Run (on the PC, or the answer to the PC's ask on the paired phone). Defaults from Roee (2026-11-19): 10
   * Antigravity tasks a day, Gemini's default model.
   */
  taskInbox: z
    .object({
      enabled: z.boolean().default(false),
      paused: z.boolean().default(false),
      repo: z.string().max(500).optional(),
      branch: z.string().max(60).default("kesher-inbox"),
      fetchMinutes: z.number().int().min(1).max(120).default(5),
      dailyCap: z.number().int().min(0).max(100).default(10),
      maxMinutes: z.number().int().min(1).max(60).default(15),
      model: z.string().max(80).default(""),
      allowedPaths: z.array(z.string().max(120)).max(40).optional(),
      forbiddenPaths: z.array(z.string().max(120)).max(60).optional(),
      commands: z.array(z.string().max(120)).max(40).optional(),
      notWhileGame: z.boolean().default(true),
      notWhileEditor: z.boolean().default(true),
      gpuBusyPercent: z.number().int().min(0).max(100).default(40),
    })
    .prefault({}),
  /**
   * Tasks on all your devices (tasks-sync.ts): the task inbox's tasks and runs kept as sealed records in the hidden
   * KesherAI folder of the user's own Google Drive. Off until turned on (on this PC only).
   */
  tasksSync: z.object({ enabled: z.boolean().default(false), workList: z.boolean().default(true) }).prefault({}),
  /** CivitAI: the user's own key, for LoRAs that need one to download (Images → Find LoRAs); never sent to a page. */
  civitai: z.object({ token: z.string().max(200).optional() }).prefault({}),
  /** Figma: the user's personal access token (Settings → Appearance → Figma); never sent to a page. */
  figma: z.object({ token: z.string().max(200).optional() }).prefault({}),
  /** The student's Moodle (moodle.ts): its address, which Moodle course goes to which Study course, and files already brought in. */
  moodle: z.object({ base: z.string().max(200).optional(), map: z.record(z.string(), z.string()).default({}), seen: z.array(z.string()).default([]) }).prefault({}),
  /** Smart auto approvals (F10): in "auto-edit" chats, the chat's model reviews a plain command before you are asked. */
  autoReview: z.boolean().default(false),
  /**
   * The model team's translator (answer-language.ts): when a final answer is in another language than the user wrote
   * in (or mixes alphabets), its prose is translated. "main" uses the chat's own model, a model id a small translation
   * model (TranslateGemma), "off" turns it off. Unset: "main".
   */
  translator: z.string().max(300).optional(),
  /** Tool search for local models (only everyday tools in full; the rest loaded on demand). On unless false. */
  toolSearch: z.boolean().optional(),
  /** With tool search: the most tools sent in full per turn (the rest are listed in more_tools). Unset: 24. */
  toolCap: z.number().int().min(8).max(80).optional(),
  /** Model size per turn: simple messages go to a smaller model loaded beside the main one. On unless false. */
  smallTurns: z.boolean().optional(),
  /**
   * The user's own sidebar shortcuts (any page of the app, or a web address), the same on every device. Checked in
   * routes/shortcuts.ts: a page `#/…` or an http(s) address, never a script.
   */
  /** The sidebar's pinned tools in order (`#/images`…), the same on the computer and the phone; unset = the defaults. */
  pins: z.array(z.string().max(100)).max(40).optional(),
  shortcuts: z.array(z.object({ id: z.string().max(40), label: z.string().max(40), icon: z.string().max(8).optional(), image: z.string().max(70_000).optional(), href: z.string().max(500) })).max(25).default([]),
  /** Looks the user saved by name (Settings → Appearance → My looks). */
  savedLooks: z.array(z.object({ name: z.string().max(60), appearance: z.record(z.string(), z.unknown()) })).max(40).default([]),
  /** The first-run welcome: whether it was finished, and the role the user picked (shapes suggestions). */
  /** About the user: the name the app and the models call her by, and how to address her (Hebrew and other gendered languages). */
  user: z
    .object({
      name: z.string().max(60).optional(),
      /** f: feminine, m: masculine, p: plural (neutral). */
      address: z.enum(["f", "m", "p"]).optional(),
    })
    .prefault({}),
  onboarding: z
    .object({
      done: z.boolean().default(false),
      role: z.string().max(200).optional(),
      /** Simple mode: the menu shows chat, pictures, models and settings only (set for a new install). */
      simple: z.boolean().optional(),
    })
    .prefault({}),
  /** Protecting the graphics card: temperature limit, unloading idle models, low priority (see gpu-guard.ts). */
  guard: z
    .object({
      enabled: z.boolean().default(true),
      maxTemp: z.number().int().min(60).max(95).default(83),
      resumeTemp: z.number().int().min(50).max(90).default(75),
      unloadAfterMinutes: z.number().int().min(0).max(1440).default(20),
      gentle: z.boolean().default(false),
      maxRamPercent: z.number().int().min(0).max(98).default(0),
      maxCpuPercent: z.number().int().min(0).max(100).default(0),
      maxCpuTemp: z.number().int().min(0).max(105).default(0),
    })
    .prefault({}),
  /** Microsoft 365 Copilot (work or school account with a Copilot licence). */
  copilot: z
    .object({
      clientId: z.string().optional(),
      refreshToken: z.string().optional(),
      email: z.string().optional(),
      name: z.string().optional(),
      lastError: z.string().optional(),
      web: z.boolean().default(true),
    })
    .prefault({}),
  /**
   * Business mode: only the listed connections may be used (e.g. only
   * Copilot); every other model, local or cloud, is turned off. A
   * `policy.json` in the data folder, placed by an administrator, overrides
   * this and cannot be changed from the app.
   */
  business: z
    .object({
      enabled: z.boolean().default(false),
      allowed: z.array(z.string()).default(["copilot"]),
    })
    .prefault({}),
  /** OneDrive sign-in (Microsoft account). The application id defaults to the one in branding.config.ts. */
  onedrive: z
    .object({
      clientId: z.string().optional(),
      refreshToken: z.string().optional(),
      email: z.string().optional(),
      name: z.string().optional(),
      lastSync: z.string().optional(),
      lastError: z.string().optional(),
    })
    .prefault({}),
  /** "My devices": the user's computers find each other through their Google account. */
  devices: z
    .object({
      id: z.string().optional(),
      share: z.boolean().default(false),
      syncSettings: z.boolean().default(true),
      stamps: z.record(z.string(), z.object({ hash: z.string(), at: z.number() })).prefault({}),
    })
    .prefault({}),
  /** "Connect with GitHub" (device sign-in). */
  github: z
    .object({
      token: z.string().optional(),
      login: z.string().optional(),
      scopes: z.string().optional(),
      clientId: z.string().optional(),
    })
    .prefault({}),
  /** A cloud-synced folder (Google Drive for desktop, OneDrive, Dropbox) to mirror projects and conversations to. */
  syncFolder: z.string().optional(),
  /** A folder with an installer this computer built (electron-builder's output: latest.yml and the installer), passed on to my other computers. */
  updateBuildFolder: z.string().optional(),
  remote: z
    .object({
      /** Listen on all interfaces and accept other devices that present the token. */
      enabled: z.boolean().default(false),
      /** Shared secret for remote devices. Generated on first start. */
      token: z.string().optional(),
      /** Keep the computer from sleeping while remote access is on (desktop app only). */
      keepAwake: z.boolean().default(false),
      /** "Access from anywhere": run a Cloudflare tunnel while KesherAI runs. */
      anywhere: z.boolean().default(false),
      /**
       * Which internet link: "quick" (Cloudflare, no account, a new address each time it starts), "cloudflare"
       * (the user's own Cloudflare account and domain: a fixed address) or "tailscale" (Tailscale Funnel: a fixed
       * https://<computer>.<tailnet>.ts.net address).
       */
      anywhereMode: z.enum(["quick", "cloudflare", "tailscale"]).default("quick"),
      /** The user's own Cloudflare tunnel (mode "cloudflare"). */
      cloudflare: z.object({ hostname: z.string().optional(), tunnelId: z.string().optional() }).prefault({}),
      /** A key of its own for each paired device (only a hash is kept), so one can be removed without the others. */
      devices: z.array(z.object({ id: z.string(), name: z.string(), hash: z.string(), createdAt: z.string(), lastSeen: z.string().optional(), lastAddress: z.string().optional(), email: z.string().max(254).optional(), scope: z.union([z.literal("mcp"), z.string().regex(/^project:[\w-]{1,80}:(read|edit)$/)]).optional(), push: z.object({ endpoint: z.string().max(1000), p256dh: z.string().max(200), auth: z.string().max(100) }).optional() })).default([]),
      /** Through the internet link, only devices with their own key (not the shared token, which the QR code and other computers use). */
      anywhereDevicesOnly: z.boolean().default(false),
      /** Guests in a shared project (docs/COLLABORATION.md): answers a day for each, on this computer. */
      guestDailyLimit: z.number().int().min(1).max(10_000).default(100),
      /** Tell the owner when a guest uses a shared project at night (23:00–07:00 on this computer). */
      guestNightAlert: z.boolean().default(false),
      /** Google sign-in for email invites (an OAuth client of type "TVs and Limited Input devices", Roee's own). */
      guestGoogle: z.object({ clientId: z.string().max(200), clientSecret: z.string().max(200) }).optional(),
      /** Emails banned from every shared project (lower case). */
      guestBanned: z.array(z.string().max(254)).default([]),
      /** Through the internet link, a device key not used for this many days stops working (0 = never). */
      anywhereIdleDays: z.number().int().min(0).max(365).default(30),
      /** The internet address, encrypted for each paired phone, in an ntfy topic only that phone can name, so it finds the computer after the address changes (link-beacon.ts). */
      linkBeacon: z.boolean().default(true),
    })
    .prefault({}),
  /** Speech: how the microphone button turns speech into text. */
  /** Meetings in My day. */
  meetings: z
    .object({
      /** Tell the people on the call apart (keeps the call's audio until the write-up, then deletes it). */
      speakers: z.boolean().default(true),
      /** Keep the meeting's recording, so its transcript follows playback (off: deleted after the write-up). */
      keepRecording: z.boolean().default(false),
      /** How many days a kept recording stays (then only the transcript and write-up remain). */
      keepRecordingDays: z.number().int().min(1).max(3650).default(30),
    })
    .prefault({}),
  speech: z
    .object({
      /** `auto`: this computer when it can, else a connected cloud service; `local`; or `cloud:<connection id>` (Groq, OpenAI). */
      stt: z.string().default("auto"),
      /** Spoken language, or `auto`. */
      language: z.string().default("auto"),
    })
    .prefault({}),
  /** Computer control: models with vision see the screen and click and type (off until the user turns it on). */
  computer: z.object({ enabled: z.boolean().default(false) }).prefault({}),
  /** The coach (prompt and usage advice). */
  coach: z
    .object({
      /** Model that writes the advice; defaults to the conversation's own model. */
      modelId: z.string().optional(),
      /** Keep notes about how the user works and tell the models (local file `coach.json`). */
      learn: z.boolean().default(true),
    })
    .prefault({}),
  /** Keys for apps that use the APIs (/v1 and /mcp), one per app; only hashes are kept. */
  apiKeys: z.array(z.object({ id: z.string(), name: z.string(), hash: z.string(), prefix: z.string(), createdAt: z.string(), lastUsedAt: z.string().optional(), uses: z.number().optional() })).default([]),
  /** Ask apps on this computer for a key too (by default only other devices need one). */
  apiAuth: z.object({ requireKeyLocally: z.boolean().default(false) }).prefault({}),
  /** Download speed limit in megabytes per second (0: none). */
  downloadLimitMBps: z.number().min(0).default(0),
  /** The key the KesherAI browser extension connects with (shown in Settings → Browser). */
  browserKey: z.string().optional(),
  /** Sites where the browser tools may act without asking ("Always allow on this site"), e.g. "example.com". */
  browserSites: z.array(z.string()).default([]),
  /**
   * Whether helper agents may use "Always on this site" too. Off (the default): a helper asks before every action
   * on every site, whatever the chat allowed (decided by Claude overnight, 2026-11-20; reversible here).
   */
  browserHelperAlways: z.boolean().default(false),
  /**
   * Safety v2 for browser and computer control (control-policy.ts, Settings → Browser and computer): the chat's mode
   * (manual: ask each action; auto: a local reviewer first; skip: no asking, only with `controlSkipAllowed`), the
   * helpers' mode (never skip), the JavaScript policy, the user's sensitive sites (always asked) and blocked sites.
   */
  controlMode: z.enum(["manual", "auto", "skip"]).default("manual"),
  controlHelperMode: z.enum(["manual", "auto"]).default("manual"),
  /** The owner's explicit yes for Skip mode, given after a warning; without it Skip works as Manual. */
  controlSkipAllowed: z.boolean().default(false),
  controlJs: z.enum(["ask", "local", "off"]).default("ask"),
  controlSensitive: z.array(z.string()).default([]),
  controlBlocked: z.array(z.string()).default([]),
  /** The user's keyboard shortcuts (Settings → Keyboard): a combination per id, or null for off (see shortcuts.ts). */
  keyboardShortcuts: z.record(z.string(), z.string().nullable()).default({}),
  /** Turn off KesherAI's in-app shortcuts (global ones are turned off one by one). */
  keyboardOff: z.boolean().default(false),
  /** The Text Helper's own quick actions (Settings → Keyboard and helpers): a button's name and what it asks. */
  textActions: z.array(z.object({ label: z.string(), prompt: z.string() })).default([]),
  /** Code environments by folder (setup command, actions, variables), set on the Code page. */
  codeEnvironments: z.record(z.string(), z.any()).default({}),
  /** Named code environments (any folder), picked when a code session starts: { id, name, setup, actions, env }. */
  namedEnvironments: z.array(z.any()).default([]),
  /** Controlling this computer from the phone: off by default; the PIN is kept only as a salted hash. */
  remoteDesktop: z.object({ enabled: z.boolean().default(false), pinHash: z.string().max(200).optional(), trusted: z.array(z.object({ id: z.string().max(64), name: z.string().max(60), at: z.string().max(40) })).max(20).optional() }).default({ enabled: false }),
  /** Settings → Chats: which buttons every chat's bar shows (a chat can change its own). */
  chatBar: z.record(z.string(), z.boolean()).default({}),
  /** Settings → Web: safe search, dark web sites through Tor (off by default), sites never used in any chat. */
  webFilter: z.object({ safeSearch: z.enum(["strict", "moderate", "off"]).default("moderate"), onion: z.boolean().default(false), blocked: z.array(z.string().max(200)).max(200).default([]) }).default({ safeSearch: "moderate", onion: false, blocked: [] }),
  /** KesherAI as an MCP server at /mcp, for other AI apps on this computer. */
  mcpServer: z
    .object({
      enabled: z.boolean().default(true),
      /** Whether another app (Claude, through KesherAI's MCP server) may approve KesherAI's own approval cards. Off: only the user does. */
      allowApprovals: z.boolean().default(false),
    })
    .prefault({}),
  /** Notifications when long work ends or KesherAI waits for an answer. */
  notifications: z
    .object({
      /** On the phone through ntfy (https://ntfy.sh or a server of your own). */
      ntfy: z.object({ enabled: z.boolean().default(false), server: z.string().default("https://ntfy.sh"), topic: z.string().optional() }).prefault({}),
      /** A notification on this computer when the window is not in front. */
      desktop: z.boolean().default(true),
      /** Only work that took at least this long. */
      minSeconds: z.number().int().min(0).default(60),
      /** Put the start of the answer in the notification (it then passes through the ntfy server). */
      includeText: z.boolean().default(false),
      /** Tell when an agent waits for an approval or an answer for a minute. */
      waiting: z.boolean().default(true),
      /** Tell when a chat's helper (sub-agent) ends or fails in the background, or waits for an answer. */
      agents: z.boolean().default(true),
      /** Approve and Deny buttons on that notification (on the phone and a watch), with "Access from anywhere" on. */
      approveButtons: z.boolean().default(true),
      /** Seconds an agent waits for an approval before the phone is told. */
      waitingSeconds: z.number().int().min(0).max(3600).default(60),
    })
    .prefault({}),
  /** Parts of KesherAI turned off (Settings → Parts); see PARTS in @kesher/shared. Missing = on. */
  parts: z.record(z.string(), z.boolean()).prefault({}),
  /** Target phones for builds (Settings → For developers → Target phones). */
  phones: z
    .object({
      /** Ids from the catalog (phones.ts) or of phones read over USB. */
      targets: z.array(z.string().max(80)).max(40).default([]),
      /** Phones read from a phone plugged in by USB (exact values). */
      custom: z
        .array(
          z.object({
            id: z.string().max(80),
            brand: z.string().max(60),
            name: z.string().max(120),
            soc: z.string().max(120),
            gpu: z.string().max(120),
            gpuFamily: z.enum(["adreno", "mali", "immortalis", "xclipse", "powervr", "other"]),
            android: z.number().int().min(0).max(99),
            screen: z.object({ w: z.number().int().min(0).max(20000), h: z.number().int().min(0).max(20000), hz: z.number().int().min(0).max(1000) }),
            ramGb: z.number().int().min(0).max(1024).optional(),
            tier: z.enum(["high", "mid", "low"]),
            detected: z.boolean().optional(),
          }),
        )
        .max(20)
        .default([]),
    })
    .prefault({}),
  /** Per-plugin settings, keyed by plugin id. */
  plugins: z.record(z.string(), z.object({ enabled: z.boolean().default(true), settings: z.record(z.string(), z.unknown()).prefault({}) })).prefault({}),
  /** Plugin folders she is developing, loaded from where they are and reloaded when their files change. */
  pluginDevFolders: z.array(z.string().max(500)).max(10).default([]),
});

/** Parsed config; see {@link KesherConfigSchema}. */
export type KesherConfig = z.infer<typeof KesherConfigSchema>;

/** Folders inside the data directory. */
export interface DataPaths {
  /** Root, `~/.kesher` by default (overridable with `KESHER_DATA_DIR`). */
  root: string;
  config: string;
  models: string;
  assets: string;
  plugins: string;
  skills: string;
  /** Saved projects and conversations. */
  library: string;
  /** Engines KesherAI installs itself, e.g. llama.cpp. */
  engines: string;
}

/**
 * Resolves the data folder layout. The root comes from `KESHER_DATA_DIR`
 * when set, else `~/.<appId>` (so forks get their own folder automatically).
 *
 * @param root - Override for tests.
 * @returns Absolute paths.
 */
export function dataPaths(root = process.env.KESHER_DATA_DIR ?? join(homedir(), `.${branding.appId}`)): DataPaths {
  return {
    root,
    config: join(root, "config.json"),
    models: join(root, "models"),
    assets: join(root, "assets"),
    plugins: join(root, "plugins"),
    skills: join(root, "skills"),
    library: join(root, "library"),
    engines: join(root, "engines"),
  };
}

/** Encrypts and decrypts short secrets with the system's own protection (Electron's safeStorage: DPAPI, Keychain). */
export interface SecretBox {
  seal(text: string): string;
  unseal(text: string): string;
}

const SEALED = "enc:v1:";
let secretBox: SecretBox | undefined;

/**
 * Keys at rest (audit S2): from now on, connection keys and tokens are written encrypted with this box, and read back
 * through it. Without a box (a run without the desktop app) they stay as they are.
 *
 * @param box - The system's protection, or undefined to stop using one.
 */
export function useSecretBox(box: SecretBox | undefined): void {
  secretBox = box;
}

/** Encrypted secrets this run could not read, kept as they were so a save does not lose them (by slot). */
const unreadable = new Map<string, string>();

/** The secrets in a config: provider keys, the Telegram, Figma, GitHub, CivitAI and cloud hub tokens, and the hub key. */
function secretSlots(c: Record<string, unknown>): Array<{ obj: Record<string, unknown>; key: string; slot: string }> {
  const slots: Array<{ obj: Record<string, unknown>; key: string; slot: string }> = [];
  for (const p of Array.isArray(c.providers) ? (c.providers as Array<Record<string, unknown>>) : []) if (p && typeof p === "object") slots.push({ obj: p, key: "apiKey", slot: `provider:${String(p.id)}` });
  for (const k of ["telegram", "figma", "github", "civitai", "hub"]) {
    const o = c[k];
    if (o && typeof o === "object") slots.push({ obj: o as Record<string, unknown>, key: "token", slot: k });
  }
  // The cloud hub's device private key.
  if (c.hub && typeof c.hub === "object") slots.push({ obj: c.hub as Record<string, unknown>, key: "key", slot: "hub:key" });
  return slots;
}

/**
 * A copy of the config with its secrets encrypted (for writing), or the read config with them decrypted.
 *
 * @param c - The config as plain JSON.
 * @param way - "seal" to encrypt, "unseal" to decrypt.
 * @param box - The box to use (by default the one set with {@link useSecretBox}).
 * @returns The changed copy; a secret that cannot be decrypted is left out (the user enters it again).
 */
export function withSecrets(c: Record<string, unknown>, way: "seal" | "unseal", box: SecretBox | undefined = secretBox): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(c)) as Record<string, unknown>;
  for (const { obj, key, slot } of secretSlots(copy)) {
    const v = obj[key];
    // A secret this run could not read: written back unchanged, unless the user entered a new one.
    if (way === "seal" && (typeof v !== "string" || !v) && unreadable.has(slot)) {
      obj[key] = unreadable.get(slot);
      continue;
    }
    if (typeof v !== "string" || !v) continue;
    if (way === "seal") {
      unreadable.delete(slot);
      if (box && !v.startsWith(SEALED)) {
        try {
          obj[key] = SEALED + box.seal(v);
        } catch {
          // The system cannot encrypt right now: keep it as it was rather than lose it.
        }
      }
    } else if (v.startsWith(SEALED)) {
      try {
        if (!box) throw new Error("no box");
        obj[key] = box.unseal(v.slice(SEALED.length));
      } catch {
        // Encrypted on another computer or user account, or no desktop app: it cannot be read here. Kept aside, so
        // a save writes it back as it was (the desktop app reads it again next time).
        unreadable.set(slot, v);
        delete obj[key];
      }
    }
  }
  return copy;
}

/**
 * Loads the config, creating folders, the file and the remote token on
 * first run.
 *
 * @param paths - Data paths.
 * @returns The parsed config.
 */
export async function loadConfig(paths: DataPaths): Promise<KesherConfig> {
  for (const dir of [paths.root, paths.models, paths.assets, paths.plugins, paths.skills, paths.library, paths.engines]) {
    await mkdir(dir, { recursive: true });
  }
  const raw = await readFile(paths.config, "utf8").catch(() => "{}");
  const config = KesherConfigSchema.parse(withSecrets(JSON.parse(raw) as Record<string, unknown>, "unseal"));
  if (!config.remote.token || !config.browserKey) {
    config.remote.token ||= randomBytes(24).toString("base64url");
    config.browserKey ||= randomBytes(12).toString("base64url");
    await saveConfig(paths, config);
  }
  return config;
}

/**
 * Writes the config with owner-only permissions, since it holds API keys.
 *
 * @param paths - Data paths.
 * @param config - Config to write.
 */
export function saveConfig(paths: DataPaths, config: KesherConfig): Promise<void> {
  // One write at a time, each to a new file then renamed over the old: two saves at once (on closing) wrote over
  // each other and left text after the JSON, so the next start could not read the settings (found in CI).
  const run = configWrites.then(async () => {
    const tmp = `${paths.config}.${process.pid}.${Date.now()}.tmp`;
    // Keys at rest (S2): written encrypted when the desktop app gave a box; the config in memory stays readable.
    await writeFile(tmp, `${JSON.stringify(withSecrets(config as unknown as Record<string, unknown>, "seal"), null, 2)}\n`, { mode: 0o600 });
    for (let i = 0; ; i++) {
      try {
        await rename(tmp, paths.config);
        break;
      } catch (e) {
        // Windows: a reader or a virus scanner holding the file makes the rename fail for a moment.
        if (i >= 8 || !["EPERM", "EACCES", "EBUSY"].includes((e as NodeJS.ErrnoException).code ?? "")) {
          await rm(tmp, { force: true }).catch(() => undefined);
          throw e;
        }
        await new Promise((r) => setTimeout(r, 50 * (i + 1)));
      }
    }
    await chmod(paths.config, 0o600).catch(() => undefined);
  });
  configWrites = run.catch(() => undefined);
  return run;
}
let configWrites: Promise<unknown> = Promise.resolve();
