import { useEffect, useRef, useState } from "react";
import { SpeedSelect, useSpeed } from "./MediaSpeed";
import type { StudyLecture, VideoChapter } from "@kesher/shared";
import { api, withToken } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
const clock = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};

/** The YouTube player in the page, driven by its postMessage API (no outside script): time, play, pause, seek. */
function useYouTube(frame: React.RefObject<HTMLIFrameElement | null>, id: string | undefined, onTime: (t: number) => void) {
  useEffect(() => {
    if (!id) return;
    const listen = () => frame.current?.contentWindow?.postMessage(JSON.stringify({ event: "listening", id: 1 }), "https://www.youtube-nocookie.com");
    const on = (e: MessageEvent) => {
      if (e.origin !== "https://www.youtube-nocookie.com" || typeof e.data !== "string") return;
      try {
        const d = JSON.parse(e.data) as { event?: string; info?: { currentTime?: number } };
        if (d.event === "infoDelivery" && typeof d.info?.currentTime === "number") onTime(d.info.currentTime);
      } catch {
        // Not the player's message.
      }
    };
    addEventListener("message", on);
    const t = setInterval(listen, 1000);
    return () => {
      removeEventListener("message", on);
      clearInterval(t);
    };
  }, [id]);
  return (func: "playVideo" | "pauseVideo" | "seekTo" | "setPlaybackRate", args: unknown[] = []) => frame.current?.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args }), "https://www.youtube-nocookie.com");
}

/**
 * A video lecture (design VideoLecture, like Edpuzzle and Panopto's in-video quizzes): the video (YouTube, her MP4,
 * or one brought from Panopto/Kaltura), its chapters with a short summary each, and a question at the end of each
 * chapter: the video pauses there; a wrong answer offers to go back to the chapter's start.
 */
export function StudyVideoLecture({ base, lecture, onLecture }: { base: string; lecture: StudyLecture; onLecture: (l: StudyLecture) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [now, setNow] = useState(0);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<number | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const answered = useRef(new Set<number>());
  const [, rerender] = useState(0);
  const chapters: VideoChapter[] = lecture.chapters ?? [];
  const yt = useYouTube(frame, lecture.videoFile ? undefined : lecture.youtube, (t) => setNow(t));
  const [rate, setRate] = useSpeed();
  const ytNow = useRef(yt);
  ytNow.current = yt;
  useEffect(() => {
    if (video.current) video.current.playbackRate = rate;
    else ytNow.current("setPlaybackRate", [Math.min(2, rate)]);
  }, [rate]);
  const seek = (t: number) => {
    if (video.current) {
      video.current.currentTime = t;
      void video.current.play().catch(() => undefined);
    } else {
      yt("seekTo", [t, true]);
      yt("playVideo");
    }
  };
  const pause = () => (video.current ? video.current.pause() : yt("pauseVideo"));
  const current = chapters.findIndex((c) => now >= c.start && now < c.end);
  // Near the end (95% of the last chapter): watched, once, for a daily goal of videos.
  const counted = useRef(false);
  useEffect(() => {
    const end = chapters.at(-1)?.end ?? 0;
    if (!counted.current && end > 60 && now >= end * 0.95) {
      counted.current = true;
      void api("/api/study/activity/video", { method: "POST" }).catch(() => undefined);
    }
  }, [now, chapters]);
  // A chapter's end with a question not answered yet: pause and ask.
  useEffect(() => {
    if (asking !== null) return;
    const i = chapters.findIndex((c) => c.question && !answered.current.has(chapters.indexOf(c)) && now >= c.end - 1.5 && now < c.end + 3);
    if (i >= 0) {
      pause();
      setAsking(i);
      setPicked(null);
    }
  }, [now]);
  const make = () => {
    setBusy(true);
    void api<StudyLecture>(`${base}/chapters`, { method: "POST" }).then(onLecture, (e: Error) => toast(e.message)).finally(() => setBusy(false));
  };
  const q = asking !== null ? chapters[asking]?.question : undefined;
  const done = (i: number) => {
    answered.current.add(i);
    setAsking(null);
    rerender((n) => n + 1);
  };
  return (
    <div className="video-lecture">
      <div className="row vl-speed">
        {/* Speed for the kept video (0.25×–4×); YouTube's own player goes from 0.25× to 2×. */}
        <SpeedSelect rate={rate} onRate={setRate} {...(lecture.videoFile ? {} : { max: 2 })} />
      </div>
      <div className="vl-stage">
        {lecture.videoFile ? (
          <video ref={video} src={withToken(`${base}/video-file`)} controls preload="metadata" onLoadedMetadata={(e) => (e.currentTarget.playbackRate = rate)} onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)} />
        ) : lecture.youtube ? (
          <iframe ref={frame} title={lecture.title} src={`https://www.youtube-nocookie.com/embed/${lecture.youtube}?enablejsapi=1&rel=0&origin=${encodeURIComponent(location.origin)}`} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen />
        ) : null}
        {q && asking !== null && (
          <div className="vl-question">
            <div className="card stack">
              <span className="vl-q-chip">⏸ {L(`שאלה על פרק ${asking + 1}`, `A question on chapter ${asking + 1}`)}</span>
              <b dir="auto">{q.q}</b>
              {q.options.map((o, i) => (
                <button key={i} type="button" dir="auto" className={`vl-option${picked === null ? "" : i === q.answer ? " right" : i === picked ? " wrong" : ""}`} disabled={picked !== null} onClick={() => setPicked(i)}>
                  {o}{picked !== null && i === q.answer ? " ✓" : ""}
                </button>
              ))}
              {picked !== null && q.explain && <p className="muted small" dir="auto">{q.explain}</p>}
              <div className="row wrap">
                <button type="button" className="primary" onClick={() => { done(asking); seek(chapters[asking]!.end + 0.5); }}>{L("המשך ▶", "Continue ▶")}</button>
                {picked !== null && picked !== q.answer && <button type="button" onClick={() => { done(asking); seek(chapters[asking]!.start); }}>⏪ {L(`חזור לתחילת הפרק (${clock(chapters[asking]!.start)})`, `Back to the chapter's start (${clock(chapters[asking]!.start)})`)}</button>}
                {picked === null && <button type="button" className="ghost" onClick={() => { done(asking); seek(chapters[asking]!.end + 0.5); }}>{L("דלג", "Skip")}</button>}
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="vl-side">
        <b>{L("פרקים", "Chapters")}</b>
        {!chapters.length && (
          <div className="stack">
            <p className="muted small">{L("קשר יחלק את הסרטון לפרקים לפי הנושאים, עם סיכום קצר ושאלה בסוף כל פרק. הסרטון יעצור לשאול.", "KesherAI splits the video into chapters by topic, with a short summary and a question at the end of each. The video stops to ask.")}</p>
            <button type="button" className="primary" disabled={busy} onClick={make}>{busy ? L("מחלק לפרקים… (כמה דקות)", "Splitting into chapters… (a few minutes)") : L("חלק לפרקים עם שאלות", "Split into chapters with questions")}</button>
          </div>
        )}
        {chapters.map((c, i) => (
          <button key={i} type="button" className={`vl-chapter${i === current ? " on" : ""}`} onClick={() => seek(c.start)}>
            <span className={`vl-num${answered.current.has(i) ? " done" : ""}`}>{answered.current.has(i) ? "✓" : i + 1}</span>
            <span className="grow"><span dir="auto">{c.title}</span><span className="muted small" dir="ltr">{clock(c.start)} – {clock(c.end)}</span></span>
            {c.question && !answered.current.has(i) && <span className="vl-q">?</span>}
          </button>
        ))}
      </div>
      {current >= 0 && chapters[current]?.summary && <p className="vl-summary" dir="auto"><b>{L(`פרק ${current + 1} בקצרה:`, `Chapter ${current + 1} in short:`)}</b> {chapters[current]!.summary}</p>}
    </div>
  );
}
