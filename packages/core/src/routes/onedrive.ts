import type { FastifyInstance } from "fastify";
import { branding } from "@kesher/shared";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";

function page(title: string, text: string): string {
  const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title>
<body style="font-family:system-ui;background:#0e1014;color:#e7e9ee;display:grid;place-items:center;min-height:100vh;margin:0">
<main style="max-width:420px;text-align:center"><h1 style="font-size:22px">${esc(title)}</h1><p style="color:#a3aab7">${esc(text)}</p></main>
<script>setTimeout(function(){window.close()},1500)</script>`;
}

/**
 * "Connect OneDrive": sign-in, status, manual sync, disconnect. Sign-in
 * starts only from this computer, because Microsoft redirects back to
 * KesherAI on localhost.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function onedriveRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  app.get("/api/onedrive", async () => ({
    configured: s.onedrive.configured,
    connected: s.onedrive.connected,
    email: s.config.onedrive.email ?? null,
    name: s.config.onedrive.name ?? null,
    lastSync: s.config.onedrive.lastSync ?? null,
    lastError: s.config.onedrive.lastError ?? null,
    customClient: !!s.config.onedrive.clientId,
  }));

  /** Sets (or clears) the user's own application id. Only from this computer. */
  app.put<{ Body: { clientId?: string } }>("/api/onedrive/client", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Set this on the computer that runs KesherAI." });
    const id = req.body?.clientId?.trim();
    if (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return reply.code(400).send({ error: "An application id looks like 0a1b2c3d-…: copy it from the app's Overview page." });
    }
    if (id) s.config.onedrive.clientId = id;
    else delete s.config.onedrive.clientId;
    await s.saveConfig();
    return { configured: s.onedrive.configured };
  });

  /** Returns the Microsoft consent URL to open in the browser. */
  app.post("/api/onedrive/connect", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Connect OneDrive from the computer that runs KesherAI." });
    try {
      return { url: s.onedrive.authUrl(`http://localhost:${s.config.port}/api/onedrive/callback`) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** Where Microsoft sends the browser back after consent. */
  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>("/api/onedrive/callback", async (req, reply) => {
    reply.type("text/html; charset=utf-8");
    if (req.query.error || !req.query.code || !req.query.state) {
      const cancelled = req.query.error === "access_denied" || req.query.error === "consent_required";
      return page("OneDrive was not connected", cancelled ? "You cancelled. You can try again from Settings." : (req.query.error_description ?? "Something went wrong. Try again from Settings.").split("\r\n")[0]!);
    }
    try {
      const email = await s.onedrive.finish(req.query.code, req.query.state);
      void s.onedriveSync.syncNow().catch(() => undefined);
      s.focusApp?.();
      return page(`${branding.productName} is connected to OneDrive`, `${email ? `${email}. ` : ""}Projects and conversations are saved in OneDrive → Apps → ${branding.productName}. You can go back to ${branding.productName}.`);
    } catch (err) {
      return page("OneDrive was not connected", (err as Error).message);
    }
  });

  app.post("/api/onedrive/sync", async (_req, reply) => {
    if (!s.onedrive.connected) return reply.code(409).send({ error: "Not connected to OneDrive" });
    try {
      return await s.onedriveSync.syncNow();
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.post("/api/onedrive/disconnect", async () => {
    await s.onedrive.disconnect();
    return { connected: false };
  });
}
