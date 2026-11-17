import { useState } from "react";
import type { LetterKind } from "@kesher/shared";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
const KINDS: Array<[LetterKind, string, string, string]> = [
  ["extension", "⏳ בקשת הארכה", "⏳ An extension", "איזו מטלה, עד מתי הייתה, למה ועד מתי מבקשת"],
  ["reserve", "🎖 התאמות אחרי מילואים", "🎖 Reserve-duty accommodations", "מתי היית במילואים, מה פספסת (שיעורים, מטלות, בחינה) ומה את מבקשת"],
  ["appeal", "📝 ערעור על ציון", "📝 A grade appeal", "איזה מבחן או מטלה, אילו שאלות לבדוק שוב ולמה"],
  ["special", "📅 מועד מיוחד", "📅 A special exam date", "איזה מבחן, ולמה את צריכה מועד מיוחד"],
  ["other", "✉️ משהו אחר", "✉️ Something else", "מה את רוצה לבקש"],
];

/**
 * A letter to the lecturer or the secretariat (design Letters, students part 31 #4): an extension, reserve-duty
 * accommodations, a grade appeal or a special exam date, drafted politely from what she writes. KesherAI never sends
 * it: she copies it, or opens it in her mail app, and sends it herself.
 */
export function StudyLetter({ courseId, onClose }: { courseId: string; onClose: () => void }) {
  const [kind, setKind] = useState<LetterKind>("extension");
  const [to, setTo] = useState("");
  const [name, setName] = useState("");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [letter, setLetter] = useState<{ subject: string; body: string } | null>(null);
  const write = async () => {
    setBusy(true);
    try {
      setLetter(await api<{ subject: string; body: string }>(`/api/study/courses/${courseId}/letter`, { method: "POST", body: { kind, to, name, details } }));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const hint = KINDS.find((k) => k[0] === kind)!;
  return (
    <section className="card study-letter">
      <div className="row study-live-head">
        <h2>✉️ {L("מכתב למרצה או למזכירות", "A letter to the lecturer or the secretariat")}</h2>
        <button type="button" className="ghost small" onClick={onClose}>{L("סגירה", "Close")}</button>
      </div>
      <div className="study-formats" role="radiogroup" aria-label={L("סוג המכתב", "Kind of letter")}>
        {KINDS.map(([k, he, en]) => <button key={k} type="button" role="radio" aria-checked={kind === k} className={`chip${kind === k ? " on" : ""}`} onClick={() => setKind(k)}>{L(he, en)}</button>)}
      </div>
      <div className="row study-letter-who">
        <label className="small">{L("אל", "To")} <input dir="auto" value={to} onChange={(e) => setTo(e.target.value)} placeholder={L("ד״ר כהן / מזכירות הפקולטה", "Dr Cohen / the faculty office")} /></label>
        <label className="small">{L("השם שלך", "Your name")} <input dir="auto" value={name} onChange={(e) => setName(e.target.value)} /></label>
      </div>
      <label className="small">{L("הפרטים", "The details")} <textarea rows={3} dir="auto" value={details} onChange={(e) => setDetails(e.target.value)} placeholder={L(hint[3], "What to ask, and why")} /></label>
      <div className="study-actions"><button type="button" className="primary" disabled={busy} onClick={() => void write()}>{busy ? L("כותב…", "Writing…") : letter ? L("לכתוב שוב", "Write again") : L("לכתוב טיוטה", "Write a draft")}</button></div>
      {letter && (
        <div className="study-letter-out">
          <label className="small">{L("נושא", "Subject")} <input dir="auto" value={letter.subject} onChange={(e) => setLetter({ ...letter, subject: e.target.value })} /></label>
          <textarea rows={10} dir="auto" value={letter.body} onChange={(e) => setLetter({ ...letter, body: e.target.value })} aria-label={L("המכתב", "The letter")} />
          <div className="row study-paper-actions">
            <button type="button" className="small" onClick={() => void navigator.clipboard?.writeText(`${letter.subject}\n\n${letter.body}`).then(() => toast(L("הועתק", "Copied")))}>{L("העתקה", "Copy")}</button>
            <a className="button small" href={`mailto:?subject=${encodeURIComponent(letter.subject)}&body=${encodeURIComponent(letter.body)}`}>{L("לפתוח בתוכנת המייל", "Open in my mail app")}</a>
          </div>
          <p className="muted small">{L("זו טיוטה: כדאי לקרוא ולתקן לפני השליחה. KesherAI לא שולח אותה בשבילך.", "This is a draft: read and fix it before sending. KesherAI does not send it for you.")}</p>
        </div>
      )}
    </section>
  );
}
