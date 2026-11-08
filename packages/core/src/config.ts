import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
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
    .default({}),
  engines: z
    .object({
      /** Path of the `llama-server` binary from llama.cpp. */
      llamaServerPath: z.string().optional(),
      /** Port KesherAI starts llama-server on. */
      llamaServerPort: z.number().int().default(8081),
      /** Extra arguments, e.g. `["-ngl", "99", "-c", "8192"]`. `--jinja` (tool calling) is always added. */
      llamaServerArgs: z.array(z.string()).default(["-ngl", "99"]),
      /** llama.cpp release tag KesherAI installed, e.g. `b6500`. */
      llamaVersion: z.string().optional(),
      /** The GGUF file loaded last, loaded again on start-up when `autoLoadLast` is on. */
      lastModel: z.string().optional(),
      autoLoadLast: z.boolean().default(true),
      /** The embedding model file the built-in engine runs for search by meaning. */
      embedModel: z.string().optional(),
      /** How many chats the built-in engine answers at the same time (llama-server slots). */
      parallel: z.number().int().min(1).max(8).default(2),
      /** How models use the graphics cards (see gpus.ts). */
      gpus: z
        .object({
          mode: z.enum(["auto", "fastest", "all"]).default("auto"),
          use: z.array(z.number().int().min(0)).optional(),
          split: z.array(z.number().positive()).optional(),
          main: z.number().int().min(0).optional(),
        })
        .default({}),
    })
    .default({}),
  /** Where KesherAI downloads models. Defaults to `models` in the data folder. */
  modelsDir: z.string().optional(),
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
      }),
    )
    .default([]),
  /** Active model per category id, e.g. `{ "chat": "llamacpp/Qwen3-8B-Q4_K_M", "image": "comfyui/flux1-dev.safetensors" }`. */
  activeModels: z.record(z.string(), z.string()).default({}),
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
    .default({}),
  /** Unity projects the user added (worked on through Unity's CLI). */
  unity: z
    .object({
      projects: z.array(z.string()).default([]),
      active: z.string().optional(),
    })
    .default({}),
  /** Talking to KesherAI from Telegram through the user's own bot (telegram.ts). */
  telegram: z
    .object({
      enabled: z.boolean().default(false),
      token: z.string().optional(),
      chats: z.array(z.number()).default([]),
      conversations: z.record(z.string(), z.string()).default({}),
    })
    .default({}),
  /** How the app looks (checked by cleanAppearance in @kesher/shared), and the last looks for Undo. */
  appearance: z.record(z.string(), z.unknown()).default({}),
  appearanceHistory: z.array(z.record(z.string(), z.unknown())).default([]),
  /** The first-run welcome: whether it was finished, and the role the user picked (shapes suggestions). */
  onboarding: z
    .object({
      done: z.boolean().default(false),
      role: z.string().max(200).optional(),
    })
    .default({}),
  /** Protecting the graphics card: temperature limit, unloading idle models, low priority (see gpu-guard.ts). */
  guard: z
    .object({
      enabled: z.boolean().default(true),
      maxTemp: z.number().int().min(60).max(95).default(83),
      resumeTemp: z.number().int().min(50).max(90).default(75),
      unloadAfterMinutes: z.number().int().min(0).max(1440).default(20),
      gentle: z.boolean().default(false),
    })
    .default({}),
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
    .default({}),
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
    .default({}),
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
    .default({}),
  /** "My devices": the user's computers find each other through their Google account. */
  devices: z
    .object({
      id: z.string().optional(),
      share: z.boolean().default(false),
      syncSettings: z.boolean().default(true),
      stamps: z.record(z.string(), z.object({ hash: z.string(), at: z.number() })).default({}),
    })
    .default({}),
  /** "Connect with GitHub" (device sign-in). */
  github: z
    .object({
      token: z.string().optional(),
      login: z.string().optional(),
      scopes: z.string().optional(),
      clientId: z.string().optional(),
    })
    .default({}),
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
    })
    .default({}),
  /** Speech: how the microphone button turns speech into text. */
  /** Meetings in My day. */
  meetings: z
    .object({
      /** Tell the people on the call apart (keeps the call's audio until the write-up, then deletes it). */
      speakers: z.boolean().default(true),
      /** Keep the meeting's recording, so its transcript follows playback (off: deleted after the write-up). */
      keepRecording: z.boolean().default(false),
    })
    .default({}),
  speech: z
    .object({
      /** `auto`: this computer when it can, else a connected cloud service; `local`; or `cloud:<connection id>` (Groq, OpenAI). */
      stt: z.string().default("auto"),
      /** Spoken language, or `auto`. */
      language: z.string().default("auto"),
    })
    .default({}),
  /** Computer control: models with vision see the screen and click and type (off until the user turns it on). */
  computer: z.object({ enabled: z.boolean().default(false) }).default({}),
  /** The coach (prompt and usage advice). */
  coach: z
    .object({
      /** Model that writes the advice; defaults to the conversation's own model. */
      modelId: z.string().optional(),
      /** Keep notes about how the user works and tell the models (local file `coach.json`). */
      learn: z.boolean().default(true),
    })
    .default({}),
  /** Keys for apps that use the APIs (/v1 and /mcp), one per app; only hashes are kept. */
  apiKeys: z.array(z.object({ id: z.string(), name: z.string(), hash: z.string(), prefix: z.string(), createdAt: z.string(), lastUsedAt: z.string().optional(), uses: z.number().optional() })).default([]),
  /** Ask apps on this computer for a key too (by default only other devices need one). */
  apiAuth: z.object({ requireKeyLocally: z.boolean().default(false) }).default({}),
  /** Download speed limit in megabytes per second (0: none). */
  downloadLimitMBps: z.number().min(0).default(0),
  /** The key the KesherAI browser extension connects with (shown in Settings → Browser). */
  browserKey: z.string().optional(),
  /** KesherAI as an MCP server at /mcp, for other AI apps on this computer. */
  mcpServer: z.object({ enabled: z.boolean().default(true) }).default({}),
  /** Notifications when long work ends or KesherAI waits for an answer. */
  notifications: z
    .object({
      /** On the phone through ntfy (https://ntfy.sh or a server of your own). */
      ntfy: z.object({ enabled: z.boolean().default(false), server: z.string().default("https://ntfy.sh"), topic: z.string().optional() }).default({}),
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
    .default({}),
  /** Parts of KesherAI turned off (Settings → Parts); see PARTS in @kesher/shared. Missing = on. */
  parts: z.record(z.string(), z.boolean()).default({}),
  /** Per-plugin settings, keyed by plugin id. */
  plugins: z.record(z.string(), z.object({ enabled: z.boolean().default(true), settings: z.record(z.string(), z.unknown()).default({}) })).default({}),
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
export async function saveConfig(paths: DataPaths, config: KesherConfig): Promise<void> {
  await writeFile(paths.config, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(paths.config, 0o600).catch(() => undefined);
}
