import type { FastifyInstance } from "fastify";
import { branding } from "@kesher/shared";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";

function page(title: string, text: string): string {
  const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title>
<body style="font-family:system-ui;background:#0e1014;color:#e7e9ee;display:grid;place-items:center;min-height:100vh;margin:0">
<main style="max-width:420px;text-align:center"><h1 style="font-size:22px">${esc(title)}</h1><p style="color:#a3aab7">${esc(text)}</p></main>`;
}

/**
 * "Connect Google Drive": sign-in, status, manual sync, disconnect.
 * Sign-in starts only from this computer, because Google redirects back to
 * KesherAI on 127.0.0.1.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function googleRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  app.get("/api/google", async () => ({
    configured: s.google.configured,
    connected: s.google.connected,
    email: s.config.google.email ?? null,
    lastSync: s.config.google.lastSync ?? null,
    lastError: s.config.google.lastError ?? null,
    /** True when the user entered their own OAuth client (rather than the project's). */
    customClient: !!s.config.google.clientId,
    /** Gmail and Calendar, when connected. */
    services: s.config.google.services ?? [],
  }));

  /** Sets (or clears) the user's own OAuth client. */
  app.put<{ Body: { clientId?: string; clientSecret?: string } }>("/api/google/client", async (req) => {
    const id = req.body?.clientId?.trim();
    if (id) {
      s.config.google.clientId = id;
      s.config.google.clientSecret = req.body.clientSecret?.trim() || undefined;
    } else {
      delete s.config.google.clientId;
      delete s.config.google.clientSecret;
    }
    await s.saveConfig();
    return { configured: s.google.configured };
  });

  /** Returns the Google consent URL to open in the browser. */
  app.post<{ Body: { services?: string[] } }>("/api/google/connect", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Connect Google from the computer that runs KesherAI." });
    try {
      const services = (req.body?.services ?? []).filter((x): x is "gmail" | "calendar" => x === "gmail" || x === "calendar");
      return { url: s.google.authUrl(`http://127.0.0.1:${s.config.port}/api/google/callback`, services) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** Where Google sends the browser back after consent. */
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/api/google/callback", async (req, reply) => {
    reply.type("text/html; charset=utf-8");
    if (req.query.error || !req.query.code || !req.query.state) {
      return page("Google Drive was not connected", req.query.error === "access_denied" ? "You cancelled. You can try again from Settings." : "Something went wrong. Try again from Settings.");
    }
    try {
      const email = await s.google.finish(req.query.code, req.query.state);
      void s.driveSync.syncNow().catch(() => undefined);
      const extra = (s.config.google.services ?? []).map((x) => (x === "gmail" ? "Gmail" : "Google Calendar"));
      return page(`${branding.productName} is connected to Google`, `${email ? `${email}. ` : ""}Projects and conversations are saved in the KesherAI folder in your Drive.${extra.length ? ` ${extra.join(" and ")} can now be used in your chats.` : ""} You can close this window.`);
    } catch (err) {
      return page("Google Drive was not connected", (err as Error).message);
    }
  });

  app.post("/api/google/sync", async (_req, reply) => {
    if (!s.google.connected) return reply.code(409).send({ error: "Not connected to Google Drive" });
    try {
      return await s.driveSync.syncNow();
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.post("/api/google/disconnect", async () => {
    await s.google.disconnect();
    return { connected: false };
  });
}
