import type { AgentTool } from "@kesher/agent";
import { mkdir, readFile as readFileFs } from "node:fs/promises";
import { extname, join } from "node:path";
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
import { ConversationManager, modelTurnFor, onModelSpeed } from "./conversations.js";
import { Speeds } from "./speeds.js";
import { Updater } from "./updates.js";
import type { PackagedUpdates } from "./updates.js";
import { GoogleDrive, GOOGLE_ENDPOINTS, type GoogleEndpoints } from "./google.js";
import { googleTools } from "./google-tools.js";
import { Knowledge, knowledgeTools } from "./knowledge.js";
import { Personas } from "./personas.js";
import { Prompts } from "./prompts.js";
import { Notifier, type Note } from "./notify.js";
import { speechTools } from "./speech-tools.js";
import { mcpServerRoutes } from "./routes/mcp-server.js";
import { anthropicRoutes } from "./routes/anthropic.js";
import { apiKeyRoutes } from "./routes/api-keys.js";
import { ApiKeys } from "./api-keys.js";
import { SkillStore } from "./skill-store.js";
import { skillRoutes } from "./routes/skills.js";
import { libraryStoreRoutes } from "./routes/library-store.js";
import { Pipelines } from "./pipelines.js";
import { ComfyManager } from "./comfy-manager.js";
import { ConversationSearch } from "./conversation-search.js";
import { comfyRoutes } from "./routes/comfy.js";
import { pipelineRoutes } from "./routes/pipelines.js";
import { transcribeWith } from "./speech-tools.js";
import { notificationRoutes } from "./routes/notifications.js";
import { promptRoutes } from "./routes/prompts.js";
import { personaRoutes } from "./routes/personas.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { DriveSync } from "./drive-sync.js";
import { Tunnel } from "./tunnel.js";
import { SdEngine, ensureImageModel, ensureVideoModel, sdProvider } from "./sdcpp.js";
import { Coach } from "./coach.js";
import { ComputerControl } from "./computer.js";
import { WhisperEngine } from "./whisper.js";
import { speechRoutes } from "./routes/speech.js";
import { computerRoutes } from "./routes/computer.js";
import { mcpRoutes } from "./routes/mcp.js";
import { journalRoutes } from "./routes/journal.js";
import { githubRoutes } from "./routes/github.js";
import { GitHubAuth } from "./github.js";
import { Runtimes } from "./runtimes.js";
import { Checkpoints } from "./checkpoints.js";
import { Devices } from "./devices.js";
import { deviceRoutes } from "./routes/devices.js";
import { Journal, type ScreenSource } from "./journal.js";
import { McpManager, mcpResultText } from "./mcp.js";
import { bySpeed, planGpus, type Gpu } from "./gpus.js";
import { coachRoutes } from "./routes/coach.js";
import { pluginRoutes } from "./routes/plugins.js";
import { detectHardwareCached } from "@kesher/downloads";
import { registerRemoteAuth } from "./auth.js";
import type { KesherServices } from "./services.js";
import { systemRoutes } from "./routes/system.js";
import { modelRoutes } from "./routes/models.js";
import { generateRoutes } from "./routes/generate.js";
import { downloadRoutes } from "./routes/downloads.js";
import { openAIRoutes } from "./routes/openai.js";
import { libraryRoutes } from "./routes/library.js";
import { fileRoutes } from "./routes/files.js";
import { terminalRoutes } from "./routes/terminal.js";
import websocket from "@fastify/websocket";
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
  /** The project's Google OAuth client (defaults to branding.config.ts; builds pass the one from repository secrets). */
  googleClient?: { clientId: string; clientSecret: string };
  /** Installed copies: update from GitHub releases (the desktop app passes its version and how to run an installer). */
  updates?: PackagedUpdates;
  /** The desktop app's screen capture for "My day" (no PowerShell, which antivirus programs block). */
  screen?: ScreenSource;
  /** Shows a notification on this computer (desktop app); returns false when the window is in front. */
  notify?: (n: Note) => boolean | Promise<boolean>;
  /** The project's GitHub OAuth App client id, for "Connect with GitHub" (builds pass it from repository secrets). */
  githubClientId?: string;
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
  if (config.modelsDir) {
    paths.models = config.modelsDir;
    await mkdir(paths.models, { recursive: true }).catch(() => undefined);
  }
  if (options.port !== undefined) config.port = options.port;

  const registry = new ProviderRegistry();
  const downloads = new DownloadManager();
  for (const factory of BUILT_IN_FACTORIES) registry.registerFactory(factory);
  // The built-in image engine (stable-diffusion.cpp), shown as the "sdcpp" connection.
  const coach = new Coach(paths.root);
  // Stops conversations through a late-bound reference: the manager is created below.
  let stopConversation: (id: string) => void = () => undefined;
  const computer = new ComputerControl(() => config.computer.enabled, (ids) => ids.forEach((id) => stopConversation(id)));
  /** NVIDIA cards with their PCI-order index. */
  const nvidiaGpus = async (): Promise<Gpu[]> =>
    (await detectHardwareCached()).gpus
      .filter((g) => /nvidia|geforce|rtx|gtx|quadro|tesla/i.test(g.name))
      .map((g, i) => ({ index: g.index ?? i, name: g.name, vramTotal: g.vramTotal, vramFree: g.vramFree, ...(g.computeCap ? { computeCap: g.computeCap } : {}) }));
  const sd = new SdEngine(join(paths.engines, "sdcpp"), () => paths.models, downloads, async () => {
    const nv = await nvidiaGpus();
    // The image engine uses one card: the fastest allowed one (or the chosen leader).
    const pool = nv.filter((g) => !config.engines.gpus.use || config.engines.gpus.use.includes(g.index));
    const card = pool.find((g) => g.index === config.engines.gpus.main) ?? bySpeed(pool)[0];
    return { nvidia: nv.length > 0, ...(card ? { vramGb: card.vramFree / 1024 ** 3, cudaIndex: card.index } : {}) };
  });
  registry.registerFactory({ type: "sdcpp", displayName: "KesherAI image engine (stable-diffusion.cpp)", categories: ["image"], create: () => sdProvider(sd) });
  registry.add({ id: "sdcpp", type: "sdcpp", name: "KesherAI image engine", location: "local" });

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
    parallel: config.engines.parallel,
    gpuPlan: async (modelPath) => planGpus(await nvidiaGpus(), config.engines.gpus, await modelSize(modelPath)),
  });
  const assets = new AssetStore(paths.assets);
  // MCP servers (Notion, GitHub, Linear, Unity, …): their tools join every chat and agent.
  const persistEarly = () => saveConfig(paths, config);
  const github = new GitHubAuth(config.github, persistEarly, options.githubClientId ?? process.env.KESHER_GITHUB_CLIENT_ID ?? (branding.github.clientId || undefined));
  const runtimes = new Runtimes(join(paths.engines, "runtimes"), downloads);
  const mcp = new McpManager(join(paths.root, "mcp.json"), join(paths.root, "mcp-auth.json"), (cfg) => (cfg.preset === "github" || /api\.githubcopilot\.com/.test(cfg.url ?? "") ? github.token() : undefined), (env) => runtimes.env(env));
  void mcp.load();
  // "My day": off until the user turns it on; never leaves this computer.
  const journal = new Journal(join(paths.root, "journal"), (modelId) => {
    const id = modelId ?? config.activeModels.chat;
    if (!id) return undefined;
    try {
      const { provider } = registry.resolve(id);
      return { id, local: (provider as { location?: string }).location !== "cloud", turn: modelTurnFor(registry, id) };
    } catch {
      return undefined;
    }
  }, undefined, options.screen);
  void journal.load();
  // Knowledge bases: the user's folders and web pages, searchable by the models, with sources.
  const knowledge = new Knowledge(join(paths.root, "knowledge"));
  void knowledge.load();
  const personas = new Personas(join(paths.root, "personas.json"));
  const skills = new SkillStore(paths.skills);
  void skills.list().catch(() => undefined);
  void personas.load();
  const persist = () => saveConfig(paths, config);
  // The project's own OAuth client (branding.config.ts) is used unless the user set another.
  const google = new GoogleDrive(config.google, persist, options.googleEndpoints ?? GOOGLE_ENDPOINTS, options.googleClient ?? branding.google);
  const driveSync = new DriveSync(google, library, config.google, persist);

  const speeds = new Speeds(join(paths.root, "speeds.json"));
  onModelSpeed((id, tokens, ms) => void speeds.record(id, tokens, ms));
  const tunnel = new Tunnel(join(paths.engines, "cloudflared"), downloads);
  const whisper = new WhisperEngine(join(paths.engines, "whisper"), () => paths.models, downloads, async () => {
    const nv = await nvidiaGpus();
    return { nvidia: nv.length > 0, ...(nv[0] ? { vramGb: nv[0].vramTotal / 1024 ** 3 } : {}) };
  });
  const updater = new Updater(undefined, options.updates);
  if (!config.notifications.ntfy.topic) {
    config.notifications.ntfy.topic = Notifier.newTopic();
    void persist().catch(() => undefined);
  }
  const notifier = new Notifier(() => config.notifications, {
    ...(options.notify ? { desktop: options.notify } : {}),
    publicUrl: () => tunnel.status().url,
  });
  downloads.on("update", (job: { id: string; label: string; status: string; error?: string }) => notifier.onDownload(job));
  const devices = new Devices({
    config: config.devices,
    remote: config.remote,
    port: () => config.port,
    providers: () => config.providers,
    addProvider: async (p, persist) => {
      registry.add(p);
      if (persist) {
        autodetected.delete(p.id);
        config.providers = [...config.providers.filter((x) => x.id !== p.id), p];
      }
    },
    registry,
    google,
    mcp,
    tunnelUrl: () => tunnel.status().url,
    startTunnel: () => tunnel.start(config.port),
    gpu: async () => {
      const nv = await nvidiaGpus();
      return nv.length ? nv.map((g) => g.name).join(" + ") : undefined;
    },
    version: async () => (await updater.version()).version,
    save: persist,
  });
  // Pipelines: chains of model calls and tools, with conditions and loops.
  const pipelines = new Pipelines(join(paths.root, "pipelines"), join(paths.root, "outputs", "pipelines"), {
    ask: async ({ prompt, system, model, persona }, signal) => {
      await personas.load();
      const p = persona ? (await personas.list()).find((x) => x.id === persona || x.name.toLowerCase() === persona.toLowerCase()) : undefined;
      const id = model || p?.modelId || config.activeModels.chat;
      if (!id) throw new Error("No chat model is active. Pick one on the Models page.");
      const sys = [p?.instructions, system].filter(Boolean).join("\n\n");
      const r = await modelTurnFor(registry, id)({ messages: [...(sys ? [{ role: "system" as const, content: sys }] : []), { role: "user" as const, content: prompt }], tools: [] }, signal, () => undefined);
      return r.text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
    },
    knowledge: async (query, base) => {
      const hits = await knowledge.search(query, base);
      return hits.map((h) => `[${h.source}${/^https?:/.test(h.source) ? "" : `, p. ${h.page}`}] ${h.text}`).join("\n\n") || "(nothing found)";
    },
    image: async ({ prompt, width, height }, signal) => {
      const id = config.activeModels.image;
      if (!id) throw new Error("No image model is active. Pick one on the Models page.");
      const { provider, providerModelId } = registry.resolve(id);
      if (!provider.generateImage) throw new Error(`${id} does not make images.`);
      return provider.generateImage({ providerModelId, prompt, width: width ?? 1024, height: height ?? 1024, steps: 20, seed: Math.floor(Math.random() * 2 ** 31) }, signal);
    },
    transcribe: async (path) => {
      const ext = extname(path);
      const r = await transcribeWith({ whisper, speech: () => config.speech, providers: () => config.providers }, await readFileFs(path), /^\.(wav|mp3|flac|ogg)$/i.test(ext) ? ext : ".wav", config.speech.language);
      return r.text;
    },
    notify: async (title, body) => void (await notifier.send({ title, body, path: "#/pipelines", tags: ["gear"] })),
  });
  const comfy = new ComfyManager(join(paths.engines, "comfyui"), {
    downloads,
    runtimes,
    modelsDir: () => paths.models,
    port: () => config.comfyui.port,
    folder: () => config.comfyui.folder,
    nvidia: async () => (await nvidiaGpus()).length > 0,
    onReady: (url) => {
      // ComfyUI's checkpoints become image models.
      if (!registry.get("comfyui")) registry.add({ id: "comfyui", type: "comfyui", name: "ComfyUI (KesherAI)", location: "local", baseUrl: url });
    },
  });
  if (config.comfyui.autoStart) void comfy.start().catch(() => undefined);
  const services: KesherServices = {
    config,
    paths,
    registry,
    assets,
    downloads,
    plugins,
    engine,
    library,
    conversations: new ConversationManager({
      registry,
      library,
      assets,
      plugins,
      config,
      outputsDir: join(paths.root, "outputs"),
      checkpoints: new Checkpoints(join(paths.root, "checkpoints")),
      personas,
      skills,
      onEvent: (convId, e, title, lastAnswer) => notifier.onConversationEvent(convId, title, e, lastAnswer),
      ensureImageModel: () => ensureImageModel({ sd, downloads, config, modelsDir: () => paths.models, save: persist }),
      computerTools: (id) => computer.tools(id),
      mcpTools: () => [
        ...googleTools(google),
        ...knowledgeTools(knowledge),
        ...speechTools({ whisper, speech: () => config.speech, providers: () => config.providers }),
        ...mcp.tools().map(({ server, tool, spec }): AgentTool => ({
          spec,
          // Tools that only read run without asking; the rest ask, like any command.
          risk: tool.annotations?.readOnlyHint && !tool.annotations.destructiveHint ? ("read" as const) : ("exec" as const),
          preview: async (input) => `${server.name} → ${tool.annotations?.title ?? tool.name}\n${JSON.stringify(input, null, 2)}`,
          run: async (input, ctx) => {
            const r = await mcp.call(server.id, tool.name, input, ctx.signal);
            const { text, images } = mcpResultText(r);
            if (r.isError) throw new Error(text);
            return { output: text, ...(images.length ? { images } : {}) };
          },
        })),
      ],
      video: {
        ensure: () => ensureVideoModel({ sd, downloads, config, modelsDir: () => paths.models, save: persist }),
        generate: (path, req) => sd.generateVideo(path, req),
      },
      userNotes: async () => (config.coach?.learn === false ? [] : (await coach.profile()).notes),
    }),
    coach,
    computer,
    mcp,
    speeds,
    runtimes,
    github,
    journal,
    knowledge,
    personas,
    skills,
    pipelines,
    comfy,
    conversationSearch: new ConversationSearch(library),
    notifier,
    prompts: new Prompts(join(paths.root, "prompts.json")),
    whisper,
    updater,
    google,
    driveSync,
    sd,
    tunnel,
    devices,
    autodetected,
    saveConfig: persist,
    registerEngineProvider: () => {
      if (!registry.get("llamacpp")) {
        registry.add({ id: "llamacpp", type: "openai-compatible", name: "KesherAI engine (llama.cpp)", location: "local", baseUrl: engine.baseUrl });
      }
    },
  };
  stopConversation = (id) => services.conversations.stop(id);

  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 50 * 1024 * 1024 });
  // The desktop window and the Vite dev server are separate origins.
  await app.register(cors, { origin: true });
  const apiKeys = new ApiKeys(() => config.apiKeys, persist);
  if (features.remote) registerRemoteAuth(app, () => config.remote.token, { verify: (k) => apiKeys.verify(k), requireLocally: () => config.apiAuth.requireKeyLocally });

  await systemRoutes(app, services);
  await modelRoutes(app, services);
  await generateRoutes(app, services);
  if (features.downloads) await downloadRoutes(app, services);
  if (features.openaiCompatibleApi) {
    await openAIRoutes(app, services);
    await anthropicRoutes(app, services);
  }
  await apiKeyRoutes(app, services, apiKeys);
  await app.register(websocket);
  await terminalRoutes(app, services);
  await coachRoutes(app, services);
  await pluginRoutes(app, services);
  await computerRoutes(app, services);
  await speechRoutes(app, services);
  await mcpRoutes(app, services);
  await journalRoutes(app, services);
  await knowledgeRoutes(app, services);
  await personaRoutes(app, services);
  await promptRoutes(app, services);
  await skillRoutes(app, services);
  await libraryStoreRoutes(app, services);
  await pipelineRoutes(app, services);
  await comfyRoutes(app, services);
  await notificationRoutes(app, services);
  await mcpServerRoutes(app, services);
  await githubRoutes(app, services);
  await deviceRoutes(app, services);
  await libraryRoutes(app, services);
  await fileRoutes(app, services);
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
  // Find the user's other computers (same Google account) and keep their connections in step.
  devices.start();

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
      if (config.remote.anywhere) {
        services.tunnel.start(config.port).catch((err: Error) => console.warn(`[tunnel] ${err.message}`));
      }
      return `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${config.port}`;
    },
    async close() {
      services.tunnel.stop();
      mcp.close();
      devices.close();
      journal.close();
      knowledge.close();
      notifier.close();
      void comfy.stop();
      await services.conversations.closeAll();
      await app.close();
      await engine.stop();
      await plugins.deactivateAll();
    },
  };
}

/**
 * @param modelPath - A GGUF file (the first part of a split model).
 * @returns Its size in bytes, adding the other parts of a split model.
 */
async function modelSize(modelPath: string): Promise<number> {
  const { stat, readdir } = await import("node:fs/promises");
  const { basename, dirname, join } = await import("node:path");
  const split = /^(.*)-00001-of-(\d{5})\.gguf$/i.exec(basename(modelPath));
  if (!split) return (await stat(modelPath).catch(() => ({ size: 0 }))).size;
  const files = (await readdir(dirname(modelPath)).catch(() => [])).filter((f) => f.startsWith(`${split[1]}-`) && f.endsWith(`-of-${split[2]}.gguf`));
  const sizes = await Promise.all(files.map((f) => stat(join(dirname(modelPath), f)).then((x) => x.size, () => 0)));
  return sizes.reduce((a, b) => a + b, 0);
}
