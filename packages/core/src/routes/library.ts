import type { FastifyInstance } from "fastify";
import { cloudFolders } from "../cloud-folders.js";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentEvent, ConversationKind, PermissionMode, Project, Teammate } from "@kesher/shared";
import type { KesherServices } from "../services.js";
import { startSSE } from "../sse.js";
import { assertFolder, NoModelError } from "../conversations.js";
import { geminiHtmlToActivity, readExport, readJanThreads } from "../chat-import.js";
import { findClaudeSessions, readClaudeSession } from "../claude-code-import.js";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";
import { conversationHtml, conversationMarkdown, exportFileName } from "../chat-export.js";
import { assertWritableFolder } from "../library.js";
import { isLocalRequest } from "../auth.js";
import { allowThroughFirewall, type FirewallResult } from "../firewall.js";
import { readProject } from "../unreal-install.js";
import { findGameProjects, findScripts } from "../game-projects.js";

const MODES: PermissionMode[] = ["plan", "ask", "auto-edit", "auto"];

/**
 * Projects, conversations (each one a live agent session), approvals,
 * questions, and app settings (active models, sync folder).
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function libraryRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  // ---------- Projects ----------
  app.get("/api/projects", async () => s.library.listProjects());

  app.post<{ Body: { name?: string; workspace?: string; instructions?: string } }>("/api/projects", async (req, reply) => {
    const name = req.body?.name?.trim();
    if (!name) return reply.code(400).send({ error: "A project needs a name" });
    if (req.body.workspace) {
      try {
        await assertFolder(req.body.workspace);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
    const now = new Date().toISOString();
    const project: Project = {
      id: randomUUID(),
      name,
      ...(req.body.workspace ? { workspace: req.body.workspace } : {}),
      ...(req.body.instructions ? { instructions: req.body.instructions } : {}),
      createdAt: now,
      updatedAt: now,
    };
    return s.library.saveProject(project);
  });

  app.patch<{ Params: { id: string }; Body: Partial<Pick<Project, "name" | "workspace" | "instructions">> }>("/api/projects/:id", async (req, reply) => {
    const project = s.library.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    if (req.body.workspace) {
      try {
        await assertFolder(req.body.workspace);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
    return s.library.saveProject({ ...project, ...req.body });
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (req) => {
    await s.library.deleteProject(req.params.id);
    return { ok: true };
  });

  // ---------- Conversations ----------
  app.get<{ Querystring: { projectId?: string } }>("/api/conversations", async (req) => {
    const q = req.query.projectId;
    return s.library.listConversations(q === undefined ? undefined : q === "none" ? null : q);
  });

  /** One search across chats, knowledge bases and (on this computer) "My day" and meetings. */
  /**
   * Imports chats exported from ChatGPT, Claude or Gemini. Body: `{ data }`,
   * the parsed `conversations.json` or `MyActivity.json` (the page takes it
   * out of the export's zip), and optionally `projectId`.
   */
  app.post<{ Body: { data?: unknown; html?: string; projectId?: string | null } }>("/api/import/chats", { bodyLimit: 400 * 1024 * 1024 }, async (req, reply) => {
    try {
      // Google Takeout's default format is HTML (MyActivity.html): read it into the same list the JSON holds.
      const html = typeof req.body?.html === "string" ? geminiHtmlToActivity(req.body.html) : undefined;
      if (html && !html.length) return reply.code(400).send({ error: "This HTML file has no Gemini activity in it. Use MyActivity.html from Google Takeout (My Activity → Gemini Apps)." });
      const { source, chats } = readExport(html ?? req.body?.data);
      if (!chats.length) return reply.code(400).send({ error: "The export has no chats with text in them." });
      const projectId = req.body?.projectId ?? null;
      if (projectId && !s.library.getProject(projectId)) return reply.code(400).send({ error: "That project does not exist." });
      return { source, found: chats.length, ...(await s.conversations.importChats(chats, projectId)) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Jan's chats, read from its data folder on this computer (only read; this computer only).
  const janThreads = async () => {
    const appData = process.env.APPDATA ?? joinPath(homedir(), "AppData", "Roaming");
    for (const dir of [joinPath(appData, "Jan", "data", "threads"), joinPath(appData, "jan", "data", "threads"), joinPath(homedir(), "Library", "Application Support", "Jan", "data", "threads"), joinPath(homedir(), "jan", "threads")]) {
      const chats = await readJanThreads(dir);
      if (chats.length) return chats;
    }
    return [];
  };
  app.get("/api/import/jan", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Only on the computer that runs KesherAI." });
    return { found: (await janThreads()).length };
  });
  app.post<{ Body: { projectId?: string | null } }>("/api/import/jan", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Only on the computer that runs KesherAI." });
    const chats = await janThreads();
    if (!chats.length) return reply.code(400).send({ error: "No Jan chats were found on this computer." });
    const projectId = req.body?.projectId ?? null;
    if (projectId && !s.library.getProject(projectId)) return reply.code(400).send({ error: "That project does not exist." });
    return { source: "jan", found: chats.length, ...(await s.conversations.importChats(chats, projectId)) };
  });

  // Claude Code's sessions on this computer: continue one in a code chat on the local model (the CoolDown handoff).
  // Session files can hold secrets from commands, so they are read only here, never from another device.
  app.get("/api/import/claude-code", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Only on the computer that runs KesherAI." });
    return { sessions: await findClaudeSessions() };
  });
  app.post<{ Body: { file?: string } }>("/api/import/claude-code", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Only on the computer that runs KesherAI." });
    try {
      const chat = await readClaudeSession(String(req.body?.file ?? ""));
      if (!chat) return reply.code(400).send({ error: "That session has no messages." });
      const r = await s.conversations.importChats([chat]);
      return { ...r, id: r.ids[0] };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // An outside agent's own choices (Antigravity: model, thinking level), for the chip in its code chat.
  app.get<{ Params: { id: string } }>("/api/conversations/:id/agent-options", async (req, reply) => {
    try {
      return { options: await s.conversations.agentOptions(req.params.id) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
  app.put<{ Params: { id: string }; Body: { configId?: string; value?: string } }>("/api/conversations/:id/agent-options", async (req, reply) => {
    const { configId, value } = req.body ?? {};
    if (typeof configId !== "string" || typeof value !== "string" || configId.length > 200 || value.length > 200) return reply.code(400).send({ error: "Which choice, and which value?" });
    try {
      return { options: await s.conversations.setAgentOption(req.params.id, configId, value) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get<{ Querystring: { q?: string } }>("/api/search", async (req) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) return { chats: [], knowledge: [], day: [] };
    const [chats, knowledge, day] = await Promise.all([
      s.conversationSearch.search(q, 8),
      s.knowledge.search(q, undefined, 5).catch(() => []),
      isLocalRequest(req) ? s.journal.search(q, 8).catch(() => []) : Promise.resolve([]),
    ]);
    return { chats, knowledge: knowledge.map((h) => ({ ...h, text: h.text.replace(/\s+/g, " ").slice(0, 220) })), day: day.map(({ frame: _f, ...d }) => d) };
  });

  /** Search every conversation: `?q=words` → the best matches with a passage. */
  app.get<{ Querystring: { q?: string; limit?: string } }>("/api/conversations/search", async (req) => s.conversationSearch.search(String(req.query.q ?? ""), Math.min(50, Math.max(1, Number(req.query.limit) || 20))));

  /** Which conversations are working right now (`running`) or waiting for an answer (`waiting`). */
  app.get("/api/conversations/activity", async () => s.conversations.activity());

  app.post<{ Body: { projectId?: string | null; kind?: ConversationKind; modelId?: string; mode?: PermissionMode; workspace?: string; personaId?: string } }>(
    "/api/conversations",
    async (req, reply) => {
      const b = req.body ?? {};
      if (b.mode && !MODES.includes(b.mode)) return reply.code(400).send({ error: "Unknown mode" });
      try {
        const c = await s.conversations.create({
          kind: b.kind === "code" ? "code" : "chat",
          ...(b.projectId !== undefined ? { projectId: b.projectId } : {}),
          ...(b.modelId ? { modelId: b.modelId } : {}),
          ...(b.mode ? { mode: b.mode } : {}),
          ...(b.workspace ? { workspace: b.workspace } : {}),
          ...(b.personaId ? { personaId: b.personaId } : {}),
        });
        const { messages: _m, events: _e, ...summary } = c;
        return summary;
      } catch (err) {
        if (err instanceof NoModelError) return reply.code(400).send({ error: err.message, code: "no-model", category: err.category });
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.get<{ Params: { id: string } }>("/api/conversations/:id", async (req, reply) => {
    const opened = await s.conversations.open(req.params.id);
    if (!opened) return reply.code(404).send({ error: "Conversation not found" });
    const { messages: _m, events: _e, ...summary } = opened.conversation;
    const interrupted = (await s.conversations.interrupted()).find((x) => x.id === req.params.id);
    return { ...summary, session: opened.session.info(), events: opened.session.events, ...(interrupted ? { interruptedAt: interrupted.at } : {}) };
  });

  // A chat KesherAI stopped by closing (an update, a restart): continue it from where it stopped, or just dismiss.
  app.post<{ Params: { id: string }; Body: { dismiss?: boolean } }>("/api/conversations/:id/resume", async (req, reply) => {
    try {
      const ok = await s.conversations.resumeInterrupted(req.params.id, req.body?.dismiss === true);
      if (!ok) return reply.code(404).send({ error: "Nothing to continue in this chat." });
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.patch<{ Params: { id: string }; Body: { title?: string; modelId?: string; mode?: PermissionMode; projectId?: string | null; team?: Teammate[]; group?: string[]; personaId?: string | null } }>(
    "/api/conversations/:id",
    async (req, reply) => {
      const b = req.body ?? {};
      if (b.mode && !MODES.includes(b.mode)) return reply.code(400).send({ error: "Unknown mode" });
      if (b.team && (!Array.isArray(b.team) || b.team.some((m) => !m || typeof m.modelId !== "string" || (m.role !== "planner" && m.role !== "reviewer")))) {
        return reply.code(400).send({ error: "A teammate needs a modelId and the role planner or reviewer." });
      }
      if (b.group && (!Array.isArray(b.group) || b.group.some((x) => typeof x !== "string") || b.group.length > 8)) return reply.code(400).send({ error: "A group is a list of up to 8 persona ids." });
      const c = await s.conversations.update(req.params.id, b);
      if (!c) return reply.code(404).send({ error: "Conversation not found" });
      const { messages: _m, events: _e, ...summary } = c;
      return summary;
    },
  );

  app.delete<{ Params: { id: string } }>("/api/conversations/:id", async (req) => {
    await s.conversations.delete(req.params.id);
    return { ok: true };
  });

  /**
   * Live events as Server-Sent Events. Replays saved events after `?after=<seq>`
   * (default: all), then streams new ones, including text deltas (seq 0) and
   * the session info after every change, as `{ "type": "info", ... }`.
   */
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/conversations/:id/events", async (req, reply) => {
    const opened = await s.conversations.open(req.params.id);
    if (!opened) return reply.code(404).send({ error: "Conversation not found" });
    const { session } = opened;
    const sse = startSSE(req, reply);
    const after = Number(req.query.after ?? 0);
    for (const e of session.events) if (e.seq > after) sse.send(e);
    sse.send({ type: "info", ...session.info() });
    const onEvent = (e: AgentEvent) => {
      sse.send(e);
      if (e.type !== "assistant_delta") sse.send({ type: "info", ...session.info() });
    };
    session.on("event", onEvent);
    // Every 10 s: the page reopens a stream that stayed quiet for 25 s (a phone network or the tunnel can stall it silently).
    const ping = setInterval(() => sse.send({ type: "ping" }), 10_000);
    sse.closed.addEventListener("abort", () => {
      clearInterval(ping);
      session.off("event", onEvent);
    });
  });

  /** Coding sessions: puts the project folder back as it was before a message (the current state is saved first). */
  app.post<{ Params: { id: string; cp: string } }>("/api/conversations/:id/checkpoints/:cp/restore", async (req, reply) => {
    if (!/^[0-9a-f]{40}$/.test(req.params.cp)) return reply.code(400).send({ error: "Bad checkpoint" });
    try {
      await s.conversations.restoreCheckpoint(req.params.id, req.params.cp);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** Lets the queue go on after Stop. */
  app.post<{ Params: { id: string } }>("/api/conversations/:id/queue/resume", async (req) => {
    await s.conversations.resumeQueue(req.params.id);
    return { ok: true };
  });

  /** Removes a message from the queue (it was sent while the agent was busy). */
  app.delete<{ Params: { id: string; qid: string } }>("/api/conversations/:id/queue/:qid", async (req, reply) =>
    s.conversations.unqueue(req.params.id, req.params.qid) ? { ok: true } : reply.code(404).send({ error: "Not in the queue" }),
  );

  app.post<{ Params: { id: string }; Body: { text?: string; web?: boolean } }>("/api/conversations/:id/messages", async (req, reply) => {
    const text = req.body?.text?.trim();
    if (!text) return reply.code(400).send({ error: "Empty message" });
    try {
      const r = await s.conversations.send(req.params.id, text, { web: req.body?.web === true });
      // Written on the phone: its answer notifies the phone even when it is short.
      if (!isLocalRequest(req)) s.notifier.messageFromPhone(req.params.id);
      return { ok: true, ...r };
    } catch (err) {
      const msg = (err as Error).message;
      return reply.code(/not found/i.test(msg) ? 404 : 409).send({ error: msg });
    }
  });

  app.post<{ Params: { id: string; requestId: string }; Body: { decision?: "allow" | "always" | "deny"; feedback?: string; scope?: "conversation" | "model" | "everywhere"; minutes?: number; command?: string } }>(
    "/api/conversations/:id/approvals/:requestId",
    async (req, reply) => {
      const opened = await s.conversations.open(req.params.id);
      const d = req.body?.decision;
      if (!opened) return reply.code(404).send({ error: "Conversation not found" });
      if (d !== "allow" && d !== "always" && d !== "deny") return reply.code(400).send({ error: "decision must be allow, always or deny" });
      if (d === "always") {
        // Remember it, so it also holds after a restart (and, by scope, in other conversations).
        const ev = opened.session.events.find((e) => e.type === "approval_request" && e.requestId === req.params.requestId);
        const tool = ev && ev.type === "approval_request" ? ev.name : undefined;
        const scope = req.body.scope ?? "conversation";
        if (tool) {
          const rule = {
            tool,
            scope,
            ...(scope === "conversation" ? { conversationId: req.params.id } : {}),
            ...(scope === "model" ? { modelId: opened.session.modelId } : {}),
            createdAt: new Date().toISOString(),
            // For a while (1 hour, today, a week…) or for good.
            ...(Number(req.body.minutes) > 0 ? { until: new Date(Date.now() + Math.min(Number(req.body.minutes), 366 * 24 * 60) * 60_000).toISOString() } : {}),
            // Only this command (its start, e.g. "pnpm test"), not every command.
            ...(typeof req.body.command === "string" && req.body.command.trim() ? { command: req.body.command.trim().slice(0, 200) } : {}),
          };
          const same = (r: { tool: string; scope: string; conversationId?: string; modelId?: string; command?: string }) => r.tool === rule.tool && r.scope === rule.scope && r.conversationId === rule.conversationId && r.modelId === rule.modelId && r.command === (rule as { command?: string }).command;
          // A newer answer replaces the old rule (e.g. "for an hour" after "for good"); rules that ended are dropped.
          s.config.permissions = [...s.config.permissions.filter((r) => !same(r) && !(r.until && Date.parse(r.until) <= Date.now())), rule];
          await s.saveConfig();
        }
      }
      if (!opened.session.approve(req.params.requestId, d, req.body.feedback)) return reply.code(404).send({ error: "That request is no longer waiting" });
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string; questionId: string }; Body: { text?: string } }>("/api/conversations/:id/answers/:questionId", async (req, reply) => {
    const opened = await s.conversations.open(req.params.id);
    if (!opened) return reply.code(404).send({ error: "Conversation not found" });
    if (!opened.session.answer(req.params.questionId, req.body?.text ?? "")) return reply.code(404).send({ error: "That question is no longer waiting" });
    return { ok: true };
  });

  /**
   * A file sent from another device (shared from the phone): saved in the
   * conversation's own folder under `shared/`. Raw bytes, `?name=`.
   */
  app.post<{ Params: { id: string }; Querystring: { name?: string } }>("/api/conversations/:id/files", { bodyLimit: 60 * 1024 * 1024 }, async (req, reply) => {
    const conv = await s.library.getConversation(req.params.id);
    if (!conv) return reply.code(404).send({ error: "Conversation not found" });
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || !body.length) return reply.code(400).send({ error: "Send the file's bytes as application/octet-stream." });
    const folder = s.conversations.workspaceOf(conv);
    if (!folder) return reply.code(409).send({ error: "This conversation has no folder." });
    const name = (String(req.query.name ?? "file").split(/[\\/]/).pop() ?? "file").replace(/[^\p{L}\p{N} ._()-]/gu, "_").slice(0, 120) || "file";
    const dir = join(folder, "shared");
    await mkdir(dir, { recursive: true });
    let path = join(dir, name);
    for (let i = 2; existsSync(path); i++) path = join(dir, name.replace(/(\.[^.]*)?$/, ` (${i})$1`));
    await writeFile(path, body);
    return { path, name: basename(path) };
  });

  /**
   * The chat as a file: `?format=md` (Markdown) or `html` (a print-ready page;
   * `&print=1` opens the print dialog, to save it as a PDF). `&download=1`
   * asks the browser to save it.
   */
  app.get<{ Params: { id: string }; Querystring: { format?: string; print?: string; download?: string } }>("/api/conversations/:id/export", async (req, reply) => {
    const conv = await s.library.getConversation(req.params.id);
    if (!conv) return reply.code(404).send({ error: "Conversation not found" });
    const html = req.query.format === "html";
    const name = exportFileName(conv, html ? "html" : "md");
    if (req.query.download) reply.header("content-disposition", `attachment; filename="chat.${html ? "html" : "md"}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    reply.type(html ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8");
    // The printable page: its own styles and pictures only; a script only for the print dialog.
    if (html) reply.header("content-security-policy", `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; script-src ${req.query.print ? "'unsafe-inline'" : "'none'"}; base-uri 'none'; form-action 'none'`);
    return html ? conversationHtml(conv, !!req.query.print) : conversationMarkdown(conv);
  });

  /** "Keep going until done": `{ goal }` sets it and sends it; an empty goal stops it. */
  app.get<{ Params: { id: string } }>("/api/conversations/:id/goal", async (req) => s.conversations.goalOf(req.params.id) ?? {});
  app.post<{ Params: { id: string }; Body: { goal?: string } }>("/api/conversations/:id/goal", async (req, reply) => {
    try {
      await s.conversations.setGoal(req.params.id, String(req.body?.goal ?? ""));
      return s.conversations.goalOf(req.params.id) ?? {};
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  /** Gives the conversation access to a folder or file outside its own (the paper clip, or drag and drop). */
  app.post<{ Params: { id: string }; Body: { path?: string } }>("/api/conversations/:id/access", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Files can only be attached on this computer." });
    const opened = await s.conversations.open(req.params.id);
    if (!opened) return reply.code(404).send({ error: "Conversation not found" });
    try {
      return { path: await opened.session.grant(req.body?.path ?? "") };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /**
   * Adds a game project to a chat (the + menu → Project): a Unity project becomes the chat's Unity
   * project (its tools work on it through the CLI), an Unreal project is opened to the chat's file tools
   * and the Blueprint tools; any other folder is opened to the file tools. Only on this computer.
   */
  const gameProjects = async () => findGameProjects({ unity: (await s.unity.status().catch(() => ({ projects: [] as string[] }))).projects, ...(s.unreal.projectFile ? { unrealFile: s.unreal.projectFile } : {}) });
  /** The Unity and Unreal projects found on this computer, to add to a chat (also from the phone). */
  app.get("/api/game-projects", async () => ({ projects: await gameProjects() }));

  /**
   * The task board's project for this chat (+ → Tasks from the board in a plain chat): the folder of the latest
   * code chat that is a git project inside the home folder, granted to this chat so its model reaches the code
   * here, without a new chat. The server picks the folder; the request never names one (also from the phone).
   */
  app.post<{ Params: { id: string } }>("/api/conversations/:id/board-project", async (req, reply) => {
    const home = homedir();
    const inHome = (f: string) => f.toLowerCase().startsWith(join(home, "").toLowerCase()) && f.length > home.length + 1;
    const folder = s.library
      .listConversations()
      .filter((c) => c.kind === "code" && typeof c.workspace === "string")
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map((c) => c.workspace as string)
      .find((f) => inHome(f) && existsSync(join(f, ".git")));
    if (!folder) return reply.code(404).send({ error: "No project yet: open a code chat in the project's folder once." });
    const opened = await s.conversations.open(req.params.id);
    if (!opened) return reply.code(404).send({ error: "Conversation not found" });
    try {
      const path = await opened.session.grant(folder);
      return { path, line: `[${basename(path)}: ${path}]` };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post<{ Params: { id: string }; Body: { path?: string } }>("/api/conversations/:id/project", async (req, reply) => {
    const folder = String(req.body?.path ?? "");
    // From the phone (remote): only a project found on the computer (never any folder by path).
    if (!isLocalRequest(req) && !(await gameProjects()).some((p) => p.path === folder)) return reply.code(403).send({ error: "From the phone, choose one of the projects found on the computer." });
    const opened = await s.conversations.open(req.params.id);
    if (!opened) return reply.code(404).send({ error: "Conversation not found" });
    try {
      const path = await opened.session.grant(folder);
      const name = basename(path);
      if (existsSync(join(path, "Assets")) && existsSync(join(path, "ProjectSettings"))) {
        await s.unity.addProject(path);
        const pk = s.unity.packagesOf(path);
        return { kind: "unity", name, path, line: `[Unity project: ${name} — ${path}${pk.pipeline ? "" : " (needs Unity's Pipeline package: 🕹 → Install now)"}]` };
      }
      const up = await readProject(path).catch(() => undefined);
      if (up) {
        const live = s.unreal.connected ? "the editor is connected" : "open it in Unreal with the KesherAI Bridge plugin, or Unreal 5.8's MCP (Create → Unreal Blueprints)";
        return { kind: "unreal", name, path, engine: up.engine, connected: s.unreal.connected, line: `[Unreal project: ${name}, UE ${up.engine || "?"} — ${path}; ${live}]` };
      }
      return { kind: "folder", name, path, line: `[${name}: ${path}]` };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** Scripts in the chat's folders (its workspace and the projects/files given to it), by part of the name: + → Script. */
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>("/api/conversations/:id/scripts", async (req, reply) => {
    const opened = await s.conversations.open(req.params.id);
    if (!opened) return reply.code(404).send({ error: "Conversation not found" });
    const ws = opened.session.info().workspace;
    const roots = [...opened.session.grants, ...(ws ? [ws] : [])];
    return { roots, scripts: roots.length ? await findScripts(roots, String(req.query.q ?? "").slice(0, 100)) : [] };
  });

  /** "Another answer": the last answer is written again; the earlier one stays as a version. */
  app.post<{ Params: { id: string } }>("/api/conversations/:id/regenerate", async (req, reply) => {
    try {
      await s.conversations.regenerate(req.params.id);
      return { ok: true };
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/conversations/:id/stop", async (req, reply) => {
    const opened = await s.conversations.open(req.params.id);
    if (!opened) return reply.code(404).send({ error: "Conversation not found" });
    s.conversations.stop(req.params.id);
    return { ok: true };
  });

  /** What the model reads on its next turn: system prompt, tools, messages, with sizes. */
  app.get<{ Params: { id: string } }>("/api/conversations/:id/context", async (req, reply) => {
    const opened = await s.conversations.open(req.params.id);
    if (!opened) return reply.code(404).send({ error: "Conversation not found" });
    return opened.session.contextView();
  });

  /** Branch at an event (`seq`); with `text`, edit that message of the user's and resend it in the branch. */
  app.post<{ Params: { id: string }; Body: { seq?: number; text?: string } }>("/api/conversations/:id/branch", async (req, reply) => {
    const seq = Number(req.body?.seq);
    if (!Number.isInteger(seq) || seq < 1) return reply.code(400).send({ error: "Say which message to branch at." });
    if (req.body?.text !== undefined && !String(req.body.text).trim()) return reply.code(400).send({ error: "The edited message is empty." });
    try {
      const c = await s.conversations.branch(req.params.id, seq, req.body?.text);
      const { messages: _m, events: _e, ...summary } = c;
      return summary;
    } catch (err) {
      return reply.code(/not found/i.test((err as Error).message) ? 404 : 400).send({ error: (err as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/conversations/:id/undo", async (req, reply) => {
    const opened = await s.conversations.open(req.params.id);
    if (!opened) return reply.code(404).send({ error: "Conversation not found" });
    try {
      const path = await opened.session.undo();
      return path ? { ok: true, path } : reply.code(409).send({ error: "Nothing to undo" });
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });

  // ---------- Permanent approvals ----------
  app.get("/api/permissions", async () => s.config.permissions);
  app.delete<{ Params: { index: string } }>("/api/permissions/:index", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Approvals can only be changed on this computer." });
    const i = Number(req.params.index);
    if (!Number.isInteger(i) || i < 0 || i >= s.config.permissions.length) return reply.code(404).send({ error: "No such approval" });
    s.config.permissions.splice(i, 1);
    await s.saveConfig();
    return s.config.permissions;
  });

  // ---------- Settings ----------
  app.get("/api/settings", async () => ({
    activeModels: s.config.activeModels,
    syncFolder: s.config.syncFolder ?? null,
    remote: { enabled: s.config.remote.enabled, keepAwake: s.config.remote.keepAwake },
  }));

  /** Cloud folders found on this computer (OneDrive, Google Drive, Dropbox, iCloud), to back up to with one click. */
  app.get("/api/sync/suggestions", async () => cloudFolders());

  app.put<{ Body: { activeModels?: Record<string, string>; syncFolder?: string | null; remote?: { enabled?: boolean; keepAwake?: boolean } } }>("/api/settings", async (req, reply) => {
    const b = req.body ?? {};
    if (b.remote && !isLocalRequest(req)) return reply.code(403).send({ error: "Remote access can only be changed on this computer." });
    let firewall: FirewallResult | undefined;
    if (typeof b.remote?.enabled === "boolean") {
      s.config.remote.enabled = b.remote.enabled;
      // Let the phone through Windows Firewall (Windows asks the user once).
      if (b.remote.enabled) firewall = await allowThroughFirewall(s.config.port).catch(() => undefined);
    }
    if (typeof b.remote?.keepAwake === "boolean") s.config.remote.keepAwake = b.remote.keepAwake;
    if (b.activeModels) {
      s.config.activeModels = Object.fromEntries(Object.entries(b.activeModels).filter(([, v]) => typeof v === "string" && v));
    }
    let synced: number | undefined;
    if (b.syncFolder !== undefined) {
      if (b.syncFolder) {
        try {
          // A cloud folder's KesherAI sub-folder is made the first time.
          const cloud = cloudFolders().some((c) => c.folder === b.syncFolder);
          if (cloud) await mkdir(b.syncFolder, { recursive: true });
          await assertWritableFolder(b.syncFolder);
        } catch (err) {
          return reply.code(400).send({ error: (err as Error).message });
        }
        s.config.syncFolder = b.syncFolder;
        await s.library.importFromSync();
        await s.library.load();
        synced = await s.library.exportToSync();
      } else {
        delete s.config.syncFolder;
      }
    }
    await s.saveConfig();
    return {
      activeModels: s.config.activeModels,
      syncFolder: s.config.syncFolder ?? null,
      remote: { enabled: s.config.remote.enabled, keepAwake: s.config.remote.keepAwake },
      ...(synced !== undefined ? { synced } : {}),
      ...(firewall ? { firewall } : {}),
    };
  });

  // ---------- Updates ----------
  app.get("/api/version", async () => s.updater.version());
  app.get("/api/updates", async (_req, reply) => {
    try {
      return await s.updater.check();
    } catch (err) {
      return reply.code(503).send({ error: (err as Error).message });
    }
  });
  app.get("/api/updates/progress", async () => s.updater.status());
  /** Long builds running now (they keep going through an update; the chat joins them again after the restart). */
  app.get("/api/jobs", async () => ({
    running: (await s.conversations.jobs().running()).map((j) => ({ id: j.id, key: j.key, startedAt: j.startedAt })),
  }));
  app.post("/api/updates/apply", async (_req, reply) => {
    try {
      return await s.updater.apply();
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });
}
