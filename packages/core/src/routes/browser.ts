import type { FastifyInstance, FastifyReply } from "fastify";
import { mergeControlLog } from "../control-live.js";
import "@fastify/websocket";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { zipSync } from "fflate";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import type { KesherServices } from "../services.js";
import { isLocalRequest } from "../auth.js";
import { browserDebugRoutes } from "./browser-debug.js";

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
    // Firefox has no chrome.debugger (it keeps the page reader); tab groups are Chrome's.
    const drop = (list: unknown) => (Array.isArray(list) ? list.filter((p) => p !== "debugger" && p !== "tabGroups") : list);
    manifest.permissions = drop(manifest.permissions);
    manifest.optional_permissions = drop(manifest.optional_permissions);
    if (Array.isArray(manifest.optional_permissions) && !manifest.optional_permissions.length) delete manifest.optional_permissions;
    manifest.browser_specific_settings = { gecko: { id: "kesherai@deadchu-r.github.io", strict_min_version: "128.0", data_collection_permissions: { required: ["none"] } } };
    files["manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  } else {
    // The Chrome Web Store warns about Firefox's own keys (and background.scripts): only Chrome's here.
    const manifest = JSON.parse(Buffer.from(files["manifest.json"]!).toString("utf8")) as Record<string, unknown>;
    delete manifest.sidebar_action;
    delete manifest.browser_specific_settings;
    manifest.background = { service_worker: "background.js" };
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
  app.get("/api/browser/sites", async () => ({ sites: s.config.browserSites ?? [], helperAlways: s.config.browserHelperAlways === true }));
  app.delete<{ Querystring: { site?: string } }>("/api/browser/sites", async (req) => {
    const site = String(req.query.site ?? "");
    s.config.browserSites = (s.config.browserSites ?? []).filter((x) => x !== site);
    await s.saveConfig();
    return { sites: s.config.browserSites };
  });

  /** What the browser tools did lately (the pane's activity strip, here and on the phone), and the one Stop for them. */
  app.get("/api/browser/activity", async () => s.browser.activity());
  app.post("/api/browser/stop", async () => {
    s.browser.stop();
    return { ok: true };
  });

  /**
   * Safety v2 for browser and computer (Settings → Browser and computer): modes, JavaScript policy, sensitive and
   * blocked sites. Skip needs `skipAllowed` (the owner's yes after a warning); helpers are never on Skip.
   */
  const controlSettings = () => ({
    mode: s.config.controlMode,
    helperMode: s.config.controlHelperMode,
    skipAllowed: s.config.controlSkipAllowed === true,
    js: s.config.controlJs,
    sensitive: s.config.controlSensitive ?? [],
    blocked: s.config.controlBlocked ?? [],
    helperAlways: s.config.browserHelperAlways === true,
  });
  app.get("/api/control/settings", async () => controlSettings());
  app.put<{ Body: { mode?: string; helperMode?: string; skipAllowed?: boolean; js?: string; sensitive?: unknown; blocked?: unknown } }>("/api/control/settings", async (req, reply) => {
    const b = req.body ?? {};
    const sites = (v: unknown) =>
      Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]!).filter((x) => /^[a-z0-9.*:-]{1,253}$/.test(x)))].slice(0, 200) : undefined;
    if (b.mode !== undefined && !["manual", "auto", "skip"].includes(b.mode)) return reply.code(400).send({ error: "mode is manual, auto or skip" });
    if (b.helperMode !== undefined && !["manual", "auto"].includes(b.helperMode)) return reply.code(400).send({ error: "helperMode is manual or auto" });
    if (b.js !== undefined && !["ask", "local", "off"].includes(b.js)) return reply.code(400).send({ error: "js is ask, local or off" });
    if (typeof b.skipAllowed === "boolean") s.config.controlSkipAllowed = b.skipAllowed;
    // Skip only after the owner's yes: asking for it without that yes is refused, not silently kept.
    if (b.mode === "skip" && !s.config.controlSkipAllowed) return reply.code(400).send({ error: "Turn on 'Allow Skip' first (it shows the warning)." });
    if (b.mode) s.config.controlMode = b.mode as "manual" | "auto" | "skip";
    if (!s.config.controlSkipAllowed && s.config.controlMode === "skip") s.config.controlMode = "manual";
    if (b.helperMode) s.config.controlHelperMode = b.helperMode as "manual" | "auto";
    if (b.js) s.config.controlJs = b.js as "ask" | "local" | "off";
    const sens = sites(b.sensitive);
    if (sens) s.config.controlSensitive = sens;
    const blk = sites(b.blocked);
    if (blk) s.config.controlBlocked = blk;
    await s.saveConfig();
    return controlSettings();
  });
  /** The action log: every browser and computer decision (who, site or app, what, allowed or denied, by whom). */
  app.get<{ Querystring: { chat?: string; n?: string } }>("/api/control/decisions", async (req) => ({
    decisions: s.browser.decisions.last(Math.min(200, Math.max(1, Number(req.query.n) || 50)), req.query.chat || undefined),
  }));

  /**
   * The phone's live view (Phase 7) in one read every 2 seconds: what the browser and the computer are doing, the
   * merged action log, the waiting browser/computer approvals (whole, for card v2), the mode and Pause. `watch=1`
   * (only while the view is on screen) also says a screen shows every chat's approvals, so no notification is sent.
   */
  app.get<{ Querystring: { watch?: string; lite?: string } }>("/api/control/live", async (req) => {
    if (req.query.watch === "1") s.controlWatchers.mark(["*"]);
    // `lite=1` (the banner on every page): only what is going on and the last action, no log or approvals.
    const lite = req.query.lite === "1";
    const b = s.browser.activity(40);
    const c = s.computer.status();
    const st = s.browser.status();
    return {
      paused: s.browser.paused(),
      mode: s.config.controlMode,
      skipAllowed: s.config.controlSkipAllowed === true,
      browser: { active: b.active, pane: st.pane, chrome: s.browser.chromeDriving() },
      computer: { enabled: c.enabled, active: c.active, app: c.app },
      log: mergeControlLog(b.log, c.log, lite ? 1 : 40),
      approvals: lite ? [] : s.conversations.pendingControl(),
      // The computer task (control-task.ts), running or ended in the last 10 minutes; lite: without its pictures.
      task: (() => {
        const t = s.controlTasks?.current();
        if (!t) return null;
        if (!lite) return t;
        const { lastShot: _shot, ...rest } = t;
        return { ...rest, steps: rest.steps.slice(-1).map(({ shotThumb: _t, ...st }) => st) };
      })(),
    };
  });
  /** A screen shows these chats' browser/computer approval cards now (`{ chats }`): their notification waits. */
  app.post<{ Body: { chats?: unknown } }>("/api/control/seen", async (req) => {
    const chats = Array.isArray(req.body?.chats) ? req.body.chats.filter((x): x is string => typeof x === "string") : [];
    s.controlWatchers.mark(chats);
    return { ok: true };
  });
  /** Pause or resume browser and computer control (`{ on }`): new actions are refused until resumed; chats go on. */
  app.post<{ Body: { on?: boolean } }>("/api/control/pause", async (req, reply) => {
    if (typeof req.body?.on !== "boolean") return reply.code(400).send({ error: "Send { on: true | false }" });
    s.browser.setPaused(req.body.on);
    return { paused: s.browser.paused() };
  });
  /** A picture of the user's Chrome tab KesherAI drives now (only an attached tab), for the live view. */
  app.get<{ Querystring: { w?: string } }>("/api/browser/chrome/shot", async (req, reply) => {
    const shot = await s.browser.chromePeek(Number(req.query.w) || 960);
    if (!shot) return reply.code(404).send({ error: "KesherAI is not driving a Chrome tab now." });
    return reply.header("cache-control", "no-store").type("image/jpeg").send(shot.jpg);
  });

  /** Whether helpers may also use "Always on this site" (off: they ask before every action; Settings → Browser). */
  app.post<{ Body: { on?: boolean } }>("/api/browser/helper-always", async (req) => {
    s.config.browserHelperAlways = req.body?.on === true;
    await s.saveConfig();
    return { on: s.config.browserHelperAlways };
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
  /** The page in front in KesherAI's browser (its address, title, text and any selection), to save it to a course. */
  app.get("/api/browser/pane/page", (_req, reply) =>
    pane(reply, async () => {
      const r = await s.browser.paneCall<{ url?: string; title?: string; text?: string; selection?: string }>("read");
      return { url: String(r?.url ?? ""), title: String(r?.title ?? ""), text: String(r?.text ?? ""), ...(r?.selection ? { selection: String(r.selection) } : {}) };
    }),
  );
  app.post<{ Body: { cmd?: string; x?: number; y?: number; url?: string; what?: string; id?: number } }>("/api/browser/pane", (req, reply) => {
    const b = req.body ?? {};
    const cmd = String(b.cmd ?? "");
    if (!["tap", "go", "nav", "select", "close", "new"].includes(cmd)) return reply.code(400).send({ error: "Unknown command." });
    const args = cmd === "tap" ? { x: Number(b.x), y: Number(b.y) } : cmd === "go" ? { url: String(b.url ?? "").slice(0, 4000) } : cmd === "nav" ? { what: String(b.what ?? "") } : { id: Number(b.id) };
    return pane(reply, async () => ({ ok: true, result: (await s.browser.paneCall(`pane-${cmd}`, args)) ?? null }));
  });

  // The pane's Debug drawer: console, network, elements, view, "Try my change", recordings.
  await browserDebugRoutes(app, s);

  app.get<{ Querystring: { key?: string; browser?: string; version?: string; features?: string } }>("/api/browser/connect", { websocket: true }, (socket, req) => {
    const origin = String(req.headers.origin ?? "");
    const key = String(req.query.key ?? "");
    if (!isLocalRequest(req) || !/^(chrome|moz)-extension:\/\//.test(origin) || !s.config.browserKey || !same(key, s.config.browserKey)) {
      socket.send(JSON.stringify({ type: "error", error: "wrong-key" }));
      socket.close();
      return;
    }
    s.browser.attach(socket, { browser: String(req.query.browser ?? "").slice(0, 40), version: String(req.query.version ?? "").slice(0, 20), features: String(req.query.features ?? "").slice(0, 80) });
    socket.send(JSON.stringify({ type: "ready" }));
  });
}
