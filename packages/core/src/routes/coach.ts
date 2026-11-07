import type { FastifyInstance } from "fastify";
import { requestStats } from "../coach.js";
import { modelTurnFor } from "../conversations.js";
import type { KesherServices } from "../services.js";

/**
 * Usage and the coach: what each request cost in tokens and how much was
 * wasted, totals across conversations, and suggestions to do better.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function coachRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  /** Per-request tokens, waste, failed steps and tools for one conversation. */
  app.get<{ Params: { id: string } }>("/api/conversations/:id/usage", async (req, reply) => {
    const c = await s.library.getConversation(req.params.id);
    if (!c) return reply.code(404).send({ error: "Conversation not found" });
    const live = (await s.conversations.open(req.params.id))?.session.events ?? c.events;
    return requestStats(live);
  });

  /** Asks the coach about a conversation. Body: `{ modelId? }` (defaults to the coach setting, then the conversation's model). */
  app.post<{ Params: { id: string }; Body: { modelId?: string } }>("/api/conversations/:id/coach", async (req, reply) => {
    const opened = await s.conversations.open(req.params.id);
    if (!opened) return reply.code(404).send({ error: "Conversation not found" });
    const conversation = { ...opened.conversation, events: opened.session.events };
    const modelId = req.body?.modelId ?? s.config.coach.modelId ?? opened.session.modelId;
    try {
      s.registry.resolve(modelId);
    } catch {
      return reply.code(400).send({ error: `The coach model ${modelId} is not connected.` });
    }
    try {
      const result = await s.coach.analyze(conversation, modelTurnFor(s.registry, modelId), s.conversations.setupOf(conversation), AbortSignal.timeout(180_000));
      return { modelId, ...result };
    } catch (err) {
      return reply.code(502).send({ error: `The coach could not answer: ${(err as Error).message}` });
    }
  });

  /** Totals across every conversation: tokens, waste, per model and per day. */
  app.get("/api/usage", async () => {
    const totals = { requests: 0, calls: 0, inputTokens: 0, outputTokens: 0, wastedTokens: 0, failedSteps: 0, estimated: false };
    const byModel: Record<string, number> = {};
    const byDay: Record<string, number> = {};
    const costly: Array<{ conversationId: string; title: string; prompt: string; tokens: number; wasted: number }> = [];
    for (const summary of s.library.listConversations()) {
      const c = await s.library.getConversation(summary.id);
      if (!c) continue;
      const stats = requestStats(c.events);
      const days = c.events.filter((e) => e.type === "user").map((e) => e.at.slice(0, 10));
      stats.forEach((r, i) => {
        const tokens = r.inputTokens + r.outputTokens;
        totals.requests++;
        totals.calls += r.calls;
        totals.inputTokens += r.inputTokens;
        totals.outputTokens += r.outputTokens;
        totals.wastedTokens += r.wastedTokens;
        totals.failedSteps += r.failedSteps;
        totals.estimated ||= r.estimated;
        for (const [m, n] of Object.entries(r.byModel)) byModel[m] = (byModel[m] ?? 0) + n;
        const day = days[i];
        if (day) byDay[day] = (byDay[day] ?? 0) + tokens;
        if (tokens > 0) costly.push({ conversationId: c.id, title: c.title, prompt: r.prompt.slice(0, 160), tokens, wasted: r.wastedTokens });
      });
    }
    costly.sort((a, b) => b.tokens - a.tokens);
    return { totals, byModel, byDay, costly: costly.slice(0, 10) };
  });

  /** What the coach has learned about how the user works. */
  app.get("/api/coach/profile", async () => ({ ...(await s.coach.profile()), learn: s.config.coach.learn, modelId: s.config.coach.modelId ?? null }));

  /** Coach settings: `{ learn?, modelId? }` (`modelId: null` = use each conversation's model). */
  app.put<{ Body: { learn?: boolean; modelId?: string | null } }>("/api/coach/settings", async (req) => {
    const b = req.body ?? {};
    if (typeof b.learn === "boolean") s.config.coach.learn = b.learn;
    if (b.modelId === null) delete s.config.coach.modelId;
    else if (typeof b.modelId === "string") s.config.coach.modelId = b.modelId;
    await s.saveConfig();
    return { ok: true };
  });

  /** Removes one learned note (by index), or all of them (no index). */
  app.delete<{ Querystring: { index?: string } }>("/api/coach/profile", async (req) => {
    const p = await s.coach.profile();
    if (req.query.index === undefined) await s.coach.reset();
    else {
      p.notes.splice(Number(req.query.index), 1);
      await s.coach.save(p);
    }
    return s.coach.profile();
  });
}
