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

  // Sliding to the top or bottom edge of a long menu scrolls it, like Apple's menus.
  let edge: { menu: HTMLElement; speed: number } | null = null;
  let raf = 0;
  const scrollLoop = () => {
    raf = 0;
    if (!edge || !trigger) return;
    edge.menu.scrollTop += edge.speed;
    setHot(itemAt(last.x, last.y));
    raf = requestAnimationFrame(scrollLoop);
  };
  let last = { x: 0, y: 0 };
  const scrollableMenu = (x: number): HTMLElement | null => {
    for (const m of document.querySelectorAll<HTMLElement>(MENUS)) {
      const r = m.getBoundingClientRect();
      if (x >= r.left && x <= r.right && m.scrollHeight > m.clientHeight + 2) return m;
    }
    return null;
  };
  const followEdge = (x: number, y: number) => {
    const menu = scrollableMenu(x);
    edge = null;
    if (menu) {
      const r = menu.getBoundingClientRect();
      const zone = Math.min(56, r.height / 4);
      // Faster the closer to (or past) the edge.
      if (y < r.top + zone) edge = { menu, speed: -Math.ceil(Math.min(1, (r.top + zone - y) / zone) * 14) };
      else if (y > r.bottom - zone) edge = { menu, speed: Math.ceil(Math.min(1, (y - (r.bottom - zone)) / zone) * 14) };
    }
    if (edge && !raf) raf = requestAnimationFrame(scrollLoop);
  };

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
      last = { x: e.clientX, y: e.clientY };
      setHot(itemAt(e.clientX, e.clientY));
      followEdge(e.clientX, e.clientY);
    },
    true,
  );
  const end = (e: PointerEvent) => {
    if (!trigger) return;
    const chosen = sliding && e.type === "pointerup" ? itemAt(e.clientX, e.clientY) : null;
    setHot(null);
    trigger = null;
    edge = null;
    // A tap (no slide) leaves the menu open; the next click event is the tap's own.
    if (!sliding) return;
    swallowClick = false;
    if (chosen) setTimeout(() => chosen.click(), 0);
  };
  addEventListener("pointerup", end, true);
  addEventListener("pointercancel", end, true);

  // Bars ([data-slide-bar], the phone's bottom bar): press, slide across the buttons (the one under
  // the finger lights up), and only lifting the finger chooses — like Apple's tab bars.
  let bar: HTMLElement | null = null;
  let barSwallow = false;
  const barItemAt = (x: number, y: number): HTMLElement | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    return bar && el && bar.contains(el) ? (el.closest(ITEMS) as HTMLElement | null) : null;
  };
  addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 0) return;
      const b = (e.target as HTMLElement | null)?.closest("[data-slide-bar]") as HTMLElement | null;
      if (!b) return;
      bar = b;
      barSwallow = true;
      setHot(barItemAt(e.clientX, e.clientY));
    },
    true,
  );
  addEventListener(
    "pointermove",
    (e) => {
      if (bar) setHot(barItemAt(e.clientX, e.clientY));
    },
    true,
  );
  const barEnd = (e: PointerEvent) => {
    if (!bar) return;
    const chosen = e.type === "pointerup" ? barItemAt(e.clientX, e.clientY) : null;
    setHot(null);
    bar = null;
    if (chosen) setTimeout(() => chosen.click(), 0);
  };
  addEventListener("pointerup", barEnd, true);
  addEventListener("pointercancel", barEnd, true);
  // The browser's own click (on press-and-release of one button) is replaced by the one above.
  addEventListener(
    "click",
    (e) => {
      if (!barSwallow || !e.isTrusted) return;
      if ((e.target as HTMLElement | null)?.closest("[data-slide-bar]")) {
        e.preventDefault();
        e.stopPropagation();
      }
      barSwallow = false;
    },
    true,
  );
}
