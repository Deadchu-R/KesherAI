/**
 * Settings > Agents: "Agents' work" (design board HubAgentsWork). What Claude's helper agents did in the last 7 days,
 * read from the commits on main that carry a `Claude-Session:` trailer (GET /api/agents/claude-work; no GitHub token,
 * no tokens spent). One card per session, its commits as rows: title, files, time and an "in 0.6.NNN" chip or "not
 * released yet"; a row opens the commit on GitHub. Works in remote too (the same route through the phone link).
 */
import { useEffect, useState } from "react";
import { splitToday, type ClaudeSession } from "@kesher/shared";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

type Commit = ClaudeSession["commits"][number] & { url?: string };
type Session = Omit<ClaudeSession, "commits"> & { commits: Commit[] };

/** Time of a commit: the clock today, the weekday and clock this week. */
function when(at: number, now: number): string {
  const d = new Date(at);
  const lang = getLocale() === "he" ? "he-IL" : "en-GB";
  const clock = d.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
  return now - at < 86_400_000 && d.getDate() === new Date(now).getDate() ? clock : `${d.toLocaleDateString(lang, { weekday: "short" })} ${clock}`;
}

/** One session: its title, how many commits, and the commits as rows. */
function SessionCard({ s, now }: { s: Session; now: number }) {
  const released = s.commits.filter((c) => c.release).length;
  return (
    <div className="cw-session">
      <div className="cw-head">
        <b dir="auto">{s.title}</b>
        <span className="muted small">{L(`${s.commits.length} קומיטים`, `${s.commits.length} commits`)} · {released === s.commits.length ? L("כולם בגרסה", "all released") : L(`${s.commits.length - released} עוד לא בגרסה`, `${s.commits.length - released} not released yet`)}</span>
      </div>
      {s.commits.map((c) => {
        const body = (
          <>
            <span className="cw-title" dir="auto">{c.title}</span>
            <span className="muted small cw-meta">{L(`${c.files} קבצים`, `${c.files} files`)} · {when(c.at, now)}</span>
            <span className={c.release ? "chip cw-rel" : "chip cw-pending"}>{c.release ? L(`בגרסה ${c.release}`, `in ${c.release}`) : L("עוד לא בגרסה", "not released yet")}</span>
          </>
        );
        return c.url ? <a key={c.sha} className="cw-row" href={c.url} target="_blank" rel="noopener noreferrer">{body}</a> : <div key={c.sha} className="cw-row">{body}</div>;
      })}
    </div>
  );
}

/** The section. */
export function ClaudeWorkSection() {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    void api<{ sessions: Session[] }>("/api/agents/claude-work").then((r) => setSessions(r.sessions), (e: Error) => setErr(e.message));
  }, []);
  const now = Date.now();
  const { today, week } = splitToday(sessions ?? [], now);
  const group = (title: string, list: ClaudeSession[]) => list.length > 0 && (
    <div className="cw-group">
      <h3>{title}</h3>
      {(list as Session[]).map((s) => <SessionCard key={s.url} s={s} now={now} />)}
    </div>
  );
  return (
    <section className="card stack claude-work" id="claude-work">
      <h2>🧾 {L("העבודה של הסוכנים", "Agents' work")}</h2>
      <p className="muted small">{L("מה עוזרי Claude עשו ב-7 הימים האחרונים, לפי הקומיטים ב-main. בלי טוקנים ובלי מפתח GitHub.", "What Claude's helper agents did in the last 7 days, from the commits on main. No tokens and no GitHub key.")}</p>
      {err ? <p className="error small">{err}</p> : sessions === null ? <p className="muted small">…</p> : sessions.length === 0 ? <p className="muted small">{L("עוד אין עבודה של סוכנים השבוע (או שלא הוגדרה תיקיית פרויקט בתיבת המשימות).", "No agent work this week yet (or no project folder is set in the task inbox).")}</p> : (
        <>
          {group(L("היום", "Today"), today)}
          {group(L("השבוע", "This week"), week)}
        </>
      )}
    </section>
  );
}
