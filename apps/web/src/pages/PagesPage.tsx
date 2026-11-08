import { useEffect, useRef, useState } from "react";
import { api, withToken } from "../api";
import { getLocale } from "../i18n";
import { RichText } from "../RichText";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface PageInfo { id: string; title: string; updatedAt: string; words: number }
interface Page extends PageInfo { content: string }

const ACTIONS: Array<[string, string, string]> = [
  ["rewrite", "שכתב", "Rewrite"],
  ["shorter", "קצר", "Shorter"],
  ["longer", "הרחב", "Longer"],
  ["fix", "תקן שגיאות", "Fix mistakes"],
  ["formal", "רשמי יותר", "More formal"],
  ["simple", "פשוט יותר", "Simpler"],
  ["translate", "תרגם", "Translate"],
];

/**
 * Pages: documents written together with the agent. Write in Markdown with
 * a live preview; select text and press a button (rewrite, shorter, …) or
 * ask in words; with nothing selected, the agent writes where the cursor is.
 */
export function PagesPage({ id }: { id?: string }) {
  const [list, setList] = useState<PageInfo[]>([]);
  const [page, setPage] = useState<Page | null>(null);
  const [ask, setAsk] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(true);
  const [undo, setUndo] = useState<string[]>([]);
  const [preview, setPreview] = useState(true);
  const area = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const loadList = () => void api<PageInfo[]>("/api/pages").then(setList, () => undefined);
  useEffect(loadList, []);
  useEffect(() => {
    if (!id) return setPage(null);
    void api<Page>(`/api/pages/${id}`).then(setPage, (e: Error) => toast(e.message));
    setUndo([]);
  }, [id]);

  const save = (next: Page) => {
    setPage(next);
    setSaved(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void api(`/api/pages/${next.id}`, { method: "PUT", body: { title: next.title, content: next.content } }).then(() => {
        setSaved(true);
        loadList();
      }, (e: Error) => toast(e.message));
    }, 700);
  };
  const create = async () => {
    const p = await api<Page>("/api/pages", { method: "POST", body: { title: L("מסמך חדש", "New page") } });
    loadList();
    location.hash = `#/pages/${p.id}`;
  };
  const remove = async () => {
    if (!page || !confirm(L(`למחוק את "${page.title}"?`, `Delete "${page.title}"?`))) return;
    await api(`/api/pages/${page.id}`, { method: "DELETE" });
    loadList();
    location.hash = "#/pages";
  };

  /** Asks the agent: the answer replaces the selection, or goes where the cursor is. */
  const write = async (o: { action?: string; instruction?: string }) => {
    if (!page || !area.current) return;
    const { selectionStart: a, selectionEnd: b } = area.current;
    const selection = page.content.slice(a, b);
    if (o.action && !selection.trim()) return toast(L("קודם סמן טקסט במסמך.", "Select some text in the page first."));
    setBusy(true);
    try {
      const r = await api<{ text: string }>(`/api/pages/${page.id}/write`, { method: "POST", body: { ...o, ...(selection ? { selection } : {}), content: page.content } });
      setUndo((u) => [...u.slice(-29), page.content]);
      const before = page.content.slice(0, a);
      const glue = !selection && before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
      const content = `${before}${glue}${r.text}${page.content.slice(b)}`;
      save({ ...page, content });
      setAsk("");
      requestAnimationFrame(() => {
        const at = a + glue.length;
        area.current?.focus();
        area.current?.setSelectionRange(at, at + r.text.length);
      });
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const undoLast = () => {
    const prev = undo.at(-1);
    if (!page || prev === undefined) return;
    setUndo((u) => u.slice(0, -1));
    save({ ...page, content: prev });
  };

  return (
    <div className="pages-page">
      <aside className="pages-list">
        <button type="button" className="primary" onClick={() => void create()}>+ {L("מסמך חדש", "New page")}</button>
        {list.map((p) => (
          <a key={p.id} href={`#/pages/${p.id}`} className={`pages-item${p.id === id ? " on" : ""}`}>
            <span dir="auto">{p.title}</span>
            <span className="muted small">{L(`${p.words} מילים`, `${p.words} words`)}</span>
          </a>
        ))}
        {!list.length && <p className="muted small">{L("עוד אין מסמכים.", "No pages yet.")}</p>}
      </aside>
      {page ? (
        <section className="pages-editor">
          <div className="row pages-head">
            <input className="pages-title grow" dir="auto" value={page.title} onChange={(e) => save({ ...page, title: e.target.value })} aria-label={L("כותרת", "Title")} />
            <span className="muted small">{saved ? L("נשמר", "Saved") : L("שומר…", "Saving…")}</span>
            <button type="button" onClick={() => setPreview(!preview)}>{preview ? L("הסתר תצוגה", "Hide preview") : L("תצוגה", "Preview")}</button>
            <a className="button" href={withToken(`/api/pages/${page.id}/export?format=md`)} download>Markdown</a>
            <button type="button" onClick={() => window.open(withToken(`/api/pages/${page.id}/export?format=html&print=1`), "_blank", "noopener")}>PDF</button>
            <button type="button" className="danger" onClick={() => void remove()}>{L("מחק", "Delete")}</button>
          </div>
          <div className="row pages-tools">
            {ACTIONS.map(([k, he, en]) => <button key={k} type="button" disabled={busy} onClick={() => void write({ action: k })}>{L(he, en)}</button>)}
            <button type="button" disabled={busy || !undo.length} onClick={undoLast}>↶ {L("בטל", "Undo")}</button>
          </div>
          <form className="row pages-ask" onSubmit={(e) => { e.preventDefault(); if (ask.trim()) void write({ instruction: ask }); }}>
            <input className="grow" dir="auto" value={ask} onChange={(e) => setAsk(e.target.value)} placeholder={L("בקש מהסוכן: \"כתוב פרק על…\", או סמן טקסט ותגיד מה לשנות", "Ask the agent: \"write a section about…\", or select text and say what to change")} />
            <button type="submit" className="primary" disabled={busy || !ask.trim()}>{busy ? L("כותב…", "Writing…") : L("כתוב", "Write")}</button>
          </form>
          <div className={`pages-body${preview ? " split" : ""}`}>
            <textarea ref={area} dir="auto" value={page.content} onChange={(e) => save({ ...page, content: e.target.value })} placeholder={L("כתוב כאן (Markdown: # כותרת, - רשימה, **מודגש**)…", "Write here (Markdown: # heading, - list, **bold**)…")} />
            {preview && <div className="pages-preview" dir="auto"><RichText text={page.content || L("_התצוגה תופיע כאן_", "_The preview shows here_")} /></div>}
          </div>
        </section>
      ) : (
        <section className="pages-editor pages-empty">
          <h1>{L("מסמכים", "Pages")}</h1>
          <p className="muted">{L("מסמכים שכותבים יחד עם הסוכן: כותבים, מסמנים קטע ומבקשים לשכתב, לקצר או להרחיב, או מבקשים ממנו לכתוב פרק חדש. הכל נשמר במחשב שלך.", "Documents you write with the agent: write, select a part and ask to rewrite, shorten or expand it, or ask it to write a new section. Everything stays on your computer.")}</p>
          <div className="row"><button type="button" className="primary" onClick={() => void create()}>+ {L("מסמך חדש", "New page")}</button></div>
        </section>
      )}
    </div>
  );
}
