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
      /** Port Kesher starts llama-server on. */
      llamaServerPort: z.number().int().default(8081),
      /** Extra arguments, e.g. `["-ngl", "99", "-c", "8192"]`. */
      llamaServerArgs: z.array(z.string()).default(["-ngl", "99"]),
    })
    .default({}),
  remote: z
    .object({
      /** Listen on all interfaces and accept other devices that present the token. */
      enabled: z.boolean().default(false),
      /** Shared secret for remote devices. Generated on first start. */
      token: z.string().optional(),
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
  for (const dir of [paths.root, paths.models, paths.assets, paths.plugins, paths.skills]) {
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
