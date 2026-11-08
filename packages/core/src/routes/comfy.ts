import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";

/**
 * Managed ComfyUI: status, install (downloads; started by the user),
 * start, stop, and the settings (own folder, port, start with KesherAI).
 * Installing, starting and stopping also work from the phone (with the
 * access token); pointing at another ComfyUI folder or port only here.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function comfyRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  // A folder or port is chosen on the computer itself; start-with-KesherAI can change from anywhere.
  const localForPaths = async (req: FastifyRequest<{ Body: { folder?: unknown; port?: unknown } }>, reply: FastifyReply) => {
    const b = req.body ?? {};
    if ((b.folder !== undefined || b.port !== undefined) && !isLocalRequest(req)) return reply.code(403).send({ error: "Choose ComfyUI's folder and port on the computer itself." });
  };
  const view = () => ({ ...s.comfy.status(), autoStart: s.config.comfyui.autoStart, port: s.config.comfyui.port, ownFolder: s.config.comfyui.folder ?? null });
  app.get("/api/comfy", async () => view());
  app.post("/api/comfy/install", async () => {
    void s.comfy.install().catch(() => undefined);
    return view();
  });
  app.post("/api/comfy/start", async () => {
    void s.comfy.start().catch(() => undefined);
    return view();
  });
  app.post("/api/comfy/stop", async () => {
    await s.comfy.stop();
    return view();
  });
  app.put<{ Body: { folder?: string | null; port?: number; autoStart?: boolean } }>("/api/comfy", { preHandler: localForPaths }, async (req, reply) => {
    const b = req.body ?? {};
    if (b.folder !== undefined) {
      if (b.folder && !existsSync(join(b.folder, "main.py")) && !existsSync(join(b.folder, "ComfyUI", "main.py"))) return reply.code(400).send({ error: "That folder has no ComfyUI (main.py, or ComfyUI\\main.py in a portable copy)." });
      if (b.folder) s.config.comfyui.folder = b.folder;
      else delete s.config.comfyui.folder;
    }
    if (b.port !== undefined) {
      if (!Number.isInteger(b.port) || b.port < 1024 || b.port > 65535) return reply.code(400).send({ error: "Port: 1024 to 65535." });
      s.config.comfyui.port = b.port;
    }
    if (b.autoStart !== undefined) s.config.comfyui.autoStart = !!b.autoStart;
    await s.saveConfig();
    return view();
  });
}
