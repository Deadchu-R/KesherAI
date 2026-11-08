import type { FastifyInstance } from "fastify";
import { PARTS, partOn } from "@kesher/shared";
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
    if (typeof req.body?.role === "string") s.config.onboarding.role = req.body.role.slice(0, 40);
    await s.saveConfig();
    return s.config.onboarding;
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
