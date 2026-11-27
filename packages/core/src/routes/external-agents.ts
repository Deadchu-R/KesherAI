import type { FastifyInstance } from "fastify";
import { isLocalRequest, pairedDeviceIdOf } from "../auth.js";
import { cleanExternalInput } from "../external-agents.js";
import type { KesherServices } from "../services.js";

/**
 * The route the lead Claude calls at an outside helper's start and end (docs/HELPERS.md).
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function externalAgentRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  /** Registers or updates a run of an outside agent: `{id, title, status: running|done|failed, step?, steps?, result?}`. */
  app.post<{ Body: unknown }>("/api/agents/external", async (req, reply) => {
    // Only this computer or a paired device (its own key; the remote check let it in) may report.
    if (!isLocalRequest(req) && !pairedDeviceIdOf(req)) return reply.code(403).send({ error: "Only this computer or a paired device can report a helper." });
    if (!s.externalAgents) return reply.code(503).send({ error: "Not ready yet." });
    const c = cleanExternalInput(req.body);
    if (!c.ok) return reply.code(400).send({ error: c.error });
    const r = s.externalAgents.report(c.input);
    return { id: r.id, status: r.status, steps: r.steps.length };
  });

  /** What Claude's helper agents did in the last 7 days, from the commits on main with a `Claude-Session:` trailer (claude-work.ts). */
  app.get("/api/agents/claude-work", async () => ({ ...(s.claudeWork ? await s.claudeWork.read() : { sessions: [], at: Date.now(), days: 7 }), running: (await s.claudeStatus?.read())?.agents.filter((a) => a.state === "running") ?? [] }));

  /** The outside runs (newest first). */
  app.get("/api/agents/external", async () => ({ runs: (s.externalAgents?.list() ?? []).map((r) => ({ id: r.id, title: r.title, status: r.status, steps: r.steps, ...(r.of ? { of: r.of } : {}), ...(r.result ? { result: r.result } : {}), startedAt: r.startedAt, ...(r.endedAt ? { endedAt: r.endedAt } : {}) })) }));
}
