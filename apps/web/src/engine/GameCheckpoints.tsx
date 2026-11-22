import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";
import { Diff } from "../ChatCards";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** One file of a checkpoint, as /api/games/checkpoints lists it. */
interface CpFile {
  rel: string;
  size: number;
  /** The file did not exist before: restoring removes it. */
  added?: boolean;
  /** Too big to keep. */
  skipped?: boolean;
}

/** One checkpoint. */
export interface GameCheckpointView {
  id: string;
  engine: "unity" | "unreal" | "godot";
  name: string;
  project: string;
  source: "chat" | "sync" | "source" | "stand-in" | "editor" | "restore";
  label: string;
  at: string;
  chatId?: string;
  files: CpFile[];
}

/** The file comparison (/api/games/checkpoints/:id/diff). */
interface Compare { rel: string; binary: boolean; sizeBefore: number; sizeNow: number; diff?: string }

const SOURCE: Record<GameCheckpointView["source"], [string, string]> = {
  chat: ["צ'אט", "Chat"],
  sync: ["סנכרון", "Sync"],
  source: ["שמירת קוד", "Code save"],
  "stand-in": ["סצנה", "Scene"],
  editor: ["שמירה מעורך", "Editor save"],
  restore: ["לפני שחזור", "Before restore"],
};
const when = (iso: string) => new Date(iso).toLocaleString(getLocale() === "he" ? "he-IL" : undefined, { dateStyle: "short", timeStyle: "short" });

/**
 * A size in words (KB, MB, GB).
 *
 * @param n - Bytes.
 */
export function sizeText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * The Checkpoints sheet (RESEARCH_LOG "Gap list: engine work without the engine open", step 5): the files KesherAI
 * kept before each engine write (a chat turn, a sync batch, a code or scene save), newest first; each file compared with
 * the file now (text) or its sizes (binaries such as .uasset, .prefab); Restore puts the checkpoint's files back (the
 * current ones are kept first, so it can be undone). At the bottom: the store's size and how long and how much it keeps.
 *
 * @param p.project - Only this project's checkpoints (engine and folder); all projects otherwise.
 * @param p.onClose - Closes the sheet.
 */
export function GameCheckpoints({ project, onClose }: { project?: { engine: string; path: string; name: string }; onClose: () => void }) {
  const [data, setData] = useState<{ checkpoints: GameCheckpointView[]; bytes: number; count: number; limits: { days: number; maxMB: number } } | null>(null);
  const [open, setOpen] = useState("");
  const [cmp, setCmp] = useState<(Compare & { id: string }) | null>(null);
  const [busy, setBusy] = useState("");
  const [limits, setLimits] = useState<{ days: string; maxMB: string }>({ days: "", maxMB: "" });
  const load = () =>
    void api<NonNullable<typeof data>>(`/api/games/checkpoints${project ? `?engine=${project.engine}&project=${encodeURIComponent(project.path)}` : ""}`).then((r) => {
      setData(r);
      setLimits({ days: String(r.limits.days), maxMB: String(r.limits.maxMB) });
    }, (e: Error) => toast(e.message));
  useEffect(load, [project?.path]);
  const compare = (c: GameCheckpointView, f: CpFile) => {
    if (cmp?.id === c.id && cmp.rel === f.rel) return setCmp(null);
    void api<Compare>(`/api/games/checkpoints/${encodeURIComponent(c.id)}/diff?path=${encodeURIComponent(f.rel)}`).then((r) => setCmp({ ...r, id: c.id }), (e: Error) => toast(e.message));
  };
  const restore = (c: GameCheckpointView) => {
    if (!confirm(L(`להחזיר ${c.files.length} קבצים של ${c.name} למצב שלפני "${c.label}"? הקבצים של עכשיו יישמרו קודם, כך שאפשר לבטל.`, `Put ${c.files.length} file(s) of ${c.name} back as they were before "${c.label}"? The files as they are now are kept first, so this can be undone.`))) return;
    setBusy(c.id);
    void api<{ restored: number; skipped: number }>(`/api/games/checkpoints/${encodeURIComponent(c.id)}/restore`, { method: "POST" })
      .then((r) => {
        toast(L(`שוחזרו ${r.restored} קבצים${r.skipped ? ` (${r.skipped} לא נשמרו)` : ""}`, `Restored ${r.restored} file(s)${r.skipped ? ` (${r.skipped} were not kept)` : ""}`));
        setCmp(null);
        load();
      }, (e: Error) => toast(e.message))
      .finally(() => setBusy(""));
  };
  const saveLimits = () =>
    void api<{ removed: number; bytes: number }>("/api/games/checkpoints/settings", { method: "PUT", body: { days: Number(limits.days), maxMB: Number(limits.maxMB) } }).then((r) => {
      toast(r.removed ? L(`נשמר. ${r.removed} נקודות ישנות נמחקו.`, `Saved. ${r.removed} old checkpoint(s) removed.`) : L("נשמר", "Saved"));
      load();
    }, (e: Error) => toast(e.message));
  return (
    <div className="hsheet-wrap" onClick={onClose}>
      <div className="hsheet games-sheet" role="dialog" aria-modal="true" aria-label={L("נקודות שחזור", "Checkpoints")} onClick={(e) => e.stopPropagation()}>
        <div className="hsheet-handle" aria-hidden />
        <div className="hd">
          <b className="grow" dir="auto">{L("נקודות שחזור", "Checkpoints")}{project ? ` · ${project.name}` : ""}</b>
          <button type="button" className="ghost small" onClick={onClose} aria-label={L("סגור", "Close")}>✕</button>
        </div>
        <p className="muted small games-sub">{L("לפני כל כתיבה של KesherAI לפרויקט (צ'אט, סנכרון, שמירת קוד או סצנה) נשמרים הקבצים שהיא נוגעת בהם, גם קבצים בינאריים.", "Before each KesherAI write to a project (a chat, a sync, a code or scene save), the files it touches are kept, binaries too.")}</p>
        {!data ? <p className="muted small">…</p> : !data.checkpoints.length && <p className="muted small">{L("אין עדיין נקודות שחזור.", "No checkpoints yet.")}</p>}
        <ul className="games-cps">
          {data?.checkpoints.map((c) => (
            <li key={c.id} className="games-cp">
              <button type="button" className="games-cp-head" aria-expanded={open === c.id} onClick={() => setOpen(open === c.id ? "" : c.id)}>
                <span className="games-cp-label" dir="auto">{c.label || L("ללא תיאור", "No description")}</span>
                <span className="row wrap small games-cp-meta">
                  <span className="games-chip">{L(...SOURCE[c.source])}</span>
                  {!project && <span className="games-chip" dir="auto">{c.name}</span>}
                  <span className="muted">{when(c.at)} · {L(`${c.files.length} קבצים`, `${c.files.length} file(s)`)}</span>
                </span>
              </button>
              {open === c.id && (
                <div className="games-cp-body">
                  <ul className="games-cp-files">
                    {c.files.map((f) => (
                      <li key={f.rel}>
                        <button type="button" className="games-hit" onClick={() => compare(c, f)} aria-expanded={cmp?.id === c.id && cmp.rel === f.rel}>
                          <span className="games-hit-text">
                            <span className="mono small games-cp-path" dir="ltr">{f.rel}</span>
                            <span className="muted small">{f.added ? L("קובץ חדש: השחזור ימחק אותו", "New file: restoring removes it") : f.skipped ? L("גדול מדי, לא נשמר", "Too big, not kept") : sizeText(f.size)}</span>
                          </span>
                        </button>
                        {cmp?.id === c.id && cmp.rel === f.rel && (
                          cmp.binary ? (
                            <p className="muted small games-sub">{L(`קובץ בינארי: ${sizeText(cmp.sizeBefore)} בנקודה, ${sizeText(cmp.sizeNow)} עכשיו.`, `Binary file: ${sizeText(cmp.sizeBefore)} then, ${sizeText(cmp.sizeNow)} now.`)}</p>
                          ) : cmp.diff && /\n[+-](?![+-]{2})/.test(cmp.diff) ? (
                            <div className="games-cp-diff"><Diff diff={cmp.diff} /></div>
                          ) : (
                            <p className="muted small games-sub">{L("לא השתנה מאז.", "Unchanged since.")}</p>
                          )
                        )}
                      </li>
                    ))}
                  </ul>
                  <div className="row wrap games-choices">
                    <button type="button" className="primary" disabled={busy === c.id || c.files.every((f) => f.skipped)} onClick={() => restore(c)}>↺ {L("שחזר לנקודה הזו", "Restore this checkpoint")}</button>
                    {c.chatId && <a className="button" href={`#/c/${c.chatId}`}>{L("לצ'אט", "Open the chat")}</a>}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
        {data && (
          <div className="games-cp-limits">
            <b className="small">{L(`נשמר: ${sizeText(data.bytes)} ב-${data.count} נקודות`, `Kept: ${sizeText(data.bytes)} in ${data.count} checkpoint(s)`)}</b>
            <div className="row wrap small">
              <label className="row">
                <span>{L("ימים", "Days")}</span>
                <input type="number" inputMode="numeric" min={1} max={3650} value={limits.days} onChange={(e) => setLimits({ ...limits, days: e.target.value })} />
              </label>
              <label className="row">
                <span>{L("עד MB", "Up to MB")}</span>
                <input type="number" inputMode="numeric" min={50} value={limits.maxMB} onChange={(e) => setLimits({ ...limits, maxMB: e.target.value })} />
              </label>
              <button type="button" onClick={saveLimits}>{L("שמור ונקה", "Save and prune")}</button>
            </div>
            <p className="muted small games-sub">{L("נשמר בתיקייה לדברים כבדים (הגדרות → המחשב וכרטיס המסך). הישנות ביותר נמחקות ראשונות.", "Kept in the folder for heavy things (Settings → Computer and graphics card). The oldest go first.")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
