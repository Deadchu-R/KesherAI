import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { KesherServices } from "../services.js";

/**
 * The user's sidebar shortcuts (after Notion's: any page, renamed, reordered, up to 25; removing one only takes it
 * off the sidebar). Kept in the config so the phone shows the same ones. A shortcut opens a page of the app
 * (`#/…`) or a web address (http/https, opened outside the app); anything else, like `javascript:`, is refused.
 */

/** A shortcut as kept. */
export interface Shortcut { id: string; label: string; icon?: string; href: string }

/**
 * Checks one shortcut.
 *
 * @param s - What the request sent.
 * @returns The cleaned shortcut, or an error to show.
 */
export function cleanShortcut(s: Partial<Shortcut>): Shortcut | { error: string } {
  const label = String(s.label ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  const href = String(s.href ?? "").trim();
  const icon = s.icon ? [...String(s.icon).trim()].slice(0, 2).join("") : undefined;
  if (!label) return { error: "A shortcut needs a name." };
  const page = /^#\/[\w\-/.?=&%:~+]*$/.test(href);
  let web = false;
  try {
    const u = new URL(href);
    web = (u.protocol === "https:" || u.protocol === "http:") && href.length <= 500;
  } catch {
    web = false;
  }
  if (!page && !web) return { error: "A shortcut opens a page of KesherAI (#/…) or a web address (https://…)." };
  return { id: s.id && /^[\w-]{1,40}$/.test(s.id) ? s.id : randomUUID(), label, ...(icon ? { icon } : {}), href };
}

/**
 * Registers the shortcut routes.
 *
 * @param app - The server.
 * @param s - The services.
 */
export function shortcutRoutes(app: FastifyInstance, s: KesherServices): void {
  app.get("/api/shortcuts", async () => ({ shortcuts: s.config.shortcuts }));
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
}
