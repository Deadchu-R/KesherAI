import { useEffect, useState } from "react";
import type { WritingFeedback, WritingStage } from "@kesher/shared";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
const STAGES: Array<[WritingStage, string, string]> = [
  ["assignment", "1 · המטלה", "1 · The task"],
  ["outline", "2 · שלד", "2 · Outline"],
  ["draft", "3 · טיוטה", "3 · Draft"],
  ["revision", "4 · תיקון", "4 · Revision"],
];
const TONE = ["", "#ff7a7a", "#f0a830", "#a5b4ff", "#7fd8a8"];

/** The text with the quotes the coach commented on marked (as text nodes, never HTML). */
function Marked({ text, quotes, on, pick }: { text: string; quotes: string[]; on: number | null; pick: (i: number) => void }) {
  const parts: Array<{ t: string; q?: number }> = [];
  // Each quote marked at its first place, in reading order.
  const found = quotes.map((q, i) => ({ i, at: text.indexOf(q) })).filter((x) => x.at >= 0).sort((a, b) => a.at - b.at);
  let pos = 0;
  for (const f of found) {
    const at = text.indexOf(quotes[f.i]!, pos);
    if (at < 0) continue;
    parts.push({ t: text.slice(pos, at) }, { t: quotes[f.i]!, q: f.i });
    pos = at + quotes[f.i]!.length;
  }
  parts.push({ t: text.slice(pos) });
  return <div className="writing-text" dir="auto">{parts.map((p, i) => (p.q === undefined ? <span key={i}>{p.t}</span> : <mark key={i} className={on === p.q ? "on" : ""} onClick={() => pick(p.q!)}>{p.t}</mark>))}</div>;
}

/**
 * The writing coach (design WritingCoach, like Khanmigo's): the assignment, an outline, a draft, a revision; feedback
 * by part and comments on her own words, with her lectures as evidence. It never writes the work for her. Her text
 * is kept on this device until she clears it.
 */
export function StudyWriting({ courseId }: { courseId: string }) {
  const key = `kesher-writing:${courseId}`;
  const [stage, setStage] = useState<WritingStage>("assignment");
  const [assignment, setAssignment] = useState("");
  const [text, setText] = useState("");
  const [fb, setFb] = useState<WritingFeedback | null>(null);
  const [busy, setBusy] = useState(false);
  const [on, setOn] = useState<number | null>(null);
  useEffect(() => {
    try {
      const j = JSON.parse(localStorage.getItem(key) ?? "{}") as { stage?: WritingStage; assignment?: string; text?: string };
      if (j.stage) setStage(j.stage);
      setAssignment(j.assignment ?? "");
      setText(j.text ?? "");
    } catch {
      // nothing kept
    }
  }, [key]);
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify({ stage, assignment, text }));
    } catch {
      // private mode
    }
  }, [key, stage, assignment, text]);
  const body = stage === "assignment" ? assignment : text;
  const ask = async () => {
    setBusy(true);
    setFb(null);
    setOn(null);
    try {
      setFb(await api<WritingFeedback>(`/api/study/courses/${courseId}/writing`, { method: "POST", body: { stage, text: body, assignment } }));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="study-writing">
      <div className="writing-stages" role="tablist" aria-label={L("שלבים", "Stages")}>
        {STAGES.map(([k, he, en]) => <button type="button" key={k} role="tab" aria-selected={stage === k} className={stage === k ? "on" : ""} onClick={() => { setStage(k); setFb(null); }}>{L(he, en)}</button>)}
      </div>
      <p className="muted small">{stage === "assignment" ? L("הדביקי את המטלה. המאמן יפרק מה היא באמת מבקשת, ויבדוק שהבנת.", "Paste the assignment. The coach breaks down what it really asks and checks you understood.") : stage === "outline" ? L("כתבי את הטענה המרכזית ונקודות השלד. המאמן יבדוק שהן מחזיקות.", "Write your main claim and outline points. The coach checks they hold up.") : stage === "draft" ? L("הדביקי את הטיוטה. המשוב לפי חלקים, עם הערות על המשפטים שלך וראיות מההרצאות.", "Paste your draft. Feedback by part, with comments on your sentences and evidence from your lectures.") : L("אחרי שתיקנת: המאמן יגיד מה השתפר ומה עוד צריך.", "After revising: the coach says what improved and what still needs work.")}</p>
      {fb && fb.comments.length > 0 && body.trim() ? <Marked text={body} quotes={fb.comments.map((c) => c.quote)} on={on} pick={setOn} /> : (
        <textarea dir="auto" rows={stage === "assignment" ? 6 : 12} value={body} onChange={(e) => (stage === "assignment" ? setAssignment(e.target.value) : setText(e.target.value))} placeholder={stage === "assignment" ? L("טקסט המטלה…", "The assignment's text…") : L("הטקסט שלך…", "Your text…")} />
      )}
      <div className="row">
        <button type="button" className="primary" disabled={busy || body.trim().length < 30} onClick={() => void ask()}>{busy ? L("קורא…", "Reading…") : L("משוב", "Get feedback")}</button>
        {fb && <button type="button" onClick={() => { setFb(null); setOn(null); }}>✏️ {L("לחזור לעריכה", "Back to editing")}</button>}
      </div>
      {fb && (
        <div className="writing-feedback">
          {fb.summary && <p dir="auto">{fb.summary}</p>}
          {fb.dimensions.length > 0 && (
            <div className="card writing-dims">
              {fb.dimensions.map((d) => (
                <div key={d.name} className="writing-dim">
                  <b>{d.name}</b>
                  <span><span style={{ color: TONE[d.level] }} aria-label={`${d.level}/4`}>{"●".repeat(d.level)}{"○".repeat(4 - d.level)}</span> <small dir="auto">{d.note}</small></span>
                </div>
              ))}
            </div>
          )}
          {fb.comments.map((c, i) => (
            <button type="button" key={i} className={`card writing-comment${on === i ? " on" : ""}`} onClick={() => setOn(i)}>
              <b dir="auto">“{c.quote}”</b>
              <span dir="auto">{c.note}</span>
            </button>
          ))}
          {fb.next.length > 0 && <ul className="writing-next" dir="auto">{fb.next.map((n, i) => <li key={i}>{n}</li>)}</ul>}
        </div>
      )}
      <p className="muted small">{L("המאמן לא כותב בשבילך: הוא שואל, מצביע ומסביר. הטקסט נשמר רק במכשיר הזה.", "The coach doesn't write it for you: it asks, points and explains. Your text stays on this device only.")}</p>
    </section>
  );
}
