import type { FastifyInstance } from "fastify";
import "@fastify/websocket";
import type WebSocket from "ws";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";
import { modelTurnFor } from "../conversations.js";
import { BRIDGE_VERSION, blueprintPrompt, parseOps } from "../unreal-bridge.js";

/** Where the plugin is downloaded from (published by .github/workflows/unreal-plugin.yml). */
export const BRIDGE_DOWNLOAD = "https://github.com/Deadchu-R/KesherAI/releases/download/unreal-plugin-latest/KesherAIBridge.zip";

/**
 * The Unreal page: the editor's connection (the KesherAI Bridge plugin),
 * its Blueprints, and changing them in words.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function unrealRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const b = s.unreal;

  /** The editor connects here; only from this computer. */
  app.get("/api/unreal/ws", {
    websocket: true,
    preHandler: async (req, reply) => {
      if (!isLocalRequest(req)) return reply.code(403).send({ error: "The Unreal Editor connects from this computer only." });
    },
  }, (socket) => b.attach(socket as unknown as WebSocket));

  app.get("/api/unreal", async () => ({ ...(await b.status()), latestBridge: BRIDGE_VERSION, download: BRIDGE_DOWNLOAD }));

  app.get("/api/unreal/blueprints", async () => b.list());

  app.get<{ Querystring: { path?: string } }>("/api/unreal/graph", async (req, reply) => {
    if (!req.query.path) return reply.code(400).send({ error: "Which Blueprint?" });
    try {
      return await b.graph(req.query.path);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  /**
   * Changes a graph as the user asks, with the active chat model. With the
   * editor connected the change is made at once (one undo step) and the
   * Blueprint compiled; with it closed, the change waits in the queue.
   */
  app.post<{ Body: { path?: string; graph?: string; request?: string } }>("/api/unreal/edit", async (req, reply) => {
    const path = String(req.body?.path ?? "");
    const request = String(req.body?.request ?? "").trim().slice(0, 2000);
    if (!path || !request) return reply.code(400).send({ error: "Choose a Blueprint and say what to change." });
    const chat = s.config.activeModels.chat;
    if (!chat) return reply.code(400).send({ error: "Choose a chat model first; it makes the change." });
    try {
      const { graph: bp } = await b.graph(path);
      const graphName = req.body?.graph || bp.graphs[0]?.name || "EventGraph";
      const turn = modelTurnFor(s.registry, chat);
      const text = (await turn({ messages: blueprintPrompt(bp, graphName, request), tools: [] }, AbortSignal.timeout(300_000), () => undefined)).text;
      const { ops, note } = parseOps(text);
      if (!ops.length) return { ops, note: note || "Nothing to change.", applied: false };
      if (!b.connected) {
        const project = (await b.project()) ?? "Project";
        const queued = await b.enqueue({ project, path, graph: graphName, ops, request });
        return { ops, note, applied: false, queued: queued.id };
      }
      const result = await b.request<{ results: Array<{ ok: boolean; error?: string }>; failed: number }>("apply", { path, graph: graphName, ops });
      const compile = await b.request<{ ok: boolean; messages: Array<{ severity: string; text: string }> }>("compile", { path }).catch(() => undefined);
      return { ops, note, applied: true, result, compile };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /** Applies operations as given (for "Apply again" and plugins). */
  app.post<{ Body: { path?: string; graph?: string; ops?: unknown[] } }>("/api/unreal/apply", async (req, reply) => {
    const { path, graph = "", ops } = req.body ?? {};
    if (!path || !Array.isArray(ops)) return reply.code(400).send({ error: "Send the Blueprint and the operations." });
    try {
      return await b.request("apply", { path, graph, ops });
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  for (const cmd of ["compile", "save", "open"] as const) {
    app.post<{ Body: { path?: string } }>(`/api/unreal/${cmd}`, async (req, reply) => {
      if (!req.body?.path) return reply.code(400).send({ error: "Which Blueprint?" });
      try {
        return await b.request(cmd, { path: req.body.path }, cmd === "compile" ? 120_000 : 30_000);
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
    });
  }

  app.get("/api/unreal/queue", async () => b.queue());
  app.delete<{ Params: { id: string } }>("/api/unreal/queue/:id", async (req) => ({ removed: await b.unqueue(req.params.id) }));
}
