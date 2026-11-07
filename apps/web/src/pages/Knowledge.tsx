import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale } from "../i18n";
import { desktop, toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Base { id: string; name: string; description?: string; folders: string[]; urls: string[]; files: number; passages: number; indexing: boolean; indexedAt: string | null; error: string | null }
interface Hit { base: string; source: string; page: number; text: string; score: number }

const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

/** One base: its folders and pages, editable. */
function BaseForm({ base, onDone }: { base?: Base; onDone: () => void }) {
  const [name, setName] = useState(base?.name ?? "");
  const [description, setDescription] = useState(base?.description ?? "");
  const [folders, setFolders] = useState((base?.folders ?? []).join("\n"));
  const [urls, setUrls] = useState((base?.urls ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api("/api/knowledge", { method: "POST", body: { ...(base ? { id: base.id } : {}), name, description, folders: lines(folders), urls: lines(urls) } });
      onDone();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card kb-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label>{L("שם", "Name")}<input value={name} onChange={(e) => setName(e.target.value)} placeholder={L("למשל: מסמכי העבודה", "e.g. Work documents")} autoFocus /></label>
      <label>{L("על מה זה (עוזר למודל לדעת מתי לחפש כאן)", "What it's about (helps the model know when to look here)")}<input value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      <label>
        {L("תיקיות, אחת בכל שורה", "Folders, one per line")}
        <textarea dir="ltr" rows={3} value={folders} onChange={(e) => setFolders(e.target.value)} placeholder="C:\\Users\\me\\Documents\\Handbook" />
      </label>
      {desktop() && (
        <div className="row">
          <button type="button" onClick={() => void desktop()!.pickFolder().then((f) => f && setFolders((v) => (v.trim() ? `${v.trim()}\n${f}` : f)))}>{L("הוסף תיקייה…", "Add folder…")}</button>
        </div>
      )}
      <label>
        {L("דפי אינטרנט, אחד בכל שורה (נטענים מחדש פעם ביום)", "Web pages, one per line (fetched again daily)")}
        <textarea dir="ltr" rows={3} value={urls} onChange={(e) => setUrls(e.target.value)} placeholder="https://docs.unity3d.com/Manual/index.html" />
      </label>
      <p className="muted small">{L("PDF, Word, Markdown, טקסט, HTML, CSV וקוד. תיקיות כמו node_modules ו-Library מדולגות. המסמכים נשארים במחשב.", "PDF, Word, Markdown, text, HTML, CSV and code. Folders like node_modules and Library are skipped. Your documents stay on this computer.")}</p>
      <div className="row">
        <button type="submit" className="primary" disabled={busy || !name.trim() || (!lines(folders).length && !lines(urls).length)}>{base ? L("שמור", "Save") : L("צור ואנדקס", "Create and index")}</button>
        <button type="button" onClick={onDone}>{L("ביטול", "Cancel")}</button>
      </div>
    </form>
  );
}

/**
 * Knowledge: the user's folders and web pages, kept indexed, which every
 * chat and agent can search (`search_knowledge`) and cite.
 */
export function KnowledgePage() {
  const [bases, setBases] = useState<Base[] | null>(null);
  const [editing, setEditing] = useState<Base | "new" | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const load = () => api<{ bases: Base[] }>("/api/knowledge").then((r) => setBases(r.bases), (e: Error) => toast(e.message));
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, []);
  const search = async () => {
    if (!query.trim()) return;
    try {
      setHits((await api<{ hits: Hit[] }>("/api/knowledge/search", { method: "POST", body: { query } })).hits);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const remove = async (b: Base) => {
    if (!confirm(L(`למחוק את "${b.name}"? המסמכים עצמם לא יימחקו.`, `Delete "${b.name}"? Your documents are not deleted.`))) return;
    await api(`/api/knowledge/${b.id}`, { method: "DELETE" }).catch((e: Error) => toast(e.message));
    void load();
  };
  const reindex = async (b: Base) => {
    await api(`/api/knowledge/${b.id}/reindex`, { method: "POST" }).catch((e: Error) => toast(e.message));
    void load();
  };
  return (
    <div className="page knowledge">
      <div className="page-head">
        <h1>{L("ידע", "Knowledge")}</h1>
        <p className="muted">{L("תיקיות ודפי אינטרנט שכל צ׳אט וסוכן יכולים לחפש בהם ולענות מהם, עם מקור לכל עובדה. האינדקס מתעדכן לבד כשקבצים משתנים.", "Folders and web pages every chat and agent can search and answer from, citing the source of each fact. The index updates itself when files change.")}</p>
      </div>
      {editing ? (
        <BaseForm base={editing === "new" ? undefined : editing} onDone={() => { setEditing(null); void load(); }} />
      ) : (
        <div className="row"><button type="button" className="primary" onClick={() => setEditing("new")}>{L("+ מאגר ידע חדש", "+ New knowledge base")}</button></div>
      )}
      {bases && !bases.length && !editing && <p className="muted">{L("עוד אין מאגרים. צרו אחד מתיקיית מסמכים — אחר כך פשוט שאלו בצ׳אט.", "No knowledge bases yet. Make one from a folder of documents, then just ask in any chat.")}</p>}
      {bases?.map((b) => (
        <section key={b.id} className="card kb-base">
          <div className="row">
            <strong>{b.name}</strong>
            <span className="muted small">
              {b.indexing ? L("מאנדקס…", "Indexing…") : L(`${b.files === 1 ? "קובץ אחד" : `${b.files} קבצים`} · ${b.passages} קטעים`, `${b.files} files · ${b.passages} passages`)}
              {b.indexedAt && !b.indexing ? ` · ${new Date(b.indexedAt).toLocaleTimeString(getLocale() === "he" ? "he-IL" : undefined, { hour: "2-digit", minute: "2-digit" })}` : ""}
            </span>
            <span className="grow" />
            <button type="button" onClick={() => void reindex(b)} disabled={b.indexing}>{L("אנדקס מחדש", "Re-index")}</button>
            <button type="button" onClick={() => setEditing(b)}>{L("עריכה", "Edit")}</button>
            <button type="button" onClick={() => void remove(b)}>{L("מחיקה", "Delete")}</button>
          </div>
          {b.description && <p className="muted small">{b.description}</p>}
          <ul className="kb-sources" dir="ltr">
            {[...b.folders, ...b.urls].map((s) => <li key={s}>{s}</li>)}
          </ul>
          {b.error && <p className="error small">{b.error}</p>}
        </section>
      ))}
      {!!bases?.length && (
        <section className="card">
          <form className="row" onSubmit={(e) => { e.preventDefault(); void search(); }}>
            <input className="grow" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={L("נסו חיפוש — כך המודל רואה את הידע שלכם", "Try a search — this is what the model sees")} />
            <button type="submit">{L("חיפוש", "Search")}</button>
          </form>
          {hits && !hits.length && <p className="muted">{L("לא נמצא. נסו מילים אחרות.", "Nothing found. Try other words.")}</p>}
          {hits?.map((h, i) => (
            <div key={i} className="kb-hit">
              <div className="muted small" dir="ltr">{h.source}{/^https?:/.test(h.source) ? "" : `, p. ${h.page}`} · {h.base}</div>
              <p dir="auto">{h.text.length > 500 ? `${h.text.slice(0, 500)}…` : h.text}</p>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
