import { useEffect, useState } from "react";
import { attendanceFor, CLASS_KINDS, classesOn, classesToMark, classNow, type AttendanceMark, type ClassKind, type ClassSlot, type ReadClass, type Timetable } from "@kesher/shared";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
const DAYS: Array<[string, string]> = [["א׳", "Sun"], ["ב׳", "Mon"], ["ג׳", "Tue"], ["ד׳", "Wed"], ["ה׳", "Thu"], ["ו׳", "Fri"], ["ש׳", "Sat"]];
const KIND: Record<ClassKind, [string, string]> = { lecture: ["הרצאה", "Lecture"], practice: ["תרגול", "Practice"], lab: ["מעבדה", "Lab"] };
const COLORS = ["#3d5afe", "#2e9e6a", "#b0662e", "#9c4dcc", "#0f8fa8", "#c2410c", "#6b7280"];
const newId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
type Course = { id: string; name: string };

// One copy for the banner and the card on the same page: a mark made in one ("were you there?") must not be undone by
// a later save from the other's older copy.
let shared: Timetable | null = null;
const listeners = new Set<(t: Timetable) => void>();
let saveTimer = 0;

/** Her timetable, loaded once per page and shared by the banner and the card. */
function useTimetable(): [Timetable | null, (t: Timetable) => void] {
  const [t, setT] = useState<Timetable | null>(shared);
  useEffect(() => {
    listeners.add(setT);
    void api<Timetable>("/api/study/timetable").then((x) => { shared = x; for (const l of listeners) l(x); }, () => setT(shared ?? { slots: [] }));
    return () => void listeners.delete(setT);
  }, []);
  const save = (next: Timetable) => {
    shared = next;
    for (const l of listeners) l(next);
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void api<Timetable>("/api/study/timetable", { method: "PUT", body: next }).catch((e: Error) => toast(e.message)), 500);
  };
  return [t, save];
}

/**
 * The timetable (design Timetable, students part 27 #3): "now: <class>" with a button that records it into its
 * course, and the week's classes (a grid on a computer, today and tomorrow first on a phone), with a note when a class
 * starts.
 */
export function StudyTimetable({ courses, part, onCourses }: { courses: Course[]; part: "now" | "card"; onCourses?: () => void }) {
  const [t, save] = useTimetable();
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<ClassSlot | null>(null);
  const [read, setRead] = useState<ReadClass[] | null>(null);
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
    {part === "now" && <MarkClasses t={t} save={save} name={name} max={3} />}
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
          <PhotoButton onRead={setRead} />
          <button type="button" className="ghost small" disabled={!courses.length} onClick={() => setEdit({ id: newId(), courseId: courses[0]!.id, day: now.getDay() === 6 ? 0 : now.getDay(), start: "10:00", end: "12:00", kind: "lecture" })}>＋ {L("שיעור", "Class")}</button>
        </div>
        {read && <ReadClasses read={read} courses={courses} onCancel={() => setRead(null)} onApply={async (picked) => {
          const made = new Map<string, string>();
          const slots: ClassSlot[] = [];
          for (const p of picked) {
            let id = p.courseId;
            if (id.startsWith("new:")) {
              const nm = id.slice(4);
              if (!made.has(nm)) made.set(nm, (await api<{ id: string }>("/api/study/courses", { method: "POST", body: { name: nm } }).catch(() => ({ id: "" }))).id);
              id = made.get(nm)!;
            }
            if (id) slots.push({ id: newId(), courseId: id, day: p.c.day, start: p.c.start, end: p.c.end, ...(p.c.room ? { room: p.c.room } : {}), ...(p.c.kind ? { kind: p.c.kind } : {}) });
          }
          save({ ...t, slots: [...t.slots, ...slots].slice(0, 80) });
          setRead(null);
          if (made.size) onCourses?.();
          toast(L(`נוספו ${slots.length} שיעורים`, `${slots.length} classes added`));
        }} />}
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
        {!!slots.length && <Attendance t={t} save={save} courses={courses.filter((c) => slots.some((s) => s.courseId === c.id))} name={name} />}
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

/** A photo or screenshot of her schedule read by the vision model (design TimetablePhoto). */
function PhotoButton({ onRead }: { onRead: (c: ReadClass[]) => void }) {
  const [busy, setBusy] = useState(false);
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try {
      const im = new Image();
      im.src = URL.createObjectURL(f);
      await im.decode();
      const k = Math.min(1, 2400 / Math.max(im.naturalWidth, im.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(im.naturalWidth * k);
      c.height = Math.round(im.naturalHeight * k);
      c.getContext("2d")!.drawImage(im, 0, 0, c.width, c.height);
      URL.revokeObjectURL(im.src);
      const r = await api<{ classes: ReadClass[] }>("/api/study/timetable/photo", { method: "POST", body: { image: c.toDataURL("image/jpeg", 0.9).split(",")[1], mime: "image/jpeg" } });
      if (!r.classes.length) toast(L("לא נמצאו שיעורים בתמונה.", "No classes were found in the picture."));
      else onRead(r.classes);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return <label className="button ghost small" aria-disabled={busy}>{busy ? L("קורא את המערכת…", "Reading the schedule…") : L("📷 מצילום", "📷 From a photo")}<input type="file" accept="image/*" hidden disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; void pick(f); }} /></label>;
}

/** The classes read from the photo: she checks each one's course (one of hers, a new course, or skip) and adds them. */
function ReadClasses({ read, courses, onApply, onCancel }: { read: ReadClass[]; courses: Course[]; onApply: (p: Array<{ c: ReadClass; courseId: string }>) => void; onCancel: () => void }) {
  const fold = (x: string) => x.toLowerCase().replace(/[\s"'׳״-]+/g, "");
  const guess = (n: string) => courses.find((c) => fold(c.name) && (fold(n).includes(fold(c.name)) || fold(c.name).includes(fold(n))))?.id ?? `new:${n}`;
  const [pick, setPick] = useState(() => read.map((c) => guess(c.name)));
  return (
    <div className="study-tt-read">
      <b className="small">{L(`נמצאו ${read.length} שיעורים. בדקי לאיזה קורס כל אחד שייך:`, `${read.length} classes found. Check each one's course:`)}</b>
      {read.map((c, i) => (
        <div key={i} className="row study-tt-read-row">
          <span className="small" dir="auto"><b>{c.name}</b> · {L(...DAYS[c.day]!)} {c.start}–{c.end}{c.room ? ` · ${c.room}` : ""}</span>
          <select value={pick[i]} onChange={(e) => setPick(pick.map((p, j) => (j === i ? e.target.value : p)))} aria-label={L("הקורס", "The course")}>
            {courses.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
            <option value={`new:${c.name}`}>{L(`➕ קורס חדש: ${c.name}`, `➕ New course: ${c.name}`)}</option>
            <option value="">{L("לדלג", "Skip")}</option>
          </select>
        </div>
      ))}
      <div className="study-actions">
        <button type="button" className="primary" onClick={() => onApply(read.flatMap((c, i) => (pick[i] ? [{ c, courseId: pick[i]! }] : [])))}>{L("להוסיף למערכת", "Add to the timetable")}</button>
        <button type="button" className="ghost" onClick={onCancel}>{L("ביטול", "Cancel")}</button>
      </div>
    </div>
  );
}

const MARK: Record<AttendanceMark, [string, string]> = { here: ["✓ הייתי", "✓ I was there"], absent: ["✗ לא", "✗ Missed"], excused: ["באישור", "Excused"], cancelled: ["בוטל", "Cancelled"] };

/** "Were you there?" for the classes that ended and are not marked yet (design Attendance), newest first. */
function MarkClasses({ t, save, name, max }: { t: Timetable; save: (t: Timetable) => void; name: (id: string) => string; max: number }) {
  const todo = classesToMark(t, new Date()).filter((x) => name(x.slot.courseId)).slice(0, max);
  if (!todo.length) return null;
  const today = new Date().toDateString();
  const when = (date: string) => {
    const d = new Date(`${date}T12:00`);
    const diff = Math.round((new Date(today).getTime() - new Date(d.toDateString()).getTime()) / 864e5);
    return diff === 0 ? L("היום", "today") : diff === 1 ? L("אתמול", "yesterday") : L(`יום ${DAYS[d.getDay()]![0]}`, DAYS[d.getDay()]![1]);
  };
  return (
    <section className="card study-attend-ask" aria-label={L("היית בשיעור?", "Were you there?")}>
      <b className="small">✋ {L("היית בשיעור?", "Were you there?")}</b>
      {todo.map((x) => (
        <div key={x.key} className="study-attend-row">
          <span className="small" dir="auto">{name(x.slot.courseId)}{x.slot.kind ? ` · ${L(...KIND[x.slot.kind])}` : ""} · {when(x.date)} <span dir="ltr">{x.slot.start}</span></span>
          <span className="study-attend-btns">
            {(["here", "absent", "cancelled"] as const).map((m) => <button key={m} type="button" className="small" onClick={() => save({ ...t, attendance: { ...t.attendance, [x.key]: m } })}>{L(...MARK[m])}</button>)}
          </span>
        </div>
      ))}
    </section>
  );
}

/**
 * Attendance per course (design Attendance, students part 41, like Absentify): turned on once, then each class that
 * ended asks "were you there?"; per course, there of held and the rule (at most N absences, or at least N%) with what
 * is left, a warning at the last one.
 */
function Attendance({ t, save, courses, name }: { t: Timetable; save: (t: Timetable) => void; courses: Course[]; name: (id: string) => string }) {
  const [rule, setRule] = useState<string | null>(null);
  if (!t.trackSince) return (
    <div className="study-attend">
      <b className="small">✋ {L("נוכחות", "Attendance")}</b>
      <p className="muted small">{L("בקורסים עם חובת נוכחות: אחרי כל שיעור תישאלי אם היית, ותראי כמה חיסורים נשארו.", "For courses that require attendance: after each class you are asked whether you were there, and see how many absences are left.")}</p>
      <button type="button" className="small" onClick={() => save({ ...t, trackSince: Date.now() })}>{L("לעקוב אחרי נוכחות", "Track attendance")}</button>
    </div>
  );
  const setLimit = (id: string, v: string) => {
    const limits = { ...t.limits };
    const n = Number(v.replace("%", ""));
    if (!v.trim()) delete limits[id];
    else if (v.includes("%")) limits[id] = { percent: Math.min(100, Math.max(1, Math.round(n))) };
    else limits[id] = { absences: Math.min(50, Math.max(0, Math.round(n))) };
    save({ ...t, limits });
    setRule(null);
  };
  return (
    <div className="study-attend">
      <b className="small">✋ {L("נוכחות", "Attendance")}</b>
      <MarkClasses t={t} save={save} name={name} max={8} />
      {courses.map((c) => {
        const a = attendanceFor(t, c.id);
        const lim = a.limit;
        return (
          <div key={c.id} className="study-attend-course">
            <div className="row">
              <b className="small" dir="auto">{c.name}</b>
              <span className="grow" />
              <span className={`small${a.over ? " bad" : a.warn ? " warn" : " muted"}`}>
                {!lim ? L("בלי חובת נוכחות", "No attendance rule") : a.over ? L("עברת את המותר", "Over the limit") : a.left === 0 ? L("לא נשארו חיסורים", "No absences left") : a.left === 1 ? L("נשאר חיסור אחד", "One absence left") : L(`נשארו ${a.left} חיסורים`, `${a.left} absences left`)}
              </span>
            </div>
            {lim && a.held > 0 && <div className="study-mock-bar" aria-hidden="true"><i style={{ width: `${a.percent ?? 0}%` }} className={a.over || a.warn ? "low" : ""} /></div>}
            <span className="muted small">
              {a.held ? L(`נכחת ${a.here} מתוך ${a.held} (${a.percent}%)`, `There ${a.here} of ${a.held} (${a.percent}%)`) : L("עוד לא סימנת שיעורים", "No classes marked yet")}
              {a.excused ? L(` · ${a.excused} באישור`, ` · ${a.excused} excused`) : ""}
              {lim ? (lim.absences !== undefined ? L(` · מותר עד ${lim.absences} חיסורים`, ` · up to ${lim.absences} absences`) : L(` · חובה ${lim.percent}%`, ` · ${lim.percent}% required`)) : ""}
              {" "}
              {rule === c.id ? (
                <form className="study-attend-rule" onSubmit={(e) => { e.preventDefault(); setLimit(c.id, String(new FormData(e.currentTarget).get("v") ?? "")); }}>
                  <input name="v" defaultValue={lim ? (lim.absences !== undefined ? String(lim.absences) : `${lim.percent}%`) : ""} placeholder={L("3 או 80%", "3 or 80%")} aria-label={L("מותר עד כמה חיסורים, או אחוז חובה (למשל 80%)", "Absences allowed, or a required percent (e.g. 80%)")} size={6} autoFocus />
                  <button type="submit" className="small">{L("שמירה", "Save")}</button>
                </form>
              ) : <button type="button" className="link small" onClick={() => setRule(c.id)}>{lim ? L("לשנות", "Change") : L("+ חובת נוכחות", "+ Attendance rule")}</button>}
            </span>
          </div>
        );
      })}
    </div>
  );
}
