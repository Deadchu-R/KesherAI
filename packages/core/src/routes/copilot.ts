import type { FastifyInstance } from "fastify";
import { branding } from "@kesher/shared";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";
import { COPILOT_MODEL } from "../copilot.js";

function page(title: string, text: string): string {
  const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title>
<body style="font-family:system-ui;background:#0e1014;color:#e7e9ee;display:grid;place-items:center;min-height:100vh;margin:0">
<main style="max-width:420px;text-align:center"><h1 style="font-size:22px">${esc(title)}</h1><p style="color:#a3aab7">${esc(text)}</p></main>
<script>setTimeout(function(){window.close()},1500)</script>`;
}

/**
 * Microsoft 365 Copilot (sign-in, status) and business mode (only the
 * allowed connections stay on). Both change only on this computer.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function copilotRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const local = (req: Parameters<typeof isLocalRequest>[0]) => isLocalRequest(req);

  app.get("/api/copilot", async () => ({
    configured: s.copilot.configured,
    connected: s.copilot.connected,
    email: s.config.copilot.email ?? null,
    name: s.config.copilot.name ?? null,
    web: s.config.copilot.web !== false,
    lastError: s.config.copilot.lastError ?? null,
    model: `copilot/${COPILOT_MODEL}`,
  }));

  app.put<{ Body: { web?: boolean; clientId?: string } }>("/api/copilot", async (req, reply) => {
    if (!local(req)) return reply.code(403).send({ error: "Change this on the computer that runs KesherAI." });
    if (typeof req.body?.web === "boolean") s.config.copilot.web = req.body.web;
    const id = req.body?.clientId?.trim();
    if (id !== undefined) {
      if (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return reply.code(400).send({ error: "An application id looks like 0a1b2c3d-…: copy it from the app's Overview page." });
      if (id) s.config.copilot.clientId = id;
      else delete s.config.copilot.clientId;
    }
    await s.saveConfig();
    return { ok: true, configured: s.copilot.configured };
  });

  app.post("/api/copilot/connect", async (req, reply) => {
    if (!local(req)) return reply.code(403).send({ error: "Connect Copilot from the computer that runs KesherAI." });
    try {
      return { url: s.copilot.authUrl(`http://localhost:${s.config.port}/api/copilot/callback`) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>("/api/copilot/callback", async (req, reply) => {
    reply.type("text/html; charset=utf-8");
    if (req.query.error || !req.query.code || !req.query.state) {
      return page("Copilot was not connected", (req.query.error_description ?? "You cancelled. You can try again from Settings.").split("\r\n")[0]!);
    }
    try {
      const email = await s.copilot.finish(req.query.code, req.query.state);
      // In business mode Copilot is the model to use: make it the chat model.
      if (!s.config.activeModels.chat || s.business().enabled) s.config.activeModels.chat = `copilot/${COPILOT_MODEL}`;
      await s.saveConfig();
      s.focusApp?.();
      return page(`${branding.productName} is connected to Microsoft 365 Copilot`, `${email ? `${email}. ` : ""}Choose "Microsoft 365 Copilot" as the chat model. You can go back to ${branding.productName}.`);
    } catch (err) {
      return page("Copilot was not connected", (err as Error).message);
    }
  });

  app.post("/api/copilot/disconnect", async (req, reply) => {
    if (!local(req)) return reply.code(403).send({ error: "Disconnect on the computer that runs KesherAI." });
    await s.copilot.disconnect();
    return { connected: false };
  });

  /** Business mode, and every connection it can allow. */
  app.get("/api/business", async () => {
    const p = s.business();
    return {
      ...p,
      managed: s.businessManaged(),
      providers: s.registry.list().map(({ provider, config }) => ({ id: provider.id, name: config.name ?? provider.name, location: provider.location, on: s.registry.permitted(provider.id) })),
    };
  });

  app.put<{ Body: { enabled?: boolean; allowed?: string[] } }>("/api/business", async (req, reply) => {
    if (!local(req)) return reply.code(403).send({ error: "Business mode changes only on the computer that runs KesherAI." });
    if (s.businessManaged()) return reply.code(423).send({ error: "Business mode is set by your organisation (policy.json) and cannot be changed here." });
    const b = s.config.business;
    if (typeof req.body?.enabled === "boolean") b.enabled = req.body.enabled;
    if (Array.isArray(req.body?.allowed)) b.allowed = [...new Set(req.body.allowed.filter((x) => typeof x === "string" && /^[\w-]+$/.test(x)))];
    s.applyBusiness();
    // The chat model must be one that is still allowed.
    const chat = s.config.activeModels.chat;
    if (b.enabled && chat && !s.registry.permitted(chat.split("/")[0]!)) {
      if (s.registry.permitted("copilot") && s.copilot.connected) s.config.activeModels.chat = `copilot/${COPILOT_MODEL}`;
      else delete s.config.activeModels.chat;
    }
    await s.saveConfig();
    return { ...s.business(), managed: false };
  });
}
