import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";

/**
 * One menu for the whole app, like Apple's pull-down buttons: press the button and keep the finger (or mouse
 * button) down, slide over the items (the one under the finger lights up) and let go to choose; a quick tap
 * opens it to tap. That press-and-slide comes from the app-wide `data-slide-menu` behaviour (slideMenus.ts);
 * this component adds the rest every menu shares: the glass panel, a checkmark on the chosen item, closing on
 * a tap outside or Escape, keyboard use (arrows, Home/End, Enter, letters), WAI-ARIA roles, flyouts that open
 * in place (so they work by finger), and taller rows on touch screens.
 *
 * @example
 * <Menu trigger="+" aria-label="Add">
 *   <MenuItem icon="📎" onSelect={pickFiles}>Files…</MenuItem>
 *   <MenuSeparator />
 *   <MenuItem checked={web} keepOpen onSelect={() => setWeb(!web)}>Web search</MenuItem>
 * </Menu>
 */

interface Ctx {
  close: () => void;
}
const MenuCtx = createContext<Ctx>({ close: () => undefined });

/** @returns Closes the menu this is inside (for custom content). */
export function useMenu(): Ctx {
  return useContext(MenuCtx);
}

export interface MenuProps {
  /** What the button shows. */
  trigger: ReactNode;
  /** The button's class (e.g. "chip", "model-chip", "bar-btn"). */
  triggerClassName?: string;
  title?: string;
  "aria-label"?: string;
  /** The wrapper's class (positions the panel); "model-menu" by default. */
  className?: string;
  /** The panel's class (where it opens: "model-pop" above, "bar-pop" below); "model-pop" by default. */
  popClassName?: string;
  popStyle?: CSSProperties;
  /** Controlled open state (otherwise the menu keeps its own). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
  /** The items, or a function given `close`. */
  children: ReactNode | ((close: () => void) => ReactNode);
}

const ITEM = '[role^="menuitem"]:not([disabled]):not([aria-disabled="true"])';

/** A pull-down menu button. */
export function Menu(p: MenuProps) {
  const [own, setOwn] = useState(false);
  const open = p.open ?? own;
  const setOpen = (o: boolean) => {
    if (p.open === undefined) setOwn(o);
    p.onOpenChange?.(o);
  };
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const id = useId();
  const focusFirst = useRef(false);
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    // Escape also when the focus is still on the button (a tap opened the menu).
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || pop.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    addEventListener("pointerdown", outside);
    addEventListener("keydown", esc);
    if (focusFirst.current) {
      focusFirst.current = false;
      pop.current?.querySelector<HTMLElement>(ITEM)?.focus();
    }
    return () => {
      removeEventListener("pointerdown", outside);
      removeEventListener("keydown", esc);
    };
  }, [open]);

  const items = () => [...(pop.current?.querySelectorAll<HTMLElement>(ITEM) ?? [])];
  const onPopKey = (e: ReactKeyboardEvent) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => {
      e.preventDefault();
      list[(n + list.length) % list.length]?.focus();
    };
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      btn.current?.focus();
    } else if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i < 0 ? list.length - 1 : i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(list.length - 1);
    else if (e.key === "Tab") close();
    else if (e.key.length === 1 && /\S/.test(e.key) && !(e.target as HTMLElement).matches("input, textarea")) {
      // Type-ahead: the next item starting with that letter.
      const k = e.key.toLocaleLowerCase();
      const from = i + 1;
      const hit = [...list.slice(from), ...list.slice(0, from)].find((el) => (el.textContent ?? "").replace(/^[^\p{L}\p{N}]+/u, "").toLocaleLowerCase().startsWith(k));
      if (hit) {
        e.preventDefault();
        hit.focus();
      }
    }
  };

  return (
    <div className={p.className ?? "model-menu"} ref={root}>
      <button
        ref={btn}
        type="button"
        data-slide-menu
        className={p.triggerClassName}
        title={p.title}
        aria-label={p["aria-label"]}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={p.disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || ((e.key === "Enter" || e.key === " ") && !open)) {
            e.preventDefault();
            focusFirst.current = true;
            if (open) items()[0]?.focus();
            else setOpen(true);
          }
        }}
      >
        {p.trigger}
      </button>
      {open && (
        <div ref={pop} id={id} className={`${p.popClassName ?? "model-pop"} kmenu`} style={p.popStyle} role="menu" aria-label={p["aria-label"]} onKeyDown={onPopKey}>
          <MenuCtx.Provider value={{ close }}>{typeof p.children === "function" ? p.children(close) : p.children}</MenuCtx.Provider>
        </div>
      )}
    </div>
  );
}

export interface MenuItemProps {
  onSelect?: () => void;
  /** A link instead of an action. */
  href?: string;
  /** Shown before the text. */
  icon?: ReactNode;
  /** A ✓ (or radio) item: true or false shows the state; undefined is a plain item. */
  checked?: boolean;
  /** "radio" for one-of-several (default "checkbox" when `checked` is set). */
  kind?: "checkbox" | "radio";
  /** Keep the menu open after choosing (toggles). */
  keepOpen?: boolean;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  dir?: "auto" | "ltr" | "rtl";
  className?: string;
  /** Shown at the end (a shortcut, a count). */
  end?: ReactNode;
  children: ReactNode;
}

/** One item: a button, a link, or a ✓ item. */
export function MenuItem(p: MenuItemProps) {
  const { close } = useMenu();
  const role = p.checked === undefined ? "menuitem" : p.kind === "radio" ? "menuitemradio" : "menuitemcheckbox";
  const cls = `kmenu-item${p.danger ? " danger" : ""}${p.className ? ` ${p.className}` : ""}`;
  const body = (
    <>
      {p.icon !== undefined && <span className="kmenu-icon" aria-hidden="true">{p.icon}</span>}
      <span className="kmenu-text" dir={p.dir}>{p.children}</span>
      {p.end !== undefined && <span className="kmenu-end">{p.end}</span>}
      {/* At the end, so a lone toggle among plain items lines up with them. */}
      {p.checked !== undefined && <span className="kmenu-check" aria-hidden="true">{p.checked ? "✓" : ""}</span>}
    </>
  );
  const run = () => {
    p.onSelect?.();
    if (!p.keepOpen) close();
  };
  if (p.href)
    return (
      <a role={role} href={p.href} className={cls} title={p.title} tabIndex={-1} onClick={run}>
        {body}
      </a>
    );
  return (
    <button type="button" role={role} aria-checked={p.checked} className={cls} title={p.title} tabIndex={-1} disabled={p.disabled} onClick={run}>
      {body}
    </button>
  );
}

/** A line between groups. */
export function MenuSeparator() {
  return <hr role="separator" className="kmenu-sep" />;
}

/** A small heading over a group (not an item). */
export function MenuLabel({ children, end }: { children: ReactNode; end?: ReactNode }) {
  return (
    <div className="kmenu-label" role="presentation">
      <span>{children}</span>
      {end}
    </div>
  );
}

/**
 * An item that opens more items under it, in place (a finger cannot hover a side flyout).
 *
 * @param props.onOpen - Called when it opens (load its list then).
 * @param props.open - Controlled (e.g. only one flyout open at a time).
 */
export function MenuSub(p: { label: ReactNode; icon?: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void; onOpen?: () => void; children: ReactNode }) {
  const [own, setOwn] = useState(false);
  const open = p.open ?? own;
  // A flyout opened near the bottom of a long menu (a phone) scrolls into view, so its choices are seen.
  const group = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) group.current?.scrollIntoView?.({ block: "nearest" });
  }, [open]);
  const toggle = () => {
    const o = !open;
    if (p.open === undefined) setOwn(o);
    p.onOpenChange?.(o);
    if (o) p.onOpen?.();
  };
  // On a phone the open flyout takes the whole menu, with this row as its back button (styles.css).
  return (
    <div className={`kmenu-subwrap${open ? " open" : ""}`}>
      <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={open} className="kmenu-item" tabIndex={-1} onClick={toggle}>
        {p.icon !== undefined && <span className="kmenu-icon" aria-hidden="true">{p.icon}</span>}
        <span className="kmenu-text">{p.label}</span>
        <span className="kmenu-end kmenu-arrow" aria-hidden="true">›</span>
      </button>
      {open && <div ref={group} className="kmenu-sub" role="group">{p.children}</div>}
    </div>
  );
}

/** A note inside a menu or flyout ("Loading…", "None yet"). */
export function MenuNote({ children }: { children: ReactNode }) {
  return <p className="muted small kmenu-note">{children}</p>;
}
