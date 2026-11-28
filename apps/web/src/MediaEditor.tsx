import { useEffect, useMemo, useRef, useState } from "react";
import { checkMediaEdit, type MediaEdit } from "@kesher/shared";
import { api, withToken } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";
import { MediaTimeline } from "./MediaTimeline";
import type { PrepInfo } from "./media-surface";
import { editLen, estimateBytes, fitPps, history, locate, push, redo, removeClip, setClip, setTransition, sizeText, splitAt, starts, undo, wholeFile, type ExportChoice, type History } from "./media-timeline";
import type { SurfaceItem } from "./surfaces";
import "./media-editor.css";

/*
 * The phone video editor (design PhoneMediaEditor, PhoneMediaExport), one lazy chunk opened full screen from the
 * media panel's "Edit". The viewer plays the PC's small proxy; the timeline and the tools change a MediaEdit (the edit
 * list, a few KB; media-timeline.ts holds the logic); Export sends that list and the file's id to the PC, which renders
 * the ORIGINAL (`POST /api/media/export`). Nothing here reads a path or the original file.
 */

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** A time as m:ss.t (h:mm:ss.t from an hour). */
function preciseClock(sec: number): string {
  const t = Math.max(0, Math.round(sec * 10) / 10);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t - h * 3600 - m * 60;
  const ss = s.toFixed(1).padStart(4, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** What a slider sheet changes. */
type Tool = "speed" | "volume" | "fade";
const RANGE: Record<Tool, { min: number; max: number; step: number }> = {
  speed: { min: 0.25, max: 4, step: 0.05 },
  volume: { min: 0, max: 2, step: 0.05 },
  fade: { min: 0, max: 1.5, step: 0.1 },
};

/** The export job as the PC reports it. */
interface ExportState {
  state: "running" | "done" | "error";
  progress: number;
  path?: string;
  error?: string;
}

/** The props of the phone editor. */
export interface MediaEditorProps {
  item: SurfaceItem;
  /** The finished prep of the file being edited (proxy and sprite ready). */
  info: PrepInfo;
  peaks?: Uint8Array | undefined;
  title: string;
  /** Leaves the editor. */
  onClose: () => void;
  /** A render finished: the new file's path in the chat's folder (the panel lists it as a new version). */
  onExported: (path: string) => void;
}

/**
 * The full-screen phone editor: viewer, transport row, timeline, contextual tool row, slider sheets and the export sheet.
 *
 * @param props - See {@link MediaEditorProps}.
 */
export default function MediaEditor({ item, info, peaks, title, onClose, onExported }: MediaEditorProps) {
  const duration = info.duration ?? 0;
  const [hist, setHist] = useState<History<MediaEdit>>(() => history(wholeFile(duration)));
  /** The edit while a finger or a slider is changing it (not yet an undo step). */
  const [draft, setDraft] = useState<MediaEdit>();
  const edit = draft ?? hist.now;
  const total = editLen(edit);
  const [at, setAt] = useState(0);
  const [pps, setPps] = useState(0);
  const [selected, setSelected] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [tool, setTool] = useState<{ kind: Tool; value: number }>();
  const [exporting, setExporting] = useState(false);
  const vid = useRef<HTMLVideoElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const now = useRef({ edit, at, playing });
  now.current = { edit, at, playing };
  /** The clip being played (so the loop only looks for the next one when this one ends). */
  const playIndex = useRef(0);

  // The first zoom shows the whole edit across the phone's width.
  useEffect(() => {
    if (!pps && root.current) setPps(fitPps(total, root.current.clientWidth || 390));
  }, [pps, total]);
  useEffect(() => {
    root.current?.focus();
  }, []);

  /** Puts the viewer on a clip: its time, speed and volume (the audio element tops at 1; louder is for the render). */
  const aim = (e: MediaEdit, t: number): void => {
    const v = vid.current, loc = locate(e, t);
    if (!v || !loc) return;
    const c = e.video[loc.index]!;
    v.playbackRate = c.speed ?? 1;
    v.volume = Math.min(1, c.volume ?? 1);
    if (Math.abs(v.currentTime - loc.time) > 0.05) v.currentTime = loc.time;
    playIndex.current = loc.index;
  };
  // Scrubbing and editing while paused move the viewer to the playhead.
  useEffect(() => {
    if (!playing) aim(edit, at);
  }, [at, edit, playing]);

  // Playing: the proxy plays stretch by stretch; a clip's end jumps to the next clip's start (no render needed).
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const loop = (): void => {
      const v = vid.current;
      const { edit: e } = now.current;
      const i = playIndex.current, c = e.video[i];
      if (v && c) {
        if (v.currentTime >= c.to - 0.03 || v.ended) {
          const next = e.video[i + 1];
          if (next) {
            playIndex.current = i + 1;
            v.playbackRate = next.speed ?? 1;
            v.volume = Math.min(1, next.volume ?? 1);
            if (Math.abs(v.currentTime - next.from) > 0.05) v.currentTime = next.from;
          } else {
            v.pause();
            setPlaying(false);
            setAt(editLen(e));
            return;
          }
        } else {
          setAt(starts(e)[i]! + Math.max(0, v.currentTime - c.from) / (c.speed ?? 1));
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const play = (): void => {
    const v = vid.current;
    if (!v) return;
    if (playing) {
      v.pause();
      setPlaying(false);
      return;
    }
    const start = at >= total - 0.05 ? 0 : at;
    if (start !== at) setAt(start);
    aim(edit, start);
    void v.play().then(() => setPlaying(true), () => toast(L("הנגן לא התחיל", "The player did not start")));
  };

  const commit = (next: MediaEdit | undefined): void => {
    if (next) setHist((h) => push(h, next));
    setDraft(undefined);
  };
  const seek = (t: number): void => setAt(Math.min(total, Math.max(0, t)));
  const doSplit = (): void => {
    const r = splitAt(edit, at);
    if (!r) return toast(L("אי אפשר לפצל כאן (קצר מ-0.1 שנ')", "Cannot split here (a piece would be under 0.1 s)"));
    commit(r.edit);
    setSelected(r.index);
  };
  const doDelete = (): void => {
    const next = removeClip(edit, selected);
    if (!next) return toast(L("חייב להישאר קטע אחד לפחות", "At least one clip must stay"));
    commit(next);
    setSelected(-1);
    setAt((t) => Math.min(t, editLen(next)));
  };
  const doUndo = (): void => {
    setHist(undo);
    setSelected(-1);
  };
  const doRedo = (): void => {
    setHist(redo);
    setSelected(-1);
  };
  const openTool = (kind: Tool): void => {
    const c = edit.video[selected];
    if (!c) return;
    setTool({ kind, value: kind === "speed" ? (c.speed ?? 1) : kind === "volume" ? (c.volume ?? 1) : (c.into?.seconds ?? 0) });
  };
  const slide = (value: number): void => {
    if (!tool) return;
    setTool({ ...tool, value });
    setDraft(tool.kind === "fade" ? setTransition(hist.now, selected, value) : setClip(hist.now, selected, { [tool.kind]: value }));
  };
  const close = (): void => {
    if (hist.past.length && !window.confirm(L("לצאת בלי לייצא? העריכה תאבד.", "Leave without exporting? The edit is lost."))) return;
    onClose();
  };

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === " ") play();
    else if (e.key === "s" || e.key === "S") doSplit();
    else if ((e.key === "Delete" || e.key === "Backspace") && selected >= 0) doDelete();
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") (e.shiftKey ? doRedo : doUndo)();
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") doRedo();
    else if (e.key === "Escape") (tool ? cancelTool : close)();
    else return;
    e.preventDefault();
  };
  const cancelTool = (): void => {
    setTool(undefined);
    setDraft(undefined);
  };
  const applyTool = (): void => {
    setTool(undefined);
    commit(draft);
  };

  const sel = edit.video[selected];
  const soon = L("בקרוב", "soon");
  return (
    <div ref={root} className="media-editor" role="dialog" aria-modal="true" aria-label={`${L("עריכת וידאו", "Video editor")}: ${title}`} tabIndex={-1} onKeyDown={onKey}>
      <header className="me-top">
        <button type="button" className="ghost me-icon" onClick={close} aria-label={L("סגירת העורך", "Close the editor")}>✕</button>
        <strong className="grow" dir="auto">{title}</strong>
        <button type="button" className="me-export" onClick={() => setExporting(true)} disabled={!total}>{L("ייצוא", "Export")}</button>
      </header>
      <div className="me-viewer" dir="ltr">
        <video ref={vid} src={withToken(`/api/media/${info.id}/proxy`)} playsInline preload="auto" aria-label={title} onEnded={() => undefined} />
      </div>
      <div className="me-transport">
        <button type="button" className="me-play" onClick={play} aria-label={playing ? L("השהיה", "Pause") : L("ניגון", "Play")}>{playing ? "❚❚" : "▶"}</button>
        <span className="me-clock" dir="ltr">{preciseClock(at)} <span className="muted">/ {preciseClock(total)}</span></span>
        <span className="grow" />
        <button type="button" className="ghost me-icon" onClick={doUndo} disabled={!hist.past.length} aria-label={L("ביטול פעולה", "Undo")}>↶</button>
        <button type="button" className="ghost me-icon" onClick={doRedo} disabled={!hist.future.length} aria-label={L("שחזור פעולה", "Redo")}>↷</button>
      </div>
      {pps > 0 && (
        <MediaTimeline
          edit={edit}
          at={at}
          pps={pps}
          selected={selected}
          info={info}
          peaks={peaks}
          label={L("ציר זמן: גרירה לגלילה, צביטה לזום, הקשה כפולה להתאמה, לחיצה ארוכה לסידור מחדש", "Timeline: drag to scrub, pinch to zoom, double-tap to fit, press and hold to reorder")}
          onSeek={seek}
          onSelect={setSelected}
          onZoom={setPps}
          onChange={(e, done) => (done ? commit(e) : setDraft(e))}
        />
      )}
      {tool ? (
        <div className="me-sheet" role="group" aria-label={tool.kind}>
          <div className="me-sheet-row">
            <button type="button" className="ghost me-icon" onClick={cancelTool} aria-label={L("ביטול", "Cancel")}>✕</button>
            <strong className="grow">
              {tool.kind === "speed" ? L("מהירות", "Speed") : tool.kind === "volume" ? L("עוצמה", "Volume") : L("מעבר מהקטע הקודם", "Fade in from the clip before")}
              {": "}
              <span dir="ltr">{tool.kind === "speed" ? `${tool.value.toFixed(2)}×` : tool.kind === "volume" ? `${Math.round(tool.value * 100)}%` : tool.value ? `${tool.value.toFixed(1)} s` : L("חיתוך ישר", "plain cut")}</span>
            </strong>
            <button type="button" className="me-ok" onClick={applyTool} aria-label={L("אישור", "Apply")}>✓</button>
          </div>
          <input type="range" dir="ltr" {...RANGE[tool.kind]} value={tool.value} onChange={(e) => slide(Number(e.target.value))} aria-label={tool.kind} autoFocus />
          {tool.kind === "volume" && tool.value > 1 && <small className="muted">{L("מעל 100% נשמע רק בייצוא", "Above 100% is heard only in the export")}</small>}
        </div>
      ) : (
        <nav className="me-tools" aria-label={L("כלים", "Tools")}>
          <button type="button" onClick={doSplit}><span aria-hidden>✂</span>{L("פיצול", "Split")}</button>
          {sel && <button type="button" onClick={doDelete}><span aria-hidden>🗑</span>{L("מחיקה", "Delete")}</button>}
          {sel && <button type="button" onClick={() => openTool("speed")}><span aria-hidden>⏱</span>{L("מהירות", "Speed")}</button>}
          {sel && <button type="button" onClick={() => openTool("volume")}><span aria-hidden>🔊</span>{L("עוצמה", "Volume")}</button>}
          {sel && <button type="button" onClick={() => openTool("fade")} disabled={selected === 0} title={selected === 0 ? L("אין קטע לפניו", "Nothing before the first clip") : ""}><span aria-hidden>◢</span>{L("מעבר", "Fade")}</button>}
          <button type="button" disabled aria-label={`${L("טקסט", "Text")} (${soon})`}><span aria-hidden>T</span>{L("טקסט", "Text")}<small>{soon}</small></button>
          <button type="button" disabled aria-label={`${L("מוזיקה", "Music")} (${soon})`}><span aria-hidden>♪</span>{L("מוזיקה", "Music")}<small>{soon}</small></button>
        </nav>
      )}
      {exporting && <ExportSheet item={item} info={info} edit={hist.now} onClose={() => setExporting(false)} onExported={onExported} />}
    </div>
  );
}

/** One row of choices in the export sheet. */
function Choices<T extends string | number>({ label, value, options, text, onPick }: { label: string; value: T; options: readonly T[]; text: (v: T) => string; onPick: (v: T) => void }) {
  return (
    <div className="me-choice" role="radiogroup" aria-label={label}>
      <span className="muted small">{label}</span>
      <div className="me-seg" dir="ltr">
        {options.map((o) => (
          <button key={o} type="button" role="radio" aria-checked={o === value} className={o === value ? "on" : ""} onClick={() => onPick(o)}>{text(o)}</button>
        ))}
      </div>
    </div>
  );
}

/**
 * The export sheet (design PhoneMediaExport): size, frame rate and quality, the estimated file size, then the render on
 * the PC with its progress. The sheet sends the edit list and the file's id only.
 */
function ExportSheet({ item, info, edit, onClose, onExported }: { item: SurfaceItem; info: PrepInfo; edit: MediaEdit; onClose: () => void; onExported: (path: string) => void }) {
  const [choice, setChoice] = useState<ExportChoice>({ height: 720, fps: 30, quality: "medium" });
  const [job, setJob] = useState<string>();
  const [st, setSt] = useState<ExportState>();
  const [lost, setLost] = useState(false);
  const [error, setError] = useState("");
  const total = editLen(edit);
  const problem = useMemo(() => {
    try {
      checkMediaEdit(edit, 1);
      return item.convId ? "" : L("אין צ'אט לשמור בו את הקובץ", "There is no chat to save the file in");
    } catch (e) {
      return (e as Error).message;
    }
  }, [edit, item.convId]);

  // Follows the render; a lost connection keeps the job (it runs on the PC) and tries again.
  useEffect(() => {
    if (!job) return;
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = (): void => {
      void api<ExportState>(`/api/media/export/${job}`).then(
        (s) => {
          if (dead) return;
          setLost(false);
          setSt(s);
          if (s.state === "done" && s.path) {
            onExported(s.path);
            toast(L("נשמרה גרסה חדשה.", "Saved a new version."));
          } else if (s.state === "running") timer = setTimeout(poll, 1000);
        },
        () => {
          if (dead) return;
          setLost(true);
          timer = setTimeout(poll, 3000);
        },
      );
    };
    poll();
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [job]);

  const start = async (): Promise<void> => {
    setError("");
    try {
      const r = await api<{ job: string }>("/api/media/export", { method: "POST", body: { conversation: item.convId, sources: [info.id], edit, ...choice } });
      setSt({ state: "running", progress: 0 });
      setJob(r.job);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const running = st?.state === "running";
  return (
    <div className="me-sheet me-export-sheet" role="dialog" aria-label={L("ייצוא", "Export")}>
      <div className="me-sheet-row">
        <button type="button" className="ghost me-icon" onClick={onClose} disabled={running} aria-label={L("סגירה", "Close")}>✕</button>
        <strong className="grow">{L("ייצוא וידאו", "Export video")}</strong>
      </div>
      {st?.state === "done" ? (
        <>
          <p role="status">{L("הסרטון מוכן והוא ברשימת הגרסאות.", "The video is ready, in the versions list.")}</p>
          <button type="button" className="me-export" onClick={onClose}>{L("סיום", "Done")}</button>
        </>
      ) : (
        <>
          <Choices label={L("גודל", "Size")} value={choice.height} options={[720, 1080] as const} text={(v) => `${v}p`} onPick={(height) => setChoice({ ...choice, height })} />
          <Choices label={L("קצב פריימים", "Frame rate")} value={choice.fps} options={[24, 30, 60] as const} text={(v) => `${v}`} onPick={(fps) => setChoice({ ...choice, fps })} />
          <Choices label={L("איכות", "Quality")} value={choice.quality} options={["low", "medium", "high"] as const} text={(v) => (v === "low" ? L("נמוכה", "Low") : v === "medium" ? L("בינונית", "Medium") : L("גבוהה", "High"))} onPick={(quality) => setChoice({ ...choice, quality })} />
          <p className="me-estimate" dir="auto">{L("גודל משוער", "About")} <strong dir="ltr">{sizeText(estimateBytes(total, choice))}</strong> · <span dir="ltr">{preciseClock(total)}</span></p>
          {(problem || error) && <p className="me-error" role="alert">{problem || error}</p>}
          {running ? (
            <div className="me-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((st?.progress ?? 0) * 100)} aria-label={L("התקדמות הייצוא", "Export progress")}>
              <span style={{ width: `${Math.round((st?.progress ?? 0) * 100)}%` }} />
              <small>{Math.round((st?.progress ?? 0) * 100)}%{lost ? ` · ${L("החיבור אבד, מנסה שוב (העבודה נמשכת במחשב)", "connection lost, retrying (the PC keeps working)")}` : ""}</small>
            </div>
          ) : (
            <button type="button" className="me-export" onClick={() => void start()} disabled={!!problem}>{st?.state === "error" ? L("ניסיון חוזר", "Try again") : L("ייצוא", "Export")}</button>
          )}
          {st?.state === "error" && <p className="me-error" role="alert">{st.error}</p>}
        </>
      )}
    </div>
  );
}
