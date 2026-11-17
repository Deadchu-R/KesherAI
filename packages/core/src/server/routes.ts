/**
 * Every area's routes (docs/ARCHITECTURE_REVIEW.md B7), registered in one place and in the order they always had:
 * system first, the pages last. The key check for remote access is set up before this (server.ts), so it covers them.
 */
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { features } from "@kesher/shared";
import type { ApiKeys } from "../api-keys.js";
import type { CanvasStore } from "../canvas.js";
import type { ChatTimers } from "../chat-timers.js";
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
import { pipelineRoutes } from "../routes/pipelines.js";
import { notificationRoutes } from "../routes/notifications.js";
import { inboxRoutes } from "../routes/inbox.js";
import { promptRoutes } from "../routes/prompts.js";
import { personaRoutes } from "../routes/personas.js";
import { civitaiRoutes } from "../routes/civitai.js";
import { knowledgeRoutes } from "../routes/knowledge.js";
import { librariesRoutes } from "../routes/libraries.js";
import { copilotRoutes } from "../routes/copilot.js";
import { unityRoutes, unrealRoutes } from "../routes/unreal.js";
import { godotRoutes } from "../routes/godot.js";
import { stremioRoutes } from "../routes/stremio.js";
import { sshRoutes } from "../routes/ssh.js";
import { chatReportRoutes } from "../routes/chat-reports.js";
import { unrealSourceRoutes } from "../routes/unreal-source.js";
import { projectFactsRoutes } from "../routes/project-facts.js";
import { gitRoutes } from "../routes/git.js";
import { lspRoutes } from "../routes/lsp.js";
import { codeRoutes } from "../routes/code.js";
import { guardRoutes } from "../routes/guard.js";
import { selfWorkRoutes } from "../routes/self-work.js";
import { memoryRoutes } from "../routes/memory.js";
import { healthRoutes } from "../routes/health.js";
import { storageRoutes } from "../routes/storage.js";
import { ideRoutes } from "../routes/ide.js";
import { torRoutes } from "../routes/tor.js";
import { remoteDesktopRoutes } from "../routes/remote-desktop.js";
import { browserRoutes } from "../routes/browser.js";
import { comfyUiRoutes } from "../routes/comfy-ui.js";
import { partsRoutes } from "../routes/parts.js";
import { telegramRoutes } from "../routes/telegram.js";
import { pagesRoutes } from "../routes/pages.js";
import { pairRoutes } from "../routes/pair.js";
import { speechRoutes } from "../routes/speech.js";
import { computerRoutes } from "../routes/computer.js";
import { mcpRoutes } from "../routes/mcp.js";
import { journalRoutes } from "../routes/journal.js";
import { gameRoutes } from "../routes/game.js";
import { timerRoutes } from "../routes/timers.js";
import { studyRoutes } from "../routes/study.js";
import { moodleRoutes } from "../routes/moodle.js";
import { webImageRoutes } from "../routes/web-image.js";
import { studyPlanRoutes } from "../routes/study-plans.js";
import { ideasRoutes } from "../routes/ideas.js";
import { canvasRoutes } from "../routes/canvas.js";
import { shareRoutes } from "../routes/shares.js";
import { ShareStore } from "../shares.js";
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
import { fileRoutes } from "../routes/files.js";
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
export async function registerRoutes(app: FastifyInstance, services: KesherServices, p: { paths: DataPaths; library: Library; apiKeys: ApiKeys; chatTimers: ChatTimers; canvases: CanvasStore; telegram: TelegramBridge }): Promise<void> {
  const { paths, library, apiKeys, chatTimers, canvases, telegram } = p;
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
  await storageRoutes(app, services);
  await ideRoutes(app);
  await torRoutes(app, services);
  await remoteDesktopRoutes(app, services);
  await pluginRoutes(app, services);
  await computerRoutes(app, services);
  await speechRoutes(app, services);
  await mcpRoutes(app, services);
  await journalRoutes(app, services);
  await gameRoutes(app, services);
  await textHelperRoutes(app, services);
  await timerRoutes(app, chatTimers);
  await studyRoutes(app, services);
  await moodleRoutes(app, services);
  await webImageRoutes(app);
  await studyPlanRoutes(app, services);
  await ideasRoutes(app, services);
  await canvasRoutes(app, canvases, (convId) => library.summary(convId)?.title);
  // Share links: a chat as a read-only page at /s/<token> (never an incognito chat).
  await shareRoutes(app, new ShareStore(join(paths.root, "shares.json")), async (convId) => {
    const summary = library.summary(convId);
    if (!summary || summary.incognito) return undefined;
    const opened = await services.conversations.open(convId);
    return opened ? { title: summary.title ?? "Chat", events: opened.session.events } : undefined;
  });
  await knowledgeRoutes(app, services);
  await librariesRoutes(app, services);
  await personaRoutes(app, services);
  if (features.images && features.downloads) await civitaiRoutes(app, services);
  await promptRoutes(app, services);
  await skillRoutes(app, services);
  await libraryStoreRoutes(app, services);
  await pipelineRoutes(app, services);
  await comfyRoutes(app, services);
  await notificationRoutes(app, services);
  await inboxRoutes(app, services);
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
  await godotRoutes(app, services);
  await stremioRoutes(app, services, apiKeys);
  await sshRoutes(app, services);
  await chatReportRoutes(app, services);
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
}
