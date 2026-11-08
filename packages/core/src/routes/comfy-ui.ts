import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import proxy from "@fastify/http-proxy";
import "@fastify/websocket";
import WebSocket from "ws";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";
import { editFlow, type ApiFlow, type NodeInfo } from "../comfy-edit.js";
import { modelTurnFor } from "../conversations.js";

/**
 * ComfyUI's own node editor inside KesherAI (the Nodes page): ComfyUI is
 * served under `/comfy-ui/`, so the page and the editor share one address
 * and the page can read and load the editor's graph (for editing it with
 * words). ComfyUI runs on this computer only; this is the one way in.
 *
 * On this computer it opens directly. From the phone (remote access), the
 * page first asks `/api/comfy-ui/session` (which needs the access token)
 * for a cookie that lets the editor's own requests through.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function comfyUiRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const sessions = new Set<string>();
  const cookie = (req: FastifyRequest) => /(?:^|;\s*)kesher_comfy=([\w-]{43})/.exec(req.headers.cookie ?? "")?.[1];
  const allowed = (req: FastifyRequest) => {
    if (isLocalRequest(req)) return true;
    const c = cookie(req);
    return !!c && [...sessions].some((x) => x.length === c.length && timingSafeEqual(Buffer.from(x), Buffer.from(c)));
  };

  /** Whether ComfyUI answers (the one KesherAI runs, or the user's own on the same port). */
  const up = async () => s.comfy.status().running || (await fetch(`${s.comfy.status().url}/system_stats`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false));

  /** A cookie for the editor's requests from another device (needs the token, like every /api call). */
  app.get("/api/comfy-ui/session", async (_req, reply) => {
    const id = randomBytes(32).toString("base64url");
    sessions.add(id);
    if (sessions.size > 50) sessions.delete(sessions.values().next().value!);
    reply.header("set-cookie", `kesher_comfy=${id}; Path=/comfy-ui; HttpOnly; SameSite=Strict${s.tunnel.status().url ? "; Secure" : ""}`);
    return { ok: true, running: await up() };
  });

  /**
   * Changes the editor's flow as the user asks, with the active chat model.
   * Body: `{ flow, request }` (the flow in ComfyUI's API format).
   */
  app.post<{ Body: { flow?: ApiFlow; request?: string } }>("/api/comfy-ui/edit", { bodyLimit: 20 * 1024 * 1024 }, async (req, reply) => {
    const request = String(req.body?.request ?? "").trim().slice(0, 2000);
    const flow = req.body?.flow;
    if (!request || !flow || typeof flow !== "object") return reply.code(400).send({ error: "Send the flow and what to change." });
    const chat = s.config.activeModels.chat;
    if (!chat) return reply.code(400).send({ error: "Choose a chat model first; it edits the flow." });
    try {
      const nodes = (await (await fetch(`${s.comfy.status().url}/object_info`, { signal: AbortSignal.timeout(20_000) })).json()) as Record<string, NodeInfo>;
      const turn = modelTurnFor(s.registry, chat);
      return await editFlow(flow, request, nodes, async (messages) => (await turn({ messages, tools: [] }, AbortSignal.timeout(300_000), () => undefined)).text);
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  const guard = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!allowed(req)) return reply.code(401).send("Open ComfyUI from KesherAI's Nodes page.");
    s.guard.touch("comfyui");
    if (!(await up())) {
      return reply.code(503).type("text/html; charset=utf-8").send("<p style='font:15px sans-serif;padding:24px'>ComfyUI is not running. Start it on KesherAI's Models page (Pictures → ComfyUI).</p>");
    }
  };

  // The editor's live updates (progress, previews): piped to ComfyUI's /ws. Done here rather than
  // by the proxy, whose WebSocket handling clashes with @fastify/websocket on the same server.
  app.get<{ Querystring: Record<string, string> }>("/comfy-ui/ws", { websocket: true, preHandler: guard }, (client, req) => {
    const search = new URLSearchParams(req.query).toString();
    const up = new WebSocket(`${s.comfy.status().url.replace(/^http/, "ws")}/ws${search ? `?${search}` : ""}`);
    const queued: Array<{ data: WebSocket.RawData; binary: boolean }> = [];
    up.on("open", () => queued.splice(0).forEach((m) => up.send(m.data, { binary: m.binary })));
    up.on("message", (data, binary) => client.readyState === client.OPEN && client.send(data, { binary }));
    client.on("message", (data: WebSocket.RawData, binary: boolean) => (up.readyState === up.OPEN ? up.send(data, { binary }) : queued.push({ data, binary })));
    const end = () => {
      up.close();
      client.close();
    };
    up.on("close", end);
    up.on("error", end);
    client.on("close", end);
  });

  await app.register(proxy, {
    upstream: s.comfy.status().url,
    prefix: "/comfy-ui",
    rewritePrefix: "",
    preHandler: guard,
    // The editor asks with its own origin; ComfyUI checks that requests come from where it is.
    replyOptions: {
      rewriteRequestHeaders: (_req, headers) => {
        const { origin: _o, referer: _r, cookie: _c, authorization: _a, ...rest } = headers;
        return { ...rest, host: new URL(s.comfy.status().url).host };
      },
    },
  });
}
