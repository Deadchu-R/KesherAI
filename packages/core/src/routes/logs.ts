import { basename } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { redactLeaks } from "@kesher/shared";
import { isLocalRequest } from "../auth.js";
import { modelTurnFor } from "../model-turn.js";
import { findGameProjects } from "../game-projects.js";
import { LOG_LEVELS, type LogLevel } from "../log-parse.js";
import { PATTERN_LABELS, type PatternLabel } from "../log-patterns.js";
import { explainPrompt, LogReader, summaryPrompt } from "../log-reader.js";
import { privacyContext } from "../privacy-guard.js";
import type { KesherServices } from "../services.js";
import { besideModelOf } from "../side-engine.js";

const levelsOf = (v?: string): LogLevel[] | undefined => {
  const l = (v ?? "").split(",").map((x) => x.trim()).filter((x): x is LogLevel => (LOG_LEVELS as readonly string[]).includes(x));
  return l.length ? l : undefined;
};
const numOf = (v?: string): number | undefined => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** Sends a reader error with its status (404 for an unknown source, 400 for a refused search or file). */
function fail(reply: FastifyReply, err: unknown, status = 400) {
  const e = err as Error & { statusCode?: number };
  return reply.code(e.statusCode ?? status).send({ error: e.message });
}

/**
 * The smart log reader (Roee, 2026-11-24; log-reader.ts): the Logs page's sources, search, patterns, labels and
 * "Explain" with the local model. Reading, labels and Explain work from a paired phone too; adding or removing a
 * file is allowed only on the computer itself (a path is typed there, and only files inside the home folder).
 *
 * - GET /api/logs/sources
 * - GET /api/logs/search?source=&q=&regex=1&levels=error,warning&cats=&since=&until=&context=&limit=
 * - GET /api/logs/patterns?source=&levels=&since=&look=0 · GET /api/logs/patterns/:id/lines?source=&limit=
 * - PUT /api/logs/patterns/:id/label { source, label: "bug" | "known" | "ignore" | null }
 * - POST /api/logs/explain { kind: "pattern" | "hour", source?, patternId?, modelId?, lang? }
 * - POST /api/logs/files { path } · DELETE /api/logs/files/:id
 *
 * @param app - Fastify instance.
 * @param s - The services (data folder, engines, registry, settings).
 */
export function logRoutes(app: FastifyInstance, s: KesherServices): void {
  const reader = new LogReader({
    root: s.paths.root,
    engineLog: () => s.engine.status().log,
    comfyLog: () => s.comfy.status().log,
    sdLogFile: () => s.sd.logFile,
    unrealProjects: async () => (await findGameProjects({ ...(s.unreal.projectFile ? { unrealFile: s.unreal.projectFile } : {}) })).filter((p) => p.kind === "unreal"),
  });

  app.get("/api/logs/sources", async () => ({ sources: await reader.list() }));

  app.get<{ Querystring: Record<string, string | undefined> }>("/api/logs/search", async (req, reply) => {
    const q = req.query;
    if (!q.source) return reply.code(400).send({ error: "Choose a log." });
    try {
      return await reader.search(q.source, {
        ...(q.q ? { q: String(q.q) } : {}),
        regex: q.regex === "1" || q.regex === "true",
        ...(levelsOf(q.levels) ? { levels: levelsOf(q.levels)! } : {}),
        ...(q.cats ? { cats: String(q.cats).split(",").slice(0, 50) } : {}),
        ...(numOf(q.since) !== undefined ? { since: numOf(q.since)! } : {}),
        ...(numOf(q.until) !== undefined ? { until: numOf(q.until)! } : {}),
        ...(numOf(q.context) !== undefined ? { context: numOf(q.context)! } : {}),
        ...(numOf(q.limit) !== undefined ? { limit: numOf(q.limit)! } : {}),
      });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/api/logs/patterns", async (req, reply) => {
    const q = req.query;
    if (!q.source) return reply.code(400).send({ error: "Choose a log." });
    try {
      const r = await reader.patterns(q.source, { ...(levelsOf(q.levels) ? { levels: levelsOf(q.levels)! } : {}), ...(numOf(q.since) !== undefined ? { since: numOf(q.since)! } : {}), look: q.look !== "0" });
      // The page needs a few line numbers per pattern at most (its lines come from /lines).
      return { ...r, patterns: r.patterns.slice(0, 500).map((p) => ({ ...p, lines: undefined })) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { source?: string; limit?: string } }>("/api/logs/patterns/:id/lines", async (req, reply) => {
    if (!req.query.source) return reply.code(400).send({ error: "Choose a log." });
    try {
      const r = await reader.patternLines(req.query.source, req.params.id, numOf(req.query.limit) ?? 50);
      if (!r) return reply.code(404).send({ error: "This pattern is no longer in the log (it may have rolled over)." });
      return { pattern: { ...r.pattern, lines: undefined }, entries: r.entries };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.put<{ Params: { id: string }; Body: { source?: string; label?: PatternLabel | null } }>("/api/logs/patterns/:id/label", async (req, reply) => {
    const { source, label } = req.body ?? {};
    if (!source) return reply.code(400).send({ error: "Choose a log." });
    if (label !== null && label !== undefined && !PATTERN_LABELS.includes(label)) return reply.code(400).send({ error: "The label is bug, known or ignore (or null to clear it)." });
    try {
      if (!(await reader.setLabel(source, req.params.id, label ?? null))) return reply.code(404).send({ error: "This pattern is no longer in the log." });
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  /**
   * The model for Explain: the one the user picked, else the small model beside the main one, else the main engine's
   * loaded model when it is not loading, else the chat model when it runs on this computer. Never a cloud model
   * unless picked.
   */
  const pickModel = (asked?: string): { id: string; cloud: boolean } | undefined => {
    const loc = (id: string) => {
      try {
        return s.registry.resolve(id).provider.location;
      } catch {
        return undefined;
      }
    };
    if (asked) {
      const l = loc(asked);
      return l ? { id: asked, cloud: l === "cloud" } : undefined;
    }
    const beside = besideModelOf(s.registry);
    if (beside) return { id: beside, cloud: false };
    const st = s.engine.status();
    if (st.running && st.modelPath && !st.job) return { id: `llamacpp/${basename(st.modelPath).replace(/\.gguf$/i, "")}`, cloud: false };
    const chat = s.config.activeModels.chat;
    if (chat && loc(chat) !== undefined && loc(chat) !== "cloud") return { id: chat, cloud: false };
    return undefined;
  };

  app.post<{ Body: { kind?: "pattern" | "hour"; source?: string; patternId?: string; modelId?: string; lang?: string } }>("/api/logs/explain", async (req, reply) => {
    const b = req.body ?? {};
    const he = b.lang === "he";
    const model = pickModel(b.modelId ? String(b.modelId) : undefined);
    if (!model) {
      return reply.code(400).send({ error: b.modelId ? "That model is not available." : "Load a local model first (Models), or pick a model for Explain.", code: "no-local-model" });
    }
    let prompt: { system: string; user: string };
    try {
      if (b.kind === "hour") {
        const list = await reader.recentErrors();
        if (!list.length) return { text: he ? "לא היו שגיאות בשעה האחרונה." : "No errors in the last hour.", model: null, hidden: 0 };
        prompt = summaryPrompt(list, he);
      } else {
        if (!b.source || !b.patternId) return reply.code(400).send({ error: "Choose a pattern to explain." });
        const r = await reader.patternLines(b.source, b.patternId, 5);
        if (!r) return reply.code(404).send({ error: "This pattern is no longer in the log." });
        const src = (await reader.list()).find((x) => x.id === b.source);
        prompt = explainPrompt(src?.name ?? b.source, r.pattern, r.entries, he);
      }
    } catch (err) {
      return fail(reply, err);
    }
    // Logs go to a cloud model only when the user picked it, and then with keys, emails, paths and the like hidden.
    let hidden = 0;
    if (model.cloud) {
      const { ctx } = privacyContext();
      const r = redactLeaks(prompt.user, ctx);
      prompt = { ...prompt, user: r.text };
      hidden = r.hits.length;
    }
    try {
      const out = await modelTurnFor(s.registry, model.id)({ messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }], tools: [] }, AbortSignal.timeout(180_000), () => undefined);
      return { text: out.text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim(), model: model.id, hidden };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.post<{ Body: { path?: string } }>("/api/logs/files", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Add a log file on the computer itself." });
    try {
      return { source: await reader.addFile(String(req.body?.path ?? "")) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/logs/files/:id", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Remove a log file on the computer itself." });
    if (!(await reader.removeFile(req.params.id))) return reply.code(404).send({ error: "No such added file." });
    return { ok: true };
  });
}
