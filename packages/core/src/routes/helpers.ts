import type { FastifyInstance } from "fastify";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { KesherServices } from "../services.js";
import { agentFileText, projectAgents, type AgentDef } from "../agents.js";

/**
 * Helpers in the chat (docs/RESEARCH_LOG.md, "Helper agents in the chat"): a chat's runs (the helpers strip and the
 * cards; live updates come as `helpers` events on the chat's own event stream, so the phone in remote gets them the
 * same way), Stop for one or all, the once-per-project answer for a cloud helper, starting the outside agent as a
 * helper (only the user does), and Settings > Helpers (the model per type with what Auto picks on this computer,
 * steps, at once, the time cap, and the user's own helpers as agent files).
 */

/** The model choices a type accepts besides a model id. */
const TIERS = new Set(["auto", "inherit", "small", "strong"]);

/** A helper file's name from its name: `design-check.md`. */
function fileNameOf(name: string): string {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 50);
  return `${slug || "helper"}.md`;
}

/**
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function helperRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const helpers = () => s.conversations.helpers;
  /** The run, only when it is this chat's. */
  const runOf = (id: string, hid: string) => {
    const r = helpers().runs.get(hid);
    return r && r.chatId === id ? r : undefined;
  };

  /** The chat's runs, and the agents its `@` menu offers (the built-in types, personas, the project's files). */
  app.get<{ Params: { id: string } }>("/api/conversations/:id/helpers", async (req) => {
    const opened = await s.conversations.open(req.params.id).catch(() => undefined);
    const code = opened?.conversation.kind === "code";
    return {
      runs: helpers().runs.list(req.params.id),
      agents: [
        ...["lookup", "research", "build"].filter((k) => k !== "build" || code).map((name) => ({ name, builtin: true })),
        ...(opened ? s.conversations.helperAgents(req.params.id).map((a) => ({ name: a.name, description: a.description.slice(0, 120) })) : []),
        ...(code ? [{ name: "antigravity", external: true }] : []),
      ],
    };
  });

  /** One run with its whole report ("Show all"). */
  app.get<{ Params: { id: string; hid: string } }>("/api/conversations/:id/helpers/:hid", async (req, reply) => {
    const r = runOf(req.params.id, req.params.hid);
    return r ?? reply.code(404).send({ error: "No such sub-agent" });
  });

  app.post<{ Params: { id: string; hid: string } }>("/api/conversations/:id/helpers/:hid/stop", async (req, reply) => {
    if (!runOf(req.params.id, req.params.hid)) return reply.code(404).send({ error: "No such sub-agent" });
    return { stopped: helpers().runs.stop(req.params.hid) };
  });

  /** "Stop all" in the strip: the helpers only (the chat's own Stop stops the chat and them). */
  app.post<{ Params: { id: string } }>("/api/conversations/:id/helpers/stop", async (req) => ({ stopped: helpers().runs.stopAll(req.params.id) }));

  /** The card's question (a cloud helper and the project's files): asked once per project, the answer is kept. */
  app.post<{ Params: { id: string; hid: string }; Body: { yes?: boolean } }>("/api/conversations/:id/helpers/:hid/answer", async (req, reply) => {
    if (!runOf(req.params.id, req.params.hid)) return reply.code(404).send({ error: "No such sub-agent" });
    return { ok: helpers().runs.answer(req.params.hid, req.body?.yes === true) };
  });

  /** Starts the outside agent (Antigravity) as a helper; only from the user (the composer's @antigravity). */
  app.post<{ Params: { id: string }; Body: { kind?: string; task?: string } }>("/api/conversations/:id/helpers", async (req, reply) => {
    if (req.body?.kind !== "external") return reply.code(400).send({ error: "Only an outside agent is started here; the lead agent starts the sub-agents." });
    const opened = await s.conversations.open(req.params.id);
    if (!opened) return reply.code(404).send({ error: "Conversation not found" });
    try {
      return { run: helpers().startExternal(req.params.id, String(req.body.task ?? "").slice(0, 20_000)) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** Settings > Helpers: the settings, what Auto picks on this computer and why, the models to choose from, the user's own helpers. */
  app.get("/api/helpers/settings", async () => {
    const h = s.config.helpers;
    const [explain, listing] = await Promise.all([helpers().explain(), s.registry.listAllModels().catch(() => ({ models: [] as Array<{ id: string; category?: string; providerModelId: string }> }))]);
    const models = listing.models.filter((m) => (m.category === "chat" || m.category === "code") && !/embed|whisper|tts|rerank/i.test(m.providerModelId)).map((m) => m.id).slice(0, 200);
    const mine = [
      ...(s.personas?.now() ?? []).filter((p) => p.agentWhen).map((p) => ({ name: p.name, description: p.agentWhen!, source: "persona" as const, model: p.modelId ?? "inherit", icon: p.icon })),
      ...s.library.listProjects().flatMap((p) => (p.workspace ? projectAgents(p.workspace, true).map((a: AgentDef) => ({ name: a.name, description: a.description, source: "project" as const, project: p.id, projectName: p.name, file: a.file, model: a.model ?? a.tier ?? "inherit", instructions: a.instructions, tools: a.tools, background: !!a.background, maxTurns: a.maxTurns, maxMinutes: a.maxMinutes })) : [])),
    ].slice(0, 60);
    return {
      settings: { models: h.models, steps: h.steps, atOnce: h.atOnce ?? null, minutes: h.minutes, cloudProjects: Object.keys(h.cloudProjects).length },
      explain,
      models,
      mine,
      projects: s.library.listProjects().filter((p) => p.workspace).map((p) => ({ id: p.id, name: p.name })),
    };
  });

  app.put<{ Body: { models?: Record<string, string>; steps?: Record<string, number>; atOnce?: number | null; minutes?: number; forgetCloud?: boolean } }>("/api/helpers/settings", async (req, reply) => {
    const h = s.config.helpers;
    const b = req.body ?? {};
    for (const k of ["lookup", "research", "build"] as const) {
      const m = b.models?.[k];
      if (typeof m === "string" && m.trim()) {
        if (!TIERS.has(m) && m.length > 300) return reply.code(400).send({ error: "Model id too long" });
        h.models[k] = m.trim();
      }
      const n = Number(b.steps?.[k]);
      if (b.steps?.[k] !== undefined && Number.isFinite(n)) h.steps[k] = Math.min(60, Math.max(2, Math.round(n)));
    }
    if (b.atOnce === null) delete h.atOnce;
    else if (typeof b.atOnce === "number" && Number.isFinite(b.atOnce)) h.atOnce = Math.min(4, Math.max(1, Math.round(b.atOnce)));
    if (typeof b.minutes === "number" && Number.isFinite(b.minutes)) h.minutes = Math.min(60, Math.max(1, Math.round(b.minutes)));
    // "Ask again": the per-project answers for cloud helpers are forgotten.
    if (b.forgetCloud) h.cloudProjects = {};
    await s.saveConfig();
    return { ok: true };
  });

  /** New or changed helper: an agent file in the project's `.kesher/agents/` (Claude Code's format, so it works there too). */
  app.post<{ Body: { project?: string; file?: string; name?: string; description?: string; instructions?: string; tools?: string[]; model?: string; background?: boolean; maxTurns?: number; maxMinutes?: number } }>("/api/helpers/agents", async (req, reply) => {
    const b = req.body ?? {};
    const project = s.library.getProject(String(b.project ?? ""));
    if (!project?.workspace) return reply.code(400).send({ error: "Choose a project with a folder." });
    const name = String(b.name ?? "").replace(/\s+/g, "-").trim().slice(0, 60);
    const description = String(b.description ?? "").trim().slice(0, 500);
    const instructions = String(b.instructions ?? "").trim().slice(0, 20_000);
    if (!name || !description || !instructions) return reply.code(400).send({ error: "An agent needs a name, when to use it, and instructions." });
    const dir = join(project.workspace, ".kesher", "agents");
    // Changing a file keeps its name; a new one gets one from its name.
    const fileName = typeof b.file === "string" && /^\.kesher\/agents\/[^/\\]+\.md$/.test(b.file) ? b.file.split("/").pop()! : fileNameOf(name);
    const path = resolve(dir, fileName);
    if (!path.startsWith(resolve(dir) + sep)) return reply.code(400).send({ error: "Bad file name" });
    const model = typeof b.model === "string" && b.model.trim() ? b.model.trim().slice(0, 300) : "auto";
    const tools = Array.isArray(b.tools) ? b.tools.filter((t): t is string => typeof t === "string" && /^[\w-]{1,40}$/.test(t)).slice(0, 30) : undefined;
    const text = agentFileText({
      name,
      description,
      instructions,
      ...(tools?.length ? { tools } : {}),
      ...(TIERS.has(model) ? { tier: model as "auto" | "inherit" | "small" | "strong" } : { model }),
      ...(b.background ? { background: true } : {}),
      ...(Number(b.maxTurns) > 0 ? { maxTurns: Math.min(60, Math.round(Number(b.maxTurns))) } : {}),
      ...(Number(b.maxMinutes) > 0 ? { maxMinutes: Math.min(60, Math.round(Number(b.maxMinutes))) } : {}),
    });
    await mkdir(dir, { recursive: true });
    await writeFile(path, text, "utf8");
    projectAgents(project.workspace, true);
    return { file: `.kesher/agents/${fileName}`, text };
  });

  app.delete<{ Body: { project?: string; file?: string } }>("/api/helpers/agents", async (req, reply) => {
    const project = s.library.getProject(String(req.body?.project ?? ""));
    const file = String(req.body?.file ?? "");
    if (!project?.workspace || !/^\.kesher\/agents\/[^/\\]+\.md$/.test(file)) return reply.code(400).send({ error: "Only an agent made here (.kesher/agents) can be deleted here." });
    await rm(join(project.workspace, ".kesher", "agents", file.split("/").pop()!), { force: true });
    projectAgents(project.workspace, true);
    return { ok: true };
  });
}
