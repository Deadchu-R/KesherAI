/**
 * The open tabs (design TabsImageEditor; RESEARCH_LOG "Editors, part 5: tabs"): each tab is a page of the app (an
 * address after `#`). Home is always first and is not stored. As VS Code: going somewhere new opens a preview tab,
 * which the next place replaces until it is pinned (a double click, or "keep"); a place already open in a tab
 * switches to that tab. Pure functions, kept in the browser (localStorage) by Tabs.tsx.
 */
export interface PageTab {
  /** The address, e.g. `#/c/<id>` or `#/models`. */
  hash: string;
  /** A preview tab: the next place opened replaces it. */
  preview?: boolean;
}

export const HOME = "#/";
const MAX = 20;

/** The part of an address that names the place (`#/c/abc?x=1` and `#/c/abc` are the same tab). */
export const placeOf = (hash: string): string => (hash || HOME).split("?")[0]!.replace(/\/$/, "") || "#";

/**
 * The tabs after going to `hash` from the tab that was showing.
 *
 * @param tabs - The open tabs (Home not included).
 * @param from - The address that was showing.
 * @param hash - Where she went.
 * @returns The new tabs.
 */
export function openTab(tabs: readonly PageTab[], from: string, hash: string): PageTab[] {
  if (placeOf(hash) === placeOf(HOME)) return [...tabs];
  const at = tabs.findIndex((t) => placeOf(t.hash) === placeOf(hash));
  if (at >= 0) return tabs.map((t, i) => (i === at ? { ...t, hash } : t));
  const cur = tabs.findIndex((t) => placeOf(t.hash) === placeOf(from));
  // A chat or an editor is something she works in: it opens as a kept tab (so tabs build up even where the row is
  // hidden or there is nothing to double-click, as on a phone). Menu pages open as a preview that the next one replaces.
  if (/^#\/(c|p)\//.test(placeOf(hash))) {
    const next = [...tabs];
    next.splice(cur >= 0 ? cur + 1 : next.length, 0, { hash });
    while (next.length > MAX) next.splice(next.findIndex((t) => placeOf(t.hash) !== placeOf(hash)), 1);
    return next;
  }
  const preview = tabs.findIndex((t) => t.preview);
  // The preview tab is reused (the one showing, or else the one there is).
  if (cur >= 0 && tabs[cur]!.preview) return tabs.map((t, i) => (i === cur ? { hash, preview: true } : t));
  if (preview >= 0) return tabs.map((t, i) => (i === preview ? { hash, preview: true } : t));
  const next = [...tabs];
  next.splice(cur >= 0 ? cur + 1 : next.length, 0, { hash, preview: true });
  // Too many: the oldest pinned tab that is not showing goes.
  while (next.length > MAX) next.splice(next.findIndex((t) => placeOf(t.hash) !== placeOf(hash)), 1);
  return next;
}

/**
 * Keeps a tab (no longer a preview).
 *
 * @param tabs - The open tabs.
 * @param hash - The tab's address.
 * @returns The new tabs.
 */
export function pinTab(tabs: readonly PageTab[], hash: string): PageTab[] {
  return tabs.map((t) => (placeOf(t.hash) === placeOf(hash) ? { hash: t.hash } : t));
}

/**
 * Closes a tab.
 *
 * @param tabs - The open tabs.
 * @param hash - The tab to close.
 * @param showing - The address showing now.
 * @returns The tabs left, and where to go (the neighbour, or Home) when the closed tab was the one showing.
 */
export function closeTab(tabs: readonly PageTab[], hash: string, showing: string): { tabs: PageTab[]; go?: string } {
  const at = tabs.findIndex((t) => placeOf(t.hash) === placeOf(hash));
  if (at < 0) return { tabs: [...tabs] };
  const left = tabs.filter((_, i) => i !== at);
  if (placeOf(hash) !== placeOf(showing)) return { tabs: left };
  return { tabs: left, go: (left[at] ?? left[at - 1])?.hash ?? HOME };
}

/**
 * The next or previous tab (Ctrl+Tab, Ctrl+Shift+Tab), Home included as the first.
 *
 * @param tabs - The open tabs.
 * @param showing - The address showing now.
 * @param step - 1 or -1.
 * @returns Its address.
 */
export function stepTab(tabs: readonly PageTab[], showing: string, step: 1 | -1): string {
  const all = [HOME, ...tabs.map((t) => t.hash)];
  const at = Math.max(0, all.findIndex((h) => placeOf(h) === placeOf(showing)));
  return all[(at + step + all.length) % all.length]!;
}

/** Reads stored tabs, keeping only well-formed ones. */
export function readTabs(raw: string | null): PageTab[] {
  try {
    const v = JSON.parse(raw ?? "[]") as unknown;
    if (!Array.isArray(v)) return [];
    return v
      .filter((t): t is PageTab => !!t && typeof (t as PageTab).hash === "string" && (t as PageTab).hash.startsWith("#/") && (t as PageTab).hash.length < 500)
      .map((t) => (t.preview ? { hash: t.hash, preview: true } : { hash: t.hash }))
      .filter((t) => placeOf(t.hash) !== placeOf(HOME))
      .slice(0, MAX);
  } catch {
    return [];
  }
}
