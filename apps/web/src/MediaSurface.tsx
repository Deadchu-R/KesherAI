import { createPortal } from "react-dom";
import { lazy, Suspense, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { closePanel, openSurface } from "./ArtifactPanel";
import { api, withToken } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";
import { fileUrl } from "./MediaView";
import { pageInput } from "./page-input";
import { offerPart, PluginFrame, usePluginUi } from "./plugins";
import { clockText, fraction, markRange, rangeAsk, rangeMessage, spriteCell, waveColumns, type Marks, type PrepInfo } from "./media-surface";
import type { SurfaceCardProps, SurfaceItem, SurfacePanelProps } from "./surfaces";

/*
 * The video and sound surfaces' card and panel (design ChatVideoSurface, ChatSoundSurface). Everything is read from the
 * PC's media prep (a small proxy, a thumbnail sprite, the sound's peaks; served with Range), never the original, so it
 * is light on the phone and the same over remote. The waveform is drawn from the peaks on a canvas: no whole-file decode.
 */

/** The phone editor is its own chunk: nothing of it loads until someone taps Edit. */
const MediaEditor = lazy(() => import("./MediaEditor"));

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
const narrow = () => matchMedia("(max-width: 1099px)").matches;
const part = (id: string, name: string) => withToken(`/api/media/${id}/${name}`);

/** The item's file as the prep route wants it: a chat file (conversation + path) or a made file (asset id). */
const prepBody = (item: SurfaceItem, path: string | undefined) => (path ? { conversation: item.convId ?? "", path } : { asset: item.id });

/**
 * Asks the PC to prepare the file (once; a cache hit answers at once) and follows it until it is done.
 *
 * @param item - The video or sound.
 * @param path - The chat file to use (a trimmed version), else the item's own.
 * @param on - Start only when true (a card waits until it is near the screen).
 * @returns The prep's status and a failure text.
 */
function useMediaPrep(item: SurfaceItem, path: string | undefined, on: boolean): { info?: PrepInfo; failed: string } {
  const [info, setInfo] = useState<PrepInfo>();
  const [failed, setFailed] = useState("");
  useEffect(() => {
    if (!on) return;
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setInfo(undefined);
    setFailed("");
    const step = (s: PrepInfo): void => {
      if (dead) return;
      setInfo(s);
      if (s.state === "error") setFailed(s.error ?? "");
      else if (s.state !== "done") timer = setTimeout(() => void api<PrepInfo>(`/api/media/prep/${s.id}`).then(step, (e: Error) => !dead && setFailed(e.message)), 1500);
    };
    void api<PrepInfo>("/api/media/prep", { method: "POST", body: prepBody(item, path) }).then(step, (e: Error) => !dead && setFailed(e.message));
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [on, item.id, item.convId, path]);
  return { ...(info ? { info } : {}), failed };
}

/** True once the element is near the screen (a card prepares its file only then). */
function useSeen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (seen || !ref.current) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && (setSeen(true), io.disconnect()), { rootMargin: "300px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen, ref]);
  return seen;
}

/** The sound's peaks (8-bit min/max pairs), fetched once they are ready. */
function usePeaks(info: PrepInfo | undefined): Uint8Array | undefined {
  const [peaks, setPeaks] = useState<Uint8Array>();
  const id = info?.ready.peaks ? info.id : undefined;
  useEffect(() => {
    if (!id) return;
    let dead = false;
    void fetch(part(id, "peaks")).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status))))).then((b) => !dead && setPeaks(new Uint8Array(b)), () => undefined);
    return () => {
      dead = true;
    };
  }, [id]);
  return peaks;
}

/** The item's name for titles. */
const nameOf = (item: SurfaceItem): string => item.title || item.path?.split("/").pop() || item.id.slice(0, 8);

interface WaveProps {
  peaks: Uint8Array | undefined;
  duration: number;
  height: number;
  /** The playhead, in seconds. */
  at?: number;
  marks?: Marks | undefined;
  /** A tap or drag: a tap seeks, a drag marks a range. */
  onPick?: (seek: number, range?: Marks) => void;
  label: string;
}

/**
 * The waveform on a canvas (left to right in Hebrew too, as a time axis is), with the marked range and the playhead.
 * A tap seeks; a drag marks a range.
 */
function Wave({ peaks, duration, height, at = 0, marks, onPick, label }: WaveProps) {
  const box = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(0);
  const drag = useRef<{ from: number; x: number; moved: boolean } | undefined>(undefined);
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(() => setW(box.current?.clientWidth ?? 0));
    ro.observe(box.current);
    setW(box.current.clientWidth);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const c = cv.current;
    if (!c || !w) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(w * dpr);
    c.height = Math.round(height * dpr);
    const g = c.getContext("2d");
    if (!g) return;
    g.scale(dpr, dpr);
    const css = getComputedStyle(c);
    const accent = css.getPropertyValue("--accent").trim() || "#6aa3ff";
    const dim = css.getPropertyValue("--muted").trim() || "#8a8f98";
    const mid = height / 2;
    const cols = peaks ? waveColumns(peaks, Math.floor(w / 2)) : [];
    const lo = marks ? fraction(marks.start, duration) * w : 0;
    const hi = marks ? fraction(marks.end, duration) * w : 0;
    if (marks) {
      g.fillStyle = accent;
      g.globalAlpha = 0.18;
      g.fillRect(lo, 0, Math.max(2, hi - lo), height);
      g.globalAlpha = 1;
    }
    cols.forEach(([a, b], i) => {
      const x = i * 2;
      g.fillStyle = marks && x >= lo && x <= hi ? accent : dim;
      const top = mid - Math.max(0.5, b) * mid * 0.95;
      g.fillRect(x, top, 1.4, Math.max(1.5, mid - Math.min(-0.01, a) * mid * 0.95 - top));
    });
    if (!cols.length) {
      g.fillStyle = dim;
      g.globalAlpha = 0.4;
      g.fillRect(0, mid - 1, w, 2);
      g.globalAlpha = 1;
    }
    if (at > 0) {
      g.fillStyle = accent;
      g.fillRect(fraction(at, duration) * w - 1, 0, 2, height);
    }
  }, [peaks, w, height, at, marks, duration]);
  const timeAt = (e: ReactPointerEvent): number => {
    const r = box.current!.getBoundingClientRect();
    return fraction(e.clientX - r.left, r.width) * duration;
  };
  return (
    <div
      ref={box}
      className={`media-wave${onPick ? " pick" : ""}`}
      dir="ltr"
      role={onPick ? "slider" : "img"}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(at)}
      style={{ height }}
      {...(onPick ? {
        onPointerDown: (e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { from: timeAt(e), x: e.clientX, moved: false };
        },
        onPointerMove: (e) => {
          const d = drag.current;
          if (!d) return;
          if (Math.abs(e.clientX - d.x) > 4) d.moved = true;
          if (d.moved) onPick(d.from, markRange(d.from, timeAt(e), duration));
        },
        onPointerUp: (e) => {
          const d = drag.current;
          drag.current = undefined;
          if (d && !d.moved) onPick(timeAt(e));
        },
      } : {})}
    >
      <canvas ref={cv} style={{ width: "100%", height }} />
    </div>
  );
}

/** A video's poster from the sprite (the frame at `t`), as a background; no separate picture request. */
function Poster({ info, t = 0 }: { info: PrepInfo; t?: number }) {
  if (!info.ready.sprite || !info.sprite) return <div className="media-poster media-poster-empty" aria-hidden />;
  const s = info.sprite;
  const { col, row } = spriteCell(s, t);
  return <div className="media-poster" aria-hidden style={{ backgroundImage: `url(${part(info.id, "sprite")})`, backgroundSize: `${s.cols * 100}% ${s.rows * 100}%`, backgroundPosition: `${s.cols > 1 ? (col / (s.cols - 1)) * 100 : 0}% ${s.rows > 1 ? (row / (s.rows - 1)) * 100 : 0}%` }} />;
}

/** The prep's state as a short line while it is not done (or why it failed). */
function PrepNote({ info, failed }: { info?: PrepInfo; failed: string }) {
  if (failed) return <span className="muted small" role="alert">{L("לא הצלחתי להכין את הקובץ: ", "Could not prepare the file: ")}{failed}</span>;
  if (!info || info.state !== "done") return <span className="muted small" role="status">{L("מכין את הקובץ בנגן…", "Preparing the file for playback…")}</span>;
  return null;
}

/**
 * The video's card in the message: the poster (from the sprite), its length, and a play button that plays the small
 * proxy right there. Open shows the panel.
 *
 * @param props - The item.
 */
export function VideoCard({ item }: SurfaceCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useSeen(ref);
  const { info, failed } = useMediaPrep(item, item.path, seen);
  const [play, setPlay] = useState(false);
  const title = nameOf(item);
  return (
    <div ref={ref} className="item-card media-card">
      <div className="media-card-view" dir="ltr">
        {play && info?.ready.proxy ? (
          <video src={part(info.id, "proxy")} controls autoPlay playsInline preload="metadata" aria-label={title} />
        ) : (
          <button type="button" className="media-card-play" disabled={!info?.ready.proxy} onClick={() => setPlay(true)} aria-label={`${L("ניגון", "Play")}: ${title}`}>
            {info ? <Poster info={info} /> : <div className="media-poster media-poster-empty" aria-hidden />}
            <span className="media-play-icon" aria-hidden>▶</span>
            {info?.duration ? <span className="media-duration">{clockText(info.duration)}</span> : null}
          </button>
        )}
      </div>
      <div className="media-card-row">
        <span className="item-card-text"><strong dir="auto">{title}</strong><small className="muted">{L("וידאו", "Video")}</small></span>
        <button type="button" className="chip-text" onClick={() => openSurface(item)}>{L("פתיחה", "Open")} ›</button>
      </div>
      <PrepNote {...(info ? { info } : {})} failed={failed} />
    </div>
  );
}

/**
 * The sound's card in the message: its waveform (from the peaks, drawn on a canvas), its length and a play button.
 *
 * @param props - The item.
 */
export function SoundCard({ item }: SurfaceCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useSeen(ref);
  const { info, failed } = useMediaPrep(item, item.path, seen);
  const peaks = usePeaks(info);
  const audio = useRef<HTMLAudioElement>(null);
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const title = nameOf(item);
  const duration = info?.duration ?? 0;
  return (
    <div ref={ref} className="item-card media-card">
      <div className="media-card-row">
        <button type="button" className="media-round" disabled={!info?.ready.proxy} aria-label={`${playing ? L("השהיה", "Pause") : L("ניגון", "Play")}: ${title}`} onClick={() => (playing ? audio.current?.pause() : void audio.current?.play())}>{playing ? "❚❚" : "▶"}</button>
        <span className="item-card-text"><strong dir="auto">{title}</strong><small className="muted">{L("סאונד", "Sound")}{duration ? ` · ${clockText(duration)}` : ""}</small></span>
        <button type="button" className="chip-text" onClick={() => openSurface(item)}>{L("פתיחה", "Open")} ›</button>
      </div>
      <Wave peaks={peaks} duration={duration} height={48} at={at} label={L("גל קול", "Waveform")} {...(duration ? { onPick: (t: number) => { if (audio.current) audio.current.currentTime = t; } } : {})} />
      {info?.ready.proxy && <audio ref={audio} src={part(info.id, "proxy")} preload="none" onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />}
      <PrepNote {...(info ? { info } : {})} failed={failed} />
    </div>
  );
}

/** The file extension of a made file's type, for its copy in the chat's folder. */
const extOf = (mime: string): string => (/webm/.test(mime) ? "webm" : /mp4|m4a|aac/.test(mime) ? (mime.startsWith("audio") ? "m4a" : "mp4") : /wav/.test(mime) ? "wav" : /mpeg|mp3/.test(mime) ? "mp3" : /ogg/.test(mime) ? "ogg" : /flac/.test(mime) ? "flac" : "bin");

/**
 * The item as a file of the chat's folder (a made file is copied into `shared/` first: the cut and the editors work on
 * a chat's files).
 *
 * @returns The path inside the chat's folder.
 */
async function chatPath(item: SurfaceItem): Promise<string> {
  if (item.path) return item.path;
  if (!item.convId) throw new Error(L("אין צ'אט לשמור בו", "No chat to keep it in"));
  const blob = await (await fetch(fileUrl({ assetId: item.id }))).blob();
  const name = `kesher-${item.kind}-${item.id.slice(0, 8)}.${extOf(blob.type)}`;
  const up = await fetch(withToken(`/api/conversations/${encodeURIComponent(item.convId)}/files?name=${encodeURIComponent(name)}`), { method: "POST", headers: { "content-type": "application/octet-stream" }, body: blob });
  if (!up.ok) throw new Error(((await up.json().catch(() => ({}))) as { error?: string }).error ?? String(up.status));
  return `shared/${((await up.json()) as { name: string }).name}`;
}

/** The panel's shared body: the player, the timeline with its marks, the range actions, the ask box and the versions. */
function MediaPanel({ item, full, onFull, video }: SurfacePanelProps & { video: boolean }) {
  const editorId = video ? "video-editor" : "sound-editor";
  const { pages } = usePluginUi();
  const page = pages.find((p) => p.pluginId === editorId);
  const [path, setPath] = useState(item.path);
  /** The renders of this file (each trim is a new file), the newest last. */
  const [renders, setRenders] = useState<string[]>([]);
  const { info, failed } = useMediaPrep(item, path, true);
  const peaks = usePeaks(info);
  const el = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [at, setAt] = useState(0);
  const [marks, setMarks] = useState<Marks>();
  const [pendingIn, setPendingIn] = useState<number>();
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState("");
  const [editor, setEditor] = useState(false);
  /** The phone editor's file: the prep as it was when it opened (a new version must not swap them under it). */
  const [editing, setEditing] = useState<{ info: PrepInfo }>();
  const editPeaks = usePeaks(editing?.info);
  const stopAt = useRef<number | undefined>(undefined);
  const duration = info?.duration ?? 0;
  const title = nameOf(item);
  const phone = narrow();
  const seek = (t: number) => {
    if (el.current) el.current.currentTime = t;
    setAt(t);
  };
  const playRange = () => {
    if (!marks || !el.current) return;
    stopAt.current = marks.end;
    seek(marks.start);
    void el.current.play();
  };
  const markIn = () => {
    setPendingIn(at);
    if (marks && at < marks.end) setMarks({ ...marks, start: Math.round(at * 100) / 100 });
  };
  const markOut = () => {
    const m = markRange(pendingIn ?? marks?.start ?? 0, at, duration);
    if (m) setMarks(m);
  };
  const ask = async () => {
    if (!marks) return;
    if (!item.convId) return toast(L("הפתיחה הזו לא קשורה לצ'אט.", "This one is not tied to a chat."));
    setBusy("ask");
    try {
      const text = rangeMessage(rangeAsk({ ...item, ...(path ? { path } : {}) }, marks), title, question, getLocale() === "he");
      await api(`/api/conversations/${item.convId}/messages`, { method: "POST", body: { text } });
      setQuestion("");
      toast(L("נשלח לצ'אט.", "Sent to the chat."));
      if (phone) closePanel();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const trim = async () => {
    if (!marks || !item.convId) return;
    setBusy("trim");
    try {
      const src = path ?? (await chatPath(item));
      const r = await api<{ path: string }>(`/api/conversations/${item.convId}/files/cut`, { method: "POST", body: { path: src, segments: [{ from: marks.start, to: marks.end }] } });
      setRenders((v) => [...v, r.path]);
      setPath(r.path);
      setMarks(undefined);
      toast(L("נשמרה גרסה חדשה.", "Saved a new version."));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  /** Sound: the PC renders the marked range of the prepared file as a new version (ids only; `POST /api/media/trim`). */
      const trimSound = async () => {
        if (!marks || !item.convId || !info) return;
        setBusy("trim");
        try {
          const { job } = await api<{ job: string }>("/api/media/trim", { method: "POST", body: { conversation: item.convId, source: info.id, start: marks.start, end: marks.end } });
          for (let st = { state: "running" } as { state: string; path?: string; error?: string }; ; await new Promise((r) => setTimeout(r, 700))) {
            st = await api<typeof st>(`/api/media/export/${job}`);
            if (st.state === "error") throw new Error(st.error || "Trim failed");
            if (st.state === "done" && st.path) {
              setRenders((v) => [...v, st.path!]);
              setPath(st.path);
              setMarks(undefined);
              toast(L("נשמרה גרסה חדשה.", "Saved a new version."));
              break;
            }
          }
        } catch (e) {
          toast((e as Error).message);
        } finally {
          setBusy("");
        }
      };
      /** Sound: apply a list of ops on the marked range (fade, gain) through the same export route. */
      const applySoundOps = async (ops: import("@kesher/shared").SoundOp[], busyTag: string) => {
        if (!marks || !item.convId || !info) return;
        setBusy(busyTag);
        try {
          const { job } = await api<{ job: string }>("/api/media/trim", { method: "POST", body: { conversation: item.convId, source: info.id, start: marks.start, end: marks.end, ops } });
          for (let st = { state: "running" } as { state: string; path?: string; error?: string }; ; await new Promise((r) => setTimeout(r, 700))) {
            st = await api<typeof st>(`/api/media/export/${job}`);
            if (st.state === "error") throw new Error(st.error || "Edit failed");
            if (st.state === "done" && st.path) {
              setRenders((v) => [...v, st.path!]);
              setPath(st.path);
              setMarks(undefined);
              toast(L("נשמרה גרסה חדשה.", "Saved a new version."));
              break;
            }
          }
        } catch (e) {
          toast((e as Error).message);
        } finally {
          setBusy("");
        }
      };
      const fadeInOut = () => {
        if (!marks) return;
        const d = Math.min(0.5, (marks.end - marks.start) / 2);
        void applySoundOps([
          { op: "fade", a: marks.start, b: marks.start + d, dir: "in" },
          { op: "fade", a: marks.end - d, b: marks.end, dir: "out" },
        ], "fade");
      };
      const [gainOpen, setGainOpen] = useState(false);
      const [gainDb, setGainDb] = useState(0);
  const openEditor = async () => {
    if (!page) {
      if (await offerPart(editorId, L("העורך המלא", "The full editor"))) setEditor(true);
      return;
    }
    try {
      if (!path) setPath(await chatPath(item));
      setEditor(true);
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const editorQuery = `c=${encodeURIComponent(item.convId ?? "")}&f=${encodeURIComponent(path ?? "")}`;
  const input = page && path ? pageInput(editorQuery, page.uses) : undefined;
  const versions = [item.path ?? "", ...renders].filter(Boolean);
  return (
    <>
      <div className="artifact-bar">
        <button type="button" className="ghost artifact-back" onClick={closePanel}>‹ {L("חזרה לצ'אט", "Back to chat")}</button>
        <strong className="grow" dir="auto">{title}</strong>
        <button type="button" className="ghost artifact-wide-only" title={L("מסך מלא", "Full screen")} aria-label={L("מסך מלא", "Full screen")} aria-pressed={full} onClick={onFull}>⛶</button>
        <button type="button" className="ghost artifact-close" title={L("סגור", "Close")} aria-label={L("סגור", "Close")} onClick={closePanel}>✕</button>
      </div>
      {editor && page && input ? (
        <div className="plugin-surface-body">
          <PluginFrame key={`${page.pluginId}:${path}`} pluginId={page.pluginId} file={page.file} title={page.title} conversationId={input.conversationId} uses={page.uses ?? []} input={input} />
        </div>
      ) : (
        <div
          className="media-body"
          onKeyDown={(e) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
            if (e.key === "i" || e.key === "[") markIn();
            else if (e.key === "o" || e.key === "]") markOut();
          }}
        >
          <div className="media-stage" dir="ltr">
            {info?.ready.proxy ? (
              video ? (
                <video ref={el} src={part(info.id, "proxy")} controls playsInline preload="metadata" aria-label={title} onTimeUpdate={(e) => { setAt(e.currentTarget.currentTime); if (stopAt.current !== undefined && e.currentTarget.currentTime >= stopAt.current) { e.currentTarget.pause(); stopAt.current = undefined; } }} />
              ) : (
                <audio ref={el} src={part(info.id, "proxy")} controls preload="metadata" aria-label={title} onTimeUpdate={(e) => { setAt(e.currentTarget.currentTime); if (stopAt.current !== undefined && e.currentTarget.currentTime >= stopAt.current) { e.currentTarget.pause(); stopAt.current = undefined; } }} />
              )
            ) : (
              <div className="media-stage-wait">{info && video ? <Poster info={info} /> : null}<PrepNote {...(info ? { info } : {})} failed={failed} /></div>
            )}
          </div>
          <Wave
            peaks={peaks}
            duration={duration}
            height={video ? 64 : 120}
            at={at}
            marks={marks}
            label={L("ציר זמן: הקשה קופצת, גרירה מסמנת קטע", "Timeline: tap to jump, drag to mark a range")}
            {...(duration ? { onPick: (t: number, r?: Marks) => (r ? setMarks(r) : seek(t)) } : {})}
          />
          <div className="media-times" dir="ltr">
            <span>{clockText(at)}</span>
            <span className="muted">{marks ? `${clockText(marks.start)} – ${clockText(marks.end)}` : L("אין קטע מסומן", "No range marked")}</span>
            <span>{duration ? clockText(duration) : ""}</span>
          </div>
          <div className="media-actions">
            <button type="button" className="chip-text" onClick={markIn} disabled={!duration} title="[ / I">[ {L("תחילת קטע", "Mark in")}</button>
            <button type="button" className="chip-text" onClick={markOut} disabled={!duration} title="] / O">{L("סוף קטע", "Mark out")} ]</button>
            <button type="button" className="chip-text" onClick={playRange} disabled={!marks}>▶ {L("ניגון הקטע", "Play range")}</button>
            <button type="button" className="chip-text" onClick={() => { setMarks(undefined); setPendingIn(undefined); }} disabled={!marks}>{L("ניקוי", "Clear")}</button>
          </div>
          <form className="media-ask" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
            <input dir="auto" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={L("מה לשאול על הקטע?", "What to ask about this range?")} aria-label={L("שאלה על הקטע", "A question about the range")} disabled={!marks} />
            <button type="submit" disabled={!marks || busy === "ask"}>{busy === "ask" ? "…" : L("לשאול על הקטע הזה", "Ask about this range")}</button>
          </form>
          {phone ? (
            <div className="media-phone-edit">
              <button type="button" disabled={!video || !info?.ready.proxy} onClick={() => info && setEditing({ info })} aria-describedby={video ? undefined : "media-soon"}>✎ {L("עריכה", "Edit")}</button>
              {!video && <span id="media-soon" className="muted small">{L("עריכת סאונד בקרוב בטלפון", "sound editing is coming soon on the phone")}</span>}
            </div>
          ) : (
                        <>
                          <div className="media-actions">
                            <button type="button" onClick={() => void (video ? trim() : trimSound())} disabled={!marks || !item.convId || !!busy || (!video && !info)}>{busy === "trim" ? L("חותך…", "Cutting…") : `✂ ${L("חיתוך לקטע", "Trim to range")}`}</button>
                            {!video && (
                              <>
                                <button type="button" onClick={fadeInOut} disabled={!marks || !item.convId || !!busy || !info}>{busy === "fade" ? L("מדהה…", "Fading…") : L("דהייה פנימה/החוצה", "Fade in/out")}</button>
                                <button type="button" onClick={() => { setGainDb(0); setGainOpen(true); }} disabled={!marks || !item.convId || !!busy || !info}>{busy === "gain" ? L("משנה עוצמה…", "Changing gain…") : L("עוצמה", "Gain")}</button>
                              </>
                            )}
                            {video && <button type="button" onClick={() => info && setEditing({ info })} disabled={!info?.ready.proxy}>✎ {L("עריכה", "Edit")}</button>}
                            <button type="button" onClick={() => void openEditor()} disabled={!!busy}>{page ? L("עורך מלא", "Full editor") : `📦 ${L("עורך מלא (התקנה)", "Full editor (install)")}`}</button>
                          </div>
                          {!video && gainOpen && marks && (
                            <form className="media-ask" onSubmit={(e) => { e.preventDefault(); setGainOpen(false); void applySoundOps([{ op: "gain", a: marks.start, b: marks.end, db: gainDb }], "gain"); }}>
                              <label className="muted small" dir="auto">{L("עוצמה בקטע (dB)", "Range gain (dB)")}: {gainDb > 0 ? `+${gainDb}` : gainDb}</label>
                              <input type="range" min={-12} max={12} step={1} value={gainDb} onChange={(e) => setGainDb(Number(e.target.value))} aria-label={L("עוצמה ב-dB", "Gain in dB")} />
                              <button type="submit" disabled={!!busy}>{L("אישור", "Apply")}</button>
                              <button type="button" className="ghost" onClick={() => setGainOpen(false)}>{L("ביטול", "Cancel")}</button>
                            </form>
                          )}
                        </>
                      )}
          {versions.length > 1 && (
            <ul className="media-versions" aria-label={L("גרסאות", "Versions")}>
              {versions.map((v, i) => (
                <li key={v}><button type="button" className={`chip-text${v === path ? " on" : ""}`} aria-pressed={v === path} onClick={() => { setPath(v); setMarks(undefined); }} dir="ltr">v{i + 1} · {v.split("/").pop()}</button></li>
              ))}
            </ul>
          )}
        </div>
      )}
      {editing && createPortal(
        <Suspense fallback={<div className="media-editor me-loading" role="status">{L("טוען את העורך…", "Loading the editor…")}</div>}>
          <MediaEditor
            item={{ ...item, ...(path ? { path } : {}) }}
            info={editing.info}
            peaks={editPeaks}
            title={title}
            onClose={() => setEditing(undefined)}
            onExported={(made) => {
              setRenders((v) => [...v, made]);
              setPath(made);
              setMarks(undefined);
            }}
          />
        </Suspense>,
        document.body,
      )}
      {editor && <div className="media-actions"><button type="button" className="ghost" onClick={() => setEditor(false)}>‹ {L("חזרה לנגן", "Back to the player")}</button></div>}
    </>
  );
}

/** The video surface's panel: the player, in/out marks, a trim, the full editor, ask about a range. */
export function VideoPanel(p: SurfacePanelProps) {
  return <MediaPanel {...p} video />;
}

/** The sound surface's panel: the big waveform, range select and play, the full editor, ask about a range. */
export function SoundPanel(p: SurfacePanelProps) {
  return <MediaPanel {...p} video={false} />;
}
