import { useEffect, useRef, useState } from "react";
import { CLASS_KINDS, classesOn, classNow, type ClassKind, type ClassSlot, type Timetable } from "@kesher/shared";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
const DAYS: Array<[string, string]> = [["א׳", "Sun"], ["ב׳", "Mon"], ["ג׳", "Tue"], ["ד׳", "Wed"], ["ה׳", "Thu"], ["ו׳", "Fri"], ["ש׳", "Sat"]];
const KIND: Record<ClassKind, [string, string]> = { lecture: ["הרצאה", "Lecture"], practice: ["תרגול", "Practice"], lab: ["מעבדה", "Lab"] };
const COLORS = ["#3d5afe", "#2e9e6a", "#b0662e", "#9c4dcc", "#0f8fa8", "#c2410c", "#6b7280"];
const newId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
type Course = { id: string; name: string };

/** Her timetable, loaded once per page and shared by the banner and the card. */
function useTimetable(): [Timetable | null, (t: Timetable) => void] {
  const [t, setT] = useState<Timetable | null>(null);
  const timer = useRef(0);
  useEffect(() => void api<Timetable>("/api/study/timetable").then(setT, () => setT({ slots: [] })), []);
  const save = (next: Timetable) => {
    setT(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void api<Timetable>("/api/study/timetable", { method: "PUT", body: next }).catch((e: Error) => toast(e.message)), 500);
  };
  return [t, save];
}

/**
 * The timetable (design Timetable, students part 27 #3): "now: <class>" with a button that records it into its
 * course, and the week's classes (a grid on a computer, today and tomorrow first on a phone), with a note when a class
 * starts.
 */
export function StudyTimetable({ courses, part }: { courses: Course[]; part: "now" | "card" }) {
  const [t, save] = useTimetable();
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<ClassSlot | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(i);
  }, []);
  if (!t) return null;
  const name = (id: string) => courses.find((c) => c.id === id)?.name ?? "";
  const color = (id: string) => COLORS[Math.max(0, courses.findIndex((c) => c.id === id)) % COLORS.length]!;
  const now = new Date();
  const cur = classNow(t, now);
  const slots = t.slots.filter((s) => courses.some((c) => c.id === s.courseId));
  const days = [0, 1, 2, 3, 4, 5].filter((d) => d < 5 || slots.some((s) => s.day === d));
  const saveSlot = (s: ClassSlot) => {
    save({ ...t, slots: t.slots.some((x) => x.id === s.id) ? t.slots.map((x) => (x.id === s.id ? s : x)) : [...t.slots, s] });
    setEdit(null);
  };
  const block = (s: ClassSlot) => (
    <button key={s.id} type="button" className="study-tt-block" style={{ ["--c" as string]: color(s.courseId) }} onClick={() => setEdit(s)}>
      <b dir="auto">{name(s.courseId)}</b>
      <span className="muted" dir="ltr">{s.start}–{s.end}</span>
      {(s.kind || s.room) && <span className="muted" dir="auto">{[s.kind ? L(...KIND[s.kind]) : "", s.room ? L(`חדר ${s.room}`, `room ${s.room}`) : ""].filter(Boolean).join(" · ")}</span>}
    </button>
  );
  return <>
    {part === "now" && cur && (
      <section className="card study-tt-now">
        <span aria-hidden="true">{cur.state === "now" ? "🔴" : "⏰"}</span>
        <b dir="auto">{cur.state === "now" ? L(`עכשיו: ${name(cur.slot.courseId)}`, `Now: ${name(cur.slot.courseId)}`) : L(`בעוד ${cur.minutes} דק׳: ${name(cur.slot.courseId)}`, `In ${cur.minutes} min: ${name(cur.slot.courseId)}`)}{cur.slot.kind ? ` · ${L(...KIND[cur.slot.kind])}` : ""}</b>
        <span className="muted small" dir="auto">{[cur.slot.room ? L(`חדר ${cur.slot.room}`, `room ${cur.slot.room}`) : "", cur.state === "now" ? L(`עד ${cur.slot.end}`, `until ${cur.slot.end}`) : L(`ב-${cur.slot.start}`, `at ${cur.slot.start}`)].filter(Boolean).join(" · ")}</span>
        <span className="grow" />
        <a className="button primary" href={`#/study/${cur.slot.courseId}?record=1`}>🎙 {L("להקליט את השיעור", "Record the class")}</a>
      </section>
    )}
    {part === "card" && <section className="card study-tt">
      <button type="button" className="study-grades-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <b>🗓 {L("מערכת שעות", "Timetable")}</b>
        <span className="grow" />
        <span className="muted small">{slots.length ? L(`${slots.length} שיעורים בשבוע`, `${slots.length} classes a week`) : L("להוסיף את השיעורים", "Add your classes")}</span>
        <span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open && <>
        <div className="row study-tt-tools">
          <label className="small"><input type="checkbox" checked={!!t.remind} onChange={(e) => save({ ...t, remind: e.target.checked })} /> {L("תזכורת להקליט כשהשיעור מתחיל", "Remind me to record when a class starts")}</label>
          {t.remind && <label className="small"><input type="checkbox" checked={!!t.phone} onChange={(e) => save({ ...t, phone: e.target.checked })} /> {L("גם לטלפון", "Also to the phone")}</label>}
          <span className="grow" />
          <button type="button" className="ghost small" disabled={!courses.length} onClick={() => setEdit({ id: newId(), courseId: courses[0]!.id, day: now.getDay() === 6 ? 0 : now.getDay(), start: "10:00", end: "12:00", kind: "lecture" })}>＋ {L("שיעור", "Class")}</button>
        </div>
        {edit && <SlotForm slot={edit} courses={courses} onSave={saveSlot} onCancel={() => setEdit(null)} onDelete={t.slots.some((x) => x.id === edit.id) ? () => { save({ ...t, slots: t.slots.filter((x) => x.id !== edit.id) }); setEdit(null); } : undefined} />}
        {!!slots.length && <>
          <div className="study-tt-grid" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
            {days.map((d) => (
              <div key={d} className={`study-tt-day${d === now.getDay() ? " today" : ""}`}>
                <b className="small">{L(...DAYS[d]!)}</b>
                {classesOn({ slots }, d).map(block)}
              </div>
            ))}
          </div>
          <div className="study-tt-list">
            {[0, 1, 2, 3, 4, 5, 6].map((k) => (now.getDay() + k) % 7).filter((d) => slots.some((s) => s.day === d)).map((d) => (
              <div key={d} className="study-tt-day">
                <b className="small">{d === now.getDay() ? L("היום", "Today") : d === (now.getDay() + 1) % 7 ? L("מחר", "Tomorrow") : ""} {L(`יום ${DAYS[d]![0]}`, DAYS[d]![1])}</b>
                {classesOn({ slots }, d).map(block)}
              </div>
            ))}
          </div>
        </>}
        <p className="muted small">{L("כשהשיעור מתחיל אפשר להקליט בלחיצה, וההקלטה נשמרת בקורס הנכון.", "When a class starts you can record it in one tap; it is saved in the right course.")}</p>
      </>}
    </section>}
  </>;
}

function SlotForm({ slot, courses, onSave, onCancel, onDelete }: { slot: ClassSlot; courses: Course[]; onSave: (s: ClassSlot) => void; onCancel: () => void; onDelete?: (() => void) | undefined }) {
  const [s, setS] = useState(slot);
  const ok = s.end > s.start;
  return (
    <form className="study-tt-form" onSubmit={(e) => { e.preventDefault(); if (ok) onSave(s); }}>
      <label className="small">{L("קורס", "Course")} <select value={s.courseId} onChange={(e) => setS({ ...s, courseId: e.target.value })}>{courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label className="small">{L("יום", "Day")} <select value={s.day} onChange={(e) => setS({ ...s, day: Number(e.target.value) })}>{DAYS.map((d, i) => <option key={i} value={i}>{L(...d)}</option>)}</select></label>
      <label className="small">{L("משעה", "From")} <input type="time" value={s.start} onChange={(e) => setS({ ...s, start: e.target.value })} required /></label>
      <label className="small">{L("עד", "To")} <input type="time" value={s.end} onChange={(e) => setS({ ...s, end: e.target.value })} required /></label>
      <label className="small">{L("סוג", "Kind")} <select value={s.kind ?? ""} onChange={(e) => { const { kind: _, ...rest } = s; setS(e.target.value ? { ...rest, kind: e.target.value as ClassKind } : rest); }}><option value="">—</option>{CLASS_KINDS.map((k) => <option key={k} value={k}>{L(...KIND[k])}</option>)}</select></label>
      <label className="small">{L("חדר", "Room")} <input dir="auto" value={s.room ?? ""} maxLength={40} onChange={(e) => { const { room: _, ...rest } = s; setS(e.target.value ? { ...rest, room: e.target.value } : rest); }} /></label>
      {!ok && <p className="small warn">{L("שעת הסיום צריכה להיות אחרי ההתחלה.", "The end must be after the start.")}</p>}
      <div className="study-actions">
        <button type="submit" className="primary" disabled={!ok}>{L("שמירה", "Save")}</button>
        <button type="button" className="ghost" onClick={onCancel}>{L("ביטול", "Cancel")}</button>
        {onDelete && <button type="button" className="ghost" onClick={onDelete}>{L("להסיר", "Remove")}</button>}
      </div>
    </form>
  );
}
