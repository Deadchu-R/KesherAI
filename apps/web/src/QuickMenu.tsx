import { useEffect, useRef, useState } from "react";
import { NEW_CODE_EVENT } from "./AppBar";
import { useLibrary } from "./library";
import { t } from "./i18n";

type Item = { key: string; label: string; icon: string; go: () => void };

/**
 * "Jump to": press and hold, slide over the places (each lights up as you
 * pass it) and let go to open the one under your finger or pointer, like
 * Apple's press-and-drag menus. A quick tap opens the menu to click
 * normally; arrow keys and Enter work too.
 */
export function QuickMenu() {
  const { conversations } = useLibrary();
  const [open, setOpen] = useState(false);
  const [hot, setHot] = useState(-1);
  const dragging = useRef(false);
  const moved = useRef(false);
  const start = useRef({ x: 0, y: 0 });
  const root = useRef<HTMLDivElement>(null);

  const nav = (hash: string) => () => {
    location.hash = hash;
  };
  const items: Item[] = [
    { key: "chat", label: t("newChat"), icon: "+", go: nav("#/") },
    { key: "code", label: t("newCode"), icon: "</>", go: () => dispatchEvent(new Event(NEW_CODE_EVENT)) },
    { key: "models", label: t("models"), icon: "◈", go: nav("#/models") },
    { key: "images", label: t("images"), icon: "◐", go: nav("#/images") },
    { key: "community", label: t("communityNav"), icon: "✦", go: nav("#/community") },
    { key: "usage", label: t("usageNav"), icon: "≋", go: nav("#/usage") },
    { key: "settings", label: t("settings"), icon: "⚙", go: nav("#/settings") },
    ...conversations.slice(0, 5).map((c) => ({ key: c.id, label: c.title, icon: c.kind === "code" ? "</>" : "•", go: nav(`#/c/${c.id}`) })),
  ];

  const choose = (i: number) => {
    const it = items[i];
    setOpen(false);
    setHot(-1);
    it?.go();
  };

  const indexAt = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-qm]");
    return el && root.current?.contains(el) ? Number(el.dataset.qm) : -1;
  };

  useEffect(() => {
    if (!open) return;
    const move = (e: PointerEvent) => {
      if (!dragging.current) return;
      if (Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 6) moved.current = true;
      setHot(indexAt(e.clientX, e.clientY));
    };
    const up = (e: PointerEvent) => {
      if (!dragging.current) return;
      dragging.current = false;
      const i = indexAt(e.clientX, e.clientY);
      // Let go over an item: open it. A tap without moving keeps the menu open to click.
      if (i >= 0) choose(i);
      else if (moved.current) {
        setOpen(false);
        setHot(-1);
      }
    };
    const outside = (e: PointerEvent) => {
      if (!dragging.current && !root.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      else if (e.key === "ArrowDown") { e.preventDefault(); setHot((h) => (h + 1) % items.length); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setHot((h) => (h <= 0 ? items.length - 1 : h - 1)); }
      else if (e.key === "Enter" && hot >= 0) { e.preventDefault(); choose(hot); }
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointerdown", outside);
    addEventListener("keydown", key);
    return () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointerdown", outside);
      removeEventListener("keydown", key);
    };
  });

  return (
    <div className="qm" ref={root}>
      <button
        type="button"
        className={`qm-btn${open ? " on" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("qmHint")}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          dragging.current = true;
          moved.current = false;
          start.current = { x: e.clientX, y: e.clientY };
          setOpen(true);
          setHot(-1);
          (e.target as Element).releasePointerCapture?.(e.pointerId);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setHot(0);
          }
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="4" cy="4" r="1.6" fill="currentColor" /><circle cx="12" cy="4" r="1.6" fill="currentColor" />
          <circle cx="4" cy="12" r="1.6" fill="currentColor" /><circle cx="12" cy="12" r="1.6" fill="currentColor" />
        </svg>
        <span>{t("qmLabel")}</span>
        <kbd className="qm-hint">{t("qmHold")}</kbd>
      </button>
      {open && (
        <div className="qm-pop" role="menu" aria-label={t("qmLabel")} style={{ touchAction: "none" }}>
          {items.map((it, i) => (
            <div
              key={it.key}
              role="menuitem"
              tabIndex={-1}
              data-qm={i}
              className={`qm-item${hot === i ? " hot" : ""}${i === 7 ? " sep" : ""}`}
              aria-selected={hot === i}
              onPointerEnter={() => !dragging.current && setHot(i)}
              onClick={() => !dragging.current && choose(i)}
            >
              <span className="qm-icon" aria-hidden>{it.icon}</span>
              <span className="qm-text" dir="auto">{it.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
