import { useEffect, useState } from "react";
import type { StudyCard } from "@kesher/shared";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/**
 * Her hard cards (design HardCards, students part 30 #1, like Anki's leeches): cards she forgot three times or more,
 * each with a fix: simpler words, split into small cards, or a memory hook; the fixed card starts fresh.
 */
export function StudyLeeches({ courseId, onChange }: { courseId: string; onChange: () => void }) {
  const [list, setList] = useState<Array<{ card: StudyCard; lapses: number }>>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const load = () => void api<{ leeches: Array<{ card: StudyCard; lapses: number }> }>(`/api/study/courses/${courseId}/leeches`).then((r) => setList(r.leeches), () => setList([]));
  useEffect(load, [courseId]);
  if (!list.length) return null;
  const fix = async (cid: string, how: "simpler" | "split" | "hook") => {
    setBusy(`${cid}:${how}`);
    try {
      const r = await api<{ cards: StudyCard[] }>(`/api/study/courses/${courseId}/cards/${cid}/fix`, { method: "POST", body: { how } });
      toast(r.cards.length > 1 ? L(`הכרטיסייה פוצלה ל-${r.cards.length}`, `Split into ${r.cards.length} cards`) : L("הכרטיסייה תוקנה", "The card was fixed"));
      setList((l) => l.filter((x) => x.card.id !== cid));
      onChange();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <section className="card study-leeches">
      <button type="button" className="study-grades-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <b>🧱 {L(`${list.length} כרטיסיות קשות`, `${list.length} hard cards`)}</b>
        <span className="grow" />
        <span className="muted small">{L("נשכחו 3 פעמים ויותר", "forgotten 3 times or more")}</span>
        <span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <>
          <p className="muted small">{L("כרטיסייה שנשכחת שוב ושוב בדרך כלל שואלת יותר מדי בבת אחת, או מנוסחת קשה. אפשר לתקן אותה, והגרסה החדשה מתחילה מההתחלה.", "A card forgotten again and again usually asks too much at once or is worded hard. Fix it; the new version starts fresh.")}</p>
          {list.map(({ card, lapses }) => (
            <div key={card.id} className="study-leech">
              <b dir="auto">{card.front}</b>
              <span className="small" dir="auto">{card.back.slice(0, 300)}</span>
              <span className="muted small">{L(`נשכחה ${lapses} פעמים`, `forgotten ${lapses} times`)}</span>
              <div className="row study-paper-actions">
                <button type="button" className="small" disabled={!!busy} onClick={() => void fix(card.id, "simpler")}>{busy === `${card.id}:simpler` ? "…" : L("✏️ ניסוח פשוט יותר", "✏️ Simpler")}</button>
                <button type="button" className="small" disabled={!!busy} onClick={() => void fix(card.id, "split")}>{busy === `${card.id}:split` ? "…" : L("✂️ לפצל לקטנות", "✂️ Split")}</button>
                <button type="button" className="small" disabled={!!busy} onClick={() => void fix(card.id, "hook")}>{busy === `${card.id}:hook` ? "…" : L("🪝 להוסיף דרך לזכור", "🪝 Add a memory hook")}</button>
              </div>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
