import { useState } from "react";
import type { StudyLecture, StudyTerm, TeachBackResult } from "@kesher/shared";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";
import { Mic } from "./Mic";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/**
 * Teach-back (the Feynman technique, design TeachBack): she picks a topic of the lecture and explains it in her own
 * words; KesherAI checks it against the lecture: what she got right (green), left out (orange, each with a card to
 * add) and got wrong (red), a score and one tip.
 */
export function StudyTeachBack({ base, lecture }: { base: string; lecture: StudyLecture }) {
  const topics = [lecture.title, ...((lecture.terms ?? []) as StudyTerm[]).slice(0, 12).map((t) => t.term)];
  const [topic, setTopic] = useState(topics[0]!);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState<TeachBackResult | null>(null);
  const [added, setAdded] = useState<Set<number>>(new Set());
  const courseBase = base.replace(/\/lectures\/[^/]+$/, "");
  const check = async () => {
    setBusy(true);
    try {
      setR(await api<TeachBackResult>(`${base}/teach-back`, { method: "POST", body: { topic, text } }));
      setAdded(new Set());
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const addCards = async (only?: number) => {
    const list = (r?.missing ?? []).map((m, i) => ({ m, i })).filter(({ m, i }) => m.card && !added.has(i) && (only === undefined || i === only));
    for (const { m, i } of list) {
      await api(`${courseBase}/cards`, { method: "POST", body: { front: m.card!.front, back: m.card!.back, lectureId: lecture.id, kind: "concept" } }).catch(() => undefined);
      setAdded((s) => new Set(s).add(i));
    }
    if (list.length) toast(L(`נוספו ${list.length} כרטיסיות`, `${list.length} cards added`));
  };
  const tone = (r?.score ?? 0) >= 80 ? "#7fd8a8" : (r?.score ?? 0) >= 55 ? "#f0a830" : "#f07a5a";
  return (
    <div className="teach-back">
      <div className="stack">
        <label className="row"><span className="muted small">{L("נושא:", "Topic:")}</span>
          <select value={topic} onChange={(e) => setTopic(e.target.value)} dir="auto">{topics.map((t) => <option key={t} value={t}>{t}</option>)}</select>
        </label>
        <textarea rows={7} dir="auto" value={text} onChange={(e) => setText(e.target.value)} placeholder={L("הסבירי את הנושא במילים שלך, כאילו את מלמדת חברה. אפשר גם בקול (🎤).", "Explain the topic in your own words, as if teaching a friend. Or by voice (🎤).")} aria-label={L("ההסבר שלך", "Your explanation")} />
        <div className="row">
          <Mic onText={(t) => setText((v) => (v.trim() ? `${v.trimEnd()} ${t}` : t))} />
          <button type="button" className="primary grow" disabled={busy || text.trim().length < 20} onClick={() => void check()}>{busy ? L("בודק מול ההרצאה…", "Checking against the lecture…") : L("בדוק אותי", "Check me")}</button>
        </div>
      </div>
      {r && (
        <div className="stack teach-result">
          <div className="row"><span className="teach-score" style={{ borderColor: tone }}>{r.score}</span><b className="grow" dir="auto">{r.tip || L("הנה מה שמצאתי", "Here is what I found")}</b></div>
          {r.covered.map((c, i) => <div key={`c${i}`} className="teach-row good-row" dir="auto">✓ {c}</div>)}
          {r.missing.map((m, i) => (
            <div key={`m${i}`} className="teach-row warn-row" dir="auto">! {m.point}
              {m.card && (added.has(i) ? <span className="muted small"> · {L("נוסף ✓", "Added ✓")}</span> : <button type="button" className="ghost small" onClick={() => void addCards(i)}>{L("+ כרטיסייה", "+ Card")}</button>)}
            </div>
          ))}
          {r.wrong.map((w, i) => <div key={`w${i}`} className="teach-row bad-row" dir="auto">✕ {L("אמרת:", "You said:")} {w.said} — {L("בהרצאה:", "The lecture:")} {w.right}</div>)}
          {r.missing.some((m, i) => m.card && !added.has(i)) && <button type="button" onClick={() => void addCards()}>{L(`+ כל הכרטיסיות מהפערים (${r.missing.filter((m, i) => m.card && !added.has(i)).length})`, `+ All cards from the gaps (${r.missing.filter((m, i) => m.card && !added.has(i)).length})`)}</button>}
        </div>
      )}
    </div>
  );
}
