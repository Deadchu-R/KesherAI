import { useEffect, useState } from "react";
import { api, withToken } from "../api";
import { getLocale } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/** Something an agent waits for the user to approve. */
export interface Pending { kind?: "chat" | "self-work"; conversationId: string; title: string; requestId: string; tool: string; preview: string; reason: string; purpose?: string; at: string }
interface Status { enabled: boolean; active: boolean; app: string; log: Array<{ at: string; action: string; app: string; ok: boolean; note?: string }> }

/** @returns What waits for approval now (polled). */
export function usePending(every = 4000): Pending[] {
  const [list, setList] = useState<Pending[]>([]);
  useEffect(() => {
    let alive = true;
    const tick = () => api<Pending[]>("/api/approvals").then((l) => alive && setList(l), () => undefined);
    void tick();
    const id = setInterval(tick, every);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [every]);
  return list;
}

/**
 * The computer's screen while computer control is on: live, what the agent did, and Stop. A tab of the inbox
 * (redesign 2026-11: "Watch and approve" was a second page for the same approvals).
 */
export function ComputerScreen() {
  const [st, setSt] = useState<Status | null>(null);
  const [live, setLive] = useState(true);
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const tick = () => api<Status>("/api/computer/status").then(setSt, () => undefined);
    void tick();
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!live || !st?.enabled) return;
    const id = setInterval(() => !document.hidden && setFrame((n) => n + 1), 1500);
    return () => clearInterval(id);
  }, [live, st?.enabled]);
  const width = Math.min(1280, Math.round(window.innerWidth * (window.devicePixelRatio || 1)));
  return (
    <section className="stack">
      <div className="row">
        <h2>{L("המסך של המחשב", "The computer's screen")}</h2>
        <span className="grow" />
        {st?.enabled && (
          <>
            <label className="check"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> {L("חי", "Live")}</label>
            <button type="button" className="danger-btn" onClick={() => void api("/api/computer/stop", { method: "POST" }).then(() => toast(L("נעצר.", "Stopped.")))}>■ {L("עצור את השליטה", "Stop control")}</button>
          </>
        )}
      </div>
      {!st?.enabled ? (
        <p className="muted">{L("שליטה במחשב כבויה. אפשר להפעיל אותה בהגדרות ← שליטה במחשב.", "Computer control is off. Turn it on in Settings → Computer control.")}</p>
      ) : (
        <>
          <img className="watch-screen" alt={L("המסך של המחשב", "The computer's screen")} src={withToken(`/api/computer/screen?w=${width}&f=${frame}`)} />
          {st.active && <p className="muted small">{L(`הסוכן עובד ב-${st.app}`, `The agent is working in ${st.app}`)}</p>}
          {st.log.length > 0 && (
            <ol className="watch-log small" reversed>
              {[...st.log].reverse().slice(0, 12).map((a, i) => (
                <li key={i} className={a.ok ? "" : "bad"}><span className="muted">{new Date(a.at).toLocaleTimeString(getLocale() === "he" ? "he-IL" : undefined)}</span> <span dir="auto">{a.action}</span>{a.app ? <span className="muted"> · {a.app}</span> : null}{a.note ? <span className="muted"> — {a.note}</span> : null}</li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}
