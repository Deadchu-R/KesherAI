import { useEffect, useRef, useState } from "react";
import { COMPACT_AT, kTokens } from "../chat-status";
import { getLocale, he$ } from "../i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/**
 * The composer's context ring (docs/FEATURE_REVIEW.md, 2026-11-21; as Cursor): how full the model's context was at
 * its last call, always in sight. Tapping it shows the numbers and Compact; from 80% a "Compact" chip is offered
 * beside it (summarise the older turns; pinned tool results stay in full, budget.ts pinnedBefore).
 *
 * @param props.share - 0–1 (chat-status.ts contextShare).
 * @param props.used - Tokens in use; `window` - tokens the model can read.
 * @param props.busy - While the chat works, Compact waits (the server refuses it then).
 * @param props.onCompact - Summarises the older part now.
 */
export function ContextRing(p: { share: number; used: number; window: number; busy: boolean; onCompact: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener("mousedown", close);
    addEventListener("keydown", close);
    return () => {
      removeEventListener("mousedown", close);
      removeEventListener("keydown", close);
    };
  }, [open]);
  const pct = Math.round(p.share * 100);
  const level = p.share >= 0.95 ? "full" : p.share >= COMPACT_AT ? "high" : "ok";
  const r = 7;
  const c = 2 * Math.PI * r;
  const label = L(`הקשר: ${pct}% בשימוש (${kTokens(p.used)} מתוך ${kTokens(p.window)} טוקנים)`, `Context: ${pct}% used (${kTokens(p.used)} of ${kTokens(p.window)} tokens)`);
  const compact = () => {
    setOpen(false);
    p.onCompact();
  };
  return (
    <span className="ctx-ring-wrap" ref={ref}>
      <button type="button" className={`ctx-ring ${level}`} aria-label={label} title={label} aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeOpacity=".25" strokeWidth="2.2" />
          <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeDasharray={`${(c * p.share).toFixed(2)} ${c.toFixed(2)}`} transform="rotate(-90 9 9)" />
        </svg>
        <span className="ctx-ring-pct" dir="ltr">{pct}%</span>
      </button>
      {level !== "ok" && !p.busy && (
        <button type="button" className="chip ctx-compact" title={L("לסכם את החלק המוקדם ולפנות מקום (תוצאות נעוצות נשארות במלואן)", "Summarise the earlier part to free room (pinned results stay in full)")} onClick={compact}>
          {L("לדחוס", "Compact")}
        </button>
      )}
      {open && (
        <span className="ctx-pop kmenu" role="dialog" aria-label={L("הקשר", "Context")}>
          <span className="small">{label}</span>
          <span className="small muted">{L("כשההקשר מתמלא, המודל מסכם לבד את החלק המוקדם. אפשר לסכם עכשיו; כל השיחה נשארת כאן.", "When the context fills, the model summarises the earlier part itself. You can summarise now; the whole chat stays here.")}</span>
          <button type="button" className="primary" disabled={p.busy} onClick={compact}>{L("לדחוס עכשיו", "Compact now")}</button>
        </span>
      )}
    </span>
  );
}
