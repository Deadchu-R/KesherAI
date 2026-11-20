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
/** A package another one points at: its file in the project when there is one. */
interface Ref { package: string; path?: string }
/** An Unreal .uasset/.umap read from its header (no engine). */
interface UnrealAsset {
  name: string; package: string; className?: string; kind?: string; parent?: string; engine?: string; size: number;
  unversioned: boolean; cooked: boolean; thumbnails: number; problems: string[];
  exports: Array<{ name: string; className: string; superName?: string; top: boolean; size: number }>; exportCount: number;
  uses: Ref[]; soft: Ref[]; engineUses: string[]; usedBy: Array<{ path: string; soft: boolean }>; usedByComplete: boolean;
  tags: Array<{ object: string; className: string; tags: Array<[string, string]> }>;
}
/** The file as the inspector reads it. */
interface View { path: string; objects: InspObject[]; names?: Record<string, string>; readOnly: boolean; open?: boolean; pending: Pending[]; truncated?: boolean; savedAt?: string; asset?: UnrealAsset }
/** A file of the list (Unreal: with its kind from the header). */
interface FileItem { path: string; size: number; kind?: string; parent?: string }

const ENGINE_NAME = { unity: "Unity", unreal: "Unreal", godot: "Godot" } as const;
/** The most objects drawn at once (a big scene has thousands; the filter narrows them). */
const SHOWN = 300;

/**
 * The inspector with the engine closed (RESEARCH_LOG "Gap list: engine work without the engine open", step 6): pick a
 * scene, prefab or asset (Unity .unity/.prefab/.asset/.mat, Godot .tscn/.tres, Unreal: the saved Blueprints), see its
 * objects, their components and values; change a number, a true/false, a text or a vector, and it waits for "Sync now"
 * (written while the engine is closed, after a checkpoint; a value changed in the engine meanwhile becomes a clash).
 * Unreal: every .uasset/.umap, read from its header (step 7): class, parent, exports, what it uses and what uses it.
 *
 * @param p.engine - The project's engine.
 * @param p.project - The project folder.
 * @param p.initialPath - A file to open at once (a search result).
 */
export function GameInspector({ engine, project, initialPath }: { engine: "unity" | "unreal" | "godot"; project: string; initialPath?: string }) {
  const [files, setFiles] = useState<{ files: FileItem[]; note?: string } | null>(null);
  const [fileQ, setFileQ] = useState("");
  const [view, setView] = useState<View | null>(null);
  const [objQ, setObjQ] = useState("");
  const [openObj, setOpenObj] = useState("");
  const [edit, setEdit] = useState<{ target: string; name: string; value: string; from: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const qs = (path?: string) => `engine=${engine}&project=${encodeURIComponent(project)}${path ? `&path=${encodeURIComponent(path)}` : ""}`;
  useEffect(() => {
    void api<{ files: FileItem[]; note?: string }>(`/api/games/inspect/files?${qs()}`).then(setFiles, (e: Error) => { toast(e.message); setFiles({ files: [] }); });
  }, [engine, project]);
  // Opened files, so "back" from a reference returns to the asset it was opened from.
  const [trail, setTrail] = useState<string[]>([]);
  const open = (path: string, from?: string) => void api<View>(`/api/games/inspect?${qs(path)}`).then((v) => { setView(v); setEdit(null); setOpenObj(""); setTrail(from ? [...trail, from] : []); }, (e: Error) => toast(e.message));
  useEffect(() => {
    if (initialPath) open(initialPath);
  }, [initialPath]);
  const back = () => {
    const prev = trail[trail.length - 1];
    if (!prev) return setView(null);
    void api<View>(`/api/games/inspect?${qs(prev)}`).then((v) => { setView(v); setTrail(trail.slice(0, -1)); }, () => setView(null));
  };
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
    const shown = (files?.files ?? []).filter((f) => !fileQ || `${f.path} ${f.kind ?? ""} ${f.parent ?? ""}`.toLowerCase().includes(fileQ.toLowerCase()));
    return (
      <div className="games-inspector">
        <p className="muted small games-sub">{engine === "unreal" ? L("כל ה-.uasset וה-.umap של הפרויקט, נקראים מהקובץ גם כש-Unreal סגור (קריאה בלבד).", "Every .uasset and .umap of the project, read from the file also with Unreal closed (read only).") : L(`הערכים נקראים מהקבצים, גם כש-${ENGINE_NAME[engine]} סגור. ערך ששונה כאן מחכה ל"סנכרן עכשיו".`, `Values are read from the files, also with ${ENGINE_NAME[engine]} closed. A value changed here waits for "Sync now".`)}</p>
        <input type="search" value={fileQ} onChange={(e) => setFileQ(e.target.value)} placeholder={engine === "unreal" ? L("סינון: שם, Blueprint, level, material…", "Filter: name, Blueprint, level, material…") : L("סינון קבצים: סצנה, prefab, asset…", "Filter files: scene, prefab, asset…")} aria-label={L("סינון קבצים", "Filter files")} />
        {!files ? <p className="muted small">…</p> : files.note ? <p className="muted small">{files.note}</p> : !shown.length && <p className="muted small">{L("אין קבצים מתאימים.", "No matching files.")}</p>}
        <ul className="games-cp-files">
          {shown.slice(0, SHOWN).map((f) => (
            <li key={f.path}>
              <button type="button" className="games-hit" onClick={() => open(f.path)}>
                <span className="games-hit-icon" aria-hidden>{/\.(unity|tscn|umap)$/i.test(f.path) ? "🎬" : /\.prefab$/i.test(f.path) || /Blueprint|widget/.test(f.kind ?? "") ? "🧩" : engine === "unreal" ? "🔷" : "📄"}</span>
                <span className="games-hit-text grow"><span className="mono small games-cp-path" dir="ltr">{f.path}</span></span>
                {f.kind && <span className="games-chip small" dir="ltr">{f.kind}{f.parent ? ` · ${f.parent}` : ""}</span>}
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
        <button type="button" className="ghost" onClick={back} aria-label={trail.length ? L("חזרה לנכס הקודם", "Back to the previous asset") : L("חזרה לקבצים", "Back to the files")}>{getLocale() === "he" ? "→" : "←"}</button>
        <span className="mono small grow games-cp-path" dir="ltr">{view.path}</span>
      </div>
      {view.asset && <UnrealAssetView a={view.asset} onOpen={(path) => open(path, view.path)} />}
      {view.asset && view.objects.length > 0 && <b className="small">{L("משתנים (מהעותק השמור)", "Variables (from the saved copy)")}</b>}
      {view.readOnly && !view.asset && <p className="muted small games-sub">{view.savedAt ? L(`עותק שמור מ-${new Date(view.savedAt).toLocaleString("he-IL")}. קריאה בלבד: שינוי דרך עמוד ה-Blueprint או צ'אט.`, `Saved copy from ${new Date(view.savedAt).toLocaleString()}. Read only: change it on the Blueprint's page or in a chat.`) : L("קריאה בלבד", "Read only")}</p>}
      {view.pending.length > 0 && (
        <div className="games-insp-pending" role="status">
          <span className="grow">{L(`${view.pending.length} ערכים מחכים לסנכרון`, `${view.pending.length} value(s) waiting to sync`)}{view.open ? ` · ${L(`סגור את ${ENGINE_NAME[engine]} כדי לכתוב אותם`, `close ${ENGINE_NAME[engine]} to write them`)}` : ""}</span>
          <button type="button" className="primary" disabled={busy || view.open} onClick={syncNow}>{L("סנכרן עכשיו", "Sync now")}</button>
        </div>
      )}
      {view.objects.length > 8 && <input type="search" value={objQ} onChange={(e) => setObjQ(e.target.value)} placeholder={L("סינון: שם אובייקט או רכיב", "Filter: object or component name")} aria-label={L("סינון אובייקטים", "Filter objects")} />}
      {!view.objects.length && !view.asset && <p className="muted small">{L("אין אובייקטים בקובץ.", "No objects in this file.")}</p>}
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

/** Bytes as a short size ("12 KB", "3.4 MB"). */
const sizeText = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * An Unreal package read from its header: what it is (class, parent, engine), its exports, the project's packages it
 * uses (hard and soft) and those that use it; a package of the project opens in the inspector.
 *
 * @param p.a - The package.
 * @param p.onOpen - Opens another package of the project (its file).
 */
function UnrealAssetView({ a, onOpen }: { a: UnrealAsset; onOpen: (path: string) => void }) {
  const refList = (refs: Ref[]) => (
    <ul className="games-cp-files">
      {refs.map((r) => (
        <li key={r.package}>
          {r.path ? (
            <button type="button" className="games-hit" onClick={() => onOpen(r.path!)}>
              <span className="games-hit-icon" aria-hidden>🔷</span>
              <span className="games-hit-text grow"><span className="mono small games-cp-path" dir="ltr">{r.package}</span></span>
            </button>
          ) : (
            <span className="mono small games-cp-path games-ue-ref" dir="ltr">{r.package} <span className="muted">· {L("לא בפרויקט", "not in the project")}</span></span>
          )}
        </li>
      ))}
    </ul>
  );
  return (
    <div className="games-ue">
      <div className="games-insp-comp">
        <b dir="ltr" className="games-cp-path">{a.name}</b>
        <div className="row wrap games-ue-chips">
          {a.className && <span className="games-chip" dir="ltr">{a.className}</span>}
          {a.parent && <span className="games-chip">{L("יורש מ-", "extends ")}<span dir="ltr">{a.parent}</span></span>}
          {a.engine && <span className="games-chip" dir="ltr">Unreal {a.engine}</span>}
          <span className="games-chip" dir="ltr">{sizeText(a.size)}</span>
          {a.thumbnails > 0 && <span className="games-chip">{L("יש תמונה ממוזערת", "Has a thumbnail")}</span>}
          {a.cooked && <span className="games-chip warn">{L("מבושל (cooked)", "Cooked")}</span>}
          {a.unversioned && <span className="games-chip warn">{L("בלי גרסה: הפריסה נוחשה", "Unversioned: layout guessed")}</span>}
        </div>
        <span className="muted small games-cp-path" dir="ltr">{a.package}</span>
        <p className="muted small games-sub">{L("נקרא מכותרת הקובץ, בלי Unreal. קריאה בלבד.", "Read from the file's header, without Unreal. Read only.")}</p>
        {a.problems.length > 0 && <p className="small games-ue-warn" role="status">{L("חלקים שלא נקראו: ", "Parts not read: ")}{a.problems.join(" · ")}</p>}
      </div>
      <details className="games-ue-sec" open={a.usedBy.length > 0 || a.uses.length > 0}>
        <summary>{L(`משתמש ב-${a.uses.length + a.soft.length} · בשימוש ב-${a.usedBy.length}`, `Uses ${a.uses.length + a.soft.length} · Used by ${a.usedBy.length}`)}</summary>
        <b className="small">{L("משתמש ב (קשיח)", "Uses (hard)")}</b>
        {a.uses.length ? refList(a.uses) : <p className="muted small">{L("אין נכסים של הפרויקט.", "No project assets.")}</p>}
        {a.soft.length > 0 && <><b className="small">{L("הפניות רכות (נטענות לפי צורך)", "Soft references (loaded on demand)")}</b>{refList(a.soft)}</>}
        <b className="small">{L("בשימוש ב", "Used by")}</b>
        {a.usedBy.length ? refList(a.usedBy.map((u) => ({ package: `${u.path.replace(/^Content\//, "/Game/").replace(/\.(uasset|umap)$/i, "")}${u.soft ? " (soft)" : ""}`, path: u.path }))) : <p className="muted small">{L("אף נכס בפרויקט לא משתמש בו.", "No asset of the project uses it.")}</p>}
        {!a.usedByComplete && <p className="muted small">{L("לא כל הקבצים נקראו עדיין: פתח שוב בעוד רגע לרשימה מלאה.", "Not every file was read yet: open it again in a moment for the full list.")}</p>}
      </details>
      <details className="games-ue-sec">
        <summary>{L(`אובייקטים בחבילה (${a.exportCount})`, `Objects in the package (${a.exportCount})`)}</summary>
        <dl className="games-insp-fields">
          {a.exports.map((e, i) => (
            <div key={i} className="games-insp-field"><dt className="mono small" dir="ltr">{e.top ? "" : "· "}{e.name}</dt><dd className="mono small" dir="ltr">{e.className}{e.superName ? ` : ${e.superName}` : ""}</dd></div>
          ))}
        </dl>
        {a.exportCount > a.exports.length && <p className="muted small">{L(`מוצגים ${a.exports.length} מתוך ${a.exportCount}.`, `Showing ${a.exports.length} of ${a.exportCount}.`)}</p>}
      </details>
      {a.engineUses.length > 0 && (
        <details className="games-ue-sec">
          <summary>{L(`מודולים של המנוע (${a.engineUses.length})`, `Engine modules (${a.engineUses.length})`)}</summary>
          <p className="mono small games-cp-path" dir="ltr">{a.engineUses.join(", ")}</p>
        </details>
      )}
      {a.tags.some((t) => t.tags.length) && (
        <details className="games-ue-sec">
          <summary>{L("תגיות Asset Registry", "Asset Registry tags")}</summary>
          {a.tags.map((t) => (
            <dl key={t.object} className="games-insp-fields">
              {t.tags.map(([k, v]) => (
                <div key={k} className="games-insp-field"><dt className="mono small" dir="ltr">{k}</dt><dd className="mono small" dir="ltr">{v}</dd></div>
              ))}
            </dl>
          ))}
        </details>
      )}
    </div>
  );
}
