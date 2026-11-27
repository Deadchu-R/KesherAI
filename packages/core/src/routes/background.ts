/**
 * A chat's background commands (background-commands.ts): the chip row at the top of the chat lists them, stops one
 * and shows the end of a finished one's output ("Show output").
 */
import type { FastifyInstance } from "fastify";
import type { BackgroundCommands } from "../background-commands.js";

/**
 * Routes for background commands.
 *
 * @param app - Fastify instance.
 * @param background - The commands.
 */
export async function backgroundRoutes(app: FastifyInstance, background: BackgroundCommands): Promise<void> {
  // Without the working folder and the output file's path (the interface does not need them).
  app.get<{ Params: { id: string } }>("/api/conversations/:id/commands", async (req) => ({
    commands: background.list(req.params.id).map(({ id, command, state, exit, startedAt, endedAt }) => ({ id, command, state, exit, startedAt, endedAt })),
  }));
  app.post<{ Params: { id: string; cid: string } }>("/api/conversations/:id/commands/:cid/stop", async (req, reply) =>
    (await background.stop(req.params.id, req.params.cid)) ? { ok: true } : reply.code(404).send({ error: "This command is no longer running." }),
  );
  app.get<{ Params: { id: string; cid: string }; Querystring: { tail?: string } }>("/api/conversations/:id/commands/:cid/output", async (req, reply) => {
    const c = background.list(req.params.id).find((x) => x.id === req.params.cid);
    if (!c) return reply.code(404).send({ error: "This command is gone." });
    return { output: await background.tail(c, Number(req.query.tail) || 30) };
  });
}
