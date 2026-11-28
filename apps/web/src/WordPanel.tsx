import { useCallback, useEffect, useState } from "react";
import { api, withToken } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";
import type { SurfaceCardProps, SurfacePanelProps } from "./surfaces";
import { ItemPanel } from "./DocPanel";
import { openSurface } from "./ArtifactPanel";
import { wordExportPath, wordFileName, wordSaveState } from "./word-file";
import "./word-panel.css";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** A KesherAI document as the panel reads it: its title, revision and the Word file it came from (the name is all that is shown). */
type WordDoc = { id: string; title: string; rev: number; source?: { path: string } };

/** Chat files already brought in, so opening the same file again shows the same document (and its unsaved edits). */
const imported = new Map<string, string>();

/**
 * A Word file in the message: its name, "Word file" and Open (the panel brings it in on the first open).
 *
 * @param props - `item` (the document's id or the chat file's path, with the title).
 */
export function WordCard({ item }: SurfaceCardProps) {
  const name = item.title || wordFileName(item.path) || L("קובץ Word", "Word file");
  return (
    <button type="button" className="item-card" onClick={() => openSurface(item)} aria-label={`${L("פתיחה", "Open")}: ${name}`}>
      <span className="item-card-icon" aria-hidden>W</span>
      <span className="item-card-text">
        <strong dir="auto">{name}</strong>
        <small className="muted">{L("קובץ Word", "Word file")}</small>
      </span>
      <span className="item-card-open">{L("פתיחה", "Open")} ›</span>
    </button>
  );
}

/**
 * A Word file beside the chat: the KesherAI document editor (view, edit, ask about a part) under a strip that names
 * the file, saves it back ("Save to Word", with a dot while there are unsaved changes) and downloads it as .docx. A
 * chat file is brought in by the server from the chat's folder (the phone sends the chat and the file's name, never a
 * path on the computer); a `docx_open` item is the document itself. Works the same over remote.
 *
 * @param props - The surface item (`path` and `convId` for a chat file, else `id` is the document's id).
 */
export function WordPanel({ item, full, onFull }: SurfacePanelProps) {
  const fromChat = !!item.path && !!item.convId;
  const key = `${item.convId ?? ""}\n${item.path ?? ""}`;
  const [docId, setDocId] = useState(fromChat ? (imported.get(key) ?? "") : item.id);
  const [doc, setDoc] = useState<WordDoc | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  /** The revision last read from, or written to, the Word file. */
  const [savedRev, setSavedRev] = useState<number | null>(null);

  // A chat file: the server brings it in as a document.
  useEffect(() => {
    if (docId || !fromChat) return;
    void api<{ id: string }>("/api/docs/import-docx", { method: "POST", body: { convId: item.convId, file: item.path } }).then(
      (d) => { imported.set(key, d.id); setDocId(d.id); },
      (e: Error) => setError(e.message),
    );
  }, [docId, fromChat, key, item.convId, item.path]);

  const load = useCallback(() => {
    if (!docId) return;
    void api<WordDoc>(`/api/docs/${encodeURIComponent(docId)}`).then(
      (d) => { setDoc(d); setSavedRev((s) => s ?? d.rev); },
      (e: Error) => setError(e.message),
    );
  }, [docId]);
  useEffect(load, [load]);
  // Her edits and the model's follow live: a new revision shows the dot.
  useEffect(() => {
    if (!docId) return;
    const es = new EventSource(withToken(`/api/docs/${encodeURIComponent(docId)}/events`));
    es.onmessage = () => load();
    return () => es.close();
  }, [docId, load]);

  const name = wordFileName(doc?.source?.path) || item.title || wordFileName(item.path) || L("מסמך", "Document");
  const state = wordSaveState({ hasFile: !!doc?.source, rev: doc?.rev ?? 0, savedRev: savedRev ?? doc?.rev ?? 0, saving });
  const save = () => {
    if (!doc || state === "saving" || state === "no-file") return;
    setSaving(true);
    const rev = doc.rev;
    void api<{ bak: boolean }>(`/api/docs/${encodeURIComponent(doc.id)}/save-docx`, { method: "POST", body: {} }).then(
      (r) => { setSavedRev(rev); toast(r.bak ? L("נשמר לקובץ Word. העותק הקודם נשמר כ-.bak", "Saved to the Word file. The old file is kept as .bak") : L("נשמר לקובץ Word", "Saved to the Word file")); },
      (e: Error) => toast(e.message),
    ).finally(() => setSaving(false));
  };

  if (error) return <p className="error word-error" dir="auto">{error}</p>;
  if (!docId) return <p className="muted word-error">{L("פותח את קובץ ה-Word…", "Opening the Word file…")}</p>;
  return (
    <>
      <div className="word-bar">
        <span className="word-badge" aria-hidden>W</span>
        <strong className="word-name" dir="auto" title={name}>{L("קובץ Word", "Word file")}: {name}</strong>
        <button type="button" className="word-save" disabled={state === "clean" || state === "saving" || state === "no-file"} onClick={save}
          title={state === "no-file" ? L("המסמך לא בא מקובץ Word: אפשר להוריד כ-.docx", "This document did not come from a Word file: download it as .docx") : L("שמירה לקובץ Word (העותק הקודם נשמר פעם אחת כ-.bak)", "Save to the Word file (the old file is kept once as .bak)")}>
          {saving ? L("שומר…", "Saving…") : L("שמירה ל-Word", "Save to Word")}
          {state === "dirty" && <span className="word-dot" role="img" aria-label={L("יש שינויים שלא נשמרו", "Unsaved changes")} />}
        </button>
        <a className="btn word-download" href={withToken(wordExportPath(docId))} download>{L("הורדה כ-.docx", "Download .docx")}</a>
      </div>
      <ItemPanel item={{ kind: "doc", id: docId, ...(item.convId ? { convId: item.convId } : {}), title: name }} full={full} onFull={onFull} />
    </>
  );
}
