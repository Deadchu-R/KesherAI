import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { isLocalRequest } from "../auth.js";
import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";
import { PIPELINE_TEMPLATES, type Pipeline } from "../pipelines.js";
import type { Routine } from "../routines.js";

/**
 * Pipelines: list (with templates), save, delete, run, follow a run, stop
 * it, and download its files.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function pipelineRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  app.get("/api/pipelines", async () => ({ pipelines: await s.pipelines.list(), templates: PIPELINE_TEMPLATES }));
  app.get<{ Params: { id: string } }>("/api/pipelines/:id", async (req, reply) => (await s.pipelines.get(req.params.id)) ?? reply.code(404).send({ error: "No such pipeline." }));
  app.post<{ Body: Partial<Pipeline> }>("/api/pipelines", async (req, reply) => {
    try {
      return await s.pipelines.save({ ...(req.body ?? {}), name: req.body?.name ?? "", steps: req.body?.steps ?? [] });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.delete<{ Params: { id: string } }>("/api/pipelines/:id", async (req) => {
    await s.pipelines.remove(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string }; Body: { inputs?: Record<string, string> } }>("/api/pipelines/:id/run", async (req, reply) => {
    try {
      const inputs = Object.fromEntries(Object.entries(req.body?.inputs ?? {}).map(([k, v]) => [k, String(v ?? "")]));
      return await s.pipelines.start(req.params.id, inputs);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  // Routines: pipelines and prompts on a schedule.
  app.get("/api/routines", async () => s.routines.list());
  app.post<{ Body: Partial<Routine> }>("/api/routines", async (req, reply) => {
    const b = req.body ?? {};
    // A folder the routine's chat may write to: only set on this computer, and only inside the user's home folder.
    const folder = b.action?.type === "prompt" ? b.action.folder : undefined;
    if (folder) {
      if (!isLocalRequest(req)) return reply.code(403).send({ error: "Give a routine a folder on this computer." });
      const home = resolve(homedir());
      const abs = resolve(folder);
      if (!isAbsolute(folder) || !(abs + sep).startsWith(home + sep) || abs === home) return reply.code(400).send({ error: "The folder must be inside your home folder (not the home folder itself)." });
      b.action = { ...b.action, folder: abs } as typeof b.action;
    }
    // A self-work routine runs its check command on this computer (scan 39): set on this computer, or from the phone
    // only with the same project and check as the last run (the rule of the panel's Start).
    if (b.action?.type === "self-work" && !isLocalRequest(req)) {
      const last = (await app.inject({ method: "GET", url: "/api/self-work", remoteAddress: "127.0.0.1", headers: { host: "127.0.0.1" } }).then((r) => r.json() as { run?: { repo?: string; check?: string } | null }, () => ({ run: null }))).run;
      if (!last || resolve(String(b.action.repo)) !== last.repo || b.action.check !== last.check) {
        return reply.code(403).send({ error: "Choose the project and its check on the computer first; from the phone you can save a routine with the same ones." });
      }
    }
    try {
      return await s.routines.save({ ...b, name: b.name ?? "", schedule: b.schedule ?? { kind: "daily", time: "08:00" }, action: b.action ?? { type: "prompt", prompt: "" } });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.delete<{ Params: { id: string } }>("/api/routines/:id", async (req) => {
    await s.routines.remove(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>("/api/routines/:id/run", async (req) => {
    void s.routines.runNow(req.params.id);
    return { ok: true };
  });

  app.get("/api/pipelines/runs", async () => s.pipelines.recent().map(({ vars: _v, log, ...r }) => ({ ...r, last: log.at(-1)?.text ?? "" })));
  app.get<{ Params: { run: string } }>("/api/pipelines/runs/:run", async (req, reply) => s.pipelines.run(req.params.run) ?? reply.code(404).send({ error: "No such run (runs are kept until KesherAI restarts)." }));
  app.post<{ Params: { run: string } }>("/api/pipelines/runs/:run/stop", async (req) => {
    s.pipelines.stop(req.params.run);
    return { ok: true };
  });
  app.get<{ Params: { run: string; file: string } }>("/api/pipelines/runs/:run/files/:file", async (req, reply) => {
    const run = s.pipelines.run(req.params.run);
    const name = basename(req.params.file);
    if (!run || !run.files.includes(name)) return reply.code(404).send({ error: "No such file." });
    const data = await readFile(join(s.paths.root, "outputs", "pipelines", run.id, name));
    const type = /\.png$/i.test(name) ? "image/png" : /\.jpe?g$/i.test(name) ? "image/jpeg" : /\.webp$/i.test(name) ? "image/webp" : "text/plain; charset=utf-8";
    return reply.type(type).header("content-disposition", `inline; filename="${encodeURIComponent(name)}"`).send(data);
  });
}
