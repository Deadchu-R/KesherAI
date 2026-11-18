/* global document, getComputedStyle, innerWidth */
/*
 * Swipes between tabs on the phone's own pages (Roee, 2026-11-18; the computer's pages have the same in the web app):
 * a quick sideways swipe over a page with a tab row moves to the next or previous tab, right to left included (in
 * Hebrew the finger moving right brings the next tab, the one on the left). The tab row nearest to where the finger
 * started is used; the "Phone / Computer" switch is never swiped; fields, sliders and sideways scrollers keep theirs.
 */
(() => {
  let start;
  const owns = (el) => {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      if (e.matches?.('input, textarea, select, canvas, video, [contenteditable="true"], [data-noswipe], [role="slider"]')) return true;
      const s = getComputedStyle(e);
      if ((s.overflowX === "auto" || s.overflowX === "scroll") && e.scrollWidth > e.clientWidth + 4) return true;
    }
    return false;
  };
  const tabsOf = (list) => [...list.querySelectorAll('[role="tab"], :scope > button, :scope > a')].filter((t) => !t.disabled && t.closest('[role="tablist"]') === list);
  const isOn = (t) => t.getAttribute("aria-selected") === "true" || t.classList.contains("on") || t.classList.contains("primary") || t.classList.contains("active");
  document.addEventListener("touchstart", (e) => {
    const p = e.touches[0];
    start = e.touches.length === 1 && p && !owns(e.target) ? { x: p.clientX, y: p.clientY, t: Date.now(), el: e.target } : undefined;
  }, { passive: true });
  document.addEventListener("touchend", (e) => {
    const p = e.changedTouches[0];
    const s = start;
    start = undefined;
    if (!s || !p) return;
    const dx = p.clientX - s.x;
    const dy = p.clientY - s.y;
    if (Date.now() - s.t > 700 || Math.abs(dx) < Math.max(60, innerWidth / 6) || Math.abs(dx) < Math.abs(dy) * 2) return;
    let list = null;
    for (let el = s.el; el && !list; el = el.parentElement) {
      list = [...el.querySelectorAll('[role="tablist"]')].find((l) => l.offsetParent !== null && !l.matches('#whereBar, #cats, .seg, [data-noswipe]') && tabsOf(l).some(isOn)) ?? null;
    }
    if (!list) return;
    const tabs = tabsOf(list);
    const at = tabs.findIndex(isOn);
    const rtl = getComputedStyle(list).direction === "rtl";
    // The finger moving left means "next" in a left-to-right row, "previous" in a right-to-left one.
    const step = (dx < 0 ? 1 : -1) * (rtl ? -1 : 1);
    const to = at + step;
    if (at < 0 || to < 0 || to >= tabs.length) return;
    tabs[to].click();
    tabs[to].scrollIntoView?.({ block: "nearest", inline: "center", behavior: "smooth" });
  }, { passive: true });
})();
