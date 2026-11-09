import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";
import { modelTurnFor } from "../conversations.js";
import { cleanInline, inlinePrompt } from "../code-complete.js";

/**
 * Copilot-style suggestions for KesherAI's code editor. The model is the one
 * chosen in Settings → Active models → "Code suggestions (inline)" (any chat
 * model: local, another computer's, or a cloud one), or the one the editor
 * names. Off when none is chosen.
 */
export function codeRoutes(app: FastifyInstance, s: KesherServices): void {
  app.post<{ Body: { prefix?: string; suffix?: string; language?: string; path?: string; model?: string } }>("/api/code/complete", async (req, reply) => {
    const model = (typeof req.body?.model === "string" && req.body.model) || s.config.activeModels.codeInline;
    if (!model) return { text: "", off: true };
    const prefix = String(req.body?.prefix ?? "").slice(-6000);
    const suffix = String(req.body?.suffix ?? "").slice(0, 2000);
    if (!prefix.trim()) return { text: "" };
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 20_000);
    req.raw.on("close", () => stop.abort());
    let streamed = "";
    try {
      const r = await modelTurnFor(s.registry, model)({ messages: [{ role: "user", content: inlinePrompt({ language: String(req.body?.language ?? "code").slice(0, 40), path: String(req.body?.path ?? "").slice(0, 300), prefix, suffix }) }], tools: [] }, stop.signal, (t) => {
        streamed += t;
        // A suggestion is short: stop the model once it has written enough.
        if (streamed.split("\n").length > 16 || streamed.length > 1500) stop.abort();
      }).catch((e: Error) => (stop.signal.aborted && streamed ? { text: streamed } : Promise.reject(e)));
      return { text: cleanInline(r.text || streamed, prefix, suffix), model };
    } catch (err) {
      if (stop.signal.aborted) return { text: "" };
      return reply.code(502).send({ error: (err as Error).message });
    } finally {
      clearTimeout(timer);
    }
  });
}
