import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import proxy from "@fastify/http-proxy";
import "@fastify/websocket";
import WebSocket from "ws";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";
import { editFlow, type ApiFlow, type NodeInfo } from "../comfy-edit.js";
import { modelTurnFor } from "../conversations.js";
import { flowState, folderNames, readyFlows, setupFlow, withCheckpoints, type ReadyFlow } from "../comfy-flows.js";
import { needsFreeCard, runSmoke, smallestSettings, smokeKind, testPicture, type SmokeResult } from "../comfy-smoke.js";

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

  /** Ready-made flows (music, 3D) with whether their models are here. */
  // `installed` and `allowed` (ComfyUI is here and business mode lets it run) tell the editors whether a tool such as
  // picture-to-3D exists on this computer (editor-handoff.ts: "Make a 3D model from this" is hidden without it).
  app.get("/api/comfy-ui/flows", async () =>
    readyFlows().map(({ flow: _f, checkpoints: _c, ...f }) => {
      const st = s.conversations.flows?.state(f.id);
      return { ...f, ...flowState({ ...f, flow: {}, checkpoints: {} }, s.paths.models, s.downloads), installed: st?.installed ?? false, allowed: st?.allowed ?? false };
    }),
  );

  /** Downloads a ready-made flow's models (follow them in the downloads circle). */
  app.post<{ Params: { id: string } }>("/api/comfy-ui/flows/:id/setup", async (req, reply) => {
    const flow = readyFlows().find((f) => f.id === req.params.id);
    if (!flow) return reply.code(404).send({ error: "No such flow." });
    try {
      return { started: await setupFlow(flow, s.paths.models, s.downloads), ...flowState(flow, s.paths.models, s.downloads) };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /** A ready-made flow in API format with the model names ComfyUI lists on this computer. */
  const apiFlow = async (flow: ReadyFlow) => {
    const list = (folder: string) =>
      fetch(`${s.comfy.status().url}/models/${folder}`, { signal: AbortSignal.timeout(10_000) })
        .then((r) => (r.ok ? (r.json() as Promise<string[]>) : []))
        .catch(() => [] as string[]);
    return withCheckpoints(flow, await list("checkpoints"), await folderNames(flow, list));
  };

  /** Flows being smoke-tested now (one at a time: they share the graphics card). */
  let smoking: string | undefined;

  /**
   * A headless smoke run of a ready-made flow: starts ComfyUI if needed, runs the flow with the smallest settings and
   * a generated test picture, waits (10 minutes at most) and answers `{ ok, seconds, outputs, error }`. Video and 3D
   * flows unload the chat model first (the card cannot hold both). Computer only: it uses the card for minutes.
   */
  app.post<{ Params: { id: string } }>("/api/comfy-ui/flows/:id/smoke", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Run the test on the computer itself." });
    const flow = readyFlows().find((f) => f.id === req.params.id);
    if (!flow) return reply.code(404).send({ error: "No such flow." });
    if (!flowState(flow, s.paths.models, s.downloads).ready) return reply.code(409).send({ error: "The flow's models are not downloaded yet." });
    if (smoking) return reply.code(409).send({ error: `A test is already running (${smoking}).` });
    const kind = smokeKind(flow.id);
    if (needsFreeCard(kind) && Object.keys(s.conversations.activity()).length) return reply.code(409).send({ error: "A chat is answering now; the test needs the graphics card. Try again when it ends." });
    smoking = flow.id;
    // Counted as an open, working editor so the idle guard does not stop ComfyUI in the middle of the run.
    s.comfy.editors++;
    try {
      if (needsFreeCard(kind)) await s.guard.unloadProvider("llamacpp");
      s.guard.touch("comfyui");
      await s.comfy.start();
      const url = s.comfy.status().url;
      const small = smallestSettings(await apiFlow(flow));
      const loaders = Object.values(small).filter((n) => n.class_type === "LoadImage");
      if (Object.values(small).some((n) => n.class_type === "Load3DAdvanced")) {
        return { ok: false, seconds: 0, outputs: [], error: "This flow needs a 3D file; it cannot be tested alone." } satisfies SmokeResult;
      }
      if (loaders.length) {
        const form = new FormData();
        form.append("image", new Blob([new Uint8Array(testPicture())], { type: "image/png" }), "kesher_smoke.png");
        form.append("overwrite", "true");
        const up = await fetch(`${url}/upload/image`, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) }).then((r) => (r.ok ? (r.json() as Promise<{ name?: string }>) : undefined), () => undefined);
        if (!up?.name) return { ok: false, seconds: 0, outputs: [], error: "ComfyUI did not take the test picture." } satisfies SmokeResult;
        for (const n of loaders) n.inputs.image = up.name;
      }
      return await runSmoke({ url, flow: small, onPoll: () => (s.comfy.editorActiveAt = Date.now()) });
    } catch (err) {
      return { ok: false, seconds: 0, outputs: [], error: (err as Error).message.slice(0, 500) } satisfies SmokeResult;
    } finally {
      s.comfy.editors = Math.max(0, s.comfy.editors - 1);
      smoking = undefined;
    }
  });

  /** A ready-made flow in ComfyUI's API format, with the checkpoint names ComfyUI uses on this computer. */
  app.get<{ Params: { id: string }; Querystring: { asset?: string } }>("/api/comfy-ui/flows/:id", async (req, reply) => {
    const flow = readyFlows().find((f) => f.id === req.params.id);
    if (!flow) return reply.code(404).send({ error: "No such flow." });
    const out = await apiFlow(flow);
    // A picture of KesherAI's (a result on the Pictures page): sent to ComfyUI's inputs and set in the flow's
    // LoadImage, so "Animate" under a picture opens the video flow ready to run.
    const assetId = req.query.asset;
    if (assetId) {
      const found = /^[\w-]{1,80}$/.test(assetId) ? await s.assets.get(assetId) : undefined;
      if (!found || !found.asset.mimeType.startsWith("image/")) return reply.code(404).send({ error: "No such picture." });
      const ext = found.asset.mimeType === "image/jpeg" ? "jpg" : found.asset.mimeType === "image/webp" ? "webp" : "png";
      const form = new FormData();
      form.append("image", new Blob([new Uint8Array(found.data)], { type: found.asset.mimeType }), `kesher_${assetId}.${ext}`);
      form.append("overwrite", "true");
      const up = await fetch(`${s.comfy.status().url}/upload/image`, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) }).then((r) => (r.ok ? (r.json() as Promise<{ name?: string }>) : undefined), () => undefined);
      if (!up?.name) return reply.code(503).send({ error: "ComfyUI did not take the picture. Is it running?" });
      for (const node of Object.values(out)) if (node.class_type === "LoadImage") node.inputs.image = up.name;
    }
    return { name: flow.title.en, flow: out };
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
    // Load on demand: an open editor that is working (progress, previews) keeps ComfyUI running (start-engines.ts).
    s.comfy.editors++;
    s.comfy.editorActiveAt = Date.now();
    let counted = true;
    up.on("open", () => queued.splice(0).forEach((m) => up.send(m.data, { binary: m.binary })));
    up.on("message", (data, binary) => {
      s.comfy.editorActiveAt = Date.now();
      if (client.readyState === client.OPEN) client.send(data, { binary });
    });
    client.on("message", (data: WebSocket.RawData, binary: boolean) => (up.readyState === up.OPEN ? up.send(data, { binary }) : queued.push({ data, binary })));
    const end = () => {
      if (counted) s.comfy.editors = Math.max(0, s.comfy.editors - 1);
      counted = false;
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
