import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import { ChatReports, chatNumbers, type ChatKind, type ReportVoice } from "../chat-report.js";
import { modelTurnFor } from "../model-turn.js";
import { parseInstagram, parseWhatsApp, type PeopleChat } from "../people-chats.js";
import type { KesherServices } from "../services.js";
import { documentText } from "@kesher/agent";

/**
 * Chat reading (#/chat-reports; chat-report.ts): a WhatsApp or Instagram chat read into a report by the model on this
 * computer, and follow-up questions about it. An optional part (Settings → Parts → "Relationship analysis").
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
  // Reports cut off by a restart (an update) go on by themselves, soon after start-up (the model loads on demand).
  setTimeout(() => { if (!off()) void reports.resume(ask()).catch(() => undefined); }, 3000).unref();

  app.get("/api/chat-reports", async () => ({ reports: off() ? [] : await reports.list() }));
  /** The chats already uploaded, to start another report from one without uploading it again. */
  app.get("/api/chat-reports/chats", async () => ({ chats: off() ? [] : await reports.chats() }));
  /** Who is in a chat file and how much (before choosing who "I" am). */
  app.post<{ Body: { source?: string; title?: string; text?: string; parts?: unknown[]; fromReport?: string } }>("/api/chat-reports/peek", { bodyLimit: 300 * 1024 * 1024 }, async (req, reply) => {
    try {
      const b = req.body ?? {};
      // A chat already uploaded (another report's copy), or a new file.
      const chat = b.fromReport ? await reports.chatOf(String(b.fromReport)) : parse(b);
      const n = chatNumbers(chat);
      return { title: chat.title, messages: n.messages, from: n.from, to: n.to, people: n.people.slice(0, 30).map((p) => ({ name: p.name, messages: p.messages })) };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.post<{ Body: { source?: string; title?: string; text?: string; parts?: unknown[]; fromReport?: string; kind?: string; voice?: string; lang?: string; me?: string; backstory?: string; model?: string; names?: Record<string, string> } }>("/api/chat-reports", { bodyLimit: 300 * 1024 * 1024 }, async (req, reply) => {
    if (off()) return reply.code(409).send({ error: "Relationship analysis is off (Settings → Parts)." });
    const b = req.body ?? {};
    let chat: PeopleChat;
    try {
      chat = b.fromReport ? await reports.chatOf(String(b.fromReport)) : parse(b);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    const kind = (["couple", "ex", "friends", "family", "group", "work"].includes(String(b.kind)) ? b.kind : "friends") as ChatKind;
    const voice = (["coach", "friend", "roast"].includes(String(b.voice)) ? b.voice : "friend") as ReportVoice;
    const lang = b.lang === "en" ? "en" : "he";
    const r = await reports.start(chat, { kind, voice, lang, ...(b.me ? { me: String(b.me).slice(0, 80) } : {}), ...(b.backstory ? { backstory: String(b.backstory).slice(0, 1000) } : {}), ...(b.names && typeof b.names === "object" ? { names: Object.fromEntries(Object.entries(b.names).slice(0, 60).map(([k, v]) => [String(k).slice(0, 80), String(v).slice(0, 60)])) } : {}) }, ask(typeof b.model === "string" ? b.model : undefined));
    return { id: r.id };
  });
  app.get<{ Params: { id: string } }>("/api/chat-reports/:id", async (req) => reports.live(req.params.id));
  // A report that failed (a context error, the model stopped): written again from the chat it has.
  app.post<{ Params: { id: string }; Body: { model?: string } }>("/api/chat-reports/:id/retry", async (req) => reports.retry(req.params.id, ask(typeof req.body?.model === "string" ? req.body.model : undefined)));
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
    if (off()) return reply.code(409).send({ error: "Relationship analysis is off (Settings → Parts)." });
    const b = req.body ?? {};
    const lang = b.lang === "en" ? "en" : "he";
    const he = lang === "he";
    let url = "";
    if (b.url) {
      url = String(b.url).trim();
      if (!/^https:\/\/[^\s]+$/i.test(url)) return reply.code(400).send({ error: he ? "צריך קישור שמתחיל ב-https." : "An https link to the report." });
      if (!s.browser.status().pane) return reply.code(409).send({ error: he ? "ייבוא מקישור צריך את הדפדפן של KesherAI במחשב (האפליקציה במחשב פתוחה). אפשר בינתיים לשמור את הדוח כ-PDF או להדביק את הטקסט שלו." : "Importing from a link needs KesherAI's own browser (the desktop app open). Save the report as a PDF instead, or paste its text." });
    } else if (!b.pdf && String(b.text ?? "").trim().length < 200) return reply.code(400).send({ error: he ? "הטקסט קצר מדי בשביל דוח." : "That is too short to be a report." });
    // Returns at once; the report page shows each step (design ImportSteps).
    const r = await reports.importStart(async (step) => {
      if (url) {
        await step("open");
        await s.browser.call("open", { url });
        // The page is built by script: read until its text stops growing (at most about 45 seconds).
        await step("wait");
        let text = "";
        let title = "";
        for (let i = 0, same = 0; i < 15 && same < 2; i++) {
          await new Promise((ok) => setTimeout(ok, 3000));
          const page = await s.browser.call<{ title?: string; text?: string }>("read", {}).catch(() => undefined);
          const next = page?.text ?? "";
          same = next.length > 200 && next.length === text.length ? same + 1 : 0;
          text = next;
          title = page?.title ?? title;
          await step("wait", String(text.length));
        }
        // A sign-in page instead of the report: say what to do.
        if (text.length < 3000 && /sign in|log in|enter your email|send code|התחבר/i.test(text)) {
          throw new Error(he ? "האתר ביקש להתחבר. במחשב: פתח את KesherAI ← דפדפן, היכנס ל-whatbrandonthinks.com והתחבר לחשבון שלך, ואז ייבא שוב. אפשר גם לשמור את הדוח כ-PDF או להדביק את הטקסט שלו." : "The site asked you to sign in. On the computer: open KesherAI → Browser, go to whatbrandonthinks.com and sign in, then import again. Or save the report as a PDF, or paste its text.");
        }
        return `${title}\n\n${text}`;
      }
      if (b.pdf) return (await documentText(new Uint8Array(Buffer.from(String(b.pdf), "base64")), "report.pdf")).pages.join("\n\n");
      return String(b.text ?? "");
    }, lang, ask(typeof b.model === "string" ? b.model : undefined));
    return { id: r.id };
  });
  app.delete<{ Params: { id: string } }>("/api/chat-reports/:id", async (req) => {
    await reports.remove(req.params.id);
    return { ok: true };
  });
}
