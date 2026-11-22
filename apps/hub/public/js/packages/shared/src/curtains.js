/**
 * Curtains: every group of the hub's Tasks tab (and each section of Claude's work list) has a head that opens and
 * closes it, so the screen is less cluttered. Which curtains the user changed is remembered per device. This file is
 * the pure part (defaults, toggling, reading and writing the stored text); the page keeps the store in localStorage.
 */
/** The storage key of the remembered curtains (one JSON object per device). */
export const CURTAINS_KEY = "kh-curtains";
/** A work-list section with more items than this starts closed. */
export const LONG_SECTION = 6;
/**
 * The curtain's state when the user has not changed it: Done (and long work-list sections) is closed; what is
 * waiting, active, next or failed is open.
 *
 * @param key - The curtain: `t:<tab>:<group>` for a Tasks group, `wl:<section>` for a work-list section.
 * @param count - The number of items inside (only a work-list section uses it).
 */
export function defaultOpen(key, count = 0) {
    if (key.startsWith("wl:"))
        return count <= LONG_SECTION;
    // Done starts closed (a long history). Failed starts open: the Failed tab is opened to see the failures, and a
    // closed curtain there showed an empty-looking page.
    return key.split(":")[1] !== "done";
}
/**
 * Whether a curtain is open now.
 *
 * @param store - The changed curtains.
 * @param key - The curtain.
 * @param count - The number of items inside.
 * @param forced - True while searching: every curtain with a match is open, whatever was chosen.
 */
export function isOpen(store, key, count = 0, forced = false) {
    return forced || (store[key] ?? defaultOpen(key, count));
}
/**
 * The store after a tap on a curtain's head (a new object; the old one is not changed).
 *
 * @param store - The changed curtains.
 * @param key - The curtain.
 * @param count - The number of items inside.
 */
export function toggled(store, key, count = 0) {
    return { ...store, [key]: !isOpen(store, key, count) };
}
/**
 * Reads the stored text; anything that is not a JSON object of booleans gives an empty store (never throws).
 *
 * @param raw - What localStorage returned, if anything.
 */
export function parseCurtains(raw) {
    try {
        const v = JSON.parse(raw ?? "{}");
        if (!v || typeof v !== "object" || Array.isArray(v))
            return {};
        return Object.fromEntries(Object.entries(v).filter((e) => typeof e[1] === "boolean").slice(0, 200));
    }
    catch {
        return {};
    }
}
/**
 * The text to store: only the curtains that differ from their default would be enough, but a plain dump is smaller
 * to reason about; the number is capped so the storage cannot grow without end.
 *
 * @param store - The changed curtains.
 */
export function serializeCurtains(store) {
    return JSON.stringify(Object.fromEntries(Object.entries(store).slice(-200)));
}
