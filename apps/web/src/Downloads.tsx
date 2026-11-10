import { useEffect, useState } from "react";
import { api, withToken } from "./api";
import { getLocale, t, type StringKey } from "./i18n";

/** One download, as the server reports it. */
export interface Job { id: string; label: string; url?: string; status: string; received: number; total?: number; speed: number; error?: string }

/**
 * Downloads, shared by every screen: one live connection to the server,
 * and a hook that re-renders when a job changes.
 */
const jobs = new Map<string, Job>();
const listeners = new Set<() => void>();
let source: EventSource | undefined;

let polling: ReturnType<typeof setInterval> | undefined;

function connect(): void {
  if (source) return;
  source = new EventSource(withToken("/api/downloads/events"));
  source.onmessage = (e) => {
    const job = JSON.parse(e.data as string) as Job;
    jobs.set(job.id, job);
    listeners.forEach((l) => l());
  };
  // Some ways in (a phone through a tunnel or a proxy) hold live events back: then ask every few seconds.
  source.onerror = () => startPolling();
  // And while something downloads, check every few seconds anyway (cheap, and covers a stream that went quiet).
  setInterval(() => {
    if ([...jobs.values()].some((j) => ACTIVE.has(j.status))) void poll();
  }, 5000);
  setTimeout(() => void poll(), 3000);
}

async function poll(): Promise<void> {
  const list = await api<Job[]>("/api/downloads").catch(() => undefined);
  if (!list) return;
  for (const j of list) jobs.set(j.id, j);
  listeners.forEach((l) => l());
}

function startPolling(): void {
  polling ??= setInterval(() => void poll(), 3000);
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
  const [limit, setLimit] = useState(0);
  useEffect(() => {
    if (open) void api<{ mbps: number }>("/api/downloads/limit").then((r) => setLimit(r.mbps)).catch(() => undefined);
  }, [open]);
  const changeLimit = (mbps: number) => {
    setLimit(mbps);
    void api("/api/downloads/limit", { method: "PUT", body: { mbps } }).catch(() => undefined);
  };
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
    // On the phone a finished-downloads button covered buttons under it (found at 390 px on the Unity page): it
    // shows there only while something downloads or failed (finished ones are on the Models page).
    <div className={`dl-corner${!active.length && !failed && !open ? " idle" : ""}`}>
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
          <label className="row muted">
            <span className="grow">{t("dlLimit")}</span>
            <select value={limit} onChange={(e) => changeLimit(Number(e.target.value))}>
              {[...new Set([0, 1, 2, 5, 10, 20, 50, limit])].sort((a, b) => a - b).map((v) => (
                <option key={v} value={v}>{v === 0 ? t("dlNoLimit") : `${v} MB/s`}</option>
              ))}
            </select>
          </label>
        </div>
      )}
      <button type="button" className="dl-button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`${t("downloads")} (${active.length})`}>
        <svg width="52" height="52" viewBox="0 0 52 52" aria-hidden>
          <circle cx="26" cy="26" r={r} className="dl-track" />
          {active.length > 0 && <circle cx="26" cy="26" r={r} className="dl-ring" strokeDasharray={c} strokeDashoffset={c * (1 - progress)} />}
          {active.length > 0 && totals.all > 0 ? (
            <text x="26" y="30" textAnchor="middle" className="dl-pct">{Math.floor(progress * 100)}%</text>
          ) : (
            <path d="M26 15v15m-6-6 6 6 6-6M18 36h16" className="dl-icon" />
          )}
        </svg>
        {active.length > 0 && <span className="dl-count">{active.length}</span>}
        {failed && active.length === 0 && <span className="dl-count bad">!</span>}
      </button>
    </div>
  );
}

/**
 * The download of one file, shown where it was started (a model's card):
 * percent, size, speed, time left, pause and cancel.
 *
 * @param props.repo - The Hugging Face repo.
 * @param props.file - The file's path in the repo (any file of the repo when left out).
 */
export function DownloadBar({ repo, file }: { repo: string; file?: string }) {
  const all = useDownloads();
  const mine = all.filter((j) => j.url?.includes(`/${repo}/resolve/`) && (!file || decodeURIComponent(j.url).endsWith(`/${file}`)));
  const j = mine.find((x) => ACTIVE.has(x.status) || x.status === "paused") ?? mine.find((x) => x.status === "failed");
  if (!j) return null;
  const pct = j.total ? Math.floor((100 * j.received) / j.total) : 0;
  return (
    <div className="dl-inline stack">
      <div className="row small">
        <strong className="grow">{j.status === "failed" ? t("dl-failed") : j.status === "paused" ? t("dl-paused") : j.status === "queued" ? t("dl-queued") : `${pct}%`}</strong>
        <span className="muted mono" dir="ltr">{gb(j.received)}{j.total ? ` / ${gb(j.total)}` : ""}{j.speed ? ` · ${(j.speed / 1024 ** 2).toFixed(1)} MB/s` : ""}</span>
      </div>
      {j.total ? <div className="bar"><div style={{ width: `${pct}%` }} /></div> : null}
      <div className="row small">
        <span className="muted grow">{j.status === "downloading" && j.total && j.speed > 0 ? t("timeLeft", { time: eta((j.total - j.received) / j.speed) }) : j.error ?? ""}</span>
        {(j.status === "downloading" || j.status === "queued") && <button type="button" onClick={() => void api(`/api/downloads/${j.id}/pause`, { method: "POST" })}>{t("dlPause")}</button>}
        {(j.status === "paused" || j.status === "failed") && <button type="button" className="primary" onClick={() => void api(`/api/downloads/${j.id}/retry`, { method: "POST" })}>{j.status === "paused" ? t("dlResume") : t("retry")}</button>}
        {j.status !== "failed" && <button type="button" onClick={() => void api(`/api/downloads/${j.id}`, { method: "DELETE" })}>{t("cancel")}</button>}
      </div>
    </div>
  );
}

/**
 * The downloads whose label matches, each with its percent and a bar (for a
 * model kind's card: its engine and files download under several names).
 */
export function DownloadsMatching({ match }: { match: RegExp }) {
  const all = useDownloads().filter((j) => match.test(j.label) && (ACTIVE.has(j.status) || j.status === "paused" || j.status === "failed"));
  if (!all.length) return null;
  return (
    <div className="stack" style={{ gap: 6 }}>
      {all.map((j) => {
        const pct = j.total ? Math.floor((100 * j.received) / j.total) : 0;
        return (
          <div key={j.id} className="dl-inline stack">
            <div className="row small">
              <span className="grow" dir="auto">{j.label}</span>
              <strong>{j.status === "failed" ? t("dl-failed") : j.status === "paused" ? t("dl-paused") : j.status === "queued" ? t("dl-queued") : `${pct}%`}</strong>
            </div>
            {j.total ? <div className="bar"><div style={{ width: `${pct}%` }} /></div> : null}
            {j.status === "failed" && <button type="button" className="primary" onClick={() => void api(`/api/downloads/${j.id}/retry`, { method: "POST" })}>{t("retry")}</button>}
          </div>
        );
      })}
    </div>
  );
}
