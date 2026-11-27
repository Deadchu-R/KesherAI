import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isLocalRequest, pairedDeviceIdOf, pairedDeviceOf } from "../auth.js";
import { inboxRunId } from "../agent-activity.js";
import type { TaskInbox } from "../inbox-runner.js";
import type { KesherServices } from "../services.js";
import { validBranchName } from "../task-inbox.js";
import { DIGEST_FILE } from "../inbox-digest.js";
import { usageQueryOf } from "../usage-log.js";
import { cleanFailoverOrder, FAILOVER_DEFAULTS, FAILOVER_TARGETS, parseAssignTo, parseWorkList, type InboxTaskView } from "@kesher/shared";

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

  /** The inbox digest (inbox-digest.ts): what finished, failed or waits per executor, and the quotas, written by the digest routine. */
  app.get("/api/task-inbox/digest", async (_req, reply) => {
    const text = await readFile(join(s.paths.root, DIGEST_FILE), "utf8").catch(() => "");
    return text ? reply.type("text/markdown; charset=utf-8").send(text) : reply.code(404).send({ error: "No digest yet: it is written by the digest routine (Routines page, Run now)." });
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

  app.post<{ Body: { title?: string; goal?: string; executor?: string; risk?: string; check?: string; acceptance?: string; kind?: string } }>("/api/task-inbox/tasks", async (req, reply) => {
    const b = req.body ?? {};
    return inbox.add({ title: String(b.title ?? ""), goal: String(b.goal ?? ""), ...(b.executor ? { executor: b.executor } : {}), ...(b.risk ? { risk: b.risk } : {}), ...(b.check ? { check: b.check } : {}), ...(b.acceptance ? { acceptance: b.acceptance } : {}), ...(b.kind ? { kind: b.kind } : {}) }).catch((e) => failed(reply, e));
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
  // Settings › Connections › Claude Code: check the install and the login again (Claude Code's own `auth status`).
  app.post("/api/task-inbox/claude/check", async (_req, reply) => (await inbox.claudeCheckNow()) ?? reply.code(404).send({ error: "Claude Code is not available here." }));
  app.post<{ Params: { id: string } }>("/api/task-inbox/tasks/:id/stop", async (req) => ({ stopped: await inbox.stop(req.params.id) }));
  app.post<{ Params: { id: string } }>("/api/task-inbox/tasks/:id/skip", async (req, reply) => inbox.skip(req.params.id).catch((e) => failed(reply, e)));
  app.post<{ Params: { id: string }; Body: { to?: string } }>("/api/task-inbox/tasks/:id/reassign", async (req, reply) => {
    const ALL = ["local", "opus", "antigravity", "gemini", "opencode", "ghostcli", "claude"] as const;
    const to = ALL.find((x) => x === req.body?.to);
    if (!to) return reply.code(400).send({ error: `to is ${ALL.join(", ")}.` });
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

  // The usage log (usage-log.ts): read only, so a paired phone may read it too. Filters: level, executor, task, since (ms), grep.
  app.get<{ Querystring: Record<string, string | undefined> }>("/api/usage-log", async (req) => inbox.usageLog(usageQueryOf(req.query)));
  // The savings finder on demand (it also runs once a day): writes `suggestion` entries, applies nothing.
  app.post("/api/usage-log/savings", async () => ({ suggestions: await inbox.savingsPass() }));

  /** Settings > Task inbox. */
  // The research backlog (research-tasks.ts): what the loop will feed next, and the lead tasks waiting for a decision.
  app.get("/api/task-inbox/research", async () => inbox.researchBacklog());

  app.put<{ Body: Record<string, unknown> }>("/api/task-inbox/settings", async (req, reply) => {
    const b = req.body ?? {};
    const cur = s.config.taskInbox;
    const bool = (k: "enabled" | "paused" | "notWhileGame" | "notWhileEditor") => {
      if (typeof b[k] === "boolean") cur[k] = b[k] as boolean;
    };
    const int = (k: "fetchMinutes" | "dailyCap" | "maxMinutes" | "stallMinutes" | "maxRequests" | "gpuBusyPercent", min: number, max: number) => {
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
      int("maxMinutes", 1, 480);
      int("stallMinutes", 1, 120);
      int("maxRequests", 1, 1000);
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
        if (typeof o.useRelay === "boolean") oc.useRelay = o.useRelay;
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
      // Quota failover (Settings › Task inbox › When a quota runs out): the two switches and the two fallback orders.
      if (b.failover && typeof b.failover === "object") {
        const o = b.failover as Record<string, unknown>;
        const fo = { ...FAILOVER_DEFAULTS, ...cur.failover };
        if (typeof o.enabled === "boolean") fo.enabled = o.enabled;
        if (typeof o.moveManual === "boolean") fo.moveManual = o.moveManual;
        for (const k of ["code", "research"] as const) {
          if (o[k] === undefined) continue;
          if (!Array.isArray(o[k]) || (o[k] as unknown[]).some((x) => !FAILOVER_TARGETS[k].includes(x as never))) throw new Error(`The ${k} fallback order has an executor that is not allowed.`);
          fo[k] = cleanFailoverOrder(k, o[k]);
        }
        cur.failover = { enabled: fo.enabled, moveManual: fo.moveManual, code: cleanFailoverOrder("code", fo.code) as Array<"ghostcli" | "opencode" | "antigravity" | "local">, research: cleanFailoverOrder("research", fo.research) as Array<"gemini" | "ghostcli" | "antigravity"> };
      }
      // GhostCLI (Settings › Task inbox card): on/off, the daily cap, the model order (only `ghostcli/…` ids), heavy tasks to it.
      if (b.ghostcli && typeof b.ghostcli === "object") {
        const o = b.ghostcli as Record<string, unknown>;
        const gc = { ...cur.ghostcli };
        if (typeof o.enabled === "boolean") gc.enabled = o.enabled;
        if (typeof o.takeHeavy === "boolean") gc.takeHeavy = o.takeHeavy;
        if (o.dailyCap !== undefined) {
          const n = Number(o.dailyCap);
          if (!Number.isInteger(n) || n < 0 || n > 200) throw new Error("The GhostCLI daily limit must be 0–200.");
          gc.dailyCap = n;
        }
        if (o.models !== undefined) {
          const list = Array.isArray(o.models) ? o.models.map((m) => String(m).trim()).filter(Boolean) : [];
          if (list.length > 10 || list.some((m) => m.length > 120 || !/^ghostcli\/[\w./:-]+$/.test(m))) throw new Error("Pick GhostCLI models (ghostcli/…), at most 10.");
          gc.models = [...new Set(list)];
        }
        cur.ghostcli = gc;
      }
      // Claude Code (Settings › Task inbox card): on/off, Run tap per task, the daily cap, the two quota thresholds, the model.
      if (b.claude && typeof b.claude === "object") {
        const o = b.claude as Record<string, unknown>;
        const cl = { ...cur.claude };
        if (typeof o.enabled === "boolean") cl.enabled = o.enabled;
        if (typeof o.askRun === "boolean") cl.askRun = o.askRun;
        const n = (k: "dailyCap" | "fiveHourMax" | "weekMax", min: number, max: number) => {
          if (o[k] === undefined) return;
          const v = Number(o[k]);
          if (!Number.isInteger(v) || v < min || v > max) throw new Error(`The Claude Code ${k} must be ${min}–${max}.`);
          cl[k] = v;
        };
        n("dailyCap", 0, 50);
        n("fiveHourMax", 10, 100);
        n("weekMax", 10, 100);
        if (o.model !== undefined) {
          const m = String(o.model).trim();
          if (m.length > 80 || !/^[\w.:[\]-]*$/.test(m)) throw new Error("The Claude model name has odd characters.");
          cl.model = m;
        }
        cur.claude = cl;
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
    void inbox.pumpGhostcli().catch(() => undefined);
    return inbox.state(isLocalRequest(req));
  });
}
