/**
 * Smart placement for every popup menu (model menu, Unity chip, + menu,
 * "Open in chat", the app bar's ☰, account and the rest): when one
 * opens, it is measured against the window and placed where it fits —
 * below or above its button, else beside it (start or end side) — kept
 * inside the window, and given a scroll when no side has room for all of
 * it. It follows the button while the page scrolls or the window resizes.
 *
 * It works on the existing menus without changing them: any element with
 * one of POPUP's classes (or data-popover) that appears in the page is
 * placed against its anchor — the nearest element marked as a menu
 * (MENU) or data-popover-anchor, else its parent.
 */

// (The quick menu and the account card span their panel's width by design, so they keep their own place.)
const POPUP = ".model-pop, .bar-pop, .team-pop, .hub-pop, [data-popover]";
const MENU = ".model-menu, .bar-menu, .appbar-menu, .account, [data-popover-anchor]";
const GAP = 6;
const EDGE = 8;

type Side = "below" | "above" | "end" | "start";

/** The element `position: fixed` is measured from (a transformed or filtered ancestor), or none (the window). */
function containingBlock(el: HTMLElement): DOMRect | undefined {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const s = getComputedStyle(p);
    const backdrop = s.backdropFilter || (s as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter || "none";
    if (s.transform !== "none" || s.filter !== "none" || backdrop !== "none" || s.perspective !== "none" || /paint|layout|strict|content/.test(s.contain) || s.willChange.includes("transform")) {
      return p.getBoundingClientRect();
    }
  }
  return undefined;
}

/**
 * Places one popup next to its anchor where it fits.
 *
 * @returns The side it went to.
 */
export function placePopup(pop: HTMLElement, anchor: HTMLElement): Side {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const a = anchor.getBoundingClientRect();
  // Measure at its natural size first.
  Object.assign(pop.style, { position: "fixed", top: "0px", left: "0px", right: "auto", bottom: "auto", insetInlineStart: "auto", insetInlineEnd: "auto", transform: "none", maxHeight: "", maxWidth: `${vw - EDGE * 2}px`, visibility: "hidden" });
  const w = Math.min(pop.offsetWidth, vw - EDGE * 2);
  const h = pop.offsetHeight;
  const room = { below: vh - a.bottom - GAP - EDGE, above: a.top - GAP - EDGE, end: 0, start: 0 };
  const rtl = getComputedStyle(anchor).direction === "rtl";
  // "end" is the reading direction's end: left in Hebrew, right in English.
  room.end = rtl ? a.left - GAP - EDGE : vw - a.right - GAP - EDGE;
  room.start = rtl ? vw - a.right - GAP - EDGE : a.left - GAP - EDGE;
  // Below or above when it fits there (the usual place), else beside, else the roomiest side with a scroll.
  const order: Side[] = ["below", "above"];
  let side: Side | undefined = order.find((s) => room[s] >= h);
  if (!side) side = (["end", "start"] as Side[]).find((s) => room[s] >= w && vh - EDGE * 2 >= Math.min(h, 240));
  if (!side) side = room.below >= room.above ? "below" : "above";
  let top: number;
  let left: number;
  let maxH = vh - EDGE * 2;
  if (side === "below" || side === "above") {
    maxH = Math.max(120, room[side]);
    const height = Math.min(h, maxH);
    top = side === "below" ? a.bottom + GAP : a.top - GAP - height;
    // Line up with the button's start edge, kept inside the window.
    left = rtl ? a.right - w : a.left;
  } else {
    const height = Math.min(h, maxH);
    top = Math.min(Math.max(EDGE, a.top), vh - EDGE - height);
    const toRight = (side === "end") !== rtl;
    left = toRight ? a.right + GAP : a.left - GAP - w;
  }
  left = Math.min(Math.max(EDGE, left), vw - EDGE - w);
  top = Math.max(EDGE, top);
  const cb = containingBlock(pop);
  Object.assign(pop.style, {
    top: `${Math.round(top - (cb?.top ?? 0))}px`,
    left: `${Math.round(left - (cb?.left ?? 0))}px`,
    maxHeight: `${Math.floor(maxH)}px`,
    overflowY: h > maxH ? "auto" : "",
    zIndex: "1000",
    visibility: "",
  });
  pop.dataset.side = side;
  return side;
}

const open = new Map<HTMLElement, HTMLElement>();
let raf = 0;
const replaceAll = () => {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => {
    for (const [pop, anchor] of open) {
      if (!pop.isConnected || !anchor.isConnected) open.delete(pop);
      else placePopup(pop, anchor);
    }
  });
};

function track(pop: HTMLElement): void {
  if (open.has(pop) || pop.dataset.placement === "off") return;
  // A popup the style sheet already pins to the screen (some phone layouts) keeps that place.
  if (!pop.style.position && getComputedStyle(pop).position === "fixed") return;
  const anchor = (pop.parentElement?.closest(MENU) as HTMLElement | null) ?? pop.parentElement;
  if (!anchor) return;
  // A popup inside another popup (a submenu list) is placed with its parent.
  if (pop.parentElement?.closest(POPUP)) return;
  open.set(pop, anchor);
  placePopup(pop, anchor);
  // Its content can change size (search results, loading): place it again.
  new ResizeObserver(replaceAll).observe(pop);
}

/** Starts placing every popup menu that opens in the page. Call once. */
export function startPlacement(): void {
  const scan = (root: ParentNode) => {
    if (root instanceof HTMLElement && root.matches(POPUP)) track(root);
    root.querySelectorAll?.<HTMLElement>(POPUP).forEach(track);
  };
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n instanceof HTMLElement) scan(n);
  }).observe(document.body, { childList: true, subtree: true });
  scan(document.body);
  addEventListener("resize", replaceAll);
  addEventListener("scroll", replaceAll, true);
}
