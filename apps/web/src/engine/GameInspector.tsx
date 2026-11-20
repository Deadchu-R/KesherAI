import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** One value, as /api/games/inspect gives it. */
interface Field { name: string; value: string; editable: boolean }
/** One component (Unity) or a node's own properties (Godot). */
interface Component { target: string; type: string; script?: string; scriptPath?: string; fields: Field[] }
/** One object of the file. */
interface InspObject { id: string; name: string; parent?: string; components: Component[]; prefab?: { source?: string; overrides: Array<{ target: string; name: string; value: string }> } }
/** A value waiting for the next sync. */
interface Pending { id: string; target: string; name: string; from: string; to: string; clash?: { now: string } }
/** The file as the inspector reads it. */
interface View { path: string; objects: InspObject[]; names?: Record<string, string>; readOnly: boolean; open?: boolean; pending: Pending[]; truncated?: boolean; savedAt?: string }

const ENGINE_NAME = { unity: "Unity", unreal: "Unreal", godot: "Godot" } as const;
/** The most objects drawn at once (a big scene has thousands; the filter narrows them). */
const SHOWN = 300;

/**
 * The inspector with the engine closed (RESEARCH_LOG "Gap list: engine work without the engine open", step 6): pick a
 * scene, prefab or asset (Unity .unity/.prefab/.asset/.mat, Godot .tscn/.tres, Unreal: the saved Blueprints), see its
 * objects, their components and values; change a number, a true/false, a text or a vector, and it waits for "Sync now"
 * (written while the engine is closed, after a checkpoint; a value changed in the engine meanwhile becomes a clash).
 *
 * @param p.engine - The project's engine.
 * @param p.project - The project folder.
 */
export function GameInspector({ engine, project }: { engine: "unity" | "unreal" | "godot"; project: string }) {
  const [files, setFiles] = useState<{ files: Array<{ path: string; size: number }>; note?: string } | null>(null);
  const [fileQ, setFileQ] = useState("");
  const [view, setView] = useState<View | null>(null);
  const [objQ, setObjQ] = useState("");
  const [openObj, setOpenObj] = useState("");
  const [edit, setEdit] = useState<{ target: string; name: string; value: string; from: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const qs = (path?: string) => `engine=${engine}&project=${encodeURIComponent(project)}${path ? `&path=${encodeURIComponent(path)}` : ""}`;
  useEffect(() => {
    void api<{ files: Array<{ path: string; size: number }>; note?: string }>(`/api/games/inspect/files?${qs()}`).then(setFiles, (e: Error) => { toast(e.message); setFiles({ files: [] }); });
  }, [engine, project]);
  const open = (path: string) => void api<View>(`/api/games/inspect?${qs(path)}`).then((v) => { setView(v); setEdit(null); }, (e: Error) => toast(e.message));
  const reload = () => view && open(view.path);

  // Each object's depth (parents first where the file has them so), for the indented list.
  const depth = useMemo(() => {
    const byId = new Map(view?.objects.map((o) => [o.id, o]) ?? []);
    const d = new Map<string, number>();
    const of = (o: InspObject, n = 0): number => (n > 30 || !o.parent || !byId.has(o.parent) ? 0 : 1 + of(byId.get(o.parent)!, n + 1));
    for (const o of view?.objects ?? []) d.set(o.id, of(o));
    return d;
  }, [view]);

  if (!view) {
    const shown = (files?.files ?? []).filter((f) => !fileQ || f.path.toLowerCase().includes(fileQ.toLowerCase()));
    return (
      <div className="games-inspector">
        <p className="muted small games-sub">{engine === "unreal" ? L("ערכי ברירת המחדל של המשתנים ב-Blueprints שנשמרו כאן (קריאה בלבד).", "The variables' defaults of the Blueprints saved here (read only).") : L(`הערכים נקראים מהקבצים, גם כש-${ENGINE_NAME[engine]} סגור. ערך ששונה כאן מחכה ל"סנכרן עכשיו".`, `Values are read from the files, also with ${ENGINE_NAME[engine]} closed. A value changed here waits for "Sync now".`)}</p>
        <input type="search" value={fileQ} onChange={(e) => setFileQ(e.target.value)} placeholder={L("סינון קבצים: סצנה, prefab, asset…", "Filter files: scene, prefab, asset…")} aria-label={L("סינון קבצים", "Filter files")} />
        {!files ? <p className="muted small">…</p> : files.note ? <p className="muted small">{files.note}</p> : !shown.length && <p className="muted small">{L("אין קבצים מתאימים.", "No matching files.")}</p>}
        <ul className="games-cp-files">
          {shown.slice(0, SHOWN).map((f) => (
            <li key={f.path}>
              <button type="button" className="games-hit" onClick={() => open(f.path)}>
                <span className="games-hit-icon" aria-hidden>{/\.(unity|tscn|umap)$/i.test(f.path) ? "🎬" : /\.prefab$/i.test(f.path) ? "🧩" : engine === "unreal" ? "🔷" : "📄"}</span>
                <span className="games-hit-text"><span className="mono small games-cp-path" dir="ltr">{f.path}</span></span>
              </button>
            </li>
          ))}
        </ul>
        {shown.length > SHOWN && <p className="muted small">{L(`מוצגים ${SHOWN} מתוך ${shown.length}. סנן כדי לצמצם.`, `Showing ${SHOWN} of ${shown.length}. Filter to narrow.`)}</p>}
      </div>
    );
  }

  const pendingOf = (target: string, name: string) => view.pending.find((p) => p.target === target && p.name === name);
  const save = () => {
    if (!edit) return;
    setBusy(true);
    void api<{ queued: boolean }>("/api/games/inspect/value", { method: "POST", body: { engine, project, path: view.path, target: edit.target, name: edit.name, from: edit.from, to: edit.value } })
      .then((r) => { toast(r.queued ? L("נשמר. ייכתב בסנכרון הבא.", "Kept. It is written at the next sync.") : L("חזר לערך שבקובץ", "Back to the value in the file")); reload(); }, (e: Error) => toast(e.message))
      .finally(() => setBusy(false));
  };
  const drop = (p: Pending) => void api(`/api/games/inspect/value/${encodeURIComponent(p.id)}`, { method: "DELETE" }).then(reload, (e: Error) => toast(e.message));
  const syncNow = () => {
    setBusy(true);
    void api<{ values?: { applied: number; clashes: number } }>("/api/games/sync", { method: "POST", body: { engine, project } })
      .then((r) => { toast(r.values?.clashes ? L(`${r.values.applied} נכתבו, ${r.values.clashes} התנגשו: בחר בגיליון הסנכרון.`, `${r.values.applied} written, ${r.values.clashes} clashed: choose on the Sync sheet.`) : L("הערכים נכתבו לקובץ", "The values were written into the file")); reload(); }, (e: Error) => toast(e.message))
      .finally(() => setBusy(false));
  };
  const matches = view.objects.filter((o) => !objQ || o.name.toLowerCase().includes(objQ.toLowerCase()) || o.components.some((c) => c.type.toLowerCase().includes(objQ.toLowerCase())));
  const scriptName = (c: Component) => (c.script ? view.names?.[c.script]?.split("/").pop() : c.scriptPath?.split("/").pop());
  return (
    <div className="games-inspector">
      <div className="row games-insp-head">
        <button type="button" className="ghost" onClick={() => setView(null)} aria-label={L("חזרה לקבצים", "Back to the files")}>{getLocale() === "he" ? "→" : "←"}</button>
        <span className="mono small grow games-cp-path" dir="ltr">{view.path}</span>
      </div>
      {view.readOnly && <p className="muted small games-sub">{view.savedAt ? L(`עותק שמור מ-${new Date(view.savedAt).toLocaleString("he-IL")}. קריאה בלבד: שינוי דרך עמוד ה-Blueprint או צ'אט.`, `Saved copy from ${new Date(view.savedAt).toLocaleString()}. Read only: change it on the Blueprint's page or in a chat.`) : L("קריאה בלבד", "Read only")}</p>}
      {view.pending.length > 0 && (
        <div className="games-insp-pending" role="status">
          <span className="grow">{L(`${view.pending.length} ערכים מחכים לסנכרון`, `${view.pending.length} value(s) waiting to sync`)}{view.open ? ` · ${L(`סגור את ${ENGINE_NAME[engine]} כדי לכתוב אותם`, `close ${ENGINE_NAME[engine]} to write them`)}` : ""}</span>
          <button type="button" className="primary" disabled={busy || view.open} onClick={syncNow}>{L("סנכרן עכשיו", "Sync now")}</button>
        </div>
      )}
      {view.objects.length > 8 && <input type="search" value={objQ} onChange={(e) => setObjQ(e.target.value)} placeholder={L("סינון: שם אובייקט או רכיב", "Filter: object or component name")} aria-label={L("סינון אובייקטים", "Filter objects")} />}
      {!view.objects.length && <p className="muted small">{L("אין אובייקטים בקובץ.", "No objects in this file.")}</p>}
      <ul className="games-insp-objs">
        {matches.slice(0, SHOWN).map((o) => (
          <li key={o.id} style={{ paddingInlineStart: `${Math.min(depth.get(o.id) ?? 0, 6) * 12}px` }}>
            <button type="button" className="games-cp-head" aria-expanded={openObj === o.id} onClick={() => setOpenObj(openObj === o.id ? "" : o.id)}>
              <span className="games-cp-label" dir="auto">{o.prefab ? "🧩 " : ""}{o.name}</span>
              <span className="muted small games-cp-label" dir="ltr">{o.components.map((c) => scriptName(c) ?? c.type).filter((t) => t !== "GameObject").join(" · ")}</span>
            </button>
            {openObj === o.id && (
              <div className="games-cp-body">
                {o.prefab && (
                  <div className="games-insp-comp">
                    <b className="small">{L("Prefab · מקור: ", "Prefab · source: ")}<span className="mono" dir="ltr">{(o.prefab.source && (view.names?.[o.prefab.source] ?? o.prefab.source)) || "?"}</span></b>
                    {o.prefab.overrides.length > 0 && (
                      <dl className="games-insp-fields">
                        {o.prefab.overrides.map((f, i) => (
                          <div key={i} className="games-insp-field"><dt className="mono small" dir="ltr">{f.name}</dt><dd className="mono small" dir="ltr">{f.value}</dd></div>
                        ))}
                      </dl>
                    )}
                  </div>
                )}
                {o.components.map((c) => (
                  <div key={`${c.target}:${c.type}`} className="games-insp-comp">
                    <b className="small" dir="ltr">{c.type}{scriptName(c) ? ` · ${scriptName(c)}` : ""}</b>
                    {!c.fields.length ? <p className="muted small games-sub">{engine === "godot" ? L("אין ערכים שונים מברירת המחדל.", "No values changed from the default.") : L("אין ערכים.", "No values.")}</p> : (
                      <dl className="games-insp-fields">
                        {c.fields.map((f) => {
                          const p = pendingOf(c.target, f.name);
                          const editing = edit?.target === c.target && edit.name === f.name;
                          return (
                            <div key={f.name} className={`games-insp-field${p ? " pending" : ""}`}>
                              <dt className="mono small" dir="ltr">{f.name}</dt>
                              <dd className="mono small" dir="ltr">
                                {editing ? (
                                  <span className="row wrap games-insp-edit">
                                    <input autoFocus value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEdit(null); }} aria-label={f.name} />
                                    <button type="button" className="primary" disabled={busy} onClick={save}>{L("שמור", "Keep")}</button>
                                    <button type="button" className="ghost" onClick={() => setEdit(null)}>{L("ביטול", "Cancel")}</button>
                                  </span>
                                ) : (
                                  <>
                                    {p ? <><s className="muted">{f.value}</s> → <b>{p.to}</b></> : f.value}
                                    {!view.readOnly && f.editable && <button type="button" className="ghost small" onClick={() => setEdit({ target: c.target, name: f.name, value: (p?.to ?? f.value).replace(/^"(.*)"$/, "$1"), from: p?.to ?? f.value })} aria-label={L(`שנה ${f.name}`, `Change ${f.name}`)}>✎</button>}
                                    {p && <button type="button" className="ghost small" onClick={() => drop(p)} aria-label={L("בטל את השינוי", "Undo this change")}>✕</button>}
                                    {p?.clash && <span className="games-chip bad">{L("התנגשות", "Clash")}</span>}
                                  </>
                                )}
                              </dd>
                            </div>
                          );
                        })}
                      </dl>
                    )}
                  </div>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      {(matches.length > SHOWN || view.truncated) && <p className="muted small">{L(`מוצגים ${Math.min(SHOWN, matches.length)} אובייקטים. סנן כדי לראות אחרים.`, `Showing ${Math.min(SHOWN, matches.length)} objects. Filter to see others.`)}</p>}
    </div>
  );
}
