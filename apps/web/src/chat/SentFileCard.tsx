import { useEffect, useRef, useState } from "react";
import { fileCardIcon, fileCardPreview, fileCardSize, firstLines, firstPdfPage, type FileCardInfo } from "@kesher/shared";
import { api } from "../api";
import { desktop } from "../library";
import { getLocale, he$ } from "../i18n";
import { MediaView, fileUrl, useNear } from "../MediaView";
import { RichText } from "../RichText";
import { FilePreview, framed } from "./Attachments";
import { OpenInChat } from "./surface-ui";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** What the chat's preview route gives back (the part a card uses). */
type Peek = { kind: "text"; text: string } | { kind: "html"; html: string } | { kind: string };

/**
 * A file the agent posted with `send_file`, as Claude shows a delivered file: the name, size, type icon and the
 * caption, a preview that fits the file (a picture, a PDF's first page, rendered Markdown, a page in a sandbox with
 * no scripts, the first 40 lines of text or code, a table, a player), and the buttons Open, Show in folder (the
 * computer app), Download and Open in chat (when an installed tool opens its type). On the phone the file streams
 * from the PC through the same authorized download address as every other chat file (`fileUrl` adds the device's
 * token); there is never a public address.
 *
 * @param props.convId - The chat.
 * @param props.card - The card from the tool's result.
 */
export function SentFileCard({ convId, card }: { convId: string; card: FileCardInfo }) {
  const ref = useRef<HTMLDivElement>(null);
  const near = useNear(ref);
  const plan = fileCardPreview(card.kind, card.size, card.display);
  const file = { convId, path: card.path };
  const url = fileUrl(file);
  const [peek, setPeek] = useState<Peek | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!near || !["pdf-page", "markdown", "html", "lines"].includes(plan)) return;
    let live = true;
    api<Peek>(`/api/conversations/${encodeURIComponent(convId)}/files/preview?path=${encodeURIComponent(card.path)}`).then((p) => live && setPeek(p), (e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [near, plan, convId, card.path]);
  const absolute = async () => `${(await api<{ folder: string }>(`/api/conversations/${encodeURIComponent(convId)}/files`)).folder.replace(/[\\/]+$/, "")}/${card.path}`;
  const text = peek && "text" in peek ? peek.text : "";
  const shown = plan === "lines" ? firstLines(text) : null;
  return (
    <div className="sent-file card" ref={ref}>
      <div className="sent-file-head">
        <span className="file-icon" aria-hidden>{fileCardIcon(card.kind)}</span>
        <div className="grow">
          <strong dir="ltr" className="sent-file-name">{card.name}</strong>
          <p className="muted small"><bdi dir="ltr">{fileCardSize(card.size)}</bdi> · {card.kind}</p>
        </div>
      </div>
      {card.caption && <p className="sent-file-caption" dir="auto">{card.caption}</p>}
      {plan === "image" && near && <img className="sent-file-img" src={url} alt={card.caption ?? card.name} loading="lazy" />}
      {plan === "player" && near && (card.kind === "audio" || card.kind === "video") && <MediaView src={url} kind={card.kind} name={card.name} />}
      {plan === "table" && near && <div className="sent-file-body"><FilePreview convId={convId} path={card.path} /></div>}
      {error && ["pdf-page", "markdown", "html", "lines"].includes(plan) && <p className="muted small" dir="auto">{L("אין תצוגה מקדימה לקובץ הזה. אפשר להוריד אותו.", "No preview for this file. You can download it.")}</p>}
      {peek && "text" in peek && plan === "pdf-page" && <pre className="sent-file-text" dir="auto">{firstLines(firstPdfPage(text)).text}</pre>}
      {peek && "text" in peek && plan === "markdown" && <div className="sent-file-body sent-file-md" dir="auto"><RichText text={text.slice(0, 20_000)} /></div>}
      {peek && "html" in peek && plan === "html" && <iframe className="sent-file-frame" sandbox="" srcDoc={framed(peek.html)} title={card.name} />}
      {shown && <pre className="sent-file-text" dir="ltr">{shown.text}{shown.more > 0 && `\n… +${shown.more}`}</pre>}
      <div className="sent-file-actions">
        <button type="button" onClick={() => (desktop()?.openPath ? void absolute().then((p) => desktop()!.openPath!(p)) : window.open(url, "_blank", "noopener"))}>{L("פתח", "Open")}</button>
        {desktop()?.openPath && <button type="button" onClick={() => void absolute().then((p) => desktop()!.openPath!(p.replace(/[\\/][^\\/]+$/, "")))}>{L("הצג בתיקייה", "Show in folder")}</button>}
        <a className="button" href={url} download={card.name}>{L("הורד", "Download")}</a>
        <OpenInChat convId={convId} name={card.name} path={card.path} />
      </div>
    </div>
  );
}
