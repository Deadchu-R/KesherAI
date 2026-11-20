import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";
import { GameSearch, type GameHit, type ProjectHits } from "../engine/GameSearch";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** One project, as /api/games lists it. */
interface Project {
  engine: "unity" | "unreal" | "godot";
  name: string;
  path: string;
  version?: string;
  open: boolean;
  pending: number;
  moves?: number;
  clashes: number;
  running?: boolean;
  lastSync?: string;
  problem?: string;
  canSync: boolean;
  page: string;
}

/** One clash on the Sync and conflicts sheet. */
interface Clash {
  id: string;
  engine: "unreal" | "unity";
  project: string;
  /** The queue's project: the folder (Unity) or the name (Unreal). */
  key: string;
  path: string;
  name: string;
  request?: string;
  queuedAt: string;
  baseAt?: string;
  engineAt: string;
  decision?: "mine" | "skip";
  mine: string[];
  diff?: { added: string[]; removed: string[] };
}

/** A change waiting for the editor (/api/unreal/queue, /api/unity/queue). */
interface Waiting { id: string; project: string; path: string; request?: string; at: string; kind?: string; clash?: unknown }

const ENGINE: Record<Project["engine"], { label: string; icon: string }> = { unity: { label: "Unity", icon: "🕹" }, unreal: { label: "Unreal", icon: "🎮" }, godot: { label: "Godot", icon: "🤖" } };
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString(getLocale() === "he" ? "he-IL" : undefined, { dateStyle: "short", timeStyle: "short" }) : "");
const same = (a: string, b: string) => a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();

/**
 * Game projects: every Unity, Unreal and Godot project on this computer in one list, with its editor open or closed,
 * the changes made with it closed that wait to sync, the last sync and its problems; "Sync now"; and the Sync and
 * conflicts sheet (a change that clashes with an edit made in the engine waits for a choice, every time).
 *
 * @param p.sync - Open the sheet at once (a notification's link: #/games?sync=1).
 */
export function GamesPage({ sync = false }: { sync?: boolean }) {
  const [list, setList] = useState<{ projects: Project[]; clashes: number } | null>(null);
  const [sheet, setSheet] = useState<{ project?: Project } | null>(sync ? {} : null);
  const [search, setSearch] = useState<{ project?: Project; q: string } | null>(null);
  const load = () => void api<{ projects: Project[]; clashes: number }>("/api/games").then(setList, (e: Error) => toast(e.message));
  const busy = !!list?.projects.some((p) => p.running);
  useEffect(() => {
    load();
    // Quicker while a sync runs (a batch Unity or a headless Unreal takes a minute or more).
    const t = setInterval(load, busy ? 3000 : 15_000);
    return () => clearInterval(t);
  }, [busy]);
  const syncNow = (p: Project) =>
    void api("/api/games/sync", { method: "POST", body: { engine: p.engine, project: p.path } }).then(() => {
      toast(L(`מסנכרן את ${p.name}…`, `Syncing ${p.name}…`));
      setTimeout(load, 800);
    }, (e: Error) => toast(e.message));
  // A tapped search result: code opens in the Source view at its line; a scene, prefab or asset on its engine's page.
  const openHit = (r: ProjectHits, h: GameHit) => {
    if (h.kind === "code" || h.kind === "script") {
      void navigator.clipboard?.writeText(`${h.path}${h.line ? `:${h.line}` : ""}`).catch(() => undefined);
      toast(L(`הנתיב הועתק: ${h.path}`, `Path copied: ${h.path}`));
      return;
    }
    location.hash = r.engine === "unity" ? "#/unity" : r.engine === "unreal" ? "#/unreal" : "#/godot";
  };

  return (
    <div className="page games-page">
      <h1>{L("פרויקטי משחק", "Game projects")}</h1>
      <p className="muted small">{L("כל הפרויקטים של Unity, Unreal ו-Godot במחשב. שינויים שנעשים כשהמנוע סגור מחכים כאן ומסונכרנים אחר כך.", "Every Unity, Unreal and Godot project on this computer. Changes made with the engine closed wait here and sync later.")}</p>
      <button type="button" className="games-search-box" onClick={() => setSearch({ q: "" })}>
        <span aria-hidden>🔍</span>
        <span className="muted grow">{L("חיפוש בכל הפרויקטים: מחלקה, סקריפט, סצנה, Blueprint…", "Search all projects: class, script, scene, Blueprint…")}</span>
      </button>
      {!!list?.clashes && (
        <button type="button" className="games-clash-banner" onClick={() => setSheet({})}>
          <span aria-hidden>⚠</span>
          <span className="grow">{L(`${list.clashes} שינויים התנגשו בעריכה שנעשתה במנוע. בחר מה לשמור.`, `${list.clashes} change(s) clash with an edit made in the engine. Choose what to keep.`)}</span>
          <b>{L("פתח", "Open")}</b>
        </button>
      )}
      {!list ? (
        <p className="muted">…</p>
      ) : !list.projects.length ? (
        <p className="muted">{L("לא נמצאו פרויקטים. פתח פרויקט פעם אחת ב-Unity, Unreal או Godot, או הוסף אותו בעמוד של המנוע.", "No projects found. Open a project once in Unity, Unreal or Godot, or add it on the engine's page.")}</p>
      ) : (
        <div className="games-list">
          {list.projects.map((p) => (
            <section key={`${p.engine}:${p.path}`} className="card games-card">
              <div className="row games-head">
                <span aria-hidden>{ENGINE[p.engine].icon}</span>
                <strong className="grow" dir="auto">{p.name}</strong>
                <span className="games-chip">{ENGINE[p.engine].label}{p.version ? ` ${p.version}` : ""}</span>
              </div>
              <div className="row small games-state">
                <span className={`hub-led ${p.open ? "ok" : "off"}`} aria-hidden />
                <span>{p.open ? L("העורך פתוח", "Editor open") : L("העורך סגור", "Editor closed")}</span>
                {p.pending > 0 && <span className="games-chip warn">{L(`${p.pending} ממתינים`, `${p.pending} waiting`)}</span>}
                {p.clashes > 0 && <span className="games-chip bad">{L(`${p.clashes} התנגשויות`, `${p.clashes} clash${p.clashes > 1 ? "es" : ""}`)}</span>}
                {p.running && <span className="games-chip">{L("מסנכרן…", "Syncing…")}</span>}
              </div>
              {(p.lastSync || p.moves) && (
                <p className="muted small games-sub">
                  {p.lastSync ? L(`סנכרון אחרון: ${when(p.lastSync)}`, `Last sync: ${when(p.lastSync)}`) : ""}
                  {p.lastSync && p.moves ? " · " : ""}
                  {p.moves ? L(`${p.moves} הזזות בסצנה ייכנסו כש-Unity ייפתח`, `${p.moves} scene move(s) go in when Unity opens`) : ""}
                </p>
              )}
              {p.problem && <p className="small games-problem" role="alert">{p.problem}</p>}
              <div className="row wrap games-actions">
                {p.canSync && <button type="button" className="primary" disabled={p.running} onClick={() => syncNow(p)}>{L("סנכרן עכשיו", "Sync now")}</button>}
                {(p.pending > 0 || p.clashes > 0) && <button type="button" onClick={() => setSheet({ project: p })}>{L("הצג ממתינים", "View pending")}</button>}
                <button type="button" onClick={() => setSearch({ project: p, q: "" })} aria-label={L(`חיפוש ב-${p.name}`, `Search ${p.name}`)}>🔍 {L("חיפוש", "Search")}</button>
                <a className="button" href={p.page}>{L("לעמוד הפרויקט", "Project page")}</a>
              </div>
            </section>
          ))}
        </div>
      )}
      {search && <GameSearch key={search.project?.path ?? "all"} {...(search.project ? { project: search.project } : {})} initial={search.q} onOpen={openHit} onClose={() => setSearch(null)} />}
      {sheet && <SyncSheet {...(sheet.project ? { project: sheet.project } : {})} onClose={() => setSheet(null)} onChange={load} />}
    </div>
  );
}

/**
 * The Sync and conflicts sheet: each clash with both sides (my queued operations; the nodes the engine added and
 * removed when its editor is open to read) and the choice, then the changes still waiting.
 *
 * @param p.project - Only this project's changes (from its "View pending"); all projects otherwise.
 * @param p.onClose - Closes the sheet.
 * @param p.onChange - After a choice (the list reloads).
 */
function SyncSheet({ project, onClose, onChange }: { project?: Project; onClose: () => void; onChange: () => void }) {
  const [clashes, setClashes] = useState<Clash[] | null>(null);
  const [waiting, setWaiting] = useState<Array<Waiting & { engine: "unreal" | "unity" }>>([]);
  const [busy, setBusy] = useState("");
  const mineOf = (engine: "unreal" | "unity", proj: string) => !project || (project.engine === engine && (engine === "unity" ? same(proj, project.path) : proj.toLowerCase() === project.name.toLowerCase()));
  const load = () => {
    void api<{ conflicts: Clash[] }>("/api/games/conflicts").then((r) => setClashes(r.conflicts.filter((c) => mineOf(c.engine, c.key))), (e: Error) => { toast(e.message); setClashes([]); });
    void Promise.all((["unreal", "unity"] as const).map((engine) => api<Waiting[]>(`/api/${engine}/queue`).then((q) => q.map((x) => ({ ...x, engine })), () => [])))
      .then((all) => setWaiting(all.flat().filter((q) => !q.clash && mineOf(q.engine, q.project))));
  };
  useEffect(load, [project?.path]);
  const choose = (c: Clash, choice: "mine" | "engine" | "skip") => {
    setBusy(c.id);
    void api(`/api/games/conflicts/${encodeURIComponent(c.id)}`, { method: "POST", body: { choice } }).then(() => {
      toast(choice === "mine" ? L("השינוי שלך יוחל עכשיו", "Your change goes in now") : choice === "engine" ? L("הגרסה של המנוע נשמרה", "The engine's version stays") : L("נשאר לאחר כך", "Left for later"));
      load();
      onChange();
    }, (e: Error) => toast(e.message)).finally(() => setBusy(""));
  };
  const app = (e: "unreal" | "unity") => (e === "unity" ? "Unity" : "Unreal");
  return (
    <div className="hsheet-wrap" onClick={onClose}>
      <div className="hsheet games-sheet" role="dialog" aria-modal="true" aria-label={L("סנכרון והתנגשויות", "Sync and conflicts")} onClick={(e) => e.stopPropagation()}>
        <div className="hsheet-handle" aria-hidden />
        <div className="hd">
          <b className="grow">{L("סנכרון והתנגשויות", "Sync and conflicts")}{project ? ` · ${project.name}` : ""}</b>
          <button type="button" className="ghost small" onClick={onClose} aria-label={L("סגור", "Close")}>✕</button>
        </div>
        {!clashes ? <p className="muted small">…</p> : !clashes.length && !waiting.length && <p className="muted small">{L("אין שינויים ממתינים ואין התנגשויות.", "Nothing is waiting and nothing clashes.")}</p>}
        {clashes?.map((c) => (
          <div key={c.id} className="games-clash">
            <div className="row">
              <strong className="grow" dir="auto">{c.name}</strong>
              <span className="games-chip">{app(c.engine)} · {c.project}</span>
              {c.decision === "skip" && <span className="games-chip">{L("דולג לעכשיו", "Skipped for now")}</span>}
            </div>
            <div className="games-sides">
              <div className="games-side">
                <b className="small">{L(`השינוי שלי (${when(c.queuedAt)})`, `Mine (${when(c.queuedAt)})`)}</b>
                {c.request && <p className="small" dir="auto">{c.request}</p>}
                <ul className="mono small" dir="ltr">{c.mine.map((m, i) => <li key={i}>{m}</li>)}</ul>
              </div>
              <div className="games-side">
                <b className="small">{L(`של ${app(c.engine)} (נשמר ${when(c.engineAt)})`, `${app(c.engine)}'s (saved ${when(c.engineAt)})`)}</b>
                {c.diff ? (
                  <ul className="mono small" dir="ltr">
                    {c.diff.added.map((n, i) => <li key={`a${i}`} className="good">+ {n}</li>)}
                    {c.diff.removed.map((n, i) => <li key={`r${i}`} className="bad">− {n}</li>)}
                    {!c.diff.added.length && !c.diff.removed.length && <li className="muted">{L("אותם צמתים; השתנו חיבורים או ערכים", "Same nodes; links or values changed")}</li>}
                  </ul>
                ) : (
                  <p className="muted small">{L(`הגרף נשמר ב-${app(c.engine)} אחרי העותק שעליו עשית את השינוי. פתח את ${app(c.engine)} כדי לראות כאן מה השתנה.`, `The graph was saved in ${app(c.engine)} after the copy your change was made on. Open ${app(c.engine)} to see here what changed.`)}</p>
                )}
              </div>
            </div>
            <div className="row wrap games-choices">
              <button type="button" className="primary" disabled={busy === c.id} onClick={() => choose(c, "mine")}>{L("שמור את שלי", "Keep mine")}</button>
              <button type="button" disabled={busy === c.id} onClick={() => choose(c, "engine")}>{L(`שמור את של ${app(c.engine)}`, `Keep ${app(c.engine)}'s`)}</button>
              {c.decision !== "skip" && <button type="button" className="ghost" disabled={busy === c.id} onClick={() => choose(c, "skip")}>{L("דלג לעכשיו", "Skip for now")}</button>}
            </div>
          </div>
        ))}
        {waiting.length > 0 && (
          <>
            <b className="small">{L(`ממתינים לסנכרון (${waiting.length})`, `Waiting to sync (${waiting.length})`)}</b>
            <ul className="games-waiting small">
              {waiting.map((w) => (
                <li key={w.id}>
                  <span dir="auto">{w.kind === "create" ? L("Blueprint חדש: ", "New Blueprint: ") : ""}{w.path.split("#")[0]!.split("/").pop()}</span>
                  <span className="muted"> · {app(w.engine)} · {when(w.at)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
