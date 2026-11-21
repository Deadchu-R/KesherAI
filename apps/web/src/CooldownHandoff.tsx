import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";
import { Select } from "./ui/Select";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** GET /api/cooldown (the server's cooldown-handoff.ts). */
interface HandoffView {
  cooldown?: { until: number; since: number; source: "manual" | "claude" | "error"; reason?: string };
  cooling: boolean;
  phase: "idle" | "working";
  handed: Array<{ boardId: string; title: string; status: "working" | "done" | "blocked" | "returned" }>;
  today: { date: string; used: number };
  retryAt?: number;
  settings: { enabled: boolean; repo: string; check: string; dailyCap: number; batch: number };
}

/** "18:30" in the user's time. */
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * Reads the hand-off's state every `ms` while the page is visible (null until the first answer, or when the server
 * has no hand-off: a worker, or an older PC in remote).
 *
 * @param ms - How often to read.
 */
function useHandoff(ms: number): [HandoffView | null, (v: HandoffView) => void] {
  const [v, setV] = useState<HandoffView | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => !document.hidden && void api<HandoffView>("/api/cooldown").then((r) => alive && setV(r), () => alive && setV(null));
    load();
    const id = window.setInterval(load, ms);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [ms]);
  return [v, setV];
}

/**
 * The banner on every page while the local model carries tasks because Claude is cooling down: until when, and
 * what it is working on. Works the same in remote (it is a server call).
 */
export function CooldownBanner() {
  const [v] = useHandoff(60_000);
  if (!v?.cooling || v.phase !== "working" || !v.cooldown) return null;
  const now = v.handed.filter((t) => t.status === "working");
  return (
    <p className="guard-banner row cooldown-banner" role="status">
      <span className="grow" dir="auto">
        🌙 {L(`רץ על המודל המקומי כי Claude בקירור עד ${hhmm(v.cooldown.until)}`, `Running on the local model because Claude is cooling down until ${hhmm(v.cooldown.until)}`)}
        {now.length > 0 && <> · <bdi>{now.map((t) => t.title).join(", ")}</bdi></>}
      </span>
      <a className="btn" href="#/self-work">{L("פרטים", "Details")}</a>
    </p>
  );
}

/**
 * Self-work's "When Claude cools down" card: on/off, the project and its check (chosen on the computer), tasks per
 * day and per run, Claude's state with "Claude is cooling down for…" and "Claude is back", and what the local model
 * took in this cooldown. Tasks are marked "Local ok" on the board (or `local_ok: true` in an inbox task).
 *
 * @param props.folder - The project chosen on the code screen (offered as the hand-off's project).
 */
export function CooldownHandoffCard({ folder }: { folder?: string }) {
  const [v, setV] = useHandoff(15_000);
  const [busy, setBusy] = useState(false);
  if (!v) return null;
  const s = v.settings;
  const put = (body: Record<string, unknown>) => {
    setBusy(true);
    void api<HandoffView>("/api/cooldown/settings", { method: "PUT", body }).then(setV, (e: Error) => toast(e.message)).finally(() => setBusy(false));
  };
  const cool = (minutes: number) => {
    setBusy(true);
    void api<HandoffView>("/api/cooldown", { method: "PUT", body: { minutes } }).then(setV, (e: Error) => toast(e.message)).finally(() => setBusy(false));
  };
  const back = () => {
    setBusy(true);
    void api<HandoffView>("/api/cooldown", { method: "DELETE" }).then(setV, (e: Error) => toast(e.message)).finally(() => setBusy(false));
  };
  const STATUS: Record<HandoffView["handed"][number]["status"], string> = {
    working: L("🤖 עובד", "🤖 Working"),
    done: L("✅ בוצע", "✅ Done"),
    blocked: L("✋ חסום", "✋ Blocked"),
    returned: L("↩ חזר ל-Claude", "↩ Back to Claude"),
  };
  return (
    <section className="card stack cooldown-card">
      <h3>{L("🌙 כש-Claude בקירור", "🌙 When Claude cools down")}</h3>
      <p className="muted small">
        {L(
          "כש-Claude נגמר לו השימוש או שהוא מוגבל, המשימות שסומנו \"מקומי בסדר\" עוברות למודל המקומי אחת אחרי השנייה, וחוזרות ל-Claude כשהוא חוזר. משימות Antigravity אף פעם לא עוברות.",
          "When Claude is out of usage or rate-limited, tasks marked \"Local ok\" go to the local model one after another, and go back to Claude when it returns. Antigravity tasks never do.",
        )}
      </p>
      <label className="row check-row">
        <input type="checkbox" checked={s.enabled} disabled={busy} onChange={(e) => put({ enabled: e.target.checked })} />
        <span className="grow">{L("המודל המקומי ממשיך כש-Claude בקירור", "The local model carries on while Claude cools down")}</span>
      </label>
      <p className="small cooldown-repo" dir="auto">
        <span className="muted">{L("פרויקט:", "Project:")}</span> <bdi dir="ltr">{s.repo || L("לא נבחר", "not chosen")}</bdi>
        {folder && folder !== s.repo && <button type="button" disabled={busy} onClick={() => put({ repo: folder })}>{L("השתמש בפרויקט הזה", "Use this project")}</button>}
      </p>
      <div className="row wrap">
        <label className="small row">
          {L("משימות ביום", "Tasks a day")}
          <Select value={s.dailyCap} disabled={busy} onChange={(e) => put({ dailyCap: Number(e.target.value) })}>
            {[2, 4, 6, 10, 20].map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
        </label>
        <label className="small row">
          {L("בכל ריצה", "Per run")}
          <Select value={s.batch} disabled={busy} onChange={(e) => put({ batch: Number(e.target.value) })}>
            {[1, 2, 3, 5].map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
        </label>
        <span className="muted small">{L(`היום: ${v.today.used}/${s.dailyCap}`, `Today: ${v.today.used}/${s.dailyCap}`)}</span>
      </div>
      <div className="row wrap">
        {v.cooling && v.cooldown ? (
          <>
            <span className="grow small" dir="auto">{L(`Claude בקירור עד ${hhmm(v.cooldown.until)}`, `Claude is cooling down until ${hhmm(v.cooldown.until)}`)}</span>
            <button type="button" disabled={busy} onClick={back}>{L("Claude חזר", "Claude is back")}</button>
          </>
        ) : (
          <>
            <span className="grow small muted">{L("Claude זמין", "Claude is available")}</span>
            <Select value={0} disabled={busy} aria-label={L("Claude בקירור ל…", "Claude is cooling down for…")} onChange={(e) => Number(e.target.value) > 0 && cool(Number(e.target.value))}>
              <option value={0}>{L("Claude בקירור ל…", "Claude cools down for…")}</option>
              <option value={60}>{L("שעה", "1 hour")}</option>
              <option value={5 * 60}>{L("5 שעות", "5 hours")}</option>
              <option value={24 * 60}>{L("יום", "1 day")}</option>
              <option value={3 * 24 * 60}>{L("3 ימים", "3 days")}</option>
            </Select>
          </>
        )}
      </div>
      {v.retryAt !== undefined && v.retryAt > Date.now() && <p className="error small" dir="auto">{L(`המודל המקומי לא הצליח להתחיל; ינסה שוב ב-${hhmm(v.retryAt)}`, `The local model could not start; it tries again at ${hhmm(v.retryAt)}`)}</p>}
      {v.handed.length > 0 && (
        <ul className="cooldown-tasks small">
          {v.handed.slice(-10).map((t) => (
            <li key={t.boardId} dir="auto"><span>{STATUS[t.status]}</span> <bdi>{t.title}</bdi></li>
          ))}
        </ul>
      )}
    </section>
  );
}
