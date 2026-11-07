import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { BUILT_IN_FACTORIES, PROVIDER_PRESETS, ProviderRegistry } from "@kesher/providers";
import { DownloadManager } from "@kesher/downloads";
import { branding, features } from "@kesher/shared";
import { dataPaths, loadConfig, saveConfig } from "./config.js";
import { AssetStore } from "./assets.js";
import { PluginHost } from "./plugins.js";
import { LlamaEngine } from "./llamacpp.js";
import { Library } from "./library.js";
import { ConversationManager } from "./conversations.js";
import { Updater } from "./updates.js";
import { GoogleDrive, GOOGLE_ENDPOINTS, type GoogleEndpoints } from "./google.js";
import { DriveSync } from "./drive-sync.js";
import { registerRemoteAuth } from "./auth.js";
import type { KesherServices } from "./services.js";
import { systemRoutes } from "./routes/system.js";
import { modelRoutes } from "./routes/models.js";
import { generateRoutes } from "./routes/generate.js";
import { downloadRoutes } from "./routes/downloads.js";
import { openAIRoutes } from "./routes/openai.js";
import { libraryRoutes } from "./routes/library.js";
import { googleRoutes } from "./routes/google.js";
import { loadModel } from "./routes/engine.js";

/** Options for {@link createKesherServer}. All optional. */
export interface KesherServerOptions {
  /** Data folder. Defaults to `KESHER_DATA_DIR` or `~/.kesher`. */
  dataDir?: string;
  /** Port; defaults to the config file's `port`. */
  port?: number;
  /** Built web UI to serve at `/` (the phone uses this). */
  webDir?: string;
  /** Extra plugin folders on top of `<dataDir>/plugins`. */
  pluginRoots?: string[];
  /** Probe LM Studio, Ollama and ComfyUI on start-up (default: the feature flag). */
  autodetect?: boolean;
  /** Fastify request logging. */
  logger?: boolean;
  /** Google endpoints (tests point these at a fake server). */
  googleEndpoints?: GoogleEndpoints;
}

/** What {@link createKesherServer} returns. */
export interface KesherServer {
  app: FastifyInstance;
  services: KesherServices;
  /** Starts listening. Returns the URL. */
  listen(): Promise<string>;
  /** Stops the server, llama-server and plugins. */
  close(): Promise<void>;
}

/**
 * Builds the core server. This is the one place where services are created
 * and wired together; read it top to bottom to understand start-up order:
 *
 * 1. Load config and data folders.
 * 2. Register built-in provider types.
 * 3. Load plugins (they may add provider types, categories and tools).
 * 4. Create the providers from the config file (now every type exists).
 * 5. Auto-detect local servers that are not configured yet.
 * 6. Load the library (pulling newer files from the sync folder first).
 * 7. Register routes, remote auth and the static web UI.
 * 8. In the background: load the last model in the built-in engine.
 *
 * @param options - See {@link KesherServerOptions}.
 * @returns The server, not yet listening.
 */
export async function createKesherServer(options: KesherServerOptions = {}): Promise<KesherServer> {
  const paths = dataPaths(options.dataDir);
  const config = await loadConfig(paths);
  if (options.port !== undefined) config.port = options.port;

  const registry = new ProviderRegistry();
  for (const factory of BUILT_IN_FACTORIES) registry.registerFactory(factory);

  const plugins = new PluginHost(registry, config, paths.root);
  if (features.plugins) await plugins.loadAll([paths.plugins, ...(options.pluginRoots ?? [])]);

  for (const p of config.providers) {
    try {
      registry.add(p);
    } catch (err) {
      console.warn(`[providers] skipping "${p.id}": ${(err as Error).message}`);
    }
  }

  const autodetected = new Set<string>();
  if (options.autodetect ?? features.autodetectLocalServers) {
    await Promise.all(
      PROVIDER_PRESETS.filter((preset) => preset.autodetect && !registry.get(preset.config.id)).map(async (preset) => {
        const provider = registry.add(preset.config);
        if (await provider.checkHealth(AbortSignal.timeout(1500))) autodetected.add(preset.config.id);
        else registry.remove(preset.config.id);
      }),
    );
  }

  const library = new Library(paths.library, () => config.syncFolder);
  try {
    const pulled = await library.importFromSync();
    if (pulled) console.log(`[library] imported ${pulled} file(s) from the sync folder`);
  } catch (err) {
    console.warn(`[library] sync folder unavailable: ${(err as Error).message}`);
  }
  await library.load();

  const engine = new LlamaEngine({
    dir: paths.engines,
    ...(config.engines.llamaServerPath ? { binaryPath: config.engines.llamaServerPath } : {}),
    ...(config.engines.llamaVersion ? { version: config.engines.llamaVersion } : {}),
    port: config.engines.llamaServerPort,
    args: config.engines.llamaServerArgs,
  });
  const assets = new AssetStore(paths.assets);
  const persist = () => saveConfig(paths, config);
  // The project's own OAuth client (branding.config.ts) is used unless the user set another.
  const google = new GoogleDrive(config.google, persist, options.googleEndpoints ?? GOOGLE_ENDPOINTS, branding.google);
  const driveSync = new DriveSync(google, library, config.google, persist);

  const services: KesherServices = {
    config,
    paths,
    registry,
    assets,
    downloads: new DownloadManager(),
    plugins,
    engine,
    library,
    conversations: new ConversationManager({ registry, library, assets, plugins, config }),
    updater: new Updater(),
    google,
    driveSync,
    autodetected,
    saveConfig: persist,
    registerEngineProvider: () => {
      if (!registry.get("llamacpp")) {
        registry.add({ id: "llamacpp", type: "openai-compatible", name: "KesherAI engine (llama.cpp)", location: "local", baseUrl: engine.baseUrl });
      }
    },
  };

  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 50 * 1024 * 1024 });
  // The desktop window and the Vite dev server are separate origins.
  await app.register(cors, { origin: true });
  if (features.remote) registerRemoteAuth(app, () => config.remote.token);

  await systemRoutes(app, services);
  await modelRoutes(app, services);
  await generateRoutes(app, services);
  if (features.downloads) await downloadRoutes(app, services);
  if (features.openaiCompatibleApi) await openAIRoutes(app, services);
  await libraryRoutes(app, services);
  await googleRoutes(app, services);

  if (options.webDir && existsSync(options.webDir)) {
    await app.register(fastifyStatic, { root: options.webDir });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/") || req.url.startsWith("/v1/")
        ? reply.code(404).send({ error: "Not found" })
        : reply.sendFile("index.html"),
    );
  }

  // Bring this computer's library up to date with Google Drive, in the background.
  if (google.connected) void driveSync.syncNow().catch(() => undefined);

  // Bring back the model that was loaded last time, without delaying start-up.
  const last = config.engines.lastModel;
  if (config.engines.autoLoadLast && last && existsSync(last) && engine.status().installed) {
    void loadModel(services, last).catch((err) => engine.fail(err));
  }

  return {
    app,
    services,
    async listen() {
      const host = features.remote && config.remote.enabled ? "0.0.0.0" : "127.0.0.1";
      await app.listen({ port: config.port, host });
      return `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${config.port}`;
    },
    async close() {
      await services.conversations.closeAll();
      await app.close();
      await engine.stop();
      await plugins.deactivateAll();
    },
  };
}
