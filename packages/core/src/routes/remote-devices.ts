/**
 * Paired devices and the internet link (Settings → Phone; moved out of server.ts unchanged, board t49): each device's
 * own key, trading the shared token for one, links for another device or an AI connector (a few an hour, each one
 * announced), removing a device and the "only paired devices" rule (on this computer only), and the access log.
 */
import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import type { AccessLog } from "../access-log.js";
import type { DeviceKeys } from "../device-keys.js";
import { isLocalRequest } from "../auth.js";
import type { KesherServices } from "../services.js";

/**
 * Routes for paired devices.
 *
 * @param app - Fastify instance.
 * @param s - Services.
 * @param deviceKeys - The devices' keys.
 * @param accessLog - Who came in from outside.
 */
export async function remoteDeviceRoutes(app: FastifyInstance, s: KesherServices, deviceKeys: DeviceKeys, accessLog: AccessLog): Promise<void> {
  app.get("/api/remote/devices", async () => ({ devices: deviceKeys.devices(), devicesOnly: s.config.remote.anywhereDevicesOnly, idleDays: s.config.remote.anywhereIdleDays }));
  /**
   * A device that came in with the shared token (found through Google, or the QR code) trades it for a
   * key of its own, so it keeps working when "only paired devices" is on, and can be removed alone.
   */
  app.post<{ Body: { device?: string } }>("/api/remote/devices/exchange", async (req, reply) => {
    const given = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    const token = s.config.remote.token ?? "";
    if (isLocalRequest(req) || !token || given.length !== token.length || !timingSafeEqual(Buffer.from(given), Buffer.from(token))) {
      return reply.code(400).send({ error: "Only a device that uses the shared token can trade it for its own key." });
    }
    return { token: await deviceKeys.issue(String(req.body?.device ?? "Device")) };
  });
  /**
   * A link for another device of the user's (a laptop's KesherAI, a browser): a key of its own, through
   * the internet link. Any signed-in device may ask (the user is often away from the computer), and every
   * new key is announced on the computer and the phone, and can be removed alone.
   */
  const invites: number[] = [];
  app.post<{ Body: { device?: string } }>("/api/remote/devices/invite", async (req, reply) => {
    // A few an hour: a stolen key cannot make many more keys for itself.
    const hourAgo = Date.now() - 3_600_000;
    while (invites.length && invites[0]! < hourAgo) invites.shift();
    if (invites.length >= 5) return reply.code(429).send({ error: "Five links were made in the last hour. Try again later." });
    const url = s.tunnel.status().url;
    if (!url) return reply.code(409).send({ error: "Turn on access from anywhere first (Settings → Phone)." });
    const name = String(req.body?.device ?? "Device").replace(/[^\p{L}\p{N} ._()-]/gu, "").slice(0, 40) || "Device";
    invites.push(Date.now());
    const key = await deviceKeys.issue(name);
    void s.notifier.send({ title: "A new device key was made", body: `"${name}" can now connect to KesherAI through the internet link${isLocalRequest(req) ? "" : " (made from a connected device)"}. If it was not you, remove it in Settings → Phone.`, path: "#/settings/phone", tags: ["key"], priority: 4 }).catch(() => undefined);
    return { link: `${url.replace(/\/$/, "")}/?token=${encodeURIComponent(key)}`, name };
  });
  /**
   * A link for an AI app such as Claude (a custom connector, added from the phone or the web): KesherAI's MCP
   * server through the internet link, with a key that opens only /mcp. Like device links, any signed-in device
   * may ask (a few an hour), and each new key is announced and can be removed alone in Settings → Phone.
   */
  app.post<{ Body: { name?: string } }>("/api/remote/devices/connector", async (req, reply) => {
    const hourAgo = Date.now() - 3_600_000;
    while (invites.length && invites[0]! < hourAgo) invites.shift();
    if (invites.length >= 5) return reply.code(429).send({ error: "Five links were made in the last hour. Try again later." });
    if (!s.config.mcpServer.enabled) return reply.code(409).send({ error: "KesherAI's MCP server is off (Settings → For developers, on the computer)." });
    const url = s.tunnel.status().url;
    if (!url) return reply.code(409).send({ error: "Turn on access from anywhere first (Settings → Phone, on the computer)." });
    const name = `${String(req.body?.name ?? "Claude").replace(/[^\p{L}\p{N} ._()-]/gu, "").slice(0, 30) || "Claude"} (connector)`;
    invites.push(Date.now());
    const key = await deviceKeys.issue(name, "mcp");
    void s.notifier.send({ title: "A connector key was made", body: `"${name}" can now give KesherAI tasks through the internet link (its key opens only the MCP server)${isLocalRequest(req) ? "" : ", made from a connected device"}. If it was not you, remove it in Settings → Phone.`, path: "#/settings/phone", tags: ["key"], priority: 4 }).catch(() => undefined);
    return { url: `${url.replace(/\/$/, "")}/mcp?token=${encodeURIComponent(key)}`, name };
  });
  app.delete<{ Params: { id: string } }>("/api/remote/devices/:id", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Devices are removed on the computer that runs KesherAI." });
    return { ok: await deviceKeys.remove(req.params.id) };
  });
  app.put<{ Body: { devicesOnly?: boolean; idleDays?: number } }>("/api/remote/devices", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "This is set on the computer that runs KesherAI." });
    if (typeof req.body?.devicesOnly === "boolean") s.config.remote.anywhereDevicesOnly = req.body.devicesOnly;
    if (typeof req.body?.idleDays === "number") s.config.remote.anywhereIdleDays = Math.max(0, Math.min(365, Math.round(req.body.idleDays)));
    await s.saveConfig();
    return { devices: deviceKeys.devices(), devicesOnly: s.config.remote.anywhereDevicesOnly, idleDays: s.config.remote.anywhereIdleDays };
  });
  app.get("/api/access-log", async () => accessLog.list());
  app.delete("/api/access-log", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "The log is cleared on the computer that runs KesherAI." });
    await accessLog.clear();
    return { ok: true };
  });
}
