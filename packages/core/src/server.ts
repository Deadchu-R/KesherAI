import type { AgentTool } from "@kesher/agent";
import { mkdir, readFile as readFileFs, writeFile as writeFileFs } from "node:fs/promises";
import { extname, join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { constants as zlibConstants } from "node:zlib";
import { timingSafeEqual } from "node:crypto";
import cors from "@fastify/cors";
import compress from "@fastify/compress";
import fastifyStatic from "@fastify/static";
import { existsSync, readFileSync } from "node:fs";
import { BUILT_IN_FACTORIES, PROVIDER_PRESETS, ProviderRegistry } from "@kesher/providers";
import { DownloadManager } from "@kesher/downloads";
import { branding, cleanAppearance, features } from "@kesher/shared";
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
import { Semantic } from "./semantic.js";
import { Tailscale } from "./tailscale.js";
import { ensureEngine } from "./routes/engine.js";
import { Personas } from "./personas.js";
import { Prompts } from "./prompts.js";
import { Notifier, type Note } from "./notify.js";
import { speechTools } from "./speech-tools.js";
import { mcpServerRoutes } from "./routes/mcp-server.js";
import { phoneRoutes } from "./routes/phones.js";
import { anthropicRoutes } from "./routes/anthropic.js";
import { apiKeyRoutes } from "./routes/api-keys.js";
import { ApiKeys } from "./api-keys.js";
import { SkillStore } from "./skill-store.js";
import { skillRoutes } from "./routes/skills.js";
import { libraryStoreRoutes } from "./routes/library-store.js";
import { Pipelines } from "./pipelines.js";
import { Routines } from "./routines.js";
import { ComfyManager } from "./comfy-manager.js";
import { ConversationSearch } from "./conversation-search.js";
import { comfyRoutes } from "./routes/comfy.js";
import { pipelineRoutes } from "./routes/pipelines.js";
import { transcribeWith } from "./speech-tools.js";
import { notificationRoutes } from "./routes/notifications.js";
import { promptRoutes } from "./routes/prompts.js";
import { personaRoutes } from "./routes/personas.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { librariesRoutes } from "./routes/libraries.js";
import { Libraries } from "./libraries.js";
import { findEngines } from "./unreal-install.js";
import { DriveSync } from "./drive-sync.js";
import { GpuGuard } from "./gpu-guard.js";
import { ComfyUIProvider } from "@kesher/providers";
import { flowState, readyFlows, setupFlow, withCheckpoints } from "./comfy-flows.js";
import { UnrealBridge } from "./unreal-bridge.js";
import { UnityCli } from "./unity-cli.js";
import { Copilot, copilotProvider } from "./copilot.js";
import { managedPolicy, policyCheck } from "./business.js";
import { copilotRoutes } from "./routes/copilot.js";
import { unityRoutes, unrealRoutes } from "./routes/unreal.js";
import { ProjectFacts } from "./project-facts.js";
import { unrealSourceRoutes } from "./routes/unreal-source.js";
import { projectFactsRoutes } from "./routes/project-facts.js";
import { gitRoutes } from "./routes/git.js";
import { lspRoutes } from "./routes/lsp.js";
import { codeRoutes } from "./routes/code.js";
import { guardRoutes } from "./routes/guard.js";
import { selfWorkRoutes } from "./routes/self-work.js";
import { SelfWork } from "./self-work.js";
import { seedBuiltinSkills } from "./builtin-skills.js";
import { TaskBoard } from "./task-board.js";
import { runIn } from "./run-in.js";
import { OneDrive, ONEDRIVE_ENDPOINTS, type OneDriveEndpoints } from "./onedrive.js";
import { Tunnel } from "./tunnel.js";
import { SdEngine, ensureImageModel, ensureVideoModel, sdProvider } from "./sdcpp.js";
import { BrowserBridge, browserTools } from "./browser-bridge.js";
import { Speakers } from "./speakers.js";
import { Kokoro } from "./kokoro.js";
import { memoryTools } from "./memory-tools.js";
import { browserRoutes } from "./routes/browser.js";
import { comfyUiRoutes } from "./routes/comfy-ui.js";
import { partsRoutes, setAppearance } from "./routes/parts.js";
import { TelegramBridge } from "./telegram.js";
import { AccessLog } from "./access-log.js";
import { Training, slug } from "./training.js";
import { CHAT_BASES, ChatTrainer } from "./chat-trainer.js";
import { applyPendingReset, cancelFullReset, fullResetPending, listBackups, requestFullReset, requestSettingsReset } from "./reset.js";
import { DeviceKeys, type DeviceKey } from "./device-keys.js";
import { telegramRoutes } from "./routes/telegram.js";
import { pagesRoutes } from "./routes/pages.js";
import { Pages } from "./pages.js";
import { pairRoutes } from "./routes/pair.js";
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
import { allowedOrigin, isLocalRequest, registerRemoteAuth } from "./auth.js";
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
import { onedriveRoutes } from "./routes/onedrive.js";
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
  /** Microsoft endpoints (tests point these at a fake server). */
  onedriveEndpoints?: OneDriveEndpoints;
  /** Installed copies: update from GitHub releases (the desktop app passes its version and how to run an installer). */
  updates?: PackagedUpdates;
  /** The desktop app's screen capture for "My day" (no PowerShell, which antivirus programs block). */
  screen?: ScreenSource;
  /** Shows a notification on this computer (desktop app); returns false when the window is in front. */
  notify?: (n: Note) => boolean | Promise<boolean>;
  /** Brings the desktop window to the front. */
  focusApp?: () => void;
  /** Restarts the desktop app (installing a downloaded update first, if there is one). */
  restartApp?: () => void;
  /** The project's GitHub OAuth App client id, for "Connect with GitHub" (builds pass it from repository secrets). */
  githubClientId?: string;
  /**
   * Worker mode: this is a second, window-less KesherAI that runs self-work, so
   * an update of the main app never stops the work. It uses the main app's
   * models over its local API (waiting while the main app restarts), shares its
   * task board, and sends notifications through it.
   */
  worker?: { mainUrl: string; mainRoot: string; version: string };
  /** Main mode (desktop app): self-work runs in the worker; this starts it when needed and says where it is. */
  workerHost?: { ensure: () => Promise<string>; url: () => string | undefined };
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
 * The interface's Content-Security-Policy: scripts, styles, fonts, pictures
 * and connections only from KesherAI itself (and Google's profile pictures).
 * A theme's CSS, a chat's Markdown or a page someone tricked the model into
 * writing cannot load anything from outside or send data away.
 */
export const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.googleusercontent.com",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

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
  // "Start over" (Settings → General): the old data folder moves aside before anything uses it.
  const resetBackup = await applyPendingReset(paths.root).catch(() => undefined);
  const config = await loadConfig(paths);
  if (config.modelsDir) {
    paths.models = config.modelsDir;
    await mkdir(paths.models, { recursive: true }).catch(() => undefined);
  }
  if (options.port !== undefined) config.port = options.port;
  const worker = options.worker;
  if (worker) {
    // The worker only works for the main app on this computer: no remote access, no device sharing.
    config.remote.enabled = false;
    config.devices.share = false;
    process.env.KESHER_NO_BEACON = "1";
  }

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
  const browser = new BrowserBridge();
  const speakers = new Speakers(join(paths.engines, "speakers"), downloads);
  const sd = new SdEngine(join(paths.engines, "sdcpp"), () => paths.models, downloads, async () => {
    const nv = await nvidiaGpus();
    // The image engine uses one card: the fastest allowed one (or the chosen leader).
    const pool = nv.filter((g) => !config.engines.gpus.use || config.engines.gpus.use.includes(g.index));
    const card = pool.find((g) => g.index === config.engines.gpus.main) ?? bySpeed(pool)[0];
    return { nvidia: nv.length > 0, ...(card ? { vramGb: card.vramFree / 1024 ** 3, cudaIndex: card.index } : {}) };
  });
  registry.registerFactory({ type: "sdcpp", displayName: "KesherAI image engine (stable-diffusion.cpp)", categories: ["image"], create: () => sdProvider(sd) });
  registry.add({ id: "sdcpp", type: "sdcpp", name: "KesherAI image engine", location: "local" });
  // The worker's models are the main app's (one copy on the graphics card), reached over its local API.
  let mainSlot: number | undefined;
  if (worker) {
    const readSlot = () =>
      void fetch(`${worker.mainUrl.replace(/\/$/, "")}/api/engines/llamacpp`, { signal: AbortSignal.timeout(5000) })
        .then((r) => r.json() as Promise<{ slotTokens?: number }>)
        .then((st) => (mainSlot = st.slotTokens), () => undefined);
    readSlot();
    setInterval(readSlot, 30_000).unref();
  }
  if (worker) registry.add({ id: "main", type: "openai-compatible", name: "KesherAI (main)", location: "local", baseUrl: `${worker.mainUrl.replace(/\/$/, "")}/v1`, options: { waitForServerMs: 10 * 60_000 } });

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
  downloads.limit = config.downloadLimitMBps * 1024 * 1024;
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
  // Search by meaning: an embedding model (KesherAI's own in a second llama.cpp server, or one the user made active).
  // Assigned below, once the engine exists; the knowledge bases ask for it when they search.
  // eslint-disable-next-line prefer-const
  let semantic: Semantic | undefined;
  const knowledge = new Knowledge(join(paths.root, "knowledge"), () => semantic?.embedder());
  void knowledge.load();
  // The library store: documentation downloaded once, searched offline as knowledge bases. Unreal's API comes
  // from the installed engine's own headers (the UObject classes and Core), with no download.
  const libraries = new Libraries(join(paths.root, "libraries"), knowledge, async () => {
    const e = (await findEngines())[0];
    if (!e) return undefined;
    const src = join(e.path, "Engine", "Source", "Runtime");
    return [join(src, "Engine", "Classes"), join(src, "CoreUObject", "Public", "UObject"), join(src, "InputCore", "Classes"), join(src, "UMG", "Public")];
  });
  const personas = new Personas(join(paths.root, "personas.json"));
  const skills = new SkillStore(paths.skills);
  // The specialist skills KesherAI ships with (materials, VFX, level design); the user's own edits are kept.
  void seedBuiltinSkills(paths.skills).then(() => skills.list()).catch(() => undefined);
  void skills.list().catch(() => undefined);
  void personas.load();
  const persist = () => saveConfig(paths, config);
  // The project's own OAuth client (branding.config.ts) is used unless the user set another.
  // The project's Google client: from the release build, or — for a copy run from the source — a
  // google-client.json in the data folder (the same file the release workflow writes).
  const fileClient = (() => {
    try {
      const j = JSON.parse(readFileSync(join(paths.root, "google-client.json"), "utf8")) as { clientId?: string; clientSecret?: string };
      return j.clientId ? { clientId: j.clientId, clientSecret: j.clientSecret ?? "" } : undefined;
    } catch {
      return undefined;
    }
  })();
  const google = new GoogleDrive(config.google, persist, options.googleEndpoints ?? GOOGLE_ENDPOINTS, options.googleClient ?? fileClient ?? branding.google);
  const driveSync = new DriveSync(google, library, config.google, persist);
  const guard = new GpuGuard(
    () => config.guard,
    undefined,
    (text) => void notifier.send({ title: "Graphics card", body: text, path: "#/settings", tags: ["thermometer"] }).catch(() => undefined),
  );
  const onedrive = new OneDrive(config.onedrive, persist, options.onedriveEndpoints ?? ONEDRIVE_ENDPOINTS, process.env.KESHER_ONEDRIVE_CLIENT_ID || branding.onedrive.clientId || undefined);
  const onedriveSync = new DriveSync(onedrive, library, config.onedrive, persist);
  // Microsoft 365 Copilot uses the same app registration as OneDrive unless the user set its own.
  const copilot = new Copilot(config.copilot, persist, options.onedriveEndpoints ?? ONEDRIVE_ENDPOINTS, () => config.onedrive.clientId || process.env.KESHER_ONEDRIVE_CLIENT_ID || branding.onedrive.clientId || undefined);
  registry.registerFactory({ type: "copilot", displayName: "Microsoft 365 Copilot", categories: ["chat"], create: () => copilotProvider(copilot) });
  registry.add({ id: "copilot", type: "copilot", name: "Microsoft 365 Copilot", location: "cloud" });
  // Business mode: only the allowed connections stay on (an administrator's policy.json wins).
  const business = () => managedPolicy(paths.root) ?? config.business;
  const applyBusiness = () => registry.setPolicy(business().enabled ? policyCheck(business()) : undefined);
  applyBusiness();

  const speeds = new Speeds(join(paths.root, "speeds.json"));
  onModelSpeed((id, tokens, ms) => void speeds.record(id, tokens, ms));
  const tailscaleCli = new Tailscale();
  const tunnel = new Tunnel(join(paths.engines, "cloudflared"), downloads, {
    mode: () => config.remote.anywhereMode,
    named: () => config.remote.cloudflare,
    saveNamed: async (n) => {
      config.remote.cloudflare = n;
      await persist();
    },
    tailscale: tailscaleCli,
    // Funnel passes requests to 127.0.0.1; they still need a key: they name another host and carry forwarding headers.
    tailscaleTarget: async () => ((await tailscaleCli.status(config.port).catch(() => undefined))?.running ? "127.0.0.1" : undefined),
  });
  const whisper = new WhisperEngine(join(paths.engines, "whisper"), () => paths.models, downloads, async () => {
    const nv = await nvidiaGpus();
    return { nvidia: nv.length > 0, ...(nv[0] ? { vramGb: nv[0].vramTotal / 1024 ** 3 } : {}) };
  });
  const updater = new Updater(undefined, options.updates, join(paths.root, "logs"));
  if (!config.notifications.ntfy.topic) {
    config.notifications.ntfy.topic = Notifier.newTopic();
    void persist().catch(() => undefined);
  }
  const notifier = new Notifier(() => config.notifications, {
    ...(options.notify ? { desktop: options.notify } : {}),
    publicUrl: () => tunnel.status().url,
    // The Approve / Deny buttons on the phone's (and watch's) notification.
    decide: async (convId, requestId, decision) => !!(await services.conversations.open(convId))?.session.approve(requestId, decision),
  });
  downloads.on("update", (job: { id: string; label: string; status: string; error?: string }) => notifier.onDownload(job));
  // Telegram: the user's own bot; each paired chat has its own conversation (telegram.ts).
  const telegram = new TelegramBridge(config.telegram, persist, {
    newConversation: async (title) => (await services.conversations.create({ kind: "chat", title, source: "telegram" })).id,
    send: async (convId, text) => void (await services.conversations.send(convId, text)),
    decide: async (convId, requestId, decision) => !!(await services.conversations.open(convId))?.session.approve(requestId, decision),
    answer: async (convId, questionId, text) => !!(await services.conversations.open(convId))?.session.answer(questionId, text),
    image: async (id) => {
      const a = await assets.get(id);
      return a && a.asset.mimeType.startsWith("image/") ? { data: a.data, mimeType: a.asset.mimeType } : undefined;
    },
    alert: (title, body) => void notifier.send({ title, body, path: "#/settings/phone", tags: ["warning"], priority: 4 }).catch(() => undefined),
    allowed: () => registry.permitted("telegram"),
    saveFile: async (convId, name, data) => {
      const conv = await library.getConversation(convId);
      const folder = conv ? services.conversations.workspaceOf(conv) : undefined;
      if (!folder) throw new Error("This chat has no folder.");
      await mkdir(join(folder, "shared"), { recursive: true });
      await writeFileFs(join(folder, "shared", name), data);
      return `shared/${name}`;
    },
    transcribe: async (data, ext) => (await transcribeWith({ whisper, speech: () => config.speech, providers: () => config.providers }, Buffer.from(data), ext, config.speech.language)).text,
  });
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
    httpsUrl: async () => {
      const h = await new Tailscale().status(config.port).catch(() => undefined);
      return h?.on ? h.url : undefined;
    },
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
  if (config.comfyui.autoStart && config.parts.nodes !== false) void comfy.start().catch(() => undefined);
  semantic = new Semantic({
    config,
    registry,
    downloads,
    modelsDir: () => paths.models,
    enginesDir: paths.engines,
    binary: async () => {
      if (!engine.status().installed) await ensureEngine(services);
      return engine.status().binaryPath!;
    },
    save: persist,
    changed: () => void knowledge.reindexAll(),
  });
  void semantic.resume().catch(() => undefined);
  // Routines: pipelines and prompts on a schedule.
  const routines = new Routines(join(paths.root, "routines.json"), {
    runPipeline: async (id, inputs) => {
      const run = await pipelines.start(id, inputs);
      const done = await pipelines.wait(run.id);
      const files = done?.files.length ? ` Files: ${done.files.join(", ")}.` : "";
      return { ok: done?.status === "done", message: done?.status === "done" ? `Finished.${files}` : done?.error ?? "Stopped.", link: "#/pipelines" };
    },
    runPrompt: async (name, prompt, modelId, personaId, opts = {}) => {
      const c = await services.conversations.create({ kind: "chat", title: `${name} · ${new Date().toLocaleDateString()}`, ...(modelId ? { modelId } : {}), ...(personaId ? { personaId } : {}) });
      // A routine's folder (e.g. a list it keeps): created if missing, then opened to this chat's file tools.
      if (opts.folder) {
        await mkdir(opts.folder, { recursive: true });
        await (await services.conversations.open(c.id))?.session.grant(opts.folder);
      }
      await services.conversations.send(c.id, opts.folder ? `${prompt}\n\n(Your folder for this: ${opts.folder})` : prompt, opts.web ? { web: true } : {});
      const end = Date.now() + 30 * 60_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const opened = await services.conversations.open(c.id);
        const st = opened?.session.info().status;
        if (st === "waiting") return { ok: true, message: "Waiting for your approval.", link: "#/watch" };
        if (st !== "running" || Date.now() > end) {
          const last = [...(opened?.session.events ?? [])].reverse().find((e) => e.type === "assistant");
          return { ok: st !== "error" && !!last, message: last && last.type === "assistant" ? last.text.replace(/\s+/g, " ").slice(0, 300) : "No answer.", link: `#/c/${c.id}` };
        }
      }
    },
    notify: async (title, body, path) => void (await notifier.send({ title, body: config.notifications.includeText ? body : body.length > 80 ? "Done — open KesherAI to read it." : body, path, tags: ["alarm_clock"] })),
    discard: async (link) => {
      const id = /^#\/c\/([\w-]+)$/.exec(link)?.[1];
      if (id) await services.conversations.delete(id);
    },
    telegram: async (text) => telegram.broadcast(text),
    busy: () => Object.keys(services.conversations.activity()).length > 0,
  });
  void routines.start();
  // Unity's CLI: the Unity page and the chat's Unity tools share it.
  UnityCli.setLogFile(join(paths.root, "logs", "unity-cli.log"));
  const unityCli = new UnityCli(config.unity, persist);
  // Look for the CLI now, so the first chat already has the Unity tools.
  unityCli.cliKnown();
  const unrealBridge = new UnrealBridge(join(paths.root, "unreal"));
  // The task board self-work shares with Claude: a file on this computer only.
  const sharedDir = join(worker ? worker.mainRoot : paths.root, "self-work");
  const taskBoard = new TaskBoard(join(sharedDir, "board.json"));
  const projectFacts = new ProjectFacts(join(paths.root, "project-facts.json"));
  const services: KesherServices = {
    browser,
    config,
    paths,
    registry,
    assets,
    downloads,
    plugins,
    engine,
    library,
    projectFacts,
    conversations: new ConversationManager({
      board: taskBoard,
      registry,
      library,
      assets,
      plugins,
      config,
      outputsDir: join(paths.root, "outputs"),
      checkpoints: new Checkpoints(join(paths.root, "checkpoints")),
      personas,
      skills,
      projectFacts,
      // A self-work worker uses the main app's engine (main/llamacpp/…): its share comes from there.
      engineSlotTokens: () => (worker ? mainSlot : engine.slotContext()),
      onEvent: (convId, e, title, lastAnswer) => {
        notifier.onConversationEvent(convId, title, e, lastAnswer);
        telegram.onConversationEvent(convId, e);
      },
      ensureImageModel: () => ensureImageModel({ sd, downloads, config, modelsDir: () => paths.models, save: persist }),
      // Parts the user turned off (Settings → Parts) give no tools.
      computerTools: (id) => (config.parts.watch === false ? [] : computer.tools(id)),
      mcpTools: () => [
        ...googleTools(google),
        ...(config.parts.knowledge === false ? [] : knowledgeTools(knowledge)),
        ...(config.parts.browser === false ? [] : browserTools(browser)),
        ...(config.parts.voice === false ? [] : speechTools({ whisper, speech: () => config.speech, providers: () => config.providers })),
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
      // change_look: the chat changes how the app looks (the same as Settings → Appearance).
      unity: unityCli,
      unreal: unrealBridge,
      look: {
        get: () => cleanAppearance(config.appearance),
        set: async (next) => {
          setAppearance({ config }, next);
          await persist();
        },
        undo: async () => {
          const prev = config.appearanceHistory.pop();
          if (prev === undefined) return false;
          config.appearance = prev;
          await persist();
          return true;
        },
      },
      // Music and 3D from the chat: the ready-made ComfyUI flows (comfy-flows.ts).
      flows: {
        state: (id: string) => {
          const flow = readyFlows().find((f) => f.id === id);
          if (!flow) throw new Error(`No flow ${id}`);
          return { ...flowState(flow, paths.models, downloads), installed: comfy.status().installed, allowed: registry.permitted("comfyui") };
        },
        setup: async (id: string) => {
          const flow = readyFlows().find((f) => f.id === id)!;
          await setupFlow(flow, paths.models, downloads);
        },
        run: async (id: string, edit: (flow: Record<string, { class_type: string; inputs: Record<string, unknown> }>, upload: (data: Uint8Array, name: string) => Promise<string>) => Promise<void> | void, signal: AbortSignal) => {
          if (!registry.permitted("comfyui")) throw new Error("ComfyUI is turned off by business mode.");
          const flow = readyFlows().find((f) => f.id === id)!;
          if (!comfy.status().running) {
            const up = await fetch(`${comfy.status().url}/system_stats`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
            if (!up) await comfy.start();
          }
          const names = await fetch(`${comfy.status().url}/models/checkpoints`).then((r) => (r.ok ? (r.json() as Promise<string[]>) : []), () => [] as string[]);
          const graph = withCheckpoints(flow, names);
          const provider = new ComfyUIProvider({ id: "comfyui-flows", type: "comfyui", name: "ComfyUI", baseUrl: comfy.status().url, location: "local" });
          await edit(graph, (data, name) => provider.uploadImage(data, name));
          await guard.before("comfyui", signal);
          try {
            return await provider.runFlow(graph, signal);
          } finally {
            guard.after();
          }
        },
      },
      video: {
        // A video model from a connection (ComfyUI's Wan) when that is the active one, else the built-in engine.
        ensure: async () => {
          const active = config.activeModels.video;
          if (active && !existsSync(active)) {
            try {
              if (registry.resolve(active).provider.generateVideo) return { path: active };
            } catch {
              // that connection is gone: fall back to the built-in engine
            }
          }
          return ensureVideoModel({ sd, downloads, config, modelsDir: () => paths.models, save: persist });
        },
        generate: async (path, req) => {
          if (!existsSync(path)) {
            const target = registry.resolve(path);
            const [file] = (await target.provider.generateVideo?.({ providerModelId: target.providerModelId, ...req })) ?? [];
            if (!file) throw new Error("The video model made no video.");
            return file;
          }
          return sd.generateVideo(path, req);
        },
      },
      userNotes: async () => (config.coach?.learn === false ? [] : (await coach.profile()).notes),
      memoryTools: () => (config.coach?.learn === false ? [] : memoryTools(coach)),
    }),
    coach,
    computer,
    mcp,
    speeds,
    runtimes,
    github,
    journal,
    knowledge,
    libraries,
    personas,
    skills,
    pipelines,
    routines,
    comfy,
    semantic: semantic!,
    conversationSearch: new ConversationSearch(library),
    notifier,
    prompts: new Prompts(join(paths.root, "prompts.json")),
    whisper,
    speakers,
    kokoro: new Kokoro(join(paths.engines, "voice"), speakers, downloads),
    updater,
    google,
    driveSync,
    onedrive,
    onedriveSync,
    guard,
    copilot,
    business,
    businessManaged: () => !!managedPolicy(paths.root),
    applyBusiness: () => {
      applyBusiness();
      telegram.restart();
    },
    unreal: unrealBridge,
    unity: unityCli,
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
  // Self-work: KesherAI works on a git project by itself, on its own branch, item by item.
  let workerUpgrade = false;
  const selfWork = new SelfWork(join(paths.root, "self-work.json"), {
    createChat: async (folder, title, modelId, extra = []) => {
      const c = await services.conversations.create({ kind: "code", workspace: folder, mode: "auto", title, ...(modelId ? { modelId } : {}) });
      // The shared board and handoff: readable by this chat's file tools.
      for (const f of extra) {
        await mkdir(f, { recursive: true }).catch(() => undefined);
        await (await services.conversations.open(c.id))?.session.grant(f);
      }
      return c.id;
    },
    send: async (id, text) => void (await services.conversations.send(id, text)),
    state: async (id) => {
      const opened = await services.conversations.open(id);
      const last = [...(opened?.session.events ?? [])].reverse().find((e) => e.type === "assistant");
      return { status: opened?.session.info().status ?? "error", last: last && last.type === "assistant" ? last.text : "", events: opened?.session.events.length ?? 0 };
    },
    stopTurn: (id) => services.conversations.stop(id),
    git: (repo, args) => runIn(repo, "git", args, false),
    check: (repo, command) => runIn(repo, command, [], true),
    // The worker tells the main app, which has the phone notifications set up.
    notify: async (title, body, path) =>
      void (worker
        ? await fetch(`${worker.mainUrl.replace(/\/$/, "")}/api/self-work/notify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, body, path }), signal: AbortSignal.timeout(10_000) }).catch(() => undefined)
        : await notifier.send({ title, body, path, tags: ["robot"] }).catch(() => undefined)),
    shared: sharedDir,
    // Between items: a worker asked to move to a newer version stops here (its run continues in the new one).
    between: async () => {
      if (workerUpgrade) process.exit(75);
    },
  });
  services.selfWork = selfWork;
  services.worker = worker ? { version: worker.version, upgrade: () => {
    workerUpgrade = true;
    const r = selfWork.current;
    if (!r || (r.status !== "running" && r.status !== "waiting")) setTimeout(() => process.exit(75), 500);
  } } : undefined;
  services.workerHost = options.workerHost;
  services.board = taskBoard;
  void selfWork.load().catch(() => undefined);
  if (worker) {
    // A worker with nothing to do for 10 minutes ends (the main app starts it again for the next run).
    let idleSince = Date.now();
    setInterval(() => {
      const r = selfWork.current;
      if (r && (r.status === "running" || r.status === "waiting")) idleSince = Date.now();
      else if (Date.now() - idleSince > 10 * 60_000) process.exit(0);
    }, 30_000).unref();
  }

  // 25 MB for a request (model APIs with pictures); the few routes that take more say so themselves.
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 25 * 1024 * 1024 });
  // Cross-origin access: the model API (/v1) for web apps of any origin (they need an access key);
  // KesherAI's own API only for its own pages, the Android app and, for /api/browser, the extension.
  // Smaller answers over Wi-Fi and the tunnel (a long chat's JSON shrinks about tenfold). Only text:
  // never live streams (they must arrive as they are written), models or pictures.
  await app.register(compress, {
    global: true,
    threshold: 2048,
    encodings: ["br", "gzip"],
    brotliOptions: { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } },
    customTypes: /^(application\/json|text\/(html|css|javascript|plain|markdown)|application\/javascript|image\/svg\+xml)(;|$)/,
  });
  await app.register(cors, {
    delegator: (req, cb) => {
      const path = (req.url ?? "").split("?")[0] ?? "";
      const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
      const open = path.startsWith("/v1");
      cb(null, { origin: open ? true : !!origin && allowedOrigin(origin, req.headers.host, path) });
    },
  });
  const apiKeys = new ApiKeys(() => config.apiKeys, persist);
  services.lastServed = () => apiKeys.lastServedAt;
  if (options.focusApp) services.focusApp = options.focusApp;
  if (options.restartApp) services.restartApp = options.restartApp;
  // A log of model-API requests (who, which model, how long), shown in Settings.
  // preHandler (not onResponse) so streamed answers, which take over the reply, are logged too.
  app.addHook("preHandler", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    if (!(path.startsWith("/v1/") || path === "/mcp") || request.method === "OPTIONS") return;
    const started = Date.now();
    const xKey = request.headers["x-api-key"];
    const given = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? (typeof xKey === "string" ? xKey : undefined);
    const body = request.body as { model?: unknown; method?: unknown; params?: { name?: unknown } } | undefined;
    const model = typeof body?.model === "string" ? body.model : path === "/mcp" && body?.method === "tools/call" ? `mcp: ${String(body.params?.name ?? "")}` : undefined;
    const caller = apiKeys.identify(given, isLocalRequest(request));
    reply.raw.once("finish", () => apiKeys.record({ at: new Date(started).toISOString(), caller, method: request.method, path, ...(model ? { model } : {}), status: reply.raw.statusCode, ms: Date.now() - started }));
  });
  // Pages the API itself answers with (sign-in results, printable chats): nothing from outside, no connections.
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/api/") && String(reply.getHeader("content-type") ?? "").startsWith("text/html") && !reply.getHeader("content-security-policy")) {
      reply.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; script-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
    }
    return payload;
  });
  // Training models from KesherAI: a picture LoRA through ComfyUI's training nodes (training.ts).
  const training = new Training({
    comfy: () => comfy.status(),
    vramGb: async () => Math.max(0, ...(await nvidiaGpus()).map((g) => g.vramTotal / 1024 ** 3)),
    objectInfo: async () => (await fetch(`${comfy.status().url}/object_info`, { signal: AbortSignal.timeout(15_000) })).json() as Promise<Record<string, { input?: { required?: Record<string, unknown[]> } }>>,
    runFlow: (flow, signal) => new ComfyUIProvider({ id: "comfyui-train", type: "comfyui", name: "ComfyUI", baseUrl: comfy.status().url, location: "local" }).runFlow(flow, signal, 4 * 60 * 60_000),
    loraDir: () => sd.loraDir,
    interrupt: async () => void (await fetch(`${comfy.status().url}/interrupt`, { method: "POST" })),
    chats: async () =>
      (await Promise.all(library.listConversations().map((c) => library.getConversation(c.id)))).filter((c): c is NonNullable<typeof c> => !!c).map((c) => ({
        id: c.id,
        title: c.title,
        turns: c.events.flatMap((e): Array<{ role: "user" | "assistant"; text: string }> => (e.type === "user" || e.type === "assistant" ? [{ role: e.type, text: (e as { text: string }).text }] : [])),
      })),
    documents: async () => {
      const pg = new Pages(join(paths.root, "pages"));
      return (await Promise.all((await pg.list()).map((p) => pg.get(p.id)))).filter((p): p is NonNullable<typeof p> => !!p).map((p) => ({ title: p.title, content: p.content }));
    },
    datasetDir: () => join(paths.root, "training", "datasets"),
  });
  // Step 3 (experimental): a chat-model LoRA with unsloth, in its own Python (chat-trainer.ts).
  const chatTrainer = new ChatTrainer(join(paths.engines, "unsloth"), {
    uv: async () => {
      await runtimes.install("uv");
      const dir = (await runtimes.paths()).find((p) => existsSync(join(p, process.platform === "win32" ? "uv.exe" : "uv")));
      if (!dir) throw new Error("uv was not found after installing it.");
      return join(dir, process.platform === "win32" ? "uv.exe" : "uv");
    },
    modelsDir: () => paths.models,
  });
  app.get("/api/training/chat", async () => ({ ...chatTrainer.status(), bases: CHAT_BASES, vramGb: Math.max(0, ...(await nvidiaGpus()).map((g) => g.vramTotal / 1024 ** 3)) }));
  app.post("/api/training/chat/install", async () => {
    void chatTrainer.install();
    return chatTrainer.status();
  });
  app.post<{ Body: { name?: string; dataset?: string; base?: string; steps?: number; rank?: number } }>("/api/training/chat", async (req, reply) => {
    const ds = (await training.datasets()).find((d) => d.name === req.body?.dataset);
    if (!ds) return reply.code(400).send({ error: "Choose a dataset." });
    try {
      await chatTrainer.train({ name: slug(String(req.body?.name ?? ds.name)), dataset: ds.file, base: String(req.body?.base ?? ""), ...(typeof req.body?.steps === "number" ? { steps: req.body.steps } : {}), ...(typeof req.body?.rank === "number" ? { rank: req.body.rank } : {}) });
      return chatTrainer.status();
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.get("/api/training/datasets", async () => training.datasets());
  app.post<{ Body: { name?: string; chats?: string[]; documents?: boolean } }>("/api/training/datasets", async (req, reply) => {
    try {
      return await training.buildChatDataset({ name: String(req.body?.name ?? "my-texts"), chats: Array.isArray(req.body?.chats) ? req.body.chats.filter((x) => typeof x === "string") : [], documents: req.body?.documents === true });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.get("/api/training", async () => ({ kinds: await training.kinds(), jobs: training.list() }));
  app.post<{ Body: { name?: string; trigger?: string; base?: string; steps?: number; rank?: number; images?: Array<{ data?: string; mimeType?: string }> } }>("/api/training/image-lora", { bodyLimit: 300 * 1024 * 1024 }, async (req, reply) => {
    const b = req.body ?? {};
    const images = (b.images ?? []).filter((i) => typeof i.data === "string" && /^image\/(png|jpeg|webp)$/.test(i.mimeType ?? "")).map((i) => ({ data: Buffer.from(i.data!, "base64"), mimeType: i.mimeType! }));
    try {
      return await training.startImageLora({ name: String(b.name ?? ""), trigger: String(b.trigger ?? ""), base: String(b.base ?? ""), images, ...(typeof b.steps === "number" ? { steps: b.steps } : {}), ...(typeof b.rank === "number" ? { rank: b.rank } : {}) });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.post("/api/training/stop", async () => {
    training.stop();
    return { ok: true };
  });
  // Reset: settings back to default, or start over (both keep a backup), or install the latest version again.
  app.get("/api/reset", async () => ({ ...(await listBackups(paths.root)), pending: fullResetPending(paths.root), ...(resetBackup ? { justReset: resetBackup } : {}), canRestart: !!options.restartApp, canReinstall: !!options.updates }));
  app.post<{ Body: { kind?: "settings" | "everything" | "reinstall" | "cancel"; keepModels?: boolean } }>("/api/reset", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Reset is done on the computer that runs KesherAI." });
    const kind = req.body?.kind;
    if (kind === "settings") {
      await requestSettingsReset(paths.root);
      if (options.restartApp) setTimeout(() => options.restartApp?.(), 600);
      return { ok: true, restarting: !!options.restartApp };
    }
    if (kind === "everything") {
      await requestFullReset(paths.root, req.body?.keepModels !== false);
      if (options.restartApp) setTimeout(() => options.restartApp?.(), 600);
      return { ok: true, restarting: !!options.restartApp };
    }
    if (kind === "cancel") {
      await cancelFullReset(paths.root);
      return { ok: true };
    }
    if (kind === "reinstall") {
      try {
        return await updater.reinstall();
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    }
    return reply.code(400).send({ error: "Say what to reset: settings, everything, reinstall." });
  });
  // Who came in from outside (and who was refused), for Settings → Phone.
  const accessLog = new AccessLog(join(paths.root, "access-log.json"), (title, body) => void notifier.send({ title, body, path: "#/settings/phone", tags: ["rotating_light"], priority: 4 }).catch(() => undefined));
  const deviceKeys = new DeviceKeys(() => config.remote.devices, persist);
  if (features.remote) {
    registerRemoteAuth(app, () => config.remote.token, { verify: (k) => apiKeys.verify(k), requireLocally: () => config.apiAuth.requireKeyLocally }, (r) => accessLog.note(r), {
      find: (k) => deviceKeys.find(k),
      seen: (d, a) => deviceKeys.seen(d as DeviceKey, a),
      devicesOnly: () => config.remote.anywhereDevicesOnly,
      idleDays: () => config.remote.anywhereIdleDays,
    });
  }
  services.deviceKeys = deviceKeys;
  // Paired devices (their own keys) and how the internet link lets them in: Settings → Phone.
  app.get("/api/remote/devices", async () => ({ devices: deviceKeys.devices(), devicesOnly: config.remote.anywhereDevicesOnly, idleDays: config.remote.anywhereIdleDays }));
  /**
   * A device that came in with the shared token (found through Google, or the QR code) trades it for a
   * key of its own, so it keeps working when "only paired devices" is on, and can be removed alone.
   */
  app.post<{ Body: { device?: string } }>("/api/remote/devices/exchange", async (req, reply) => {
    const given = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    const token = config.remote.token ?? "";
    if (isLocalRequest(req) || !token || given.length !== token.length || !timingSafeEqual(Buffer.from(given), Buffer.from(token))) {
      return reply.code(400).send({ error: "Only a device that uses the shared token can trade it for its own key." });
    }
    return { token: await deviceKeys.issue(String(req.body?.device ?? "Device")) };
  });
  /**
   * A link for another device of the user's (a laptop's KesherAI, a browser): a key of its own, through
   * the internet link. Any signed-in device may ask (the user is often away from the computer), and every
   * new key is announced on the computer and the phone, and can be removed alone.
   */
  const invites: number[] = [];
  app.post<{ Body: { device?: string } }>("/api/remote/devices/invite", async (req, reply) => {
    // A few an hour: a stolen key cannot make many more keys for itself.
    const hourAgo = Date.now() - 3_600_000;
    while (invites.length && invites[0]! < hourAgo) invites.shift();
    if (invites.length >= 5) return reply.code(429).send({ error: "Five links were made in the last hour. Try again later." });
    const url = tunnel.status().url;
    if (!url) return reply.code(409).send({ error: "Turn on access from anywhere first (Settings → Phone)." });
    const name = String(req.body?.device ?? "Device").replace(/[^\p{L}\p{N} ._()-]/gu, "").slice(0, 40) || "Device";
    invites.push(Date.now());
    const key = await deviceKeys.issue(name);
    void notifier.send({ title: "A new device key was made", body: `"${name}" can now connect to KesherAI through the internet link${isLocalRequest(req) ? "" : " (made from a connected device)"}. If it was not you, remove it in Settings → Phone.`, path: "#/settings/phone", tags: ["key"], priority: 4 }).catch(() => undefined);
    return { link: `${url.replace(/\/$/, "")}/?token=${encodeURIComponent(key)}`, name };
  });
  /**
   * A link for an AI app such as Claude (a custom connector, added from the phone or the web): KesherAI's MCP
   * server through the internet link, with a key that opens only /mcp. Like device links, any signed-in device
   * may ask (a few an hour), and each new key is announced and can be removed alone in Settings → Phone.
   */
  app.post<{ Body: { name?: string } }>("/api/remote/devices/connector", async (req, reply) => {
    const hourAgo = Date.now() - 3_600_000;
    while (invites.length && invites[0]! < hourAgo) invites.shift();
    if (invites.length >= 5) return reply.code(429).send({ error: "Five links were made in the last hour. Try again later." });
    if (!config.mcpServer.enabled) return reply.code(409).send({ error: "KesherAI's MCP server is off (Settings → For developers, on the computer)." });
    const url = tunnel.status().url;
    if (!url) return reply.code(409).send({ error: "Turn on access from anywhere first (Settings → Phone, on the computer)." });
    const name = `${String(req.body?.name ?? "Claude").replace(/[^\p{L}\p{N} ._()-]/gu, "").slice(0, 30) || "Claude"} (connector)`;
    invites.push(Date.now());
    const key = await deviceKeys.issue(name, "mcp");
    void notifier.send({ title: "A connector key was made", body: `"${name}" can now give KesherAI tasks through the internet link (its key opens only the MCP server)${isLocalRequest(req) ? "" : ", made from a connected device"}. If it was not you, remove it in Settings → Phone.`, path: "#/settings/phone", tags: ["key"], priority: 4 }).catch(() => undefined);
    return { url: `${url.replace(/\/$/, "")}/mcp?token=${encodeURIComponent(key)}`, name };
  });
  app.delete<{ Params: { id: string } }>("/api/remote/devices/:id", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Devices are removed on the computer that runs KesherAI." });
    return { ok: await deviceKeys.remove(req.params.id) };
  });
  app.put<{ Body: { devicesOnly?: boolean; idleDays?: number } }>("/api/remote/devices", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "This is set on the computer that runs KesherAI." });
    if (typeof req.body?.devicesOnly === "boolean") config.remote.anywhereDevicesOnly = req.body.devicesOnly;
    if (typeof req.body?.idleDays === "number") config.remote.anywhereIdleDays = Math.max(0, Math.min(365, Math.round(req.body.idleDays)));
    await persist();
    return { devices: deviceKeys.devices(), devicesOnly: config.remote.anywhereDevicesOnly, idleDays: config.remote.anywhereIdleDays };
  });
  app.get("/api/access-log", async () => accessLog.list());
  app.delete("/api/access-log", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "The log is cleared on the computer that runs KesherAI." });
    await accessLog.clear();
    return { ok: true };
  });

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
  await librariesRoutes(app, services);
  await personaRoutes(app, services);
  await promptRoutes(app, services);
  await skillRoutes(app, services);
  await libraryStoreRoutes(app, services);
  await pipelineRoutes(app, services);
  await comfyRoutes(app, services);
  await notificationRoutes(app, services);
  await mcpServerRoutes(app, services);
  await phoneRoutes(app, services);
  await githubRoutes(app, services);
  await deviceRoutes(app, services);
  await libraryRoutes(app, services);
  await fileRoutes(app, services);
  await googleRoutes(app, services);
  await onedriveRoutes(app, services);
  await guardRoutes(app, services);
  await selfWorkRoutes(app, services);
  await unrealRoutes(app, services);
  unrealSourceRoutes(app, services);
  await projectFactsRoutes(app, services);
  await gitRoutes(app, services);
  lspRoutes(app, services);
  codeRoutes(app, services);
  await unityRoutes(app, services);
  await copilotRoutes(app, services);
  await browserRoutes(app, services);
  await comfyUiRoutes(app, services);
  await partsRoutes(app, services);
  await telegramRoutes(app, telegram);
  telegram.start();
  await pagesRoutes(app, services, new Pages(join(paths.root, "pages")));
  await pairRoutes(app, services);

  if (options.webDir && existsSync(options.webDir)) {
    await app.register(fastifyStatic, {
      root: options.webDir,
      // (@fastify/static 10 passes the reply here.)
      setHeaders: (reply: { header(name: string, value: string): unknown }, path: string) => {
        if (path.endsWith(".html")) reply.header("content-security-policy", WEB_CSP);
      },
    });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/") || req.url.startsWith("/v1/")
        ? reply.code(404).send({ error: "Not found" })
        : reply.header("content-security-policy", WEB_CSP).sendFile("index.html"),
    );
  }

  // Bring this computer's library up to date with Google Drive, in the background.
  if (google.connected) void driveSync.syncNow().catch(() => undefined);
  if (onedrive.connected) void onedriveSync.syncNow().catch(() => undefined);
  // Find the user's other computers (same Google account) and keep their connections in step.
  devices.start();

  // Protect the graphics card: hold local work while it is too hot or paused, unload idle models.
  let comfyUsed = false;
  guard.add({
    name: "chat model",
    providers: ["llamacpp"],
    loaded: () => engine.status().running,
    unload: () => engine.stop("unused for a while (Settings → graphics card: unload after)"),
    reload: async () => {
      const path = config.engines.lastModel;
      if (path && existsSync(path) && engine.status().installed) await loadModel(services, path);
    },
    pids: () => (engine.pid ? [engine.pid] : []),
  });
  guard.add({
    name: "ComfyUI models",
    providers: ["comfyui"],
    loaded: () => comfyUsed && comfy.status().running,
    // Frees ComfyUI's memory without stopping it; the next flow loads what it needs.
    unload: async () => {
      comfyUsed = false;
      await fetch(`${comfy.status().url}/free`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ unload_models: true, free_memory: true }), signal: AbortSignal.timeout(10_000) });
    },
    used: () => void (comfyUsed = true),
    pids: () => (comfy.pid ? [comfy.pid] : []),
  });
  registry.setGate(guard);
  guard.start();
  app.addHook("onClose", async () => guard.stop());

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
      // A restart (from the phone, or to install an update) keeps the tunnel, so its address stays the same.
      if (services.restarting) services.tunnel.detach();
      else services.tunnel.stop();
      mcp.close();
      devices.close();
      journal.close();
      knowledge.close();
      notifier.close();
      telegram.stop();
      void comfy.stop();
      routines.close();
      void semantic?.stop();
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
