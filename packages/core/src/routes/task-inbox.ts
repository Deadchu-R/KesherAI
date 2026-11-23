import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isLocalRequest, pairedDeviceIdOf, pairedDeviceOf } from "../auth.js";
import { inboxRunId } from "../agent-activity.js";
import type { TaskInbox } from "../inbox-runner.js";
import type { KesherServices } from "../services.js";
import { validBranchName } from "../task-inbox.js";
import { parseAssignTo, parseWorkList, type InboxTaskView } from "@kesher/shared";

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

  /** A task with the owner's name and note for its agent run (agent-labels.ts). */
  const labelled = <T extends InboxTaskView>(t: T): T => {
    const l = s.agentLabels?.get(inboxRunId(t.id));
    return l ? { ...t, label: l } : t;
  };

  app.get("/api/task-inbox", async (req) => {
    const st = await inbox.state(isLocalRequest(req));
    return { ...st, tasks: st.tasks.map(labelled) };
  });

  app.get<{ Params: { id: string } }>("/api/task-inbox/tasks/:id", async (req, reply) => inbox.task(req.params.id).then(labelled, (e) => failed(reply, e)));

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

  /**
   * "Add to queue" / "Take out of the queue" (inbox-queue.ts): the tap is the user's own start for the task. From the
   * phone (remote) it counts with the paired device's own key.
   */
  app.post<{ Params: { id: string } }>("/api/task-inbox/tasks/:id/queue", async (req, reply) => {
    const by = verifiedBy(req);
    if (!by) return reply.code(403).send({ error: "Only your paired phone or this computer can queue a task." });
    return inbox.queueAdd(req.params.id, by).catch((e) => failed(reply, e));
  });
  app.post<{ Params: { id: string } }>("/api/task-inbox/tasks/:id/unqueue", async (req, reply) => inbox.queueRemove(req.params.id).catch((e) => failed(reply, e)));

  /**
   * The freed-slot notification's Run button (no token: the one-time code is the key, as for quick-approve): starts the
   * next Antigravity task once, if the slot is still free. The phone app sends it from anywhere, also remotely.
   */
  app.post<{ Params: { code: string } }>("/api/quick-run/:code", async (req, reply) => {
    if (!(await inbox.quickRun(req.params.code))) return reply.code(410).send({ error: "This button no longer works: the slot was taken, the task started, or it is too old." });
    return { ok: true };
  });

  /** Asks again "Run this task in Antigravity?" (after the last ask expired or got "Not now"). */
  app.post<{ Params: { id: string } }>("/api/task-inbox/tasks/:id/ask", async (req, reply) => inbox.askRun(req.params.id).catch((e) => failed(reply, e)));

  /** The user's tap on the ask: Run or Not now. One answer, one task; nothing starts without a verified sender. */
  app.post<{ Body: { requestId?: string; decision?: string } }>("/api/task-inbox/run-answer", async (req, reply) => {
    const by = verifiedBy(req);
    if (!by) return reply.code(403).send({ error: "Only your paired phone or this computer can answer." });
    const requestId = String(req.body?.requestId ?? "");
    const d = req.body?.decision;
    const decision = d === "allow" || d === "skip" || d === "clear" ? d : "deny";
    try {
      // A chat agent's message to Antigravity, or an inbox task.
      if (await inbox.answerMessage(requestId, decision === "allow" ? "allow" : "deny", by)) return { ok: true };
      const t = await inbox.answerRun(requestId, decision, by);
      return t ?? reply.code(410).send({ error: "That ask has expired or was already answered. Ask again." });
    } catch (e) {
      return failed(reply, e);
    }
  });

  /** The owner's name and note for an inbox task's agent run (agent-labels.ts; empty fields clear them). */
  app.put<{ Params: { id: string }; Body: { name?: unknown; note?: unknown } }>("/api/task-inbox/tasks/:id/label", async (req, reply) => {
    const ok = await inbox.task(req.params.id).then(() => true, () => false);
    if (!ok || !s.agentLabels) return reply.code(404).send({ error: "No such task" });
    return { label: s.agentLabels.set(inboxRunId(req.params.id), { name: req.body?.name, note: req.body?.note }) };
  });
  /** The model an Antigravity task runs on (one of the state's `models`; "" = the default for its kind). */
  app.put<{ Params: { id: string }; Body: { model?: unknown } }>("/api/task-inbox/tasks/:id/model", async (req, reply) => {
    const model = typeof req.body?.model === "string" ? req.body.model.slice(0, 80) : "";
    return inbox.setModel(req.params.id, model).catch((e) => failed(reply, e));
  });
  app.post<{ Params: { id: string } }>("/api/task-inbox/tasks/:id/stop", async (req) => ({ stopped: await inbox.stop(req.params.id) }));
  app.post<{ Params: { id: string } }>("/api/task-inbox/tasks/:id/skip", async (req, reply) => inbox.skip(req.params.id).catch((e) => failed(reply, e)));
  app.post<{ Params: { id: string }; Body: { to?: string } }>("/api/task-inbox/tasks/:id/reassign", async (req, reply) => {
    const to = req.body?.to === "local" ? "local" : req.body?.to === "opus" ? "opus" : req.body?.to === "opencode" ? "opencode" : undefined;
    if (!to) return reply.code(400).send({ error: "to is local, opus or opencode." });
    return inbox.reassign(req.params.id, to).catch((e) => failed(reply, e));
  });

  /** Claude's work list (docs/WORK_LIST.md on the inbox branch's project), its open items, for "Send to an agent". */
  app.get("/api/task-inbox/work-list", async () => {
    const text = await inbox.workList().catch(() => undefined);
    return { items: text === undefined ? [] : parseWorkList(text).filter((i) => i.status !== "done").slice(0, 200) };
  });

  /**
   * "Who does it": gives an inbox task (`:id`) or a work-list item (`w-…`) to another executor (task-assign.ts). A
   * running or finished task answers with a question (`ask`) until the user's yes comes back as `confirm`.
   */
  app.post<{ Params: { id: string }; Body: { to?: unknown; confirm?: unknown } }>("/api/task-inbox/assign/:id", async (req, reply) => {
    const to = parseAssignTo(req.body?.to);
    if (!to || !s.assignTask) return reply.code(400).send({ error: "Pick who does it." });
    if (!/^[\w-]{1,64}$/.test(req.params.id)) return reply.code(400).send({ error: "Bad task id." });
    return s.assignTask(req.params.id, to, req.body?.confirm === true);
  });

  /** Allow once or deny an agent's step that the policy asked about. */
  app.post<{ Params: { id: string }; Body: { requestId?: string; decision?: string } }>("/api/task-inbox/tasks/:id/answer", async (req, reply) => {
    if (!verifiedBy(req)) return reply.code(403).send({ error: "Only your paired phone or this computer can answer." });
    const ok = await inbox.answer(req.params.id, String(req.body?.requestId ?? ""), req.body?.decision === "allow" ? "allow" : "deny").catch(() => false);
    return ok ? { ok } : reply.code(410).send({ error: "That step is no longer waiting." });
  });

  /** Settings > Task inbox. */
  // The research backlog (research-tasks.ts): what the loop will feed next, and the lead tasks waiting for a decision.
  app.get("/api/task-inbox/research", async () => inbox.researchBacklog());

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
      if (typeof b.loop === "boolean") cur.loop = b.loop;
      // "Ask before the next task" per executor (inbox-queue.ts).
      if (b.askBeforeNext && typeof b.askBeforeNext === "object") {
        const a = b.askBeforeNext as Record<string, unknown>;
        for (const k of ["antigravity", "local"] as const) if (typeof a[k] === "boolean") cur.askBeforeNext = { ...cur.askBeforeNext, [k]: a[k] as boolean };
      }
      int("fetchMinutes", 1, 120);
      int("dailyCap", 0, 100);
      int("maxMinutes", 1, 60);
      int("gpuBusyPercent", 0, 100);
      list("allowedPaths", 40);
      list("forbiddenPaths", 60);
      list("commands", 40);
      // OpenCode Go (Settings > Task inbox card): on/off, the two models (only the connection's own `opencode-go/…` ids), the daily cap.
      if (b.opencode && typeof b.opencode === "object") {
        const o = b.opencode as Record<string, unknown>;
        const oc = { ...cur.opencode };
        if (typeof o.enabled === "boolean") oc.enabled = o.enabled;
        if (typeof o.useFree === "boolean") oc.useFree = o.useFree;
        if (typeof o.freeTrainingOk === "boolean") oc.freeTrainingOk = o.freeTrainingOk;
        for (const k of ["small", "strong"] as const) {
          if (o[k] === undefined) continue;
          const m = String(o[k]).trim();
          if (m.length > 120 || !/^opencode-go\/[\w.:-]+$/.test(m)) throw new Error("Pick an OpenCode Go model (opencode-go/…).");
          oc[k] = m;
        }
        if (o.dailyCap !== undefined) {
          const n = Number(o.dailyCap);
          if (!Number.isInteger(n) || n < 0 || n > 100) throw new Error("The OpenCode Go daily limit must be 0–100.");
          oc.dailyCap = n;
        }
        cur.opencode = oc;
      }
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
    void inbox.pumpOpencode().catch(() => undefined);
    return inbox.state(isLocalRequest(req));
  });
}
