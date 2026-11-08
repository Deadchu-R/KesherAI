import type { FastifyInstance } from "fastify";
import { isLocalRequest } from "../auth.js";
import type { TelegramBridge } from "../telegram.js";

/**
 * Telegram (Settings → Phone): the status anywhere; the token and pairing
 * only on this computer, since the token is a key to the bot.
 *
 * @param app - The server.
 * @param telegram - The bridge.
 */
export async function telegramRoutes(app: FastifyInstance, telegram: TelegramBridge): Promise<void> {
  const local = (req: Parameters<typeof isLocalRequest>[0]) => isLocalRequest(req);
  const deny = { error: "Telegram is set up on the computer that runs KesherAI." };

  app.get("/api/telegram", async (req) => ({ ...telegram.status(), ...(local(req) ? {} : { pairCode: "" }) }));

  /** Body: `{ token }` (checks it with Telegram and starts the bot), or `{ enabled }`. */
  app.put<{ Body: { token?: string; enabled?: boolean } }>("/api/telegram", async (req, reply) => {
    if (!local(req)) return reply.code(403).send(deny);
    try {
      if (typeof req.body?.token === "string") await telegram.setToken(req.body.token);
      if (typeof req.body?.enabled === "boolean") await telegram.setEnabled(req.body.enabled);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    return telegram.status();
  });

  /** Unpairs every chat (they need the new code). */
  app.post("/api/telegram/unpair", async (req, reply) => {
    if (!local(req)) return reply.code(403).send(deny);
    await telegram.unpairAll();
    return telegram.status();
  });

  /** Forgets the bot token and the chats. */
  app.delete("/api/telegram", async (req, reply) => {
    if (!local(req)) return reply.code(403).send(deny);
    await telegram.forget();
    return telegram.status();
  });
}
