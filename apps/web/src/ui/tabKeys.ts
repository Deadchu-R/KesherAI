/**
 * Arrow keys between tabs, everywhere (WAI-ARIA tabs pattern): in any `[role=tablist]`, Right and Left move to the next
 * or previous tab and choose it, Home and End to the first and last. In a right-to-left page Left is "next".
 */

/**
 * The tab to move to.
 *
 * @param count - Tabs in the list.
 * @param at - The current one.
 * @param key - The key pressed.
 * @param rtl - Whether the page reads right to left.
 * @returns Its index, or -1 when the key does not move.
 */
export function nextTab(count: number, at: number, key: string, rtl: boolean): number {
  if (count < 2 || at < 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  const step = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0;
  if (!step) return -1;
  return (at + (rtl ? -step : step) + count) % count;
}

/** Listens for arrow keys on tabs (call once, when the app starts). */
export function startTabKeys(): void {
  document.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const tab = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('[role="tab"]');
    const list = tab?.closest<HTMLElement>('[role="tablist"]');
    if (!tab || !list) return;
    const tabs = [...list.querySelectorAll<HTMLElement>('[role="tab"]')].filter((t) => !t.hasAttribute("disabled") && t.closest('[role="tablist"]') === list);
    const to = nextTab(tabs.length, tabs.indexOf(tab), e.key, getComputedStyle(list).direction === "rtl");
    if (to < 0) return;
    e.preventDefault();
    tabs[to]!.focus();
    tabs[to]!.click();
  });
}
