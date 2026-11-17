import { useEffect, useState } from "react";
import { lineAt, type StudyHighlight, type StudyLecture } from "@kesher/shared";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** Seconds as m:ss or h:mm:ss. */
export function clockOf(sec: number): string {
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  return h ? `${h}:${m.toString().padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/**
 * Her notes on moments of a recording or a video (design TimeNotes, Roee): "📝 a note here" takes the moment playing,
 * she types what she wants to remember, and each note is a button back to its moment. Kept with the lecture's
 * highlights, so the course's "My notes" and "cards from highlights" see them too.
 */
export function StudyTimeNotes({ base, lecture, now, onSeek, onLecture }: { base: string; lecture: StudyLecture; now: number; onSeek: (sec: number) => void; onLecture: (l: StudyLecture) => void }) {
  const [at, setAt] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const all = lecture.highlights ?? [];
  const notes = all.filter((h) => h.at !== undefined).sort((a, b) => a.at! - b.at!);
  // The note closest before the moment playing is marked.
  const current = notes.filter((n) => n.at! <= now).at(-1)?.id;
  const save = async (list: StudyHighlight[]) => {
    setBusy(true);
    try {
      const r = await api<{ highlights: StudyHighlight[] }>(`${base}/highlights`, { method: "PUT", body: { highlights: list } });
      onLecture({ ...lecture, highlights: r.highlights });
      return true;
    } catch (e) {
      toast((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    const note = text.trim();
    if (at === null || !note) return;
    const heard = lineAt(lecture.text, at);
    if (await save([...all, { id: `n${Date.now().toString(36)}`, text: heard || note, ...(heard ? { note } : {}), at, t: Date.now() }])) {
      setAt(null);
      setText("");
    }
  };
  useEffect(() => {
    if (at === null) setText("");
  }, [at]);
  return (
    <div className="study-tnotes">
      <div className="row study-tnotes-head">
        <b>📝 {L("הערות על רגעים", "Notes on moments")}{notes.length ? ` (${notes.length})` : ""}</b>
        {at === null && <button type="button" className="small primary" onClick={() => setAt(Math.floor(now))}>{L(`הערה ברגע הזה (${clockOf(now)})`, `A note here (${clockOf(now)})`)}</button>}
      </div>
      {at !== null && (
        <div className="study-tnotes-new">
          <span className="study-stamp" dir="ltr">{clockOf(at)}</span>
          <textarea rows={2} dir="auto" autoFocus value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void add(); } if (e.key === "Escape") setAt(null); }} placeholder={L("מה לזכור מהרגע הזה", "What to remember from this moment")} aria-label={L("ההערה", "The note")} />
          <div className="row">
            <button type="button" className="small primary" disabled={busy || !text.trim()} onClick={() => void add()}>{L("לשמור", "Save")}</button>
            <button type="button" className="small ghost" onClick={() => setAt(null)}>{L("ביטול", "Cancel")}</button>
          </div>
        </div>
      )}
      {notes.length ? (
        <ul className="study-tnotes-list">
          {notes.map((n) => (
            <li key={n.id} className={n.id === current ? "now" : ""}>
              <button type="button" className="study-stamp" dir="ltr" title={L("לנגן מכאן", "Play from here")} onClick={() => onSeek(n.at!)}>{clockOf(n.at!)}</button>
              <span dir="auto">{n.note ?? n.text}</span>
              <button type="button" className="ghost small" aria-label={L("למחוק את ההערה", "Delete the note")} onClick={() => void save(all.filter((h) => h.id !== n.id))}>✕</button>
            </li>
          ))}
        </ul>
      ) : at === null ? <p className="muted small">{L("עוצרים ברגע חשוב ולוחצים \"הערה ברגע הזה\". כל ההערות של הקורס מחכות גם בלשונית \"ההערות שלי\".", "Stop at an important moment and press \"A note here\". All of the course's notes are also in the \"My notes\" tab.")}</p> : null}
    </div>
  );
}

interface CourseNote extends StudyHighlight { lectureId: string; title: string }

/** Every note in the course in one place (design TimeNotes): search, and each opens its lecture at its moment. */
export function StudyNotesTab({ courseId }: { courseId: string }) {
  const [data, setData] = useState<{ notes: CourseNote[]; written: Array<{ lectureId: string; title: string; text: string }> } | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => void api<NonNullable<typeof data>>(`/api/study/courses/${courseId}/notes`).then(setData, (e: Error) => toast(e.message)), [courseId]);
  if (!data) return <p className="muted">…</p>;
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const has = (s: string) => words.every((w) => s.toLowerCase().includes(w));
  const notes: CourseNote[] = [...data.notes, ...data.written.map((w) => ({ id: `w-${w.lectureId}`, lectureId: w.lectureId, title: w.title, text: w.text, t: 0 }))];
  const shown = notes.filter((n) => has(`${n.note ?? ""} ${n.text} ${n.title}`));
  return (
    <section className="card study-notes-tab">
      <h2>📝 {L("ההערות שלי", "My notes")}</h2>
      {notes.length ? <input type="search" dir="auto" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L("חיפוש בהערות", "Search the notes")} aria-label={L("חיפוש בהערות", "Search the notes")} /> : null}
      {!notes.length && <p className="muted">{L("עוד אין הערות. בהרצאה עם הקלטה או סרטון, לוחצים \"הערה ברגע הזה\" ליד הנגן. גם הדגשות עם הערה מ\"קריאה והדגשה\" יופיעו כאן.", "No notes yet. In a lecture with a recording or a video, press \"A note here\" by the player. Highlights with a note from \"Read and highlight\" show here too.")}</p>}
      {notes.length > 0 && !shown.length && <p className="muted">{L("אין הערה שמתאימה לחיפוש.", "No note matches the search.")}</p>}
      <ul className="study-notes-list">
        {shown.map((n) => (
          <li key={`${n.lectureId}-${n.id}`}>
            <a href={`#/study/${courseId}/l/${n.lectureId}${n.at !== undefined ? `/${n.at}` : ""}`}>
              <span className="muted small" dir="auto">{n.title}{n.at !== undefined ? ` · ▶ ${clockOf(n.at)}` : n.page ? L(` · עמוד ${n.page}`, ` · page ${n.page}`) : n.t === 0 ? L(" · הערות ליד הסיכום", " · notes beside the summary") : ""}</span>
              <b dir="auto" className="study-notes-text">{n.note ?? n.text}</b>
              {n.note && n.text !== n.note && <span className="muted small" dir="auto">“{n.text.slice(0, 160)}”</span>}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
