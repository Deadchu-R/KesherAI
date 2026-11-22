import { useEffect, useRef, useState } from "react";
import type { AgentEvent } from "@kesher/shared";
import { api, withToken } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";
import { actionWord } from "./BrowserPanel";
import { ControlApproval } from "./ControlApproval";
import { ControlTaskCard } from "./ControlTaskCard";
import { liveSources, pickSource, type LiveSource, type LiveState } from "./control-live-view";
import "./control-card.css";

/**
 * "What the agent is doing" (browser and computer control, Phase 7 of docs/research/browser-computer-control.md): the
 * phone's view of the PC while a model uses KesherAI's browser, the user's Chrome or the computer. A picture that
 * refreshes (the pane, the Chrome tab or the screen), the "now" line, the waiting approvals as card v2 with the crop,
 * one big Stop, Manual/Auto and Pause, and the merged action log. A tab of the inbox (#/watch), the same on the
 * computer, in remote and in the Android app. While it is on screen, approvals are not sent as notifications. The
 * computer task (one goal that KesherAI carries out by itself) shows here too, with its form (ControlTaskCard.tsx).
 */

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
type ApprovalEv = Extract<AgentEvent, { type: "approval_request" }> & { seq: number; at: string };

/** A computer action in words (the log keeps the tool's own short names). */
function computerWord(action: string): string {
  const w: Record<string, [string, string]> = {
    click: ["לחיצה", "Click"], double_click: ["לחיצה כפולה", "Double click"], right_click: ["לחיצה ימנית", "Right click"], type: ["הקלדה", "Type"], key: ["מקשים", "Keys"],
    scroll: ["גלילה", "Scroll"], drag: ["גרירה", "Drag"], screenshot: ["צילום מסך", "Screenshot"], zoom: ["הגדלה", "Zoom"], batch: ["כמה פעולות", "Several actions"],
    "use app": ["אישור אפליקציה", "App approved"], "open app": ["פתיחת אפליקציה", "Open an app"], tree: ["קריאת החלון", "Read the window"], invoke: ["לחיצה", "Press"],
    "set value": ["כתיבה בשדה", "Write into a field"], toggle: ["החלפת מצב", "Toggle"], select: ["בחירה", "Select"], windows: ["רשימת חלונות", "List windows"], move: ["הזזת חלון", "Move a window"],
    find: ["חיפוש במסך", "Find on screen"], clipboard: ["לוח הגזירים", "Clipboard"], stop: ["נעצר", "Stopped"],
  };
  const x = w[action];
  return x ? L(x[0], x[1]) : action;
}

/** One log line in words. */
function lineText(a: LiveState["log"][number]): string {
  const word = a.kind === "browser" ? actionWord(a.action) : computerWord(a.action);
  return `${word}${a.target ? `: ${a.target}` : ""}${a.where ? ` · ${a.where}` : ""}`;
}

const SOURCE_WORDS: Record<LiveSource, () => string> = {
  pane: () => L("הדפדפן של KesherAI", "KesherAI's browser"),
  chrome: () => L("הכרום שלך", "Your Chrome"),
  computer: () => L("מסך המחשב", "The computer's screen"),
};

/** The live view. */
export function ControlLive() {
  const [st, setSt] = useState<LiveState | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<LiveSource | undefined>();
  const [frame, setFrame] = useState(0);
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  const ticks = useRef(0);
  /** Read again now (after starting, answering or stopping a computer task). */
  const [kick, setKick] = useState(0);
  // One read every 2 seconds while the page is on screen; `watch=1` tells the computer a screen shows the approvals.
  useEffect(() => {
    let alive = true;
    const read = () =>
      !document.hidden &&
      api<LiveState>("/api/control/live?watch=1").then(
        (s) => {
          if (!alive) return;
          setSt(s);
          setError("");
          // A new picture every read while the agent works, every third (about 6 s) while it is idle: fewer pictures
          // over a phone's connection.
          ticks.current++;
          if (s.browser.active || s.computer.active || ticks.current % 3 === 0) setFrame((n) => n + 1);
        },
        (e: Error) => alive && setError(e.message),
      );
    void read();
    const id = setInterval(read, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [kick]);

  const source = st ? pickSource(st, picked) : undefined;
  // A picture that failed (no tab, a Chrome tab let go) is tried again with the next one.
  useEffect(() => {
    setMissing(false);
  }, [source, frame]);
  const active = !!st && (st.browser.active || st.computer.active);
  const last = st?.log.at(-1);
  // Pictures as wide as the phone's screen in real pixels, at most 1280.
  const width = Math.min(1280, Math.round(window.innerWidth * (window.devicePixelRatio || 1)));
  const shot = source === "pane" ? `/api/browser/pane/shot?n=${frame}` : source === "chrome" ? `/api/browser/chrome/shot?w=${width}&n=${frame}` : source === "computer" ? `/api/computer/screen?w=${width}&f=${frame}` : "";

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) toast(done);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  const stopAll = () =>
    run(
      () => Promise.all([api("/api/browser/stop", { method: "POST" }), api("/api/computer/stop", { method: "POST" })]).then(() => setSt((s) => (s ? { ...s, browser: { ...s.browser, active: false }, computer: { ...s.computer, active: false } } : s))),
      L("נעצר: הדפדפן והמחשב.", "Stopped: the browser and the computer."),
    );
  const setMode = (mode: "manual" | "auto") => run(() => api<{ mode: LiveState["mode"] }>("/api/control/settings", { method: "PUT", body: { mode } }).then((r) => setSt((s) => (s ? { ...s, mode: r.mode } : s))));
  const setPause = (on: boolean) => run(() => api<{ paused: boolean }>("/api/control/pause", { method: "POST", body: { on } }).then((r) => setSt((s) => (s ? { ...s, paused: r.paused } : s))));

  if (!st) return <section className="stack">{error ? <p className="error small">{error}</p> : <p className="muted">{L("טוען…", "Loading…")}</p>}</section>;
  const sources = liveSources(st);
  return (
    <section className="stack cl-live" aria-label={L("מה הסוכן עושה", "What the agent is doing")}>
      <button type="button" className={`cl-stop${active ? " on" : ""}`} disabled={busy} onClick={() => void stopAll()} title={L("עוצר כל פעולה בדפדפן ובמחשב של כל הצ׳אטים וסוכני העזר (גם Ctrl+Alt+Esc במחשב)", "Stops every browser and computer action of every chat and helper (also Ctrl+Alt+Esc on the computer)")}>
        ■ {L("עצור הכול", "Stop everything")}
      </button>

      <div className="cl-toggles">
        <div className="cl-seg" role="radiogroup" aria-label={L("מצב", "Mode")}>
          {(["manual", "auto"] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={st.mode === m} className={st.mode === m ? "on" : ""} disabled={busy} onClick={() => void setMode(m)}>
              {m === "manual" ? L("ידני", "Manual") : L("אוטומטי", "Auto")}
            </button>
          ))}
        </div>
        <label className="cl-pause">
          <input type="checkbox" checked={st.paused} disabled={busy} onChange={(e) => void setPause(e.target.checked)} />
          <span>{st.paused ? L("מושהה: לחצו כדי להמשיך", "Paused: tap to resume") : L("השהיית השליטה", "Pause control")}</span>
        </label>
      </div>
      <p className="muted small cl-mode-help" dir="auto">
        {st.mode === "skip"
          ? L("מצב דילוג פעיל (מההגדרות): פעולות רצות בלי לשאול. לחצו ידני או אוטומטי כדי לחזור לשאול.", "Skip is on (from Settings): actions run without asking. Tap Manual or Auto to be asked again.")
          : st.mode === "auto"
            ? L("אוטומטי: בודק מקומי מאשר פעולות רגילות, והשאר מגיע אליך.", "Auto: a local reviewer lets ordinary actions run; the rest come to you.")
            : L("ידני: כל פעולה מחכה לאישור שלך.", "Manual: every action waits for your yes.")}
      </p>

      <p className={`cl-now${active ? " on" : ""}${st.paused ? " paused" : ""}`} role="status" dir="auto">
        <span className="cl-k">{st.paused ? L("מושהה", "Paused") : active ? L("עכשיו", "Now") : L("אחרון", "Last")}</span>{" "}
        {st.paused ? L("פעולות חדשות בדפדפן ובמחשב מחכות עד שתמשיכו. הצ׳אטים ממשיכים.", "New browser and computer actions wait until you resume. The chats go on.") : last ? lineText(last) : L("הסוכן עוד לא השתמש בדפדפן או במחשב.", "The agent has not used the browser or the computer yet.")}
      </p>

      <ControlTaskCard task={st.task} enabled={st.computer.enabled} onChange={() => setKick((k) => k + 1)} />

      {st.approvals.map((a) => (
        <div key={(a.ev as ApprovalEv).requestId} className="cl-approval">
          <a className="small" href={`#/c/${a.conversationId}`} dir="auto">{a.title || L("צ׳אט", "Chat")}</a>
          <ControlApproval convId={a.conversationId} ev={a.ev as ApprovalEv} pending />
        </div>
      ))}

      {sources.length > 0 ? (
        <div className="cl-view">
          {sources.length > 1 && (
            <div className="cl-tabs" role="tablist" aria-label={L("מה להציג", "What to show")}>
              {sources.map((x) => (
                <button key={x} type="button" role="tab" aria-selected={source === x} className={source === x ? "on" : ""} onClick={() => setPicked(x)}>
                  {SOURCE_WORDS[x]()}
                </button>
              ))}
            </div>
          )}
          {source && !missing ? (
            <img className="cl-shot" src={withToken(shot)} alt={SOURCE_WORDS[source]()} onError={() => setMissing(true)} onLoad={() => setMissing(false)} />
          ) : (
            <p className="muted small">{source === "pane" ? L("אין לשונית פתוחה בדפדפן של KesherAI.", "No tab is open in KesherAI's browser.") : L("אין תמונה כרגע.", "No picture right now.")}</p>
          )}
        </div>
      ) : (
        <p className="muted small" dir="auto">{L("אין מה להציג: הדפדפן של KesherAI רץ באפליקציה במחשב, ושליטה במחשב כבויה.", "Nothing to show: KesherAI's browser runs in the app on the computer, and computer control is off.")}</p>
      )}

      {error && <p className="error small">{error}</p>}

      {st.log.length > 0 && (
        <details className="cl-log-box" open>
          <summary>{L("יומן הפעולות", "Action log")}</summary>
          <ol className="cl-log small">
            {[...st.log].reverse().slice(0, 25).map((a, i) => (
              <li key={`${a.at}-${i}`} className={a.ok ? "" : "bad"} dir="auto">
                <time className="muted" dir="ltr">{new Date(a.at).toLocaleTimeString(getLocale() === "he" ? "he-IL" : "en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>{" "}
                <span aria-hidden="true">{a.kind === "browser" ? "🌐" : "🖥"}</span> {lineText(a)}
                {a.note ? <span className="muted"> — {a.note}</span> : null}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
