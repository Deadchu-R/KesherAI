import type { FastifyInstance } from "fastify";
import { isLocalRequest } from "../auth.js";
import type { TelegramBridge } from "../telegram.js";

/**
 * Telegram (Settings → Phone): the status anywhere, without the pairing
 * code; the token, pairing and every setting only on this computer.
 *
 * @param app - The server.
 * @param telegram - The bridge.
 */
export async function telegramRoutes(app: FastifyInstance, telegram: TelegramBridge): Promise<void> {
  const deny = { error: "Telegram is set up on the computer that runs KesherAI." };

  app.get("/api/telegram", async (req) => {
    const st = telegram.status();
    if (isLocalRequest(req)) return { ...st, local: true };
    const { pairing: _hidden, ...rest } = st;
    return { ...rest, local: false };
  });

  /** Body: `{ token }` (checks it with Telegram and starts the bot), `{ enabled }`, or `{ approveCommands }`. */
  app.put<{ Body: { token?: string; enabled?: boolean; approveCommands?: boolean } }>("/api/telegram", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send(deny);
    try {
      if (typeof req.body?.token === "string") await telegram.setToken(req.body.token);
      if (typeof req.body?.enabled === "boolean") await telegram.setEnabled(req.body.enabled);
      if (typeof req.body?.approveCommands === "boolean") await telegram.setApproveCommands(req.body.approveCommands);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    return telegram.status();
  });

  /** Opens pairing for 10 minutes (one code, one chat). */
  app.post("/api/telegram/pair", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send(deny);
    return telegram.startPairing();
  });

  /** Closes pairing. */
  app.delete("/api/telegram/pair", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send(deny);
    telegram.stopPairing();
    return telegram.status();
  });

  /** Unpairs one chat. */
  app.delete<{ Params: { id: string } }>("/api/telegram/chats/:id", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send(deny);
    await telegram.unpair(Number(req.params.id));
    return telegram.status();
  });

  /** Forgets the bot token and the chats. */
  app.delete("/api/telegram", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send(deny);
    await telegram.forget();
    return telegram.status();
  });
}
