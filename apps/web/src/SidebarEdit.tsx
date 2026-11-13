/**
 * The sidebar's ✏ edit mode: the pinned tools and the shortcuts as one list to reorder (arrows, which also work
 * with a keyboard and a screen reader), hide and add to. After Linear's "Customize sidebar" and Slack's sidebar
 * preferences (docs/RESEARCH_LOG.md, 2026-11-13): editing is a mode with a clear Done, hiding never deletes
 * anything, and everything hidden stays one tap away under "Add". Saved on the computer, so the phone matches.
 */
import { useEffect, useRef, useState } from "react";
import { getLocale } from "./i18n";
import { DEFAULT_PINS, NAV_ICONS, setPinOrder, useNavItems, usePins } from "./Sidebar";
import { saveShortcuts, useShortcuts } from "./SidebarShortcuts";
import { ToolIcon } from "./ToolIcon";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/** Moves item `i` of a list by `by` places. */
function moved<T>(list: T[], i: number, by: number): T[] {
  const next = [...list];
  const [x] = next.splice(i, 1);
  next.splice(Math.max(0, Math.min(next.length, i + by)), 0, x!);
  return next;
}

/**
 * Dragging a row by its handle (mouse or finger, at once: no long press in edit mode). The list reorders while
 * the row moves over the others, like Linear's and Notion's lists.
 *
 * @param ids - The rows, in order.
 * @param onOrder - Shows and saves the new order.
 */
function useHandleDrag(ids: string[], onOrder: (next: string[]) => void) {
  const [dragging, setDragging] = useState<string | null>(null);
  const order = useRef(ids);
  order.current = ids;
  const save = useRef(onOrder);
  save.current = onOrder;
  // The window follows the pointer: the row's own element moves in the list while it is dragged, which would
  // drop a pointer capture on it.
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-edit-id]")?.dataset.editId;
      const now = order.current;
      if (!over || over === dragging || !now.includes(over)) return;
      const next = now.filter((x) => x !== dragging);
      next.splice(next.indexOf(over) + (now.indexOf(over) > now.indexOf(dragging) ? 1 : 0), 0, dragging);
      save.current(next);
    };
    const end = () => setDragging(null);
    addEventListener("pointermove", move);
    addEventListener("pointerup", end);
    addEventListener("pointercancel", end);
    return () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", end);
      removeEventListener("pointercancel", end);
    };
  }, [dragging]);
  const handle = (id: string) => ({
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      setDragging(id);
    },
  });
  return { dragging, handle };
}

/** One row: drag handle, icon, name, up, down, hide. */
function Row(p: { id: string; dragging: boolean; handle: React.HTMLAttributes<HTMLElement>; icon: React.ReactNode; label: string; first: boolean; last: boolean; onMove: (by: number) => void; onHide: () => void; hideLabel: string }) {
  return (
    <li className={`side-edit-row${p.dragging ? " dragging" : ""}`} data-edit-id={p.id}>
      <span className="side-edit-grip" aria-hidden="true" title={L("גררו לשינוי הסדר", "Drag to reorder")} {...p.handle}>⠿</span>
      <span className="nav-ico" aria-hidden="true">{p.icon}</span>
      <span className="grow side-edit-name" dir="auto">{p.label}</span>
      <button type="button" className="icon-btn" disabled={p.first} aria-label={L(`${p.label}: למעלה`, `${p.label}: up`)} title={L("למעלה", "Up")} onClick={() => p.onMove(-1)}>↑</button>
      <button type="button" className="icon-btn" disabled={p.last} aria-label={L(`${p.label}: למטה`, `${p.label}: down`)} title={L("למטה", "Down")} onClick={() => p.onMove(1)}>↓</button>
      <button type="button" className="icon-btn" aria-label={`${p.label}: ${p.hideLabel}`} title={p.hideLabel} onClick={p.onHide}>✕</button>
    </li>
  );
}

/**
 * @param props.onDone - Leaves edit mode.
 */
export function SidebarEdit({ onDone }: { onDone: () => void }) {
  const [pins, toggle] = usePins();
  const nav = useNavItems();
  const shortcuts = useShortcuts();
  // Only pages that exist now (a part that is off keeps its place for when it is back on).
  const shown = pins.filter((h) => nav.some((n) => n.href === h));
  const labelOf = (h: string) => nav.find((n) => n.href === h)?.label ?? h;
  const reorder = (next: string[]) => setPinOrder([...next, ...pins.filter((h) => !next.includes(h))]);
  const hidden = nav.filter((n) => !pins.includes(n.href));
  const pinDrag = useHandleDrag(shown, reorder);
  // Shortcuts: the order shows at once while dragging and is saved once, when the row is dropped.
  const [draft, setDraft] = useState<string[] | null>(null);
  const byId = (order: string[]) => order.map((id) => shortcuts.find((s) => s.id === id)!).filter(Boolean);
  const cutDrag = useHandleDrag(draft ?? shortcuts.map((s) => s.id), setDraft);
  const cuts = draft ? byId(draft) : shortcuts;
  useEffect(() => {
    if (!cutDrag.dragging && draft) void saveShortcuts(byId(draft)).then(() => setDraft(null));
  }, [cutDrag.dragging]);
  return (
    <div className="side-edit">
      <div className="section-head">
        <span>{L("עריכת התפריט", "Edit the menu")}</span>
        <button type="button" className="primary small" onClick={onDone}>{L("סיום", "Done")}</button>
      </div>
      <p className="muted small side-edit-hint">{L("גררו מהידית ⠿ או השתמשו בחצים לשינוי הסדר. ✕ מסתיר מהתפריט ולא מוחק דבר.", "Drag by the ⠿ handle or use the arrows to change the order. ✕ hides from the menu and deletes nothing.")}</p>
      <div className="side-edit-title">{L("כלים בתפריט", "Tools in the menu")}</div>
      {shown.length === 0 && <p className="muted small side-edit-hint">{L("אין כלים בתפריט. הוסיפו מהרשימה למטה.", "No tools in the menu. Add some from the list below.")}</p>}
      <ul className="side-edit-list">
        {shown.map((h, i) => (
          <Row key={h} id={h} dragging={pinDrag.dragging === h} handle={pinDrag.handle(h)} icon={<ToolIcon href={h} fallback={NAV_ICONS[h] ?? "•"} />} label={labelOf(h)} first={i === 0} last={i === shown.length - 1} onMove={(by) => reorder(moved(shown, i, by))} onHide={() => toggle(h)} hideLabel={L("הסתר", "Hide")} />
        ))}
      </ul>
      {shortcuts.length > 0 && (
        <>
          <div className="side-edit-title">{L("קיצורי דרך", "Shortcuts")}</div>
          <ul className="side-edit-list">
            {cuts.map((s, i) => (
              <Row key={s.id} id={s.id} dragging={cutDrag.dragging === s.id} handle={cutDrag.handle(s.id)} icon={s.icon ?? "⭐"} label={s.label} first={i === 0} last={i === cuts.length - 1} onMove={(by) => void saveShortcuts(moved(cuts, i, by))} onHide={() => void saveShortcuts(cuts.filter((_, j) => j !== i))} hideLabel={L("הסר", "Remove")} />
            ))}
          </ul>
        </>
      )}
      {hidden.length > 0 && (
        <>
          <div className="side-edit-title">{L("הוספה לתפריט", "Add to the menu")}</div>
          <div className="side-edit-add">
            {hidden.map((n) => (
              <button key={n.href} type="button" className="pill-btn" onClick={() => toggle(n.href)} aria-label={L(`הוסף: ${n.label}`, `Add: ${n.label}`)}>
                <span aria-hidden="true">+ {NAV_ICONS[n.href] ?? ""}</span> {n.label}
              </button>
            ))}
          </div>
        </>
      )}
      <button type="button" className="link-btn side-edit-reset" onClick={() => setPinOrder(DEFAULT_PINS)}>{L("חזרה לברירת המחדל", "Back to the default")}</button>
    </div>
  );
}
