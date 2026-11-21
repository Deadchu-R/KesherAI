import { useEffect, useState } from "react";
import { api, withToken } from "./api";
import { getLocale, t, he$, type StringKey } from "./i18n";
import { Select } from "./ui/Select";

/** One download, as the server reports it. */
export interface Job {
  id: string; label: string; url?: string; dest?: string; status: string; received: number; total?: number;
  /** Bytes per second, smoothed on the computer (no jumping). */
  speed: number;
  /** Seconds left at that speed, when known. */
  etaSeconds?: number;
  /** While checking the file: bytes hashed so far. */
  verified?: number;
  error?: string;
  /** Why it failed: decides the error card's cause and its one fix button. */
  errorKind?: "disk-full" | "auth" | "network" | "changed" | "other";
  /** While waiting: the place in the line (1 starts next). */
  position?: number;
  /** Why it is not at full speed: the chat is answering (`slowed`) or a game is in Play (`paused`, also while waiting). */
  busy?: "slowed" | "paused";
  /** "Don't slow": this download ignores the chat and the game. */
  dontSlow?: boolean;
  /** The hub's hash is known (Verify shows). */
  sha256?: string;
  /** From the hub: Verify can fetch the hash itself. */
  fromHub?: boolean;
  /** The last check: same as the hub (`ok`) or different (`bad`, with Repair). */
  integrity?: "ok" | "bad";
  /** What Repair does (`bad`) or is doing: only the broken ranges, or the whole file. */
  repair?: "ranges" | "whole";
  /** A repair is downloading right now. */
  repairing?: boolean;
}

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

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

/** Asks the server for the list now (after a move or a pause, so the screen does not wait for the next live event). */
export async function refreshDownloads(): Promise<void> {
  await poll();
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

export const gb = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${(b / 1024 ** 2).toFixed(0)} MB`);
export const ACTIVE = new Set(["queued", "downloading", "verifying"]);

/** "about 4 min" from seconds, in the interface language. */
export function eta(seconds: number): string {
  const nf = (n: number, unit: "second" | "minute" | "hour") => new Intl.NumberFormat(getLocale(), { style: "unit", unit, unitDisplay: "short" }).format(n);
  if (seconds < 60) return nf(Math.max(1, Math.round(seconds)), "second");
  if (seconds < 3600) return nf(Math.round(seconds / 60), "minute");
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m ? `${nf(h, "hour")} ${nf(m, "minute")}` : nf(h, "hour");
}

export const mbps = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MB/s`;

/** The steps a download goes through; the current one is marked (waiting, downloading, checking, done). */
const PHASES = ["queued", "downloading", "verifying", "done"] as const;

/** The four phases as a small track: passed ones filled, the current one bold. Failed and paused ones show no track. */
export function PhaseTrack({ status }: { status: string }) {
  const at = PHASES.indexOf(status as (typeof PHASES)[number]);
  if (at < 0) return null;
  return (
    <ol className="dl-phases" aria-label={t(`dl-${status}` as StringKey)}>
      {PHASES.map((p, i) => (
        <li key={p} className={i < at ? "past" : i === at ? "now" : ""} aria-current={i === at ? "step" : undefined}>{t(`dl-${p}` as StringKey)}</li>
      ))}
    </ol>
  );
}

/**
 * One line for several downloads together: how many, the speed they share, and the time left for all of them.
 *
 * @param active - The downloads that are waiting, downloading or being checked.
 */
function TotalLine({ active }: { active: Job[] }) {
  if (active.length < 2) return null;
  const left = active.reduce((n, j) => n + Math.max(0, (j.total ?? 0) - j.received), 0);
  const speed = active.filter((j) => j.status === "downloading").reduce((n, j) => n + j.speed, 0);
  return (
    <div className="row small dl-total">
      <strong className="grow">{L(`${active.length} הורדות פעילות`, `${active.length} downloads running`)}</strong>
      <span className="muted mono" dir="ltr">{speed > 0 ? mbps(speed) : ""}</span>
      {speed > 0 && left > 0 && <span className="muted">{L("בסך הכול", "in all")}: {t("timeLeft", { time: eta(left / speed) })}</span>}
    </div>
  );
}

/**
 * The badge of a download that gives way to the computer: slowed while the chat answers, paused while a game plays
 * (a waiting download shows it too, since it will not start before the game ends). Nothing when it runs freely.
 */
export function BusyBadge({ j }: { j: Job }) {
  if (!j.busy || !["downloading", "queued", "paused"].includes(j.status)) return null;
  return (
    <span className="pill warn dl-busy" role="status">
      {j.busy === "paused" ? L("מושהית בזמן שהמשחק רץ", "Paused while the game plays") : L("עסוק: מואטת בשביל הצ'אט", "Busy: slowed for the chat")}
    </span>
  );
}

/** The "Don't slow" switch of one download: it then ignores the chat and the game and runs at full speed. */
export function DontSlowToggle({ j, onDone }: { j: Job; onDone?: () => void }) {
  return (
    <label className="check small dl-dontslow">
      <input type="checkbox" checked={!!j.dontSlow} onChange={(e) => void api(`/api/downloads/${j.id}/dont-slow`, { method: "POST", body: { on: e.target.checked } }).catch(() => undefined).then(() => onDone?.())} />
      {L("אל תאט את ההורדה הזו", "Don't slow this one")}
    </label>
  );
}

/**
 * What one download shows while it is not finished: its phase, a bar, and the numbers that fit the phase: the
 * network speed and time left while downloading, the check's progress while the file is verified.
 */
export function JobMeters({ j }: { j: Job }) {
  const pct = j.total ? Math.floor((100 * j.received) / j.total) : 0;
  const size = `${gb(j.received)}${j.total ? ` / ${gb(j.total)}` : ""}`;
  if (j.status === "verifying") {
    const vp = j.received ? Math.min(100, Math.floor((100 * (j.verified ?? 0)) / j.received)) : 0;
    return (
      <>
        <div className="bar" role="progressbar" aria-valuenow={vp} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${vp}%` }} /></div>
        <div className="row small muted"><span className="grow">{L("בודק שהקובץ שלם", "Checking the file is intact")}</span><span className="mono" dir="ltr">{vp}%</span></div>
      </>
    );
  }
  if (j.status === "queued") return <><BusyBadge j={j} /><div className="muted small">{j.busy === "paused" ? L("מחכה שהמשחק יסתיים", "Waiting for the game to end") : L("מחכה לתור שלו", "Waiting for its turn")}</div></>;
  return (
    <>
      <BusyBadge j={j} />
      {j.repairing && <span className="pill dl-busy">{L("מתקן: מוריד רק את החלקים הפגומים", "Repairing: downloading only the broken parts")}</span>}
      {j.total ? <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${pct}%` }} /></div> : null}
      <div className="row small muted">
        <span className="mono grow" dir="ltr">{size}{j.speed ? ` · ${mbps(j.speed)}` : ""}</span>
        {j.status === "downloading" && j.etaSeconds !== undefined && <span>{t("timeLeft", { time: eta(j.etaSeconds) })}</span>}
      </div>
    </>
  );
}

/**
 * Verify and Repair for a finished file. Verify reads the file once and compares its SHA-256 with the hub's (the
 * progress shows as the checking phase); it is offered only when a hash is known or can be fetched. A file that
 * differs shows Repair: only the broken ranges when it was downloaded in parts and they can be told, else the file
 * is downloaded again. Works from the phone too: the server does the reading and sends back only the result.
 */
export function VerifyActions({ j, onDone }: { j: Job; onDone?: () => void }) {
  const [problem, setProblem] = useState("");
  const [noHash, setNoHash] = useState(false);
  const call = (path: "verify" | "repair") => {
    setProblem("");
    return api(`/api/downloads/${j.id}/${path}`, { method: "POST" })
      .catch((e: Error) => {
        if (path === "verify" && /no hash/i.test(e.message)) setNoHash(true);
        else setProblem(e.message);
      })
      .then(() => onDone?.());
  };
  const canVerify = !noHash && (!!j.sha256 || !!j.fromHub);
  return (
    <>
      {j.integrity === "ok" && <span className="pill good">{L("זהה לקובץ באתר", "Matches the hub")}</span>}
      {j.integrity === "bad" && (
        <div className="dl-error stack" role="alert">
          <strong>{L("הקובץ שונה מהקובץ באתר.", "The file differs from the one on the hub.")}</strong>
          <span className="muted small">{j.repair === "ranges" ? L("חלקים ממנו פגומים: אפשר להוריד רק אותם.", "Parts of it are broken: only those can be downloaded again.") : L("אי אפשר לדעת איפה: הקובץ יורד מחדש.", "It cannot be told where: the file is downloaded again.")}</span>
          <div className="row dl-actions"><button type="button" className="primary" onClick={() => void call("repair")}>{j.repair === "ranges" ? L("תקן (רק החלקים הפגומים)", "Repair (only the broken parts)") : L("תקן (הורדה מחדש)", "Repair (download again)")}</button></div>
        </div>
      )}
      {canVerify && j.integrity !== "bad" && <div className="row dl-actions"><button type="button" onClick={() => void call("verify")}>{L("בדוק את הקובץ", "Verify")}</button></div>}
      {noHash && <span className="muted small">{L("באתר אין hash לקובץ הזה, אז אי אפשר לבדוק אותו.", "The hub has no hash for this file, so it cannot be checked.")}</span>}
      {problem && <span className="error small">{problem}</span>}
    </>
  );
}

/**
 * A failed download: what went wrong in plain words and one button that fixes it. A full disk offers the other
 * drive; a refused file (401/403) points to the Hugging Face token setting (the token is never asked for here);
 * a network problem retries (it resumes); a file that changed on the hub restarts from zero.
 */
export function ErrorCard({ j }: { j: Job }) {
  const [problem, setProblem] = useState("");
  const kind = j.errorKind ?? "other";
  const post = (path: string) => {
    setProblem("");
    return api(`/api/downloads/${j.id}/${path}`, { method: "POST" }).catch((e: Error) => setProblem(e.message));
  };
  const cause: Record<NonNullable<Job["errorKind"]>, string> = {
    "disk-full": L("אין מספיק מקום בכונן הזה להורדה.", "There is not enough room on this drive for the download."),
    auth: L("המודל הזה צריך טוקן של Hugging Face.", "This model needs a Hugging Face token."),
    network: L("החיבור לאינטרנט נקטע או איטי מדי. מה שירד נשמר.", "The connection dropped or timed out. What was downloaded is kept."),
    changed: L("הקובץ השתנה באתר, אז מה שירד כבר לא מתאים.", "The file changed on the hub, so what was downloaded no longer matches."),
    other: L("ההורדה נכשלה.", "The download failed."),
  };
  return (
    <div className="dl-error stack" role="alert">
      <strong>{cause[kind]}</strong>
      {j.error && <span className="muted small mono dl-error-raw" dir="ltr">{j.error}</span>}
      <div className="row">
        {kind === "disk-full" && <button type="button" className="primary" onClick={() => void post("other-drive")}>{L("בחר כונן אחר", "Choose another drive")}</button>}
        {kind === "auth" && <a className="button primary" href="#/settings/accounts">{L("הוסף טוקן בהגדרות", "Add a token in Settings")}</a>}
        {kind === "changed" && <button type="button" className="primary" onClick={() => void post("restart")}>{L("התחל מחדש", "Restart")}</button>}
        {(kind === "network" || kind === "other") && <button type="button" className="primary" onClick={() => void post("retry")}>{L("נסה שוב (ממשיך מאיפה שעצר)", "Retry (resumes)")}</button>}
      </div>
      {problem && <span className="error small">{problem}</span>}
    </div>
  );
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
  const [notify, setNotify] = useState(true);
  useEffect(() => {
    if (!open) return;
    void api<{ mbps: number }>("/api/downloads/limit").then((r) => setLimit(r.mbps)).catch(() => undefined);
    void api<{ on: boolean }>("/api/downloads/notify").then((r) => setNotify(r.on)).catch(() => undefined);
  }, [open]);
  const changeNotify = (on: boolean) => {
    setNotify(on);
    void api("/api/downloads/notify", { method: "PUT", body: { on } }).catch(() => undefined);
  };
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
          <div className="row"><strong className="grow">{t("downloads")}</strong><a className="button small" href="#/downloads" onClick={() => setOpen(false)}>{L("פתח הכול", "Open all")}</a><button type="button" onClick={() => setOpen(false)} aria-label={t("cancel")}>✕</button></div>
          <TotalLine active={active} />
          <div className="list">
            {all.map((j) => (
              <div key={j.id} className="dl-job">
                <div className="row">
                  <span className="mono grow dl-name" dir="ltr" title={j.label}>{j.label}</span>
                  <span className={`pill ${j.status === "done" ? "good" : j.status === "failed" ? "bad" : ""}`}>{t(`dl-${j.status}` as StringKey)}</span>
                </div>
                {ACTIVE.has(j.status) && <PhaseTrack status={j.status} />}
                {ACTIVE.has(j.status) || j.status === "paused" ? <JobMeters j={j} /> : j.status === "done" && j.total ? <span className="muted small mono" dir="ltr">{gb(j.total)}</span> : null}
                {j.status === "failed" && <ErrorCard j={j} />}
                {(j.status === "downloading" || j.status === "queued") && <DontSlowToggle j={j} onDone={() => void refreshDownloads()} />}
                <div className="row muted">
                  <span className="grow" />
                  {(j.status === "downloading" || j.status === "queued") && <button type="button" onClick={() => void api(`/api/downloads/${j.id}/pause`, { method: "POST" })}>{t("dlPause")}</button>}
                  {j.status === "paused" && <button type="button" className="primary" onClick={() => void api(`/api/downloads/${j.id}/retry`, { method: "POST" })}>{t("dlResume")}</button>}
                  {(ACTIVE.has(j.status) || j.status === "paused") && <button type="button" onClick={() => void api(`/api/downloads/${j.id}`, { method: "DELETE" })}>{t("cancel")}</button>}
                  {j.status === "cancelled" && <button type="button" onClick={() => void api(`/api/downloads/${j.id}/retry`, { method: "POST" })}>{t("retry")}</button>}
                  {!ACTIVE.has(j.status) && <button type="button" onClick={() => remove(j.id)} aria-label={t("remove")}>✕</button>}
                </div>
              </div>
            ))}
          </div>
          <label className="row muted">
            <span className="grow">{t("dlLimit")}</span>
            <Select value={limit} onChange={(e) => changeLimit(Number(e.target.value))}>
              {[...new Set([0, 1, 2, 5, 10, 20, 50, limit])].sort((a, b) => a - b).map((v) => (
                <option key={v} value={v}>{v === 0 ? t("dlNoLimit") : `${v} MB/s`}</option>
              ))}
            </Select>
          </label>
          <label className="check small">
            <input type="checkbox" checked={notify} onChange={(e) => changeNotify(e.target.checked)} /> {L("התראה כשהורדה גדולה (200MB ומעלה) מסתיימת", "Notify when big downloads end (200 MB and up)")}
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
  if (j.status === "failed") return <div className="dl-inline stack"><ErrorCard j={j} /></div>;
  return (
    <div className="dl-inline stack">
      <div className="row small">
        <strong className="grow">{j.status === "paused" ? t("dl-paused") : t(`dl-${j.status}` as StringKey)}</strong>
        {j.total ? <span className="muted mono" dir="ltr">{Math.floor((100 * j.received) / j.total)}%</span> : null}
      </div>
      <PhaseTrack status={j.status} />
      <JobMeters j={j} />
      <div className="row small">
        <span className="grow" />
        {(j.status === "downloading" || j.status === "queued") && <button type="button" onClick={() => void api(`/api/downloads/${j.id}/pause`, { method: "POST" })}>{t("dlPause")}</button>}
        {j.status === "paused" && <button type="button" className="primary" onClick={() => void api(`/api/downloads/${j.id}/retry`, { method: "POST" })}>{t("dlResume")}</button>}
        <button type="button" onClick={() => void api(`/api/downloads/${j.id}`, { method: "DELETE" })}>{t("cancel")}</button>
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
            {j.status === "failed" && <ErrorCard j={j} />}
          </div>
        );
      })}
    </div>
  );
}
