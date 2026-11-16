import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale } from "../i18n";
import { toast, useLibrary } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Dl { id: string; label: string; status: string; received: number; total?: number; speed: number }
interface Run { status: string; goal: string; items?: unknown[]; convId: string }
interface Routine { id?: string; name: string; running?: boolean }

/** Everything the computer is doing now, in one place. */
interface Now {
  activity: Record<string, "running" | "waiting">;
  approvals: Array<{ kind: string; conversationId: string; title: string; requestId: string }>;
  downloads: Dl[];
  selfWork: Run | null;
  routines: Routine[];
  jobs: Array<{ id: string; key: string; startedAt: number }>;
  update: { running: boolean; step?: string } | null;
}

const ACTIVE = new Set(["queued", "downloading", "verifying", "paused"]);
const mb = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);
const since = (ms: number) => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  return m < 60 ? L(`${m} דק׳`, `${m} min`) : L(`${Math.floor(m / 60)} ש׳ ${m % 60} דק׳`, `${Math.floor(m / 60)} h ${m % 60} min`);
};

/** Reads each part on its own: one that fails (an older computer) leaves the rest. */
async function readNow(): Promise<Now> {
  const get = <T,>(path: string, fallback: T) => api<T>(path).catch(() => fallback);
  const [activity, approvals, downloads, sw, routines, jobs, update] = await Promise.all([
    get<Now["activity"]>("/api/conversations/activity", {}),
    get<Now["approvals"]>("/api/approvals", []),
    get<Dl[]>("/api/downloads", []),
    get<{ run: Run | null }>("/api/self-work", { run: null }),
    get<Routine[]>("/api/routines", []),
    get<{ running: Now["jobs"] }>("/api/jobs", { running: [] }),
    get<Now["update"]>("/api/updates/progress", null),
  ]);
  return {
    activity,
    approvals: Array.isArray(approvals) ? approvals : [],
    downloads: (Array.isArray(downloads) ? downloads : []).filter((d) => ACTIVE.has(d.status)),
    selfWork: sw.run && (sw.run.status === "running" || sw.run.status === "waiting") ? sw.run : null,
    routines: (Array.isArray(routines) ? routines : []).filter((r) => r.running),
    jobs: jobs.running ?? [],
    update: update?.running ? update : null,
  };
}

/**
 * "Tasks": what runs on the computer now (chats answering or waiting, approvals, downloads, self-work, routines, long
 * builds, an update), each with Open and, where it makes sense, Stop. Made for the phone (390 px) and the computer.
 */
export function TasksPage() {
  const [now, setNow] = useState<Now | null>(null);
  const { conversations } = useLibrary();
  const load = () => void readNow().then(setNow);
  useEffect(() => {
    load();
    const id = setInterval(() => {
      if (!document.hidden) load();
    }, 4000);
    return () => clearInterval(id);
  }, []);
  const act = (p: Promise<unknown>, done: string) =>
    void p.then(
      () => {
        toast(done);
        setTimeout(load, 600);
      },
      (e: Error) => toast(e.message),
    );
  const titleOf = (id: string) => conversations.find((c) => c.id === id)?.title || L("צ'אט", "Chat");
  if (!now) return <div className="page"><p className="muted">…</p></div>;
  // A chat waiting for an approval is listed once, as the approval.
  const chats = Object.entries(now.activity).filter(([id]) => !now.approvals.some((a) => a.conversationId === id));
  const count = chats.length + now.approvals.length + now.downloads.length + (now.selfWork ? 1 : 0) + now.routines.length + now.jobs.length + (now.update ? 1 : 0);
  return (
    <div className="page tasks-page">
      <h1>{L("משימות", "Tasks")}</h1>
      <p className="muted small">{L("מה שרץ עכשיו במחשב. מתעדכן לבד.", "What runs on the computer now. Updates by itself.")}</p>
      {count === 0 && <p className="muted tasks-empty">{L("שום דבר לא רץ עכשיו. צ'אטים, הורדות, עבודה עצמית ושגרות יופיעו כאן כשהם רצים.", "Nothing runs now. Chats, downloads, self-work and routines show here while they run.")}</p>}
      <ul className="tasks-list">
        {now.approvals.map((a) => (
          <li key={a.requestId} className="task-item waiting">
            <span className="task-dot" aria-hidden="true" />
            <span className="grow">
              <b dir="auto">{a.title || titleOf(a.conversationId)}</b>
              <small>{L("מחכה לאישור שלך", "Waiting for your approval")}</small>
            </span>
            <a className="button primary small" href="#/inbox">{L("לאישור", "Review")}</a>
          </li>
        ))}
        {chats.map(([id, st]) => (
          <li key={id} className={`task-item ${st}`}>
            <span className="task-dot" aria-hidden="true" />
            <span className="grow">
              <b dir="auto">{titleOf(id)}</b>
              <small>{st === "running" ? L("עונה עכשיו", "Answering now") : L("מחכה לך", "Waiting for you")}</small>
            </span>
            <a className="button small" href={`#/c/${id}`}>{L("פתח", "Open")}</a>
            {st === "running" && <button type="button" className="small" onClick={() => act(api(`/api/conversations/${id}/stop`, { method: "POST" }), L("נעצר", "Stopped"))}>{L("עצור", "Stop")}</button>}
          </li>
        ))}
        {now.selfWork && (
          <li className={`task-item ${now.selfWork.status}`}>
            <span className="task-dot" aria-hidden="true" />
            <span className="grow">
              <b dir="auto">🤖 {now.selfWork.goal.slice(0, 90)}</b>
              <small>{L(`עבודה עצמית · ${now.selfWork.items?.length ?? 0} פריטים`, `Self-work · ${now.selfWork.items?.length ?? 0} items`)}</small>
            </span>
            <a className="button small" href="#/self-work">{L("פתח", "Open")}</a>
            <button type="button" className="small" onClick={() => confirm(L("לעצור את העבודה העצמית אחרי הפריט הנוכחי?", "Stop self-work after the current item?")) && act(api("/api/self-work/stop", { method: "POST" }), L("נעצר", "Stopped"))}>{L("עצור", "Stop")}</button>
          </li>
        )}
        {now.downloads.map((d) => {
          const pct = d.total ? Math.floor((d.received / d.total) * 100) : undefined;
          return (
            <li key={d.id} className={`task-item ${d.status === "paused" ? "waiting" : "running"}`}>
              <span className="task-dot" aria-hidden="true" />
              <span className="grow">
                <b dir="auto">⬇ {d.label}</b>
                <small dir="ltr">{pct !== undefined ? `${pct}% · ` : ""}{mb(d.received)}{d.total ? ` / ${mb(d.total)}` : ""}{d.speed ? ` · ${mb(d.speed)}/s` : ""}</small>
                {pct !== undefined && <progress max={100} value={pct} aria-label={d.label} />}
              </span>
              {d.status !== "paused" && d.status !== "verifying" && <button type="button" className="small" onClick={() => act(api(`/api/downloads/${d.id}/pause`, { method: "POST" }), L("הושהה", "Paused"))}>{L("השהה", "Pause")}</button>}
            </li>
          );
        })}
        {now.routines.map((r) => (
          <li key={r.id ?? r.name} className="task-item running">
            <span className="task-dot" aria-hidden="true" />
            <span className="grow">
              <b dir="auto">⏰ {r.name}</b>
              <small>{L("שגרה רצה", "Routine running")}</small>
            </span>
            <a className="button small" href="#/pipelines">{L("פתח", "Open")}</a>
          </li>
        ))}
        {now.jobs.map((j) => (
          <li key={j.id} className="task-item running">
            <span className="task-dot" aria-hidden="true" />
            <span className="grow">
              <b dir="auto">🔨 {j.key}</b>
              <small>{L(`בנייה ארוכה · ${since(j.startedAt)}`, `Long build · ${since(j.startedAt)}`)}</small>
            </span>
          </li>
        ))}
        {now.update && (
          <li className="task-item running">
            <span className="task-dot" aria-hidden="true" />
            <span className="grow">
              <b>⟳ {L("עדכון", "Update")}</b>
              <small dir="auto">{now.update.step}</small>
            </span>
            <a className="button small" href="#/updates">{L("פתח", "Open")}</a>
          </li>
        )}
      </ul>
    </div>
  );
}
