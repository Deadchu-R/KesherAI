import type { FastifyInstance } from "fastify";
import { BUILT_IN_CATEGORIES, branding, features } from "@kesher/shared";
import { detectHardware } from "@kesher/downloads";
import { resolve, sep } from "node:path";
import { hostname, networkInterfaces } from "node:os";
import type { KesherServices } from "../services.js";
import { Tailscale } from "../tailscale.js";
import { isLocalRequest } from "../auth.js";

/** Version of the core server API. */
export const CORE_VERSION = "0.4.0";

/** HTTPS through Tailscale, for remote access. */
const tailscale = new Tailscale();

/**
 * Health, app info, categories, hardware, skills, plugins and plugin tools.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function systemRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  app.get("/api/health", async () => ({
    ok: true,
    version: CORE_VERSION,
    build: await s.updater.version(),
    productName: branding.productName,
    features,
    remote: { enabled: s.config.remote.enabled },
  }));

  /**
   * Restarts KesherAI on this computer (also from the phone), installing a
   * downloaded update first. The interface then waits for it and reconnects.
   */
  /** The Approve / Deny buttons on a phone or watch notification (no token: the one-time code is the key). */
  app.post<{ Params: { code: string }; Querystring: { d?: string } }>("/api/quick-approve/:code", async (req, reply) => {
    const d = req.query.d === "allow" ? "allow" : req.query.d === "deny" ? "deny" : undefined;
    if (!d) return reply.code(400).send({ error: "d must be allow or deny" });
    if (!(await s.notifier.quickDecide(req.params.code, d))) return reply.code(410).send({ error: "This button no longer works: the request was answered or is too old." });
    return { ok: true };
  });

  app.post("/api/system/restart", async (_req, reply) => {
    if (!s.restartApp) return reply.code(409).send({ error: "This copy runs from the command line: restart it there." });
    s.restarting = true;
    setTimeout(() => s.restartApp?.(), 500);
    return { ok: true };
  });

  app.get("/api/categories", async () => [...BUILT_IN_CATEGORIES, ...s.plugins.categories]);

  app.get("/api/hardware", async () => detectHardware());

  app.get("/api/plugins", async () =>
    s.plugins.list().map((p) => ({ ...p.manifest, status: p.status, error: p.error, dir: p.dir, removable: resolve(p.dir).startsWith(resolve(s.paths.plugins) + sep) })),
  );

  app.get("/api/tools", async () =>
    [...s.plugins.tools.values()].map(({ name, description, inputSchema, pluginId }) => ({ name, description, inputSchema, pluginId })),
  );

  app.post<{ Params: { name: string }; Body: Record<string, unknown> }>("/api/tools/:name", async (req, reply) => {
    const tool = s.plugins.tools.get(req.params.name);
    if (!tool) return reply.code(404).send({ error: `No tool "${req.params.name}"` });
    try {
      return { result: await tool.run(req.body ?? {}, AbortSignal.timeout(120_000)) };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  if (features.remote) {
    /** Only callable from this computer: shows the token to pair a phone. */
    app.get("/api/remote", async (req, reply) => {
      if (!isLocalRequest(req)) {
        return reply.code(403).send({ error: "Only available on this computer" });
      }
      // Addresses other devices can use: the home network, and Tailscale (100.64.0.0/10) if installed.
      // Each carries the card's MAC and broadcast address, so the phone can wake this computer (Wake-on-LAN).
      const addresses = Object.values(networkInterfaces())
        .flat()
        .filter((a): a is NonNullable<typeof a> => !!a && a.family === "IPv4" && !a.internal)
        .map((a) => ({
          address: a.address,
          tailscale: /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address),
          mac: a.mac,
          broadcast: broadcastOf(a.address, a.netmask),
        }));
      return {
        enabled: s.config.remote.enabled,
        keepAwake: s.config.remote.keepAwake,
        anywhere: s.config.remote.anywhere,
        tunnel: s.tunnel.status(),
        token: s.config.remote.token,
        port: s.config.port,
        addresses,
      };
    });

    /**
     * For the phone app (needs the token like every remote request): this
     * computer's name and every address it can be reached at right now, so a
     * saved computer keeps working when the network or the tunnel address
     * changes. The token itself is not included.
     */
    app.get("/api/remote/links", async () => {
      const lan = Object.values(networkInterfaces())
        .flat()
        .filter((a): a is NonNullable<typeof a> => !!a && a.family === "IPv4" && !a.internal)
        .map((a) => ({ url: `http://${a.address}:${s.config.port}`, kind: /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address) ? "tailscale" : "home", mac: a.mac, broadcast: broadcastOf(a.address, a.netmask) }));
      const tunnel = s.tunnel.status().url;
      const https = await tailscale.status(s.config.port).catch(() => undefined);
      return { name: hostname(), links: [...(https?.on && https.url ? [{ url: https.url, kind: "https" }] : []), ...lan, ...(tunnel ? [{ url: tunnel, kind: "anywhere" }] : [])] };
    });

    /** HTTPS through Tailscale (a real certificate for this computer's tailnet name). */
    app.get("/api/remote/https", async (req, reply) => {
      if (!isLocalRequest(req)) return reply.code(403).send({ error: "Only available on this computer" });
      return tailscale.status(s.config.port);
    });
    app.post<{ Body: { on?: boolean } }>("/api/remote/https", async (req, reply) => {
      if (!isLocalRequest(req)) return reply.code(403).send({ error: "Only available on this computer" });
      if (req.body?.on === false) return tailscale.disable(s.config.port);
      if (!s.config.remote.enabled) return reply.code(409).send({ error: "Turn on remote access first (above)." });
      const ts = Object.values(networkInterfaces())
        .flat()
        .find((a) => !!a && a.family === "IPv4" && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address));
      if (!ts) return reply.code(409).send({ error: "This computer has no Tailscale address. Is Tailscale connected?" });
      return tailscale.enable(s.config.port, ts.address);
    });

    /**
     * "Access from anywhere": turns the Cloudflare tunnel on or off and
     * remembers the choice. Only from this computer. Body: `{ on: boolean }`.
     * Turning it on downloads cloudflared the first time (about 60 MB).
     */
    /**
     * Which internet link: quick (no account, a new address each start), the user's own Cloudflare (a fixed
     * address in their domain) or Tailscale Funnel (a fixed ts.net address). Only from this computer.
     */
    app.put<{ Body: { mode?: string } }>("/api/remote/anywhere-mode", async (req, reply) => {
      if (!isLocalRequest(req)) return reply.code(403).send({ error: "Only available on this computer" });
      const mode = req.body?.mode;
      if (mode !== "quick" && mode !== "cloudflare" && mode !== "tailscale") return reply.code(400).send({ error: "mode is quick, cloudflare or tailscale" });
      const was = s.config.remote.anywhereMode;
      s.config.remote.anywhereMode = mode;
      await s.saveConfig();
      if (s.config.remote.anywhere && was !== mode) {
        s.tunnel.stop();
        try {
          await s.tunnel.start(s.config.port);
        } catch (err) {
          return reply.code(502).send({ ...s.tunnel.status(), error: (err as Error).message });
        }
      }
      return s.tunnel.status();
    });
    /** Your own Cloudflare, step 1: Cloudflare's sign-in page (open it on any device; pick the domain there). */
    app.post("/api/remote/cloudflare/login", async (req, reply) => {
      if (!isLocalRequest(req)) return reply.code(403).send({ error: "Only available on this computer" });
      try {
        return await s.tunnel.cloudflareLogin();
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
    });
    /** Your own Cloudflare, step 2: a tunnel for KesherAI and the address pointed at it. Body: `{ hostname }`. */
    app.post<{ Body: { hostname?: string } }>("/api/remote/cloudflare/setup", async (req, reply) => {
      if (!isLocalRequest(req)) return reply.code(403).send({ error: "Only available on this computer" });
      try {
        await s.tunnel.cloudflareSetup(String(req.body?.hostname ?? "").trim());
        return s.tunnel.status();
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });
    app.post<{ Body: { on?: boolean } }>("/api/remote/anywhere", async (req, reply) => {
      if (!isLocalRequest(req)) return reply.code(403).send({ error: "Only available on this computer" });
      const on = req.body?.on === true;
      s.config.remote.anywhere = on;
      await s.saveConfig();
      if (!on) {
        s.tunnel.stop();
        return s.tunnel.status();
      }
      try {
        await s.tunnel.start(s.config.port);
      } catch (err) {
        return reply.code(502).send({ ...s.tunnel.status(), error: (err as Error).message });
      }
      return s.tunnel.status();
    });
  }
}

/**
 * The broadcast address of a network, where Wake-on-LAN packets are sent.
 *
 * @param address - IPv4 address, e.g. `192.168.1.20`.
 * @param netmask - e.g. `255.255.255.0`.
 * @returns e.g. `192.168.1.255`.
 */
export function broadcastOf(address: string, netmask: string): string {
  const a = address.split(".").map(Number);
  const m = netmask.split(".").map(Number);
  return a.map((octet, i) => (octet | (~(m[i] ?? 0) & 255)) & 255).join(".");
}
