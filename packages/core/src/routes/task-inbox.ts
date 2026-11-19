import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isLocalRequest, pairedDeviceIdOf, pairedDeviceOf } from "../auth.js";
import type { TaskInbox } from "../inbox-runner.js";
import type { KesherServices } from "../services.js";
import { validBranchName } from "../task-inbox.js";

/**
 * The task inbox (inbox-runner.ts): the queue, a task's page, Run / Stop / Skip, answers to the PC's "Run this task
 * in Antigravity?" ask and to an agent's asked step, "+ Task", and Settings > Task inbox. Works the same from the phone
 * (remote): there Run answers the PC's ask, and only a request carrying a paired device's own key counts as an answer.
 * The project folder is chosen only on the computer.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 * @param inbox - The inbox.
 */
export async function taskInboxRoutes(app: FastifyInstance, s: KesherServices, inbox: TaskInbox): Promise<void> {
  const failed = (reply: FastifyReply, e: unknown) => {
    const code = (e as { code?: unknown }).code;
    return reply.code(typeof code === "number" && code >= 400 && code < 600 ? code : 400).send({ error: (e as Error).message });
  };
  /** Who answered, as verified: this computer, or the paired device whose key the request carried. */
  const verifiedBy = (req: FastifyRequest): string | undefined => (isLocalRequest(req) ? "pc" : pairedDeviceIdOf(req) ?? pairedDeviceOf(req));

  app.get("/api/task-inbox", async (req) => inbox.state(isLocalRequest(req)));

  app.get<{ Params: { id: string } }>("/api/task-inbox/tasks/:id", async (req, reply) => inbox.task(req.params.id).catch((e) => failed(reply, e)));

  app.post("/api/task-inbox/sync", async (_req, reply) => {
    try {
      await inbox.sync();
      return { ok: true };
    } catch (e) {
      return failed(reply, e);
    }
  });

  app.post<{ Body: { title?: string; goal?: string; executor?: string; risk?: string; check?: string; acceptance?: string } }>("/api/task-inbox/tasks", async (req, reply) => {
    const b = req.body ?? {};
    return inbox.add({ title: String(b.title ?? ""), goal: String(b.goal ?? ""), ...(b.executor ? { executor: b.executor } : {}), ...(b.risk ? { risk: b.risk } : {}), ...(b.check ? { check: b.check } : {}), ...(b.acceptance ? { acceptance: b.acceptance } : {}) }).catch((e) => failed(reply, e));
  });

  /** Run on the PC itself. On the phone, Run is the answer to the PC's ask (`/run-answer`). */
  app.post<{ Params: { id: string } }>("/api/task-inbox/tasks/:id/run", async (req, reply) => inbox.run(req.params.id, { here: isLocalRequest(req) }).catch((e) => failed(reply, e)));

  /** Asks again "Run this task in Antigravity?" (after the last ask expired or got "Not now"). */
  app.post<{ Params: { id: string } }>("/api/task-inbox/tasks/:id/ask", async (req, reply) => inbox.askRun(req.params.id).catch((e) => failed(reply, e)));

  /** The user's tap on the ask: Run or Not now. One answer, one task; nothing starts without a verified sender. */
  app.post<{ Body: { requestId?: string; decision?: string } }>("/api/task-inbox/run-answer", async (req, reply) => {
    const by = verifiedBy(req);
    if (!by) return reply.code(403).send({ error: "Only your paired phone or this computer can answer." });
    const requestId = String(req.body?.requestId ?? "");
    const decision = req.body?.decision === "allow" ? "allow" : "deny";
    try {
      const t = await inbox.answerRun(requestId, decision, by);
      return t ?? reply.code(410).send({ error: "That ask has expired or was already answered. Ask again." });
    } catch (e) {
      return failed(reply, e);
    }
  });

  app.post<{ Params: { id: string } }>("/api/task-inbox/tasks/:id/stop", async (req) => ({ stopped: await inbox.stop(req.params.id) }));
  app.post<{ Params: { id: string } }>("/api/task-inbox/tasks/:id/skip", async (req, reply) => inbox.skip(req.params.id).catch((e) => failed(reply, e)));
  app.post<{ Params: { id: string }; Body: { to?: string } }>("/api/task-inbox/tasks/:id/reassign", async (req, reply) => {
    const to = req.body?.to === "local" ? "local" : req.body?.to === "opus" ? "opus" : undefined;
    if (!to) return reply.code(400).send({ error: "to is local or opus." });
    return inbox.reassign(req.params.id, to).catch((e) => failed(reply, e));
  });

  /** Allow once or deny an agent's step that the policy asked about. */
  app.post<{ Params: { id: string }; Body: { requestId?: string; decision?: string } }>("/api/task-inbox/tasks/:id/answer", async (req, reply) => {
    if (!verifiedBy(req)) return reply.code(403).send({ error: "Only your paired phone or this computer can answer." });
    const ok = await inbox.answer(req.params.id, String(req.body?.requestId ?? ""), req.body?.decision === "allow" ? "allow" : "deny").catch(() => false);
    return ok ? { ok } : reply.code(410).send({ error: "That step is no longer waiting." });
  });

  /** Settings > Task inbox. */
  app.put<{ Body: Record<string, unknown> }>("/api/task-inbox/settings", async (req, reply) => {
    const b = req.body ?? {};
    const cur = s.config.taskInbox;
    const bool = (k: "enabled" | "paused" | "notWhileGame" | "notWhileEditor") => {
      if (typeof b[k] === "boolean") cur[k] = b[k] as boolean;
    };
    const int = (k: "fetchMinutes" | "dailyCap" | "maxMinutes" | "gpuBusyPercent", min: number, max: number) => {
      if (b[k] === undefined) return;
      const n = Number(b[k]);
      if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${k} must be ${min}–${max}.`);
      cur[k] = n;
    };
    const list = (k: "allowedPaths" | "forbiddenPaths" | "commands", max: number) => {
      if (b[k] === undefined) return;
      if (!Array.isArray(b[k])) throw new Error(`${k} must be a list.`);
      const v = (b[k] as unknown[]).map((x) => String(x).trim()).filter(Boolean);
      if (v.length > max || v.some((x) => x.length > 120 || /[\n;|`$<>]/.test(x) || x.startsWith("/") || x.includes(".."))) throw new Error(`${k} has an entry that is not allowed.`);
      cur[k] = v;
    };
    try {
      bool("enabled");
      bool("paused");
      bool("notWhileGame");
      bool("notWhileEditor");
      int("fetchMinutes", 1, 120);
      int("dailyCap", 0, 100);
      int("maxMinutes", 1, 60);
      int("gpuBusyPercent", 0, 100);
      list("allowedPaths", 40);
      list("forbiddenPaths", 60);
      list("commands", 40);
      if (typeof b.model === "string") {
        if (b.model.length > 80 || !/^[\w .:/()-]*$/.test(b.model)) throw new Error("The model name has odd characters.");
        cur.model = b.model.trim();
      }
      if (typeof b.branch === "string") {
        const br = b.branch.trim();
        if (!validBranchName(br) || br.includes("/") || ["main", "master", "release"].includes(br)) throw new Error("That branch name is not allowed for the inbox.");
        cur.branch = br;
      }
      if (typeof b.repo === "string") {
        if (!isLocalRequest(req)) return reply.code(403).send({ error: "The project folder is chosen on the computer." });
        const r = b.repo.trim();
        if (r && (!isAbsolute(r) || !existsSync(join(r, ".git")))) throw new Error("That folder is not a git project.");
        if (r) cur.repo = r;
        else delete cur.repo;
      }
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    await s.saveConfig();
    if (!cur.enabled) await inbox.stopAll();
    inbox.start();
    return inbox.state(isLocalRequest(req));
  });
}
