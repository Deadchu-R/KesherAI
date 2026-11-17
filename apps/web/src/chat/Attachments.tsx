import { useEffect, useState } from "react";
import { Media } from "../MediaSpeed";
import { api, withToken } from "../api";
import { getLocale, he$ } from "../i18n";
import { LineIcon } from "../ui/Glyph";
import { fileIcon } from "../attach-lines";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

type Preview =
  | { kind: "table"; name: string; sheets: Array<{ name: string; rows: string[][]; more: number }> }
  | { kind: "slides"; name: string; slides: string[] }
  | { kind: "html"; name: string; html: string }
  | { kind: "text"; name: string; text: string }
  | { kind: "image" | "none"; name: string; path: string };

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

/** The preview: a table, slides, a page, a picture or text, with Download. */
function AttachmentPreview({ convId, path, onClose }: { convId: string; path: string; onClose: () => void }) {
  const [p, setP] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [sheet, setSheet] = useState(0);
  useEffect(() => {
    void api<Preview>(`/api/conversations/${encodeURIComponent(convId)}/files/preview?path=${encodeURIComponent(path)}`).then(setP, (e: Error) => setError(e.message));
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [convId, path, onClose]);
  const file = "path" in (p ?? {}) ? (p as { path: string }).path : path;
  const download = withToken(`/api/conversations/${encodeURIComponent(convId)}/files/download?path=${encodeURIComponent(file)}`);
  const name = p?.name ?? path.split(/[\\/]/).pop();
  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div className="dialog card attach-preview" role="dialog" aria-modal="true" aria-label={name} onClick={(e) => e.stopPropagation()}>
        <header className="row">
          <LineIcon name={fileIcon(path)} />
          <strong className="grow attach-name" dir="auto">{name}</strong>
          <a className="btn" href={download} download>{L("הורדה", "Download")}</a>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={L("סגירה", "Close")}><LineIcon name="close" size={16} /></button>
        </header>
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
          {p?.kind === "none" && /\.(mp4|webm|mov|m4v|mkv)$/i.test(file) && <Media kind="video" className="attach-img" src={download} controls preload="metadata" />}
          {p?.kind === "none" && /\.(mp3|wav|m4a|ogg|flac|aac|opus)$/i.test(file) && <Media kind="audio" src={download} controls preload="metadata" style={{ width: "100%" }} />}
          {p?.kind === "none" && !/\.(mp4|webm|mov|m4v|mkv|mp3|wav|m4a|ogg|flac|aac|opus)$/i.test(file) && <p className="muted">{L("אין תצוגה מקדימה לסוג הקובץ הזה. אפשר להוריד אותו.", "No preview for this kind of file. You can download it.")}</p>}
        </div>
      </div>
    </div>
  );
}
