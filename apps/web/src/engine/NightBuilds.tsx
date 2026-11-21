import { useEffect, useState } from "react";
import { api, isRemote } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";
import { sizeText } from "./GameCheckpoints";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** One kept build of a project, as /api/games/night lists it. */
interface NightBuild {
  id: string;
  slot: string;
  platform: "windows" | "android";
  startedAt: string;
  durationMs: number;
  ok: boolean;
  sizeBytes?: number;
  warnings: number;
  errors: number;
  smoke?: { ok: boolean; note: string };
  changes: string[];
}

/** One project's night-build state. */
interface NightProject {
  engine: "unity" | "unreal";
  name: string;
  path: string;
  settings: { enabled: boolean; time: string; platforms: Array<"windows" | "android">; smoke: boolean };
  /** What this computer can build for it. */
  platforms: Array<"windows" | "android">;
  waiting?: "editor" | "busy";
  running?: { platform: string; since: string };
  last: NightBuild[];
}

/** One row of the morning scorecard. */
interface ScoreRow extends Omit<NightBuild, "slot" | "startedAt"> {
  project: string;
  name: string;
  engine: string;
  changes: string[];
}

const PLATFORM = { windows: "Windows", android: "Android" } as const;
const minutes = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
};

/**
 * Night builds on the Games page (RESEARCH_LOG 2026-11-21, c-20261121-38 Part D idea 6): the morning scorecard of the
 * last night (one row per project and platform: passed or failed, time, size, warnings, smoke test, what changed since
 * the last build; a failure opens its log cut down to the errors) and, per project, the setting: on or off (off by
 * default), the time, the platforms this computer can build and the smoke test. From the phone only the two switches
 * and viewing work; the time and platforms are changed on the computer.
 */
export function NightBuilds() {
  const [data, setData] = useState<{ projects: NightProject[]; card?: { night: string; rows: ScoreRow[]; passed: number; failed: number } } | null>(null);
  const [log, setLog] = useState<{ id: string; text: string; errors: boolean; full: boolean } | null>(null);
  const [open, setOpen] = useState("");
  const remote = isRemote();
  const load = () => void api<NonNullable<typeof data>>("/api/games/night").then(setData, (e: Error) => toast(e.message));
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);
  const save = (p: NightProject, patch: Partial<NightProject["settings"]>) =>
    void api("/api/games/night", { method: "PUT", body: { project: p.path, ...patch } }).then(load, (e: Error) => toast(e.message));
  const showLog = (id: string, full = false) =>
    void api<{ text: string; errors: boolean }>(`/api/games/night/${encodeURIComponent(id)}/log${full ? "?full=1" : ""}`).then((r) => setLog({ id, full, ...r }), (e: Error) => toast(e.message));
  if (!data?.projects.length) return null;
  const card = data.card;
  return (
    <section className="card games-night" aria-label={L("בניית לילה", "Night build")}>
      <div className="row games-head">
        <span aria-hidden>🌙</span>
        <strong className="grow">{L("בניית לילה", "Night build")}</strong>
        {card && <span className={`games-chip ${card.failed ? "bad" : ""}`}>{card.failed ? `✕ ${card.failed} · ` : ""}✓ {card.passed}</span>}
      </div>
      {card ? (
        <ul className="games-cps">
          {card.rows.map((r) => (
            <li key={r.id} className="games-cp">
              <button type="button" className="games-cp-head" aria-expanded={open === r.id} onClick={() => { setOpen(open === r.id ? "" : r.id); if (!r.ok && open !== r.id) showLog(r.id); }}>
                <span className="games-cp-label" dir="auto">{r.ok ? "✓" : "✕"} {r.name} · {PLATFORM[r.platform]}</span>
                <span className="row wrap small games-cp-meta">
                  <span className="muted">{minutes(r.durationMs)}{r.sizeBytes ? ` · ${sizeText(r.sizeBytes)}` : ""}</span>
                  <span className={`games-chip ${r.warnings ? "warn" : ""}`}>⚠ {r.warnings}</span>
                  {r.errors > 0 && <span className="games-chip bad">{L(`${r.errors} שגיאות`, `${r.errors} error(s)`)}</span>}
                  {r.smoke && <span className={`games-chip ${r.smoke.ok ? "" : "bad"}`}>{L("בדיקת עשן", "Smoke")} {r.smoke.ok ? "✓" : "✕"}</span>}
                </span>
              </button>
              {open === r.id && (
                <div className="games-cp-body">
                  {r.smoke && <p className="muted small games-sub" dir="auto">{r.smoke.note}</p>}
                  <p className="small games-sub"><b>{L("מה השתנה מאז אתמול", "What changed since last night")}</b></p>
                  {r.changes.length ? <ul className="games-cp-files">{r.changes.map((c) => <li key={c} className="mono small" dir="ltr">{c}</li>)}</ul> : <p className="muted small games-sub">{L("אין קומיטים חדשים.", "No new commits.")}</p>}
                  {(!r.ok || r.errors > 0) && (
                    <>
                      <p className="small games-sub"><b>{log?.id === r.id && !log.full ? L("הלוג, רק השגיאות", "The log, errors only") : L("הלוג (סוף)", "The log (end)")}</b></p>
                      {log?.id === r.id ? <pre className="games-night-log mono small" dir="ltr">{log.text || "…"}</pre> : <p className="muted small">…</p>}
                      <button type="button" className="ghost small" onClick={() => showLog(r.id, !(log?.id === r.id && log.full))}>{log?.id === r.id && log.full ? L("רק שגיאות", "Errors only") : L("הלוג המלא (סוף)", "Full log (end)")}</button>
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small games-sub">{L("עדיין אין בנייה. הפעל לפרויקט ובבוקר יחכה כאן סיכום.", "No build yet. Turn it on for a project and a summary waits here in the morning.")}</p>
      )}
      <div className="games-night-set">
        {data.projects.map((p) => (
          <div key={p.path} className="games-night-proj">
            <label className="row games-night-switch">
              <input type="checkbox" checked={p.settings.enabled} onChange={(e) => save(p, { enabled: e.target.checked })} />
              <span className="grow" dir="auto">{p.name}</span>
              {p.running ? <span className="games-chip">{L("בונה…", "Building…")}</span> : p.waiting ? <span className="games-chip warn">{p.waiting === "editor" ? L("ממתין: העורך פתוח", "Waiting: editor open") : L("ממתין: המחשב עסוק", "Waiting: computer busy")}</span> : null}
            </label>
            {p.settings.enabled && (
              <div className="row wrap small games-night-opts">
                <label className="row">
                  <span>{L("שעה", "Time")}</span>
                  <input type="time" value={p.settings.time} disabled={remote} onChange={(e) => e.target.value && save(p, { time: e.target.value })} />
                </label>
                {p.platforms.map((pl) => (
                  <label key={pl} className="row">
                    <input type="checkbox" disabled={remote || (p.settings.platforms.length === 1 && p.settings.platforms[0] === pl)} checked={p.settings.platforms.includes(pl)} onChange={(e) => save(p, { platforms: e.target.checked ? [...p.settings.platforms, pl] : p.settings.platforms.filter((x) => x !== pl) })} />
                    <span>{PLATFORM[pl]}</span>
                  </label>
                ))}
                <label className="row">
                  <input type="checkbox" checked={p.settings.smoke} onChange={(e) => save(p, { smoke: e.target.checked })} />
                  <span>{L("בדיקת עשן", "Smoke test")}</span>
                </label>
              </div>
            )}
          </div>
        ))}
        <p className="muted small games-sub">{L("בונה רק כשהמחשב פנוי והעורך של הפרויקט סגור. הבניות נשמרות מחוץ לפרויקט (7 אחרונות). השעה והפלטפורמות משתנות במחשב.", "Builds only when the computer is idle and the project's editor is closed. Builds are kept outside the project (the last 7). The time and platforms are changed on the computer.")}</p>
      </div>
    </section>
  );
}
