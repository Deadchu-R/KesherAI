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
  const [step, setStep] = useState<{ text: string; pct?: number; error?: string } | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      setGone(false);
      setLate(false);
      setStep(null);
      setState({ ...(e as CustomEvent).detail, since: Date.now() });
    };
    addEventListener(EVENT, on);
    return () => removeEventListener(EVENT, on);
  }, []);
  useEffect(() => {
    if (!state || state.error) return;
    let away = false;
    const tick = async () => {
      // An update: show its download percent while the computer still answers.
      if (state.update && !away) {
        const p = await api<{ running: boolean; step?: string; error?: string }>("/api/updates/progress").catch(() => undefined);
        if (p?.error) setStep({ text: p.error, error: p.error });
        else if (p?.step) {
          const pct = /(\d+)%/.exec(p.step)?.[1];
          setStep({ text: p.step, ...(pct ? { pct: Number(pct) } : {}) });
        }
      }
      try {
        const v = await api<{ version: string; commit?: string }>("/api/version");
        const changed = v.version !== state.before || v.commit !== state.commit;
        // Back after being away, or already on the new version, or (a quick restart) answering again after a while.
        if (away || changed || (!state.update && Date.now() - state.since > 20_000)) location.reload();
      } catch {
        away = true;
        setGone(true);
      }
      // Inside the phone app, this address may be gone for good (a new "anywhere" link after
      // the computer restarted): the app's start screen tries the computer's other addresses.
      const inApp = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
      if (away && inApp && Date.now() - state.since > 75_000) location.href = "http://localhost/index.html";
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
        {state.update && !gone && step && !step.error && (
          <div className="stack" style={{ gap: 6 }}>
            <div className="row small"><span className="grow">{step.pct !== undefined ? L("מוריד את הגרסה החדשה", "Downloading the new version") : step.text === "Installing" ? L("מתקין…", "Installing…") : step.text}</span>{step.pct !== undefined && <strong>{step.pct}%</strong>}</div>
            {step.pct !== undefined && <div className="bar"><div style={{ width: `${step.pct}%` }} /></div>}
          </div>
        )}
        {step?.error && <p className="error">{step.error}</p>}
        {!state.error && !late && step?.pct === undefined && <div className="spinner" aria-hidden />}
        {(late || state.error || step?.error) && (
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
