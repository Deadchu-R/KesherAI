import { useEffect, useState, type ReactNode } from "react";
import { getLocale } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/**
 * A box that can fill the whole window (a graph to work on at full size) and
 * go back to its place. It covers the window rather than asking the browser
 * for full screen, so it works the same in the app, a browser and a phone.
 * Esc or the button returns it.
 */
export function Fullscreen(p: { children: ReactNode; className?: string; label?: string; hidden?: boolean }) {
  const [big, setBig] = useState(false);
  // On a phone or tablet the browser's own full screen is asked for too (no address bar), and the
  // screen may be turned: the box follows the new size (the graph fits again on its own).
  useEffect(() => {
    if (!big || !matchMedia("(pointer: coarse)").matches) return;
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) void el.requestFullscreen({ navigationUI: "hide" }).catch(() => undefined);
    const left = () => !document.fullscreenElement && setBig(false);
    document.addEventListener("fullscreenchange", left);
    return () => {
      document.removeEventListener("fullscreenchange", left);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, [big]);
  useEffect(() => {
    if (!big) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setBig(false);
    window.addEventListener("keydown", key);
    // The page under it does not scroll while it is open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", key);
      document.body.style.overflow = prev;
    };
  }, [big]);
  return (
    <div hidden={p.hidden} className={`fs-box${big ? " fs-on" : ""}${p.className ? ` ${p.className}` : ""}`} role={big ? "dialog" : undefined} aria-modal={big || undefined} aria-label={big ? p.label : undefined}>
      <button type="button" className="fs-toggle" onClick={() => setBig((b) => !b)} aria-pressed={big} title={big ? L("חזרה לגודל רגיל (Esc)", "Back to normal size (Esc)") : L("מסך מלא", "Full screen")}>
        {big ? L("⤡ סגור מסך מלא", "⤡ Exit full screen") : L("⤢ מסך מלא", "⤢ Full screen")}
      </button>
      {p.children}
    </div>
  );
}
