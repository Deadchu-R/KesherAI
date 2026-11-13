import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";
import { menuTool, runDesigner } from "../design-assistant.js";
import { modelTurnFor } from "../model-turn.js";
import { cleanShortcut, type Shortcut } from "../menu-shortcuts.js";

export { cleanShortcut, type Shortcut } from "../menu-shortcuts.js";

/**
 * The user's sidebar shortcuts (after Notion's: any page, renamed, reordered, up to 25; removing one only takes it
 * off the sidebar). Kept in the config so the phone shows the same ones. A shortcut opens a page of the app
 * (`#/…`) or a web address (http/https, opened outside the app); anything else, like `javascript:`, is refused.
 */

/**
 * Registers the shortcut routes.
 *
 * @param app - The server.
 * @param s - The services.
 */
export function shortcutRoutes(app: FastifyInstance, s: KesherServices): void {
  app.get("/api/shortcuts", async () => ({ shortcuts: s.config.shortcuts }));
  // The pinned tools: one list for every device (Roee: one menu on the computer and the phone). null = the defaults.
  app.get("/api/pins", async () => ({ pins: s.config.pins ?? null }));
  app.put<{ Body: { pins?: unknown } }>("/api/pins", async (req, reply) => {
    const pins = req.body?.pins;
    if (!Array.isArray(pins) || pins.length > 40 || !pins.every((p) => typeof p === "string" && /^#\/[\w\-/]{1,98}$/.test(p))) return reply.code(400).send({ error: "Pins are app pages (#/…), up to 40." });
    s.config.pins = [...new Set(pins as string[])];
    await s.saveConfig();
    return { pins: s.config.pins };
  });
  // The whole list at once (add, rename, reorder and remove are all one PUT), so two devices never half-merge.
  app.put<{ Body: { shortcuts?: Array<Partial<Shortcut>> } }>("/api/shortcuts", async (req, reply) => {
    const list = req.body?.shortcuts;
    if (!Array.isArray(list) || list.length > 25) return reply.code(400).send({ error: "Up to 25 shortcuts." });
    const out: Shortcut[] = [];
    for (const item of list) {
      const c = cleanShortcut(item ?? {});
      if ("error" in c) return reply.code(400).send(c);
      out.push(c);
    }
    s.config.shortcuts = out;
    await s.saveConfig();
    return { shortcuts: out };
  });

  /**
   * The design assistant (the 🎨 panel): one request in words, done with change_look and change_menu only.
   * One at a time. The pages come from the app (their names in the user's language) and are checked here.
   */
  let designing = false;
  app.post<{ Body: { text?: string; pages?: Array<{ href?: string; label?: string }>; defaults?: string[]; hebrew?: boolean } }>("/api/design-assistant", async (req, reply) => {
    const text = String(req.body?.text ?? "").trim().slice(0, 600);
    if (!text) return reply.code(400).send({ error: "Say what to change." });
    const modelId = s.config.activeModels.chat;
    if (!modelId) return reply.code(400).send({ code: "no-model", error: "Choose a chat model first (Models)." });
    if (designing) return reply.code(409).send({ error: "The design assistant is still working on the last request." });
    const page = /^#\/[\w\-/]{0,98}$/;
    const pages = (Array.isArray(req.body?.pages) ? req.body.pages : []).filter((p) => typeof p?.href === "string" && page.test(p.href)).slice(0, 60).map((p) => ({ href: p.href!, label: String(p.label ?? p.href).slice(0, 40) }));
    const defaults = (Array.isArray(req.body?.defaults) ? req.body.defaults : []).filter((h) => typeof h === "string" && page.test(h)).slice(0, 40);
    const store = {
      pins: () => s.config.pins ?? null,
      setPins: async (next: string[]) => {
        s.config.pins = next;
        await s.saveConfig();
      },
      shortcuts: () => s.config.shortcuts,
      setShortcuts: async (next: Shortcut[]) => {
        s.config.shortcuts = next;
        await s.saveConfig();
      },
    };
    const before = { pins: s.config.pins ?? null, shortcuts: [...s.config.shortcuts] };
    const label = (h: string) => pages.find((p) => p.href === h)?.label ?? h;
    const state = `Now pinned in the menu, in order: ${(before.pins ?? defaults).map(label).join(", ") || "(nothing)"}. Shortcuts: ${before.shortcuts.map((x) => x.label).join(", ") || "(none)"}.`;
    designing = true;
    try {
      const r = await runDesigner({ text, tools: [...s.conversations.lookTools(), menuTool(store, pages, defaults)], modelId, model: modelTurnFor(s.registry, modelId), state, hebrew: req.body?.hebrew === true, signal: AbortSignal.timeout(180_000) });
      return { reply: r.reply, look: r.used.includes("change_look"), menu: r.used.includes("change_menu"), before, pins: s.config.pins ?? null, shortcuts: s.config.shortcuts };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    } finally {
      designing = false;
    }
  });
}
