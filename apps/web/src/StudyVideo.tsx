import { useEffect, useRef, useState } from "react";
import { pptxFiles, type StudyLecture, type StudyPicture, type VideoSlide } from "@kesher/shared";
import { strToU8, zipSync } from "fflate";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";
import { speak, stopSpeaking } from "./Speak";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
const TONES = ["#a5b4ff", "#7fd8a8", "#f0a830", "#e88ad8", "#6ac0d0", "#f07a5a"];

/**
 * A lecture's video overview (design VideoOverview, like NotebookLM's): narrated slides from the lecture, read aloud
 * with her chosen voice, one slide after another; chapters to jump; free Wikimedia pictures on the slides that ask
 * for one (with their author and licence). Made once and kept with the lecture; works on the phone too.
 */
export function StudyVideo({ base, lecture, onLecture }: { base: string; lecture: StudyLecture; onLecture: (l: StudyLecture) => void }) {
  const slides: VideoSlide[] = lecture.video ?? [];
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pics, setPics] = useState<StudyPicture[] | null>(null);
  const run = useRef(0);
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => () => stopSpeaking(), []);
  useEffect(() => {
    if (!slides.some((s) => s.picture) || pics) return;
    void api<{ pictures: StudyPicture[] }>(`${base}/pictures?kind=picture`).then((r) => setPics(r.pictures.filter((p) => !p.video)), () => setPics([]));
  }, [slides.length]);
  const play = (from: number) => {
    const token = ++run.current;
    setAt(from);
    setPlaying(true);
    const next = (i: number) => {
      if (token !== run.current) return;
      if (i >= slides.length) {
        setPlaying(false);
        // Watched to the end: counts toward a daily goal of videos.
        if (from === 0) void api("/api/study/activity/video", { method: "POST" }).catch(() => undefined);
        return;
      }
      setAt(i);
      void speak(slides[i]!.say, () => next(i + 1));
    };
    stopSpeaking();
    next(from);
  };
  const pause = () => {
    run.current++;
    stopSpeaking();
    setPlaying(false);
  };
  if (!slides.length) {
    return (
      <div className="study-empty">
        <p className="muted">{L("סרטון קצר של שקפים עם קריינות, מתוך ההרצאה בלבד. נוצר פעם אחת ונשמר.", "A short video of narrated slides, from the lecture only. Made once and kept.")}</p>
        <button type="button" className="primary" disabled={busy} onClick={() => { setBusy(true); void api<StudyLecture>(`${base}/video`, { method: "POST" }).then(onLecture, (e: Error) => toast(e.message)).finally(() => setBusy(false)); }}>{busy ? L("מכין שקפים… (כמה דקות)", "Making slides… (a few minutes)") : L("🎬 צור סרטון סקירה", "🎬 Make a video overview")}</button>
      </div>
    );
  }
  const s = slides[at]!;
  const picIndex = slides.slice(0, at + 1).filter((x) => x.picture).length - 1;
  const pic = s.picture && pics?.length ? pics[picIndex % pics.length] : undefined;
  const tone = TONES[at % TONES.length]!;
  return (
    <div className="video-overview">
      <div className="video-stage" ref={stage} style={{ ["--tone" as string]: tone }}>
        <div className="video-slide">
          <div className="video-text">
            <span className="video-count" style={{ color: tone, borderColor: tone }}>{L(`שקופית ${at + 1} מתוך ${slides.length}`, `Slide ${at + 1} of ${slides.length}`)}</span>
            <h3 dir="auto">{s.title}</h3>
            <ul dir="auto">{s.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>
          </div>
          {pic && (
            <figure className="video-pic">
              <img src={pic.src} alt={s.title} loading="lazy" />
              <figcaption className="small" dir="auto">{pic.artist} · {pic.license}</figcaption>
            </figure>
          )}
        </div>
        <div className="video-bar">
          <button type="button" className="ghost" aria-label={playing ? L("עצור", "Pause") : L("נגן", "Play")} onClick={() => (playing ? pause() : play(at))}>{playing ? "⏸" : "▶"}</button>
          <button type="button" className="ghost" aria-label={L("הקודמת", "Previous")} disabled={at === 0} onClick={() => (playing ? play(at - 1) : setAt(at - 1))}>⏮</button>
          <span className="video-progress"><span style={{ width: `${((at + 1) / slides.length) * 100}%` }} /></span>
          <button type="button" className="ghost" aria-label={L("הבאה", "Next")} disabled={at >= slides.length - 1} onClick={() => (playing ? play(at + 1) : setAt(at + 1))}>⏭</button>
        </div>
      </div>
      <ol className="video-chapters">
        {slides.map((x, i) => <li key={i}><button type="button" className={i === at ? "on" : ""} onClick={() => (playing ? play(i) : setAt(i))} dir="auto">{x.title}</button></li>)}
      </ol>
      <p className="muted small video-say" dir="auto">{s.say}</p>
      <div className="row video-deck">
        <button type="button" onClick={() => void stage.current?.requestFullscreen?.().catch(() => undefined)}>🖥 {L("להציג (מסך מלא)", "Present (full screen)")}</button>
        <button type="button" onClick={() => downloadDeck(lecture.title, slides)}>⬇ {L("PowerPoint עם הערות דובר", "PowerPoint with speaker notes")}</button>
      </div>
    </div>
  );
}

/** The slides as an editable .pptx (the narration in the speaker notes), downloaded. */
function downloadDeck(title: string, slides: VideoSlide[]) {
  const files = pptxFiles(title, slides.map((x) => ({ title: x.title, bullets: x.bullets, notes: x.say })));
  const zip = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([zip], { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }));
  a.download = `${title.replace(/[\\/:*?"<>|]+/g, "").slice(0, 80) || "slides"}.pptx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
