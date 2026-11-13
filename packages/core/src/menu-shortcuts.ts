import { randomUUID } from "node:crypto";

/**
 * The user's menu shortcuts: what one is and how it is checked. Used by the shortcut routes and by the design
 * assistant's change_menu tool.
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
