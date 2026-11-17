import { useEffect, useRef, useState } from "react";
import { pageAt, type StudyCard, type StudyHighlight } from "@kesher/shared";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
const newId = () => `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** The text cut into plain and highlighted pieces (each highlight at its first place; overlaps skipped). */
function pieces(text: string, hs: StudyHighlight[]): Array<{ s: string; h?: StudyHighlight }> {
  const ranges = hs.map((h) => ({ h, at: text.indexOf(h.text) })).filter((r) => r.at >= 0).sort((a, b) => a.at - b.at);
  const out: Array<{ s: string; h?: StudyHighlight }> = [];
  let pos = 0;
  for (const r of ranges) {
    if (r.at < pos) continue;
    if (r.at > pos) out.push({ s: text.slice(pos, r.at) });
    out.push({ s: r.h.text, h: r.h });
    pos = r.at + r.h.text.length;
  }
  if (pos < text.length) out.push({ s: text.slice(pos) });
  return out;
}

/**
 * Reading with highlights (design ReadHighlights, students part 27 #5, like LiquidText and RemNote): select text in
 * the lecture (a PDF's or slides' text keeps its page marks), highlight it, with a note if she likes; her highlights
 * with their pages beside it, and the new ones made into cards in one tap.
 */
export function StudyHighlights({ base, text, initial, onCards }: { base: string; text: string; initial: StudyHighlight[]; onCards: () => void }) {
  const [hs, setHs] = useState(initial);
  const [sel, setSel] = useState("");
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const on = () => {
      const s = getSelection();
      const inside = !!s && s.rangeCount > 0 && !!box.current?.contains(s.getRangeAt(0).commonAncestorContainer);
      setSel(inside ? s!.toString().trim().slice(0, 2000) : "");
    };
    document.addEventListener("selectionchange", on);
    return () => document.removeEventListener("selectionchange", on);
  }, []);
  const save = (next: StudyHighlight[]) => {
    setHs(next);
    void api(`${base}/highlights`, { method: "PUT", body: { highlights: next } }).catch((e: Error) => toast(e.message));
  };
  const add = (withNote: boolean) => {
    if (!sel) return;
    const at = text.indexOf(sel);
    const page = at >= 0 ? pageAt(text, at) : undefined;
    const h: StudyHighlight = { id: newId(), text: sel, ...(page ? { page } : {}), t: Date.now() };
    save([...hs, h]);
    getSelection()?.removeAllRanges();
    setSel("");
    if (withNote) {
      setNoteFor(h.id);
      setNote("");
    }
  };
  const fresh = hs.filter((h) => !h.carded).length;
  const toCards = async () => {
    setBusy(true);
    try {
      const r = await api<{ cards: StudyCard[] }>(`${base}/cards`, { method: "POST", body: { highlights: true } });
      toast(L(`נוצרו ${r.cards.length} כרטיסיות מההדגשות`, `${r.cards.length} cards made from your highlights`));
      setHs((x) => x.map((h) => ({ ...h, carded: true })));
      onCards();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="study-hl">
      <div className="study-hl-text" dir="auto" ref={box}>
        {pieces(text, hs).map((p, i) => (p.h ? <mark key={i} title={p.h.note ?? ""}>{p.s}</mark> : <span key={i}>{p.s}</span>))}
      </div>
      {sel && (
        <div className="study-hl-bar" onMouseDown={(e) => e.preventDefault()}>
          <button type="button" className="primary small" onClick={() => add(false)}>🖍 {L("להדגיש", "Highlight")}</button>
          <button type="button" className="small" onClick={() => add(true)}>📝 {L("עם הערה", "With a note")}</button>
        </div>
      )}
      <aside className="study-hl-list">
        <b className="small">🖍 {L(`ההדגשות שלי (${hs.length})`, `My highlights (${hs.length})`)}</b>
        {!hs.length && <p className="muted small">{L("מסמני טקסט בהרצאה ולוחצים \"להדגיש\". כל הדגשה נשמרת עם העמוד שלה.", "Select text in the lecture and press \"Highlight\". Each keeps its page.")}</p>}
        {hs.map((h) => (
          <div key={h.id} className="study-hl-item">
            <span className="small" dir="auto">{h.page ? <span className="muted">{L(`עמ׳ ${h.page}`, `p. ${h.page}`)} · </span> : null}{h.text.length > 160 ? `${h.text.slice(0, 158)}…` : h.text}{h.carded ? " ✓" : ""}</span>
            {noteFor === h.id ? (
              <form className="row" onSubmit={(e) => { e.preventDefault(); save(hs.map((x) => (x.id === h.id ? { ...x, ...(note.trim() ? { note: note.trim() } : {}) } : x))); setNoteFor(null); }}>
                <input dir="auto" autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder={L("ההערה שלך", "Your note")} aria-label={L("הערה", "Note")} />
                <button type="submit" className="small">{L("שמירה", "Save")}</button>
              </form>
            ) : h.note ? <span className="muted small" dir="auto">{L("הערה", "Note")}: {h.note}</span> : null}
            <span className="row">
              {noteFor !== h.id && <button type="button" className="link small" onClick={() => { setNoteFor(h.id); setNote(h.note ?? ""); }}>{h.note ? L("לערוך הערה", "Edit note") : L("להוסיף הערה", "Add a note")}</button>}
              <button type="button" className="link small" onClick={() => save(hs.filter((x) => x.id !== h.id))}>{L("להסיר", "Remove")}</button>
            </span>
          </div>
        ))}
        {fresh > 0 && <button type="button" className="primary" disabled={busy} onClick={() => void toCards()}>{busy ? L("יוצר כרטיסיות…", "Making cards…") : L(`להפוך ${fresh} הדגשות לכרטיסיות`, `Make ${fresh} highlights into cards`)}</button>}
      </aside>
    </div>
  );
}
