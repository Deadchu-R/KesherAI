import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
type RecordingSettings = { keep: boolean; deleteAfter: "never" | "30" | "90" | "semester"; asked?: boolean };

/** Settings → Study: keep lecture recordings, and when to delete them. */
export function StudySection() {
  const [s, setS] = useState<RecordingSettings | null>(null);
  useEffect(() => void api<RecordingSettings>("/api/study/recordings").then(setS, () => undefined), []);
  const save = (change: Partial<RecordingSettings>) => void api<RecordingSettings>("/api/study/recordings", { method: "PUT", body: { ...change, asked: true } }).then(setS, (e: Error) => toast(e.message));
  if (!s) return null;
  return (
    <section className="card">
      <h2>{L("הקלטות הרצאה", "Lecture recordings")}</h2>
      <label className="study-check"><input type="checkbox" checked={s.keep} onChange={(e) => save({ keep: e.target.checked })} /> {L("לשמור את ההקלטה של הרצאות חדשות (לנגן מכל דקה בתמלול)", "Keep the recording of new lectures (play from any minute in the transcript)")}</label>
      <label className="field">
        <span>{L("מחיקה אוטומטית", "Delete automatically")}</span>
        <select value={s.deleteAfter} onChange={(e) => save({ deleteAfter: e.target.value as RecordingSettings["deleteAfter"] })}>
          <option value="never">{L("אף פעם", "Never")}</option>
          <option value="30">{L("אחרי 30 יום", "After 30 days")}</option>
          <option value="90">{L("אחרי 90 יום", "After 90 days")}</option>
          <option value="semester">{L("אחרי סוף הסמסטר", "After the semester ends")}</option>
        </select>
      </label>
      <p className="muted small">{L("סוף הסמסטר לכל קורס: התאריך שכתבת בקורס, אחרת המבחן האחרון בסילבוס, אחרת תאריך המבחן. ההקלטות נשמרות במחשב; מהטלפון הן עוברות למחשב בסנכרון.", "Each course's semester end: the date you wrote on the course, else its syllabus's last exam, else its exam date. Recordings are kept on the computer; from the phone they move there on sync.")}</p>
    </section>
  );
}
