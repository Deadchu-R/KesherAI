import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";
import { toast } from "./library";
import { Select } from "./ui/Select";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Task {
  id: string;
  title: string;
  details?: string;
  status: "open" | "claimed" | "done" | "blocked";
  category?: Category;
  /** Small ones are self-work's, big ones Claude's. */
  size?: "small" | "big";
  /** Handed to self-work by Roee: it takes this one first. */
  forKesher?: boolean;
  owner?: "claude" | "kesher" | "roee";
  result?: string;
  priority: number;
  updatedAt: string;
}
interface Note { at: string; from: "claude" | "kesher" | "roee"; text: string; task?: string }
interface Board { rev: number; tasks: Task[]; notes: Note[] }

type Category = "normal" | "cooldown" | "fable";
/**
 * One list that Claude and self-work share (Roee, 2026-11-11): self-work takes the small tasks, Claude the big
 * ones, and a task can be handed to self-work. Fable's tasks stay apart (another model).
 */
const CATS: Array<[Category, string, string, string, string]> = [
  ["normal", "משימות", "Tasks", "קטנות: העבודה העצמית. גדולות: Claude.", "Small: self-work. Big: Claude."],
  ["fable", "Fable", "Fable", "משימות גדולות ל־Claude Fable", "Bigger tasks for Claude Fable"],
];
const catOf = (t: Task): Category => (t.category === "fable" || /^\s*\[fable\]/i.test(t.title) ? "fable" : "normal");
const sizeOf = (t: Task): "small" | "big" => t.size ?? (t.category === "cooldown" || /^\s*\[cool\s*down\]/i.test(t.title) ? "small" : "big");
/** What a new task is: small, big, or Fable's. */
type Kind = "small" | "big" | "fable";

const WHO: Record<string, [string, string]> = { claude: ["Claude", "Claude"], kesher: ["KesherAI", "KesherAI"], roee: ["אתה", "You"] };
const STATUS: Record<Task["status"], [string, string]> = { open: ["פתוחה", "Open"], claimed: ["בעבודה", "In progress"], done: ["הושלמה", "Done"], blocked: ["תקועה", "Blocked"] };
const ORDER: Record<Task["status"], number> = { claimed: 0, blocked: 1, open: 2, done: 3 };

/**
 * The task board KesherAI's self-work agent and Claude share (a file on this
 * computer): who took what, what is done and how it was checked, and the notes
 * between them. You can add a task, give one back (reopen), and leave a note.
 */
export function TaskBoardView() {
  const [board, setBoard] = useState<Board | null>(null);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [open, setOpen] = useState<string>("");
  const [kind, setKind] = useState<Kind>("small");
  const [folded, setFolded] = useState<Category[]>([]);

  useEffect(() => {
    let alive = true;
    const load = () => void api<Board>("/api/self-work/board").then((b) => alive && setBoard(b), () => undefined);
    load();
    // A hidden tab (or the phone in a pocket) does not ask every 5 seconds.
    const t = window.setInterval(() => !document.hidden && load(), 5000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  const change = (changes: unknown[]) => void api<Board>("/api/self-work/board", { method: "POST", body: { changes } }).then(setBoard, (e: Error) => toast(e.message));
  if (!board) return null;
  const tasks = [...board.tasks].sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.priority - b.priority);
  const shown = tasks.filter((t) => showDone || t.status !== "done");
  const done = tasks.length - tasks.filter((t) => t.status !== "done").length;

  return (
    <div className="task-board">
      <div className="row wrap">
        <strong className="grow">{L("לוח המשימות המשותף", "The shared task board")}</strong>
        {done > 0 && <button type="button" className="small" onClick={() => setShowDone((v) => !v)}>{showDone ? L("הסתר שהושלמו", "Hide done") : L(`הצג שהושלמו (${done})`, `Show done (${done})`)}</button>}
      </div>
      {!tasks.length && <p className="muted small">{L("אין משימות עדיין. משימה שתוסיפו כאן תופיע גם אצל Claude וגם אצל העבודה העצמית.", "No tasks yet. A task you add here shows for Claude and for self-work alike.")}</p>}
      {CATS.map(([c, he, en, hintHe, hintEn]) => {
        const list = shown.filter((t) => catOf(t) === c);
        const all = tasks.filter((t) => catOf(t) === c && t.status !== "done").length;
        // A list row like Linear's or Material's two-line item: a status mark, the title (two lines at most), and
        // one quiet line under it (number, who, status). Sections fold like Linear's groups and show their count.
        return (
          <details key={c} className={`task-cat ${c}`} open={!folded.includes(c)} onToggle={(e) => {
            const isOpen = (e.currentTarget as HTMLDetailsElement).open;
            setFolded((f) => (isOpen ? f.filter((x) => x !== c) : f.includes(c) ? f : [...f, c]));
          }}>
            <summary title={L(hintHe, hintEn)}><span className="task-cat-name">{L(he, en)}</span><span className="task-count">{all}</span></summary>
            {list.length === 0 ? <p className="muted small task-empty">{L("אין משימות פתוחות.", "No open tasks.")}</p> : (
              <ul className="task-list">
                {list.map((t) => (
              <li key={t.id} className={`task ${t.status}`}>
                <button type="button" className="task-row" aria-expanded={open === t.id} onClick={() => setOpen(open === t.id ? "" : t.id)}>
                  <span className={`task-mark ${t.status}`} role="img" aria-label={L(...STATUS[t.status])} />
                  <span className="task-text">
                    <span className="task-title" dir="auto">{t.title.replace(/^\s*\[(cool\s*down|fable)\]\s*/i, "")}</span>
                    <span className="task-meta">
                      <span dir="ltr">{t.id}</span>
                      <span className={`task-state ${t.status}`}>{L(...STATUS[t.status])}</span>
                      {t.owner && <span>{L(...WHO[t.owner]!)}</span>}
                      {c === "normal" && <span>{sizeOf(t) === "small" ? L("קטנה", "Small") : L("גדולה", "Big")}</span>}
                      {t.forKesher && t.status !== "done" && <span className="task-state claimed">🤖 {L("לעבודה העצמית", "For self-work")}</span>}
                    </span>
                  </span>
                </button>
                {open === t.id && (
                  <div className="task-body small">
                    {t.details && <p dir="auto">{t.details}</p>}
                    {t.result && <p dir="auto"><strong>{L("תוצאה:", "Result:")}</strong> {t.result}</p>}
                    <div className="row wrap">
                      <Select value={catOf(t) === "fable" ? "fable" : sizeOf(t)} aria-label={L("גודל", "Size")} onChange={(e) => change([e.target.value === "fable" ? { op: "edit", id: t.id, category: "fable" } : { op: "edit", id: t.id, category: "normal", size: e.target.value }])}>
                        <option value="small">{L("קטנה (עבודה עצמית)", "Small (self-work)")}</option>
                        <option value="big">{L("גדולה (Claude)", "Big (Claude)")}</option>
                        <option value="fable">Fable</option>
                      </Select>
                      {t.status !== "done" && (
                        <button type="button" onClick={() => change([{ op: "edit", id: t.id, forKesher: !t.forKesher }])} title={L("העבודה העצמית תיקח אותה ראשונה, בלי קשר לגודל", "Self-work takes it first, whatever its size")}>
                          {t.forKesher ? L("בטל: לא לעבודה העצמית", "Undo: not for self-work") : L("🤖 תן לעבודה העצמית", "🤖 Give to self-work")}
                        </button>
                      )}
                      {(t.status === "done" || t.status === "blocked" || t.status === "claimed") && <button type="button" onClick={() => change([{ op: "reopen", id: t.id }])}>{L("החזר לפתוחה", "Reopen")}</button>}
                      <button type="button" onClick={() => change([{ op: "edit", id: t.id, priority: Math.max(1, t.priority - 1) }])} title={L("עדיפות גבוהה יותר", "Higher priority")}>↑ p{t.priority}</button>
                    </div>
                  </div>
                )}
              </li>
                ))}
              </ul>
            )}
          </details>
        );
      })}
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (title.trim()) { change([kind === "fable" ? { op: "add", title: title.trim(), category: "fable" } : { op: "add", title: title.trim(), category: "normal", size: kind }]); setTitle(""); } }}>
        <input className="grow" dir="auto" value={title} placeholder={L("משימה חדשה…", "A new task…")} onChange={(e) => setTitle(e.target.value)} />
        <Select value={kind} aria-label={L("גודל", "Size")} onChange={(e) => setKind(e.target.value as Kind)}>
          <option value="small">{L("קטנה", "Small")}</option>
          <option value="big">{L("גדולה", "Big")}</option>
          <option value="fable">Fable</option>
        </Select>
        <button type="submit" disabled={!title.trim()}>{L("הוסף", "Add")}</button>
      </form>
      {board.notes.length > 0 && (
        <details className="task-notes">
          <summary className="small">{L(`הודעות (${board.notes.length})`, `Notes (${board.notes.length})`)}</summary>
          <ol className="small">
            {board.notes.slice(-20).map((n, i) => (
              <li key={i}><strong>{L(...WHO[n.from]!)}</strong>{n.task ? <span className="muted"> ({n.task})</span> : null}: <span dir="auto">{n.text}</span></li>
            ))}
          </ol>
        </details>
      )}
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (note.trim()) { change([{ op: "note", text: note.trim() }]); setNote(""); } }}>
        <input className="grow" dir="auto" value={note} placeholder={L("הודעה ל-Claude ול-KesherAI…", "A note for Claude and KesherAI…")} onChange={(e) => setNote(e.target.value)} />
        <button type="submit" disabled={!note.trim()}>{L("שלח", "Send")}</button>
      </form>
    </div>
  );
}
