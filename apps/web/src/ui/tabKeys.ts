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

/**
 * A finger swipe that means "the next tab" (Roee, 2026-11-18): mostly sideways, long enough and quick. Returns the
 * arrow key it stands for (so it moves like the keyboard, right to left included), or "" when it is not a swipe.
 *
 * @param dx - Sideways distance in pixels (positive: the finger moved right).
 * @param dy - Up-down distance in pixels.
 * @param ms - How long the touch lasted.
 * @param width - The screen's width (a swipe is at least a sixth of it, and at least 60 pixels).
 */
export function swipeKey(dx: number, dy: number, ms: number, width: number): "ArrowRight" | "ArrowLeft" | "" {
  if (ms > 700 || Math.abs(dx) < Math.max(60, width / 6) || Math.abs(dx) < Math.abs(dy) * 2) return "";
  // Moving the finger left brings the next page in from the right, like the Right arrow in a left-to-right page.
  return dx < 0 ? "ArrowRight" : "ArrowLeft";
}

/** Whether a touch began where sideways movement belongs to something else (a field, a slider, a sideways scroller). */
function ownsSideways(el: HTMLElement | null): boolean {
  for (let e = el; e && e !== document.body; e = e.parentElement) {
    if (e.matches('input, textarea, select, canvas, video, [contenteditable="true"], [data-noswipe], [role="slider"], .cm-editor, .monaco-editor')) return true;
    const s = getComputedStyle(e);
    if ((s.overflowX === "auto" || s.overflowX === "scroll") && e.scrollWidth > e.clientWidth + 4) return true;
  }
  return false;
}

/**
 * Swipes between tabs on a touch screen: a sideways swipe on a page with tabs (`[role=tablist]` with a selected tab,
 * or a `nav` of links with the current page marked, like Settings) moves to the next or previous one, like the arrows. The nearest tab list around where the finger started is the
 * one moved; fields, sliders and sideways scrollers keep their own swipes.
 */
export function startTabSwipes(): void {
  let start: { x: number; y: number; t: number; el: HTMLElement | null } | undefined;
  document.addEventListener("touchstart", (e) => {
    const p = e.touches[0];
    start = e.touches.length === 1 && p && !ownsSideways(e.target as HTMLElement) ? { x: p.clientX, y: p.clientY, t: Date.now(), el: e.target as HTMLElement } : undefined;
  }, { passive: true });
  document.addEventListener("touchend", (e) => {
    const p = e.changedTouches[0];
    const s = start;
    start = undefined;
    if (!s || !p) return;
    const key = swipeKey(p.clientX - s.x, p.clientY - s.y, Date.now() - s.t, window.innerWidth);
    if (!key) return;
    // The nearest tab list around the touch that shows which tab is open: tabs (`role=tab`, one selected) or a page
    // menu of links (a `nav` with the current page marked, like Settings' categories).
    const open = (l: HTMLElement) => l.querySelector('[role="tab"][aria-selected="true"], a[aria-current="page"]');
    let list: HTMLElement | null = null;
    // Only inside the page (up to <main>): the app's own bars are not swiped through.
    for (let e2 = s.el; e2 && !list; e2 = e2.tagName === "MAIN" ? null : e2.parentElement) {
      list = [...e2.querySelectorAll<HTMLElement>('[role="tablist"], nav')].find((l) => l.offsetParent !== null && open(l)) ?? null;
    }
    if (!list) return;
    const isTabs = list.getAttribute("role") === "tablist";
    const tabs = [...list.querySelectorAll<HTMLElement>(isTabs ? '[role="tab"]' : "a[href]")].filter((t) => !t.hasAttribute("disabled") && t.closest(isTabs ? '[role="tablist"]' : "nav") === list);
    const at = tabs.findIndex((t) => t.getAttribute("aria-selected") === "true" || t.getAttribute("aria-current") === "page");
    const to = nextTab(tabs.length, at, key, getComputedStyle(list).direction === "rtl");
    // No wrapping around on a swipe: past the last tab nothing happens.
    if (to < 0 || Math.abs(to - at) !== 1) return;
    tabs[to]!.click();
    tabs[to]!.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, { passive: true });
}
