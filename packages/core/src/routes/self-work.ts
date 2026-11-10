import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import { isLocalRequest } from "../auth.js";
import { pickCodeModel } from "../code-model.js";
import { ensureLmStudioContext } from "../lmstudio-context.js";
import { detectHardwareCached } from "@kesher/downloads";
import type { KesherServices } from "../services.js";
import type { SelfWorkState } from "../self-work.js";
import type { BoardChange } from "../task-board.js";

/**
 * Self-work: start, follow and stop KesherAI working on a git project by itself.
 * A new project folder and its check command are chosen only on the computer;
 * the phone can start again with the same folder and check, follow, and stop.
 *
 * In the desktop app the work runs in a second, window-less KesherAI (the
 * worker), so updating the app never stops it: these routes check the request
 * here and pass it on to the worker on this computer.
 */
export async function selfWorkRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const host = s.workerHost;
  /** Asks the worker (only when there is one; never a sender-given address). */
  const toWorker = async <T>(path: string, method: "GET" | "POST", body?: unknown, start = false): Promise<T> => {
    const url = start ? await host!.ensure() : host!.url();
    if (!url) return { run: null } as T;
    const r = await fetch(`${url}${path}`, { method, ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) });
    const data = (await r.json().catch(() => ({}))) as T & { error?: string };
    if (!r.ok) throw Object.assign(new Error(data.error ?? `The worker answered ${r.status}.`), { code: r.status });
    return data;
  };
  const current = async (): Promise<SelfWorkState | null> => (host ? (await toWorker<{ run: SelfWorkState | null }>("/api/self-work", "GET").catch(() => ({ run: null }))).run : (s.selfWork?.current ?? null));

  app.get("/api/self-work", async () => ({ run: await current(), ...(host ? { worker: !!host.url() } : {}), ...(s.worker ? { version: s.worker.version } : {}) }));

  app.post<{ Body: { repo?: string; goal?: string; hours?: number; check?: string; modelId?: string } }>("/api/self-work/start", async (req, reply) => {
    const b = req.body ?? {};
    const repo = resolve(String(b.repo ?? ""));
    const check = String(b.check ?? "").trim();
    const last = await current();
    if (!isLocalRequest(req) && !(last && last.repo === repo && last.check === check)) {
      return reply.code(403).send({ error: "Choose the project and its check on the computer first; from the phone you can start again with the same ones." });
    }
    const home = resolve(homedir());
    if (!b.repo || !isAbsolute(String(b.repo)) || !(repo + sep).startsWith(home + sep)) return reply.code(400).send({ error: "The project must be a folder inside your home folder." });
    if (b.modelId !== undefined && typeof b.modelId !== "string") return reply.code(400).send({ error: "modelId is text." });
    const start = { repo, goal: String(b.goal ?? ""), ...(b.hours !== undefined ? { hours: Number(b.hours) } : {}), check };
    try {
      // No model chosen: the best one for long coding runs on this computer (see code-model.ts), else the active chat model.
      const auto = b.modelId ? undefined : pickCodeModel(await s.registry.listAllModels().then((r) => r.models.filter((m) => !m.id.startsWith("main/")), () => []));
      // A local LM Studio model must be loaded with room for hours of tool calls (it often loads with 4096 tokens).
      const chosen = b.modelId || auto?.id || s.config.activeModels.chat;
      let contextNote = "";
      if (chosen) {
        const [providerId, ...rest] = chosen.split("/");
        const prov = s.config.providers.find((p) => p.id === providerId) as { baseUrl?: string; apiKey?: string } | undefined;
        if (prov?.baseUrl) {
          const hw = await detectHardwareCached().catch(() => undefined);
          const vramGb = hw ? Math.max(0, ...hw.gpus.map((g) => g.vramTotal)) / 1024 ** 3 : 0;
          const r = await ensureLmStudioContext(prov.baseUrl, rest.join("/"), vramGb >= 20 ? 65_536 : 32_768, prov.apiKey).catch((e: Error) => {
            contextNote = e.message;
            return undefined;
          });
          if (r?.reloaded) contextNote = `${rest.join("/")} was loaded again with ${r.after} tokens of context (it had ${r.before ?? "none"}).`;
        }
      }
      if (host) {
        // The worker uses this app's models.
        const model = chosen;
        const r = await toWorker<{ run: SelfWorkState }>("/api/self-work/start", "POST", { ...start, ...(model ? { modelId: `main/${model}` } : {}) }, true);
        return { ...r, ...(auto && !b.modelId ? { picked: auto } : {}), ...(contextNote ? { contextNote } : {}) };
      }
      const sw = s.selfWork;
      if (!sw) return reply.code(503).send({ error: "Self-work is not ready yet." });
      const model = b.modelId || auto?.id;
      return { run: await sw.start({ ...start, ...(model ? { modelId: model } : {}) }), ...(auto && !b.modelId ? { picked: auto } : {}), ...(contextNote ? { contextNote } : {}) };
    } catch (e) {
      return reply.code((e as { code?: number }).code === 409 ? 409 : 400).send({ error: (e as Error).message });
    }
  });

  app.post("/api/self-work/stop", async (_req, reply) => {
    if (host) return toWorker("/api/self-work/stop", "POST", {}).catch((e: Error) => reply.code(502).send({ error: e.message }));
    const sw = s.selfWork;
    const run = sw?.current;
    if (sw && run) {
      await sw.stop();
      s.conversations.stop(run.convId);
    }
    return { run: sw?.current ?? null };
  });

  // What the run's chat did lately (tools, answers): the worker's chats live in its own folder, so the panel shows this.
  app.get("/api/self-work/log", async () => {
    if (host) return toWorker<{ lines: string[] }>("/api/self-work/log", "GET").catch(() => ({ lines: [], waiting: [] }));
    const run = s.selfWork?.current;
    const opened = run ? await s.conversations.open(run.convId) : undefined;
    const lines = (opened?.session.events ?? [])
      .flatMap((e) => (e.type === "assistant" ? [`💬 ${e.text.replace(/\s+/g, " ").slice(0, 300)}`] : e.type === "tool_call" ? [`🔧 ${e.name} ${JSON.stringify(e.input).slice(0, 120)}`] : e.type === "tool_result" && !e.ok ? [`⚠ ${e.name}: ${String(e.output).replace(/\s+/g, " ").slice(0, 160)}`] : e.type === "approval_request" ? [`✋ ${e.name} waits for approval`] : []))
      .slice(-60);
    const answered = new Set((opened?.session.events ?? []).flatMap((e) => (e.type === "approval_result" ? [e.requestId] : [])));
    const waiting = (opened?.session.events ?? []).filter((e) => e.type === "approval_request" && !answered.has(e.requestId)).map((e) => (e.type === "approval_request" ? { requestId: e.requestId, name: e.name, preview: e.preview.slice(0, 800), reason: e.reason } : null)).filter(Boolean);
    return { lines, waiting };
  });

  // Approve or deny what the run waits for (the worker's chat has no window of its own).
  app.post<{ Body: { requestId?: string; decision?: string } }>("/api/self-work/approve", async (req, reply) => {
    const requestId = String(req.body?.requestId ?? "");
    const decision = req.body?.decision === "allow" ? "allow" : "deny";
    if (!/^[\w-]{8,64}$/.test(requestId)) return reply.code(400).send({ error: "Which request?" });
    if (host) return toWorker("/api/self-work/approve", "POST", { requestId, decision }).catch((e: Error) => reply.code(502).send({ error: e.message }));
    const run = s.selfWork?.current;
    const opened = run ? await s.conversations.open(run.convId) : undefined;
    if (!opened?.session.approve(requestId, decision)) return reply.code(404).send({ error: "That request is no longer waiting." });
    return { ok: true };
  });

  // The worker's notifications go out through the main app (it has the phone set up). Only from this computer.
  app.post<{ Body: { title?: string; body?: string; path?: string } }>("/api/self-work/notify", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Only on this computer." });
    const b = req.body ?? {};
    await s.notifier.send({ title: String(b.title ?? "").slice(0, 120), body: String(b.body ?? "").slice(0, 500), path: /^#\/c\/[\w-]+$/.test(String(b.path ?? "")) ? String(b.path) : "#/code", tags: ["robot"] }).catch(() => undefined);
    return { ok: true };
  });

  // Worker only: move to the newer version after the current item (the main app asks after it updated).
  app.post("/api/self-work/upgrade", async (req, reply) => {
    if (!isLocalRequest(req) || !s.worker) return reply.code(403).send({ error: "Only the worker, from this computer." });
    s.worker.upgrade();
    return { ok: true };
  });

  // The shared task board: Roee sees it and can add, reopen or note from KesherAI (and the phone).
  app.get("/api/self-work/board", async (_req, reply) => (s.board ? s.board.read() : reply.code(503).send({ error: "No board." })));
  app.post<{ Body: { changes?: BoardChange[]; rev?: number } }>("/api/self-work/board", async (req, reply) => {
    if (!s.board) return reply.code(503).send({ error: "No board." });
    const changes = Array.isArray(req.body?.changes) ? req.body.changes : [];
    try {
      return await s.board.change("roee", changes, typeof req.body?.rev === "number" ? req.body.rev : undefined);
    } catch (e) {
      return reply.code((e as { code?: number }).code === 409 ? 409 : 400).send({ error: (e as Error).message });
    }
  });
}
