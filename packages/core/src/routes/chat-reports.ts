import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import { ChatReports, chatNumbers, type ChatKind, type ReportVoice } from "../chat-report.js";
import { modelTurnFor } from "../model-turn.js";
import { parseInstagram, parseWhatsApp, type PeopleChat } from "../people-chats.js";
import type { KesherServices } from "../services.js";
import { documentText } from "@kesher/agent";

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
  app.post<{ Body: { source?: string; title?: string; text?: string; parts?: unknown[]; kind?: string; voice?: string; lang?: string; me?: string; backstory?: string; model?: string; names?: Record<string, string> } }>("/api/chat-reports", { bodyLimit: 300 * 1024 * 1024 }, async (req, reply) => {
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
    const r = await reports.start(chat, { kind, voice, lang, ...(b.me ? { me: String(b.me).slice(0, 80) } : {}), ...(b.backstory ? { backstory: String(b.backstory).slice(0, 1000) } : {}), ...(b.names && typeof b.names === "object" ? { names: Object.fromEntries(Object.entries(b.names).slice(0, 60).map(([k, v]) => [String(k).slice(0, 80), String(v).slice(0, 60)])) } : {}) }, ask(typeof b.model === "string" ? b.model : undefined));
    return { id: r.id };
  });
  app.get<{ Params: { id: string } }>("/api/chat-reports/:id", async (req) => reports.get(req.params.id));
  app.post<{ Params: { id: string }; Body: { question?: string; model?: string } }>("/api/chat-reports/:id/ask", async (req) => reports.followUp(req.params.id, String(req.body?.question ?? ""), ask(typeof req.body?.model === "string" ? req.body.model : undefined)));
  /** "Want to know more?": a few words, or another export of the chat (or the chat of an imported report). */
  app.post<{ Params: { id: string }; Body: { text?: string; source?: string; title?: string; chatText?: string; parts?: unknown[]; model?: string } }>("/api/chat-reports/:id/add", { bodyLimit: 300 * 1024 * 1024 }, async (req, reply) => {
    const b = req.body ?? {};
    let chat: PeopleChat | undefined;
    try {
      if (b.chatText || b.parts) chat = parse({ source: b.source, title: b.title, text: b.chatText, parts: b.parts });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    const r = await reports.add(req.params.id, { ...(b.text ? { text: String(b.text) } : {}), ...(chat ? { chat } : {}) }, ask(typeof b.model === "string" ? b.model : undefined));
    return { id: r.id, version: r.version };
  });
  /**
   * A report from What Brandon Thinks: its link (opened in KesherAI's own browser pane, with the user's sign-in there;
   * the page is built by script, so a plain download is empty), a PDF saved from it, or its text.
   */
  app.post<{ Body: { url?: string; pdf?: string; text?: string; lang?: string; model?: string } }>("/api/chat-reports/import", { bodyLimit: 60 * 1024 * 1024 }, async (req, reply) => {
    if (off()) return reply.code(409).send({ error: "Chat reading is off (Settings → Parts)." });
    const b = req.body ?? {};
    let text = String(b.text ?? "");
    if (b.url) {
      const url = String(b.url).trim();
      if (!/^https:\/\/[^\s]+$/i.test(url)) return reply.code(400).send({ error: "An https link to the report." });
      if (!s.browser.status().pane) return reply.code(409).send({ error: "Importing from a link needs KesherAI's own browser (the desktop app). Save the report as a PDF instead, or paste its text." });
      const page = await s.browser.call<{ title?: string; text?: string }>("open", { url });
      text = `${page.title ?? ""}\n\n${page.text ?? ""}`;
    } else if (b.pdf) {
      text = (await documentText(new Uint8Array(Buffer.from(String(b.pdf), "base64")), "report.pdf")).pages.join("\n\n");
    }
    const r = await reports.importReport(text, b.lang === "en" ? "en" : "he", ask(typeof b.model === "string" ? b.model : undefined));
    return { id: r.id };
  });
  app.delete<{ Params: { id: string } }>("/api/chat-reports/:id", async (req) => {
    await reports.remove(req.params.id);
    return { ok: true };
  });
}
