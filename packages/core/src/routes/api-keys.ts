import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { KesherServices } from "../services.js";
import type { ApiKeys } from "../api-keys.js";
import { isLocalRequest } from "../auth.js";

/**
 * App access keys for the model APIs: list, create (the key is shown once),
 * revoke, and whether apps on this computer need one too. Only on this
 * computer.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 * @param keys - The key store.
 */
export async function apiKeyRoutes(app: FastifyInstance, s: KesherServices, keys: ApiKeys): Promise<void> {
  const local = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Access keys can be managed only on this computer." });
  };
  const view = () => ({
    keys: keys.list().map(({ hash: _h, ...k }) => k),
    requireKeyLocally: s.config.apiAuth.requireKeyLocally,
    base: `http://127.0.0.1:${s.config.port}`,
  });
  app.get("/api/api-keys", { preHandler: local }, async () => view());
  app.post<{ Body: { name?: string } }>("/api/api-keys", { preHandler: local }, async (req) => {
    const { key, entry } = await keys.create(String(req.body?.name ?? ""));
    const { hash: _h, ...rest } = entry;
    return { key, entry: rest };
  });
  app.delete<{ Params: { id: string } }>("/api/api-keys/:id", { preHandler: local }, async (req, reply) => ((await keys.revoke(req.params.id)) ? view() : reply.code(404).send({ error: "No such key." })));
  app.put<{ Body: { requireKeyLocally?: boolean } }>("/api/api-keys/settings", { preHandler: local }, async (req) => {
    s.config.apiAuth.requireKeyLocally = !!req.body?.requireKeyLocally;
    await s.saveConfig();
    return view();
  });
}
