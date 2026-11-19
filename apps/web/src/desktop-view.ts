import { getLocale } from "./i18n";
import { toast } from "./library";

/**
 * The computer view on a phone (Roee, 2026-11-18: "a phone with a mouse connected can switch to the computer view"),
 * as Chrome's "Desktop site", Samsung DeX and iPadOS with a pointer do it (docs/RESEARCH_LOG.md "A phone with a mouse"):
 * the page is laid out 1280 px wide and the phone shows it scaled, so every screen is the computer's. "auto" switches
 * when a mouse or a touchpad is connected to a touch phone and back when it is gone; "computer" and "phone" stay.
 */
export type ViewChoice = "auto" | "computer" | "phone";
const KEY = "kesher-view";
const WIDE = 1280;
const mouse = typeof matchMedia === "function" ? matchMedia("(any-pointer: fine)") : undefined;
const touch = () => typeof navigator !== "undefined" && navigator.maxTouchPoints > 0;
let last: boolean | undefined;

/** The viewer's choice (kept on this device). */
export function viewChoice(): ViewChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "computer" || v === "phone" ? v : "auto";
  } catch {
    return "auto";
  }
}

/** Whether this device can show the choice at all: a touch screen narrower than the computer view. */
export const canChooseView = () => touch() && Math.min(screen.width, screen.height) < 900;

/** Whether the computer view is on now. */
export const computerView = () => {
  const c = viewChoice();
  return c === "computer" || (c === "auto" && canChooseView() && !!mouse?.matches);
};

/** Lays the page out for the current choice (the viewport's width) and says so when it changed by itself. */
function apply(said = false): void {
  const on = computerView();
  if (on === last) return;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (meta) meta.content = on ? `width=${WIDE}` : "width=device-width, initial-scale=1";
  if (said && last !== undefined) toast(on ? (getLocale() === "he" ? "🖱 עכבר חובר: תצוגת מחשב" : "🖱 Mouse connected: computer view") : getLocale() === "he" ? "תצוגת טלפון" : "Phone view");
  last = on;
  document.documentElement.toggleAttribute("data-computer-view", on);
}

/**
 * Sets the choice and lays the page out for it.
 *
 * @param c - auto, computer or phone.
 */
export function setViewChoice(c: ViewChoice): void {
  try {
    if (c === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, c);
  } catch {
    // Not kept (a private window): it still applies now.
  }
  apply();
}

/** Starts it: once at load, then whenever a mouse comes or goes. */
export function startDesktopView(): void {
  if (!canChooseView()) return;
  apply();
  mouse?.addEventListener("change", () => apply(true));
}
