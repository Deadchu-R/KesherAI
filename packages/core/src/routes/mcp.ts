import type { FastifyInstance } from "fastify";
import { branding } from "@kesher/shared";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";
import { MCP_PRESETS, type McpServerConfig } from "../mcp.js";
import { findMcpServers, importMcpServer, type FoundMcpServer } from "../mcp-import.js";

function page(title: string, text: string): string {
  const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title>
<body style="font-family:system-ui;background:#121213;color:#ededee;display:grid;place-items:center;min-height:100vh;margin:0">
<main style="max-width:420px;text-align:center"><h1 style="font-size:22px">${esc(title)}</h1><p style="color:#94949c">${esc(text)}</p></main>`;
}

/**
 * MCP servers: list, add (by hand, from the catalog, or by pasting a Claude
 * Desktop config), sign in, reconnect, remove. Adding or changing a server
 * starts programs on this computer, so only this computer may do it.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function mcpRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const localOnly = "Change MCP servers from the computer that runs KesherAI.";

  app.get("/api/mcp", async () => {
    await s.mcp.load();
    return { servers: s.mcp.list(), presets: MCP_PRESETS };
  });

  app.put<{ Body: McpServerConfig }>("/api/mcp/servers", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: localOnly });
    try {
      return await s.mcp.upsert(req.body);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post<{ Body: { json: string } }>("/api/mcp/import", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: localOnly });
    try {
      return { added: await s.mcp.importConfig(req.body?.json ?? "") };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // MCP servers other apps already set up (Claude Desktop, Cursor, VS Code, Windsurf, Gemini CLI, Jan): listed with their
  // command (never the values of their keys), and added turned off. Their config files are only read.
  app.get("/api/mcp/found", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: localOnly });
    await s.mcp.load();
    const mine = s.mcp.list();
    const same = (f: FoundMcpServer) => mine.some((m) => (f.url ? m.url === f.url : m.command === f.command && JSON.stringify(m.args ?? []) === JSON.stringify(f.args ?? [])));
    return { found: (await findMcpServers()).map((f) => ({ ...f, file: undefined, have: same(f) })) };
  });

  app.post<{ Body: { items?: Array<{ app?: string; name?: string; withSecrets?: boolean }> } }>("/api/mcp/found/import", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: localOnly });
    await s.mcp.load();
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 50) : [];
    const added: string[] = [];
    for (const it of items) {
      const taken = new Set(s.mcp.list().map((m) => m.id));
      const config = await importMcpServer(String(it.app ?? ""), String(it.name ?? ""), it.withSecrets === true, taken);
      if (!config) continue;
      await s.mcp.upsert(config);
      added.push(config.name);
    }
    return { added };
  });

  app.delete<{ Params: { id: string } }>("/api/mcp/servers/:id", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: localOnly });
    await s.mcp.remove(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/mcp/servers/:id/reconnect", async (req, reply) => {
    try {
      await s.mcp.connect(req.params.id);
    } catch {
      /* the status says why */
    }
    return reply.send(s.mcp.statusOf(req.params.id));
  });

  // MCP Apps: a tool's own view (a `ui://` resource on that server), shown in the chat in a sandboxed frame.
  app.get<{ Params: { id: string }; Querystring: { uri?: string } }>("/api/mcp/servers/:id/ui", async (req, reply) => {
    const uri = String(req.query.uri ?? "");
    if (!/^ui:\/\/[^\s]{1,500}$/.test(uri)) return reply.code(400).send({ error: "Not a ui:// view." });
    try {
      const r = await s.mcp.readResource(req.params.id, uri);
      if (!r) return reply.code(404).send({ error: "The server has no such view." });
      if (r.text.length > 8 * 1024 * 1024) return reply.code(413).send({ error: "The view is larger than 8 MB." });
      const ui = (r.meta as { ui?: { csp?: Record<string, unknown>; prefersBorder?: boolean } } | undefined)?.ui;
      const list = (k: string) => (Array.isArray(ui?.csp?.[k]) ? (ui!.csp![k] as unknown[]).filter((d): d is string => typeof d === "string" && /^https:\/\/[\w.*:-]+$/.test(d)).slice(0, 20) : []);
      return { html: r.text, csp: { connect: list("connectDomains"), resource: list("resourceDomains") }, prefersBorder: ui?.prefersBorder !== false };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });
  // A call from a tool's own view: only that server's tools; one that changes things needs the person's yes in the
  // chat (the page asks and sends `confirmed`).
  app.post<{ Params: { id: string }; Body: { name?: string; arguments?: Record<string, unknown>; confirmed?: boolean } }>("/api/mcp/servers/:id/app-call", async (req, reply) => {
    const name = String(req.body?.name ?? "");
    const tool = s.mcp.toolOf(req.params.id, name);
    if (!tool) return reply.code(404).send({ error: "This app's server has no such tool." });
    const readOnly = !!tool.annotations?.readOnlyHint && !tool.annotations.destructiveHint;
    if (!readOnly && req.body?.confirmed !== true) return reply.code(409).send({ error: "needs-confirm", title: tool.annotations?.title ?? tool.name });
    try {
      return await s.mcp.call(req.params.id, name, (req.body?.arguments ?? {}) as Record<string, unknown>);
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  /** Returns the service's consent page to open in the browser. */
  app.post<{ Params: { id: string } }>("/api/mcp/servers/:id/sign-in", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Sign in from the computer that runs KesherAI." });
    try {
      return { url: await s.mcp.signInUrl(req.params.id, `http://127.0.0.1:${s.config.port}/api/mcp/callback`) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/mcp/servers/:id/sign-out", async (req) => {
    await s.mcp.signOut(req.params.id);
    return { ok: true };
  });

  /** Node.js and uv for program servers: installed by KesherAI into its own folder. */
  app.get("/api/runtimes", async () => s.runtimes.status());
  app.post<{ Params: { tool: string } }>("/api/runtimes/:tool/install", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: localOnly });
    const tool = req.params.tool;
    if (tool !== "node" && tool !== "uv") return reply.code(400).send({ error: "node or uv" });
    // Runs in the background (see the downloads circle); servers that failed reconnect when it is done.
    void s.runtimes.install(tool).then(() => s.mcp.retryFailed(), () => undefined);
    return reply.code(202).send({ ok: true });
  });

  /** Where the service sends the browser back after consent. */
  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>("/api/mcp/callback", async (req, reply) => {
    reply.type("text/html; charset=utf-8");
    if (req.query.error || !req.query.code || !req.query.state) {
      return page("Not connected", req.query.error === "access_denied" ? "You cancelled. You can try again from KesherAI." : (req.query.error_description ?? "Something went wrong. Try again from KesherAI."));
    }
    try {
      const name = await s.mcp.finishSignIn(req.query.state, req.query.code);
      return page(`${branding.productName} is connected to ${name}`, "Its tools are now available in your chats. You can close this window.");
    } catch (err) {
      return page("Not connected", (err as Error).message);
    }
  });
}
