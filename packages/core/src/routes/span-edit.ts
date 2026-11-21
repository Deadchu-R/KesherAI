import type { FastifyInstance } from "fastify";
import { cleanSpanAnswer, spanEditPrompt } from "@kesher/shared";
import type { KesherServices } from "../services.js";
import { modelTurnFor } from "../conversations.js";

/**
 * Highlight-to-edit (shared/span-edit.ts): the side panel sends the selected span with the text around it and the
 * user's instruction; the chat model (Settings → Active models → Chat, or the one named) answers with the new text for
 * the span only. The page shows it as a diff and saves it on Accept, so nothing changes here. Works the same from the
 * phone connected to the PC (the page sends the text, not a file path).
 */
export function spanEditRoutes(app: FastifyInstance, s: KesherServices): void {
  app.post<{ Body: { kind?: string; language?: string; title?: string; before?: string; selected?: string; after?: string; instruction?: string; model?: string } }>("/api/span-edit", { bodyLimit: 256 * 1024 }, async (req, reply) => {
    const b = req.body ?? {};
    const model = (typeof b.model === "string" && b.model) || s.config.activeModels.chat;
    if (!model) return reply.code(409).send({ error: "Choose a chat model first (Models page)." });
    const selected = String(b.selected ?? "").slice(0, 8000);
    const instruction = String(b.instruction ?? "").trim();
    if (!selected.trim() || !instruction) return reply.code(400).send({ error: "Select some text and say what to change." });
    const prompt = spanEditPrompt({
      kind: b.kind === "code" ? "code" : "doc",
      language: String(b.language ?? "").slice(0, 40),
      title: String(b.title ?? "").slice(0, 120),
      before: String(b.before ?? "").slice(-3000),
      selected,
      after: String(b.after ?? "").slice(0, 3000),
      instruction,
    });
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 3 * 60_000);
    reply.raw.on("close", () => !reply.raw.writableFinished && stop.abort());
    try {
      const r = await modelTurnFor(s.registry, model)({ messages: [{ role: "user", content: prompt }], tools: [] }, stop.signal, () => undefined);
      return { text: cleanSpanAnswer(r.text), model };
    } catch (err) {
      return reply.code(502).send({ error: stop.signal.aborted ? "The model took too long." : (err as Error).message });
    } finally {
      clearTimeout(timer);
    }
  });
}
