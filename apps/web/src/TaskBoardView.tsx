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
  owner?: "claude" | "kesher" | "roee";
  result?: string;
  priority: number;
  updatedAt: string;
}
interface Note { at: string; from: "claude" | "kesher" | "roee"; text: string; task?: string }
interface Board { rev: number; tasks: Task[]; notes: Note[] }

type Category = "normal" | "cooldown" | "fable";
/** The board's three lists: Claude Opus's, the local model's (while Claude's usage is used up), Claude Fable's. */
const CATS: Array<[Category, string, string, string, string]> = [
  ["normal", "Normal", "Normal", "מה ש־Claude (Opus) עובד עליו", "What Claude (Opus) works on"],
  ["cooldown", "CoolDown", "CoolDown", "המודל המקומי, כשה־usage של Claude נגמר", "The local model, while Claude's usage is used up"],
  ["fable", "Fable", "Fable", "משימות גדולות ל־Claude Fable", "Bigger tasks for Claude Fable"],
];
const catOf = (t: Task): Category => t.category ?? (/^\s*\[cool\s*down\]/i.test(t.title) ? "cooldown" : /^\s*\[fable\]/i.test(t.title) ? "fable" : "normal");

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
  const [cat, setCat] = useState<Category>("normal");

  useEffect(() => {
    let alive = true;
    const load = () => void api<Board>("/api/self-work/board").then((b) => alive && setBoard(b), () => undefined);
    load();
    const t = window.setInterval(load, 5000);
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
        return (
          <section key={c} className={`task-cat ${c}`}>
            <h4 className="row"><span className="grow">{L(he, en)} <span className="muted small">({all})</span></span><span className="muted small">{L(hintHe, hintEn)}</span></h4>
            {list.length === 0 ? <p className="muted small">{L("אין משימות פתוחות.", "No open tasks.")}</p> : (
              <ul className="task-list">
                {list.map((t) => (
              <li key={t.id} className={`task ${t.status}`}>
                <button type="button" className="task-head" aria-expanded={open === t.id} onClick={() => setOpen(open === t.id ? "" : t.id)}>
                  <span className="muted small" dir="ltr">{t.id}</span>
                  <span className="grow" dir="auto">{t.title}</span>
                  <span className={`pill small ${t.status}`}>{L(...STATUS[t.status])}{t.owner ? ` · ${L(...WHO[t.owner]!)}` : ""}</span>
                </button>
                {open === t.id && (
                  <div className="task-body small">
                    {t.details && <p dir="auto">{t.details}</p>}
                    {t.result && <p dir="auto"><strong>{L("תוצאה:", "Result:")}</strong> {t.result}</p>}
                    <div className="row wrap">
                      <Select value={catOf(t)} aria-label={L("קטגוריה", "Category")} onChange={(e) => change([{ op: "edit", id: t.id, category: e.target.value }])}>
                        {CATS.map(([c, en]) => <option key={c} value={c}>{en}</option>)}
                      </Select>
                      {(t.status === "done" || t.status === "blocked" || t.status === "claimed") && <button type="button" onClick={() => change([{ op: "reopen", id: t.id }])}>{L("החזר לפתוחה", "Reopen")}</button>}
                      <button type="button" onClick={() => change([{ op: "edit", id: t.id, priority: Math.max(1, t.priority - 1) }])} title={L("עדיפות גבוהה יותר", "Higher priority")}>↑ p{t.priority}</button>
                    </div>
                  </div>
                )}
              </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (title.trim()) { change([{ op: "add", title: title.trim(), category: cat }]); setTitle(""); } }}>
        <input className="grow" dir="auto" value={title} placeholder={L("משימה חדשה…", "A new task…")} onChange={(e) => setTitle(e.target.value)} />
        <Select value={cat} aria-label={L("קטגוריה", "Category")} onChange={(e) => setCat(e.target.value as Category)}>
          {CATS.map(([c, en]) => <option key={c} value={c}>{en}</option>)}
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
