import type { FastifyInstance } from "fastify";
import type WebSocket from "ws";
import { isLocalRequest } from "../auth.js";
import type { KesherServices } from "../services.js";

/**
 * Godot: the editor connects here (KesherAI Bridge addon, this computer only); the page reads its state and the open
 * scene, adds the addon to a project, and runs or stops the game.
 */
export async function godotRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const g = s.godot;
  app.get("/api/godot/ws", {
    websocket: true,
    preHandler: async (req, reply) => {
      if (!isLocalRequest(req)) return reply.code(403).send({ error: "The Godot editor connects from this computer only." });
    },
  }, (socket) => g.attach(socket as unknown as WebSocket));
  app.get("/api/godot", async () => ({ ...g.status(), editors: await g.findGodot() }));
  app.get("/api/godot/tree", async (_req, reply) => g.request("tree").catch((e: Error) => reply.code(409).send({ error: e.message })));
  app.post<{ Body: { project?: string; csharp?: boolean } }>("/api/godot/connect", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Connect a project on the computer that runs KesherAI." });
    const dir = String(req.body?.project ?? "").replace(/[\\/]project\.godot$/i, "");
    await g.connectProject(dir);
    const ed = (await g.findGodot()).find((x) => x.csharp === (req.body?.csharp === true)) ?? (await g.findGodot())[0];
    if (ed) {
      const { spawn } = await import("node:child_process");
      const { dirname } = await import("node:path");
      spawn(ed.path, ["--editor", "--path", dir], { cwd: dirname(ed.path), detached: true, stdio: "ignore" }).unref();
    }
    return { ok: true, opened: ed?.path ?? null };
  });
  app.post<{ Body: { action?: "run" | "stop" } }>("/api/godot/play", async (req, reply) => g.request(req.body?.action === "stop" ? "stop" : "run").then(() => ({ ok: true }), (e: Error) => reply.code(409).send({ error: e.message })));
  app.get("/api/godot/log", async (_req, reply) => g.request<{ text: string }>("log").catch((e: Error) => reply.code(409).send({ error: e.message })));
  app.get("/api/godot/screenshot", async (_req, reply) => g.request<{ png: string }>("screenshot", {}, 20_000).then((r) => reply.type("image/png").send(Buffer.from(r.png, "base64")), (e: Error) => reply.code(409).send({ error: e.message })));
}
