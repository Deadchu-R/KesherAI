import type { FastifyInstance } from "fastify";
import { PARTS, partOn, cleanAppearance, type Appearance } from "@kesher/shared";
import type { KesherServices } from "../services.js";
import { ensureVideoModel } from "../sdcpp.js";
import { isLocalRequest } from "../auth.js";

/**
 * Settings → Parts: turning parts of KesherAI on and off. Off: its pages
 * leave the menu, its tools leave the chats, and what it runs in the
 * background stops. On: it downloads what it needs (follow it in the
 * downloads circle).
 *
 * @param app - Fastify instance.
 * @param s - Services.
 */
export async function partsRoutes(app: FastifyInstance, s: KesherServices): Promise<void> {
  const view = () => ({ parts: PARTS.map((p) => ({ ...p, on: partOn(s.config.parts, p.id) })) });

  app.get("/api/parts", async () => view());

  /**
   * The first-run welcome. It shows once, on this computer, to someone who
   * has not chatted yet (an update never shows it to an existing user).
   */
  app.get("/api/onboarding", async (req) => ({
    ...s.config.onboarding,
    show: !s.config.onboarding.done && isLocalRequest(req) && s.library.items().length === 0,
    google: { configured: s.google.configured, connected: s.google.connected },
    remote: { enabled: s.config.remote.enabled },
  }));

  /** Body: `{ done?, role? }`. */
  app.put<{ Body: { done?: boolean; role?: string } }>("/api/onboarding", async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send({ error: "The welcome runs on the computer that runs KesherAI." });
    if (typeof req.body?.done === "boolean") s.config.onboarding.done = req.body.done;
    if (typeof req.body?.role === "string") s.config.onboarding.role = req.body.role.slice(0, 200);
    await s.saveConfig();
    return s.config.onboarding;
  });

  /** How the app looks. Only looks (no access, no files), so the phone may change it too. */
  app.get("/api/appearance", async () => ({ appearance: cleanAppearance(s.config.appearance), canUndo: s.config.appearanceHistory.length > 0 }));

  /** Body: `{ appearance }` (the whole look; `{}` is the default look), or `{ undo: true }`. */
  app.put<{ Body: { appearance?: unknown; undo?: boolean } }>("/api/appearance", async (req) => {
    if (req.body?.undo) {
      const prev = s.config.appearanceHistory.pop();
      s.config.appearance = prev ? cleanAppearance(prev) as Record<string, unknown> : {};
    } else setAppearance(s, cleanAppearance(req.body?.appearance));
    await s.saveConfig();
    return { appearance: cleanAppearance(s.config.appearance), canUndo: s.config.appearanceHistory.length > 0 };
  });

  /** Looks the user saved by name. Only looks, so the phone may use them too. */
  const looksView = () => ({ looks: s.config.savedLooks.map((l) => ({ name: l.name, appearance: cleanAppearance(l.appearance) })) });
  app.get("/api/appearance/saved", async () => looksView());

  /** Body: `{ name }`: saves the look in use under that name (the same name is replaced). */
  app.post<{ Body: { name?: unknown } }>("/api/appearance/saved", async (req, reply) => {
    const name = typeof req.body?.name === "string" ? [...req.body.name].filter((c) => c >= " ").join("").trim().slice(0, 60) : "";
    if (!name) return reply.code(400).send({ error: "Give the look a name." });
    const rest = s.config.savedLooks.filter((l) => l.name !== name);
    if (rest.length >= 40) return reply.code(400).send({ error: "You can keep up to 40 looks; delete one first." });
    s.config.savedLooks = [...rest, { name, appearance: cleanAppearance(s.config.appearance) as Record<string, unknown> }];
    await s.saveConfig();
    return looksView();
  });

  /** Deletes a saved look by name (`?name=`). */
  app.delete<{ Querystring: { name?: string } }>("/api/appearance/saved", async (req) => {
    s.config.savedLooks = s.config.savedLooks.filter((l) => l.name !== req.query.name);
    await s.saveConfig();
    return looksView();
  });

  /** A picture for the background (Settings → Appearance): saved to the library; returns its id. Body: `{ data: base64, mimeType }`. */
  app.post<{ Body: { data?: string; mimeType?: string } }>("/api/appearance/background", { bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
    const mime = req.body?.mimeType ?? "";
    if (!/^image\/(png|jpeg|webp)$/.test(mime) || typeof req.body?.data !== "string") return reply.code(400).send({ error: "Send a PNG, JPEG or WebP picture." });
    const data = Buffer.from(req.body.data, "base64");
    if (!data.length) return reply.code(400).send({ error: "The picture is empty." });
    const asset = await s.assets.save(data, mime, { meta: { use: "background" } });
    return { assetId: asset.id };
  });

  /** Body: `{ parts: { <id>: true | false } }`, or `{ preset: "chat" | "all" }`. */
  app.put<{ Body: { parts?: Record<string, boolean>; preset?: "chat" | "all" } }>("/api/parts", async (req, reply) => {
    const next: Record<string, boolean> = { ...s.config.parts };
    if (req.body?.preset) for (const p of PARTS) next[p.id] = req.body.preset === "all";
    for (const [id, on] of Object.entries(req.body?.parts ?? {})) if (PARTS.some((p) => p.id === id)) next[id] = !!on;
    const turnedOn = PARTS.filter((p) => next[p.id] !== false && !partOn(s.config.parts, p.id)).map((p) => p.id);
    const turnedOff = PARTS.filter((p) => next[p.id] === false && partOn(s.config.parts, p.id)).map((p) => p.id);
    // Only what is off is stored (everything is on by default).
    s.config.parts = Object.fromEntries(Object.entries(next).filter(([, v]) => v === false));
    await s.saveConfig();
    try {
      await apply(s, turnedOn, turnedOff);
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message, ...view() });
    }
    return view();
  });
}

/** Stops what turned-off parts run, and starts the downloads turned-on parts need. */
async function apply(s: KesherServices, on: string[], off: string[]): Promise<void> {
  const plugin = async (id: string, enabled: boolean) => {
    const prev = s.config.plugins[id];
    if ((prev?.enabled ?? true) === enabled) return;
    s.config.plugins[id] = { enabled, settings: prev?.settings ?? {} };
    await s.saveConfig();
    await s.plugins.reload();
  };
  for (const id of off) {
    const part = PARTS.find((p) => p.id === id);
    if (part?.plugin) await plugin(part.plugin, false);
    if (id === "nodes") await s.comfy.stop().catch(() => undefined);
    if (id === "day") await s.journal.update({ enabled: false }).catch(() => undefined);
    if (id === "knowledge") await s.semantic.stop().catch(() => undefined);
  }
  for (const id of on) {
    const part = PARTS.find((p) => p.id === id);
    if (part?.plugin) await plugin(part.plugin, true);
    // Downloads run in the background; their progress shows in the downloads circle.
    if (id === "images") void s.sd.installEngine().catch(() => undefined);
    if (id === "voice") {
      void s.whisper.prepare().catch(() => undefined);
      void s.kokoro.prepare().catch(() => undefined);
    }
    if (id === "knowledge") void s.semantic.setup().catch(() => undefined);
    if (id === "video") void ensureVideoModel({ sd: s.sd, downloads: s.downloads, config: s.config, modelsDir: () => s.paths.models, save: () => s.saveConfig() }).catch(() => undefined);
    if (id === "nodes" && !s.comfy.status().installed) void s.comfy.install().catch(() => undefined);
  }
}

/**
 * Sets the look and keeps the one before it for Undo (the last 10).
 *
 * @param s - The server state.
 * @param next - The new, checked look.
 */
export function setAppearance(s: { config: { appearance: Record<string, unknown>; appearanceHistory: Array<Record<string, unknown>> } }, next: Appearance): void {
  s.config.appearanceHistory = [...s.config.appearanceHistory, s.config.appearance].slice(-10);
  s.config.appearance = next as Record<string, unknown>;
}
