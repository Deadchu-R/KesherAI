/**
 * Reaching this computer from elsewhere, and what it tells the user (docs/ARCHITECTURE_REVIEW.md B5, first part): the
 * "Access from anywhere" link (Tailscale or a Cloudflare tunnel) and the full-drive warning. Auth, device keys and
 * the notifier still start in server.ts (they need the chats, made later).
 */
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { features } from "@kesher/shared";
import { AccessLog } from "../access-log.js";
import type { ApiKeys } from "../api-keys.js";
import { registerRemoteAuth } from "../auth.js";
import { DeviceKeys, type DeviceKey } from "../device-keys.js";
import { freeSpace, type DownloadManager } from "@kesher/downloads";
import type { DataPaths, KesherConfig } from "../config.js";
import type { Notifier } from "../notify.js";
import { Tailscale } from "../tailscale.js";
import { Tunnel } from "../tunnel.js";

/**
 * The "Access from anywhere" link: Tailscale when it runs, else a Cloudflare tunnel (quick or the user's named one).
 *
 * @param paths - The data folders (cloudflared is downloaded under engines).
 * @param downloads - For cloudflared's download.
 * @param config - The remote settings.
 * @param persist - Saves the settings (a named tunnel is remembered).
 * @returns The Tailscale CLI and the tunnel.
 */
export function buildTunnel(paths: DataPaths, downloads: DownloadManager, config: KesherConfig, persist: () => Promise<void>): { tailscaleCli: Tailscale; tunnel: Tunnel } {
  const tailscaleCli = new Tailscale();
  const tunnel = new Tunnel(join(paths.engines, "cloudflared"), downloads, {
    mode: () => config.remote.anywhereMode,
    named: () => config.remote.cloudflare,
    saveNamed: async (n) => {
      config.remote.cloudflare = n;
      await persist();
    },
    tailscale: tailscaleCli,
    // Funnel passes requests to 127.0.0.1; they still need a key: they name another host and carry forwarding headers.
    tailscaleTarget: async () => ((await tailscaleCli.status(config.port).catch(() => undefined))?.running ? "127.0.0.1" : undefined),
  });
  return { tailscaleCli, tunnel };
}

/**
 * A nearly full drive (found on the PC: 27 MB left) breaks downloads, self-work and Windows itself: say so, once a
 * day, checked a minute after start and every half hour.
 *
 * @param paths - Where the models are (the drive that fills up).
 * @param notifier - Sends the warning.
 */
export function watchDisk(paths: DataPaths, notifier: Notifier): void {
  let diskWarned = 0;
  const checkDisk = async () => {
    const free = await freeSpace(paths.models).catch(() => undefined);
    if (free === undefined || free >= 5 * 1024 ** 3 || Date.now() - diskWarned < 24 * 3_600_000) return;
    diskWarned = Date.now();
    await notifier.send({ title: "The drive is almost full", body: `Only ${(free / 1024 ** 3).toFixed(1)} GB is free where KesherAI keeps its models. Downloads and self-work will fail; Windows may slow down. Remove models you do not use (Models page) or other large files.`, path: "#/models", tags: ["warning"] }).catch(() => undefined);
  };
  setTimeout(() => void checkDisk(), 60_000).unref();
  setInterval(() => void checkDisk(), 30 * 60_000).unref();
}

/**
 * Who may come in from elsewhere: the remote token, each paired device's own key, and an API key for the model API;
 * every refused or outside request goes to the access log (Settings → Phone), which warns about a stranger. Called
 * where it always was in createKesherServer (the auth hook's place among the routes is the same).
 *
 * @param app - The server.
 * @param p - The paths, settings and their saving, the notifier (for the access log's warnings) and the API keys.
 * @returns The access log and the device keys (the routes for paired devices use both).
 */
export function setupRemoteAccess(app: FastifyInstance, p: { paths: DataPaths; config: KesherConfig; persist: () => Promise<void>; notifier: Notifier; apiKeys: ApiKeys }): { accessLog: AccessLog; deviceKeys: DeviceKeys } {
  const { paths, config, persist, notifier, apiKeys } = p;
  const accessLog = new AccessLog(join(paths.root, "access-log.json"), (title, body) => void notifier.send({ title, body, path: "#/settings/phone", tags: ["rotating_light"], priority: 4 }).catch(() => undefined));
  const deviceKeys = new DeviceKeys(() => config.remote.devices, persist);
  if (features.remote) {
    registerRemoteAuth(app, () => config.remote.token, { verify: (k) => apiKeys.verify(k), requireLocally: () => config.apiAuth.requireKeyLocally }, (r) => accessLog.note(r), {
      find: (k) => deviceKeys.find(k),
      seen: (d, a) => deviceKeys.seen(d as DeviceKey, a),
      devicesOnly: () => config.remote.anywhereDevicesOnly,
      idleDays: () => config.remote.anywhereIdleDays,
    });
  }
  return { accessLog, deviceKeys };
}
