import { useCallback, useEffect, useMemo, useState } from "react";
import { api, withToken } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";
import "./design-page.css";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** A board as /api/design lists it (packages/core/src/design-render.ts). */
interface Board {
  name: string;
  title: string;
  group: string;
  viewport: "desktop" | "phone";
  w: number;
  h: number;
  hash: string;
  changedAt: string;
  newest: boolean;
  note: string;
}
interface DesignState {
  available: boolean;
  boards: Board[];
  baseVersion: string;
  running: { since: string; step: string } | null;
  error: string;
  last?: { at: string; ms: number; diff: { added: string[]; changed: string[]; same: string[]; removed: string[] }; errors: string[] };
}

const shot = (b: Board) => withToken(`/api/design/shot/${encodeURIComponent(b.name)}?v=${b.hash.slice(0, 12)}`);
const when = (iso: string) => new Date(iso).toLocaleString(getLocale() === "he" ? "he-IL" : "en-US", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * Design (#/design): the design-doc boards KesherAI renders itself from tools/design/scenarios, by group with the
 * newest first; tap a board for full size and a note for Claude; "Render again" shoots every board anew. The same
 * boards go to Claude's design doc (publish.json in the design-out folder). Works from the phone (remote).
 */
export function DesignPage() {
  const [s, setS] = useState<DesignState | null>(null);
  const [open, setOpen] = useState<Board | null>(null);
  const [onlyNew, setOnlyNew] = useState(false);

  const load = useCallback(() => api<DesignState>("/api/design").then(setS, () => setS({ available: false, boards: [], baseVersion: "", running: null, error: "" })), []);
  useEffect(() => void load(), [load]);
  // While a render runs, follow it.
  useEffect(() => {
    if (!s?.running) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [s?.running, load]);

  const render = async () => {
    try {
      await api("/api/design/render", { method: "POST", body: {} });
      toast(L("מצלם את הלוחות מחדש…", "Rendering the boards again…"));
      await load();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const groups = useMemo(() => {
    const list = (s?.boards ?? []).filter((b) => !onlyNew || b.newest);
    const by = new Map<string, Board[]>();
    for (const b of list) by.set(b.group, [...(by.get(b.group) ?? []), b]);
    // Groups with something new come first; inside, the server's order (newest first).
    return [...by.entries()].sort((a, b) => Number(b[1].some((x) => x.newest)) - Number(a[1].some((x) => x.newest)));
  }, [s, onlyNew]);

  if (!s) return <div className="page"><div className="page-loading" aria-busy="true" /></div>;
  const newCount = s.boards.filter((b) => b.newest).length;

  return (
    <div className="page design-page">
      <div className="row design-head">
        <h1 className="grow">{L("עיצוב", "Design")}</h1>
        <button type="button" className="primary" disabled={!s.available || !!s.running} onClick={() => void render()}>
          {s.running ? L("מצלם…", "Rendering…") : L("צלם שוב", "Render again")}
        </button>
      </div>
      <p className="muted small">
        {L("הלוחות של מסמך העיצוב, מצולמים מהממשק האמיתי עם נתוני דוגמה. Claude מפרסם את אותם לוחות למסמך שלו.", "The design doc's boards, shot from the real interface with sample data. Claude publishes the same boards to his doc.")}
      </p>
      {!s.available && (
        <div className="card small">{L("לא נמצאה תיקיית הקוד של KesherAI עם tools/design/scenarios. בחר אותה בהגדרות > תיבת משימות.", "No KesherAI source folder with tools/design/scenarios. Choose it in Settings > Task inbox.")}</div>
      )}
      {s.running && <div className="card small design-status" role="status">⏳ {L("מצלם", "Rendering")} <bdi dir="ltr">{s.running.step}</bdi></div>}
      {s.error && <div className="card small design-error" role="alert">{s.error}</div>}
      {s.last && !s.running && (
        <p className="small muted design-last">
          {L("צילום אחרון", "Last render")}: {when(s.last.at)} · {L(`${s.last.diff.added.length} חדשים, ${s.last.diff.changed.length} השתנו`, `${s.last.diff.added.length} new, ${s.last.diff.changed.length} changed`)}
          {s.last.errors.length > 0 && <span className="design-error-text"> · {L(`${s.last.errors.length} נכשלו`, `${s.last.errors.length} failed`)}</span>}
        </p>
      )}
      {s.last && s.last.errors.length > 0 && !s.running && (
        <details className="small"><summary>{L("מה נכשל", "What failed")}</summary><ul dir="ltr">{s.last.errors.map((e) => <li key={e}>{e}</li>)}</ul></details>
      )}
      {s.boards.length > 0 && (
        <div className="seg-pills" role="tablist" aria-label={L("אילו לוחות", "Which boards")}>
          <button type="button" role="tab" aria-selected={!onlyNew} className={!onlyNew ? "on" : ""} onClick={() => setOnlyNew(false)}>{L("הכל", "All")} ({s.boards.length})</button>
          <button type="button" role="tab" aria-selected={onlyNew} className={onlyNew ? "on" : ""} onClick={() => setOnlyNew(true)}>{L("הכי חדש", "Newest")} ({newCount})</button>
        </div>
      )}
      {s.available && !s.boards.length && !s.running && <p className="muted">{L("עוד אין לוחות. לחץ ״צלם שוב״.", "No boards yet. Tap “Render again”.")}</p>}
      {groups.map(([g, list]) => (
        <section key={g} className="design-group">
          <h2 dir="auto">{g}</h2>
          <div className="design-grid">
            {list.map((b) => (
              <button type="button" key={b.name} className={`design-board card${b.newest ? " newest" : ""}`} onClick={() => setOpen(b)} aria-label={b.title}>
                <span className="design-thumb"><img src={shot(b)} alt="" loading="lazy" /></span>
                <span className="design-meta">
                  {b.newest && <span className="design-new">🆕 {L("הכי חדש", "Newest")}</span>}
                  <strong dir="auto">{b.title}</strong>
                  <span className="muted small">{b.viewport === "phone" ? L("טלפון", "Phone") : L("מחשב", "Computer")} · {when(b.changedAt)}</span>
                  {b.note && <span className="small design-note-line" dir="auto">💬 {b.note}</span>}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
      {open && <BoardView board={open} onClose={() => setOpen(null)} onSaved={() => void load()} />}
    </div>
  );
}

/** One board at full size, with Roee's note for Claude (it goes on the doc's canvas beside the board). */
function BoardView({ board, onClose, onSaved }: { board: Board; onClose: () => void; onSaved: () => void }) {
  const [note, setNote] = useState(board.note);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const save = async () => {
    setSaving(true);
    try {
      await api(`/api/design/note/${encodeURIComponent(board.name)}`, { method: "PUT", body: { note } });
      toast(note.trim() ? L("ההערה נשמרה, היא תופיע ליד הלוח במסמך", "Note saved; it shows beside the board in the doc") : L("ההערה נמחקה", "Note removed"));
      onSaved();
      onClose();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="dialog-backdrop design-view-backdrop" role="presentation" onClick={onClose}>
      <div className="dialog card design-view" role="dialog" aria-modal="true" aria-label={board.title} onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <strong className="grow" dir="auto">{board.title}</strong>
          <button type="button" className="icon-btn" aria-label={L("סגור", "Close")} onClick={onClose}>✕</button>
        </div>
        <div className={`design-full ${board.viewport}`}><img src={shot(board)} alt={board.title} /></div>
        <label className="stack small">
          <span>{L("הערה ללוח (תופיע ליד הלוח במסמך העיצוב)", "Note on this board (shows beside it in the design doc)")}</span>
          <textarea rows={2} value={note} maxLength={2000} dir="auto" onChange={(e) => setNote(e.target.value)} placeholder={L("למשל: הכפתור קטן מדי בטלפון", "For example: the button is too small on the phone")} />
        </label>
        <div className="row design-view-actions">
          <span className="grow muted small" dir="ltr">{board.name}</span>
          <button type="button" onClick={onClose}>{L("ביטול", "Cancel")}</button>
          <button type="button" className="primary" disabled={saving || note === board.note} onClick={() => void save()}>{L("שמור הערה", "Save note")}</button>
        </div>
      </div>
    </div>
  );
}
