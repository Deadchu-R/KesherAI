/**
 * The whole interface with a game controller (the ROG Ally's, an Xbox pad, a Steam Deck's), as Steam Big Picture and
 * the Xbox app work:
 * - D-pad or left stick: move between buttons, links and fields (to the nearest one in that direction);
 * - A: press · B: back (closes a menu or dialog, otherwise the previous page) · X: right-click (more options);
 * - Y: search and commands (the palette) · LB / RB: previous / next page of the menu;
 * - Menu (≡): open or close the side menu · View (⧉): to the chat box;
 * - right stick: scroll · LT / RT: a page up / down.
 * Read with the browser's Gamepad API (standard mapping), only while a controller is connected; the mouse, touch and
 * keyboard work as before, and the controller's look (a bold focus ring, the button hints) shows only after it is used.
 */

const A = 0, B = 1, X = 2, Y = 3, LB = 4, RB = 5, LT = 6, RT = 7, VIEW = 8, MENU = 9, UP = 12, DOWN = 13, LEFT = 14, RIGHT = 15;
const FIRST_REPEAT = 380;
const REPEAT = 110;
const DEAD = 0.5;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"], summary';

/** Elements a controller can reach: shown, not inert, inside the top dialog when one is open. */
function reachable(): HTMLElement[] {
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"], dialog[open], .palette-back, .modal-back')].filter(visible);
  const root: ParentNode = dialogs.at(-1) ?? document;
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => visible(el) && !el.closest("[inert], [aria-hidden='true']"));
}

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
  const st = getComputedStyle(el);
  return st.visibility !== "hidden" && st.display !== "none" && Number(st.opacity) > 0.05;
}

/**
 * The nearest element in a direction from a box (as spatial navigation on TVs and consoles): candidates ahead of the
 * box, scored by distance along the direction plus a penalty for being off to the side.
 *
 * @param from - The current box.
 * @param boxes - The candidates' boxes.
 * @param dir - Where to go.
 * @returns The index of the chosen box, or -1.
 */
export function nearest(from: { x: number; y: number; w: number; h: number }, boxes: Array<{ x: number; y: number; w: number; h: number }>, dir: "up" | "down" | "left" | "right"): number {
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  let best = -1;
  let score = Infinity;
  boxes.forEach((b, i) => {
    const bx = b.x + b.w / 2;
    const by = b.y + b.h / 2;
    let along: number;
    let side: number;
    if (dir === "down") {
      along = b.y - (from.y + from.h) + b.h / 2;
      side = Math.max(0, Math.abs(bx - cx) - (from.w + b.w) / 2);
      if (by <= cy + 1) return;
    } else if (dir === "up") {
      along = from.y - (b.y + b.h) + b.h / 2;
      side = Math.max(0, Math.abs(bx - cx) - (from.w + b.w) / 2);
      if (by >= cy - 1) return;
    } else if (dir === "right") {
      along = b.x - (from.x + from.w) + b.w / 2;
      side = Math.max(0, Math.abs(by - cy) - (from.h + b.h) / 2);
      if (bx <= cx + 1) return;
    } else {
      along = from.x - (b.x + b.w) + b.w / 2;
      side = Math.max(0, Math.abs(by - cy) - (from.h + b.h) / 2);
      if (bx >= cx - 1) return;
    }
    const s = Math.max(0, along) + side * 3;
    if (s < score) {
      score = s;
      best = i;
    }
  });
  return best;
}

const boxOf = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};

function focus(el: HTMLElement): void {
  (el.focus as (o?: FocusOptions & { focusVisible?: boolean }) => void)({ preventScroll: true, focusVisible: true });
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** Whether typing goes into the focused element (arrows move the text cursor there, not the focus). */
const typing = (el: Element | null) => !!el && (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !["button", "checkbox", "radio", "range", "submit", "reset", "color", "file"].includes(el.type)) || (el as HTMLElement).isContentEditable);

function move(dir: "up" | "down" | "left" | "right"): void {
  const now = document.activeElement as HTMLElement | null;
  const all = reachable();
  if (!now || now === document.body || !all.includes(now)) {
    // Nothing chosen yet: the main area's first control (or the first anywhere).
    const first = all.find((el) => el.closest("main")) ?? all[0];
    if (first) focus(first);
    return;
  }
  // In a text field the sides move the text cursor.
  if (typing(now) && (dir === "left" || dir === "right")) return;
  const others = all.filter((el) => el !== now && !now.contains(el));
  const i = nearest(boxOf(now), others.map(boxOf), dir);
  if (i >= 0) focus(others[i]!);
  else if (dir === "up" || dir === "down") scrollNear(now, dir === "down" ? 240 : -240);
}

/** The element that scrolls around `el` (or the page). */
function scroller(el: Element | null): Element {
  for (let e = el; e && e !== document.body; e = e.parentElement) {
    const st = getComputedStyle(e);
    if (/(auto|scroll)/.test(st.overflowY) && e.scrollHeight > e.clientHeight + 2) return e;
  }
  return document.querySelector(".main") ?? document.scrollingElement ?? document.documentElement;
}

function scrollNear(el: Element | null, by: number): void {
  scroller(el).scrollBy({ top: by });
}

function key(k: string): boolean {
  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e.defaultPrevented;
}

function back(): void {
  // Escape first (menus, dialogs, the palette close on it); otherwise the previous page.
  const before = location.hash;
  const handled = key("Escape");
  const dialogOpen = document.querySelector('[role="dialog"], .palette-back');
  if (!handled && !dialogOpen && location.hash === before) history.back();
}

function press(): void {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return move("down");
  if (typing(el)) {
    // In a field A sends what was typed (Enter), as a chat's send.
    key("Enter");
    return;
  }
  el.click();
}

function context(): void {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return;
  const b = boxOf(el);
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: b.x + b.w / 2, clientY: b.y + b.h / 2, button: 2 }));
}

/** The menu's pages in order (the side menu's links), for LB / RB. */
function page(by: -1 | 1): void {
  const links = [...document.querySelectorAll<HTMLAnchorElement>(".sidebar a[href^='#/']")];
  const hrefs = [...new Set(links.map((a) => a.getAttribute("href")!))];
  if (!hrefs.length) return;
  const at = hrefs.findIndex((h) => location.hash === h || location.hash.startsWith(`${h}/`));
  location.hash = hrefs[(at + by + hrefs.length) % hrefs.length]!;
}

/** Whether a controller was the last thing used (the controller's look shows). */
function setActive(on: boolean): void {
  document.documentElement.classList.toggle("pad", on);
  window.dispatchEvent(new CustomEvent("kesher:pad", { detail: on }));
}

/** Lets the page take a button first (the Game Helper's questions); true when it did. */
function pageTakes(button: string): boolean {
  const e = new CustomEvent("kesher:pad-button", { detail: button, cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
}

let running = false;

/** Places where the arrow keys already mean something (lists, menus, editors, graphs, sliders). */
const OWN_ARROWS = '[role="listbox"], [role="menu"], [role="tablist"], [role="slider"], [role="grid"], [role="tree"], select, .monaco-editor, .script-canvas, .ue-frame, .xterm, input[type="range"]';

/**
 * The same navigation from the keyboard's arrows, on a handheld (or once a controller was used): a ROG Ally in
 * Armoury Crate's Desktop mode sends its D-pad as arrow keys and A as Enter, not as a controller (found on Roee's
 * ROG Xbox Ally X: "the controller does not work"). Enter presses a button by itself; Esc goes back.
 */
function keyboardNav(): void {
  window.addEventListener("keydown", (e) => {
    const html = document.documentElement;
    if (!html.classList.contains("handheld") && !html.classList.contains("pad")) return;
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target as HTMLElement | null;
    const dirs: Record<string, "up" | "down" | "left" | "right"> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
    const dir = dirs[e.key];
    if (dir) {
      if (target && (target.closest(OWN_ARROWS) || (typing(target) && (dir === "left" || dir === "right" || target instanceof HTMLTextAreaElement)))) return;
      e.preventDefault();
      move(dir);
      return;
    }
    if (e.key === "Escape" && !document.querySelector('[role="dialog"], .palette-back') && !typing(target)) {
      // Nothing closed on Esc: the previous page (as B).
      if (!pageTakes("B")) history.back();
    }
  });
}

/** Starts reading controllers (once); safe to call more than once. */
export function startGamepad(): void {
  if (running) return;
  running = true;
  keyboardNav();
  if (typeof navigator.getGamepads !== "function") return;
  const held = new Map<number, { since: number; last: number }>();
  let frame = 0;
  const off = () => setActive(false);
  window.addEventListener("pointerdown", off, true);
  window.addEventListener("wheel", off, { passive: true, capture: true });

  const loop = (t: number) => {
    frame = 0;
    const pad = [...navigator.getGamepads()].find((p): p is Gamepad => !!p && p.connected);
    if (!pad) return;
    const down = (i: number) => !!pad.buttons[i]?.pressed;
    const ax = (i: number) => pad.axes[i] ?? 0;
    // The stick counts as the D-pad.
    const dir = { [UP]: down(UP) || ax(1) < -DEAD, [DOWN]: down(DOWN) || ax(1) > DEAD, [LEFT]: down(LEFT) || ax(0) < -DEAD, [RIGHT]: down(RIGHT) || ax(0) > DEAD } as Record<number, boolean>;
    const isDown = (i: number) => (i in dir ? dir[i]! : down(i));
    const fire = (i: number, repeat: boolean): boolean => {
      if (!isDown(i)) {
        held.delete(i);
        return false;
      }
      const h = held.get(i);
      if (!h) {
        held.set(i, { since: t, last: t });
        return true;
      }
      if (repeat && t - h.since > FIRST_REPEAT && t - h.last > REPEAT) {
        h.last = t;
        return true;
      }
      return false;
    };
    let used = false;
    const act = (i: number, repeat: boolean, f: () => void) => {
      if (fire(i, repeat)) {
        used = true;
        f();
      }
    };
    act(UP, true, () => move("up"));
    act(DOWN, true, () => move("down"));
    act(LEFT, true, () => move("left"));
    act(RIGHT, true, () => move("right"));
    act(A, false, press);
    act(B, false, () => pageTakes("B") || back());
    act(X, false, () => pageTakes("X") || context());
    act(Y, false, () => pageTakes("Y") || window.dispatchEvent(new Event("kesher:palette")));
    act(LB, false, () => pageTakes("LB") || page(-1));
    act(RB, false, () => pageTakes("RB") || page(1));
    act(MENU, false, () => window.dispatchEvent(new Event("kesher:sidebar")));
    act(VIEW, false, () => {
      const box = document.querySelector<HTMLElement>("main textarea, main input[type='text']");
      if (box) focus(box);
    });
    act(LT, true, () => scrollNear(document.activeElement, -innerHeight * 0.8));
    act(RT, true, () => scrollNear(document.activeElement, innerHeight * 0.8));
    // The right stick scrolls smoothly, faster the further it is pushed.
    const ry = ax(3);
    if (Math.abs(ry) > 0.2) {
      used = true;
      scrollNear(document.activeElement, ry * ry * Math.sign(ry) * 28);
    }
    if (used && !document.documentElement.classList.contains("pad")) setActive(true);
    frame = requestAnimationFrame(loop);
  };
  const start = () => {
    if (!frame) frame = requestAnimationFrame(loop);
  };
  window.addEventListener("gamepadconnected", start);
  // A controller connected before the page loaded shows up on its first button press.
  window.addEventListener("focus", start);
  start();
}
