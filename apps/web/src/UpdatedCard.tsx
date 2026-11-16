import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
const SEEN = "kesherai-seen-version";

/**
 * After an update, once: "Updated to X" with what is new in it (from the release notes), on the home screen. The first
 * run only remembers the version (nothing to compare with).
 */
export function UpdatedCard({ hash }: { hash: string }) {
  const [card, setCard] = useState<{ version: string; notes: string[] } | null>(null);
  useEffect(() => {
    void (async () => {
      const v = await api<{ version: string }>("/api/version").catch(() => undefined);
      if (!v) return;
      let seen: string | null = null;
      try { seen = localStorage.getItem(SEEN); } catch { /* storage off: show nothing */ return; }
      if (!seen) { try { localStorage.setItem(SEEN, v.version); } catch { /* none */ } return; }
      if (seen === v.version) return;
      const h = await api<{ releases: Array<{ version: string; notes: string[] }> }>("/api/updates/history").catch(() => undefined);
      const notes = h?.releases.find((r) => r.version.replace(/^v/, "") === v.version)?.notes ?? [];
      setCard({ version: v.version, notes: notes.slice(0, 5) });
    })();
  }, []);
  if (!card || (hash !== "#/" && hash !== "")) return null;
  const close = () => { try { localStorage.setItem(SEEN, card.version); } catch { /* none */ } setCard(null); };
  return (
    <section className="card stack updated-card" role="status">
      <div className="row" style={{ gap: 10 }}>
        <span className="updated-dot" aria-hidden />
        <b className="grow">{L(`עודכן ל-${card.version}`, `Updated to ${card.version}`)}</b>
        <button type="button" className="ghost small" aria-label={L("סגירה", "Close")} onClick={close}>✕</button>
      </div>
      {card.notes.length > 0 && <ul dir="auto">{card.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      <div className="row"><a className="button" href="#/updates" onClick={close}>{L("כל השינויים", "All changes")}</a></div>
    </section>
  );
}
