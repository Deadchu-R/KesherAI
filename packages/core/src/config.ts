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
      /** The GGUF file loaded last, loaded again on start-up when `autoLoadLast` is on. */
      lastModel: z.string().optional(),
      autoLoadLast: z.boolean().default(true),
      /** The embedding model file the built-in engine runs for search by meaning. */
      embedModel: z.string().optional(),
      /** How many chats the built-in engine answers at the same time (llama-server slots). */
      // One chat at a time by default: the whole context for it (Roee, Nov 11). Settings → Computer offers up to 8.
      parallel: z.number().int().min(1).max(8).default(1),
      /** Multi-token prediction: tokens guessed ahead (unset: 2; 0: off). */
      mtpDraft: z.number().int().min(0).max(16).optional(),
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
      services: z.array(z.enum(["gmail", "calendar", "drive"])).optional(),
    })
    .prefault({}),
  /** Unity projects the user added (worked on through Unity's CLI). */
  unity: z
    .object({
      projects: z.array(z.string()).default([]),
      active: z.string().optional(),
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
  /** Figma: the user's personal access token (Settings → Appearance → Figma); never sent to a page. */
  figma: z.object({ token: z.string().max(200).optional() }).prefault({}),
  /** Tool search for local models (only everyday tools in full; the rest loaded on demand). On unless false. */
  toolSearch: z.boolean().optional(),
  /** Looks the user saved by name (Settings → Appearance → My looks). */
  savedLooks: z.array(z.object({ name: z.string().max(60), appearance: z.record(z.string(), z.unknown()) })).max(40).default([]),
  /** The first-run welcome: whether it was finished, and the role the user picked (shapes suggestions). */
  onboarding: z
    .object({
      done: z.boolean().default(false),
      role: z.string().max(200).optional(),
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
      devices: z.array(z.object({ id: z.string(), name: z.string(), hash: z.string(), createdAt: z.string(), lastSeen: z.string().optional(), lastAddress: z.string().optional(), scope: z.literal("mcp").optional() })).default([]),
      /** Through the internet link, only devices with their own key (not the shared token, which the QR code and other computers use). */
      anywhereDevicesOnly: z.boolean().default(false),
      /** Through the internet link, a device key not used for this many days stops working (0 = never). */
      anywhereIdleDays: z.number().int().min(0).max(365).default(30),
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
  const config = KesherConfigSchema.parse(JSON.parse(raw));
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
    await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
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
