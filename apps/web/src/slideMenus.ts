/**
 * Press-and-slide menus, like Apple's: press a menu button and keep your
 * finger (or mouse button) down, slide over the items (the one under the
 * finger lights up), and let go to choose it. A plain tap still just opens
 * the menu. Works for every button marked `data-slide-menu` and the menus
 * and side menu it opens.
 */
const MENUS = ".bar-pop, .sidebar.open, .model-pop, .acc-pop, [role=menu], [role=listbox]";
const ITEMS = "a[href], button:not([disabled]), [role=menuitem], [role=option]";

/** Installs the behaviour once, for the whole app. */
export function installSlideMenus(): void {
  let trigger: HTMLElement | null = null;
  let start = { x: 0, y: 0 };
  let sliding = false;
  let hot: HTMLElement | null = null;
  let swallowClick = false;
  let opened: HTMLElement | null = null;

  const setHot = (el: HTMLElement | null) => {
    if (el === hot) return;
    hot?.classList.remove("slide-hot");
    hot = el;
    hot?.classList.add("slide-hot");
  };
  const itemAt = (x: number, y: number): HTMLElement | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!el || (trigger && trigger.contains(el))) return null;
    const menu = el.closest(MENUS);
    return menu ? (el.closest(ITEMS) as HTMLElement | null) : null;
  };

  addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 0) return;
      const t = (e.target as HTMLElement | null)?.closest("[data-slide-menu]") as HTMLElement | null;
      if (!t) return;
      trigger = t;
      start = { x: e.clientX, y: e.clientY };
      sliding = false;
      // Open now (not on release), so the finger can slide into the menu.
      swallowClick = true;
      opened = t;
      t.click();
    },
    true,
  );
  // The release on the button itself would toggle the menu closed again: skip that one click.
  addEventListener(
    "click",
    (e) => {
      if (!swallowClick || !e.isTrusted) return;
      const t = (e.target as HTMLElement | null)?.closest("[data-slide-menu]");
      if (t && t === opened) {
        e.stopPropagation();
        e.preventDefault();
      }
      swallowClick = false;
    },
    true,
  );
  addEventListener(
    "pointermove",
    (e) => {
      if (!trigger) return;
      if (!sliding && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 8) return;
      sliding = true;
      setHot(itemAt(e.clientX, e.clientY));
    },
    true,
  );
  const end = (e: PointerEvent) => {
    if (!trigger) return;
    const chosen = sliding && e.type === "pointerup" ? itemAt(e.clientX, e.clientY) : null;
    setHot(null);
    trigger = null;
    // A tap (no slide) leaves the menu open; the next click event is the tap's own.
    if (!sliding) return;
    swallowClick = false;
    if (chosen) setTimeout(() => chosen.click(), 0);
  };
  addEventListener("pointerup", end, true);
  addEventListener("pointercancel", end, true);
}
