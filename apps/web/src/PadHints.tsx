import { useEffect, useState } from "react";
import { getLocale, he$ } from "./i18n";
import { api } from "./api";
import { toast } from "./library";
import { startGamepad } from "./gamepad";
import { consoleOn, markConsoleOffered, shouldOfferConsole } from "./console-mode";
import { switchConsole, watchGameWhileAway } from "./pages/ConsoleMode";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

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
  // A handheld was found: console mode is offered once (as Armoury Crate SE offers its full-screen launcher).
  const [offer, setOffer] = useState("");
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
    // View+Menu held: console mode on (its page turns it off). Not in the Game Helper's window over a game.
    const toConsole = () => {
      if (!location.hash.startsWith("#/game/")) switchConsole(true);
    };
    window.addEventListener("kesher:console", toConsole);
    if (consoleOn()) {
      watchGameWhileAway();
      // Console mode starts at its home (a link to a page still opens that page).
      if (!location.hash || location.hash === "#/" || location.hash === "#") location.hash = "#/console";
    }
    void api<{ model: string; handheld?: string }>("/api/system/device")
      .then((d) => {
        if (!d.handheld) return;
        document.documentElement.dataset.handheld = d.handheld;
        setHandheld(handheldSetting(), true);
        if (shouldOfferConsole(d.handheld)) setOffer(d.handheld);
        try {
          if (localStorage.getItem("kesher.handheld.told") === d.handheld) return;
          localStorage.setItem("kesher.handheld.told", d.handheld);
        } catch {
          /* told again next time */
        }
        toast(L(`זוהה ${d.handheld}: אפשר לשלוט עם השלט (A בחירה, B חזרה, Y חיפוש, LB/RB עמודים).`, `${d.handheld} found: the controller works (A choose, B back, Y search, LB/RB pages).`));
      })
      .catch(() => undefined);
    return () => {
      window.removeEventListener("kesher:pad", pad);
      window.removeEventListener("kesher:console", toConsole);
    };
  }, []);
  const answer = (yes: boolean) => {
    markConsoleOffered(offer);
    setOffer("");
    if (yes) switchConsole(true);
  };
  const offerCard = offer ? (
    <div className="console-offer" role="dialog" aria-label={L("מצב קונסולה", "Console mode")}>
      <p>{L(`זוהה ${offer}. לעבור למצב קונסולה עם כפתורים גדולים ועוזר משחק? (אפשר גם להחזיק ⧉+≡)`, `${offer} found. Switch to console mode, with big buttons and a game helper? (Or hold ⧉+≡)`)}</p>
      <div className="row">
        <button type="button" className="primary" onClick={() => answer(true)}>{L("למצב קונסולה", "Console mode")}</button>
        <button type="button" onClick={() => answer(false)}>{L("לא עכשיו", "Not now")}</button>
      </div>
    </div>
  ) : null;
  if (!on) return offerCard;
  const hint = (b: string, cls: string, text: string) => (
    <span className="pad-hint">
      <span className={`pad-btn ${cls}`} aria-hidden="true">{b}</span>
      {text}
    </span>
  );
  return (
    <>
    {offerCard}
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
      {hint("⧉+≡", "m", L("החזקה: קונסולה", "Hold: console"))}
      {hint("R3", "m", L("דיבור", "Speak"))}
      {hint("L3", "m", L("עצור", "Stop"))}
    </div>
    </>
  );
}
