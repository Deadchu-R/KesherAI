import "../downloads-page.css";
import { useCallback, useEffect, useState } from "react";
import { api, isRemote } from "../api";
import { ErrorCard, JobMeters, PhaseTrack, eta, gb, mbps, refreshDownloads, useDownloads, type Job } from "../Downloads";
import { getLocale, t, he$, type StringKey } from "../i18n";
import { Select } from "../ui/Select";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** How many finished downloads the page lists. */
export const FINISHED_SHOWN = 30;

/** A place downloads are saved to, with its free space (from `/api/downloads/drives`; ids and sizes only). */
interface Drive { id: "models" | "heavy"; freeGb?: number; totalGb?: number }

/** The four lists of the page, from every download the server knows. */
export interface DownloadGroups {
  /** Downloading or being checked. */
  running: Job[];
  /** Waiting, in the order they start (place 1 first). */
  queued: Job[];
  /** Paused by the user: they keep their file and wait for Resume. */
  paused: Job[];
  /** Done, newest first, at most {@link FINISHED_SHOWN}. */
  finished: Job[];
  /** Failed or stopped, newest first. */
  failed: Job[];
}

/**
 * Splits the downloads (newest first, as {@link useDownloads} gives them) into the page's lists. The queue follows the
 * server's places, never the order they were first seen in.
 *
 * @param all - Every download.
 * @returns The lists.
 */
export function groupDownloads(all: Job[]): DownloadGroups {
  const by = (...s: string[]) => all.filter((j) => s.includes(j.status));
  return {
    running: by("downloading", "verifying").reverse(),
    queued: by("queued").sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9)),
    paused: by("paused").reverse(),
    finished: by("done").slice(0, FINISHED_SHOWN),
    failed: by("failed", "cancelled"),
  };
}

/**
 * The full Downloads page (`#/downloads`): what runs, the queue (drag or use the arrows to reorder it; the buttons
 * are 44 px tall for a thumb), what finished and what failed, the free space of each drive and the total speed. It
 * only sends job ids and places to the server, so it works from the phone exactly as on the computer.
 */
export function DownloadsPage() {
  const all = useDownloads();
  const [drives, setDrives] = useState<Drive[]>([]);
  const [max, setMax] = useState(2);
  const [parts, setParts] = useState(4);
  const [problem, setProblem] = useState("");
  const [dragId, setDragId] = useState<string | undefined>();
  const { running, queued, paused, finished, failed } = groupDownloads(all);
  const speed = running.reduce((n, j) => n + (j.status === "downloading" ? j.speed : 0), 0);
  const left = [...running, ...queued].reduce((n, j) => n + Math.max(0, (j.total ?? 0) - j.received), 0);

  const loadDrives = useCallback(() => void api<Drive[]>("/api/downloads/drives").then(setDrives).catch(() => undefined), []);
  useEffect(() => {
    loadDrives();
    void api<{ max: number }>("/api/downloads/concurrency").then((r) => setMax(r.max)).catch(() => undefined);
    void api<{ parts: number }>("/api/downloads/parts").then((r) => setParts(r.parts)).catch(() => undefined);
    // Free space changes as files land: look again every half minute.
    const timer = setInterval(loadDrives, 30_000);
    return () => clearInterval(timer);
  }, [loadDrives]);
  useEffect(() => void refreshDownloads(), []);

  /** One call to the server, then the list again (a phone behind a proxy may get no live events). */
  const act = async (path: string, body?: unknown, method = "POST") => {
    setProblem("");
    try {
      await api(`/api/downloads/${path}`, { method, ...(body !== undefined ? { body } : {}) });
    } catch (e) {
      setProblem((e as Error).message);
    }
    await refreshDownloads();
    loadDrives();
  };
  const changeMax = (n: number) => {
    setMax(n);
    void act("concurrency", { max: n }, "PUT");
  };

  const changeParts = (n: number) => {
    setParts(n);
    void act("parts", { parts: n }, "PUT");
  };

  const driveName = (id: Drive["id"]) => (id === "heavy" ? L("כונן הנתונים הכבדים", "Heavy-data drive") : L("תיקיית ההורדות", "Download folder"));
  const hasPause = running.length + queued.length > 0;

  return (
    <div className="page dl-page">
      <div className="row dl-page-head">
        <h1 className="grow">{t("downloads")}</h1>
        {hasPause && <button type="button" onClick={() => void act("pause-all")}>{L("השהה הכול", "Pause all")}</button>}
        {paused.length > 0 && <button type="button" className="primary" onClick={() => void act("resume-all")}>{L("המשך הכול", "Resume all")}</button>}
      </div>

      <section className="card dl-summary" aria-label={L("סיכום", "Summary")}>
        <div className="dl-stats">
          <div><span className="muted small">{L("מהירות כוללת", "Total speed")}</span><strong className="mono" dir="ltr">{speed > 0 ? mbps(speed) : "—"}</strong></div>
          <div><span className="muted small">{L("פעילות", "Active")}</span><strong>{running.length} / {max}</strong></div>
          <div><span className="muted small">{L("בתור", "Waiting")}</span><strong>{queued.length}</strong></div>
          {speed > 0 && left > 0 && <div><span className="muted small">{L("זמן שנשאר לכולן", "Time left for all")}</span><strong>{eta(left / speed)}</strong></div>}
        </div>
        {drives.length > 0 && (
          <ul className="dl-drives">
            {drives.map((d) => {
              const used = d.totalGb && d.freeGb !== undefined ? Math.round(100 * (1 - d.freeGb / d.totalGb)) : undefined;
              return (
                <li key={d.id}>
                  <div className="row small"><span className="grow">{driveName(d.id)}</span>{d.freeGb !== undefined && <span className="mono" dir="ltr">{L("פנוי", "Free")} {Math.round(d.freeGb)} GB{d.totalGb ? ` / ${Math.round(d.totalGb)} GB` : ""}</span>}</div>
                  {used !== undefined && <div className="bar" role="progressbar" aria-label={driveName(d.id)} aria-valuenow={used} aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${used}%` }} /></div>}
                </li>
              );
            })}
          </ul>
        )}
        <label className="row small">
          <span className="grow">{L("כמה הורדות במקביל", "Downloads at the same time")}</span>
          <Select value={max} onChange={(e) => changeMax(Number(e.target.value))}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</Select>
        </label>
        <label className="row small">
          <span className="grow">{L("חלקים בכל הורדה (קבצים מ-1 GB)", "Parts per download (files from 1 GB)")}</span>
          <Select value={parts} onChange={(e) => changeParts(Number(e.target.value))}>{[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n === 1 ? L("1 (כבוי)", "1 (off)") : n}</option>)}</Select>
        </label>
        {problem && <span className="error small">{problem}</span>}
      </section>

      {all.length === 0 && <p className="muted">{L("אין הורדות כרגע. הורדה שתתחיל תופיע כאן.", "No downloads yet. One you start shows up here.")}</p>}

      {running.length > 0 && (
        <section className="stack" aria-label={L("רצות עכשיו", "Running")}>
          <h2>{L("רצות עכשיו", "Running")} <span className="muted small">{running.length}</span></h2>
          {running.map((j) => (
            <article key={j.id} className="card dl-item">
              <Name j={j} />
              <PhaseTrack status={j.status} />
              <JobMeters j={j} />
              <div className="row dl-actions">
                <button type="button" onClick={() => void act(`${j.id}/pause`)}>{t("dlPause")}</button>
                <button type="button" onClick={() => void act(j.id, undefined, "DELETE")}>{t("cancel")}</button>
              </div>
            </article>
          ))}
        </section>
      )}

      {(queued.length > 0 || paused.length > 0) && (
        <section className="stack" aria-label={L("בתור", "Queued")}>
          <h2>{L("בתור", "Queued")} <span className="muted small">{queued.length + paused.length}</span></h2>
          {queued.length > 1 && <p className="muted small">{L("גררו כדי לשנות סדר, או השתמשו בחיצים. ההורדה הראשונה מתחילה ראשונה.", "Drag to change the order, or use the arrows. The first one starts first.")}</p>}
          <ol className="dl-queue">
            {queued.map((j, i) => (
              <li
                key={j.id}
                className={`card dl-item${dragId === j.id ? " dragging" : ""}`}
                draggable
                onDragStart={() => setDragId(j.id)}
                onDragEnd={() => setDragId(undefined)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragId && dragId !== j.id) void act(`${dragId}/move`, { to: i });
                  setDragId(undefined);
                }}
              >
                <div className="row">
                  <span className="dl-handle" aria-hidden="true" title={L("גרור", "Drag")}>⠿</span>
                  <span className="dl-place mono" dir="ltr">{i + 1}</span>
                  <Name j={j} />
                </div>
                <JobMeters j={j} />
                <div className="row dl-actions">
                  <button type="button" disabled={i === 0} onClick={() => void act(`${j.id}/move`, { to: "up" })} aria-label={L("הזז למעלה", "Move up")}>↑</button>
                  <button type="button" disabled={i === queued.length - 1} onClick={() => void act(`${j.id}/move`, { to: "down" })} aria-label={L("הזז למטה", "Move down")}>↓</button>
                  {i > 0 && <button type="button" onClick={() => void act(`${j.id}/move`, { to: "top" })}>{L("העבר לראש", "Move to top")}</button>}
                  <button type="button" onClick={() => void act(`${j.id}/pause`)}>{t("dlPause")}</button>
                  <button type="button" onClick={() => void act(j.id, undefined, "DELETE")}>{t("cancel")}</button>
                </div>
              </li>
            ))}
          </ol>
          {paused.map((j) => (
            <article key={j.id} className="card dl-item">
              <Name j={j} />
              <JobMeters j={j} />
              <div className="row dl-actions">
                <button type="button" className="primary" onClick={() => void act(`${j.id}/retry`)}>{t("dlResume")}</button>
                <button type="button" onClick={() => void act(j.id, undefined, "DELETE")}>{t("cancel")}</button>
              </div>
            </article>
          ))}
        </section>
      )}

      {finished.length > 0 && (
        <section className="stack" aria-label={L("הסתיימו", "Finished")}>
          <h2>{L("הסתיימו", "Finished")} <span className="muted small">{finished.length}</span></h2>
          {finished.map((j) => (
            <article key={j.id} className="card dl-item">
              <Name j={j} />
              <div className="row dl-actions">
                {j.total ? <span className="muted small mono grow" dir="ltr">{gb(j.total)}</span> : <span className="grow" />}
                {/* The folder opens on the computer itself, so it is not offered on a phone (the server refuses it there too). */}
                {!isRemote() && <button type="button" onClick={() => void act(`${j.id}/open-folder`)}>{L("פתח תיקייה", "Open folder")}</button>}
                <button type="button" onClick={() => void act(j.id, undefined, "DELETE")} aria-label={t("remove")}>✕</button>
              </div>
            </article>
          ))}
        </section>
      )}

      {failed.length > 0 && (
        <section className="stack" aria-label={L("נכשלו", "Failed")}>
          <h2>{L("נכשלו", "Failed")} <span className="muted small">{failed.length}</span></h2>
          {failed.map((j) => (
            <article key={j.id} className="card dl-item">
              <Name j={j} />
              {j.status === "failed" ? <ErrorCard j={j} /> : <span className="muted small">{L("נעצרה. מה שירד נשמר.", "Stopped. What was downloaded is kept.")}</span>}
              <div className="row dl-actions">
                {j.status === "cancelled" && <button type="button" className="primary" onClick={() => void act(`${j.id}/retry`)}>{t("retry")}</button>}
                <button type="button" onClick={() => void act(j.id, undefined, "DELETE")} aria-label={t("remove")}>✕</button>
              </div>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}

/** A download's name and status pill. */
function Name({ j }: { j: Job }) {
  return (
    <div className="row dl-name-row">
      <span className="mono grow dl-name" dir="ltr" title={j.label}>{j.label}</span>
      <span className={`pill ${j.status === "done" ? "good" : j.status === "failed" ? "bad" : ""}`}>{t(`dl-${j.status}` as StringKey)}</span>
    </div>
  );
}

