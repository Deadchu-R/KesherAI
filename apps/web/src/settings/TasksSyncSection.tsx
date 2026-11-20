import { useEffect, useState } from "react";
import { api, isRemote } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** `GET /api/tasks-sync` (packages/core/src/tasks-sync.ts). */
interface TasksSyncStatus {
  enabled: boolean;
  /** Claude's work list is shown on every device (default on). */
  workList: boolean;
  configured: boolean;
  connected: boolean;
  needsReconnect: boolean;
  syncing: boolean;
  lastSync: string | null;
  lastError: string | null;
  counts: { tasks: number; pending: number; received: number; workList: number };
}

/** "5 min ago" style time. */
function ago(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (min < 1) return L("עכשיו", "just now");
  const n = min < 120 ? `${min} ${L("דק׳", "min")}` : `${Math.round(min / 60)} ${L("שע׳", "h")}`;
  return L(`לפני ${n}`, `${n} ago`);
}

/**
 * Settings → Phone and remote access → Tasks on all your devices: keeps the task inbox in a hidden KesherAI folder
 * of the user's own Google Drive, so the phone and the hub page see the same tasks. A switch, a status line and
 * "Reconnect Google" when the Drive permission is missing. Turning on (and the Google consent) happens only on the PC;
 * the phone sees the status, can sync now and can turn it off.
 */
export function TasksSyncSection() {
  const [s, setS] = useState<TasksSyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const remote = isRemote();
  const load = () => void api<TasksSyncStatus>("/api/tasks-sync").then(setS, () => undefined);
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
      load();
    }
  };
  if (!s || !s.configured) return null;
  /** Opens Google's consent page when the server returns one (only on the PC). */
  const consent = async (r: { url?: string }) => {
    if (r.url) window.open(r.url, "_blank", "noopener");
  };
  const toggle = (on: boolean) => run(async () => consent(await api<{ url?: string }>("/api/tasks-sync", { method: "POST", body: { enabled: on } })));
  const reconnect = () => run(async () => consent(await api<{ url?: string }>("/api/tasks-sync/reconnect", { method: "POST" })));
  const showWorkList = (on: boolean) => run(() => api("/api/tasks-sync", { method: "POST", body: { workList: on } }));
  const syncNow = () => run(() => api("/api/tasks-sync/sync", { method: "POST" }));
  const cantTurnOn = !s.enabled && (remote || !s.connected);

  const state = !s.enabled
    ? L("כבוי", "Off")
    : !s.connected
      ? L("צריך להתחבר ל-Google במחשב", "Sign in to Google on the PC")
      : s.needsReconnect
        ? L("חסרה הרשאה ל-Google Drive", "Google Drive permission is missing")
        : s.syncing
          ? L("מסנכרן…", "Syncing…")
          : s.lastError
            ? L("הסנכרון האחרון נכשל, ינסה שוב", "The last sync failed, will retry")
            : s.lastSync
              ? L(`סונכרן ${ago(s.lastSync)}`, `Synced ${ago(s.lastSync)}`)
              : L("עוד לא סונכרן", "Not synced yet");
  const good = s.enabled && s.connected && !s.needsReconnect && !s.lastError;

  return (
    <section className="card stack tasks-sync" id="tasks-sync">
      <div className="row">
        <h2 className="grow">{L("🔄 המשימות בכל המכשירים", "🔄 Tasks on all your devices")}</h2>
        <label className="row small" title={cantTurnOn ? (remote ? L("מפעילים במחשב", "Turn on at the PC") : L("קודם להתחבר ל-Google", "Sign in to Google first")) : undefined}>
          <input type="checkbox" checked={s.enabled} disabled={busy || cantTurnOn} onChange={(e) => void toggle(e.target.checked)} /> {L("פעיל", "On")}
        </label>
      </div>
      <p className="muted small">
        {L(
          "המשימות של תיבת המשימות נשמרות בתיקייה נסתרת של KesherAI ב-Google Drive שלך, נעולות במפתח שנשמר שם גם הוא. כך הטלפון, דף המרכז והמחשב רואים את אותן משימות, גם כשהמחשב כבוי. מי שנכנס לחשבון Google שלך יכול לפתוח אותן; המרכז (Cloudflare) לא רואה אותן.",
          "The task inbox's tasks are kept in a hidden KesherAI folder in your Google Drive, locked with a key kept there too. So your phone, the hub page and this PC see the same tasks, even when the PC is off. Someone signed in to your Google account could open them; the hub (Cloudflare) never sees them.",
        )}
      </p>
      <div className="row wrap" role="status">
        <span className={`dot ${good ? "on" : "off"}`} aria-hidden="true" />
        <span>{state}</span>
        {s.enabled && s.connected && !s.needsReconnect && (
          <span className="muted small">
            {[L(`${s.counts.tasks} משימות ב-Drive`, `${s.counts.tasks} tasks in Drive`), s.counts.received ? L(`${s.counts.received} התקבלו ממכשירים אחרים`, `${s.counts.received} from other devices`) : "", s.counts.pending ? L(`${s.counts.pending} ממתינות לשליחה`, `${s.counts.pending} waiting to send`) : ""].filter(Boolean).join(" · ")}
          </span>
        )}
      </div>
      {s.enabled && (
        <label className="row small tasks-sync-wl">
          <input type="checkbox" checked={s.workList !== false} disabled={busy} onChange={(e) => void showWorkList(e.target.checked)} />
          <span className="grow">
            {L("להציג את רשימת העבודה של Claude", "Show Claude's work list")}
            <span className="muted">
              {" · "}
              {s.workList !== false && s.counts.workList
                ? L(`${s.counts.workList} פריטים, מתעדכנת כל 15 דקות`, `${s.counts.workList} items, updated every 15 minutes`)
                : L("מ-docs/WORK_LIST.md בפרויקט של תיבת המשימות, בלשונית המשימות של המרכז ובטלפון", "From docs/WORK_LIST.md in the task inbox's project, in the hub's Tasks tab and on the phone")}
            </span>
          </span>
        </label>
      )}
      {s.enabled && s.lastError && !s.needsReconnect && <span className="bad small" dir="auto">{s.lastError}</span>}
      {remote && !s.enabled && <span className="muted small">{L("מפעילים את זה במחשב (צריך לאשר את Google שם).", "Turn this on at the PC (Google asks for permission there).")}</span>}
      {!remote && !s.connected && <span className="muted small">{L("קודם להתחבר ל-Google (כפתור החשבון למעלה).", "Sign in to Google first (the account button at the top).")}</span>}
      <div className="row wrap">
        {s.enabled && s.needsReconnect && (remote ? (
          <span className="small">{L("כדי לתקן, לחץ \"חבר מחדש את Google\" במחשב.", "To fix it, tap \"Reconnect Google\" on the PC.")}</span>
        ) : (
          <button type="button" className="primary" disabled={busy} onClick={() => void reconnect()}>{L("חבר מחדש את Google", "Reconnect Google")}</button>
        ))}
        {s.enabled && s.connected && !s.needsReconnect && (
          <button type="button" disabled={busy || s.syncing} onClick={() => void syncNow()}>{L("סנכרן עכשיו", "Sync now")}</button>
        )}
      </div>
    </section>
  );
}
