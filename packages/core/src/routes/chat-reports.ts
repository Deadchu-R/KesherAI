import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import { ChatReports, chatNumbers, type ChatKind, type ReportVoice } from "../chat-report.js";
import { modelTurnFor } from "../model-turn.js";
import { parseInstagram, parseWhatsApp, type PeopleChat } from "../people-chats.js";
import type { KesherServices } from "../services.js";

/**
 * Chat reading (#/chat-reports; chat-report.ts): a WhatsApp or Instagram chat read into a report by the model on this
 * computer, and follow-up questions about it. An optional part (Settings → Parts → "Chat reading").
 */
export async function chatReportRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const reports = new ChatReports(join(s.paths.root, "chat-reports"));
  const ask = (model?: string) => async (system: string, user: string, signal?: AbortSignal) => {
    const id = model || s.config.activeModels.chat;
    if (!id) throw Object.assign(new Error("Choose a chat model first (Models page)."), { statusCode: 409 });
    const r = await modelTurnFor(s.registry, id)({ messages: [{ role: "system", content: system }, { role: "user", content: user }], tools: [] }, signal ?? AbortSignal.timeout(20 * 60_000), () => undefined);
    return r.text;
  };
  const parse = (b: { source?: string; title?: string; text?: string; parts?: unknown[] }): PeopleChat => {
    const title = String(b.title ?? "").trim().slice(0, 60);
    const chat = b.source === "instagram" ? parseInstagram(Array.isArray(b.parts) ? b.parts.slice(0, 200) : []) : parseWhatsApp(String(b.text ?? ""), title || "WhatsApp");
    if (title) chat.title = title;
    return chat;
  };
  const off = () => s.config.parts?.["chat-reports"] === false;

  app.get("/api/chat-reports", async () => ({ reports: off() ? [] : await reports.list() }));
  /** Who is in a chat file and how much (before choosing who "I" am). */
  app.post<{ Body: { source?: string; title?: string; text?: string; parts?: unknown[] } }>("/api/chat-reports/peek", { bodyLimit: 300 * 1024 * 1024 }, async (req, reply) => {
    try {
      const chat = parse(req.body ?? {});
      const n = chatNumbers(chat);
      return { title: chat.title, messages: n.messages, from: n.from, to: n.to, people: n.people.slice(0, 30).map((p) => ({ name: p.name, messages: p.messages })) };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.post<{ Body: { source?: string; title?: string; text?: string; parts?: unknown[]; kind?: string; voice?: string; lang?: string; me?: string; backstory?: string; model?: string } }>("/api/chat-reports", { bodyLimit: 300 * 1024 * 1024 }, async (req, reply) => {
    if (off()) return reply.code(409).send({ error: "Chat reading is off (Settings → Parts)." });
    const b = req.body ?? {};
    let chat: PeopleChat;
    try {
      chat = parse(b);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    const kind = (["couple", "friends", "family", "group", "work"].includes(String(b.kind)) ? b.kind : "friends") as ChatKind;
    const voice = (["coach", "friend", "roast"].includes(String(b.voice)) ? b.voice : "friend") as ReportVoice;
    const lang = b.lang === "en" ? "en" : "he";
    const r = await reports.start(chat, { kind, voice, lang, ...(b.me ? { me: String(b.me).slice(0, 80) } : {}), ...(b.backstory ? { backstory: String(b.backstory).slice(0, 1000) } : {}) }, ask(typeof b.model === "string" ? b.model : undefined));
    return { id: r.id };
  });
  app.get<{ Params: { id: string } }>("/api/chat-reports/:id", async (req) => reports.get(req.params.id));
  app.post<{ Params: { id: string }; Body: { question?: string; model?: string } }>("/api/chat-reports/:id/ask", async (req) => reports.followUp(req.params.id, String(req.body?.question ?? ""), ask(typeof req.body?.model === "string" ? req.body.model : undefined)));
  app.delete<{ Params: { id: string } }>("/api/chat-reports/:id", async (req) => {
    await reports.remove(req.params.id);
    return { ok: true };
  });
}
