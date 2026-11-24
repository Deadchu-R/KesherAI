import { useEffect, useState } from "react";
import { claudeWindowPercent, type ClaudeState, type InboxState } from "@kesher/shared";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** A time for a card: the time today, else the day and the time. */
export function claudeWhen(ms: number): string {
  const loc = getLocale() === "he" ? "he-IL" : "en-GB";
  return new Date(ms).toDateString() === new Date().toDateString() ? new Date(ms).toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit", hour12: false }) : new Date(ms).toLocaleString(loc, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * "Claude 5h N% · week M%" from Claude Code's last reading (the whole account, the Claude app included), with when it
 * was read; "unknown" before the first reading or once a window reset.
 *
 * @param p.s - Claude Code's state.
 * @param p.max - The thresholds, to colour a window at or above its limit.
 */
export function ClaudeQuotaLine({ s, max }: { s: ClaudeState; max?: { fiveHour: number; week: number } }) {
  const now = Date.now();
  const five = claudeWindowPercent(s.quota?.fiveHour, now);
  const week = claudeWindowPercent(s.quota?.sevenDay, now);
  const pct = (v: number | undefined, limit: number | undefined) => (v === undefined ? <span className="muted">{L("לא ידוע", "unknown")}</span> : <b className={limit !== undefined && v >= limit ? "tinbox-err" : ""}>{v}%</b>);
  return (
    <span className="small claude-quota" dir="auto">
      ✳ Claude 5h {pct(five, max?.fiveHour)} · {L("שבוע", "week")} {pct(week, max?.week)}
      {s.quota && <span className="muted"> · {L(`נקרא ב-${claudeWhen(s.quota.at)}`, `read ${claudeWhen(s.quota.at)}`)}</span>}
    </span>
  );
}

/**
 * Settings › Connections › Claude Code: whether the `claude` program is on this PC (and its version), whether it is
 * signed in with the user's own Claude subscription (an API key is refused), the subscription's 5-hour and weekly
 * use, and why tasks are held back. KesherAI never signs in for the user: the card says how. Works from the phone.
 */
export function ClaudeCodeCard() {
  const [s, setS] = useState<ClaudeState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<InboxState>("/api/task-inbox").then((x) => setS(x.claude ?? null), () => undefined);
  }, []);
  if (!s) return null;
  const check = () => {
    setBusy(true);
    void api<ClaudeState>("/api/task-inbox/claude/check", { method: "POST" }).then(setS, (e) => toast((e as Error).message)).finally(() => setBusy(false));
  };
  const login = !s.installed ? null : s.account === "api-key" ? "bad" : s.loggedIn ? "good" : s.loggedIn === false ? "warn" : null;
  return (
    <section className="card stack claude-card">
      <div className="row wrap">
        <h2 className="grow">✳ Claude Code</h2>
        <span className={`pill ${s.installed ? "good" : "warn"}`} dir="ltr">{s.installed ? `${L("מותקן", "Installed")} · v${s.version ?? "?"}` : L("לא מותקן", "Not installed")}</span>
        {login && <span className={`pill ${login}`}>{login === "good" ? L(`מחובר${s.plan ? ` · ${s.plan}` : ""}`, `Signed in${s.plan ? ` · ${s.plan}` : ""}`) : login === "bad" ? L("מפתח API: לא מותר", "API key: not allowed") : L("לא מחובר", "Not signed in")}</span>}
      </div>
      <p className="small muted">{L("משימות מתיבת המשימות רצות ב-Claude Code במחשב הזה, עם המנוי שלך. הן משתמשות באותן מגבלות Max כמו אפליקציית Claude שלך.", "Task-inbox tasks run in Claude Code on this PC, with your own subscription. They use the same Max limits as your Claude app.")}</p>
      {!s.installed && <p className="small tinbox-err" dir="auto">{L("התקן את Claude Code (code.claude.com) ואז לחץ \"בדוק שוב\".", "Install Claude Code (code.claude.com), then tap \"Check again\".")}</p>}
      {s.installed && s.loggedIn === false && <p className="small tinbox-err" dir="auto">{L("פתח טרמינל, הרץ claude והתחבר עם חשבון Claude שלך. KesherAI לא מתחבר בשבילך ולא קורא את פרטי הכניסה.", "Open a terminal, run claude and sign in with your Claude account. KesherAI never signs in for you or reads the login.")}</p>}
      {s.account === "api-key" && <p className="small tinbox-err" dir="auto">{L("Claude Code מחובר במפתח API (תשלום לפי שימוש). KesherAI מריץ אותו רק עם המנוי: הרץ claude ואז ‎/login עם חשבון Claude.", "Claude Code is signed in with an API key (pay per use). KesherAI runs it only with your subscription: run claude, then /login with your Claude account.")}</p>}
      <ClaudeQuotaLine s={s} />
      {s.blocked && <p className="small tinbox-err" dir="auto">⏸ {s.blocked.why}{s.blocked.until ? L(` (עד ${claudeWhen(s.blocked.until)})`, ` (until ${claudeWhen(s.blocked.until)})`) : ""}</p>}
      <div className="row wrap">
        <button type="button" disabled={busy} onClick={check}>{busy ? L("בודק…", "Checking…") : L("בדוק שוב", "Check again")}</button>
        <a className="small" href="#/settings/inbox">{L("הגדרות › תיבת משימות › Claude Code", "Settings › Task inbox › Claude Code")}</a>
      </div>
    </section>
  );
}
