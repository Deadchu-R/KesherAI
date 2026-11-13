/**
 * The 🎨 button next to the bell: a small panel where a request in words changes how the app looks (colors,
 * size, corners, font) and what the side menu holds (which tools, in what order, shortcuts). The chat model does
 * it with two tools only (change_look, change_menu); every change can be undone here in one click. Like the
 * theme assistants in Arc and Raycast and the "ask AI" panels in Notion and Linear: small, next to what it
 * changes, with examples to start from (docs/RESEARCH_LOG.md, 2026-11-13).
 */
import { useState } from "react";
import { api } from "./api";
import { appearanceChanged, undoAppearance } from "./appearance";
import { getLocale } from "./i18n";
import { DEFAULT_PINS, showPins, useNavItems } from "./Sidebar";
import { saveShortcuts, showShortcuts, type Shortcut } from "./SidebarShortcuts";
import { BarPopover } from "./ui/BarPopover";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Answer { reply: string; look: boolean; menu: boolean; before: { pins: string[] | null; shortcuts: Shortcut[] }; pins: string[] | null; shortcuts: Shortcut[] }
interface Line { who: "me" | "ai"; text: string; undo?: Answer; undone?: boolean }

const EXAMPLES: Array<[string, string]> = [
  ["צבע ראשי ירוק ופינות עגולות יותר", "A green accent and rounder corners"],
  ["טקסט גדול יותר", "Bigger text"],
  ["שים את עבודה עצמית ראשונה בתפריט", "Put Self-work first in the menu"],
  ["הוסף קיצור דרך להגדרות ההתראות", "Add a shortcut to notification settings"],
];

/** The button and its panel. The conversation stays while the app is open. */
export function DesignAssistant() {
  const nav = useNavItems();
  const [log, setLog] = useState<Line[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const ask = async (request: string) => {
    const q = request.trim();
    if (!q || busy) return;
    setBusy(true);
    setText("");
    setLog((l) => [...l, { who: "me", text: q }]);
    try {
      const r = await api<Answer>("/api/design-assistant", { method: "POST", body: { text: q, pages: nav.map((n) => ({ href: n.href, label: n.label })), defaults: DEFAULT_PINS, hebrew: getLocale() === "he" } });
      if (r.look) appearanceChanged();
      if (r.menu) {
        showPins(r.pins);
        showShortcuts(r.shortcuts);
      }
      setLog((l) => [...l, { who: "ai", text: r.reply || L("בוצע.", "Done."), ...(r.look || r.menu ? { undo: r } : {}) }]);
    } catch (e) {
      const err = e as Error & { code?: string };
      setLog((l) => [...l, { who: "ai", text: /chat model/i.test(err.message) ? L("צריך לבחור מודל צ'אט קודם (מודלים).", "Choose a chat model first (Models).") : err.message }]);
    } finally {
      setBusy(false);
    }
  };

  const undo = async (i: number) => {
    const a = log[i]?.undo;
    if (!a) return;
    try {
      if (a.look) await undoAppearance();
      if (a.menu) {
        await api("/api/pins", { method: "PUT", body: { pins: a.before.pins ?? DEFAULT_PINS } });
        showPins(a.before.pins);
        await saveShortcuts(a.before.shortcuts);
      }
      setLog((l) => l.map((x, j) => (j === i ? { ...x, undone: true } : x)));
    } catch (e) {
      setLog((l) => [...l, { who: "ai", text: (e as Error).message }]);
    }
  };

  return (
    <BarPopover
      className="design-btn"
      label={L("עיצוב ותפריט", "Design and menu")}
      title={L("עיצוב ותפריט", "Design and menu")}
      icon={<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 2.5a6.5 6.5 0 1 0 0 13c1 0 1.5-.6 1.5-1.3 0-.9-.8-1.2-.8-2 0-.7.6-1.2 1.4-1.2h1.6a2.8 2.8 0 0 0 2.8-2.8C15.5 5 12.6 2.5 9 2.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="none" /><circle cx="5.8" cy="8.6" r=".9" fill="currentColor" /><circle cx="8" cy="5.6" r=".9" fill="currentColor" /><circle cx="11.4" cy="6" r=".9" fill="currentColor" /></svg>}
    >
      {(close) => (
        <>
          <div className="row inbox-pop-head">
            <strong className="grow">{L("עיצוב ותפריט", "Design and menu")}</strong>
            <a className="icon-btn" href="#/settings/appearance" aria-label={L("כל הגדרות המראה", "All appearance settings")} title={L("כל הגדרות המראה", "All appearance settings")} onClick={close}>⚙</a>
          </div>
          <div className="ue-bubble-log design-log" aria-live="polite">
            {!log.length && (
              <>
                <p className="muted small">{L("כתבו מה לשנות במראה האפליקציה או בתפריט הצד. כל שינוי אפשר לבטל.", "Say what to change in how the app looks or in the side menu. Every change can be undone.")}</p>
                <div className="design-examples">
                  {EXAMPLES.map(([he, en]) => <button key={en} type="button" className="pill-btn" disabled={busy} onClick={() => void ask(L(he, en))}>{L(he, en)}</button>)}
                </div>
              </>
            )}
            {log.map((m, i) => (
              <div key={i} className={`ue-msg ${m.who === "me" ? "you" : "ai"}`} dir="auto">
                {m.text}
                {m.undo && (m.undone ? <span className="muted small"> · {L("בוטל", "Undone")}</span> : <button type="button" className="link-btn design-undo" onClick={() => void undo(i)}>↶ {L("בטל", "Undo")}</button>)}
              </div>
            ))}
            {busy && <div className="ue-msg ai muted">{L("עובד על זה…", "Working on it…")}</div>}
          </div>
          <form className="row ue-ask" onSubmit={(e) => { e.preventDefault(); void ask(text); }}>
            <input className="grow" dir="auto" autoFocus value={text} maxLength={600} onChange={(e) => setText(e.target.value)} placeholder={L("למשל: מצב בהיר עם כחול", "For example: light mode with blue")} aria-label={L("מה לשנות", "What to change")} />
            <button type="submit" className="primary" disabled={busy || !text.trim()} aria-label={L("שלח", "Send")}>{busy ? "…" : "↑"}</button>
          </form>
        </>
      )}
    </BarPopover>
  );
}
