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
 * Watch and approve: everything agents wait for you to approve, from any
 * device, and — while computer control is on — the computer's screen live,
 * what the agent did, and Stop.
 */
export function WatchPage() {
  const pending = usePending(2000);
  const [st, setSt] = useState<Status | null>(null);
  const [live, setLive] = useState(true);
  const [frame, setFrame] = useState(0);
  const [busy, setBusy] = useState("");
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
  const answer = async (p: Pending, decision: "allow" | "deny") => {
    setBusy(p.requestId);
    try {
      await api("/api/inbox/answer", { method: "POST", body: { kind: p.kind ?? "chat", conversationId: p.conversationId, requestId: p.requestId, decision } });
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const width = Math.min(1280, Math.round(window.innerWidth * (window.devicePixelRatio || 1)));
  return (
    <div className="page watch">
      <div className="page-head">
        <h1>{L("מעקב ואישור", "Watch and approve")}</h1>
        <p className="muted">{L("כל מה שסוכנים מחכים שתאשרו — מכל מכשיר. כששליטה במחשב פעילה, רואים כאן גם את המסך בזמן אמת ואפשר לעצור.", "Everything agents wait for you to approve, from any device. While computer control is on you also see the screen live here, and can stop it.")}</p>
      </div>
      <section className="stack">
        <h2>{pending.length ? L(`מחכה לאישור (${pending.length})`, `Waiting for approval (${pending.length})`) : L("אין מה לאשר כרגע", "Nothing to approve now")}</h2>
        {pending.map((p) => (
          <article key={p.requestId} className="card watch-item">
            <div className="row">
              <a href={`#/c/${p.conversationId}`} dir="auto"><strong>{p.title || L("שיחה", "Chat")}</strong></a>
              <span className="pill" dir="ltr">{p.tool}</span>
              <span className="grow" />
              <span className="muted small">{new Date(p.at).toLocaleTimeString(getLocale() === "he" ? "he-IL" : undefined, { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
            {p.purpose && <p dir="auto">{p.purpose}</p>}
            <p className="muted small" dir="auto">{p.reason}</p>
            <pre className="ctx-text" dir="auto">{p.preview}</pre>
            <div className="row">
              <button type="button" className="primary" disabled={busy === p.requestId} onClick={() => void answer(p, "allow")}>{L("אישור", "Allow")}</button>
              <button type="button" disabled={busy === p.requestId} onClick={() => void answer(p, "deny")}>{L("דחייה", "Deny")}</button>
              <a className="muted small" href={`#/c/${p.conversationId}`}>{L("לשיחה", "Open the chat")}</a>
            </div>
          </article>
        ))}
      </section>
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
    </div>
  );
}
