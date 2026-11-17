import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";
import { GOAL_KINDS, type GoalKind, type StudyGoal } from "@kesher/shared";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
type RecordingSettings = { keep: boolean; deleteAfter: "never" | "30" | "90" | "semester"; asked?: boolean };

/** What each goal kind is called, and the amounts offered. */
export const GOAL_NAMES: Record<GoalKind, [string, string, number[]]> = {
  minutes: ["דקות ריכוז", "Focus minutes", [10, 20, 30, 45, 60, 90]],
  cards: ["כרטיסיות", "Cards", [10, 20, 40, 80]],
  lectures: ["הרצאות חדשות", "New lectures", [1, 2, 3]],
  videos: ["סרטונים שנצפו עד הסוף", "Videos watched to the end", [1, 2, 3]],
  quizzes: ["בחנים", "Quizzes", [1, 2, 3]],
  summaries: ["סיכומים", "Summaries", [1, 2, 3]],
};

/** Settings → Study → Daily goal (design DailyGoal): off by default; targets, a reminder, and the phone. */
function GoalSettings() {
  const [g, setG] = useState<StudyGoal | null>(null);
  useEffect(() => void api<StudyGoal>("/api/study/goal").then(setG, () => undefined), []);
  const save = (change: Partial<StudyGoal>) => void api<StudyGoal>("/api/study/goal", { method: "PUT", body: change }).then(setG, (e: Error) => toast(e.message));
  if (!g) return null;
  return (
    <section className="card study-goal-settings">
      <h2>🎯 {L("יעד יומי", "Daily goal")}</h2>
      <label className="study-check"><input type="checkbox" checked={g.on} onChange={(e) => save({ on: e.target.checked })} /> {L("להפעיל יעד יומי (עם ספירת ימים רצופים שעמדת בו)", "Turn on a daily goal (counting the days in a row you reach it)")}</label>
      {g.on && (
        <>
          {GOAL_KINDS.map((k) => (
            <div key={k} className="goal-row">
              <span>{L(GOAL_NAMES[k][0], GOAL_NAMES[k][1])}</span>
              <div className="goal-opts" role="radiogroup" aria-label={L(GOAL_NAMES[k][0], GOAL_NAMES[k][1])}>
                {[0, ...GOAL_NAMES[k][2]].map((v) => (
                  <button type="button" key={v} role="radio" aria-checked={(g.targets[k] ?? 0) === v} className={(g.targets[k] ?? 0) === v ? "on" : ""} onClick={() => save({ targets: { [k]: v } })}>{v || L("לא", "Off")}</button>
                ))}
              </div>
            </div>
          ))}
          <div className="goal-row">
            <span>{L("תזכורת", "Reminder")}</span>
            <label className="study-check"><input type="checkbox" checked={!!g.remind} onChange={(e) => save({ remind: e.target.checked ? "20:30" : "" })} /> {L("כן, בשעה", "Yes, at")}</label>
            {g.remind && <input type="time" value={g.remind} onChange={(e) => e.target.value && save({ remind: e.target.value })} aria-label={L("שעת התזכורת", "Reminder time")} />}
          </div>
          {g.remind && <label className="study-check"><input type="checkbox" checked={!!g.phone} onChange={(e) => save({ phone: e.target.checked })} /> {L("לשלוח את התזכורת גם לטלפון", "Send the reminder to the phone too")}</label>}
          <p className="muted small">{L("התזכורת מגיעה רק בימים שעוד לא הגעת ליעד, ואומרת כמה נשאר ומה הדבר הבא ללמוד. יום נחשב כשכל החלקים של היעד הושלמו.", "The reminder comes only on days you have not reached the goal yet, and says how much is left and what to study next. A day counts when every part of the goal is done.")}</p>
        </>
      )}
    </section>
  );
}

/** Settings → Study → View: simple mode (design StudySimple). */
function ViewSettings() {
  const [p, setP] = useState<{ simple: boolean; welcomed: boolean } | null>(null);
  useEffect(() => void api<{ simple: boolean; welcomed: boolean }>("/api/study/prefs").then(setP, () => undefined), []);
  if (!p) return null;
  return (
    <section className="card">
      <h2>🧹 {L("תצוגה", "View")}</h2>
      <label className="study-check"><input type="checkbox" checked={p.simple} onChange={(e) => void api<typeof p>("/api/study/prefs", { method: "PUT", body: { simple: e.target.checked } }).then(setP, (er: Error) => toast(er.message))} /> {L("תצוגה פשוטה: רק הכלים של כל יום, השאר תחת \"עוד כלים\"", "Simple view: only the everyday tools, the rest under \"More tools\"")}</label>
    </section>
  );
}

/** Settings → Study: the daily goal; keep lecture recordings, and when to delete them. */
export function StudySection() {
  const [s, setS] = useState<RecordingSettings | null>(null);
  useEffect(() => void api<RecordingSettings>("/api/study/recordings").then(setS, () => undefined), []);
  const save = (change: Partial<RecordingSettings>) => void api<RecordingSettings>("/api/study/recordings", { method: "PUT", body: { ...change, asked: true } }).then(setS, (e: Error) => toast(e.message));
  if (!s) return <><ViewSettings /><GoalSettings /></>;
  return (
    <>
    <ViewSettings />
    <GoalSettings />
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
    </>
  );
}
