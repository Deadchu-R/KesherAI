import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** A page to save: from KesherAI's browser or the extension's side panel. */
export interface WebClip { url: string; title: string; text: string; selection?: string }

interface CourseRow { id: string; name: string }
interface LectureRow { id: string; title: string }

const host = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
};

/**
 * "Save to course" (design SaveToCourse): the page, or only what she selected, as a new lecture in a course she
 * picks, or added to one of its lectures. The last course is remembered.
 */
export function SaveToCourse({ clip, onClose }: { clip: WebClip; onClose: () => void }) {
  const [courses, setCourses] = useState<CourseRow[] | null>(null);
  const [course, setCourse] = useState("");
  const [lectures, setLectures] = useState<LectureRow[]>([]);
  const [into, setInto] = useState("");
  const [title, setTitle] = useState(clip.title.slice(0, 200));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const body = clip.selection?.trim() || clip.text;
  const words = body.split(/\s+/).filter(Boolean).length;

  useEffect(() => {
    void api<{ courses: CourseRow[] }>("/api/study").then((r) => {
      setCourses(r.courses);
      let last = "";
      try {
        last = localStorage.getItem("kesher-clip-course") ?? "";
      } catch {
        // no storage
      }
      setCourse(r.courses.find((c) => c.id === last)?.id ?? r.courses[0]?.id ?? "");
    }, (e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    setInto("");
    if (!course) return setLectures([]);
    void api<{ lectures: LectureRow[] }>(`/api/study/courses/${course}`).then((r) => setLectures(r.lectures.slice(-8).reverse()), () => setLectures([]));
  }, [course]);

  const save = async () => {
    if (!course) return;
    setBusy(true);
    setError("");
    try {
      const l = await api<{ id: string }>(`/api/study/courses/${course}/clip`, { method: "POST", body: { title, url: clip.url, text: body, ...(into ? { lectureId: into } : {}) } });
      try {
        localStorage.setItem("kesher-clip-course", course);
      } catch {
        // no storage
      }
      toast(L("נשמר לקורס", "Saved to the course"));
      onClose();
      location.hash = `#/study/${course}/l/${l.id}`;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <form className="dialog card save-course" role="dialog" aria-modal="true" aria-label={L("שמירה לקורס", "Save to course")} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <h2>🎓 {L("שמירה לקורס", "Save to course")}</h2>
        <p className="muted small" dir="auto">{clip.title} · <span dir="ltr">{host(clip.url)}</span></p>
        <blockquote dir="auto" className="save-course-quote">
          {body.slice(0, 220)}{body.length > 220 ? "…" : ""}
          <small className="muted"> · {clip.selection?.trim() ? L(`הקטע שסימנת (${words} מילים)`, `Your selection (${words} words)`) : L(`כל הדף (${words} מילים)`, `The whole page (${words} words)`)}</small>
        </blockquote>
        {courses && !courses.length ? (
          <p className="muted">{L("עוד אין קורסים. פתחי קורס בלימודים, ואז שמרי אליו.", "No courses yet. Open one in Study first, then save to it.")} <a href="#/study" onClick={onClose}>{L("ללימודים", "Open Study")}</a></p>
        ) : (
          <>
            <span className="small">{L("קורס", "Course")}</span>
            <div className="save-course-opts">{(courses ?? []).map((c) => <button type="button" key={c.id} className={`save-course-opt${c.id === course ? " on" : ""}`} aria-pressed={c.id === course} onClick={() => setCourse(c.id)}>{c.id === course ? "✓ " : ""}{c.name}</button>)}</div>
            <span className="small">{L("איפה", "Where")}</span>
            <div className="save-course-opts">
              <button type="button" className={`save-course-opt${!into ? " on" : ""}`} aria-pressed={!into} onClick={() => setInto("")}>{!into ? "✓ " : ""}{L("הרצאה חדשה", "New lecture")}</button>
              {lectures.map((l) => <button type="button" key={l.id} className={`save-course-opt${into === l.id ? " on" : ""}`} aria-pressed={into === l.id} onClick={() => setInto(l.id)}>{into === l.id ? "✓ " : ""}{L("להוסיף ל: ", "Add to: ")}{l.title}</button>)}
            </div>
            {!into && <label>{L("שם", "Name")}<input value={title} onChange={(e) => setTitle(e.target.value)} dir="auto" /></label>}
          </>
        )}
        {error && <p className="error small">{error}</p>}
        <div className="row">
          <button type="submit" className="primary" disabled={busy || !course}>{busy ? "…" : L("שמירה", "Save")}</button>
          <button type="button" onClick={onClose}>{L("ביטול", "Cancel")}</button>
        </div>
        <p className="muted small">{L("נשמר עם הקישור למקור. הסיכום, הכרטיסיות והבחנים משתמשים בו כמו בכל הרצאה.", "Saved with a link to the page. Summaries, cards and quizzes use it like any lecture.")}</p>
      </form>
    </div>,
    document.body,
  );
}
