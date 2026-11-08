import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";
import { pagePrompt, type Pages } from "../pages.js";
import { modelTurnFor } from "../conversations.js";
import { conversationHtml } from "../chat-export.js";
import type { Conversation } from "@kesher/shared";

/**
 * Pages: documents written with the agent. CRUD, the writing requests
 * (rewrite a selection, write the next part), and export.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 * @param pages - The pages store.
 */
export async function pagesRoutes(app: FastifyInstance, s: KesherServices, pages: Pages): Promise<void> {
  app.get("/api/pages", async () => pages.list());
  app.post<{ Body: { title?: string; content?: string } }>("/api/pages", async (req) => pages.save({ title: req.body?.title ?? "Untitled", content: req.body?.content ?? "" }));
  app.get<{ Params: { id: string } }>("/api/pages/:id", async (req, reply) => (await pages.get(req.params.id)) ?? reply.code(404).send({ error: "Page not found" }));
  app.put<{ Params: { id: string }; Body: { title?: string; content?: string } }>("/api/pages/:id", { bodyLimit: 10 * 1024 * 1024 }, async (req, reply) => {
    if (!(await pages.get(req.params.id))) return reply.code(404).send({ error: "Page not found" });
    return pages.save({ id: req.params.id, ...(typeof req.body?.title === "string" ? { title: req.body.title } : {}), ...(typeof req.body?.content === "string" ? { content: req.body.content } : {}) });
  });
  app.delete<{ Params: { id: string } }>("/api/pages/:id", async (req) => {
    await pages.remove(req.params.id);
    return { ok: true };
  });

  /**
   * A writing request. Body: `{ action?, instruction?, selection?, content? }`
   * (`content`: the text as it is in the editor now). Answers `{ text }`: what
   * replaces the selection, or goes where the cursor is.
   */
  app.post<{ Params: { id: string }; Body: { action?: string; instruction?: string; selection?: string; content?: string } }>("/api/pages/:id/write", { bodyLimit: 10 * 1024 * 1024 }, async (req, reply) => {
    const page = await pages.get(req.params.id);
    if (!page) return reply.code(404).send({ error: "Page not found" });
    const chat = s.config.activeModels.chat;
    if (!chat) return reply.code(400).send({ error: "Choose a chat model first; it writes with you." });
    const b = req.body ?? {};
    if (!b.action && !b.instruction?.trim()) return reply.code(400).send({ error: "Say what to write." });
    const ac = new AbortController();
    reply.raw.on("close", () => !reply.raw.writableFinished && ac.abort());
    try {
      const r = await modelTurnFor(s.registry, chat)({ messages: pagePrompt({ title: page.title, content: b.content ?? page.content }, { ...(b.action ? { action: b.action } : {}), ...(b.instruction ? { instruction: b.instruction } : {}), ...(b.selection ? { selection: b.selection } : {}) }), tools: [] }, ac.signal, () => undefined);
      const text = r.text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```\s*$/, "$1").trim();
      return { text };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /** The page as Markdown (`?format=md`) or a print-ready page (`html`, `&print=1` for Save as PDF). */
  app.get<{ Params: { id: string }; Querystring: { format?: string; print?: string } }>("/api/pages/:id/export", async (req, reply) => {
    const page = await pages.get(req.params.id);
    if (!page) return reply.code(404).send({ error: "Page not found" });
    if (req.query.format !== "html") {
      reply.header("content-disposition", `attachment; filename="page.md"; filename*=UTF-8''${encodeURIComponent(`${page.title}.md`)}`);
      return reply.type("text/markdown; charset=utf-8").send(page.content);
    }
    // The chat page layout, with the document as one block.
    const asChat = { id: page.id, title: page.title, createdAt: page.updatedAt, modelId: "", events: [{ seq: 1, at: page.updatedAt, type: "assistant", turn: 1, text: page.content }] } as unknown as Conversation;
    const html = conversationHtml(asChat, !!req.query.print).replace(/<div class="who">[^<]*<\/div>/, "").replace(/<div class="meta">[^<]*<\/div>/, "");
    return reply.type("text/html; charset=utf-8").send(html);
  });
}
