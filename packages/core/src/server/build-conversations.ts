/**
 * The conversation manager and everything a chat can reach (docs/ARCHITECTURE_REVIEW.md B4): the providers, the
 * library, tools from every part (browser, Google, knowledge, speech, Unity, Unreal, ComfyUI flows, the canvas,
 * timers, memory), and what a chat reports back (notifications, Telegram). Built once by createKesherServer from the
 * services made before it; the body is the same as when it stood in server.ts.
 */
import { aboutUserNote } from "../user-profile.js";
import { engineAsk } from "../tool-router.js";
import { ConversationManager } from "../conversations.js";
import { browserTools } from "../browser-bridge.js";
import { fabTools } from "../fab-tools.js";
import { canvasTools } from "../canvas.js";
import { deckStoreFor, deckTools } from "../decks.js";
import { docStoreFor, docTools } from "../docs.js";
import { versionNumber } from "../versions.js";
import { sheetStoreFor, sheetTools } from "../sheets.js";
import { timerTools } from "../chat-timers.js";
import { Checkpoints } from "../checkpoints.js";
import { flowState, folderNames, readyFlows, setupFlow, withCheckpoints } from "../comfy-flows.js";
import { redact } from "../fault-log.js";
import { ensureFfmpeg } from "../ffmpeg.js";
import { googleTools } from "../google-tools.js";
import { knowledgeTools } from "../knowledge.js";
import { appUri, mcpResultText } from "../mcp.js";
import { memoryTools } from "../memory-tools.js";
import { setAppearance } from "../routes/parts.js";
import { ensureImageModel, ensureVideoModel } from "../sdcpp.js";
import { readMedia, speechTools } from "../speech-tools.js";
import { SideEngine, sideEngineOf, translatorModelId } from "../side-engine.js";
import { type AgentTool } from "@kesher/agent";
import { ComfyUIProvider } from "@kesher/providers";
import { cleanAppearance } from "@kesher/shared";
import { existsSync } from "node:fs";
import { readFile as readFileFs } from "node:fs/promises";
import { join } from "node:path";
import type { AssetStore } from "../assets.js";
import type { HelperEngine } from "../chat-helpers.js";
import type { BrowserBridge } from "../browser-bridge.js";
import type { CanvasStore } from "../canvas.js";
import type { ChatTimers } from "../chat-timers.js";
import type { Coach } from "../coach.js";
import type { ComfyManager } from "../comfy-manager.js";
import type { ComputerControl } from "../computer.js";
import type { DataPaths, KesherConfig } from "../config.js";
import type { FaultLog } from "../fault-log.js";
import type { GoogleDrive } from "../google.js";
import type { GpuGuard } from "../gpu-guard.js";
import type { Knowledge } from "../knowledge.js";
import type { Library } from "../library.js";
import type { LlamaEngine } from "../llamacpp.js";
import type { McpManager } from "../mcp.js";
import type { MemoryStore } from "../memory-store.js";
import type { Notifier } from "../notify.js";
import type { Personas } from "../personas.js";
import type { PluginHost } from "../plugins.js";
import type { ProjectFacts } from "../project-facts.js";
import type { SdEngine } from "../sdcpp.js";
import type { SkillStore } from "../skill-store.js";
import type { TaskBoard } from "../task-board.js";
import type { TelegramBridge } from "../telegram.js";
import type { Tor } from "../tor.js";
import type { UnityCli } from "../unity-cli.js";
import type { UnrealBridge } from "../unreal-bridge.js";
import type { Updater } from "../updates.js";
import type { WhisperEngine } from "../whisper.js";
import type { DownloadManager } from "@kesher/downloads";
import type { ProviderRegistry } from "@kesher/providers";

/** The services the conversation manager is built from (all made earlier in createKesherServer). */
export interface ConversationParts {
  taskBoard: TaskBoard;
  registry: ProviderRegistry;
  library: Library;
  assets: AssetStore;
  plugins: PluginHost;
  config: KesherConfig;
  paths: DataPaths;
  personas: Personas;
  skills: SkillStore;
  projectFacts: ProjectFacts;
  engine: LlamaEngine;
  browser: BrowserBridge;
  tor: Tor;
  faults: FaultLog;
  updater: Updater;
  guard: GpuGuard;
  sd: SdEngine;
  notifier: Notifier;
  telegram: TelegramBridge;
  downloads: DownloadManager;
  computer: ComputerControl;
  google: GoogleDrive;
  knowledge: Knowledge;
  whisper: WhisperEngine;
  mcp: McpManager;
  unityCli: UnityCli;
  unrealBridge: UnrealBridge;
  godot: import("../godot-bridge.js").GodotBridge;
  comfy: ComfyManager;
  coach: Coach;
  memory: MemoryStore;
  canvases: CanvasStore;
  chatTimers: ChatTimers;
  /** The worker's link to the main app (a window-less KesherAI that runs self-work), if this is the worker. */
  worker: { mainUrl: string; mainRoot: string; version: string } | undefined;
  /** The main app's context share, as the worker last read it. */
  mainSlot: () => number | undefined;
  /** The engine as helpers need it (absent in a self-work worker). */
  helperEngine?: HelperEngine;
  /** Saves the settings. */
  persist: () => Promise<void>;
}

/**
 * @param p - The services.
 * @returns The conversation manager.
 */
export function buildConversations(p: ConversationParts): ConversationManager {
  const { taskBoard, registry, library, assets, plugins, config, paths, personas, skills, projectFacts, engine, browser, tor, faults, updater, guard, sd, notifier, telegram, downloads, computer, google, knowledge, whisper, mcp, unityCli, unrealBridge, godot, comfy, coach, memory, canvases, chatTimers, worker, mainSlot, persist, helperEngine } = p;
  return new ConversationManager({
    board: taskBoard,
    registry,
    library,
    assets,
    plugins,
    config,
    outputsDir: join(paths.root, "outputs"),
    checkpoints: new Checkpoints(join(paths.root, "checkpoints")),
    undoDir: join(paths.root, "undo"),
    personas,
    skills,
    projectFacts,
    // A self-work worker uses the main app's engine (main/llamacpp/…): its share comes from there.
    engineSlotTokens: () => (worker ? mainSlot() : engine.slotContext()),
    // Routing by meaning: a tiny call to the model the engine has loaded (never in a self-work worker: not its engine).
    routeAsk: () => (worker ? undefined : engineAsk({ baseUrl: () => engine.baseUrl, apiKey: engine.apiKey, ready: () => engine.status().running && !!engine.status().modelPath })),
    saveConfig: () => persist(),
    ...(helperEngine ? { helperEngine } : {}),
    browserPane: () => browser.status().pane,
    // "+" → a recording or a video: its speech as text and a few frames, before the model answers.
    ...(config.parts.voice === false ? {} : { readMedia: (path: string) => readMedia({ whisper, speech: () => config.speech, providers: () => config.providers, ffmpeg: () => ensureFfmpeg({ dir: paths.engines, downloads }) }, path) }),
    // The translator, when it is a GGUF file (Settings → Chats → Model team): loaded beside the main model.
    translatorModel: (pick: string) => translatorModelId(sideEngineOf(registry, () => new SideEngine({ dir: paths.engines, binary: () => engine.status().binaryPath, ...(config.engines.llamaVersion ? { version: config.engines.llamaVersion } : {}), args: config.engines.llamaServerArgs, registry })), pick),
    tor,
    faults,
    doctorState: async () => {
      const [listing, upd, torSt] = await Promise.all([registry.listAllModels().catch((e: Error) => ({ models: [], errors: [{ providerId: "all", message: e.message }] })), updater.version().catch(() => undefined), tor.status()]);
      const g = guard.status();
      return {
        version: upd?.version,
        platform: `${process.platform} ${process.arch}`,
        activeModels: config.activeModels,
        models: listing.models.length,
        providersNotAnswering: listing.errors,
        guard: { paused: g.paused, cooling: g.cooling, systemHold: g.systemHold, waiting: g.waiting, running: g.running, cards: g.cards.map((c) => `${c.name} ${c.temp}°C ${Math.round(c.memUsed / 2 ** 30)}/${Math.round(c.memTotal / 2 ** 30)} GB`), ramPercent: g.system.ramTotal ? Math.round((g.system.ramUsed / g.system.ramTotal) * 100) : undefined },
        tor: { installed: torSt.installed, running: torSt.running, ...(torSt.job ? { job: torSt.job } : {}) },
        // The image engine's last run (its command and the end of its output), for failed pictures.
        imageEngineLastRun: await readFileFs(sd.logFile, "utf8").then((t: string) => redact(t.split("\n").slice(-30).join("\n").slice(-1900)), () => undefined),
      };
    },
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
      ...(config.parts.browser === false ? [] : browserTools(browser, async (data, mimeType) => (await assets.save(data, mimeType)).id)),
      ...(config.parts.browser === false || !browser.status().pane ? [] : fabTools(browser)),
      ...(config.parts.voice === false ? [] : speechTools({ whisper, speech: () => config.speech, providers: () => config.providers, ffmpeg: () => ensureFfmpeg({ dir: paths.engines, downloads }) })),
      ...mcp.tools().map(({ server, tool, spec }): AgentTool => ({
        spec,
        // Tools that only read run without asking; the rest ask, like any command.
        risk: tool.annotations?.readOnlyHint && !tool.annotations.destructiveHint ? ("read" as const) : ("exec" as const),
        preview: async (input) => `${server.name} → ${tool.annotations?.title ?? tool.name}\n${JSON.stringify(input, null, 2)}`,
        run: async (input, ctx) => {
          const r = await mcp.call(server.id, tool.name, input, ctx.signal);
          const { text, images } = mcpResultText(r);
          if (r.isError) throw new Error(text);
          // An MCP App: its view shows under the result, given the input and the result (kept small in the chat).
          const uri = appUri(tool);
          const raw = uri ? JSON.stringify({ content: r.content ?? [], structuredContent: r.structuredContent }) : "";
          const app = uri && raw.length < 512 * 1024 ? { server: server.id, uri, input, result: JSON.parse(raw) as unknown } : undefined;
          return { output: text, ...(images.length ? { images } : {}), ...(app ? { app } : {}) };
        },
      })),
    ],
    // change_look: the chat changes how the app looks (the same as Settings → Appearance).
    unity: unityCli,
    unreal: unrealBridge,
    godot,
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
      run: async (id: string, edit: (flow: Record<string, { class_type: string; inputs: Record<string, unknown> }>, upload: (data: Uint8Array, name: string, subfolder?: string) => Promise<string>) => Promise<void> | void, signal: AbortSignal) => {
        if (!registry.permitted("comfyui")) throw new Error("ComfyUI is turned off by business mode.");
        const flow = readyFlows().find((f) => f.id === id)!;
        if (!comfy.status().running) {
          const up = await fetch(`${comfy.status().url}/system_stats`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
          if (!up) await comfy.start();
        }
        const list = (folder: string) => fetch(`${comfy.status().url}/models/${folder}`).then((r) => (r.ok ? (r.json() as Promise<string[]>) : []), () => [] as string[]);
        const graph = withCheckpoints(flow, await list("checkpoints"), await folderNames(flow, list));
        const provider = new ComfyUIProvider({ id: "comfyui-flows", type: "comfyui", name: "ComfyUI", baseUrl: comfy.status().url, location: "local" });
        await edit(graph, (data, name, subfolder) => provider.uploadImage(data, name, subfolder));
        await guard.before("comfyui", signal);
        try {
          return await provider.runFlow(graph, signal);
        } finally {
          guard.after();
          // A chat model is loaded too: ComfyUI gives the card back at once (found on the PC: after a song, both
          // shared 24 GB and the chat model answered in minutes, not seconds). The next song loads what it needs.
          if (engine.status().running) void fetch(`${comfy.status().url}/free`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ unload_models: true, free_memory: true }), signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
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
    aboutUser: () => aboutUserNote(config.user),
    userNotes: async () => (config.coach?.learn === false ? [] : (await coach.profile()).notes),
    memoryTools: (convId) => memoryTools(memory, () => (convId ? library.summary(convId) : undefined)),
    // None in an incognito chat: a timer is written to disk (scan 65).
    // The chat's canvas and its slide deck (design DeckEditor): none in an incognito chat.
    canvasTools: (convId) => (library.summary(convId)?.incognito ? [] : [...canvasTools(canvases, convId, () => library.summary(convId)?.title ?? ""), ...deckTools(deckStoreFor(join(paths.root, "decks")), convId, () => library.summary(convId)?.title ?? ""), ...docTools(docStoreFor(join(paths.root, "docs")), convId, () => library.summary(convId)?.title ?? ""), ...sheetTools(sheetStoreFor(join(paths.root, "sheets")), convId, () => library.summary(convId)?.title ?? "")]),
    // A deep research's report: a new document of the chat (none in an incognito chat).
    writeReport: async (convId, title, body) => {
      if (library.summary(convId)?.incognito) return undefined;
      const store = docStoreFor(join(paths.root, "docs"));
      const d = await store.create({ title, convId });
      const saved = await store.update(d.id, (x) => {
        x.body = body;
      }, true);
      return { id: saved.id, ver: versionNumber(saved) };
    },
    timerTools: (convId) => (library.summary(convId)?.incognito ? [] : timerTools(chatTimers, convId, (title, body) => notifier.send({ title, body, path: `#/c/${convId}`, tags: ["bell"] }).then(() => undefined))),
    memory,
  });
}
