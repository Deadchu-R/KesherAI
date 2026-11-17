import { useCallback, useEffect, useRef, useState } from "react";
import { strToU8, zipSync } from "fflate";
import { docxFiles } from "@kesher/shared";
import { api, withToken } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";
import { ImportFile } from "../ImportFile";
import { RichText } from "../RichText";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

interface Doc { id: string; title: string; body: string; convId?: string; rev: number; updatedAt: string; versions?: Array<{ rev: number; at: string }> }

/** Markdown split into blocks: blank-line separated, a code fence kept whole. */
export function toBlocks(body: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let fence = false;
  for (const line of body.replace(/\r/g, "").split("\n")) {
    if (/^```/.test(line)) fence = !fence;
    if (!fence && !line.trim() && !/^```/.test(line)) {
      if (cur.length) out.push(cur.join("\n"));
      cur = [];
    } else cur.push(line);
  }
  if (cur.length) out.push(cur.join("\n"));
  return out;
}

const NEW_BLOCKS: Array<[string, string, string]> = [
  ["", "פסקה", "Paragraph"],
  ["## ", "כותרת", "Heading"],
  ["- ", "רשימה", "List"],
  ["1. ", "רשימה ממוספרת", "Numbered list"],
  ["> ", "ציטוט", "Quote"],
  ["| | |\n|---|---|\n| | |", "טבלה", "Table"],
  ["```\n\n```", "קוד", "Code"],
];

/** Zips Office files and saves them (Word or Excel, optional: KesherAI keeps its own format). */
function saveOffice(files: Record<string, string>, name: string, mime: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** The writing buttons on the block being edited (its selected text, or the whole block). */
const WRITE_ACTIONS: Array<[string, string, string]> = [
  ["rewrite", "לנסח מחדש", "Rewrite"],
  ["shorter", "לקצר", "Shorter"],
  ["longer", "להרחיב", "Longer"],
  ["fix", "לתקן שגיאות", "Fix mistakes"],
  ["simple", "בשפה פשוטה", "Simpler"],
  ["translate", "לתרגם", "Translate"],
];

/** The document as a PDF through the system's "Save as PDF" (no Word needed): the page as it is drawn. */
function printDoc(title: string, html: string) {
  const he = /[֐-׿]/.test(title);
  const frame = document.createElement("iframe");
  // No scripts run in the print copy (the document's text is hers or the model's).
  frame.setAttribute("sandbox", "allow-same-origin allow-modals");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;opacity:0";
  frame.srcdoc = `<!doctype html><html dir="${he ? "rtl" : "ltr"}"><head><meta charset="utf-8"><title>${title.replace(/</g, "&lt;")}</title><style>@page{size:A4;margin:18mm}body{font-family:Heebo,Arial,sans-serif;font-size:12pt;line-height:1.7;color:#1d1d22}h1,h2,h3{line-height:1.3}table{border-collapse:collapse}td,th{border:1px solid #bbb;padding:4px 8px}blockquote{border-inline-start:3px solid #3d5afe;margin:0;padding-inline-start:12px;color:#555}pre{background:#f3f3f6;padding:8px;white-space:pre-wrap}button,svg{display:none}</style></head><body><h1>${title.replace(/</g, "&lt;")}</h1>${html}</body></html>`;
  frame.onload = () => {
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 60_000);
  };
  document.body.appendChild(frame);
}

/**
 * KesherAI's own documents (#/docs and #/docs/<id>, design DocEditor): the list, and the editor: each block shows as
 * it will read, and a click turns it into its Markdown to edit; a "+" adds a heading, list, quote, table or code.
 * The model's edits from the chat appear live. Saved as Markdown; PDF, Markdown and copy-for-Word/Google Docs out.
 */
export function DocsPage({ id }: { id?: string }) {
  if (!id) return <DocList />;
  return <DocEditor key={id} id={id} />;
}

function DocList() {
  const [docs, setDocs] = useState<Array<{ id: string; title: string; words: number; updatedAt: string }> | null>(null);
  useEffect(() => void api<{ docs: NonNullable<typeof docs> }>("/api/docs").then((r) => setDocs(r.docs), (e: Error) => toast(e.message)), []);
  const create = async () => {
    const d = await api<Doc>("/api/docs", { method: "POST", body: { title: L("מסמך חדש", "New document"), body: "" } });
    location.hash = `#/docs/${d.id}`;
  };
  return (
    <main className="page slides-page">
      <header className="page-head row">
        <h1>📝 {L("מסמכים", "Documents")}</h1>
        <span className="grow" />
        <ImportFile accept=".docx,.pdf,.md,.txt" label={L("ייבוא Word / PDF", "Import Word / PDF")} />
        <button type="button" className="primary" onClick={() => void create()}>＋ {L("מסמך חדש", "New document")}</button>
      </header>
      <p className="muted">{L("מסמכים שנשמרים ב-KesherAI: כותבים, עורכים ומורידים כ-PDF, בלי Word. אפשר גם לבקש מהצ'אט \"תכתוב לי מסמך על…\".", "Documents kept in KesherAI: write, edit and save as PDF, no Word needed. You can also ask a chat to \"write a document about…\".")}</p>
      {!docs ? <p className="muted">…</p> : !docs.length ? <p className="muted">{L("עוד אין מסמכים.", "No documents yet.")}</p> : (
        <ul className="slides-list">{docs.map((d) => <li key={d.id}><a href={`#/docs/${d.id}`} className="card"><b dir="auto">{d.title}</b><span className="muted small">{L(`${d.words} מילים`, `${d.words} words`)} · {new Date(d.updatedAt).toLocaleDateString(getLocale() === "he" ? "he-IL" : "en-GB")}</span></a></li>)}</ul>
      )}
    </main>
  );
}

function DocEditor({ id }: { id: string }) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState<"" | "saving" | "saved">("");
  const [ask, setAsk] = useState("");
  const [addAt, setAddAt] = useState<number | null>(null);
  const [writing, setWriting] = useState(false);
  const pending = useRef<Doc | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const rev = useRef(-1);
  const timer = useRef(0);
  const view = useRef<HTMLDivElement>(null);
  rev.current = doc?.rev ?? -1;
  const load = useCallback(() => void api<Doc>(`/api/docs/${id}`).then((d) => { if (!pending.current) setDoc(d); }, (e: Error) => toast(e.message)), [id]);
  useEffect(load, [load]);
  useEffect(() => {
    const es = new EventSource(withToken(`/api/docs/${id}/events`));
    es.onmessage = (e) => {
      const m = JSON.parse(e.data as string) as { rev?: number };
      if (typeof m.rev === "number" && m.rev !== rev.current && !pending.current) load();
    };
    return () => es.close();
  }, [id, load]);
  const save = (next: Doc) => {
    setDoc(next);
    pending.current = next;
    setSaving("saving");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      const d = pending.current;
      if (!d) return;
      try {
        const saved = await api<Doc>(`/api/docs/${id}`, { method: "PUT", body: { title: d.title, body: d.body, rev: d.rev } });
        pending.current = null;
        setDoc((cur) => (cur ? { ...cur, rev: saved.rev, versions: saved.versions } : saved));
        setSaving("saved");
      } catch {
        pending.current = null;
        toast(L("המסמך השתנה בינתיים (למשל מהצ'אט). טוען את החדש, ואפשר לערוך שוב.", "The document changed meanwhile (from the chat, say). Loading the new one; edit again."));
        load();
      }
    }, 800);
  };
  if (!doc) return <main className="page"><p className="muted">…</p></main>;
  const blocks = toBlocks(doc.body);
  const setBlocks = (b: string[]) => save({ ...doc, body: b.filter((x) => x.trim()).join("\n\n") });
  const commit = () => {
    if (editing === null) return;
    const b = [...blocks];
    if (editing >= b.length) b.push(draft);
    else b[editing] = draft;
    setBlocks(b);
    setEditing(null);
  };
  const open = (i: number, text: string) => {
    if (editing !== null) commit();
    setEditing(i);
    setDraft(text);
  };
  const insert = (i: number, text: string) => {
    const b = [...blocks];
    b.splice(i, 0, text || " ");
    setDoc({ ...doc, body: b.join("\n\n") });
    setAddAt(null);
    setEditing(i);
    setDraft(text);
  };
  /** A writing button: the model changes the selected text of the block being edited (or all of it). */
  const writeWith = async (action: string) => {
    const t = editor.current;
    if (!t || writing) return;
    const [a, b] = t.selectionStart !== t.selectionEnd ? [t.selectionStart, t.selectionEnd] : [0, draft.length];
    const selection = draft.slice(a, b);
    if (!selection.trim()) return;
    setWriting(true);
    try {
      const r = await api<{ text: string }>(`/api/docs/${id}/write`, { method: "POST", body: { action, selection, content: doc.body } });
      setDraft((d) => `${d.slice(0, a)}${r.text}${d.slice(b)}`);
      requestAnimationFrame(() => {
        t.focus();
        t.setSelectionRange(a, a + r.text.length);
      });
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setWriting(false);
    }
  };
  const askAi = async () => {
    if (!ask.trim()) return;
    try {
      const conv = doc.convId ?? (await api<{ id: string }>("/api/conversations", { method: "POST", body: { kind: "chat" } })).id;
      await api(`/api/conversations/${conv}/messages`, { method: "POST", body: { text: `${L("במסמך", "In the document")} "${doc.title}" (#/docs/${doc.id}): ${ask.trim()}\n${L("השתמש בכלי document עם", "Use the document tool with")} id "${doc.id}" (${L("קודם read", "read first")}).` } });
      setAsk("");
      toast(L("נשלח לצ'אט. השינוי יופיע כאן כשיסתיים.", "Sent to the chat. The change appears here when it is done."));
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const download = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([`# ${doc.title}\n\n${doc.body}\n`], { type: "text/markdown" }));
    a.download = `${doc.title.replace(/[\\/:*?"<>|]+/g, "").slice(0, 80) || "document"}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };
  const copyRich = async () => {
    const html = view.current?.innerHTML ?? "";
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([`<h1>${doc.title.replace(/</g, "&lt;")}</h1>${html}`], { type: "text/html" }), "text/plain": new Blob([doc.body], { type: "text/plain" }) })]);
      toast(L("הועתק: אפשר להדביק ב-Word או ב-Google Docs עם העיצוב", "Copied: paste into Word or Google Docs with its formatting"));
    } catch {
      await navigator.clipboard.writeText(doc.body);
      toast(L("הועתק כטקסט", "Copied as text"));
    }
  };
  return (
    <main className="page docs-editor">
      <div className="slides-bar">
        <a href="#/docs" className="link">‹</a>
        <input className="docs-title" dir="auto" value={doc.title} onChange={(e) => save({ ...doc, title: e.target.value })} aria-label={L("שם המסמך", "Document name")} />
        <span className="muted small">{saving === "saving" ? L("שומר…", "Saving…") : saving === "saved" ? L("נשמר", "Saved") : ""}</span>
        {!!doc.versions?.length && (
          <select aria-label={L("גרסאות", "Versions")} value="" onChange={(e) => e.target.value && void api<Doc>(`/api/docs/${id}/restore`, { method: "POST", body: { rev: Number(e.target.value) } }).then(setDoc, (er: Error) => toast(er.message))}>
            <option value="">{L(`גרסה ${doc.rev}`, `Version ${doc.rev}`)} ▾</option>
            {[...doc.versions].reverse().map((v) => <option key={v.rev} value={v.rev}>{L("לחזור לגרסה", "Back to version")} {v.rev} · {new Date(v.at).toLocaleTimeString(getLocale() === "he" ? "he-IL" : "en-GB", { hour: "2-digit", minute: "2-digit" })}</option>)}
          </select>
        )}
        <span className="grow" />
        <button type="button" onClick={() => printDoc(doc.title, view.current?.innerHTML ?? "")}>⬇ PDF</button>
        <button type="button" onClick={download}>Markdown</button>
        <button type="button" onClick={() => saveOffice(docxFiles(doc.title, doc.body), `${doc.title.replace(/[\\/:*?"<>|]+/g, "").slice(0, 80) || "document"}.docx`, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")}>Word</button>
        <button type="button" className="link small" onClick={() => void copyRich()}>{L("העתקה ל-Word / Google Docs", "Copy for Word / Google Docs")}</button>
      </div>
      <article className="docs-page" ref={view}>
        {blocks.map((b, i) => (editing === i ? (
          <div key={i} className="docs-editing">
            <textarea ref={editor} className="docs-block-edit" dir="auto" autoFocus value={draft} readOnly={writing} rows={Math.max(2, draft.split("\n").length + 1)} onChange={(e) => setDraft(e.target.value)} onBlur={() => !writing && commit()} onKeyDown={(e) => { if (e.key === "Escape") commit(); }} />
            <div className="docs-write" onMouseDown={(e) => e.preventDefault()}>
              {writing ? <span className="muted small">✨ {L("כותב…", "Writing…")}</span> : WRITE_ACTIONS.map(([k, he, en]) => <button key={k} type="button" className="ghost small" onClick={() => void writeWith(k)}>{L(he, en)}</button>)}
            </div>
          </div>
        ) : (
          <div key={i} className="docs-block" role="button" tabIndex={0} onClick={() => open(i, b)} onKeyDown={(e) => e.key === "Enter" && open(i, b)}>
            <RichText text={b} />
          </div>
        )))}
        {editing !== null && editing >= blocks.length && <textarea className="docs-block-edit" dir="auto" autoFocus value={draft} rows={3} onChange={(e) => setDraft(e.target.value)} onBlur={commit} />}
        {!blocks.length && editing === null && <p className="muted docs-empty" onClick={() => open(0, "")}>{L("לחצי כאן ותתחילי לכתוב…", "Click here and start writing…")}</p>}
        <div className="docs-add">
          <button type="button" className="ghost" onClick={() => setAddAt(addAt === null ? blocks.length : null)}>＋</button>
          {addAt !== null && NEW_BLOCKS.map(([t, he, en]) => <button key={he} type="button" className="ghost small" onClick={() => insert(addAt, t)}>{L(he, en)}</button>)}
        </div>
      </article>
      <form className="slides-ask row" onSubmit={(e) => { e.preventDefault(); void askAi(); }}>
        <input dir="auto" value={ask} onChange={(e) => setAsk(e.target.value)} placeholder={`✨ ${L("לבקש מהמודל: \"תקצר את הסעיף על…\", \"תוסיף טבלת השוואה\"", "Ask the model: \"shorten the part on…\", \"add a comparison table\"")}`} />
        <button type="submit" disabled={!ask.trim()}>{L("שליחה", "Send")}</button>
      </form>
    </main>
  );
}
