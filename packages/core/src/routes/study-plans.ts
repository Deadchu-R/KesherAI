import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { jsonOf } from "../chat-report.js";
import { modelTurnFor } from "../model-turn.js";
import { checkPlan, planPrompt, StudyPlans, type StudyPlan } from "../study-plans.js";
import type { KesherServices } from "../services.js";

/**
 * Study → an assignment broken into steps in the days before it is due (study-plans.ts, design DeadlinePlan), and
 * those steps on Google Calendar when it is connected.
 */
export async function studyPlanRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const plans = new StudyPlans(join(s.paths.root, "study", "plans.json"));
  const ask = async (system: string, user: string) => {
    const id = s.config.activeModels.chat;
    if (!id) throw Object.assign(new Error("Choose a chat model first (Models page)."), { statusCode: 409 });
    return (await modelTurnFor(s.registry, id)({ messages: [{ role: "system", content: system }, { role: "user", content: user }], tools: [] }, AbortSignal.timeout(10 * 60_000), () => undefined)).text;
  };
  const make = async (p: { title: string; course: string; due: number; details?: string; lang: "he" | "en" }, id?: string): Promise<StudyPlan> => {
    const busy = await plans.busy(id);
    const now = Date.now();
    const user = `Assignment: ${p.title}\nCourse: ${p.course}\n${p.details ? `Details: ${p.details}\n` : ""}Today: ${new Date(now).toISOString().slice(0, 10)}\nDue: ${new Date(p.due).toISOString().slice(0, 16)}\nAlready planned (minutes per day): ${JSON.stringify(busy)}`;
    const raw = await ask(planPrompt(p.lang), user).then(jsonOf, () => undefined);
    return plans.put({ id: id ?? randomUUID(), title: p.title, course: p.course, due: p.due, steps: checkPlan(raw, now, p.due, busy, p.lang), createdAt: now });
  };

  app.get("/api/study/plans", async () => ({ plans: await plans.list(), calendar: s.google.has("calendar") }));
  app.post<{ Body: { title?: string; course?: string; due?: number; details?: string; lang?: string } }>("/api/study/plans", async (req, reply) => {
    const b = req.body ?? {};
    const title = String(b.title ?? "").trim().slice(0, 160);
    const due = Number(b.due);
    if (!title || !(due > Date.now() - 86_400_000)) return reply.code(400).send({ error: "What is due, and when?" });
    return make({ title, course: String(b.course ?? "").slice(0, 120), due, details: String(b.details ?? "").slice(0, 2000), lang: b.lang === "en" ? "en" : "he" });
  });
  app.post<{ Params: { id: string } }>("/api/study/plans/:id/replan", async (req, reply) => {
    const p = await plans.get(req.params.id);
    if (!p) return reply.code(404).send({ error: "No such plan." });
    return make({ title: p.title, course: p.course, due: p.due, lang: /\p{Script=Hebrew}/u.test(p.title) ? "he" : "en" }, p.id);
  });
  app.post<{ Params: { id: string; i: string }; Body: { done?: boolean } }>("/api/study/plans/:id/steps/:i", async (req, reply) => {
    const p = await plans.get(req.params.id);
    const step = p?.steps[Number(req.params.i)];
    if (!p || !step) return reply.code(404).send({ error: "No such step." });
    step.done = req.body?.done === true;
    return plans.put(p);
  });
  app.delete<{ Params: { id: string } }>("/api/study/plans/:id", async (req) => {
    await plans.remove(req.params.id);
    return { ok: true };
  });
  /** The plan's steps as events on her Google Calendar (in the evening, 18:00 onward, one after another). */
  app.post<{ Params: { id: string } }>("/api/study/plans/:id/calendar", async (req, reply) => {
    const p = await plans.get(req.params.id);
    if (!p) return reply.code(404).send({ error: "No such plan." });
    if (!s.google.has("calendar")) return reply.code(409).send({ error: "Connect Google Calendar first (Settings → Accounts)." });
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const base = `${s.google.base("calendar")}/calendars/primary/events?sendUpdates=none`;
    const startOf: Record<string, number> = {};
    for (const st of p.steps.filter((x) => !x.done)) {
      const from = startOf[st.date] ?? 18 * 60;
      startOf[st.date] = from + st.minutes;
      const hm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      await s.google.api(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ summary: `${st.title} · ${p.title}`, description: p.course, start: { dateTime: `${st.date}T${hm(from)}:00`, timeZone: tz }, end: { dateTime: `${st.date}T${hm(from + st.minutes)}:00`, timeZone: tz } }) });
    }
    return plans.put({ ...p, calendar: true });
  });
}
