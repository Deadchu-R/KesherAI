import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";

/** What a Hugging Face access token looks like: `hf_` and letters or digits, no spaces. */
const HF_TOKEN = /^hf_[A-Za-z0-9]{8,200}$/;

/**
 * Settings > Accounts: the user's Hugging Face access token (for gated models, and a higher download limit). GET says
 * only whether it is set (any device may ask); PUT (this computer only, like the web search keys) sets or clears it.
 * The token is kept encrypted in the config and is never sent back, logged or put in an error message.
 *
 * @param app - Fastify instance.
 * @param s - The services (the config).
 */
export async function hfTokenRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  app.get("/api/hf-token", async () => ({ set: !!s.config.huggingFaceToken }));
  app.put<{ Body: { token?: string | null } }>("/api/hf-token", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "The Hugging Face token is changed on the computer that runs KesherAI." });
    const v = req.body?.token;
    const token = typeof v === "string" ? v.trim() : "";
    if (token && !HF_TOKEN.test(token)) return reply.code(400).send({ error: "That does not look like a Hugging Face token (it starts with hf_)." });
    if (token) s.config.huggingFaceToken = token;
    else delete s.config.huggingFaceToken;
    await s.saveConfig();
    return { set: !!token };
  });
}
