/**
 * The sidebar's ✏ edit mode: the pinned tools and the shortcuts as one list to reorder (arrows, which also work
 * with a keyboard and a screen reader), hide and add to. After Linear's "Customize sidebar" and Slack's sidebar
 * preferences (docs/RESEARCH_LOG.md, 2026-11-13): editing is a mode with a clear Done, hiding never deletes
 * anything, and everything hidden stays one tap away under "Add". Saved on the computer, so the phone matches.
 */
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

/** One row: icon, name, up, down, hide. */
function Row(p: { icon: React.ReactNode; label: string; first: boolean; last: boolean; onMove: (by: number) => void; onHide: () => void; hideLabel: string }) {
  return (
    <li className="side-edit-row">
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
  return (
    <div className="side-edit">
      <div className="section-head">
        <span>{L("עריכת התפריט", "Edit the menu")}</span>
        <button type="button" className="primary small" onClick={onDone}>{L("סיום", "Done")}</button>
      </div>
      <p className="muted small side-edit-hint">{L("החצים משנים סדר. ✕ מסתיר מהתפריט ולא מוחק דבר.", "The arrows change the order. ✕ hides from the menu and deletes nothing.")}</p>
      <div className="side-edit-title">{L("כלים בתפריט", "Tools in the menu")}</div>
      {shown.length === 0 && <p className="muted small side-edit-hint">{L("אין כלים בתפריט. הוסיפו מהרשימה למטה.", "No tools in the menu. Add some from the list below.")}</p>}
      <ul className="side-edit-list">
        {shown.map((h, i) => (
          <Row key={h} icon={<ToolIcon href={h} fallback={NAV_ICONS[h] ?? "•"} />} label={labelOf(h)} first={i === 0} last={i === shown.length - 1} onMove={(by) => reorder(moved(shown, i, by))} onHide={() => toggle(h)} hideLabel={L("הסתר", "Hide")} />
        ))}
      </ul>
      {shortcuts.length > 0 && (
        <>
          <div className="side-edit-title">{L("קיצורי דרך", "Shortcuts")}</div>
          <ul className="side-edit-list">
            {shortcuts.map((s, i) => (
              <Row key={s.id} icon={s.icon ?? "⭐"} label={s.label} first={i === 0} last={i === shortcuts.length - 1} onMove={(by) => void saveShortcuts(moved(shortcuts, i, by))} onHide={() => void saveShortcuts(shortcuts.filter((_, j) => j !== i))} hideLabel={L("הסר", "Remove")} />
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
