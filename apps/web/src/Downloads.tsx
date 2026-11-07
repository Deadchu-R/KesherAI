import { useEffect, useState } from "react";
import { api, withToken } from "./api";
import { getLocale, t, type StringKey } from "./i18n";

/** One download, as the server reports it. */
export interface Job { id: string; label: string; status: string; received: number; total?: number; speed: number; error?: string }

/**
 * Downloads, shared by every screen: one live connection to the server,
 * and a hook that re-renders when a job changes.
 */
const jobs = new Map<string, Job>();
const listeners = new Set<() => void>();
let source: EventSource | undefined;

function connect(): void {
  if (source) return;
  source = new EventSource(withToken("/api/downloads/events"));
  source.onmessage = (e) => {
    const job = JSON.parse(e.data as string) as Job;
    jobs.set(job.id, job);
    listeners.forEach((l) => l());
  };
}

/** @returns All downloads, newest first. Re-renders on every change. */
export function useDownloads(): Job[] {
  const [, tick] = useState(0);
  useEffect(() => {
    connect();
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return [...jobs.values()].reverse();
}

const gb = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${(b / 1024 ** 2).toFixed(0)} MB`);
const ACTIVE = new Set(["queued", "downloading", "verifying"]);

/** "about 4 min" from seconds, in the interface language. */
function eta(seconds: number): string {
  const nf = (n: number, unit: "second" | "minute" | "hour") => new Intl.NumberFormat(getLocale(), { style: "unit", unit, unitDisplay: "short" }).format(n);
  if (seconds < 60) return nf(Math.max(1, Math.round(seconds)), "second");
  if (seconds < 3600) return nf(Math.round(seconds / 60), "minute");
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m ? `${nf(h, "hour")} ${nf(m, "minute")}` : nf(h, "hour");
}

/**
 * The small round downloads button in the corner of every screen. It shows
 * a progress ring while something downloads and a dot when one failed, and
 * opens a list with progress, speed, cancel and retry.
 */
export function DownloadsButton() {
  const all = useDownloads();
  const [open, setOpen] = useState(false);
  const active = all.filter((j) => ACTIVE.has(j.status));
  const failed = all.some((j) => j.status === "failed");
  if (all.length === 0) return null;
  const totals = active.reduce((acc, j) => ({ got: acc.got + j.received, all: acc.all + (j.total ?? 0) }), { got: 0, all: 0 });
  const progress = totals.all ? totals.got / totals.all : 0;
  const r = 22;
  const c = 2 * Math.PI * r;
  const remove = (id: string) => {
    jobs.delete(id);
    listeners.forEach((l) => l());
    void api(`/api/downloads/${id}`, { method: "DELETE" }).catch(() => undefined);
  };

  return (
    <div className="dl-corner">
      {open && (
        <div className="dl-panel card" role="dialog" aria-label={t("downloads")}>
          <div className="row"><strong className="grow">{t("downloads")}</strong><button type="button" onClick={() => setOpen(false)} aria-label={t("cancel")}>✕</button></div>
          <div className="list">
            {all.map((j) => (
              <div key={j.id} className="dl-job">
                <div className="row">
                  <span className="mono grow dl-name" dir="ltr" title={j.label}>{j.label}</span>
                  <span className={`pill ${j.status === "done" ? "good" : j.status === "failed" ? "bad" : ""}`}>{t(`dl-${j.status}` as StringKey)}</span>
                </div>
                {ACTIVE.has(j.status) && j.total ? <div className="bar"><div style={{ width: `${(100 * j.received) / j.total}%` }} /></div> : null}
                <div className="row muted">
                  <span className="mono grow" dir="ltr">{gb(j.received)}{j.total ? ` / ${gb(j.total)}` : ""}{j.speed ? ` · ${(j.speed / 1024 ** 2).toFixed(1)} MB/s` : ""}</span>
                  {j.status === "downloading" && j.total && j.speed > 0 && <span className="muted">{t("timeLeft", { time: eta((j.total - j.received) / j.speed) })}</span>}
                  {(j.status === "downloading" || j.status === "queued") && <button type="button" onClick={() => void api(`/api/downloads/${j.id}/pause`, { method: "POST" })}>{t("dlPause")}</button>}
                  {j.status === "paused" && <button type="button" className="primary" onClick={() => void api(`/api/downloads/${j.id}/retry`, { method: "POST" })}>{t("dlResume")}</button>}
                  {(ACTIVE.has(j.status) || j.status === "paused") && <button type="button" onClick={() => void api(`/api/downloads/${j.id}`, { method: "DELETE" })}>{t("cancel")}</button>}
                  {(j.status === "failed" || j.status === "cancelled") && <button type="button" onClick={() => void api(`/api/downloads/${j.id}/retry`, { method: "POST" })}>{t("retry")}</button>}
                  {!ACTIVE.has(j.status) && <button type="button" onClick={() => remove(j.id)} aria-label={t("remove")}>✕</button>}
                </div>
                {j.error && <span className="error">{j.error}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      <button type="button" className="dl-button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`${t("downloads")} (${active.length})`}>
        <svg width="52" height="52" viewBox="0 0 52 52" aria-hidden>
          <circle cx="26" cy="26" r={r} className="dl-track" />
          {active.length > 0 && <circle cx="26" cy="26" r={r} className="dl-ring" strokeDasharray={c} strokeDashoffset={c * (1 - progress)} />}
          <path d="M26 15v15m-6-6 6 6 6-6M18 36h16" className="dl-icon" />
        </svg>
        {active.length > 0 && <span className="dl-count">{active.length}</span>}
        {failed && active.length === 0 && <span className="dl-count bad">!</span>}
      </button>
    </div>
  );
}
