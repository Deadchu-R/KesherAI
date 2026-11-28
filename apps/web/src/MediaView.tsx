import { useEffect, useRef, useState } from "react";
import { api, withToken } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";
import { Media } from "./MediaSpeed";
import { OpenInChat } from "./chat/surface-ui";
import { assetIdOf, formatDuration, mediaKindOf, type MediaKind } from "./chat/chat-inline";

/*
 * What a chat shows inline for a file a tool made (like Claude's answers): one player for pictures, video and sound
 * (`MediaView`), and the chips under it (`FileChips`: Download, Save to Drive, Open in the editor). Every address is
 * the server's own (`/api/assets/..`, a chat's `files/download`) with the token, so it works the same from the phone.
 */

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** Where a made file lives: an asset KesherAI keeps, or a file in a chat's folder (path inside it). */
export type FileRef = { assetId: string } | { convId: string; path: string };

/** The file's address on the server (with the token, for the phone). */
export function fileUrl(f: FileRef): string {
  return withToken("assetId" in f ? `/api/assets/${f.assetId}` : `/api/conversations/${encodeURIComponent(f.convId)}/files/download?path=${encodeURIComponent(f.path)}`);
}

/** True once the element is near the screen (players load only then; long chats stay light). */
export function useNear(ref: React.RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (near || !ref.current) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) {
        setNear(true);
        io.disconnect();
      }
    }, { rootMargin: "400px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [near, ref]);
  return near;
}

/**
 * A picture, video or sound in the chat: a player with controls, its length, a poster (a song's cover), and
 * full screen. Loads only when it comes near the screen.
 *
 * @param props.src - The file's address (from `fileUrl`).
 * @param props.kind - What it is (`mediaKindOf`); a 3D model shows as a file only.
 * @param props.name - Its name, for the picture's alt text and the full-screen view.
 * @param props.poster - A picture shown before a video plays, or beside a song.
 */
export function MediaView({ src, kind, name = "", poster }: { src: string; kind: MediaKind; name?: string; poster?: string }) {
  const box = useRef<HTMLDivElement | null>(null);
  const media = useRef<HTMLMediaElement | null>(null);
  const near = useNear(box);
  const [length, setLength] = useState("");
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!full) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setFull(false);
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [full]);
  if (kind === "model") return null;
  const fullLabel = L("מסך מלא", "Full screen");
  // A video goes full screen itself (iPhone Safari has only its own `webkitEnterFullscreen`); a picture opens over the page.
  const goFull = () => {
    const v = media.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (kind === "video" && v) void (v.requestFullscreen?.() ?? Promise.reject()).catch(() => v.webkitEnterFullscreen?.());
    else setFull(true);
  };
  const meta = (e: React.SyntheticEvent<HTMLMediaElement>) => setLength(formatDuration(e.currentTarget.duration));
  return (
    <div ref={box} className={`media-view ${kind}`}>
      {!near ? (
        <div className="media-wait" aria-hidden />
      ) : kind === "image" ? (
        <button type="button" className="media-img-btn" onClick={() => setFull(true)} aria-label={`${fullLabel}${name ? `: ${name}` : ""}`}>
          <img src={src} alt={name} loading="lazy" className="asset" />
        </button>
      ) : kind === "video" ? (
        <Media ref={media} kind="video" src={src} controls playsInline preload="metadata" {...(poster ? { poster } : {})} onLoadedMetadata={meta} className="asset" />
      ) : (
        <div className="media-audio-row">
          {poster && <img className="media-cover" src={poster} alt="" loading="lazy" />}
          <Media ref={media} kind="audio" src={src} controls preload="metadata" onLoadedMetadata={meta} />
        </div>
      )}
      {near && (length || kind !== "audio") && (
        <div className="media-bar small muted">
          {length && <span className="media-len" dir="ltr">{length}</span>}
          {kind !== "audio" && <button type="button" className="ghost small" onClick={goFull}>⛶ {fullLabel}</button>}
        </div>
      )}
      {full && (
        <div className="media-full" role="dialog" aria-modal="true" aria-label={name || fullLabel} onClick={() => setFull(false)}>
          <img src={src} alt={name} />
          <button type="button" className="media-full-close" aria-label={L("סגירה", "Close")} onClick={() => setFull(false)}>✕</button>
        </div>
      )}
    </div>
  );
}

// Whether Google Drive is connected: asked once per page load (the chips show "Save to Drive" only then).
let drive: Promise<boolean> | undefined;
function useDrive(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    drive ??= api<{ connected?: boolean }>("/api/google").then((g) => !!g.connected, () => false);
    let live = true;
    void drive.then((v) => live && setOn(v));
    return () => {
      live = false;
    };
  }, []);
  return on;
}

/**
 * The chips under a file a tool made: Download, Save to Drive (when Google Drive is connected; OneDrive has no file
 * upload yet), and Open in chat (when an installed tool opens its type, surfaces.ts: it opens in the side panel, full
 * screen on the phone; a tool that is off offers to install first). An asset is copied into the chat's folder first,
 * because editors open a chat's files.
 *
 * @param props.file - Where the file is.
 * @param props.name - The download's file name.
 * @param props.kind - Its kind (unused: the file's type picks the surface; kept for callers).
 * @param props.convId - The chat, for Open in chat with an asset (no chat: no Open chip for assets).
 */
export function FileChips({ file, name, convId }: { file: FileRef; name: string; kind?: MediaKind | null; convId?: string }) {
  const driveOn = useDrive();
  const [busy, setBusy] = useState<"" | "drive" | "edit">("");
  const [link, setLink] = useState("");
  const save = async () => {
    setBusy("drive");
    try {
      const body = "assetId" in file ? { assetId: file.assetId } : { conversationId: file.convId, path: file.path };
      const r = await api<{ link: string }>("/api/google/save-file", { method: "POST", body });
      setLink(r.link);
      toast(L("נשמר ב-Google Drive, בתיקייה KesherAI", "Saved to Google Drive, in the KesherAI folder"));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const chat = "assetId" in file ? convId : file.convId;
  /** The file as a chat file: an asset goes into the chat's `shared/` folder first (editors open a chat's files). */
  const inChat = async (): Promise<string> => {
    if (!("assetId" in file)) return file.path;
    if (!chat) throw new Error(L("אין צ'אט לפתוח בו", "No chat to open it in"));
    setBusy("edit");
    try {
      const bytes = await (await fetch(fileUrl(file))).blob();
      const up = await fetch(withToken(`/api/conversations/${encodeURIComponent(chat)}/files?name=${encodeURIComponent(name.slice(0, 120))}`), { method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes });
      if (!up.ok) throw new Error(((await up.json().catch(() => ({}))) as { error?: string }).error ?? `${up.status}`);
      return `shared/${((await up.json()) as { name: string }).name}`;
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="file-chips">
      <a className="chip-text" href={fileUrl(file)} download={name}>⤓ {L("הורדה", "Download")}</a>
      {driveOn && (link ? (
        <a className="chip-text" href={link} target="_blank" rel="noreferrer">↗ {L("פתח ב-Drive", "Open in Drive")}</a>
      ) : (
        <button type="button" className="chip-text" disabled={!!busy} onClick={() => void save()}>{busy === "drive" ? L("שומר…", "Saving…") : `☁ ${L("שמירה ל-Drive", "Save to Drive")}`}</button>
      ))}
      {chat && (busy === "edit" ? <span className="chip-text muted">{L("פותח…", "Opening…")}</span> : <OpenInChat convId={chat} name={"assetId" in file ? name : file.path} resolve={inChat} />)}
    </div>
  );
}

/**
 * A made file with its player and chips, in one card (tool results and the answer's own asset links).
 *
 * @param props.file - Where the file is.
 * @param props.kind - Its kind.
 * @param props.name - Its name (download name, alt text).
 * @param props.convId - The chat (for Open in the editor).
 * @param props.poster - A cover picture (a song's).
 * @param props.title - A heading above the player (a song's title).
 */
export function MadeMedia({ file, kind, name, convId, poster, title }: { file: FileRef; kind: MediaKind; name: string; convId?: string; poster?: string; title?: string }) {
  return (
    <div className={`made-media ${kind}`}>
      {title && <strong className="audio-title" dir="auto">{title}</strong>}
      <MediaView src={fileUrl(file)} kind={kind} name={name} {...(poster ? { poster } : {})} />
      <FileChips file={file} name={name} kind={kind} {...(convId ? { convId } : {})} />
    </div>
  );
}

/**
 * A link to `/api/assets/<id>` in an answer, shown as its player: the kind comes from the asset's `content-type`
 * (a HEAD request), so a video link plays and a picture shows. Anything else stays a plain link.
 *
 * @param props.href - The link.
 * @param props.label - Its text.
 * @param props.convId - The chat (for Open in the editor).
 */
export function AssetEmbed({ href, label, convId }: { href: string; label: string; convId?: string }) {
  const id = assetIdOf(href);
  const [found, setFound] = useState<{ kind: MediaKind; ext: string } | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    fetch(withToken(`/api/assets/${id}`), { method: "HEAD" }).then(
      (r) => {
        const mime = (r.headers.get("content-type") ?? "").split(";")[0]!.trim();
        const kind = r.ok ? mediaKindOf(mime) : null;
        // The download's extension from the type (`audio/mpeg` is an .mp3).
        if (live && kind) setFound({ kind, ext: mime === "audio/mpeg" ? "mp3" : mime === "image/jpeg" ? "jpg" : (mime.split("/")[1] ?? "bin").replace(/[^a-z0-9]/g, "") });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [id]);
  if (!id || !found) return <a href={id ? withToken(`/api/assets/${id}`) : href} target="_blank" rel="noreferrer">{label}</a>;
  // In an answer the chat is the page's own (`#/c/<id>`), for Open in the editor.
  const chat = convId ?? /^#\/c\/([^/?]+)/.exec(location.hash)?.[1];
  return <MadeMedia file={{ assetId: id }} kind={found.kind} name={`kesher-${found.kind}-${id.slice(0, 8)}.${found.ext}`} {...(chat ? { convId: decodeURIComponent(chat) } : {})} />;
}
