/**
 * Chat checks (chat-checks/): run KesherAI's "behaves like Claude" scenarios on this computer with the selected
 * chat model, and read the results (Settings › For developers › Chat checks).
 *   GET  /api/chat-checks          the scenarios, the last 10 runs (newest first), the default model, whether this device may run
 *   POST /api/chat-checks/run      {ids?, model?} → {job}; only on this computer (a phone views, it does not run)
 *   GET  /api/chat-checks/:job     one run: per scenario pass/fail/skip, the failing check and its reason, duration
 *   POST /api/chat-checks/stop     stops the run that is going (this computer only)
 */
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { basename } from "node:path";
import type { FastifyInstance } from "fastify";
import { isLocalRequest } from "../auth.js";
import type { ChatTimers } from "../chat-timers.js";
import type { ConversationManager } from "../conversations.js";
import { ChatChecks, type ChatCheckHost } from "../chat-checks/runner.js";
import { SCENARIOS } from "../chat-checks/scenarios.js";

/**
 * KesherAI's chats as the chat checks' host: temporary chats on the chosen model, deleted with their folder and
 * anything they scheduled.
 *
 * @param conversations - The conversation manager.
 * @param timers - Chat timers (a scenario's scheduled task is removed with its chat).
 * @param defaultModel - The chat model used when a run names none.
 */
export function conversationHost(conversations: ConversationManager, timers: ChatTimers | undefined, defaultModel: () => string | undefined): ChatCheckHost {
  const sessionOf = async (id: string) => {
    const opened = await conversations.open(id);
    if (!opened) throw new Error("The check's chat is gone.");
    return opened.session;
  };
  const folders = new Map<string, string>();
  return {
    defaultModel,
    async createChat(o) {
      const c = await conversations.create({ kind: "chat", modelId: o.model, auto: false, title: o.title, ...(o.incognito ? { incognito: true } : {}) });
      const folder = conversations.workspaceOf(c)!;
      folders.set(c.id, folder);
      return { id: c.id, folder };
    },
    async hasTool(id, tool, option) {
      const spec = (await sessionOf(id)).toolSpec(tool);
      if (!spec) return false;
      const props = (spec.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      return !option || Object.hasOwn(props, option);
    },
    async watch(id, onEvent) {
      const session = await sessionOf(id);
      session.on("event", onEvent);
      return () => session.off("event", onEvent);
    },
    send: (id, text) => conversations.send(id, text),
    approve: (id, requestId, decision, feedback) => void sessionOf(id).then((s) => s.approve(requestId, decision, feedback), () => undefined),
    answer: (id, questionId, text) => void sessionOf(id).then((s) => s.answer(questionId, text), () => undefined),
    stop: (id) => conversations.stop(id),
    async deleteChat(id) {
      await timers?.forget(id).catch(() => undefined);
      await conversations.delete(id);
      // The chat's own folder (outputs/<chat id>): only that one, never anything else.
      const folder = folders.get(id);
      folders.delete(id);
      if (folder && basename(folder) === id) await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    },
    async seedChat(title, messages) {
      const r = await conversations.importChats([{ source: "claude", originalId: `kesher-chat-check-${randomBytes(4).toString("hex")}`, title, createdAt: messages[0]?.at ?? new Date().toISOString(), messages }]);
      return r.ids[0]!;
    },
  };
}

/**
 * Routes for the chat checks.
 *
 * @param app - Fastify instance.
 * @param checks - The runner (one per app).
 */
export async function chatCheckRoutes(app: FastifyInstance, checks: ChatChecks): Promise<void> {
  app.get("/api/chat-checks", async (req) => ({
    scenarios: SCENARIOS.map((s) => ({ id: s.id, he: s.he, en: s.en })),
    runs: await checks.list(),
    running: checks.running() ?? null,
    model: checks.defaultModel() ?? null,
    canRun: isLocalRequest(req),
  }));
  app.post<{ Body: { ids?: unknown; model?: unknown } | null }>("/api/chat-checks/run", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Chat checks run only on the computer itself." });
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x): x is string => typeof x === "string").slice(0, 50) : undefined;
    const model = typeof req.body?.model === "string" ? req.body.model.slice(0, 200) : undefined;
    try {
      return { job: await checks.start({ ...(ids ? { ids } : {}), ...(model ? { model } : {}) }) };
    } catch (e) {
      return reply.code(checks.running() ? 409 : 400).send({ error: (e as Error).message });
    }
  });
  app.post("/api/chat-checks/stop", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Chat checks run only on the computer itself." });
    return { ok: checks.cancel() };
  });
  app.get<{ Params: { job: string } }>("/api/chat-checks/:job", async (req, reply) => (await checks.get(req.params.job)) ?? reply.code(404).send({ error: "No such run." }));
}
