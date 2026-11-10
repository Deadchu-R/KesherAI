import { Children, isValidElement, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * The one drop-down menu of KesherAI, in Apple's style: a pop-up button that
 * shows the current choice with ⌃⌄, and a glass menu with a checkmark on the
 * current item (macOS / iOS pop-up buttons). Press and hold, slide over the
 * choices (each lights up under the finger or pointer) and let go to pick
 * one, like Apple's press-and-drag menus (and KesherAI's "Jump to"); a quick
 * tap opens it to tap normally. Rows are taller on touch screens.
 *
 * It takes the same props and children as `<select>` (`value`, `onChange`,
 * `<option>`, `<optgroup>`, `disabled`, `className`…), and `onChange` gets
 * `{ target: { value } }`, so `<select>` → `<Select>` is a drop-in change.
 * Keyboard and screen readers follow WAI-ARIA's select-only combobox
 * (arrows, Home/End, PageUp/PageDown, Enter/Space/Tab, Escape, type-ahead).
 */

interface Opt { value: string; label: ReactNode; text: string; disabled: boolean; group?: string }

/** What `onChange` receives (like a native change event, for `e.target.value`). */
export interface SelectChange { target: { value: string }; currentTarget: { value: string } }

export interface SelectProps {
  value?: string | number;
  defaultValue?: string | number;
  onChange?: (e: SelectChange) => void;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  title?: string;
  id?: string;
  dir?: "ltr" | "rtl" | "auto";
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /** Focus it when it appears (like `<select autoFocus>`). */
  autoFocus?: boolean;
  children?: ReactNode;
}

const textOf = (n: ReactNode): string =>
  typeof n === "string" || typeof n === "number" ? String(n) : Array.isArray(n) ? n.map(textOf).join("") : isValidElement(n) ? textOf((n.props as { children?: ReactNode }).children) : "";

function readOptions(children: ReactNode, group?: string): Opt[] {
  const out: Opt[] = [];
  Children.forEach(children, (c) => {
    if (!isValidElement(c)) return;
    const el = c as ReactElement<{ value?: string | number; disabled?: boolean; label?: string; children?: ReactNode }>;
    if (el.type === "option") {
      const label = el.props.children;
      out.push({ value: String(el.props.value ?? textOf(label)), label, text: textOf(label), disabled: !!el.props.disabled, ...(group ? { group } : {}) });
    } else if (el.type === "optgroup") {
      out.push(...readOptions(el.props.children, el.props.label ?? ""));
    } else if (el.props.children) {
      // A fragment or a wrapper around options.
      out.push(...readOptions(el.props.children, group));
    }
  });
  return out;
}


/**
 * A drop-down menu (see the file's comment).
 *
 * @param props - Like `<select>`'s.
 */
export function Select({ value, defaultValue, onChange, disabled, className, style, title, id, dir, autoFocus, children, ...aria }: SelectProps) {
  const options = useMemo(() => readOptions(children), [children]);
  const [own, setOwn] = useState(String(defaultValue ?? options[0]?.value ?? ""));
  const current = value !== undefined ? String(value) : own;
  const selected = options.find((o) => o.value === current) ?? (value === undefined ? options[0] : undefined);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxHeight: number; up: boolean } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const drag = useRef({ on: false, moved: false, x: 0, y: 0 });
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const uid = useId();
  const listId = `${uid}-list`;
  const optId = (i: number) => `${uid}-o${i}`;
  useEffect(() => {
    if (autoFocus) btn.current?.focus();
  }, []);

  const enabled = (i: number) => i >= 0 && i < options.length && !options[i]!.disabled;
  const step = (from: number, dir: 1 | -1) => {
    for (let i = from + dir; i >= 0 && i < options.length; i += dir) if (enabled(i)) return i;
    return from;
  };
  const first = () => step(-1, 1);
  const last = () => step(options.length, -1);

  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 220 && above > below;
    const maxHeight = Math.max(160, Math.min(420, up ? above : below));
    const width = Math.min(Math.max(r.width, 180), 420, window.innerWidth - 16);
    // Right-to-left (Hebrew): the menu lines up with the button's right edge.
    const rtl = btn.current ? getComputedStyle(btn.current).direction === "rtl" : false;
    const left = Math.min(Math.max(8, rtl ? r.right - width : r.left), window.innerWidth - width - 8);
    setPos({ top: up ? r.top - 4 : r.bottom + 4, left, width, maxHeight, up });
  };

  const show = (focus?: number) => {
    if (disabled || !options.length) return;
    place();
    const i = options.findIndex((o) => o.value === current);
    setActive(focus ?? (i >= 0 ? i : first()));
    setOpen(true);
  };
  const hide = (refocus = true) => {
    setOpen(false);
    if (refocus) btn.current?.focus();
  };
  const choose = (i: number, refocus = true) => {
    if (!enabled(i)) return;
    const v = options[i]!.value;
    if (value === undefined) setOwn(v);
    if (v !== current) onChange?.({ target: { value: v }, currentTarget: { value: v } });
    hide(refocus);
  };

  // Close on a press outside; follow the button when the page scrolls or resizes.
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!btn.current?.contains(t) && !list.current?.contains(t)) hide(false);
    };
    const move = () => place();
    // Press, slide, release: the row under the finger lights up, and letting go over it picks it.
    const indexAt = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-ksel]");
      return el && list.current?.contains(el) ? Number(el.dataset.ksel) : -1;
    };
    const slide = (e: PointerEvent) => {
      const d = drag.current;
      if (!d.on) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) d.moved = true;
      const i = indexAt(e.clientX, e.clientY);
      if (i >= 0 && enabled(i)) {
        setActive((a) => {
          if (a !== i && e.pointerType === "touch") navigator.vibrate?.(4);
          return i;
        });
      }
    };
    const release = (e: PointerEvent) => {
      const d = drag.current;
      if (!d.on) return;
      d.on = false;
      const i = indexAt(e.clientX, e.clientY);
      if (i >= 0 && d.moved) choose(i);
      else if (i >= 0 && !d.moved) return; // a tap on the button itself: the menu stays open to tap
      else if (d.moved) hide();
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", slide);
    window.addEventListener("pointerup", release);
    window.addEventListener("resize", move);
    window.addEventListener("scroll", move, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", slide);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("resize", move);
      window.removeEventListener("scroll", move, true);
    };
  });
  // Keep the active row in view.
  useLayoutEffect(() => {
    if (open && active >= 0) document.getElementById(optId(active))?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const typeAhead = (key: string) => {
    const now = Date.now();
    const t = typed.current;
    t.text = now - t.at > 700 ? key : t.text + key;
    t.at = now;
    const q = t.text.toLowerCase();
    const start = t.text.length === 1 ? active + 1 : Math.max(active, 0);
    for (let k = 0; k < options.length; k++) {
      const i = (start + k) % options.length;
      if (enabled(i) && options[i]!.text.trim().toLowerCase().startsWith(q)) return i;
    }
    return -1;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const k = e.key;
    if (!open) {
      if (["ArrowDown", "Enter", " "].includes(k)) {
        e.preventDefault();
        show();
      } else if (k === "ArrowUp" || k === "Home") {
        e.preventDefault();
        show(first());
      } else if (k === "End") {
        e.preventDefault();
        show(last());
      } else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const i = typeAhead(k);
        if (i >= 0) show(i);
      }
      return;
    }
    if (k === "Escape") {
      e.preventDefault();
      hide();
    } else if (k === "ArrowDown") {
      e.preventDefault();
      setActive((a) => step(a, 1));
    } else if (k === "ArrowUp") {
      e.preventDefault();
      if (e.altKey) choose(active);
      else setActive((a) => step(a, -1));
    } else if (k === "Home") {
      e.preventDefault();
      setActive(first());
    } else if (k === "End") {
      e.preventDefault();
      setActive(last());
    } else if (k === "PageDown") {
      e.preventDefault();
      setActive((a) => { let i = a; for (let n = 0; n < 10; n++) i = step(i, 1); return i; });
    } else if (k === "PageUp") {
      e.preventDefault();
      setActive((a) => { let i = a; for (let n = 0; n < 10; n++) i = step(i, -1); return i; });
    } else if (k === "Enter" || k === " ") {
      e.preventDefault();
      choose(active);
    } else if (k === "Tab") {
      choose(active, false);
    } else if (k.length === 1 && !e.ctrlKey && !e.metaKey) {
      const i = typeAhead(k);
      if (i >= 0) setActive(i);
    }
  };

  let lastGroup: string | undefined;
  const menu = open && pos && (
    <>
      <div
        ref={list}
        id={listId}
        role="listbox"
        aria-label={aria["aria-label"] ?? title}
        className={`ksel-menu${pos.up ? " up" : ""}`}
        dir={dir ?? "auto"}
        style={{ left: pos.left, width: pos.width, maxHeight: pos.maxHeight, ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }) }}
        onPointerDown={(e) => e.preventDefault()}
      >
        {options.map((o, i) => {
          const head = o.group !== undefined && o.group !== lastGroup ? o.group : undefined;
          lastGroup = o.group;
          return (
            <div key={`${o.value}-${i}`}>
              {head !== undefined && head !== "" && <div className="ksel-group" role="presentation">{head}</div>}
              <div
                id={optId(i)}
                data-ksel={i}
                role="option"
                aria-selected={o.value === current}
                aria-disabled={o.disabled || undefined}
                className={`ksel-opt${i === active ? " active" : ""}${o.value === current ? " on" : ""}${o.disabled ? " off" : ""}`}
                onPointerEnter={() => enabled(i) && setActive(i)}
                onClick={() => choose(i)}
              >
                <span className="ksel-check" aria-hidden>{o.value === current ? "✓" : ""}</span>
                <span className="ksel-label">{o.label}</span>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );

  return (
    <>
      <button
        ref={btn}
        type="button"
        id={id}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 ? optId(active) : undefined}
        aria-label={aria["aria-label"]}
        aria-labelledby={aria["aria-labelledby"]}
        title={title}
        disabled={disabled}
        dir={dir}
        className={`ksel${className ? ` ${className}` : ""}${open ? " open" : ""}`}
        style={style}
        onPointerDown={(e) => {
          if (e.button !== 0 || disabled) return;
          e.preventDefault();
          if (open) {
            hide();
            return;
          }
          drag.current = { on: true, moved: false, x: e.clientX, y: e.clientY };
          // Let the pointer move over the menu (the button would keep it otherwise).
          (e.target as Element).releasePointerCapture?.(e.pointerId);
          btn.current?.focus();
          show();
        }}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          if (open && !list.current?.contains(e.relatedTarget as Node)) hide(false);
        }}
      >
        <span className="ksel-value">{selected ? selected.label : ""}</span>
        <svg className="ksel-chev" viewBox="0 0 10 14" aria-hidden width="10" height="14">
          <path d="M2 5.2 5 2.2l3 3M2 8.8l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {menu && createPortal(menu, document.body)}
    </>
  );
}
