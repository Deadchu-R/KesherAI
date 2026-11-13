import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * A top-bar button that opens a small panel under it (the bell, the design assistant), the way notification
 * centers work in GitHub, Linear and Slack: it opens on demand, closes on a click outside or Escape, and gives
 * the focus back to its button. On a phone the panel spans the screen under the bar.
 *
 * @param p.icon - What the button shows.
 * @param p.label - Its name, for screen readers and the tooltip.
 * @param p.className - Extra class for the button.
 * @param p.badge - A small mark on the button (a count or a dot).
 * @param p.onOpen - Called each time the panel opens.
 * @param p.children - The panel's content, or a function given `close`.
 */
export function BarPopover(p: { icon: ReactNode; label: string; title: string; className?: string; badge?: ReactNode; onOpen?: () => void; children: ReactNode | ((close: () => void) => ReactNode) }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== "Escape") return;
        button.current?.focus();
        setOpen(false);
      } else if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onHash = () => setOpen(false);
    addEventListener("mousedown", close);
    addEventListener("keydown", close);
    addEventListener("hashchange", onHash);
    return () => {
      removeEventListener("mousedown", close);
      removeEventListener("keydown", close);
      removeEventListener("hashchange", onHash);
    };
  }, [open]);
  const toggle = () => {
    if (!open) p.onOpen?.();
    setOpen(!open);
  };
  return (
    <div className="bar-pop-wrap" ref={root}>
      <button ref={button} type="button" className={`bar-btn ${p.className ?? ""}`} aria-label={p.label} title={p.label} aria-expanded={open} aria-controls={open ? id : undefined} onClick={toggle}>
        {p.icon}
        {p.badge}
      </button>
      {open && (
        <div id={id} className="hub-pop bar-panel" role="dialog" aria-label={p.title}>
          {typeof p.children === "function" ? p.children(() => setOpen(false)) : p.children}
        </div>
      )}
    </div>
  );
}
