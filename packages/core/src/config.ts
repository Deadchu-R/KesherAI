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
      folderId: z.string().optional(),
      lastSync: z.string().optional(),
      lastError: z.string().optional(),
      services: z.array(z.enum(["gmail", "calendar", "drive"])).optional(),
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
    })
    .default({}),
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
  if (!config.remote.token) {
    config.remote.token = randomBytes(24).toString("base64url");
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
