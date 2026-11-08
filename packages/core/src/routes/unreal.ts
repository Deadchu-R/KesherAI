import type { FastifyInstance } from "fastify";
import "@fastify/websocket";
import { join } from "node:path";
import type WebSocket from "ws";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";
import { modelTurnFor } from "../conversations.js";
import { BRIDGE_VERSION, blueprintPrompt, parseOps, unityPrompt } from "../unreal-bridge.js";
import { BridgeInstaller, enableUnrealMcp, findEngines, installUnityPackage } from "../unreal-install.js";
import { MCP_PRESETS } from "../mcp.js";

/** Where the plugin is downloaded from (published by .github/workflows/unreal-plugin.yml). */
export const BRIDGE_DOWNLOAD = "https://github.com/Deadchu-R/KesherAI/releases/download/unreal-plugin-latest/KesherAIBridge.zip";

/** Where the Unity package comes from in Unity's Package Manager (Add package from git URL). */
export const UNITY_PACKAGE_URL = "https://github.com/Deadchu-R/KesherAI.git?path=/integrations/unity/com.kesherai.bridge";

/**
 * The Unreal page.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function unrealRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  await editorRoutes(app, s, "unreal");
}

/**
 * The Unity page (Visual Scripting).
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function unityRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  await editorRoutes(app, s, "unity");
}

/**
 * An editor page (Unreal or Unity): the editor's connection (the KesherAI
 * Bridge plugin or package), its graphs, and changing them in words.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 * @param kind - Which editor.
 */
async function editorRoutes(app: FastifyInstance, s: KesherServices, kind: "unreal" | "unity"): Promise<void> {
  const b = kind === "unreal" ? s.unreal : s.unity;
  const unreal = s.unreal;
  const base = `/api/${kind}`;
  const name = kind === "unreal" ? "The Unreal Editor" : "The Unity Editor";

  /** The Unreal editor connects here; only from this computer. (Unity goes through its CLI.) */
  if (kind === "unreal") app.get(`${base}/ws`, {
    websocket: true,
    preHandler: async (req, reply) => {
      if (!isLocalRequest(req)) return reply.code(403).send({ error: `${name} connects from this computer only.` });
    },
  }, (socket) => unreal.attach(socket as unknown as WebSocket));

  app.get(base, async () => ({ ...(await b.status()), latestBridge: kind === "unreal" ? BRIDGE_VERSION : "0.2.0", download: kind === "unreal" ? BRIDGE_DOWNLOAD : UNITY_PACKAGE_URL }));

  app.get(`${base}/blueprints`, async () => b.list());

  app.get<{ Querystring: { path?: string } }>(`${base}/graph`, async (req, reply) => {
    if (!req.query.path) return reply.code(400).send({ error: "Which Blueprint?" });
    try {
      return await b.graph(req.query.path);
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });

  /**
   * Changes a graph as the user asks, with the active chat model. With the
   * editor connected the change is made at once (one undo step) and the
   * Blueprint compiled; with it closed, the change waits in the queue.
   */
  app.post<{ Body: { path?: string; graph?: string; request?: string } }>(`${base}/edit`, async (req, reply) => {
    const path = String(req.body?.path ?? "");
    const request = String(req.body?.request ?? "").trim().slice(0, 2000);
    if (!path || !request) return reply.code(400).send({ error: "Choose a Blueprint and say what to change." });
    const chat = s.config.activeModels.chat;
    if (!chat) return reply.code(400).send({ error: "Choose a chat model first; it makes the change." });
    try {
      const { graph: bp } = await b.graph(path);
      const graphName = req.body?.graph || bp.graphs[0]?.name || "EventGraph";
      const turn = modelTurnFor(s.registry, chat);
      const text = (await turn({ messages: kind === "unreal" ? blueprintPrompt(bp, graphName, request) : unityPrompt(bp, request), tools: [] }, AbortSignal.timeout(300_000), () => undefined)).text;
      const { ops, note } = parseOps(text);
      if (!ops.length) return { ops, note: note || "Nothing to change.", applied: false };
      if (kind === "unreal" && !b.connected) {
        const project = (await b.project()) ?? "Project";
        const queued = await b.enqueue({ project, path, graph: graphName, ops, request });
        return { ops, note, applied: false, queued: queued.id };
      }
      const result = await b.request<{ results: Array<{ ok: boolean; error?: string }>; failed: number }>("apply", { path, graph: graphName, ops: kind === "unity" ? JSON.stringify(ops) : ops }, kind === "unity" ? 120_000 : 30_000);
      const compile = await b.request<{ ok: boolean; messages: Array<{ severity: string; text: string }> }>("compile", { path }).catch(() => undefined);
      return { ops, note, applied: true, result, compile };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /** Applies operations as given (for "Apply again" and plugins). */
  app.post<{ Body: { path?: string; graph?: string; ops?: unknown[] } }>(`${base}/apply`, async (req, reply) => {
    const { path, graph = "", ops } = req.body ?? {};
    if (!path || !Array.isArray(ops)) return reply.code(400).send({ error: "Send the Blueprint and the operations." });
    try {
      return await b.request("apply", { path, graph, ops: kind === "unity" ? JSON.stringify(ops) : ops });
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  for (const cmd of ["compile", "save", "open"] as const) {
    app.post<{ Body: { path?: string } }>(`${base}/${cmd}`, async (req, reply) => {
      if (!req.body?.path) return reply.code(400).send({ error: "Which Blueprint?" });
      try {
        return await b.request(cmd, { path: req.body.path }, cmd === "compile" ? 120_000 : 30_000);
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
    });
  }

  app.get(`${base}/queue`, async () => b.queue());
  app.delete<{ Params: { id: string } }>(`${base}/queue/:id`, async (req) => ({ removed: await b.unqueue(req.params.id) }));

  if (kind === "unity") {
    const unity = s.unity;
    /**
     * Prepares a Unity project (Unity 6+): copies the KesherAI Bridge package into
     * Packages/ and adds Unity's Pipeline package with its CLI. Only on this computer.
     */
    app.post<{ Body: { project?: string } }>(`${base}/install`, async (req, reply) => {
      if (!isLocalRequest(req)) return reply.code(403).send({ error: "Add the package on the computer that runs KesherAI." });
      if (!req.body?.project) return reply.code(400).send({ error: "Choose the project folder." });
      try {
        return { message: await unity.install(req.body.project, installUnityPackage) };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });
    /** Unity's CLI with no project needed: its version, the editors installed, and a project being made. */
    app.get(`${base}/cli`, async () => unity.cliInfo());
    /** Makes a new project with Unity's CLI (in the background). Only on this computer. */
    app.post<{ Body: { name?: string; parent?: string; editor?: string; template?: string; open?: boolean } }>(`${base}/create`, async (req, reply) => {
      if (!isLocalRequest(req)) return reply.code(403).send({ error: "Make the project on the computer that runs KesherAI." });
      try {
        unity.createProject({ name: String(req.body?.name ?? ""), parent: String(req.body?.parent ?? ""), ...(req.body?.editor ? { editor: String(req.body.editor) } : {}), ...(req.body?.template ? { template: String(req.body.template) } : {}), open: req.body?.open === true }, installUnityPackage);
        return unity.cliInfo();
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });
    /** Updates Unity's CLI (`unity self-update`). Only on this computer. */
    app.post(`${base}/cli/update`, async (req, reply) => {
      if (!isLocalRequest(req)) return reply.code(403).send({ error: "Update Unity's CLI on the computer that runs KesherAI." });
      try {
        return { message: await unity.selfUpdate() };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });
    /** Opens the shown project in the Unity editor. Only on this computer. */
    app.post(`${base}/open-editor`, async (req, reply) => {
      if (!isLocalRequest(req)) return reply.code(403).send({ error: "Open Unity on the computer that runs KesherAI." });
      try {
        await unity.openProject();
        return { ok: true };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });
    /** Adds a project folder, or picks which one the page shows. Only on this computer. */
    app.put<{ Body: { project?: string } }>(`${base}/project`, async (req, reply) => {
      if (!isLocalRequest(req)) return reply.code(403).send({ error: "Choose the project on the computer that runs KesherAI." });
      try {
        await unity.addProject(String(req.body?.project ?? ""));
        return unity.status();
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });
    return;
  }

  const installer = new BridgeInstaller(join(s.paths.root, "unreal", "_built"));

  /**
   * Unreal 5.8+: turns on the engine's own MCP server in a project and connects KesherAI's chats to it
   * (the "Unreal Engine" MCP server, 127.0.0.1:8000). Only on this computer.
   */
  app.post<{ Body: { project?: string } }>("/api/unreal/mcp-setup", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Set up the project on the computer that runs KesherAI." });
    if (!req.body?.project) return reply.code(400).send({ error: "Choose the project folder." });
    try {
      const message = await enableUnrealMcp(req.body.project);
      await s.mcp.load();
      const preset = MCP_PRESETS.find((p) => p.id === "unreal")!;
      const have = s.mcp.list().find((m) => m.preset === "unreal");
      if (!have) await s.mcp.upsert({ id: "unreal", name: preset.name, transport: "http", url: preset.url!, headers: {}, enabled: true, preset: "unreal" });
      else if (!have.enabled) await s.mcp.upsert({ ...have, enabled: true });
      return { message };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** Engines on this computer and the current install (for "Install into a project"). */
  app.get("/api/unreal/engines", async () => ({ engines: await findEngines(), job: installer.status() ?? null, windows: process.platform === "win32" }));

  /**
   * Installs the plugin into a project folder (works for Blueprint-only
   * projects): builds it once per engine version, then copies it in. Only on
   * this computer.
   */
  app.post<{ Body: { project?: string } }>("/api/unreal/install", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Install the plugin on the computer that runs KesherAI." });
    if (!req.body?.project) return reply.code(400).send({ error: "Choose the project folder." });
    try {
      await installer.install(req.body.project);
      return { job: installer.status() };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

}
