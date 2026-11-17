import { useEffect, useRef, useState } from "react";
import { averageNeeded, neededFor, rowGrade, weightedAverage, type GradeRow, type Grades } from "@kesher/shared";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
const newId = () => `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const DEFAULT_PARTS = () => [{ name: L("מבחן", "Exam"), weight: 70 }, { name: L("עבודות", "Assignments"), weight: 30 }];
/** A number field's value: empty stays empty. */
const val = (n: number | undefined) => (n === undefined ? "" : String(n));
const parse = (s: string) => (s.trim() === "" ? undefined : Number(s));

/**
 * Grades and the weighted average (design Grades, students part 27 #2): her Study courses and earlier ones, each with
 * its credits (נק"ז) and the parts of its grade; the course grade, what she needs in the exam for the grade she wants
 * (and at least the passing exam score), the weighted average, and the average she needs in the credits to come.
 */
export function StudyGrades({ courses }: { courses: Array<{ id: string; name: string }> }) {
  const [g, setG] = useState<Grades | null>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef(0);
  useEffect(() => void api<Grades>("/api/study/grades").then(setG, () => setG({ rows: [] })), []);
  if (!g) return null;
  const save = (next: Grades) => {
    setG(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void api("/api/study/grades", { method: "PUT", body: next }).catch((e: Error) => toast(e.message)), 700);
  };
  const setRow = (id: string, change: Partial<GradeRow>) => save({ ...g, rows: g.rows.map((r) => (r.id === id ? { ...r, ...change } : r)) });
  const { average, credits } = weightedAverage(g.rows);
  const missing = courses.filter((c) => !g.rows.some((r) => r.courseId === c.id));
  const avgNeed = g.target !== undefined && g.remaining ? averageNeeded(g.rows, g.target, g.remaining) : undefined;
  return (
    <section className="card study-grades">
      <button type="button" className="study-grades-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <b>🎓 {L("ציונים וממוצע", "Grades and average")}</b>
        <span className="grow" />
        {average !== undefined ? <><b className="study-grades-avg">{average}</b><span className="muted small">{L(`ממוצע משוקלל · ${credits} נק"ז`, `weighted average · ${credits} credits`)}</span></> : <span className="muted small">{L("להוסיף ציונים", "Add grades")}</span>}
        <span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open && <>
        {g.rows.map((r) => {
          const { grade, sofar, left } = rowGrade(r);
          const want = r.want ?? g.target ?? 85;
          const need = neededFor(r, want);
          return (
            <div key={r.id} className="study-grade-row">
              <div className="row study-grade-top">
                <input dir="auto" className="study-grade-name" value={r.name} onChange={(e) => setRow(r.id, { name: e.target.value })} aria-label={L("שם הקורס", "Course name")} />
                <label className="small">{L('נק"ז', "Credits")} <input type="number" min={0} max={30} step={0.5} value={val(r.credits)} onChange={(e) => setRow(r.id, { credits: parse(e.target.value) ?? 0 })} /></label>
                <span className="grow" />
                <b className="study-grade-final">{grade ?? (sofar !== undefined ? <span className="muted small">{L(`עד עכשיו ${sofar}`, `so far ${sofar}`)}</span> : "—")}</b>
                <button type="button" className="ghost small" aria-label={L("להסיר", "Remove")} onClick={() => confirm(L(`להסיר את "${r.name}" מהציונים?`, `Remove "${r.name}" from the grades?`)) && save({ ...g, rows: g.rows.filter((x) => x.id !== r.id) })}>✕</button>
              </div>
              {r.final === undefined && (
                <div className="study-grade-parts">
                  {r.parts.map((p, k) => (
                    <div key={k} className="row study-grade-part">
                      <input dir="auto" value={p.name} placeholder={L("רכיב", "Part")} onChange={(e) => setRow(r.id, { parts: r.parts.map((x, j) => (j === k ? { ...x, name: e.target.value } : x)) })} aria-label={L("שם הרכיב", "Part name")} />
                      <label className="small"><input type="number" min={0} max={100} value={val(p.weight)} onChange={(e) => setRow(r.id, { parts: r.parts.map((x, j) => (j === k ? { ...x, weight: parse(e.target.value) ?? 0 } : x)) })} aria-label={L("משקל באחוזים", "Weight in percent")} />%</label>
                      <input type="number" min={0} max={100} value={val(p.score)} placeholder={L("ציון", "Score")} onChange={(e) => { const s = parse(e.target.value); setRow(r.id, { parts: r.parts.map((x, j) => (j === k ? { name: x.name, weight: x.weight, ...(s !== undefined ? { score: s } : {}) } : x)) }); }} aria-label={L("הציון", "Score")} />
                      <button type="button" className="ghost small" aria-label={L("להסיר רכיב", "Remove part")} onClick={() => setRow(r.id, { parts: r.parts.filter((_, j) => j !== k) })}>✕</button>
                    </div>
                  ))}
                  <div className="row study-grade-more">
                    <button type="button" className="ghost small" onClick={() => setRow(r.id, { parts: [...r.parts, { name: "", weight: 0 }] })}>＋ {L("רכיב", "Part")}</button>
                    <label className="small">{L("מינימום לעבור במבחן", "Exam pass mark")} <input type="number" min={0} max={100} value={val(r.minExam)} onChange={(e) => { const { minExam: _, ...rest } = r; const m = parse(e.target.value); save({ ...g, rows: g.rows.map((x) => (x.id === r.id ? { ...rest, ...(m !== undefined ? { minExam: m } : {}) } : x)) }); }} /></label>
                    <label className="small">{L("רוצה לסיים עם", "Want to finish with")} <input type="number" min={0} max={100} value={val(r.want)} placeholder={String(g.target ?? 85)} onChange={(e) => { const { want: _, ...rest } = r; const w = parse(e.target.value); save({ ...g, rows: g.rows.map((x) => (x.id === r.id ? { ...rest, ...(w !== undefined ? { want: w } : {}) } : x)) }); }} /></label>
                  </div>
                  {need !== undefined && left > 0 && (
                    <p className={`small study-grade-need${need > 100 ? " far" : ""}`} dir="auto">
                      {need > 100 ? L(`גם 100 במה שנשאר לא יביא ל-${want}. אפשר להגיע עד ${Math.floor(rowGrade({ ...r, parts: r.parts.map((p) => ({ ...p, score: p.score ?? 100 })) }).grade ?? 0)}.`, `Even 100 in what is left will not reach ${want}; the most is ${Math.floor(rowGrade({ ...r, parts: r.parts.map((p) => ({ ...p, score: p.score ?? 100 })) }).grade ?? 0)}.`)
                        : L(`כדי לסיים עם ${want} צריך ${need} במה שנשאר (${left}% מהציון)`, `To finish with ${want} you need ${need} in what is left (${left}% of the grade)`)}{r.minExam !== undefined ? L(` · מינימום לעבור: ${r.minExam}`, ` · pass mark: ${r.minExam}`) : ""}
                    </p>
                  )}
                </div>
              )}
              <label className="small study-grade-typed"><input type="checkbox" checked={r.final !== undefined} onChange={(e) => { const { final: _, ...rest } = r; save({ ...g, rows: g.rows.map((x) => (x.id === r.id ? (e.target.checked ? { ...rest, final: grade ?? sofar ?? 80 } : rest) : x)) }); }} /> {L("ציון סופי ידוע", "Final grade known")}
                {r.final !== undefined && <input type="number" min={0} max={100} value={val(r.final)} onChange={(e) => setRow(r.id, { final: parse(e.target.value) ?? 0 })} aria-label={L("ציון סופי", "Final grade")} />}
              </label>
            </div>
          );
        })}
        <div className="study-actions">
          {missing.map((c) => <button key={c.id} type="button" className="ghost small" onClick={() => save({ ...g, rows: [...g.rows, { id: newId(), courseId: c.id, name: c.name, credits: 0, parts: DEFAULT_PARTS() }] })}>＋ {c.name}</button>)}
          <button type="button" className="ghost small" onClick={() => save({ ...g, rows: [...g.rows, { id: newId(), name: L("קורס קודם", "Earlier course"), credits: 0, parts: [], final: 80 }] })}>＋ {L("קורס קודם", "Earlier course")}</button>
        </div>
        <div className="row study-grade-target">
          <label className="small">{L("יעד ממוצע", "Target average")} <input type="number" min={0} max={100} value={val(g.target)} onChange={(e) => { const { target: _, ...rest } = g; const t = parse(e.target.value); save({ ...rest, ...(t !== undefined ? { target: t } : {}) }); }} /></label>
          <label className="small">{L('נק"ז שנשארו', "Credits to come")} <input type="number" min={0} max={400} value={val(g.remaining)} onChange={(e) => { const { remaining: _, ...rest } = g; const n = parse(e.target.value); save({ ...rest, ...(n !== undefined ? { remaining: n } : {}) }); }} /></label>
        </div>
        {avgNeed !== undefined && <p className="small" dir="auto">{avgNeed > 100 ? L(`גם 100 בכל ${g.remaining} הנק"ז שנשארו לא יביא לממוצע ${g.target}.`, `Even 100 in all ${g.remaining} credits to come will not reach ${g.target}.`) : L(`כדי להגיע לממוצע ${g.target}, צריך בממוצע ${avgNeed} ב-${g.remaining} הנק"ז שנשארו.`, `To reach an average of ${g.target}, you need ${avgNeed} on average in the ${g.remaining} credits to come.`)}</p>}
      </>}
    </section>
  );
}
