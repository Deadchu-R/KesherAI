import type { FastifyInstance } from "fastify";
import "@fastify/websocket";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";

/** Where the browser extension's files are: next to the installed app, or in the source tree. */
export function extensionFolder(): string | undefined {
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  const here = dirname(fileURLToPath(import.meta.url));
  return [resources && join(resources, "browser-extension"), resolve(here, "../../../../apps/browser-extension")].find((p): p is string => !!p && existsSync(join(p, "manifest.json")));
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * The browser extension: its status and pairing key (on this computer only),
 * and the WebSocket it connects to. Only an extension on this computer can
 * connect (a browser extension's origin, the key), never a web page.
 *
 * @param app - Fastify instance (with @fastify/websocket registered).
 * @param s - Services.
 */
export async function browserRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  app.get("/api/browser", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "Only available on this computer" });
    return { ...s.browser.status(), key: s.config.browserKey, folder: extensionFolder() ?? null };
  });

  app.get<{ Querystring: { key?: string; browser?: string; version?: string } }>("/api/browser/connect", { websocket: true }, (socket, req) => {
    const origin = String(req.headers.origin ?? "");
    const key = String(req.query.key ?? "");
    if (!isLocalRequest(req) || !/^(chrome|moz)-extension:\/\//.test(origin) || !s.config.browserKey || !same(key, s.config.browserKey)) {
      socket.send(JSON.stringify({ type: "error", error: "wrong-key" }));
      socket.close();
      return;
    }
    s.browser.attach(socket, { browser: String(req.query.browser ?? "").slice(0, 40), version: String(req.query.version ?? "").slice(0, 20) });
    socket.send(JSON.stringify({ type: "ready" }));
  });
}
