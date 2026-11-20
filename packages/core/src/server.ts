/**
 * KesherAI's core server: `createKesherServer` builds everything in one place, in order: the settings and
 * data folders, model providers, plugins, the services (conversations, the llama.cpp engine, the graphics card
 * guard, notifications, self-work, the task board…), every route under /api and /v1, the remote-access check,
 * and the UI. The desktop app and `pnpm dev` both start here. See docs/CODE_GUIDE.md (Hebrew) and
 * docs/ARCHITECTURE.md for the walk-through.
 */
import { hostname } from "node:os";
import { LinkWatch } from "./link-watch.js";
import { LinkBeaconPoster } from "./link-beacon-post.js";
import { LipSync } from "./lipsync.js";
import { basename, join } from "node:path";
import Fastify from "fastify";
import { constants as zlibConstants } from "node:zlib";
import cors from "@fastify/cors";
import compress from "@fastify/compress";
import fastifyStatic from "@fastify/static";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { BUILT_IN_FACTORIES, ProviderRegistry } from "@kesher/providers";
import { DownloadManager } from "@kesher/downloads";
import { beaconSecret, branding, features, helperHandoff, parseWorkList } from "@kesher/shared";
import type { HelperRunInfo } from "@kesher/shared";
import { saveConfig } from "./config.js";
import { AssetStore } from "./assets.js";
import { PluginHost } from "./plugins.js";
import { findMmproj } from "./llamacpp.js";
import { Library } from "./library.js";
import { modelTurnFor, onModelSpeed } from "./conversations.js";
import { Speeds } from "./speeds.js";
import { Updater } from "./updates.js";
import { GoogleDrive, GOOGLE_ENDPOINTS } from "./google.js";
import { Knowledge } from "./knowledge.js";
import { Semantic } from "./semantic.js";
import { Tailscale } from "./tailscale.js";
import { ensureEngine, loadModel } from "./routes/engine.js";
import { SideEngine, sideEngineOf } from "./side-engine.js";
import type { HelperEngine } from "./chat-helpers.js";
import { StudyModelSwitch } from "./study-model.js";
import { GodotBridge } from "./godot-bridge.js";
import { VoiceCloner } from "./voice-clone.js";
import { voiceCloneRoutes } from "./routes/voice-clone.js";
import { PartSegmenter } from "./part-seg.js";
import { partSegRoutes } from "./routes/part-seg.js";
import { BgRemover } from "./bg-remove.js";
import { bgRemoveRoutes } from "./routes/bg-remove.js";
import { localCall } from "./local-call.js";
import { scanComputer, scanFolder } from "./model-scan.js";
import { Prompts } from "./prompts.js";
import { Notifier } from "./notify.js";
import { ApiKeys } from "./api-keys.js";
import { ConversationSearch } from "./conversation-search.js";
import { PhonePush } from "./phone-push.js";
import { Libraries } from "./libraries.js";
import { findEngines } from "./unreal-install.js";
import { DriveSync } from "./drive-sync.js";
import { GpuGuard } from "./gpu-guard.js";
import { ComfyUIProvider } from "@kesher/providers";
import { Copilot, copilotProvider } from "./copilot.js";
import { managedPolicy, policyCheck } from "./business.js";
import { ProjectFacts } from "./project-facts.js";
import { ModelUse } from "./pc-fix.js";
import { TaskBoard } from "./task-board.js";
import { HubClient } from "./hub-client.js";
import { TasksSync } from "./tasks-sync.js";
import { buildTaskInbox } from "./server/build-inbox.js";
import { answerFromHub, isDangerousReason } from "./hub-approvals.js";
import { agentLabelCommand, inboxCommand } from "./hub-commands.js";
import { AgentActivity, HELPER_ASKS, helperSnapshot, INBOX_APPROVALS, inboxRunId, inboxSnapshot, type RunSnapshot } from "./agent-activity.js";
import { AgentLabels } from "./agent-labels.js";
import { assignTask, type AssignDeps } from "./task-assign.js";

/** The hub approval list's name for the task inbox's run asks. */
const INBOX_ASKS = "task-inbox";
import { CORE_VERSION } from "./routes/system.js";
import { OneDrive, ONEDRIVE_ENDPOINTS } from "./onedrive.js";
import { sdProvider } from "./sdcpp.js";
import { BrowserBridge } from "./browser-bridge.js";
import { Speakers } from "./speakers.js";
import { Kokoro } from "./kokoro.js";
import { ChatTimers } from "./chat-timers.js";
import { MemoryStore } from "./memory-store.js";
import { Tor } from "./tor.js";
import { FaultLog } from "./fault-log.js";
import { Training } from "./training.js";
import { ChatTrainer } from "./chat-trainer.js";
import { Pages } from "./pages.js";
import { Coach } from "./coach.js";
import { ComputerControl } from "./computer.js";
import { WhisperEngine } from "./whisper.js";
import { trainingRoutes } from "./routes/training.js";
import { resetRoutes } from "./routes/reset.js";
import { remoteDeviceRoutes } from "./routes/remote-devices.js";
import { guestRoutes } from "./routes/guests.js";
import { CanvasStore } from "./canvas.js";
import { GitHubAuth } from "./github.js";
import { Runtimes } from "./runtimes.js";
import { Devices } from "./devices.js";
import { McpManager } from "./mcp.js";
import { allowedOrigin, isLocalRequest } from "./auth.js";
import type { KesherServices } from "./services.js";
import { TERMINATED_FILE } from "./routes/system.js";
import { WEB_CSP, type KesherServer, type KesherServerOptions } from "./server/options.js";
import { openDataDir } from "./server/data-dir.js";
import { buildComfy, buildLlamaEngine, buildSdEngine, nvidiaGpus } from "./server/build-engines.js";
import { addProviders, openPersonasAndSkills } from "./server/build-chat.js";
import { buildConversations } from "./server/build-conversations.js";
import { registerRoutes } from "./server/routes.js";
import { startEngines } from "./server/start-engines.js";
import { buildGameEngines, buildJournal, buildPipelines, buildRoutines, buildSelfWork } from "./server/build-extras.js";
import { Study } from "./study.js";
import { buildNotifier, buildTelegram, buildTunnel, setupRemoteAccess, watchDisk } from "./server/build-remote.js";

export { amdCardOnLinux } from "./server/build-engines.js";

export { WEB_CSP, type KesherServer, type KesherServerOptions } from "./server/options.js";

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
  const { paths, config, resetBackup } = await openDataDir(options);
  const worker = options.worker;
  /** The server itself, once made: routines start self-work through its route. */
  const injectRef: { app?: { inject: (o: { method: "POST"; url: string; payload: unknown; remoteAddress: string; headers: Record<string, string> }) => Promise<{ statusCode: number; json: () => unknown }> } } = {};

  const registry = new ProviderRegistry();
  const downloads = new DownloadManager();
  for (const factory of BUILT_IN_FACTORIES) registry.registerFactory(factory);
  // The built-in image engine (stable-diffusion.cpp), shown as the "sdcpp" connection.
  const coach = new Coach(paths.root);
  const memory = new MemoryStore(join(paths.root, "memory.json"));
  // Stops conversations through a late-bound reference: the manager is created below.
  let stopConversation: (id: string) => void = () => undefined;
  const browser = new BrowserBridge();
  // One Stop for the browser and the computer: either button (or Ctrl+Alt+Esc) ends both.
  const computer = new ComputerControl(() => config.computer.enabled, (ids) => ids.forEach((id) => stopConversation(id)), undefined, {
    peer: { stoppedAt: () => browser.activity(1).stoppedAt, stop: () => browser.stop() },
  });
  const speakers = new Speakers(join(paths.engines, "speakers"), downloads);
  const sd = buildSdEngine(paths, downloads, config);
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
  if (features.plugins) await plugins.loadAll([paths.plugins, ...(options.pluginRoots ?? [])], config.pluginDevFolders);

  const autodetected = await addProviders(registry, config, options.autodetect ?? features.autodetectLocalServers);

  const library = new Library(paths.library, () => config.syncFolder);
  try {
    const pulled = await library.importFromSync();
    if (pulled) console.log(`[library] imported ${pulled} file(s) from the sync folder`);
  } catch (err) {
    console.warn(`[library] sync folder unavailable: ${(err as Error).message}`);
  }
  await library.load();

  // When each model was last loaded (PC Health's "Fix it for me": models nobody used for 30 days).
  const modelUse = new ModelUse(join(paths.root, "model-use.json"));
  const engine = buildLlamaEngine(paths, config, modelUse);
  downloads.limit = config.downloadLimitMBps * 1024 * 1024;
  const assets = new AssetStore(paths.assets);
  // MCP servers (Notion, GitHub, Linear, Unity, …): their tools join every chat and agent.
  const persistEarly = () => saveConfig(paths, config);
  const github = new GitHubAuth(config.github, persistEarly, options.githubClientId ?? process.env.KESHER_GITHUB_CLIENT_ID ?? (branding.github.clientId || undefined));
  const runtimes = new Runtimes(join(paths.engines, "runtimes"), downloads);
  const mcp = new McpManager(join(paths.root, "mcp.json"), join(paths.root, "mcp-auth.json"), (cfg) => (cfg.preset === "github" || /api\.githubcopilot\.com/.test(cfg.url ?? "") ? github.token() : undefined), (env) => runtimes.env(env));
  void mcp.load();
  const journal = buildJournal(paths, config, registry, options.screen);
  // Study (students): courses, lectures, flashcards and quizzes, with the active chat model.
  const lipSync = new LipSync(
    join(paths.engines, "lipsync"),
    () => [options.lipsyncScript, join(process.cwd(), "tools", "lipsync", "kesher_lipsync.py")].find((f) => f && existsSync(f)),
    join(paths.root, "study", "avatar", "clip.webm"),
    async () => Math.max(0, ...(await nvidiaGpus()).map((g) => g.vramTotal / 1024 ** 3)),
  );
  let studyRunning = 0;
  // A course's own model (Roee, 2026-11-16: a Hebrew model for study, chosen per course; "auto" = the best Hebrew model
  // on this computer). Loaded in the engine when nothing else uses it, and the earlier model put back after.
  const studySwitch = new StudyModelSwitch({
    loaded: () => engine.status().modelPath,
    load: async (path) => {
      engine.note(`loading ${path.split(/[\\/]/).pop()} (a course's model)`);
      guard.touch("llamacpp");
      await engine.load(path);
      guard.touch("llamacpp");
      services.registerEngineProvider();
    },
    busy: async () => {
      if (chatsBusy()) return "chat";
      // Self-work's state is the worker's (asked like "install when free" asks it).
      const run = (await localCall<{ run?: { status?: string } | null }>(config.port, "GET", "/api/self-work").catch(() => ({ json: { run: null } }))).json.run;
      return run?.status === "running" ? "self-work" : undefined;
    },
  });
  let ggufs: { at: number; list: Array<{ path: string; name: string; size: number }> } | undefined;
  const localGgufs = async () => {
    if (ggufs && Date.now() - ggufs.at < 300_000) return ggufs.list;
    const own = await scanFolder({ folder: join(paths.models, "chat"), source: "KesherAI" }).catch(() => []);
    const others = (await scanComputer(config.modelFolders).catch(() => [])).flatMap((f) => f.models);
    // One entry per model: projector files and the later parts of a split model (-00002-of-00004…) are left out.
    ggufs = { at: Date.now(), list: [...own, ...others].filter((m) => m.format === "gguf" && !/mmproj/i.test(m.name) && Number(/-(\d+)-of-\d+\.gguf$/i.exec(m.name)?.[1] ?? 1) === 1) };
    return ggufs.list;
  };
  /** The course's model file: "auto" → the largest DictaLM (Dicta's Hebrew models), else the named llamacpp model. */
  const courseFile = async (modelId: string | undefined): Promise<string | undefined> => {
    const list = await localGgufs();
    if (!modelId) return list.filter((m) => /dictalm/i.test(m.name)).sort((a, b) => b.size - a.size)[0]?.path;
    const name = modelId.slice(modelId.indexOf("/") + 1);
    return list.find((m) => m.name.replace(/\.gguf$/i, "").replace(/[\s/]+/g, "-") === name)?.path;
  };
  const study = new Study(join(paths.root, "study"), (modelId) => {
    const active = config.activeModels.chat;
    // A cloud or other provider's model chosen for the course: used as it is.
    const own = !modelId || modelId.startsWith("llamacpp/");
    const id = own ? active : modelId;
    if (!id) return undefined;
    try {
      registry.resolve(id);
    } catch {
      return undefined;
    }
    const counted = <T,>(work: () => Promise<T>) => (async () => { studyRunning++; try { return await work(); } finally { studyRunning--; } })();
    if (!own) {
      const turn = modelTurnFor(registry, id);
      return { id, turn: ((...args: Parameters<typeof turn>) => counted(() => turn(...args))) as typeof turn };
    }
    // The course's local model (or the best Hebrew one): loaded when free; without one, the active chat model.
    const turn: ReturnType<typeof modelTurnFor> = async (req, signal, onText) =>
      counted(async () => {
        const file = active?.startsWith("llamacpp/") ? await courseFile(modelId) : undefined;
        if (!file) return modelTurnFor(registry, id)(req, signal, onText);
        return studySwitch.use(file, () => modelTurnFor(registry, "llamacpp/" + (file.split(/[\\/]/).pop() ?? "").replace(/\.gguf$/i, ""))(req, signal, onText), signal);
      });
    return { id, turn };
  });
  study.modelState = async () => {
    const list = await localGgufs();
    const hebrew = (await courseFile(undefined))?.split(/[\\/]/).pop();
    return { ...studySwitch.status(), ...(hebrew ? { hebrew } : {}), models: list.map((m) => `llamacpp/${m.name.replace(/\.gguf$/i, "").replace(/[\s/]+/g, "-")}`) };
  };
  study.switchNow = () => studySwitch.now();
  // Photos (a board, a schedule) need a model that sees pictures: the loaded one when it has its vision file, else the
  // smallest local model over 4 GB (and under 24 GB) that has one (found on the PC: the active Hebrew model has none, so photos
  // came back empty). Loaded when free, like a course's model; none found → the active chat model.
  study.visionModel = () => {
    const active = config.activeModels.chat;
    if (!active?.startsWith("llamacpp/")) return undefined;
    const pick = async () => {
      const st = engine.status();
      if (st.running && st.modelPath && (await findMmproj(st.modelPath))) return st.modelPath;
      // The smallest that is not tiny: a 12B loads in seconds where a 31B took ten minutes on the PC.
      for (const m of (await localGgufs()).filter((x) => x.size > 4 * 1024 ** 3 && x.size < 24 * 1024 ** 3).sort((a, b) => a.size - b.size)) if (await findMmproj(m.path)) return m.path;
      return undefined;
    };
    const turn: ReturnType<typeof modelTurnFor> = async (req, signal, onText) => {
      const file = await pick();
      if (!file) return modelTurnFor(registry, active)(req, signal, onText);
      return studySwitch.use(file, () => modelTurnFor(registry, "llamacpp/" + (file.split(/[\\/]/).pop() ?? "").replace(/\.gguf$/i, ""))(req, signal, onText), signal);
    };
    return { id: active, turn };
  };
  // Kept lecture recordings whose time has come are deleted (Settings → Study): soon after start, then daily.
  const cleanRec = () => void study.cleanRecordings().catch(() => undefined);
  setTimeout(cleanRec, 120_000).unref?.();
  setInterval(cleanRec, 24 * 3600_000).unref?.();
  // Knowledge bases: the user's folders and web pages, searchable by the models, with sources.
  // Search by meaning: an embedding model (KesherAI's own in a second llama.cpp server, or one the user made active).
  // Assigned below, once the engine exists; the knowledge bases ask for it when they search.
  // eslint-disable-next-line prefer-const
  let semantic: Semantic | undefined;
  // Set once the chats exist (below); until then nothing is answering.
  let chatsBusy: () => boolean = () => false;
  // Pictures in a knowledge folder: described by the chat model when it is local and sees pictures (its mmproj file),
  // never sent to a cloud model; they wait while a chat is working.
  const knowledge = new Knowledge(join(paths.root, "knowledge"), () => semantic?.embedder(), {
    describe: async () => {
      const st = engine.status();
      const chat = config.activeModels.chat ?? "";
      if (!st.running || !st.modelPath || !chat.startsWith("llamacpp/") || !(await findMmproj(st.modelPath))) return undefined;
      const turn = modelTurnFor(registry, chat);
      return async (data, mime) =>
        (
          await turn(
            { messages: [{ role: "user", content: "Describe this picture so it can be found by searching later: what it shows, any text in it (word for word), people, objects, the place, and its kind (photo, screenshot, diagram, receipt…). Plain sentences, at most 120 words.", images: [{ mimeType: mime, data: data.toString("base64") }] }], tools: [] },
            AbortSignal.timeout(180_000),
            () => undefined,
          )
        ).text;
    },
    busy: () => chatsBusy(),
  });
  void knowledge.load();
  // The library store: documentation downloaded once, searched offline as knowledge bases. Unreal's API comes
  // from the installed engine's own headers (the UObject classes and Core), with no download.
  const libraries = new Libraries(join(paths.root, "libraries"), knowledge, async () => {
    const e = (await findEngines())[0];
    if (!e) return undefined;
    const src = join(e.path, "Engine", "Source", "Runtime");
    return [join(src, "Engine", "Classes"), join(src, "CoreUObject", "Public", "UObject"), join(src, "InputCore", "Classes"), join(src, "UMG", "Public")];
  });
  const { personas, skills } = openPersonasAndSkills(paths);
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
  // Tor for blocked pages: downloaded only when the user presses Install, started only when a page does not open.
  const tor = new Tor(join(paths.engines, "tor"));
  const faults = new FaultLog(join(paths.root, "logs", "faults.jsonl"));
  const guard = new GpuGuard(
    () => config.guard,
    undefined,
    (text) => void notifier.send({ title: "Graphics card", body: text, path: "#/settings/computer", tags: ["thermometer"] }).catch(() => undefined),
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
  const { tunnel } = buildTunnel(paths, downloads, config, persist);
  const whisper = new WhisperEngine(join(paths.engines, "whisper"), () => paths.models, downloads, async () => {
    const nv = await nvidiaGpus();
    return { nvidia: nv.length > 0, ...(nv[0] ? { vramGb: nv[0].vramTotal / 1024 ** 3 } : {}) };
  });
  whisper.language = () => config.speech.language ?? "auto";
  whisper.keepFitting();
  const updater = new Updater(undefined, options.updates ? { ...options.updates, feedDir: join(paths.root, "update-feed") } : undefined, join(paths.root, "logs"));
  if (!config.notifications.ntfy.topic) {
    config.notifications.ntfy.topic = Notifier.newTopic();
    void persist().catch(() => undefined);
  }
  // The phone app's own notifications (live connection, or UnifiedPush through ntfy).
  const phonePush = new PhonePush(() => config.remote.devices, persist);
  const notifier = buildNotifier({ config, phonePush, ...(options.notify ? { desktop: options.notify } : {}), tunnel, chats: () => services.conversations, worker, paths });
  // A lecture from the phone that the computer summarized by itself: "the lecture is ready" on the phone.
  study.onLectureReady = (course, lecture) => {
    const he = /[\u0590-\u05ff]/.test(`${course.name} ${lecture.title}`);
    void notifier.send({ title: he ? `ההרצאה מוכנה: ${lecture.title}` : `Lecture ready: ${lecture.title}`, body: he ? `${course.name}: סיכום, מונחים ותרשים מחכים לך.` : `${course.name}: the summary, terms and diagram are waiting.`, path: `#/study/${course.id}/l/${lecture.id}`, tags: ["books"] }).catch(() => undefined);
  };
  downloads.on("update", (job: { id: string; label: string; status: string; error?: string }) => {
    notifier.onDownload(job);
    // "When a download finishes" routines (once, when it is done).
    if (job.status === "done") {
      try {
        routines.onDownload(job.label);
      } catch {
        // KesherAI is still starting (the routines come a moment later)
      }
    }
  });
  watchDisk(paths, notifier);
  // Telegram: the user's own bot; each paired chat has its own conversation (telegram.ts).
  const telegram = buildTelegram({ config, persist, chats: () => services.conversations, assets, notifier, registry, library, whisper });
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
  // Updates without GitHub: my other computers that are online, and pass on the installer they have.
  updater.setPeers(() => devices.peers().filter((p) => p.online && p.urls[0]).map((p) => ({ name: p.name, url: p.urls[0]!, token: p.token })));
  // Pipelines: chains of model calls and tools, with conditions and loops.
  const pipelines = buildPipelines({ paths, config, registry, personas, knowledge, whisper, notifier });
  const comfy = buildComfy({ paths, downloads, runtimes, config, registry });
  // After Terminate (see routes/system.ts) this start stays light: no ComfyUI, no model, until asked.
  const terminatedFile = join(paths.root, TERMINATED_FILE);
  const afterTerminate = existsSync(terminatedFile) && Date.now() - statSync(terminatedFile).mtimeMs < 10 * 60_000;
  if (existsSync(terminatedFile)) rmSync(terminatedFile, { force: true });
  if (config.comfyui.autoStart && config.parts.nodes !== false && !afterTerminate) void comfy.start().catch(() => undefined);
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
  // The model's timers ("check the build in an hour") and its notifications (chat-timers.ts).
  // Canvases: an Excalidraw board each chat (or the Canvas page) shares with the model.
  const canvases = new CanvasStore(join(paths.root, "canvases"));
  const chatTimers = new ChatTimers(join(paths.root, "timers.json"), {
    send: (convId, text) => services.conversations.send(convId, text),
    exists: async (convId) => !!library.summary(convId),
  });
  void chatTimers.start();
  const routines = buildRoutines({ paths, pipelines, injectRef, chats: () => services.conversations, notifier, config, telegram, engine, othersBusy: () => guard.othersBusy() });
  void routines.start();
  const { unityCli, unrealBridge, gameCheckpoints } = buildGameEngines(paths, config, persist);
  // The Godot editor's link (KesherAI Bridge addon); Godot editors are looked for once, for the chat's tools.
  const godot = new GodotBridge(paths.engines);
  void godot.findGodot().then((g) => (godot.installed = g.length > 0), () => undefined);
  // The task board self-work shares with Claude: a file on this computer only.
  const sharedDir = join(worker ? worker.mainRoot : paths.root, "self-work");
  const taskBoard = new TaskBoard(join(sharedDir, "board.json"));
  const projectFacts = new ProjectFacts(join(paths.root, "project-facts.json"));
  // Helpers in the chat (chat-helpers.ts) on this computer's engine: a small model beside the main one, or a build's
  // one swap and back. A self-work worker shares the main app's engine, so it never loads or swaps there.
  const besideEngine = () => sideEngineOf(registry, () => new SideEngine({ dir: paths.engines, binary: () => engine.status().binaryPath, ...(config.engines.llamaVersion ? { version: config.engines.llamaVersion } : {}), args: config.engines.llamaServerArgs, registry }));
  const helperEngine: HelperEngine | undefined = worker
    ? undefined
    : {
        loaded: () => {
          const st = engine.status();
          return { running: st.running, ...(st.modelPath ? { path: st.modelPath } : {}) };
        },
        vramGiB: async () => {
          const { detectHardwareCached } = await import("@kesher/downloads");
          const hw = await detectHardwareCached();
          return Math.max(0, ...hw.gpus.map((g) => g.vramTotal / 1024 ** 3));
        },
        localModels: async () => (await localGgufs()).map((m) => ({ path: m.path, name: m.name, sizeGiB: m.size / 1024 ** 3 })),
        loadMain: (path, why) => loadModel(services, path, undefined, why),
        loadBeside: (path) => besideEngine().load(path),
        beside: () => {
          const st = besideEngine().status();
          return { ...(st.running && st.modelPath ? { path: st.modelPath } : {}), ...(st.running && st.modelId ? { modelId: st.modelId } : {}) };
        },
      };
  const services: KesherServices = {
    localModels: localGgufs,
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
    conversations: buildConversations({ taskBoard, registry, library, assets, plugins, config, paths, personas, skills, projectFacts, engine, browser, tor, faults, updater, guard, sd, notifier, telegram, downloads, computer, google, knowledge, whisper, mcp, unityCli, unrealBridge, gameCheckpoints, godot, comfy, coach, memory, canvases, chatTimers, worker, persist, mainSlot: () => mainSlot, ...(helperEngine ? { helperEngine } : {}) }),
    coach,
    memory,
    computer,
    mcp,
    speeds,
    runtimes,
    github,
    journal,
    study,
    studyBusy: () => studyRunning,
    lipSync,
    ...(options.virtualCamera ? { virtualCamera: options.virtualCamera } : {}),
    ...(options.screen ? { screen: options.screen } : {}),
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
    phonePush,
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
    tor,
    faults,
    copilot,
    business,
    businessManaged: () => !!managedPolicy(paths.root),
    applyBusiness: () => {
      applyBusiness();
      telegram.restart();
    },
    unreal: unrealBridge,
    godot,
    unity: unityCli,
    gameCheckpoints,
    sd,
    tunnel,
    devices,
    autodetected,
    saveConfig: persist,
    registerEngineProvider: () => {
      if (!registry.get("llamacpp")) {
        registry.add({ id: "llamacpp", type: "openai-compatible", name: "KesherAI engine (llama.cpp)", location: "local", baseUrl: engine.baseUrl, apiKey: engine.apiKey, options: { llamaCpp: { slots: () => engine.slots(), parallelChats: () => engine.parallelChats() } } });
      }
    },
  };
  chatsBusy = () => Object.values(services.conversations.activity()).includes("running");
  stopConversation = (id) => services.conversations.stop(id);
  // Self-work: KesherAI works on a git project by itself, on its own branch, item by item.
  const { selfWork, upgrade: workerUpgrade } = buildSelfWork({ paths, chats: () => services.conversations, notifier, worker, sharedDir });
  services.selfWork = selfWork;
  services.modelUse = modelUse;
  services.worker = worker && workerUpgrade ? { version: worker.version, upgrade: workerUpgrade } : undefined;
  services.workerHost = options.workerHost;
  services.board = taskBoard;
  // The task inbox: Claude's tasks from the kesher-inbox branch; Antigravity runs only on the user's own Run.
  const taskInbox = buildTaskInbox({ config, root: paths.root, board: taskBoard, notifier, guard });
  services.taskInbox = taskInbox;
  // The chat's @antigravity agent asks the same "Run this in Antigravity?" before each message it sends.
  services.conversations.helpers.askAntigravity = (info) => taskInbox.askMessage(info);
  // Live agent activity for the hub page and the phone's Cloud tab (agent-activity.ts): off until the PC's opt-in.
  const hubRef: { client?: HubClient } = {};
  const activity = new AgentActivity({
    send: (batches) => void hubRef.client?.sendActivity(batches).catch(() => undefined),
    enabled: () => config.hub.enabled && config.hub.optIn.reportActivity,
    fileNames: () => config.hub.optIn.reportFileNames,
  });
  const helperRuns = services.conversations.helpers.runs;
  // The owner's names and notes for agent runs (agent-labels.ts): this PC keeps them; every screen and device shows them.
  const agentLabels = new AgentLabels(join(paths.root, "agent-labels.json"));
  await agentLabels.load();
  services.agentLabels = agentLabels;
  helperRuns.labelOf = (id) => agentLabels.get(id);
  /** An inbox run's snapshot with the owner's label. */
  const labelled = (snap: RunSnapshot): RunSnapshot => {
    const l = agentLabels.get(snap.runId);
    return l ? { ...snap, ...(l.name ? { name: l.name } : {}), ...(l.note ? { note: l.note } : {}), ...(l.at ? { labelAt: l.at } : {}) } : snap;
  };
  // A new name or note: the chat's cards update, and the run's state goes again to the phones and to Google Drive.
  agentLabels.on("change", (runId: string) => {
    const h = helperRuns.get(runId);
    if (h) {
      helperRuns.touch(runId);
      const snap = helperSnapshot(h, INBOX_ASKS);
      activity.relabel(snap);
      services.tasksSync?.observeAgent(snap, undefined, true);
      return;
    }
    void taskInbox.list().then((tasks) => {
      const t = tasks.find((x) => inboxRunId(x.id) === runId);
      const snap = t && inboxSnapshot(t, t.runAsk, INBOX_ASKS);
      if (!t || !snap) return;
      activity.relabel(labelled(snap));
      services.tasksSync?.observeAgent(labelled(snap), t.summary, true);
    }, () => undefined);
  });
  // "Who does it": the same steps from the app's routes and from the hub (task-assign.ts).
  const assignDeps: AssignDeps = {
    task: (id) => taskInbox.task(id).catch(() => undefined),
    fromDrive: async (id) => services.tasksSync?.inboxIdOf(id),
    workItem: async (id) => {
      const text = await taskInbox.workList().catch(() => undefined);
      const item = text === undefined ? undefined : parseWorkList(text).find((i) => i.id === id);
      return item && { title: item.title, text: item.text };
    },
    stop: (id) => taskInbox.stop(id),
    reassign: (id, to, again) => taskInbox.reassign(id, to, { again }),
    add: (input) => taskInbox.add(input),
    toChat: async (role, title, text) => {
      const repo = config.taskInbox.repo;
      if (!repo) throw new Error("Pick the git project for the task inbox in Settings > Task inbox first.");
      const chatTitle = `${role === "build" ? "🛠️" : role === "research" ? "📚" : "🔎"} ${title}`.slice(0, 120);
      const chat = await services.conversations.create({ kind: "code", workspace: repo, title: chatTitle });
      void services.conversations.send(chat.id, helperHandoff(role, title, text)).catch(() => undefined);
      return chatTitle;
    },
    movedOut: (id, where) => taskInbox.movedOut(id, where),
  };
  services.assignTask = (taskId, to, confirm) => assignTask(assignDeps, taskId, to, confirm);
  // A chat's helper that ended in the background or waits for an answer: on this computer and the phone (notify.ts).
  const chatTitle = (id: string) => library.summary(id)?.title ?? "KesherAI";
  helperRuns.on("end", (r: HelperRunInfo & { chatId: string }) => notifier.onHelperEnd(r, chatTitle(r.chatId)));
  helperRuns.on("ask", (r: HelperRunInfo & { chatId: string }) => notifier.onHelperAsk(r, chatTitle(r.chatId)));
  helperRuns.on("answered", (r: HelperRunInfo & { chatId: string }) => notifier.onHelperAnswered(r));
  helperRuns.on("change", (chatId: string) => {
    for (const r of helperRuns.list(chatId)) {
      const snap = helperSnapshot(r, INBOX_ASKS);
      activity.observe(snap, async () => helperRuns.stop(r.id));
      // Its last state also goes to the user's Google Drive, for "last seen" while this PC is off (tasks-sync.ts).
      services.tasksSync?.observeAgent(snap);
    }
  });
  taskInbox.onChange(() => {
    // The hub page's Tasks list follows the inbox too (metadata, sealed to the phones; hub-client.ts).
    void hubRef.client?.reportInbox().catch(() => undefined);
    void taskInbox.list().then((tasks) => {
      for (const t of tasks) {
        const found = inboxSnapshot(t, t.runAsk, INBOX_ASKS);
        if (!found) continue;
        const snap = labelled(found);
        activity.observe(snap, () => taskInbox.stop(t.id));
        services.tasksSync?.observeAgent(snap, t.summary);
      }
    }, () => undefined);
  });
  // Kesher Cloud hub: off until the user turns it on; tasks from it land on this board (hub-client.ts).
  const hub = new HubClient({
    activity,
    settings: () => config.hub,
    persist,
    board: taskBoard,
    inbox: (t, boardId) => taskInbox.fromHub(t, boardId),
    inboxTasks: () => taskInbox.list(),
    // Run / Cancel pressed on the owner's phone or hub page (hub-client.ts checks the sender; hub-commands.ts).
    inboxCommand: (action, taskId, from) =>
      inboxCommand(
        {
          ids: async () => (await taskInbox.list()).map((t) => t.id),
          fromDrive: async (id) => services.tasksSync?.inboxIdOf(id),
          run: (id, by) => taskInbox.run(id, { approvedBy: by }),
          running: async (id) => ["running", "needs-approval"].includes((await taskInbox.task(id)).status),
          stop: (id) => taskInbox.stop(id),
          skip: (id) => taskInbox.skip(id),
        },
        action,
        taskId,
        from,
      ),
    // "Who does it" for a task or a work-list item, from the owner's phone or hub page (task-assign.ts).
    assign: (taskId, to, confirm) => assignTask(assignDeps, taskId, to, confirm),
    // A name and note for an agent, from the owner's phone or hub page (hub-commands.ts).
    agentLabel: (runId, label) =>
      agentLabelCommand(
        {
          known: async (id) => !!helperRuns.get(id) || (await taskInbox.list()).some((t) => inboxRunId(t.id) === id),
          set: (id, l) => agentLabels.set(id, l),
        },
        runId,
        label,
      ),
    version: CORE_VERSION,
    notify: (title, body) => void notifier.send({ title, body, path: "#/settings", tags: ["inbox_tray"] }).catch(() => undefined),
    busy: () => services.selfWork?.current?.status === "running",
    // Another device wrote to the user's Google Drive: pull now (tasks-sync.ts).
    onSync: () => services.tasksSync?.onPing(),
    approvals: {
      pending: () => [
        // A chat's own steps and its sub-agents' steps (`helper` names who asks; the hub page shows it as "who").
        ...services.conversations.pendingApprovals().map((a) => {
          const helper = a.helper;
          return { conversationId: a.conversationId, requestId: a.requestId, title: helper ? `${helper} (sub-agent) · ${a.title}`.slice(0, 200) : a.title, tool: a.tool, preview: a.preview, reason: a.purpose ? `${a.reason} ${a.purpose}`.trim() : a.reason, ...(helper ? { who: helper } : {}), forWhile: !isDangerousReason(a.reason), at: a.at };
        }),
        // The PC's "Run this task in Antigravity?" asks, so the phone can answer away from home.
        ...taskInbox.openAsks().map(({ title, text, where, ask }) => ({ conversationId: INBOX_ASKS, requestId: ask.requestId, title: `Run in Antigravity? ${title}`.slice(0, 200), tool: "antigravity", preview: [text.slice(0, 1200), "", `Project: ${config.taskInbox.repo ? basename(config.taskInbox.repo) : "?"} · ${where} · Left today: ${ask.left}`].join("\n"), reason: "One tap runs this once. The ask expires in 30 minutes.", who: "Antigravity", kind: "run" as const, at: new Date(ask.at).toISOString() })),
      ],
      answer: async (conversationId, requestId, decision, from, forMinutes) => {
        // An agent card's yes/no (a helper's ask) or an Antigravity step's approval: only from a paired phone.
        if (conversationId === HELPER_ASKS) return from?.kind === "phone" && helperRuns.answer(requestId, decision === "allow");
        if (conversationId === INBOX_APPROVALS) {
          if (from?.kind !== "phone") return false;
          const t = (await taskInbox.list()).find((x) => x.pending?.requestId === requestId);
          return !!t && (await taskInbox.answer(t.id, requestId, decision));
        }
        // A run answer counts only from a paired phone (its sealed, signed message); one answer is one task.
        if (conversationId === INBOX_ASKS) {
          if (from?.kind !== "phone") return false;
          if (await taskInbox.answerMessage(requestId, decision, `hub:${from.id}`)) return true;
          return !!(await taskInbox.answerRun(requestId, decision, `hub:${from.id}`).catch(() => undefined));
        }
        // A chat's step: as its own card answers it ("Allow for a while" keeps a timed rule for the chat's tool).
        return answerFromHub(
          {
            find: async (convId, reqId) => {
              const session = (await services.conversations.open(convId))?.session;
              const ev = session?.events.find((e) => e.type === "approval_request" && e.requestId === reqId);
              if (!session || !ev || ev.type !== "approval_request") return undefined;
              return { request: { name: ev.name, reason: ev.reason, ...(ev.scope ? { scope: ev.scope } : {}), ...(ev.helper ? { helper: ev.helper } : {}) }, approve: (d) => session.approve(reqId, d) };
            },
            config: () => config,
            saveConfig: persist,
          },
          conversationId,
          requestId,
          decision,
          forMinutes,
        );
      },
    },
  });
  services.hub = hub;
  hubRef.client = hub;
  // Tasks on all your devices: the inbox's tasks as sealed records in the user's Google Drive (off until turned on).
  services.tasksSync = new TasksSync({
    settings: () => config.tasksSync,
    setEnabled: async (on) => {
      config.tasksSync.enabled = on;
      await persist();
    },
    setWorkList: async (on) => {
      config.tasksSync.workList = on;
      await persist();
    },
    google,
    inbox: taskInbox,
    file: join(paths.root, "tasks-sync.json"),
    log: (m) => console.warn(`[tasks-sync] ${m}`),
    // The other devices pull at once instead of at their next timer (a bare ping through the hub).
    onWrote: () => hub.pingSync(),
  });

  // 25 MB for a request (model APIs with pictures); the few routes that take more say so themselves.
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 25 * 1024 * 1024 });
  // Server errors go into the fault log (the route and the message; never the request's body).
  app.addHook("onError", async (req, _reply, err) => {
    // Only real failures: an answer like "not set up yet" (a 4xx the page explains) is not a fault (audit 2026-11:
    // a Unity project without the Bridge package filled the log).
    if ((err.statusCode ?? 500) < 500) return;
    services.faults.add({ kind: "server", where: `${req.method} ${req.routeOptions?.url ?? req.url.split("?")[0]}`, message: err.message });
  });
  injectRef.app = app;
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
  await trainingRoutes(app, { training, chatTrainer, vramGb: async () => Math.max(0, ...(await nvidiaGpus()).map((g) => g.vramTotal / 1024 ** 3)) });
  // A voice of her own: Chatterbox Multilingual (Hebrew too), from a short clip, in its own Python (voice-clone.ts).
  // The most free memory on any card (the guard's last reading), for the engines that need room on it.
  // Read the card now (the guard reads every 15 s when idle: a model unloaded a moment ago still looked loaded).
  const freeGpu = async () => { await guard.check().catch(() => undefined); const cards = guard.status().cards; return cards.length ? Math.max(...cards.map((c) => c.memTotal - c.memUsed)) : undefined; };
  // uv (installed when first needed): the engines below each set up their own Python with it.
  const uvPath = async () => {
    await runtimes.install("uv");
    const dir = (await runtimes.paths()).find((p) => existsSync(join(p, process.platform === "win32" ? "uv.exe" : "uv")));
    if (!dir) throw new Error("uv was not found after installing it.");
    return join(dir, process.platform === "win32" ? "uv.exe" : "uv");
  };
  await voiceCloneRoutes(app, new VoiceCloner(join(paths.engines, "chatterbox"), uvPath), services.assets);
  // Splitting a 3D model into parts by meaning: P3-SAM in its own Python (part-seg.ts), set up when she asks for it.
  await partSegRoutes(app, new PartSegmenter(join(paths.engines, "p3sam"), uvPath, freeGpu));
  // Removing a picture's background (the image editor): rembg + BiRefNet in its own Python (bg-remove.ts).
  await bgRemoveRoutes(app, new BgRemover(join(paths.engines, "rembg"), uvPath, freeGpu));
  // Reset: settings back to default, or start over (both keep a backup), or install the latest version again.
  await resetRoutes(app, { root: paths.root, justReset: resetBackup, restartApp: options.restartApp, canReinstall: !!options.updates, reinstall: () => updater.reinstall() });
  const { accessLog, deviceKeys } = setupRemoteAccess(app, { paths, config, persist, notifier, apiKeys });
  services.deviceKeys = deviceKeys;
  // Paired devices (their own keys) and how the internet link lets them in: Settings → Phone.
  await remoteDeviceRoutes(app, services, deviceKeys, accessLog);
  await guestRoutes(app, services);

  // Every area's routes, in their order (after the key check for remote access, above).
  await registerRoutes(app, services, { paths, library, apiKeys, chatTimers, canvases, telegram });

  if (options.webDir && existsSync(options.webDir)) {
    await app.register(fastifyStatic, {
      root: options.webDir,
      // Our own cache headers (setHeaders) instead of the library's.
      cacheControl: false,
      // (@fastify/static 10 passes the reply here.)
      setHeaders: (reply: { header(name: string, value: string): unknown }, path: string) => {
        if (path.endsWith(".html")) {
          reply.header("content-security-policy", WEB_CSP);
          // After an update the page must load the new version's files (their names change), never a kept copy.
          reply.header("cache-control", "no-cache");
        } else if (/[\\/]assets[\\/]/.test(path)) reply.header("cache-control", "public, max-age=31536000, immutable");
      },
    });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/") || req.url.startsWith("/v1/")
        ? reply.code(404).send({ error: "Not found" })
        : reply.header("content-security-policy", WEB_CSP).header("cache-control", "no-cache").sendFile("index.html"),
    );
  }

  // Bring this computer's library up to date with Google Drive, in the background.
  if (google.connected) void driveSync.syncNow().catch(() => undefined);
  if (onedrive.connected) void onedriveSync.syncNow().catch(() => undefined);
  // Find the user's other computers (same Google account) and keep their connections in step.
  devices.start();

  // Protect the graphics card, close left-over engines, and bring back the last model (server/start-engines.ts).
  startEngines({ app, services, guard, engine, comfy, config, faults, registry, afterTerminate });

  let linkWatch: LinkWatch | undefined;
  let linkBeacon: LinkBeaconPoster | undefined;
  return {
    app,
    services,
    async listen() {
      const host = features.remote && config.remote.enabled ? "0.0.0.0" : "127.0.0.1";
      await app.listen({ port: config.port, host });
      // Kesher Cloud: a paired PC that was on connects again when the app starts (before 0.6.402 it waited for the
      // On switch, so the hub page showed it Off). The main app only, never a worker.
      if (!options.worker) hub.start();
      if (!options.worker) services.tasksSync?.start();
      // Helpers a restart stopped continue (and the ended ones show again); the main app only, never a worker.
      if (!options.worker) void services.conversations.helpers.resumeSaved().catch((err: Error) => console.warn(`[helpers] ${err.message}`));
      if (config.remote.anywhere) {
        services.tunnel.start(config.port).catch((err: Error) => console.warn(`[tunnel] ${err.message}`));
      }
      // A new "anywhere" address: the link goes to the user's Telegram bot and phone, so the phone is never left with an
      // old one (link-watch.ts). The main app only.
      if (!options.worker && features.remote) {
        linkWatch = new LinkWatch(join(paths.root, "anywhere-link.json"), () => (config.remote.anywhere ? services.tunnel.status().url : undefined), async (link, address) => {
          await services.notifier.send({ title: "A new link to your computer", body: `The internet address of KesherAI on this computer changed to ${address}. The full link (with the access key) was sent to your Telegram bot; or open the app and connect with the new address.`, tags: ["link"], priority: 4 }, true).catch(() => undefined);
          await telegram.broadcast(`🔗 KesherAI: the link to your computer changed. Open this on the phone to connect again (it holds the access key; keep it private):\n${link}`).catch(() => undefined);
        }, () => config.remote.token ?? "");
        void linkWatch.start();
        linkBeacon = new LinkBeaconPoster(
          () => (config.remote.anywhere && config.remote.linkBeacon ? services.tunnel.status().url : undefined),
          async () => [...config.remote.devices.filter((d) => !d.scope).map((d) => d.hash), ...(config.remote.token ? [await beaconSecret(config.remote.token)] : [])],
          () => hostname(),
        );
        linkBeacon.start();
      }
      return `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${config.port}`;
    },
    async close() {
      linkWatch?.stop();
      linkBeacon?.stop();
      // A restart (from the phone, or to install an update) keeps the tunnel, so its address stays the same.
      if (services.restarting) services.tunnel.detach();
      else services.tunnel.stop();
      mcp.close();
      devices.close();
      journal.close();
      knowledge.close();
      notifier.close();
      phonePush.close();
      telegram.stop();
      hub.stop();
      void comfy.stop();
      routines.close();
      void semantic?.stop();
      await services.conversations.closeAll();
      await app.close();
      await engine.stop();
      plugins.stopWatching();
      await plugins.deactivateAll();
    },
  };
}
