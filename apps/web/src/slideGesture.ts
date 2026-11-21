/**
 * The decisions behind press-and-slide menus (slideMenus.ts), kept apart from the DOM so they can be tested:
 * one press on a menu button is one gesture, and one gesture toggles the menu exactly once.
 *
 * Why this matters on phones: the menu opens on the press (so the finger can slide into it), and on a 390 px
 * phone it opens as a sheet over the composer, right under the finger. The browser's own click for that tap
 * comes after the finger lifts and lands on whatever is under it by then: the button (a second toggle, which
 * closed the menu at once) or a menu item (chosen without the user meaning it). So the gesture owns its click,
 * whatever its target, and the browser's one is swallowed.
 */

/** A point on the screen, in CSS pixels. */
export interface Point {
  x: number;
  y: number;
}

/** How far (px) the pointer must move before a press counts as a slide, not a tap. */
export const SLIDE_SLOP = 8;
/** How long (ms) after the lift the browser's click for the gesture may still arrive. */
export const CLICK_WINDOW = 800;

/** What to do when the pointer lifts. */
export interface LiftResult {
  /** The pointer slid: choose the item under it (if any). Otherwise it was a tap and the menu stays open. */
  slid: boolean;
}

/**
 * One press-and-slide gesture at a time. The caller feeds it the pointer events and asks it whether a click
 * belongs to the gesture (and must be swallowed).
 *
 * @example
 * const g = new SlideGesture();
 * g.down({ x: 10, y: 10 }, button, 0); // open the menu now
 * g.lift(120);                         // a tap: the menu stays open
 * g.swallowClick(true, 130);           // true: the browser's click for the tap is not a second toggle
 */
export class SlideGesture {
  private start: Point | null = null;
  private sliding = false;
  /** Until when the gesture's own click is swallowed (0: no gesture waiting for its click). */
  private swallowUntil = 0;
  /** The button that opened the menu, while the pointer is down. */
  trigger: unknown = null;

  /** Whether a pointer is down on a menu button. */
  get active(): boolean {
    return this.trigger !== null;
  }

  /** Whether the pointer has moved far enough to be sliding over the items. */
  get isSliding(): boolean {
    return this.sliding;
  }

  /**
   * Any pointer went down anywhere (call it before `down`). A new press starts a new gesture, so a click the
   * last gesture was still waiting for (none came: a finger that slid gets no click) is no longer swallowed.
   */
  press(): void {
    this.swallowUntil = 0;
  }

  /**
   * The pointer went down on a menu button: the menu toggles now (the caller clicks the button once).
   * @param at Where the pointer went down.
   * @param trigger The menu button (any object; compared by identity).
   * @param now The event time (ms).
   */
  down(at: Point, trigger: unknown, now: number): void {
    this.start = at;
    this.trigger = trigger;
    this.sliding = false;
    // The browser's click comes after the lift; until then (and a little after) it belongs to this gesture.
    this.swallowUntil = now + 60_000;
  }

  /**
   * The pointer moved.
   * @param at Where it is now.
   * @returns Whether it is sliding (only then the item under it lights up).
   */
  move(at: Point): boolean {
    if (!this.start || this.trigger === null) return false;
    if (!this.sliding && Math.hypot(at.x - this.start.x, at.y - this.start.y) < SLIDE_SLOP) return false;
    this.sliding = true;
    return true;
  }

  /**
   * The pointer lifted (or was cancelled). Either way the browser's click for this gesture, if it comes, is
   * swallowed: after a tap it would be a second toggle (or hit the menu that opened under the finger), and
   * after a slide the chosen item is clicked by the caller instead.
   * @param now The event time (ms).
   * @returns Whether the pointer slid.
   */
  lift(now: number): LiftResult {
    const slid = this.sliding;
    this.trigger = null;
    this.start = null;
    this.sliding = false;
    this.swallowUntil = now + CLICK_WINDOW;
    return { slid };
  }

  /**
   * Asks whether a click is the browser's own click for the last gesture (swallow it). Answers true at most
   * once per gesture. Clicks made by code (not trusted: the menu opening, a chosen item) and keyboard clicks
   * (no gesture before them) are never swallowed.
   * @param trusted The event's `isTrusted`.
   * @param now The event time (ms).
   */
  swallowClick(trusted: boolean, now: number): boolean {
    if (!trusted || !this.swallowUntil) return false;
    const mine = now <= this.swallowUntil;
    this.swallowUntil = 0;
    return mine;
  }
}
