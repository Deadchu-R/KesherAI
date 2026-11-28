/**
 * Every area's routes (docs/ARCHITECTURE_REVIEW.md B7), registered in one place and in the order they always had:
 * system first, the pages last. The key check for remote access is set up before this (server.ts), so it covers them.
 */
import { bankRoutes } from "../routes/bank.js";
import { roomRoutes } from "../routes/rooms.js";
import { SceneRooms } from "../scene-rooms.js";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { features } from "@kesher/shared";
import type { ApiKeys } from "../api-keys.js";
import type { CanvasStore } from "../canvas.js";
import type { ChatTimers } from "../chat-timers.js";
import type { BackgroundCommands } from "../background-commands.js";
import type { DataPaths } from "../config.js";
import type { Library } from "../library.js";
import { Pages } from "../pages.js";
import { systemRoutes } from "../routes/system.js";
import type { KesherServices } from "../services.js";
import type { TelegramBridge } from "../telegram.js";
import { mcpServerRoutes } from "../routes/mcp-server.js";
import { phoneRoutes } from "../routes/phones.js";
import { anthropicRoutes } from "../routes/anthropic.js";
import { apiKeyRoutes } from "../routes/api-keys.js";
import { skillRoutes } from "../routes/skills.js";
import { libraryStoreRoutes } from "../routes/library-store.js";
import { comfyRoutes } from "../routes/comfy.js";
import { installableRoutes } from "../routes/installables.js";
import { pipelineRoutes } from "../routes/pipelines.js";
import { notificationRoutes } from "../routes/notifications.js";
import { inboxRoutes } from "../routes/inbox.js";
import { externalAgentRoutes } from "../routes/external-agents.js";
import { promptRoutes } from "../routes/prompts.js";
import { personaRoutes } from "../routes/personas.js";
import { civitaiRoutes } from "../routes/civitai.js";
import { knowledgeRoutes } from "../routes/knowledge.js";
import { librariesRoutes } from "../routes/libraries.js";
import { copilotRoutes } from "../routes/copilot.js";
import { unityRoutes, unrealRoutes } from "../routes/unreal.js";
import { godotRoutes } from "../routes/godot.js";
import { godotSceneRoutes } from "../routes/godot-scene.js";
import { unitySceneRoutes } from "../routes/unity-scene.js";
import { gamesRoutes } from "../routes/games.js";
import { nightBuildRoutes } from "../routes/night-builds.js";
import { unrealLevelRoutes } from "../routes/unreal-level.js";
import { stremioRoutes } from "../routes/stremio.js";
import { sshRoutes } from "../routes/ssh.js";
import { chatReportRoutes } from "../routes/chat-reports.js";
import { unrealSourceRoutes } from "../routes/unreal-source.js";
import { projectFactsRoutes } from "../routes/project-facts.js";
import { gitRoutes } from "../routes/git.js";
import { lspRoutes } from "../routes/lsp.js";
import { codeRoutes } from "../routes/code.js";
import { spanEditRoutes } from "../routes/span-edit.js";
import { voiceRoutes } from "../routes/voice.js";
import { privacyRoutes } from "../routes/privacy.js";
import { guardRoutes } from "../routes/guard.js";
import { lightProfileRoutes } from "../routes/light-profile.js";
import { cpuPoolRoutes } from "../routes/cpu-pool.js";
import { translateRoutes } from "../routes/translate.js";
import { selfWorkRoutes } from "../routes/self-work.js";
import { memoryRoutes } from "../routes/memory.js";
import { healthRoutes } from "../routes/health.js";
import { logRoutes } from "../routes/logs.js";
import { travelRoutes } from "../routes/travel.js";
import type { buildTravel } from "../travel/index.js";
import { webSearchCheckRoutes } from "../routes/web-search-check.js";
import { hfTokenRoutes } from "../routes/hf-token.js";
import { freeCloudRoutes } from "../routes/free-cloud.js";
import { storageRoutes } from "../routes/storage.js";
import { ideRoutes } from "../routes/ide.js";
import { torRoutes } from "../routes/tor.js";
import { remoteDesktopRoutes } from "../routes/remote-desktop.js";
import { browserRoutes } from "../routes/browser.js";
import { comfyUiRoutes } from "../routes/comfy-ui.js";
import { partsRoutes } from "../routes/parts.js";
import { telegramRoutes } from "../routes/telegram.js";
import { hubRoutes } from "../routes/hub.js";
import { pagesRoutes } from "../routes/pages.js";
import { pairRoutes } from "../routes/pair.js";
import { speechRoutes } from "../routes/speech.js";
import { computerRoutes } from "../routes/computer.js";
import { controlTaskRoutes } from "../routes/control-tasks.js";
import { visionRoutes } from "../routes/vision.js";
import { mcpRoutes } from "../routes/mcp.js";
import { journalRoutes } from "../routes/journal.js";
import { gameRoutes } from "../routes/game.js";
import { timerRoutes } from "../routes/timers.js";
import { backgroundRoutes } from "../routes/background.js";
import { chatCheckRoutes, conversationHost } from "../routes/chat-checks.js";
import { ChatChecks } from "../chat-checks/runner.js";
import { studyRoutes } from "../routes/study.js";
import { appLinkRoutes, focusRoomRoutes, liveQuizRoutes, projectRoutes } from "../routes/live-quiz.js";
import { moodleRoutes } from "../routes/moodle.js";
import { webImageRoutes } from "../routes/web-image.js";
import { studyPlanRoutes } from "../routes/study-plans.js";
import { ideasRoutes } from "../routes/ideas.js";
import { designRoutes } from "../routes/design.js";
import { deckRoutes } from "../routes/decks.js";
import { deckStoreFor } from "../decks.js";
import { docRoutes } from "../routes/docs.js";
import { docStoreFor } from "../docs.js";
import { sheetRoutes } from "../routes/sheets.js";
import { sheetStoreFor } from "../sheets.js";
import { importRoutes } from "../routes/imports.js";
import { lensRoutes } from "../routes/lens.js";
import { canvasRoutes } from "../routes/canvas.js";
import { shareRoutes } from "../routes/shares.js";
import { ShareStore } from "../shares.js";
import { sharedChatRoutes } from "../routes/shared-chat.js";
import { textHelperRoutes } from "../routes/text-helper.js";
import { githubRoutes } from "../routes/github.js";
import { deviceRoutes } from "../routes/devices.js";
import { coachRoutes } from "../routes/coach.js";
import { pluginRoutes } from "../routes/plugins.js";
import { shortcutRoutes } from "../routes/shortcuts.js";
import { modelRoutes } from "../routes/models.js";
import { generateRoutes } from "../routes/generate.js";
import { downloadRoutes } from "../routes/downloads.js";
import { openAIRoutes } from "../routes/openai.js";
import { libraryRoutes } from "../routes/library.js";
import { editorUploadRoutes } from "../routes/editor-upload.js";
import { helperRoutes } from "../routes/helpers.js";
import { resumeRoutes } from "../routes/resume.js";
import { taskInboxRoutes } from "../routes/task-inbox.js";
import { tasksSyncRoutes } from "../routes/tasks-sync.js";
import { fileRoutes } from "../routes/files.js";
import { mediaPrepRoutes } from "../routes/media-prep.js";
import { imageEditRoutes } from "../routes/image-edit.js";
import { terminalRoutes } from "../routes/terminal.js";
import websocket from "@fastify/websocket";
import { googleRoutes } from "../routes/google.js";
import { onedriveRoutes } from "../routes/onedrive.js";

/**
 * Registers the routes of every area, and starts Telegram once its routes are in.
 *
 * @param app - The server.
 * @param services - What the routes reach.
 * @param p - The data folders, the chats' library, the API keys, chat timers, canvases and Telegram (the few routes
 *   that take their own part instead of the services).
 */
export async function registerRoutes(app: FastifyInstance, services: KesherServices, p: { paths: DataPaths; library: Library; apiKeys: ApiKeys; chatTimers: ChatTimers; background: BackgroundCommands; canvases: CanvasStore; telegram: TelegramBridge; travel: ReturnType<typeof buildTravel> }): Promise<void> {
  const { paths, library, apiKeys, chatTimers, background, canvases, telegram, travel } = p;
  await systemRoutes(app, services);
  shortcutRoutes(app, services);
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
  await memoryRoutes(app, services);
  await healthRoutes(app, services);
  // The smart log reader (Logs page): sources, search, patterns, labels, Explain.
  logRoutes(app, services);
  await webSearchCheckRoutes(app, services);
  await travelRoutes(app, services, travel.watches, travel.service.rates);
  await hfTokenRoutes(app, services);
  await freeCloudRoutes(app, services);
  await storageRoutes(app, services);
  await ideRoutes(app);
  await torRoutes(app, services);
  await remoteDesktopRoutes(app, services);
  await pluginRoutes(app, services);
  await computerRoutes(app, services);
  await controlTaskRoutes(app, services);
  await visionRoutes(app, services);
  await speechRoutes(app, services);
  await mcpRoutes(app, services);
  await journalRoutes(app, services);
  await gameRoutes(app, services);
  await textHelperRoutes(app, services);
  await timerRoutes(app, chatTimers, (id) => library.summary(id)?.title);
  await backgroundRoutes(app, background);
  // Chat checks (Settings › For developers): "behaves like Claude" scenarios run here, in temporary chats.
  await chatCheckRoutes(app, new ChatChecks(conversationHost(services.conversations, chatTimers, () => services.config.activeModels.chat), join(paths.root, "chat-checks.json")));
  await studyRoutes(app, services);
  await liveQuizRoutes(app, services.study);
  await focusRoomRoutes(app);
  await appLinkRoutes(app);
  await projectRoutes(app, services.study);
  await moodleRoutes(app, services);
  await webImageRoutes(app);
  await studyPlanRoutes(app, services);
  await ideasRoutes(app, services);
  await designRoutes(app, services);
  await canvasRoutes(app, canvases, (convId) => library.summary(convId)?.title);
  await deckRoutes(app, deckStoreFor(join(paths.root, "decks")));
  {
    // The older "Pages" join the documents (one place for documents); their files stay.
    const docs = docStoreFor(join(paths.root, "docs"));
    await docs.importPages(join(paths.root, "pages")).catch(() => 0);
    await docRoutes(app, docs, services);
    // Real Word files: in, out and saved back (the libraries load on first use).
    const { docxRoutes } = await import("../routes/docx.js");
    const { docxRoots } = await import("../docx-service.js");
    await docxRoutes(app, { docs, assets: services.assets, roots: docxRoots }, async (id) => {
      const c = await services.library.getConversation(id);
      return c ? services.conversations.workspaceOf(c) : undefined;
    });
  }
  await sheetRoutes(app, sheetStoreFor(join(paths.root, "sheets")));
  await lensRoutes(app, services);
  await importRoutes(app, { docs: docStoreFor(join(paths.root, "docs")), decks: deckStoreFor(join(paths.root, "decks")), sheets: sheetStoreFor(join(paths.root, "sheets")) });
  // Share links: a chat as a read-only page at /s/<token> (never an incognito chat).
  const shares = new ShareStore(join(paths.root, "shares.json"));
  await shareRoutes(app, shares, async (convId) => {
    const summary = library.summary(convId);
    if (!summary || summary.incognito) return undefined;
    const opened = await services.conversations.open(convId);
    return opened ? { title: summary.title ?? "Chat", events: opened.session.events } : undefined;
  });
  // "Allow replies" on a shared chat: the project's guests write in it, under the owner's rules (shared-chat.ts).
  await sharedChatRoutes(app, services, shares);
  await knowledgeRoutes(app, services);
  await librariesRoutes(app, services);
  await personaRoutes(app, services);
  if (features.images && features.downloads) await civitaiRoutes(app, services);
  await promptRoutes(app, services);
  await skillRoutes(app, services);
  await libraryStoreRoutes(app, services);
  await pipelineRoutes(app, services);
  await comfyRoutes(app, services);
  await installableRoutes(app, services);
  await notificationRoutes(app, services);
  await inboxRoutes(app, services);
  await externalAgentRoutes(app, services);
  await mcpServerRoutes(app, services);
  await phoneRoutes(app, services);
  await githubRoutes(app, services);
  await deviceRoutes(app, services);
  await libraryRoutes(app, services);
  await editorUploadRoutes(app, async (id) => { const c = await services.library.getConversation(id); return c ? services.conversations.workspaceOf(c) : undefined; });
  await helperRoutes(app, services);
  await resumeRoutes(app, services);
  if (services.taskInbox) await taskInboxRoutes(app, services, services.taskInbox);
  if (services.tasksSync) await tasksSyncRoutes(app, services, services.tasksSync);
  await fileRoutes(app, services);
  await mediaPrepRoutes(app, services);
  await imageEditRoutes(app, services);
  await bankRoutes(app, services);
  await roomRoutes(app, (services.sceneRooms ??= new SceneRooms()));
  await googleRoutes(app, services);
  await onedriveRoutes(app, services);
  await guardRoutes(app, services);
  await lightProfileRoutes(app, services);
  await cpuPoolRoutes(app, services);
  await translateRoutes(app, services);
  await selfWorkRoutes(app, services);
  await unrealRoutes(app, services);
  await godotRoutes(app, services);
  // From the phone (remote), a scene's project must be one found on this computer (its engine's project list or the
  // usual folders): a folder typed by path is for this computer only (the stand-in's projects menu, 2026-11-18).
  {
    const { findGameProjects } = await import("../game-projects.js");
    const { isLocalRequest } = await import("../request-origin.js");
    const { resolve: resolvePath, dirname: dirOf } = await import("node:path");
    let cache: { at: number; paths: Set<string> } | undefined;
    const known = async () => {
      if (!cache || Date.now() - cache.at > 60_000) {
        const godotFile = services.godot.status().editor?.projectFile;
        const list = await findGameProjects({ unity: (await services.unity.status().catch(() => ({ projects: [] as string[] }))).projects, ...(godotFile ? { godot: [dirOf(godotFile)] } : {}) });
        cache = { at: Date.now(), paths: new Set(list.map((p) => p.path.toLowerCase())) };
      }
      return cache.paths;
    };
    app.addHook("preHandler", async (req, reply) => {
      if (!/^\/api\/(godot\/(scenes?|asset)|unity\/(scenes?|asset))(\?|$)/.test(req.url) || isLocalRequest(req)) return;
      const raw = String((req.query as { project?: unknown })?.project ?? (req.body as { project?: unknown } | undefined)?.project ?? "").replace(/[\\/]project\.godot$/i, "");
      if (!raw || !(await known()).has(resolvePath(raw).toLowerCase())) return reply.code(403).send({ error: "From the phone, choose one of the projects found on the computer." });
    });
  }
  // A Godot scene without Godot: read it, and write the moves made in KesherAI back into its .tscn.
  await godotSceneRoutes(app, services.godot, services.gameCheckpoints);
  await unitySceneRoutes(app, services.gameCheckpoints);
  await unrealLevelRoutes(app, services.unreal);
  // The editors' "Open from project": a found Unity/Unreal project's assets opened in the editors, saved back with approval.
  {
    const { findGameProjects } = await import("../game-projects.js");
    const { projectAssetRoutes } = await import("../routes/project-assets.js");
    const { dirname: dirOf } = await import("node:path");
    let found: { at: number; list: ReturnType<typeof findGameProjects> } | undefined;
    await projectAssetRoutes(app, {
      found: () => {
        if (!found || Date.now() - found.at > 30_000) {
          const godotFile = services.godot.status().editor?.projectFile;
          found = { at: Date.now(), list: findGameProjects({ unity: services.config.unity.projects, ...(services.unreal.projectFile ? { unrealFile: services.unreal.projectFile } : {}), ...(godotFile ? { godot: [dirOf(godotFile)] } : {}) }) };
          found.list.catch(() => { found = undefined; });
        }
        return found.list;
      },
      dataDir: services.paths.root,
      unreal: (projectFile, cmd, args) => services.unreal.assetCommand(cmd, args, projectFile),
      checkpoints: services.gameCheckpoints,
      notify: (title, body) => void services.notifier.send({ title, body, path: "#/games?saves=1", tags: ["floppy_disk"], computerOnly: true }).catch(() => undefined),
    });
  }
  // The Game projects home: every engine project, its waiting changes, sync and clashes.
  await gamesRoutes(app, services);
  // Night builds of the games with a morning scorecard (off by default, per project).
  await nightBuildRoutes(app, services);
  await stremioRoutes(app, services, apiKeys);
  await sshRoutes(app, services);
  await chatReportRoutes(app, services);
  unrealSourceRoutes(app, services);
  await projectFactsRoutes(app, services);
  await gitRoutes(app, services);
  lspRoutes(app, services);
  codeRoutes(app, services);
  spanEditRoutes(app, services);
  voiceRoutes(app, services);
  privacyRoutes(app, services);
  await unityRoutes(app, services);
  await copilotRoutes(app, services);
  await browserRoutes(app, services);
  await comfyUiRoutes(app, services);
  await partsRoutes(app, services);
  await telegramRoutes(app, telegram);
  telegram.start();
  if (services.hub) {
    await hubRoutes(app, services.hub);
    services.hub.start();
  }
  await pagesRoutes(app, services, new Pages(join(paths.root, "pages")));
  await pairRoutes(app, services);
}
