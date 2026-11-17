import { useEffect, useState } from "react";
import { apaCite, apaRef, chicagoCite, chicagoRef, toBibtex, toRis, type StudySource } from "@kesher/shared";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

function save(text: string, name: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const copy = (t: string) => void navigator.clipboard?.writeText(t).then(() => toast(L("הועתק", "Copied")), () => toast(L("ההעתקה לא הצליחה", "Copying failed")));
const byline = (p: StudySource) => [p.authors.slice(0, 3).join(", ") + (p.authors.length > 3 ? " et al." : ""), p.year, p.venue].filter(Boolean).join(" · ");

/**
 * Papers and the course's sources library (design Papers, students part 28 #6, like Semantic Scholar, Consensus and
 * Zotero): search real papers (OpenAlex) or paste a DOI, "what do the studies say" from their abstracts with numbered
 * links, save to the course, and every saved source as an APA 7 reference, an in-text citation, BibTeX and RIS.
 */
export function StudyPapers({ courseId, courseName }: { courseId: string; courseName: string }) {
  const [style, setStyle] = useState<"apa" | "chicago">(() => { try { return localStorage.getItem("kesher-cite-style") === "chicago" ? "chicago" : "apa"; } catch { return "apa"; } });
  const [q, setQ] = useState("");
  const [found, setFound] = useState<StudySource[] | null>(null);
  const [asked, setAsked] = useState("");
  const [busy, setBusy] = useState("");
  const [say, setSay] = useState("");
  const [lib, setLib] = useState<StudySource[]>([]);
  useEffect(() => void api<{ sources: StudySource[] }>(`/api/study/courses/${courseId}/sources`).then((r) => setLib(r.sources), (e: Error) => toast(e.message)), [courseId]);
  const search = async () => {
    const t = q.trim();
    if (!t) return;
    setBusy("search");
    setSay("");
    try {
      setFound((await api<{ papers: StudySource[] }>(`/api/study/courses/${courseId}/papers?q=${encodeURIComponent(t)}`)).papers);
      setAsked(t);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const studiesSay = async () => {
    setBusy("say");
    try {
      setSay((await api<{ text: string }>(`/api/study/courses/${courseId}/papers/say`, { method: "POST", body: { question: asked, papers: (found ?? []).filter((p) => p.abstract).slice(0, 10) } })).text);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const keep = async (p: StudySource) => {
    try {
      setLib((await api<{ sources: StudySource[] }>(`/api/study/courses/${courseId}/sources`, { method: "POST", body: { source: p } })).sources);
      toast(L("נשמר במקורות של הקורס", "Saved to the course's sources"));
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const drop = async (id: string) => setLib((await api<{ sources: StudySource[] }>(`/api/study/courses/${courseId}/sources/${id}`, { method: "DELETE" }).catch((e: Error) => { toast(e.message); return { sources: lib }; })).sources);
  const saved = (p: StudySource) => lib.some((s) => (p.doi && s.doi?.toLowerCase() === p.doi.toLowerCase()) || s.title.toLowerCase() === p.title.toLowerCase());
  // "What the studies say" numbers only the papers with an abstract, in this order.
  const withAbstract = (found ?? []).filter((p) => p.abstract).slice(0, 10);
  const file = courseName.replace(/[\\/:*?"<>|]+/g, "").slice(0, 60) || "sources";
  const ref = style === "chicago" ? chicagoRef : apaRef;
  const cite = style === "chicago" ? chicagoCite : apaCite;
  const sorted = [...lib].sort((a, b) => ref(a).localeCompare(ref(b)));
  /** A BibTeX or RIS file from Zotero, Mendeley or EndNote: its sources join the course's. */
  const importFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const r = await api<{ sources: StudySource[]; added: number; found: number }>(`/api/study/courses/${courseId}/sources/import`, { method: "POST", body: { text: await f.text() } });
      setLib(r.sources);
      toast(L(`נוספו ${r.added} מקורות (מתוך ${r.found} בקובץ)`, `${r.added} sources added (of ${r.found} in the file)`));
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <div className="study-papers">
      <section className="card study-papers-find">
        <h2>🔎 {L("חיפוש מאמרים", "Find papers")}</h2>
        <form className="row study-papers-search" onSubmit={(e) => { e.preventDefault(); void search(); }}>
          <input type="search" dir="auto" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L("נושא או שאלה באנגלית, או DOI", "A topic or question, or a DOI")} aria-label={L("חיפוש מאמרים", "Find papers")} />
          <button type="submit" className="primary" disabled={!q.trim() || busy === "search"}>{busy === "search" ? "…" : L("חיפוש", "Search")}</button>
        </form>
        <p className="muted small">{L("מאמרים אמיתיים מ-OpenAlex (מאגר פתוח של מאות מיליוני מאמרים). רק מילות החיפוש יוצאות מהמחשב. רוב המאמרים באנגלית, אז כדאי לחפש באנגלית.", "Real papers from OpenAlex (an open index of hundreds of millions of papers). Only the search words leave the computer.")}</p>
        {found && !found.length && <p className="muted">{L("לא נמצאו מאמרים. נסי מילים אחרות, או באנגלית.", "No papers found. Try other words.")}</p>}
        {found && withAbstract.length > 1 && (
          <div className="study-papers-say">
            <button type="button" disabled={busy === "say"} onClick={() => void studiesSay()}>{busy === "say" ? L("קורא את התקצירים…", "Reading the abstracts…") : L("💡 מה המחקרים אומרים?", "💡 What do the studies say?")}</button>
            {say && <p dir="auto" className="study-papers-answer">{say}</p>}
            {say && <p className="muted small">{L("מבוסס רק על התקצירים של המאמרים הממוספרים כאן. כדאי לפתוח את המאמר לפני שמצטטים.", "Based only on the abstracts of the numbered papers here. Open the paper before citing it.")}</p>}
          </div>
        )}
        {found && found.length > 0 && (
          <ol className="study-papers-list">
            {found.map((p) => {
              const n = withAbstract.indexOf(p);
              return (
                <li key={p.id}>
                  <div className="study-paper-head">
                    {n >= 0 && say ? <span className="study-paper-n">[{n + 1}]</span> : null}
                    {p.url ? <a href={p.url} target="_blank" rel="noopener noreferrer" dir="auto"><b>{p.title}</b></a> : <b dir="auto">{p.title}</b>}
                  </div>
                  <span className="muted small" dir="auto">{byline(p)}{p.cited ? L(` · צוטט ${p.cited} פעמים`, ` · cited ${p.cited} times`) : ""}</span>
                  {p.abstract && <details><summary className="small">{L("תקציר", "Abstract")}</summary><p dir="auto" className="small">{p.abstract}</p></details>}
                  <div className="row study-paper-actions">
                    <button type="button" className="small" disabled={saved(p)} onClick={() => void keep(p)}>{saved(p) ? L("✓ במקורות", "✓ In sources") : L("שמירה למקורות", "Save to sources")}</button>
                    {p.pdf && <a className="button small" href={p.pdf} target="_blank" rel="noopener noreferrer">{L("PDF חינמי ↗", "Free PDF ↗")}</a>}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section className="card study-papers-lib">
        <h2>📚 {L(`המקורות של הקורס (${lib.length})`, `The course's sources (${lib.length})`)}</h2>
        <div className="row study-paper-actions">
          <label className="button small">
            📥 {L("ייבוא מ-Zotero / Mendeley (BibTeX או RIS)", "Import from Zotero / Mendeley (BibTeX or RIS)")}
            <input type="file" accept=".bib,.ris,.txt,text/plain" hidden onChange={(e) => { void importFile(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
          <select value={style} onChange={(e) => { const v = e.target.value === "chicago" ? "chicago" : "apa"; setStyle(v); try { localStorage.setItem("kesher-cite-style", v); } catch { /* a convenience */ } }} aria-label={L("סגנון ציטוט", "Citation style")}>
            <option value="apa">APA 7</option>
            <option value="chicago">Chicago</option>
          </select>
        </div>
        {!lib.length ? <p className="muted small">{L("מאמרים ששומרים מהחיפוש מגיעים לכאן, עם הפניה מוכנה ב-APA 7 או Chicago.", "Papers you save from the search come here, with an APA 7 or Chicago reference ready.")}</p> : (
          <>
            <div className="row study-paper-actions">
              <button type="button" className="small" onClick={() => copy(sorted.map(ref).join("\n"))}>{L(`העתקת רשימת המקורות (${style === "chicago" ? "Chicago" : "APA"})`, `Copy the reference list (${style === "chicago" ? "Chicago" : "APA"})`)}</button>
              <button type="button" className="small" onClick={() => save(toBibtex(sorted), `${file}.bib`, "application/x-bibtex;charset=utf-8")}>BibTeX</button>
              <button type="button" className="small" onClick={() => save(toRis(sorted), `${file}.ris`, "application/x-research-info-systems;charset=utf-8")}>RIS</button>
            </div>
            <p className="muted small">{L("את BibTeX ו-RIS אפשר לייבא ל-Zotero, ל-Mendeley או ל-EndNote.", "BibTeX and RIS import into Zotero, Mendeley or EndNote.")}</p>
            <ul className="study-papers-refs">
              {sorted.map((s) => (
                <li key={s.id}>
                  <p dir="ltr" className="study-paper-ref">{ref(s)}</p>
                  <div className="row study-paper-actions">
                    <button type="button" className="small" onClick={() => copy(ref(s))}>{L("העתקת ההפניה", "Copy the reference")}</button>
                    <button type="button" className="small" onClick={() => copy(cite(s))} title={L("הציטוט בתוך הטקסט", "The in-text citation")}>{cite(s)}</button>
                    {s.pdf && <a className="button small" href={s.pdf} target="_blank" rel="noopener noreferrer">PDF ↗</a>}
                    <button type="button" className="ghost small" aria-label={L("להסיר מהמקורות", "Remove from sources")} onClick={() => void drop(s.id)}>✕</button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
