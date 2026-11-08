import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);
const EVENT = "kesher-reconnect";

/**
 * Waits for KesherAI on the computer to come back (after an update or a
 * restart), then reloads the interface. `restart` asks the computer to
 * restart first.
 *
 * @param o.restart - Restart KesherAI on the computer now.
 * @param o.update - An update is being installed (waits for the new version).
 */
export async function reconnect(o: { restart?: boolean; update?: boolean } = {}): Promise<void> {
  const before = await api<{ version: string; commit?: string }>("/api/version").catch(() => undefined);
  if (o.restart) {
    try {
      await api("/api/system/restart", { method: "POST" });
    } catch (e) {
      dispatchEvent(new CustomEvent(EVENT, { detail: { error: (e as Error).message } }));
      return;
    }
  }
  dispatchEvent(new CustomEvent(EVENT, { detail: { before: before?.version, commit: before?.commit, update: !!o.update } }));
}

/** The "Restarting… reconnecting" screen, shown while the computer's KesherAI is away. */
export function Reconnecting() {
  const [state, setState] = useState<{ before?: string; commit?: string; update?: boolean; error?: string; since: number } | null>(null);
  const [gone, setGone] = useState(false);
  const [late, setLate] = useState(false);
  useEffect(() => {
    const on = (e: Event) => {
      setGone(false);
      setLate(false);
      setState({ ...(e as CustomEvent).detail, since: Date.now() });
    };
    addEventListener(EVENT, on);
    return () => removeEventListener(EVENT, on);
  }, []);
  useEffect(() => {
    if (!state || state.error) return;
    let away = false;
    const tick = async () => {
      try {
        const v = await api<{ version: string; commit?: string }>("/api/version");
        const changed = v.version !== state.before || v.commit !== state.commit;
        // Back after being away, or already on the new version, or (a quick restart) answering again after a while.
        if (away || changed || (!state.update && Date.now() - state.since > 20_000)) location.reload();
      } catch {
        away = true;
        setGone(true);
      }
      if (Date.now() - state.since > 4 * 60_000) setLate(true);
    };
    const id = setInterval(() => void tick(), 2000);
    return () => clearInterval(id);
  }, [state]);
  if (!state) return null;
  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog card stack" role="alertdialog" aria-modal="true" aria-live="polite">
        <strong>{state.error ? L("לא הצלחתי להפעיל מחדש", "Could not restart") : state.update ? L("מעדכן את KesherAI במחשב…", "Updating KesherAI on the computer…") : L("מפעיל מחדש את KesherAI במחשב…", "Restarting KesherAI on the computer…")}</strong>
        <p className="muted">
          {state.error ?? (late ? L("זה לוקח יותר מהרגיל. אולי המחשב ישן או ש-KesherAI לא עלה.", "This is taking longer than usual. The computer may be asleep, or KesherAI did not start.") : gone ? L("המחשב בהפעלה מחדש. אתחבר מחדש לבד ברגע שהוא חוזר.", "The computer's app is restarting. I will reconnect by myself as soon as it is back.") : L("מחכה…", "Waiting…"))}
        </p>
        {!state.error && !late && <div className="spinner" aria-hidden />}
        {(late || state.error) && (
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button type="button" onClick={() => setState(null)}>{L("סגור", "Close")}</button>
            <button type="button" onClick={() => location.reload()}>{L("התחבר מחדש", "Reconnect")}</button>
            {!state.error && <button type="button" className="primary" onClick={() => void reconnect({ restart: true })}>{L("הפעל מחדש שוב", "Restart again")}</button>}
          </div>
        )}
      </div>
    </div>
  );
}
