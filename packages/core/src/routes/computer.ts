import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";

/**
 * Computer control: whether it is on, what it is doing (and the action
 * log), turning it on or off, and Stop (also bound to Ctrl+Alt+Esc in the
 * desktop app).
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function computerRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  /** `{ enabled, active, app, log }`: `active` means it acted in the last 15 seconds. */
  app.get("/api/computer/status", async () => s.computer.status());

  /** The screen now, as PNG, for watching the agent work (only while computer control is on). */
  app.get<{ Querystring: { w?: string } }>("/api/computer/screen", async (req, reply) => {
    try {
      const png = await s.computer.watch(Number(req.query.w) || 960);
      return reply.type("image/png").header("cache-control", "no-store").send(png);
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });

  /** Everything waiting for the user's approval, in every conversation. */
  app.get("/api/approvals", async () => s.conversations.pendingApprovals());

  /** Stops every conversation that is controlling the computer. */
  app.post("/api/computer/stop", async () => {
    s.computer.stop();
    return { ok: true };
  });

  /** Turns computer control on or off: `{ enabled }`. New messages get (or lose) the tools. */
  app.put<{ Body: { enabled?: boolean } }>("/api/computer", async (req, reply) => {
    if (typeof req.body?.enabled !== "boolean") return reply.code(400).send({ error: "Send { enabled: true | false }" });
    s.config.computer.enabled = req.body.enabled;
    await s.saveConfig();
    if (!req.body.enabled) s.computer.stop();
    return s.computer.status();
  });
}
