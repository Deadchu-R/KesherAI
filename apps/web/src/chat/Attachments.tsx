import { lazy, Suspense, useEffect, useState } from "react";
import { Media } from "../MediaSpeed";
import { api, withToken } from "../api";
import { getLocale, he$ } from "../i18n";
import { LineIcon } from "../ui/Glyph";
import { fileIcon } from "../attach-lines";
import { usePluginUi } from "../plugins";

// three.js is big: the 3D viewer loads only when a model is opened.
const ModelViewer = lazy(() => import("../ModelViewer"));
const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

type Preview =
  | { kind: "table"; name: string; sheets: Array<{ name: string; rows: string[][]; more: number }> }
  | { kind: "slides"; name: string; slides: string[] }
  | { kind: "html"; name: string; html: string }
  | { kind: "text"; name: string; text: string }
  | { kind: "image" | "model" | "none"; name: string; path: string };

/** A Word or HTML page in a frame with no scripts, no forms and nothing from outside (only its own styles and pictures). */
const framed = (html: string) =>
  `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>body{font:15px/1.6 system-ui,sans-serif;color:#1d1d1f;background:#fff;margin:24px;max-width:780px}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:4px 8px}img{max-width:100%}</style><body dir="auto">${html}`;

/**
 * The files a message attached, as chips (as Claude shows them): a tap opens a preview.
 *
 * @param props.convId - The chat.
 * @param props.files - Paths from the message's "[Attached: …]" lines.
 */
export function AttachmentChips({ convId, files }: { convId: string; files: string[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <span className="attach-chips">
      {files.map((f) => (
        <button key={f} type="button" className="attach-chip" onClick={() => setOpen(f)} title={L("תצוגה מקדימה", "Preview")}>
          <LineIcon name={fileIcon(f)} size={15} />
          <span dir="auto">{f.split(/[\\/]/).pop()}</span>
        </button>
      ))}
      {open && <AttachmentPreview convId={convId} path={open} onClose={() => setOpen(null)} />}
    </span>
  );
}

/** The preview dialog: the file's name, Download, and the preview. */
function AttachmentPreview({ convId, path, onClose }: { convId: string; path: string; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [onClose]);
  const download = withToken(`/api/conversations/${encodeURIComponent(convId)}/files/download?path=${encodeURIComponent(path)}`);
  const name = path.split(/[\\/]/).pop();
  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div className="dialog card attach-preview" role="dialog" aria-modal="true" aria-label={name} onClick={(e) => e.stopPropagation()}>
        <header className="row">
          <LineIcon name={fileIcon(path)} />
          <strong className="grow attach-name" dir="auto">{name}</strong>
          <a className="btn" href={download} download>{L("הורדה", "Download")}</a>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={L("סגירה", "Close")}><LineIcon name="close" size={16} /></button>
        </header>
        <FilePreview convId={convId} path={path} />
      </div>
    </div>
  );
}

/**
 * "Edit" on a chat's picture or video: opens it in the image or video editor (a plugin page) as a tab, which can send
 * the result back to the chat. Shown only when that editor is installed.
 */
function EditIn({ convId, path, kind }: { convId: string; path: string; kind: "image" | "video" | "sound" }) {
  const { pages } = usePluginUi();
  const id = `${kind}-editor`;
  const editor = pages.find((p) => p.pluginId === id && p.uses?.includes(kind));
  if (!editor) return null;
  const href = `#/p/${editor.pluginId}/${editor.id}?c=${encodeURIComponent(convId)}&f=${encodeURIComponent(path)}`;
  return <a className="btn attach-edit" href={href}><LineIcon name="pencil" size={15} /> {kind === "image" ? L("עריכה בעורך התמונות", "Edit in the image editor") : kind === "video" ? L("עריכה בעורך הווידאו", "Edit in the video editor") : L("עריכה בעורך הסאונד", "Edit in the sound editor")}</a>;
}

/** Files shown as a preview rather than as text: Office files, PDF and pictures (the Workspace opens these so). */
export const PREVIEW_FIRST = /\.(xlsx|docx|pptx|pdf|png|jpe?g|webp|gif|bmp|glb|gltf)$/i;
/** Files that can be read either way: a table or a page, or their text to edit. */
export const PREVIEW_OR_TEXT = /\.(csv|tsv|html?)$/i;

/**
 * A file of the chat's folder as a table (Excel, CSV), slides (PowerPoint), a page (Word, HTML, in a frame with no
 * scripts), a picture, a player or text (PDF and the rest). Used by the attachment chips and the Workspace.
 *
 * @param props.convId - The chat.
 * @param props.path - The file, relative to the chat's folder.
 * @param props.reloadKey - Changes when the file may have changed (the agent wrote it again).
 */
export function FilePreview({ convId, path, reloadKey }: { convId: string; path: string; reloadKey?: number }) {
  const [p, setP] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [sheet, setSheet] = useState(0);
  useEffect(() => {
    setError("");
    void api<Preview>(`/api/conversations/${encodeURIComponent(convId)}/files/preview?path=${encodeURIComponent(path)}`).then(setP, (e: Error) => setError(e.message));
  }, [convId, path, reloadKey]);
  useEffect(() => {
    setSheet(0);
    setP(null);
  }, [path]);
  const file = "path" in (p ?? {}) ? (p as { path: string }).path : path;
  const download = withToken(`/api/conversations/${encodeURIComponent(convId)}/files/download?path=${encodeURIComponent(file)}`);
  return (
    <div className="attach-body">
      {error && <p className="error" dir="auto">{error}</p>}
      {!p && !error && <p className="muted">{L("טוען…", "Loading…")}</p>}
      {p?.kind === "table" && (
        <>
          {p.sheets.length > 1 && (
            <div className="seg-pills" role="tablist">
              {p.sheets.map((s, i) => <button key={s.name + i} type="button" role="tab" aria-selected={i === sheet} className={i === sheet ? "on" : ""} onClick={() => setSheet(i)} dir="auto">{s.name}</button>)}
            </div>
          )}
          {(() => {
            const s = p.sheets[sheet];
            if (!s || !s.rows.length) return <p className="muted">{L("הגיליון ריק", "This sheet is empty")}</p>;
            const width = Math.max(...s.rows.map((r) => r.length));
            return (
              <div className="attach-table-wrap">
                <table className="attach-table">
                  <thead><tr>{Array.from({ length: width }, (_, i) => <th key={i} dir="auto">{s.rows[0]![i] ?? ""}</th>)}</tr></thead>
                  <tbody>{s.rows.slice(1).map((r, ri) => <tr key={ri}>{Array.from({ length: width }, (_, i) => <td key={i} dir="auto">{r[i] ?? ""}</td>)}</tr>)}</tbody>
                </table>
                {s.more > 0 && <p className="muted small">{L(`ועוד ${s.more} שורות (בקובץ המלא)`, `${s.more} more rows (in the full file)`)}</p>}
              </div>
            );
          })()}
        </>
      )}
      {p?.kind === "slides" && (
        <ol className="attach-slides">
          {p.slides.map((s, i) => <li key={i}><span className="muted small">{L(`שקף ${i + 1}`, `Slide ${i + 1}`)}</span><p dir="auto">{s || L("(בלי טקסט)", "(no text)")}</p></li>)}
        </ol>
      )}
      {p?.kind === "html" && <iframe className="attach-frame" sandbox="" srcDoc={framed(p.html)} title={p.name} />}
      {p?.kind === "text" && <pre className="attach-text" dir="auto">{p.text}</pre>}
      {p?.kind === "image" && <img className="attach-img" src={download} alt={p.name} />}
      {p?.kind === "image" && <EditIn convId={convId} path={file} kind="image" />}
      {p?.kind === "model" && <Suspense fallback={<p className="muted">{L("טוען…", "Loading…")}</p>}><ModelViewer src={download} name={p.name} /></Suspense>}
      {p?.kind === "none" && /\.(mp4|webm|mov|m4v|mkv)$/i.test(file) && <><Media kind="video" className="attach-img" src={download} controls preload="metadata" /><EditIn convId={convId} path={file} kind="video" /></>}
      {p?.kind === "none" && /\.(mp3|wav|m4a|ogg|flac|aac|opus)$/i.test(file) && <><Media kind="audio" src={download} controls preload="metadata" style={{ width: "100%" }} /><EditIn convId={convId} path={file} kind="sound" /></>}
      {p?.kind === "none" && !/\.(mp4|webm|mov|m4v|mkv|mp3|wav|m4a|ogg|flac|aac|opus)$/i.test(file) && <p className="muted">{L("אין תצוגה מקדימה לסוג הקובץ הזה. אפשר להוריד אותו.", "No preview for this kind of file. You can download it.")}</p>}
    </div>
  );
}
