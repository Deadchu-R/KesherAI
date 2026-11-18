/**
 * The nursing tools: drug cards, lab values and medication-calculation practice (computed here, never by a model).
 * Part of the Study page (pages/StudyPage.tsx).
 */
import { useState } from "react";
import { calcCorrect, LAB_VALUES, practiceProblem, type CalcKind, type LabValue, type StudyDrug, type CalcProblem } from "@kesher/shared";
import { api } from "../../api";
import { CourseInfo, L, call } from "./common";

/** The course's drug cards: the list, adding one from the material, and each card's fields. */
export function Drugs({ courseId, info, onChange }: { courseId: string; info: CourseInfo; onChange: () => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string>();
  const shown = info.drugs.filter((d) => !q || `${d.name} ${d.brands ?? ""} ${d.drugClass ?? ""}`.toLowerCase().includes(q.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name));
  const rows: Array<[keyof StudyDrug, [string, string]]> = [["brands", ["שמות מסחריים", "Brand names"]], ["drugClass", ["קבוצה", "Class"]], ["action", ["מנגנון פעולה", "How it works"]], ["uses", ["התוויות", "Uses"]], ["dose", ["מינון ודרך מתן", "Dose and route"]], ["sideEffects", ["תופעות לוואי", "Side effects"]], ["contraindications", ["התוויות נגד", "Contraindications"]], ["nursing", ["תפקיד האחות", "Nursing"]], ["teaching", ["הדרכת המטופל", "Patient teaching"]]];
  return (
    <section className="study-drugs">
      <p className="muted small">{L("כרטיסי התרופות נכתבים מההרצאות שלך בלבד (בעמוד ההרצאה: ״כרטיסי תרופות מההרצאה״). כל תרופה מוסיפה גם שלוש כרטיסיות לחזרה. מינונים — תמיד לפי ההוראה ובית המרקחת.", "Drug cards come from your lectures only (on a lecture: “Drug cards from this lecture”). Each drug also adds three review cards. Doses: always by the order and the pharmacy.")}</p>
      {info.drugs.length > 0 && <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L("חיפוש תרופה", "Search a drug")} aria-label={L("חיפוש", "Search")} dir="auto" />}
      {!info.drugs.length ? <p className="muted">{L("עוד אין כרטיסי תרופות.", "No drug cards yet.")}</p> : (
        <ul className="study-list">
          {shown.map((d) => (
            <li key={d.id} className="study-drug">
              <button type="button" className="study-drug-head" aria-expanded={open === d.id} onClick={() => setOpen(open === d.id ? undefined : d.id)}>
                <b dir="ltr">{d.name}</b>
                {d.drugClass && <small dir="auto">{d.drugClass}</small>}
              </button>
              {open === d.id && (
                <dl className="study-drug-body">
                  {rows.filter(([k]) => d[k]).map(([k, n]) => <div key={k}><dt>{L(...n)}</dt><dd dir="auto">{String(d[k])}</dd></div>)}
                  <button type="button" className="small ghost" onClick={async () => { if (confirm(L(`להסיר את ${d.name}?`, `Remove ${d.name}?`)) && (await call(api(`/api/study/courses/${courseId}/drugs/${d.id}`, { method: "DELETE" })))) onChange(); }}>{L("הסר", "Remove")}</button>
                </dl>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const LAB_GROUPS: Record<LabValue["group"], [string, string]> = { electrolytes: ["אלקטרוליטים", "Electrolytes"], blood: ["ספירת דם וסוכר", "Blood count and glucose"], kidney: ["כליות", "Kidneys"], gases: ["גזים בדם", "Blood gases"], coagulation: ["קרישה", "Clotting"], other: ["עוד", "Other"] };

/** Normal adult lab ranges, by group, with a search. */
export function LabValues() {
  const [q, setQ] = useState("");
  const shown = LAB_VALUES.filter((v) => !q || `${v.name} ${v.he}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <section className="study-labs">
      <p className="muted small">{L("ערכים תקינים למבוגרים כפי שמלמדים בדרך כלל. לכל מעבדה טווחים משלה: תמיד לבדוק מול הטווח של בית החולים ושל הקורס.", "Normal adult values as usually taught. Every lab has its own ranges: always check your hospital's and your course's.")}</p>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L("חיפוש, למשל אשלגן", "Search, e.g. potassium")} aria-label={L("חיפוש", "Search")} dir="auto" />
      {(Object.keys(LAB_GROUPS) as Array<LabValue["group"]>).map((g) => {
        const rows = shown.filter((v) => v.group === g);
        if (!rows.length) return null;
        return (
          <div key={g} className="card">
            <h2>{L(...LAB_GROUPS[g])}</h2>
            <table className="study-lab-table">
              <tbody>
                {rows.map((v) => (
                  <tr key={v.name}>
                    <th scope="row"><span>{v.he}</span> <small dir="ltr">{v.name}</small></th>
                    <td dir="ltr">{v.range} <small>{v.unit}</small>{v.note ? <small> · {v.note}</small> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </section>
  );
}

const CALC: Array<[CalcKind, [string, string]]> = [
  ["volume", ["נפח למתן", "Volume to give"]],
  ["tablets", ["טבליות", "Tablets"]],
  ["weight", ["לפי משקל", "By weight"]],
  ["rate", ["קצב משאבה", "Pump rate"]],
  ["drops", ["טיפות לדקה", "Drops per minute"]],
  ["infusion", ["עירוי mcg/kg/min", "Infusion mcg/kg/min"]],
];

/** A number with its unit kept together in right-to-left text. */
const u = (n: number | undefined, unit: string) => `\u2068${n} ${unit}\u2069`;

/** The problem in words, from its numbers. */
function calcQuestion(p: CalcProblem): string {
  const v = p.values;
  switch (p.kind) {
    case "volume": return L(`הוראה: ${u(v.doseMg, "mg")}. בבקבוקון יש ${u(v.haveMg, "mg")} ב-${u(v.perMl, "mL")}. כמה mL לתת?`, `Ordered ${u(v.doseMg, "mg")}. The vial has ${u(v.haveMg, "mg")} in ${u(v.perMl, "mL")}. How many mL?`);
    case "tablets": return L(`הוראה: ${u(v.doseMg, "mg")}. כל טבליה ${u(v.tabletMg, "mg")}. כמה טבליות לתת?`, `Ordered ${u(v.doseMg, "mg")}. Each tablet is ${u(v.tabletMg, "mg")}. How many tablets?`);
    case "weight": return L(`הוראה: ${u(v.mgPerKg, "mg/kg")}. המטופל שוקל ${u(v.kg, "kg")}. כמה mg לתת?`, `Ordered ${u(v.mgPerKg, "mg/kg")}. The patient weighs ${u(v.kg, "kg")}. How many mg?`);
    case "rate": return L(`יש לתת ${u(v.volumeMl, "mL")} במשך ${v.hours} שעות במשאבה. מה הקצב ב-mL/h?`, `Give ${u(v.volumeMl, "mL")} over ${v.hours} hours by pump. What rate in mL/h?`);
    case "drops": return L(`יש לתת ${u(v.volumeMl, "mL")} במשך ${v.minutes} דקות בסט של ${v.dropFactor} טיפות ל-mL. כמה טיפות לדקה?`, `Give ${u(v.volumeMl, "mL")} over ${v.minutes} minutes with a ${v.dropFactor} drops/mL set. Drops per minute?`);
    case "infusion": return L(`הוראה: ${u(v.mcgPerKgMin, "mcg/kg/min")}, משקל ${u(v.kg, "kg")}. בשקית ${u(v.drugMg, "mg")} ב-${u(v.bagMl, "mL")}. מה קצב המשאבה ב-mL/h?`, `Ordered ${u(v.mcgPerKgMin, "mcg/kg/min")}, weight ${u(v.kg, "kg")}. The bag has ${u(v.drugMg, "mg")} in ${u(v.bagMl, "mL")}. Pump rate in mL/h?`);
  }
}

/** Medication-calculation practice: a new problem of the chosen kind, her answer checked here with the steps. */
export function CalcPractice() {
  const [kind, setKind] = useState<CalcKind>("volume");
  const [p, setP] = useState(() => practiceProblem("volume"));
  const [answer, setAnswer] = useState("");
  const [checked, setChecked] = useState<boolean | null>(null);
  const next = (k = kind) => { setKind(k); setP(practiceProblem(k)); setAnswer(""); setChecked(null); };
  return (
    <section className="study-calc">
      <p className="muted small">{L("התשובה מחושבת בקוד, לא במודל — אפשר לסמוך עליה. תמיד לבדוק מול הוראות המחלקה.", "The answer is computed by code, not by a model. Always check against your ward's rules.")}</p>
      <div className="seg-pills" role="tablist" aria-label={L("סוג חישוב", "Kind")}>
        {CALC.map(([k, n]) => <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? "on" : ""} onClick={() => next(k)}>{L(...n)}</button>)}
      </div>
      <div className="card">
        <p className="study-calc-q" dir="auto">{calcQuestion(p)}</p>
        <form className="study-calc-answer" onSubmit={(e) => { e.preventDefault(); setChecked(calcCorrect(Number(answer.replace(",", ".")), p.result)); }}>
          <input inputMode="decimal" value={answer} onChange={(e) => { setAnswer(e.target.value); setChecked(null); }} aria-label={L("התשובה שלך", "Your answer")} dir="ltr" />
          <span className="muted" dir="ltr">{p.result.unit}</span>
          <button type="submit" className="primary" disabled={!answer.trim()}>{L("בדוק", "Check")}</button>
        </form>
        {checked !== null && (
          <div className={`study-calc-result ${checked ? "good" : "bad"}`}>
            <b>{checked ? L("✓ נכון. הדרך:", "✓ Right. The way:") : L(`לא נכון. התשובה: ${u(p.result.value, p.result.unit)}. הדרך:`, `Not right. The answer: ${p.result.value} ${p.result.unit}. The way:`)}</b>
            <ol dir="ltr">{p.result.steps.map((s, k) => <li key={k}>{s}</li>)}</ol>
          </div>
        )}
        <button type="button" onClick={() => next()}>{L("תרגיל נוסף", "Another problem")}</button>
      </div>
    </section>
  );
}
