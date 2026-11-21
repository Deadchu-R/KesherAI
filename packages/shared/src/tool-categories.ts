/**
 * The tool categories of the welcome and of the All tools page, one per kind of person the welcome asks about
 * (game developer, artist, developer, student, writer, researcher, everyday). The roles picked in the welcome
 * decide which categories come first, which pages are pinned at the top of the sidebar, and which categories
 * the All tools page shows before "Show all". Nothing is ever removed: a page in no category lands in "More",
 * and every category is one tap away.
 */

/** One category of tools: pages (menu hrefs such as `#/images`) in the order they are shown. */
export interface ToolCategory {
  id: string;
  icon: string;
  title: { en: string; he: string };
  /** Menu hrefs, most useful first (the first ones are pinned for the roles that pick this category). */
  pages: string[];
}

/** The categories, in their default order. `system` is always shown, and always last. */
export const TOOL_CATEGORIES: ToolCategory[] = [
  { id: "games", icon: "🎮", title: { en: "Game development", he: "פיתוח משחקים" }, pages: ["#/unreal", "#/unity", "#/games", "#/godot", "#/nodes"] },
  { id: "art", icon: "🎨", title: { en: "Art and design", he: "אמנות ועיצוב" }, pages: ["#/images", "#/bank", "#/canvas", "#/lens", "#/batch", "#/training", "#/design"] },
  { id: "code", icon: "💻", title: { en: "Code and automation", he: "קוד ואוטומציה" }, pages: ["#/self-work", "#/pipelines", "#/tasks", "#/task-inbox"] },
  { id: "study", icon: "🎓", title: { en: "Study", he: "לימודים" }, pages: ["#/study", "#/ideas"] },
  { id: "writing", icon: "✍️", title: { en: "Writing and creating", he: "כתיבה ויצירה" }, pages: ["#/docs", "#/slides", "#/sheets", "#/prompts", "#/personas"] },
  { id: "research", icon: "🔬", title: { en: "Research and knowledge", he: "מחקר וידע" }, pages: ["#/knowledge", "#/libraries", "#/compare", "#/chat-reports"] },
  { id: "everyday", icon: "☀️", title: { en: "Everyday", he: "יומיומי" }, pages: ["#/day", "#/inbox", "#/memory", "#/community", "#/stremio", "#/usage"] },
  { id: "system", icon: "⚙", title: { en: "System", he: "מערכת" }, pages: ["#/models", "#/connections", "#/health", "#/remote", "#/updates", "#/settings"] },
];

/** Where pages that no category names go (new pages, plugin pages), so nothing disappears. */
export const MORE_CATEGORY: ToolCategory = { id: "more", icon: "🧩", title: { en: "More", he: "עוד" }, pages: [] };

/** The categories each role brings first, most important first. Roles not listed bring every category. */
export const ROLE_CATEGORIES: Record<string, string[]> = {
  gamedev: ["games", "art", "code"],
  artist: ["art", "writing"],
  developer: ["code", "research"],
  student: ["study", "research", "writing"],
  writer: ["writing", "research"],
  researcher: ["research", "study", "writing"],
  everyday: ["everyday", "writing"],
  modeler: ["games", "art"],
  sound: ["art", "writing"],
  youtuber: ["writing", "art"],
  business: ["everyday", "writing", "code"],
};

const ALL_IDS = TOOL_CATEGORIES.map((c) => c.id);

/** Splits a stored role value ("gamedev,artist") into ids. */
function roleList(roles: string | string[] | undefined): string[] {
  return (Array.isArray(roles) ? roles : (roles ?? "").split(",")).map((r) => r.trim()).filter(Boolean);
}

/**
 * The categories the picked roles bring first, in pick order without repeats, then `system`.
 *
 * @param roles - Role ids, a list or joined with commas (as the welcome stores them).
 * @returns Category ids. No role, or a role that brings everything ("other", an unknown one): every category.
 */
export function categoriesForRoles(roles: string | string[] | undefined): string[] {
  const ids = roleList(roles);
  if (!ids.length || ids.some((r) => !ROLE_CATEGORIES[r])) return [...ALL_IDS];
  const picked = ids.flatMap((r) => ROLE_CATEGORIES[r]!).filter((c, i, a) => a.indexOf(c) === i && c !== "system");
  return [...picked, "system"];
}

/** A category with the pages that exist, and whether the roles brought it (shown before "Show all"). */
export interface CategoryView extends ToolCategory {
  first: boolean;
}

/**
 * Sorts the pages that exist into categories for the All tools page: the roles' categories first, then the rest
 * (marked `first: false`, hidden until "Show all"), then "More" for pages no category names, with `system` last.
 * Every given page appears exactly once.
 *
 * @param hrefs - Every page of the menu, plugin pages included.
 * @param roles - The picked roles (see {@link categoriesForRoles}).
 * @returns Non-empty categories in the order to show them.
 */
export function categorizeTools(hrefs: string[], roles: string | string[] | undefined): CategoryView[] {
  const first = categoriesForRoles(roles);
  const known = new Set(TOOL_CATEGORIES.flatMap((c) => c.pages));
  const rank = (id: string) => (id === "system" ? 1000 : first.includes(id) ? first.indexOf(id) : 100 + ALL_IDS.indexOf(id));
  const unique = hrefs.filter((h, i, a) => a.indexOf(h) === i);
  const cats: CategoryView[] = TOOL_CATEGORIES.map((c) => ({ ...c, pages: c.pages.filter((p) => unique.includes(p)), first: first.includes(c.id) }));
  const more = unique.filter((h) => !known.has(h));
  if (more.length) cats.push({ ...MORE_CATEGORY, pages: more, first: false });
  return cats.filter((c) => c.pages.length).sort((a, b) => (a.id === "more" ? 500 : rank(a.id)) - (b.id === "more" ? 500 : rank(b.id)));
}

/**
 * The pages to pin at the top of the sidebar for the picked roles: the first two of each of their categories, then
 * the pins the user already had (so nothing they chose is lost), capped so the sidebar stays short.
 *
 * @param roles - The picked roles.
 * @param current - The pins now.
 * @param max - The most pins to keep (default 8).
 * @returns The new pins, roles' pages first. No specific role: the current pins unchanged.
 */
export function pinsForRoles(roles: string | string[] | undefined, current: string[], max = 8): string[] {
  const ids = roleList(roles).filter((r) => ROLE_CATEGORIES[r]);
  if (!ids.length) return current;
  const byId = new Map(TOOL_CATEGORIES.map((c) => [c.id, c]));
  const fromRoles = categoriesForRoles(ids).filter((c) => c !== "system").flatMap((c) => byId.get(c)!.pages.slice(0, 2));
  return [...fromRoles, ...current].filter((h, i, a) => a.indexOf(h) === i).slice(0, max);
}
