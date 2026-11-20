import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** The kinds of results, as /api/games/search names them. */
export type HitKind = "code" | "script" | "scene" | "prefab" | "asset";

/** One search result. */
export interface GameHit { kind: HitKind; name: string; path: string; line?: number; detail: string }

/** A project's results. */
export interface ProjectHits { engine: "unity" | "unreal" | "godot"; name: string; path: string; hits: GameHit[]; counts: Record<HitKind, number> }

const KINDS: Array<{ id: HitKind | ""; he: string; en: string; icon: string }> = [
  { id: "", he: "הכל", en: "All", icon: "" },
  { id: "code", he: "מחלקות ופונקציות", en: "Classes and functions", icon: "ƒ" },
  { id: "script", he: "סקריפטים", en: "Scripts", icon: "📄" },
  { id: "scene", he: "סצנות ושלבים", en: "Scenes and levels", icon: "🗺" },
  { id: "prefab", he: "פריפאבים ו-Blueprints", en: "Prefabs and Blueprints", icon: "🧩" },
  { id: "asset", he: "נכסים", en: "Assets", icon: "🎨" },
];
const iconOf = (k: HitKind) => KINDS.find((x) => x.id === k)!.icon;

/**
 * The search sheet of the Game projects page (step 3 of the engine-closed plan): classes and functions with their
 * lines, scripts, scenes, prefabs and Blueprints, and assets, found in the projects' index with the engine closed;
 * kind chips with counts; a result opens in the Source view (code) or its engine page.
 *
 * @param p.project - Search only this project (its card's 🔍); all projects otherwise.
 * @param p.initial - The words typed in the page's box.
 * @param p.onOpen - What a tapped result does.
 * @param p.onClose - Closes the sheet.
 */
export function GameSearch({ project, initial = "", onOpen, onClose }: { project?: { engine: string; path: string; name: string }; initial?: string; onOpen: (r: ProjectHits, h: GameHit) => void; onClose: () => void }) {
  const [q, setQ] = useState(initial);
  const [kind, setKind] = useState<HitKind | "">("");
  const [results, setResults] = useState<ProjectHits[] | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    // A short wait after each key, and only the newest answer is shown.
    const n = ++seq.current;
    const t = setTimeout(() => {
      setBusy(true);
      const qs = new URLSearchParams({ q, ...(kind ? { kind } : {}), ...(project ? { engine: project.engine, project: project.path } : {}) });
      void api<{ results: ProjectHits[] }>(`/api/games/search?${qs}`).then((r) => n === seq.current && setResults(r.results), (e: Error) => toast(e.message)).finally(() => n === seq.current && setBusy(false));
    }, 250);
    return () => clearTimeout(t);
  }, [q, kind, project?.path]);
  // The chips' counts: of one project, or summed over all.
  const counts = (results ?? []).reduce<Record<string, number>>((m, r) => {
    for (const [k, v] of Object.entries(r.counts)) m[k] = (m[k] ?? 0) + v;
    return m;
  }, {});
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <div className="hsheet-wrap" onClick={onClose}>
      <div className="hsheet games-sheet games-search" role="dialog" aria-modal="true" aria-label={L("חיפוש בפרויקט", "Search the project")} onClick={(e) => e.stopPropagation()}>
        <div className="hsheet-handle" aria-hidden />
        <div className="hd">
          <b className="grow">{L("חיפוש", "Search")}{project ? ` · ${project.name}` : L(" בכל הפרויקטים", " in all projects")}</b>
          <button type="button" className="ghost small" onClick={onClose} aria-label={L("סגור", "Close")}>✕</button>
        </div>
        <input type="search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={L("מחלקה, סקריפט, סצנה, פריפאב, Blueprint…", "Class, script, scene, prefab, Blueprint…")} aria-label={L("מה לחפש", "What to find")} dir="auto" />
        <div className="games-kinds" role="tablist" aria-label={L("סוג", "Kind")}>
          {KINDS.map((k) => (
            <button key={k.id} type="button" role="tab" aria-selected={kind === k.id} className={`games-chip${kind === k.id ? " on" : ""}`} onClick={() => setKind(k.id)}>
              {k.icon ? `${k.icon} ` : ""}{L(k.he, k.en)}{results && q.trim() ? ` ${k.id ? counts[k.id] ?? 0 : total}` : ""}
            </button>
          ))}
        </div>
        <p className="muted small games-search-note">{busy ? L("מחפש…", "Searching…") : L("מהאינדקס של הפרויקט: עובד גם כשהמנוע סגור.", "From the project's index: works with the engine closed too.")}</p>
        {results && !q.trim() && project && results[0] && (
          <p className="small">{L(`${results[0].counts.script} סקריפטים · ${results[0].counts.code} מחלקות ופונקציות · ${results[0].counts.scene} סצנות · ${results[0].counts.prefab} פריפאבים ו-Blueprints · ${results[0].counts.asset} נכסים`, `${results[0].counts.script} scripts · ${results[0].counts.code} classes and functions · ${results[0].counts.scene} scenes · ${results[0].counts.prefab} prefabs and Blueprints · ${results[0].counts.asset} assets`)}</p>
        )}
        {results && q.trim() && !results.some((r) => r.hits.length) && !busy && <p className="muted small">{L("לא נמצא כלום.", "Nothing found.")}</p>}
        {results?.filter((r) => r.hits.length).map((r) => (
          <section key={`${r.engine}:${r.path}`} className="games-results">
            {!project && <b className="small">{r.name} <span className="muted">· {r.engine === "unity" ? "Unity" : r.engine === "unreal" ? "Unreal" : "Godot"}</span></b>}
            <ul>
              {r.hits.map((h) => (
                <li key={`${h.kind}:${h.path}:${h.line ?? 0}:${h.name}`}>
                  <button type="button" className="games-hit" onClick={() => onOpen(r, h)}>
                    <span className="games-hit-icon" aria-hidden>{iconOf(h.kind)}</span>
                    <span className="grow games-hit-text">
                      <span className="games-hit-name" dir="ltr">{h.name}</span>
                      <span className="muted small games-hit-path" dir="ltr">{h.path}{h.line ? `:${h.line}` : ""}</span>
                    </span>
                    <span className="games-chip small">{h.detail}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
