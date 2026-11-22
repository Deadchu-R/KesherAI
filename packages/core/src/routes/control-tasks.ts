import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ProviderRegistry } from "@kesher/providers";
import { isLocalRequest, pairedDeviceIdOf, pairedDeviceOf } from "../auth.js";
import { ControlTasks, type ControlPlanner } from "../control-task.js";
import { parseTaskRequest } from "../control-task-rules.js";
import { heavyGate } from "../heavy-gate.js";
import { modelTurnFor } from "../model-turn.js";
import type { KesherServices } from "../services.js";
import { visionServiceOf } from "../vision-service.js";

/**
 * Computer tasks (control-task.ts): one goal in, KesherAI does the steps on this computer, a summary and the last
 * screenshot out. For Claude, Roee or the phone (remote); only from this computer or a paired device.
 *
 * - POST /api/control/tasks `{ goal, apps?, maxSteps? (40), maxMinutes? (15), model? ("auto"|"gemini"|"local") }` → `{ id }`
 * - GET  /api/control/tasks/:id → `{ status, step, steps, summary, lastShot, question? … }`
 * - POST /api/control/tasks/:id/stop
 * - POST /api/control/tasks/:id/answer `{ text }` (when status is needs-you)
 * - GET  /api/control/tasks → `{ current }` (the running task, or the last one for 10 minutes)
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function controlTaskRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const tasks = s.controlTasks ?? (s.controlTasks = buildControlTasks(s));
  /** This computer, or the paired device whose key the request carried; anyone else is refused. */
  const verifiedBy = (req: FastifyRequest): string | undefined => (isLocalRequest(req) ? "pc" : pairedDeviceIdOf(req) ?? pairedDeviceOf(req));
  const refuse = { error: "Only this computer or a paired device can run computer tasks." };

  app.get("/api/control/tasks", async (req, reply) => {
    if (!verifiedBy(req)) return reply.code(403).send(refuse);
    return { current: tasks.current() ?? null };
  });

  app.post<{ Body: unknown }>("/api/control/tasks", async (req, reply) => {
    const by = verifiedBy(req);
    if (!by) return reply.code(403).send(refuse);
    const r = parseTaskRequest(req.body);
    if ("error" in r) return reply.code(400).send({ error: r.error });
    try {
      return tasks.start(r, by);
    } catch (e) {
      const code = (e as { code?: number }).code;
      return reply.code(code === 409 || code === 503 ? code : 400).send({ error: (e as Error).message });
    }
  });

  app.get<{ Params: { id: string } }>("/api/control/tasks/:id", async (req, reply) => {
    if (!verifiedBy(req)) return reply.code(403).send(refuse);
    const t = tasks.get(req.params.id);
    return t ?? reply.code(404).send({ error: "No such computer task (only the last 20 are kept, until KesherAI restarts)." });
  });

  app.post<{ Params: { id: string } }>("/api/control/tasks/:id/stop", async (req, reply) => {
    if (!verifiedBy(req)) return reply.code(403).send(refuse);
    return tasks.stop(req.params.id) ? { ok: true } : reply.code(409).send({ error: "That task is not running." });
  });

  app.post<{ Params: { id: string }; Body: { text?: unknown } }>("/api/control/tasks/:id/answer", async (req, reply) => {
    if (!verifiedBy(req)) return reply.code(403).send(refuse);
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) return reply.code(400).send({ error: "Send { text }." });
    return tasks.answer(req.params.id, text) ? { ok: true } : reply.code(409).send({ error: "That task is not waiting for an answer." });
  });
}

/**
 * The app's computer tasks: computer control, the free Gemini key and the local vision model as planners, main.log.
 *
 * @param s - Services.
 */
export function buildControlTasks(s: KesherServices): ControlTasks {
  const logFile = join(s.paths.root, "logs", "main.log");
  const gemini = geminiPlanner(s.registry);
  return new ControlTasks({
    enabled: () => s.computer.status().enabled,
    uia: () => s.computer.status().uia !== "none",
    paused: () => s.browser.paused(),
    tools: (id) => s.computer.tools(id),
    allow: (id, a) => s.computer.allow(id, a),
    front: () => s.computer.foregroundNow(),
    watch: (w) => s.computer.watch(w),
    planners: () => {
      const v = visionServiceOf(s.config);
      const local: ControlPlanner | undefined = v?.model()
        ? (q, signal) =>
            heavyGate.run({ en: "A computer task (local vision model)", he: "משימת מחשב (מודל ראייה מקומי)" }, () =>
              v.plan({ system: q.system, user: q.user, ...(q.image ? { image: q.image } : {}), signal }), signal)
        : undefined;
      return { ...(s.registry.get("gemini") ? { gemini } : {}), ...(local ? { local } : {}) };
    },
    log: (line) => {
      try {
        mkdirSync(join(s.paths.root, "logs"), { recursive: true });
        appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
      } catch {
        // a log that cannot be written never stops a task
      }
    },
  });
}

/**
 * Plans with the user's free Gemini key (provider "gemini", a free AI Studio key with no billing): flash-latest, the
 * newest Flash, then flash-lite-latest, moving on only when Google says it is busy. The model list is read once per
 * 10 minutes.
 *
 * @param registry - The providers.
 */
export function geminiPlanner(registry: ProviderRegistry): ControlPlanner {
  let cache: { at: number; ids: string[] } | undefined;
  const order = async (signal: AbortSignal): Promise<string[]> => {
    if (cache && Date.now() - cache.at < 10 * 60_000) return cache.ids;
    const p = registry.get("gemini");
    if (!p) throw new Error("No Gemini connection.");
    const models = (await p.listModels(signal)).filter((m) => m.category === "chat" && /flash/i.test(m.providerModelId) && !/image|tts|live|preview|exp|embed/i.test(m.providerModelId));
    const ver = (id: string) => Number(/gemini-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);
    const full = models.filter((m) => !/lite/i.test(m.providerModelId));
    const ids = [
      full.find((m) => /flash-latest$/i.test(m.providerModelId)),
      [...full].sort((a, b) => ver(b.providerModelId) - ver(a.providerModelId))[0],
      models.find((m) => /flash-lite-latest$/i.test(m.providerModelId)),
    ].filter((m, i, all): m is NonNullable<typeof m> => !!m && all.findIndex((x) => x?.id === m.id) === i).map((m) => m.id);
    if (!ids.length) throw new Error("The Gemini connection lists no Flash model.");
    cache = { at: Date.now(), ids };
    return ids;
  };
  return async (q, signal) => {
    let last: Error | undefined;
    for (const id of await order(signal)) {
      try {
        const turn = modelTurnFor(registry, id, undefined, "helper");
        const r = await turn({ messages: [{ role: "system", content: q.system }, { role: "user", content: q.user, ...(q.image ? { images: [{ mimeType: q.image.mimeType, data: q.image.data.toString("base64") }] } : {}) }], tools: [] }, signal, () => undefined);
        return r.text;
      } catch (e) {
        last = e as Error;
        if (signal.aborted || !/\b(500|502|503|504)\b|UNAVAILABLE|overloaded/i.test(last.message)) throw last;
      }
    }
    throw last ?? new Error("Gemini is busy.");
  };
}
