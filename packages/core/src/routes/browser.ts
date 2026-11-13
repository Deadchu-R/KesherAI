import type { FastifyInstance, FastifyReply } from "fastify";
import "@fastify/websocket";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { zipSync } from "fflate";
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

/**
 * The extension as a zip, for a browser: Chrome, Edge, Brave and Opera take
 * it as it is (unzip and "Load unpacked", or upload it to the free Edge
 * Add-ons store); Firefox needs its own id and a background script instead
 * of a service worker (for addons.mozilla.org, also free).
 *
 * @param folder - The extension's folder.
 * @param target - `chrome` or `firefox`.
 * @returns The zip's bytes.
 */
export async function packExtension(folder: string, target: "chrome" | "firefox"): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const name of await readdir(folder)) {
    if (!/\.(js|json|html|png|css)$/.test(name)) continue;
    files[name] = new Uint8Array(await readFile(join(folder, name)));
  }
  if (target === "firefox") {
    const manifest = JSON.parse(Buffer.from(files["manifest.json"]!).toString("utf8")) as Record<string, unknown>;
    manifest.background = { scripts: ["page.js", "background.js"] };
    manifest.browser_specific_settings = { gecko: { id: "kesherai@deadchu-r.github.io", strict_min_version: "128.0", data_collection_permissions: { required: ["none"] } } };
    files["manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  }
  return zipSync(files, { level: 9 });
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

  /** The extension as a zip: `?for=chrome` (Chrome, Edge, Brave, Opera) or `?for=firefox`. */
  app.get<{ Querystring: { for?: string } }>("/api/browser/package", async (req, reply) => {
    const folder = extensionFolder();
    if (!folder) return reply.code(404).send({ error: "The extension's files are not in this copy of KesherAI." });
    const target = req.query.for === "firefox" ? "firefox" : "chrome";
    const zip = await packExtension(folder, target);
    reply.header("content-disposition", `attachment; filename="KesherAI-extension-${target}.zip"`);
    return reply.type("application/zip").send(Buffer.from(zip));
  });

  /** Sites where the browser tools act without asking ("Always on this site"), and taking one back. */
  app.get("/api/browser/sites", async () => ({ sites: s.config.browserSites ?? [] }));
  app.delete<{ Querystring: { site?: string } }>("/api/browser/sites", async (req) => {
    const site = String(req.query.site ?? "");
    s.config.browserSites = (s.config.browserSites ?? []).filter((x) => x !== site);
    await s.saveConfig();
    return { sites: s.config.browserSites };
  });

  // KesherAI's own browser pane, for the phone: its tabs, a picture of the tab in front, taps and the address bar.
  const pane = async (reply: FastifyReply, run: () => Promise<unknown>) => {
    try {
      return await run();
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  };
  app.get("/api/browser/pane", (_req, reply) => pane(reply, () => s.browser.paneCall("pane-state")));
  app.get("/api/browser/pane/shot", async (_req, reply) => {
    try {
      const jpg = await s.browser.paneCall<Buffer | null>("pane-shot");
      if (!jpg) return reply.code(404).send({ error: "No tab is open." });
      return reply.header("cache-control", "no-store").type("image/jpeg").send(jpg);
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });
  app.post<{ Body: { cmd?: string; x?: number; y?: number; url?: string; what?: string; id?: number } }>("/api/browser/pane", (req, reply) => {
    const b = req.body ?? {};
    const cmd = String(b.cmd ?? "");
    if (!["tap", "go", "nav", "select", "close", "new"].includes(cmd)) return reply.code(400).send({ error: "Unknown command." });
    const args = cmd === "tap" ? { x: Number(b.x), y: Number(b.y) } : cmd === "go" ? { url: String(b.url ?? "").slice(0, 4000) } : cmd === "nav" ? { what: String(b.what ?? "") } : { id: Number(b.id) };
    return pane(reply, async () => ({ ok: true, result: (await s.browser.paneCall(`pane-${cmd}`, args)) ?? null }));
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
