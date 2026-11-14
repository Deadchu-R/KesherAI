import { useEffect, useState } from "react";
import { getLocale } from "./i18n";
import { api } from "./api";
import { toast } from "./library";
import { startGamepad } from "./gamepad";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/** Whether the handheld look is on: "auto" (on a handheld gaming PC), "on" or "off" (remembered on this device). */
export function handheldSetting(): "auto" | "on" | "off" {
  try {
    const v = localStorage.getItem("kesher.handheld");
    return v === "on" || v === "off" ? v : "auto";
  } catch {
    return "auto";
  }
}

/** Sets the handheld look (and applies it now). */
export function setHandheld(v: "auto" | "on" | "off", detected = !!document.documentElement.dataset.handheld): void {
  try {
    localStorage.setItem("kesher.handheld", v);
  } catch {
    /* for this visit only */
  }
  const on = v === "on" || (v === "auto" && detected);
  document.documentElement.classList.toggle("handheld", on);
  // The whole interface larger (most sizes are pixels), in the desktop app.
  (window as unknown as { kesherDesktop?: { setZoom?: (f: number) => void } }).kesherDesktop?.setZoom?.(on ? 1.25 : 1);
}

/**
 * Controller support for the whole app, and the handheld look: on a handheld gaming PC (ROG Ally, Steam Deck, Legion
 * Go…) the targets grow and it says the controller works; the button hints show along the bottom while a controller
 * is in use (as Steam Big Picture's footer).
 */
export function PadHints() {
  const [on, setOn] = useState(false);
  // Where the chosen control is, for the Ⓐ beside it (what A will press).
  const [at, setAt] = useState<{ x: number; y: number; label: string } | null>(null);
  useEffect(() => {
    if (!on) return setAt(null);
    const place = () => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return setAt(null);
      const r = el.getBoundingClientRect();
      const field = el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !["button", "checkbox", "radio", "submit"].includes(el.type));
      setAt({ x: Math.min(innerWidth - 90, r.right - 4), y: Math.max(4, r.top - 14), label: field ? L("שליחה", "Send") : L("בחירה", "Choose") });
    };
    place();
    window.addEventListener("focusin", place);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("focusin", place);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [on]);
  useEffect(() => {
    startGamepad();
    const pad = (e: Event) => setOn(!!(e as CustomEvent<boolean>).detail);
    window.addEventListener("kesher:pad", pad);
    void api<{ model: string; handheld?: string }>("/api/system/device")
      .then((d) => {
        if (!d.handheld) return;
        document.documentElement.dataset.handheld = d.handheld;
        setHandheld(handheldSetting(), true);
        try {
          if (localStorage.getItem("kesher.handheld.told") === d.handheld) return;
          localStorage.setItem("kesher.handheld.told", d.handheld);
        } catch {
          /* told again next time */
        }
        toast(L(`זוהה ${d.handheld}: אפשר לשלוט עם השלט (A בחירה, B חזרה, Y חיפוש, LB/RB עמודים).`, `${d.handheld} found: the controller works (A choose, B back, Y search, LB/RB pages).`));
      })
      .catch(() => undefined);
    return () => window.removeEventListener("kesher:pad", pad);
  }, []);
  if (!on) return null;
  const hint = (b: string, cls: string, text: string) => (
    <span className="pad-hint">
      <span className={`pad-btn ${cls}`} aria-hidden="true">{b}</span>
      {text}
    </span>
  );
  return (
    <>
    {at && (
      <span className="pad-focus-badge" style={{ left: at.x, top: at.y }} aria-hidden="true">
        <span className="pad-btn a">A</span>
        {at.label}
      </span>
    )}
    <div className="pad-hints" role="note" aria-label={L("כפתורי השלט", "Controller buttons")}>
      {hint("A", "a", L("בחירה", "Choose"))}
      {hint("B", "b", L("חזרה", "Back"))}
      {hint("X", "x", L("עוד", "More"))}
      {hint("Y", "y", L("חיפוש", "Search"))}
      {hint("LB RB", "lr", L("עמודים", "Pages"))}
      {hint("≡", "m", L("תפריט", "Menu"))}
      {hint("⧉", "m", L("לתיבת הצ'אט", "Chat box"))}
    </div>
    </>
  );
}
