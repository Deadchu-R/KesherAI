import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";
import { modelTurnFor } from "../conversations.js";
import { healthItems, healthPrompt, readHealth, type HealthReading } from "../pc-health.js";

/**
 * The Health page: the computer's reading and what to do (fixed rules), and on request the chat model's short
 * list in plain words. Read only. The phone sees the computer's health too.
 */
export async function healthRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  let last: { at: number; reading: HealthReading } | undefined;
  let reading: Promise<HealthReading> | undefined;
  const read = async (fresh: boolean): Promise<HealthReading> => {
    if (!fresh && last && Date.now() - last.at < 60_000) return last.reading;
    // One reading at a time (walking folders takes a few seconds).
    reading ??= readHealth({ dataRoot: s.paths.root, guard: s.guard.status() })
      .then((r) => {
        last = { at: Date.now(), reading: r };
        return r;
      })
      .finally(() => (reading = undefined));
    return reading;
  };

  app.get<{ Querystring: { lang?: string; fresh?: string } }>("/api/pc-health", async (req) => {
    const r = await read(req.query.fresh === "1");
    return { reading: r, items: healthItems(r, req.query.lang === "he") };
  });

  // KesherAI's own recent faults (already cleaned of secrets and home paths), for the Health page.
  app.get("/api/faults", async () => s.faults.recent({ limit: 15 }));

  app.post<{ Body: { lang?: string } }>("/api/pc-health/advice", async (req, reply) => {
    const he = req.body?.lang === "he";
    const chat = s.config.activeModels.chat;
    if (!chat) return reply.code(400).send({ error: "Choose a chat model first.", code: "no-model" });
    const r = await read(false);
    try {
      const out = await modelTurnFor(s.registry, chat)({ messages: [{ role: "user", content: healthPrompt(r, healthItems(r, he), he) }], tools: [] }, AbortSignal.timeout(180_000), () => undefined);
      return { text: out.text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim(), model: chat };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });
}
