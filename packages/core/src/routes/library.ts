import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { AgentEvent, ConversationKind, PermissionMode, Project } from "@kesher/shared";
import type { KesherServices } from "../services.js";
import { startSSE } from "../sse.js";
import { assertFolder, NoModelError } from "../conversations.js";
import { assertWritableFolder } from "../library.js";
import { isLocalRequest } from "../auth.js";
import { allowThroughFirewall, type FirewallResult } from "../firewall.js";

const MODES: PermissionMode[] = ["ask", "auto-edit", "auto"];

/**
 * Projects, conversations (each one a live agent session), approvals,
 * questions, and app settings (active models, sync folder).
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function libraryRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  // ---------- Projects ----------
  app.get("/api/projects", async () => s.library.listProjects());

  app.post<{ Body: { name?: string; workspace?: string; instructions?: string } }>("/api/projects", async (req, reply) => {
    const name = req.body?.name?.trim();
    if (!name) return reply.code(400).send({ error: "A project needs a name" });
    if (req.body.workspace) {
      try {
        await assertFolder(req.body.workspace);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
    const now = new Date().toISOString();
    const project: Project = {
      id: randomUUID(),
      name,
      ...(req.body.workspace ? { workspace: req.body.workspace } : {}),
      ...(req.body.instructions ? { instructions: req.body.instructions } : {}),
      createdAt: now,
      updatedAt: now,
    };
    return s.library.saveProject(project);
  });

  app.patch<{ Params: { id: string }; Body: Partial<Pick<Project, "name" | "workspace" | "instructions">> }>("/api/projects/:id", async (req, reply) => {
    const project = s.library.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    if (req.body.workspace) {
      try {
        await assertFolder(req.body.workspace);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
    return s.library.saveProject({ ...project, ...req.body });
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (req) => {
    await s.library.deleteProject(req.params.id);
    return { ok: true };
  });

  // ---------- Conversations ----------
  app.get<{ Querystring: { projectId?: string } }>("/api/conversations", async (req) => {
    const q = req.query.projectId;
    return s.library.listConversations(q === undefined ? undefined : q === "none" ? null : q);
  });

  /** Which conversations are working right now (`running`) or waiting for an answer (`waiting`). */
  app.get("/api/conversations/activity", async () => s.conversations.activity());

  app.post<{ Body: { projectId?: string | null; kind?: ConversationKind; modelId?: string; mode?: PermissionMode; workspace?: string } }>(
    "/api/conversations",
    async (req, reply) => {
      const b = req.body ?? {};
      if (b.mode && !MODES.includes(b.mode)) return reply.code(400).send({ error: "Unknown mode" });
      try {
        const c = await s.conversations.create({
          kind: b.kind === "code" ? "code" : "chat",
          ...(b.projectId !== undefined ? { projectId: b.projectId } : {}),
          ...(b.modelId ? { modelId: b.modelId } : {}),
          ...(b.mode ? { mode: b.mode } : {}),
          ...(b.workspace ? { workspace: b.workspace } : {}),
        });
        const { messages: _m, events: _e, ...summary } = c;
        return summary;
      } catch (err) {
        if (err instanceof NoModelError) return reply.code(400).send({ error: err.message, code: "no-model", category: err.category });
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/conversations/:id", async (req, reply) => {
    const opened = await s.conversations.open(req.params.id);
    if (!opened) return reply.code(404).send({ error: "Conversation not found" });
    const { messages: _m, events: _e, ...summary } = opened.conversation;
    return { ...summary, session: opened.session.info(), events: opened.session.events };
  });

  app.patch<{ Params: { id: string }; Body: { title?: string; modelId?: string; mode?: PermissionMode; projectId?: string | null } }>(
    "/api/conversations/:id",
    async (req, reply) => {
      const b = req.body ?? {};
      if (b.mode && !MODES.includes(b.mode)) return reply.code(400).send({ error: "Unknown mode" });
      const c = await s.conversations.update(req.params.id, b);
      if (!c) return reply.code(404).send({ error: "Conversation not found" });
      const { messages: _m, events: _e, ...summary } = c;
      return summary;
    },
  );

  app.delete<{ Params: { id: string } }>("/api/conversations/:id", async (req) => {
    await s.conversations.delete(req.params.id);
    return { ok: true };
  });

  /**
   * Live events as Server-Sent Events. Replays saved events after `?after=<seq>`
   * (default: all), then streams new ones, including text deltas (seq 0) and
   * the session info after every change, as `{ "type": "info", ... }`.
   */
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/conversations/:id/events", async (req, reply) => {
    const opened = await s.conversations.open(req.params.id);
    if (!opened) return reply.code(404).send({ error: "Conversation not found" });
    const { session } = opened;
    const sse = startSSE(req, reply);
    const after = Number(req.query.after ?? 0);
    for (const e of session.events) if (e.seq > after) sse.send(e);
    sse.send({ type: "info", ...session.info() });
    const onEvent = (e: AgentEvent) => {
      sse.send(e);
      if (e.type !== "assistant_delta") sse.send({ type: "info", ...session.info() });
    };
    session.on("event", onEvent);
    const ping = setInterval(() => sse.send({ type: "ping" }), 25_000);
    sse.closed.addEventListener("abort", () => {
      clearInterval(ping);
      session.off("event", onEvent);
    });
  });

  app.post<{ Params: { id: string }; Body: { text?: string } }>("/api/conversations/:id/messages", async (req, reply) => {
    const text = req.body?.text?.trim();
    if (!text) return reply.code(400).send({ error: "Empty message" });
    try {
      await s.conversations.send(req.params.id, text);
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      return reply.code(/not found/i.test(msg) ? 404 : 409).send({ error: msg });
    }
  });

  app.post<{ Params: { id: string; requestId: string }; Body: { decision?: "allow" | "always" | "deny"; feedback?: string; scope?: "conversation" | "model" | "everywhere" } }>(
    "/api/conversations/:id/approvals/:requestId",
    async (req, reply) => {
      const opened = await s.conversations.open(req.params.id);
      const d = req.body?.decision;
      if (!opened) return reply.code(404).send({ error: "Conversation not found" });
      if (d !== "allow" && d !== "always" && d !== "deny") return reply.code(400).send({ error: "decision must be allow, always or deny" });
      if (d === "always") {
        // Remember it, so it also holds after a restart (and, by scope, in other conversations).
        const ev = opened.session.events.find((e) => e.type === "approval_request" && e.requestId === req.params.requestId);
        const tool = ev && ev.type === "approval_request" ? ev.name : undefined;
        const scope = req.body.scope ?? "conversation";
        if (tool) {
          const rule = {
            tool,
            scope,
            ...(scope === "conversation" ? { conversationId: req.params.id } : {}),
            ...(scope === "model" ? { modelId: opened.session.modelId } : {}),
            createdAt: new Date().toISOString(),
          };
          const same = (r: { tool: string; scope: string; conversationId?: string; modelId?: string }) => r.tool === rule.tool && r.scope === rule.scope && r.conversationId === rule.conversationId && r.modelId === rule.modelId;
          if (!s.config.permissions.some(same)) {
            s.config.permissions.push(rule);
            await s.saveConfig();
          }
        }
      }
      if (!opened.session.approve(req.params.requestId, d, req.body.feedback)) return reply.code(404).send({ error: "That request is no longer waiting" });
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string; questionId: string }; Body: { text?: string } }>("/api/conversations/:id/answers/:questionId", async (req, reply) => {
    const opened = await s.conversations.open(req.params.id);
    if (!opened) return reply.code(404).send({ error: "Conversation not found" });
    if (!opened.session.answer(req.params.questionId, req.body?.text ?? "")) return reply.code(404).send({ error: "That question is no longer waiting" });
    return { ok: true };
  });

  /** Gives the conversation access to a folder or file outside its own (the paper clip, or drag and drop). */
  app.post<{ Params: { id: string }; Body: { path?: string } }>("/api/conversations/:id/access", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Files can only be attached on this computer." });
    const opened = await s.conversations.open(req.params.id);
    if (!opened) return reply.code(404).send({ error: "Conversation not found" });
    try {
      return { path: await opened.session.grant(req.body?.path ?? "") };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/conversations/:id/stop", async (req, reply) => {
    const opened = await s.conversations.open(req.params.id);
    if (!opened) return reply.code(404).send({ error: "Conversation not found" });
    opened.session.stop();
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/conversations/:id/undo", async (req, reply) => {
    const opened = await s.conversations.open(req.params.id);
    if (!opened) return reply.code(404).send({ error: "Conversation not found" });
    try {
      const path = await opened.session.undo();
      return path ? { ok: true, path } : reply.code(409).send({ error: "Nothing to undo" });
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });

  // ---------- Permanent approvals ----------
  app.get("/api/permissions", async () => s.config.permissions);
  app.delete<{ Params: { index: string } }>("/api/permissions/:index", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Approvals can only be changed on this computer." });
    const i = Number(req.params.index);
    if (!Number.isInteger(i) || i < 0 || i >= s.config.permissions.length) return reply.code(404).send({ error: "No such approval" });
    s.config.permissions.splice(i, 1);
    await s.saveConfig();
    return s.config.permissions;
  });

  // ---------- Settings ----------
  app.get("/api/settings", async () => ({
    activeModels: s.config.activeModels,
    syncFolder: s.config.syncFolder ?? null,
    remote: { enabled: s.config.remote.enabled, keepAwake: s.config.remote.keepAwake },
  }));

  app.put<{ Body: { activeModels?: Record<string, string>; syncFolder?: string | null; remote?: { enabled?: boolean; keepAwake?: boolean } } }>("/api/settings", async (req, reply) => {
    const b = req.body ?? {};
    if (b.remote && !isLocalRequest(req)) return reply.code(403).send({ error: "Remote access can only be changed on this computer." });
    let firewall: FirewallResult | undefined;
    if (typeof b.remote?.enabled === "boolean") {
      s.config.remote.enabled = b.remote.enabled;
      // Let the phone through Windows Firewall (Windows asks the user once).
      if (b.remote.enabled) firewall = await allowThroughFirewall(s.config.port).catch(() => undefined);
    }
    if (typeof b.remote?.keepAwake === "boolean") s.config.remote.keepAwake = b.remote.keepAwake;
    if (b.activeModels) {
      s.config.activeModels = Object.fromEntries(Object.entries(b.activeModels).filter(([, v]) => typeof v === "string" && v));
    }
    let synced: number | undefined;
    if (b.syncFolder !== undefined) {
      if (b.syncFolder) {
        try {
          await assertWritableFolder(b.syncFolder);
        } catch (err) {
          return reply.code(400).send({ error: (err as Error).message });
        }
        s.config.syncFolder = b.syncFolder;
        await s.library.importFromSync();
        await s.library.load();
        synced = await s.library.exportToSync();
      } else {
        delete s.config.syncFolder;
      }
    }
    await s.saveConfig();
    return {
      activeModels: s.config.activeModels,
      syncFolder: s.config.syncFolder ?? null,
      remote: { enabled: s.config.remote.enabled, keepAwake: s.config.remote.keepAwake },
      ...(synced !== undefined ? { synced } : {}),
      ...(firewall ? { firewall } : {}),
    };
  });

  // ---------- Updates ----------
  app.get("/api/version", async () => s.updater.version());
  app.get("/api/updates", async (_req, reply) => {
    try {
      return await s.updater.check();
    } catch (err) {
      return reply.code(503).send({ error: (err as Error).message });
    }
  });
  app.get("/api/updates/progress", async () => s.updater.status());
  app.post("/api/updates/apply", async (_req, reply) => {
    try {
      return await s.updater.apply();
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });
}
