import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";
import type { ActionItem, Entity, JournalSettings } from "../journal.js";

/**
 * "My day" (the journal): settings, the day, replay pictures, reflect,
 * entities, actions and search. All of it stays on this computer, so every
 * route answers only requests from this computer, even with remote access on.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function journalRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const local = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Your day's journal is only available on the computer it records." });
  };
  const opts = { preHandler: local };

  app.get("/api/journal", opts, async () => s.journal.info());
  app.put<{ Body: Partial<JournalSettings> }>("/api/journal/settings", opts, async (req) => s.journal.update(req.body ?? {}));
  app.post<{ Body: { minutes?: number } }>("/api/journal/pause", opts, async (req) => {
    const m = Number(req.body?.minutes ?? 30);
    return s.journal.update({ pausedUntil: m > 0 ? Date.now() + m * 60_000 : 0 });
  });
  app.post<{ Body: { minutes?: number } }>("/api/journal/forget-recent", opts, async (req) => ({ removed: await s.journal.forgetRecent(Math.min(24 * 60, Math.max(1, Number(req.body?.minutes ?? 15)))) }));

  app.get<{ Params: { day: string } }>("/api/journal/day/:day", opts, async (req) => s.journal.day(req.params.day));
  app.delete<{ Params: { day: string } }>("/api/journal/day/:day", opts, async (req) => {
    await s.journal.forgetDay(req.params.day);
    return { ok: true };
  });
  app.post<{ Params: { day: string }; Body: { all?: boolean } }>("/api/journal/day/:day/summarize", opts, async (req) => s.journal.summarize(req.params.day, !!req.body?.all));
  app.get<{ Params: { day: string } }>("/api/journal/week/:day", opts, async (req) => s.journal.week(req.params.day));
  app.get<{ Params: { day: string; file: string } }>("/api/journal/frame/:day/:file", opts, async (req, reply) => {
    const img = await s.journal.frame(req.params.day, req.params.file);
    if (!img) return reply.code(404).send({ error: "This picture is no longer kept." });
    const png = img[0] === 0x89 && img[1] === 0x50;
    return reply.type(png ? "image/png" : "image/jpeg").header("cache-control", "private, max-age=86400").send(img);
  });

  // Meetings: the app records the call (microphone + the call's sound), sends each half-minute piece to
  // /api/speech/transcribe, and adds the text here; at the end the model writes it up.
  app.post<{ Body: { title?: string } }>("/api/journal/meetings", opts, async (req) => s.journal.startMeeting(String(req.body?.title ?? "")));
  app.get<{ Params: { day: string } }>("/api/journal/meetings/:day", opts, async (req) => s.journal.meetings(req.params.day));
  app.post<{ Params: { day: string; id: string }; Body: { t?: number; text?: string; who?: string } }>("/api/journal/meetings/:day/:id/segment", opts, async (req, reply) => {
    try {
      const who = req.body?.who === "me" || req.body?.who === "others" ? req.body.who : undefined;
      const m = await s.journal.addSegment(req.params.day, req.params.id, Number(req.body?.t ?? Date.now()), String(req.body?.text ?? ""), who);
      return { segments: m.segments.length };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });
  app.post<{ Params: { day: string; id: string } }>("/api/journal/meetings/:day/:id/finish", opts, async (req, reply) => {
    try {
      return await s.journal.finishMeeting(req.params.day, req.params.id);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });
  app.delete<{ Params: { day: string; id: string } }>("/api/journal/meetings/:day/:id", opts, async (req) => {
    await s.journal.deleteMeeting(req.params.day, req.params.id).catch(() => undefined);
    return { ok: true };
  });

  app.get("/api/journal/actions", opts, async () => s.journal.openActions());
  app.patch<{ Params: { day: string; id: string }; Body: { state: ActionItem["state"] } }>("/api/journal/actions/:day/:id", opts, async (req, reply) => {
    if (!["open", "done", "dismissed"].includes(req.body?.state)) return reply.code(400).send({ error: "state must be open, done or dismissed" });
    return s.journal.setAction(req.params.day, req.params.id, req.body.state);
  });

  app.get("/api/journal/entities", opts, async () => s.journal.listEntities());
  app.patch<{ Params: { id: string }; Body: { name?: string; kind?: Entity["kind"]; hidden?: boolean; parent?: string | null; merge?: string[] } }>("/api/journal/entities/:id", opts, async (req, reply) => {
    const e = await s.journal.editEntity(req.params.id, req.body ?? {});
    return e ?? reply.code(404).send({ error: "No such entity" });
  });

  /** Searches the journal and every saved conversation. */
  app.get<{ Querystring: { q?: string } }>("/api/journal/search", opts, async (req) => {
    const q = (req.query.q ?? "").trim();
    if (!q) return { journal: [], conversations: [] };
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const conversations: Array<{ id: string; title: string; snippet: string; updatedAt: string }> = [];
    for (const c of s.library.listConversations()) {
      if (conversations.length >= 30) break;
      const full = await s.library.getConversation(c.id);
      const body = `${c.title}\n${(full?.messages ?? []).map((m) => (typeof m.content === "string" ? m.content : "")).join("\n")}`;
      const low = body.toLowerCase();
      if (!words.every((w) => low.includes(w))) continue;
      const i = Math.max(0, low.indexOf(words[0]!) - 60);
      conversations.push({ id: c.id, title: c.title, snippet: (i ? "…" : "") + body.slice(i, i + 200).replace(/\s+/g, " "), updatedAt: c.updatedAt });
    }
    return { journal: await s.journal.search(q), conversations };
  });
}
