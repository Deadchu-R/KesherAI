import type { FastifyInstance } from "fastify";
import type { GameProject } from "../game-projects.js";
import { tailProjectLog } from "../unreal-log.js";

/**
 * GET /api/unreal/log: the end of a project's Unreal Editor log (Saved/Logs/<Project>.log, else the newest log
 * there), so faults such as "the plugin did not connect" are found without opening Unreal's Output Log. From the
 * phone too. Only a project from the found list (its `path` exactly as GET /api/unreal/projects gives it), never any
 * path. `lines` (default 400, at most 2000) and `grep` (plain text, case-insensitive, at most 200 characters) are
 * optional.
 *
 * @param app - Fastify instance.
 * @param projects - The Unreal projects found on this computer.
 */
export function unrealLogRoute(app: FastifyInstance, projects: () => Promise<GameProject[]>): void {
  app.get<{ Querystring: { project?: string; lines?: string; grep?: string } }>("/api/unreal/log", async (req, reply) => {
    const p = (await projects()).find((x) => x.kind === "unreal" && x.path === req.query.project);
    if (!p) return reply.code(400).send({ error: "Choose one of the projects found on this computer (its path from /api/unreal/projects)." });
    try {
      const tail = await tailProjectLog(p.path, p.name, {
        ...(req.query.lines ? { lines: Number(req.query.lines) } : {}),
        ...(req.query.grep ? { grep: String(req.query.grep).slice(0, 200) } : {}),
      });
      if (!tail) return reply.code(404).send({ error: `${p.name} has no editor log yet (Unreal writes it when the project opens).` });
      return { project: p.name, ...tail };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });
}
