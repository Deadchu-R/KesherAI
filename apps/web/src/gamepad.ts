/**
 * The whole interface with a game controller (the ROG Ally's, an Xbox pad, a Steam Deck's), as Steam Big Picture and
 * the Xbox app work:
 * - D-pad or left stick: move between buttons, links and fields (to the nearest one in that direction);
 * - A: press · B: back (closes a menu or dialog, otherwise the previous page) · X: right-click (more options);
 * - Y: search and commands (the palette) · LB / RB: previous / next page of the menu;
 * - Menu (≡): open or close the side menu · View (⧉): to the chat box;
 * - right stick: scroll · LT / RT: a page up / down;
 * - right stick pressed (R3): the microphone (speak the message instead of typing it; press again to finish);
 * - left stick pressed (L3): stop (the answer being written, or the reading aloud).
 * Read with the browser's Gamepad API (standard mapping), only while a controller is connected; the mouse, touch and
 * keyboard work as before, and the controller's look (a bold focus ring, the button hints) shows only after it is used.
 */
import { openPadKeyboard, padKeyboardButton, padKeyboardOpen } from "./pad-keyboard";

const A = 0, B = 1, X = 2, Y = 3, LB = 4, RB = 5, LT = 6, RT = 7, VIEW = 8, MENU = 9, L3 = 10, R3 = 11, UP = 12, DOWN = 13, LEFT = 14, RIGHT = 15;
const FIRST_REPEAT = 380;
const REPEAT = 110;
const DEAD = 0.5;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"], summary';

/**
 * The areas focus stays inside (as Norigin's focus boundaries and YouTube TV's rows): the side menu, the top bar, the
 * page, a dialog. Arrows move within the area first and cross to the next one only at its edge (found on Roee's ROG
 * Ally: one press jumped to "unrelated things" in another part of the screen).
 */
const AREAS = '[role="dialog"], .palette, .sidebar, .appbar, .phone-tabs, .script-side, .game-head, .game-asks, .game-chat, main, .main';

/** The last control chosen in each area (coming back to an area returns there, as Steam and the Xbox app do). */
const lastIn = new WeakMap<Element, HTMLElement>();
const areaOf = (el: Element): Element => el.closest(AREAS) ?? document.body;

/** Shown at all (not display:none, hidden, faded out or zero-sized); off-screen is fine: the view follows. */
function rendered(el: HTMLElement): boolean {
  if (!el.getClientRects().length) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  const st = getComputedStyle(el);
  return st.visibility !== "hidden" && Number(st.opacity) > 0.05;
}

/** Elements a controller can reach: rendered, not inert, inside the top dialog when one is open. */
function reachable(): HTMLElement[] {
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"], dialog[open], .palette-back, .modal-back')].filter(rendered);
  const root: ParentNode = dialogs.at(-1) ?? document;
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
    if (!rendered(el) || el.closest("[inert], [aria-hidden='true']")) return false;
    // A whole region that takes focus (a message list, a canvas) is not a button to land on.
    const r = el.getBoundingClientRect();
    return !(r.height > innerHeight * 0.7 && r.width > innerWidth * 0.5) || el.matches("textarea, input");
  });
}

/**
 * The nearest element in a direction from a box (as spatial navigation on TVs and consoles): only candidates ahead of
 * the box's edge; scored by the gap along the direction plus twice the offset to the side, and those in the same
 * row or column (overlapping on the other axis) win over diagonal ones.
 *
 * @param from - The current box.
 * @param boxes - The candidates' boxes.
 * @param dir - Where to go.
 * @returns The index of the chosen box, or -1.
 */
export function nearest(from: { x: number; y: number; w: number; h: number }, boxes: Array<{ x: number; y: number; w: number; h: number }>, dir: "up" | "down" | "left" | "right"): number {
  const vertical = dir === "up" || dir === "down";
  let best = -1;
  let score = Infinity;
  boxes.forEach((b, i) => {
    // The gap along the direction, from edge to edge (a little overlap allowed: rows of uneven height).
    const gap = dir === "down" ? b.y - (from.y + from.h) : dir === "up" ? from.y - (b.y + b.h) : dir === "right" ? b.x - (from.x + from.w) : from.x - (b.x + b.w);
    const size = vertical ? Math.min(from.h, b.h) : Math.min(from.w, b.w);
    if (gap < -size * 0.5) return;
    // The centre must also be ahead (not a box beside this one that reaches past it).
    const ahead = dir === "down" ? b.y + b.h / 2 > from.y + from.h / 2 : dir === "up" ? b.y + b.h / 2 < from.y + from.h / 2 : dir === "right" ? b.x + b.w / 2 > from.x + from.w / 2 : b.x + b.w / 2 < from.x + from.w / 2;
    if (!ahead) return;
    const overlap = vertical ? Math.min(from.x + from.w, b.x + b.w) - Math.max(from.x, b.x) : Math.min(from.y + from.h, b.y + b.h) - Math.max(from.y, b.y);
    const side = overlap > 0 ? 0 : -overlap;
    const s = Math.max(0, gap) + side * 2 + (overlap > 0 ? 0 : 40);
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
  // The view follows: an element out of sight comes to the middle, one in sight only as far as needed.
  const r = el.getBoundingClientRect();
  const view = scroller(el).getBoundingClientRect();
  const out = r.bottom < Math.max(0, view.top) || r.top > Math.min(innerHeight, view.bottom);
  el.scrollIntoView({ block: out ? "center" : "nearest", inline: "nearest", behavior: "smooth" });
}

/** Whether typing goes into the focused element (arrows move the text cursor there, not the focus). */
const typing = (el: Element | null) => !!el && (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !["button", "checkbox", "radio", "range", "submit", "reset", "color", "file"].includes(el.type)) || (el as HTMLElement).isContentEditable);

/** In a text box, whether the caret is on its first (or last) line, where up (or down) leaves the box. */
function atEdge(el: HTMLElement, dir: "up" | "down"): boolean {
  if (!(el instanceof HTMLTextAreaElement)) return true;
  const at = el.selectionStart ?? 0;
  return dir === "up" ? !el.value.slice(0, at).includes("\n") : !el.value.slice(at).includes("\n");
}

function move(dir: "up" | "down" | "left" | "right"): void {
  const now = document.activeElement as HTMLElement | null;
  const all = reachable();
  if (!now || now === document.body || !all.includes(now)) {
    // Nothing chosen yet: the last place in the page, else the page's first control in sight (else the first).
    const main = document.querySelector("main, .main");
    const back = main ? lastIn.get(main) : undefined;
    const first = (back && all.includes(back) ? back : undefined) ?? all.find((el) => main?.contains(el) && el.getBoundingClientRect().top >= 0 && el.getBoundingClientRect().top < innerHeight) ?? all[0];
    if (first) focus(first);
    return;
  }
  // In a text field the sides move the text cursor, and up/down leave it only from its first/last line.
  if (typing(now) && (dir === "left" || dir === "right" || !atEdge(now, dir))) return;
  const vertical = dir === "up" || dir === "down";
  const from = boxOf(now);
  const others = all.filter((el) => el !== now && !now.contains(el) && !el.contains(now));
  const area = areaOf(now);
  // 1. Within this area.
  const here = others.filter((el) => areaOf(el) === area);
  const i = nearest(from, here.map(boxOf), dir);
  if (i >= 0) {
    const target = here[i]!;
    // Long text with no buttons in it (an answer): read it a page at a time, not jump past it.
    const sc = scroller(now);
    const viewH = Math.min(innerHeight, sc.getBoundingClientRect().height || innerHeight);
    const gap = dir === "down" ? boxOf(target).y - (from.y + from.h) : dir === "up" ? from.y - (boxOf(target).y + boxOf(target).h) : 0;
    if (vertical && gap > viewH * 0.75 && canScroll(sc, dir)) {
      sc.scrollBy({ top: (dir === "down" ? 1 : -1) * viewH * 0.6, behavior: "smooth" });
      return;
    }
    focus(target);
    return;
  }
  // 2. At the area's edge: more of it to scroll first, then the next area (back to where it was left).
  const sc = scroller(now);
  if (vertical && canScroll(sc, dir) && sc !== document.scrollingElement) {
    sc.scrollBy({ top: (dir === "down" ? 1 : -1) * Math.min(innerHeight, sc.clientHeight) * 0.6, behavior: "smooth" });
    return;
  }
  const away = others.filter((el) => areaOf(el) !== area);
  const j = nearest(from, away.map(boxOf), dir);
  if (j < 0) return;
  const next = away[j]!;
  const remembered = lastIn.get(areaOf(next));
  focus(remembered && all.includes(remembered) ? remembered : next);
}

/** Whether a scrolling element has more to show in a direction. */
function canScroll(el: Element, dir: "up" | "down" | "left" | "right"): boolean {
  if (dir === "up") return el.scrollTop > 1;
  if (dir === "down") return el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  return false;
}

const scrolls = (e: Element) => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 2;

/** The element that scrolls around `el`, or the page's biggest scrolling area (a chat's messages). */
function scroller(el: Element | null): Element {
  for (let e = el; e && e !== document.body; e = e.parentElement) if (scrolls(e)) return e;
  return mainScroller();
}

let mainCache: { el: Element; at: number } | undefined;

/**
 * The biggest scrolling area in sight (the page's content), for scrolling without a chosen control. Kept for a
 * second (scan 63: the right stick asks every frame, and looking costs a style read per element on the page).
 */
function mainScroller(): Element {
  if (mainCache && performance.now() - mainCache.at < 1000 && mainCache.el.isConnected) return mainCache.el;
  const el = findMainScroller();
  mainCache = { el, at: performance.now() };
  return el;
}

function findMainScroller(): Element {
  let best: Element | undefined;
  let area = 0;
  for (const e of document.querySelectorAll("main *, .main *, .game-chat *, main, .main")) {
    if (!scrolls(e)) continue;
    const r = e.getBoundingClientRect();
    const a = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) * r.width;
    if (a > area) {
      area = a;
      best = e;
    }
  }
  return best ?? document.scrollingElement ?? document.documentElement;
}

function scrollNear(el: Element | null, by: number): void {
  // The right stick and LT/RT scroll what the chosen control is in, or the page's content.
  const sc = el && el !== document.body ? scroller(el) : mainScroller();
  sc.scrollBy({ top: by });
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
    // A field other than the chat box (search, settings, names): the controller's own keyboard. The chat box keeps A
    // as send (its microphone is R3).
    if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !el.closest(".composer") && !el.readOnly) {
      openPadKeyboard(el);
      return;
    }
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

/**
 * The node graph (Blueprints, the C# graph) takes the controller while it has focus: true when it did. For "back",
 * false also when the graph let go (B with nothing chosen), so the controller moves on from it.
 */
function canvasTakes(detail: { action: "dir" | "pan" | "zoom" | "back"; dir?: "up" | "down" | "left" | "right"; dx?: number; dy?: number; factor?: number }): boolean {
  if (!(document.activeElement as HTMLElement | null)?.closest?.(".ue-frame")) return false;
  const e = new CustomEvent("kesher:pad-canvas", { detail, cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented && !(e as CustomEvent & { leave?: boolean }).leave;
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
      if (target && (target.closest(OWN_ARROWS) || (typing(target) && (dir === "left" || dir === "right" || !atEdge(target, dir))))) return;
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
  // The last control chosen in each area, kept as focus moves (by controller, mouse or touch).
  window.addEventListener("focusin", (e) => {
    const el = e.target as HTMLElement | null;
    if (el && el !== document.body) lastIn.set(areaOf(el), el);
  });
  keyboardNav();
  if (typeof navigator.getGamepads !== "function") return;
  const held = new Map<number, { since: number; last: number }>();
  let frame = 0;
  const off = () => setActive(false);
  window.addEventListener("pointerdown", off, true);
  // The mouse moved on purpose (not a nudge): pointer mode, as TV apps switch between remote and pointer.
  window.addEventListener("mousemove", (e) => {
    if (Math.abs(e.movementX) + Math.abs(e.movementY) > 6) off();
  }, { passive: true });
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
    // The on-screen keyboard, while open, takes every button.
    if (padKeyboardOpen()) {
      act(UP, true, () => padKeyboardButton("up"));
      act(DOWN, true, () => padKeyboardButton("down"));
      act(LEFT, true, () => padKeyboardButton("left"));
      act(RIGHT, true, () => padKeyboardButton("right"));
      for (const [i, name] of [[A, "A"], [B, "B"], [X, "X"], [Y, "Y"], [LB, "LB"], [RB, "RB"], [MENU, "MENU"]] as Array<[number, string]>) act(i, i === X, () => padKeyboardButton(name));
      frame = requestAnimationFrame(loop);
      return;
    }
    act(UP, true, () => canvasTakes({ action: "dir", dir: "up" }) || move("up"));
    act(DOWN, true, () => canvasTakes({ action: "dir", dir: "down" }) || move("down"));
    act(LEFT, true, () => canvasTakes({ action: "dir", dir: "left" }) || move("left"));
    act(RIGHT, true, () => canvasTakes({ action: "dir", dir: "right" }) || move("right"));
    act(A, false, press);
    act(B, false, () => pageTakes("B") || canvasTakes({ action: "back" }) || ((document.activeElement as HTMLElement | null)?.closest?.(".ue-frame") ? move("down") : back()));
    act(X, false, () => pageTakes("X") || context());
    act(Y, false, () => pageTakes("Y") || window.dispatchEvent(new Event("kesher:palette")));
    act(LB, false, () => pageTakes("LB") || page(-1));
    act(RB, false, () => pageTakes("RB") || page(1));
    act(MENU, false, () => window.dispatchEvent(new Event("kesher:sidebar")));
    act(VIEW, false, () => {
      const box = document.querySelector<HTMLElement>("main textarea, main input[type='text']");
      if (box) focus(box);
    });
    // Writing without a keyboard: R3 is the chat box's microphone (dictation), L3 stops the answer or the voice.
    act(R3, false, () => document.querySelector<HTMLElement>("main .box-bar .chip.mic")?.click());
    act(L3, false, () => document.querySelector<HTMLElement>("main .send.stop, button.stop-speaking")?.click());
    act(LT, true, () => canvasTakes({ action: "zoom", factor: 0.85 }) || scrollNear(document.activeElement, -innerHeight * 0.8));
    act(RT, true, () => canvasTakes({ action: "zoom", factor: 1.18 }) || scrollNear(document.activeElement, innerHeight * 0.8));
    // The right stick scrolls smoothly, faster the further it is pushed.
    const rx = ax(2);
    const ry = ax(3);
    if (Math.abs(rx) > 0.2 || Math.abs(ry) > 0.2) {
      used = true;
      // On the graph the right stick pans it; elsewhere it scrolls.
      const sx = Math.abs(rx) > 0.2 ? rx * Math.abs(rx) * 22 : 0;
      const sy = Math.abs(ry) > 0.2 ? ry * Math.abs(ry) * 22 : 0;
      if (!canvasTakes({ action: "pan", dx: sx, dy: sy }) && sy) scrollNear(document.activeElement, sy * 1.3);
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
