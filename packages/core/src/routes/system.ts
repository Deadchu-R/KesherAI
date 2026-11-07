import type { FastifyInstance } from "fastify";
import { BUILT_IN_CATEGORIES, branding, features } from "@kesher/shared";
import { detectHardware } from "@kesher/downloads";
import { discoverSkills, loadSkillBody } from "@kesher/skills";
import { join, resolve, sep } from "node:path";
import { hostname, networkInterfaces } from "node:os";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";

/** Version of the core server API. */
export const CORE_VERSION = "0.4.0";

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

  if (features.skills) {
    const roots = () => [s.paths.skills, join(process.cwd(), ".kesher", "skills"), join(process.cwd(), ".claude", "skills")];
    app.get("/api/skills", async () => discoverSkills(roots()));
    app.get<{ Params: { name: string } }>("/api/skills/:name", async (req, reply) => {
      const skill = (await discoverSkills(roots())).find((sk) => sk.name === req.params.name);
      if (!skill) return reply.code(404).send({ error: "Skill not found" });
      return { ...skill, body: await loadSkillBody(skill) };
    });
  }

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
      return { name: hostname(), links: [...lan, ...(tunnel ? [{ url: tunnel, kind: "anywhere" }] : [])] };
    });

    /**
     * "Access from anywhere": turns the Cloudflare tunnel on or off and
     * remembers the choice. Only from this computer. Body: `{ on: boolean }`.
     * Turning it on downloads cloudflared the first time (about 60 MB).
     */
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
