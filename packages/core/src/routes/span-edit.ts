import type { FastifyInstance } from "fastify";
import { cleanSpanAnswer, cleanSpanPartial, spanEditPrompt, stripContextEcho, withoutFenceLines } from "@kesher/shared";
import type { KesherServices } from "../services.js";
import { modelTurnFor } from "../conversations.js";
import { startSSE } from "../sse.js";

/**
 * Highlight-to-edit (shared/span-edit.ts): the side panel sends the selected span with the text around it and the
 * user's instruction; the chat model (Settings → Active models → Chat, or the one named) answers with the new text for
 * the span only. The page shows it as a diff and saves it on Accept, so nothing changes here. Works the same from the
 * phone connected to the PC (the page sends the text, not a file path). With `stream: true` the answer comes as Server-Sent
 * Events (`delta` with the text so far, then `done` with the cleaned text, or `error`), so the page can show the rewrite
 * as it is written; without it, one JSON answer.
 */
export function spanEditRoutes(app: FastifyInstance, s: KesherServices): void {
  app.post<{ Body: { kind?: string; language?: string; title?: string; before?: string; selected?: string; after?: string; instruction?: string; model?: string; stream?: boolean; fenced?: boolean } }>("/api/span-edit", { bodyLimit: 256 * 1024 }, async (req, reply) => {
    const b = req.body ?? {};
    const model = (typeof b.model === "string" && b.model) || s.config.activeModels.chat;
    if (!model) return reply.code(409).send({ error: "Choose a chat model first (Models page)." });
    const selected = String(b.selected ?? "").slice(0, 8000);
    const instruction = String(b.instruction ?? "").trim().slice(0, 2000);
    if (!selected.trim() || !instruction) return reply.code(400).send({ error: "Select some text and say what to change." });
    const before = String(b.before ?? "").slice(-3000);
    const after = String(b.after ?? "").slice(0, 3000);
    const prompt = spanEditPrompt({
      kind: b.kind === "code" ? "code" : "doc",
      language: String(b.language ?? "").slice(0, 40),
      title: String(b.title ?? "").slice(0, 120),
      before,
      selected,
      after,
      instruction,
    });
    /** The answer as the span's text: tags and fences cleaned, the neighbours not repeated, no fence lines inside a document's code block. */
    const finish = (raw: string) => {
      const t = stripContextEcho(cleanSpanAnswer(raw), before, after);
      return b.fenced ? withoutFenceLines(t) : t;
    };
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 3 * 60_000);
    const sse = b.stream ? startSSE(req, reply) : null;
    if (sse) sse.closed.addEventListener("abort", () => stop.abort());
    else reply.raw.on("close", () => !reply.raw.writableFinished && stop.abort());
    try {
      let soFar = "";
      const r = await modelTurnFor(s.registry, model)({ messages: [{ role: "user", content: prompt }], tools: [] }, stop.signal, (t) => {
        if (!sse) return;
        soFar += t;
        sse.send({ type: "delta", text: cleanSpanPartial(soFar) });
      });
      const text = finish(r.text);
      if (sse) {
        sse.send({ type: "done", text, model });
        return;
      }
      return { text, model };
    } catch (err) {
      const message = stop.signal.aborted ? "The model took too long." : (err as Error).message;
      if (sse) sse.send({ type: "error", message });
      else return reply.code(502).send({ error: message });
    } finally {
      clearTimeout(timer);
      sse?.end();
    }
  });
}
