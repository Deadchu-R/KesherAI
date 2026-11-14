import { randomUUID } from "node:crypto";

/**
 * The user's menu shortcuts: what one is and how it is checked. Used by the shortcut routes and by the design
 * assistant's change_menu tool.
 */

/** A shortcut as kept. */
/** `image`: the site's own icon (a data: address), shown instead of the emoji. */
export interface Shortcut { id: string; label: string; icon?: string; image?: string; href: string }

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
  // A site's icon: a small image as a data: address (shown in an <img>, so even an SVG runs nothing).
  const image = typeof s.image === "string" && s.image.length <= 70_000 && /^data:image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|webp|jpeg|gif);base64,[A-Za-z0-9+/=]+$/.test(s.image) ? s.image : undefined;
  return { id: s.id && /^[\w-]{1,40}$/.test(s.id) ? s.id : randomUUID(), label, ...(icon ? { icon } : {}), ...(image ? { image } : {}), href };
}
