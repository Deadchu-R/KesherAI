/**
 * One lecture: its text with time stamps, audio, pictures, notes, terms and the glossary, and the flow diagram.
 * Part of the Study page (pages/StudyPage.tsx).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { SpeedSelect, useSpeed } from "../../MediaSpeed";
import { ReadAlong } from "../../ReadAlong";
import { StudyTopicVideos } from "../../StudyTopicVideos";
import { StudyPortions } from "../../StudyPortions";
import { StudyTimeNotes, clockOf } from "../../StudyTimeNotes";
import { StudyHighlights } from "../../StudyHighlights";
import { StudySheet } from "../../StudySheet";
import { StudySlides } from "../../StudySlides";
import { OcclusionEditor } from "../../StudyOcclusion";
import { noteCards, parsePodcast, type TermPlace, type StudyPicture, type StudyMediaKind, clinicalField, STUDY_FORMATS, type StudyDrug, type StudyCard, type StudyFormat, type StudyLecture, type StudyTerm } from "@kesher/shared";
import { api, withToken } from "../../api";
import { speak, speakDialog, stopSpeaking } from "../../Speak";
import { toast } from "../../library";
import { RichText } from "../../RichText";
import { parseFlow } from "../../study-diagram";
import { StudyVideo } from "../../StudyVideo";
import { StudyTeachBack } from "../../StudyTeachBack";
import { StudyVideoLecture } from "../../StudyVideoLecture";
import { L, LectureRow, askChat, call, fmtName, go } from "./common";

/** A lecture's flowchart as boxes and arrows (or its source, when it is not a simple flowchart). */
function FlowView({ src }: { src: string }) {
  const flow = useMemo(() => parseFlow(src), [src]);
  if (!flow) return <pre className="study-diagram-src" dir="ltr">{src}</pre>;
  const label = (id: string) => flow.nodes.find((n) => n.id === id)?.label ?? id;
  // Follow the arrows from the first box; boxes not reached are listed after.
  const order: string[] = [];
  const visit = (id: string) => {
    if (order.includes(id)) return;
    order.push(id);
    flow.edges.filter((e) => e.from === id).forEach((e) => visit(e.to));
  };
  flow.nodes.forEach((n) => visit(n.id));
  return (
    <div className={`study-flow ${flow.dir === "LR" ? "row" : "col"}`} dir="ltr" role="img" aria-label={flow.edges.map((e) => `${label(e.from)} → ${label(e.to)}`).join(", ")}>
      {order.map((id, i) => {
        const into = flow.edges.find((e) => e.to === id && order.indexOf(e.from) === i - 1);
        return (
          <span key={id} className="study-flow-step">
            {i > 0 && <span className="study-flow-arrow" aria-hidden="true">{into?.label ? <small>{into.label}</small> : null}→</span>}
            <span className="study-flow-box" dir="auto">{label(id)}</span>
          </span>
        );
      })}
    </div>
  );
}

/** The lecture's text with each [mm:ss] mark as a button that plays the kept recording from there. */
function StampedText({ text, onSeek, now }: { text: string; onSeek: (sec: number) => void; now?: number }) {
  const lines = text.split("\n");
  const secOf = (line: string) => {
    const m = /^\[(?:(\d+):)?(\d+):(\d\d)\]/.exec(line);
    return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : undefined;
  };
  // The line being heard (design: listening controls, students part 28 #3): the last mark at or before the sound.
  let current = -1;
  if (now !== undefined) lines.forEach((line, i) => { const s = secOf(line); if (s !== undefined && s <= now) current = i; });
  const here = useRef<HTMLDivElement>(null);
  useEffect(() => {
    here.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [current]);
  return (
    <>
      {lines.map((line, i) => {
        const m = /^\[(?:(\d+):)?(\d+):(\d\d)\]/.exec(line);
        if (!m) return <div key={i} className={current >= 0 && i > current && lines.slice(current + 1, i).every((x) => secOf(x) === undefined) ? "study-now" : ""}>{line || "\u00a0"}</div>;
        const sec = secOf(line)!;
        return (
          <div key={i} ref={i === current ? here : undefined} className={i === current ? "study-now" : ""}>
            <button type="button" className="study-stamp" dir="ltr" title={L("לנגן מכאן", "Play from here")} onClick={() => onSeek(sec)}>{m[0]}</button>{line.slice(m[0].length)}
          </div>
        );
      })}
    </>
  );
}

type RecordingSettings = { keep: boolean; deleteAfter: "never" | "30" | "90" | "semester"; asked?: boolean };

/** The kept recording: a player (the text's minute marks play from there), delete, and the first-time question. */
function LectureAudio({ courseId, lecture, player, startAt, onRemoved, onTime }: { courseId: string; lecture: StudyLecture; player: React.RefObject<HTMLAudioElement | null>; startAt?: number; onRemoved: () => void; onTime?: (sec: number) => void }) {
  const [settings, setSettings] = useState<RecordingSettings | null>(null);
  // Listening speed, the same for every player, remembered on this device (0.25×–4×).
  const [rate, setRate] = useSpeed();
  useEffect(() => {
    if (player.current) player.current.playbackRate = rate;
  }, [rate, player]);
  const skip = (d: number) => { const a = player.current; if (a) a.currentTime = Math.max(0, a.currentTime + d); };
  useEffect(() => void api<RecordingSettings>("/api/study/recordings").then(setSettings, () => undefined), []);
  const src = withToken(`/api/study/courses/${courseId}/lectures/${lecture.id}/recording`);
  const choose = async (deleteAfter: RecordingSettings["deleteAfter"]) => {
    const r = await call(api<RecordingSettings>("/api/study/recordings", { method: "PUT", body: { deleteAfter, asked: true } }));
    if (r) setSettings(r);
  };
  const mb = Math.max(1, Math.round((lecture.recording?.bytes ?? 0) / 1024 / 1024));
  return (
    <div className="study-audio">
      <audio ref={player} controls preload="metadata" src={src} onLoadedMetadata={(e) => { e.currentTarget.playbackRate = rate; if (startAt !== undefined && e.currentTarget.currentTime < 1) e.currentTarget.currentTime = startAt; }} onTimeUpdate={(e) => onTime?.(e.currentTarget.currentTime)} />
      <div className="row study-audio-tools" dir="ltr">
        <button type="button" className="ghost small" onClick={() => skip(-10)} aria-label={L("10 שניות אחורה", "Back 10 seconds")}>↺ 10</button>
        <button type="button" className="ghost small" onClick={() => skip(10)} aria-label={L("10 שניות קדימה", "Forward 10 seconds")}>10 ↻</button>
        <span className="grow" />
        <SpeedSelect rate={rate} onRate={setRate} />
      </div>
      <div className="row small">
        <span className="muted">{L(`ההקלטה נשמרה במחשב (${mb}MB). לחיצה על דקה בטקסט המלא מנגנת משם.`, `The recording is kept on the computer (${mb} MB). A minute in the full text plays from there.`)}</span>
        <button type="button" className="small ghost" onClick={async () => {
          if (!confirm(L("למחוק את ההקלטה? התמלול נשאר. אי אפשר לבטל.", "Delete the recording? The transcript stays. This cannot be undone."))) return;
          if (await call(api(`/api/study/courses/${courseId}/lectures/${lecture.id}/recording`, { method: "DELETE" }))) onRemoved();
        }}>{L("מחיקת ההקלטה", "Delete the recording")}</button>
      </div>
      {settings && !settings.asked && (
        <div className="card study-rec-ask">
          <strong>{L("ההקלטות נשמרות", "Recordings are kept")}</strong>
          <p className="small">{L("הרצאה של שעה וחצי היא בערך 20MB. למחוק אותן אוטומטית?", "A 90-minute lecture is about 20 MB. Delete them automatically?")}</p>
          <div className="row wrap">
            <button type="button" className="primary" onClick={() => void choose("never")}>{L("לא למחוק אף פעם", "Never delete")}</button>
            <button type="button" onClick={() => void choose("30")}>{L("אחרי 30 יום", "After 30 days")}</button>
            <button type="button" onClick={() => void choose("90")}>{L("אחרי 90 יום", "After 90 days")}</button>
            <button type="button" onClick={() => void choose("semester")}>{L("אחרי סוף הסמסטר", "After the semester ends")}</button>
          </div>
          <p className="muted small">{L("סוף הסמסטר לכל קורס: לפי המבחן האחרון בסילבוס או תאריך המבחן, או תאריך שתכתבי בקורס. אפשר לשנות בהגדרות ← לימודים.", "Each course's semester end: its syllabus's last exam or its exam date, or a date you write on the course. Change it in Settings → Study.")}</p>
        </div>
      )}
    </div>
  );
}

/** One lecture: its text or recording, summary, terms, diagram, pictures, notes and the cards made from it. */
export function LectureView({ courseId, lectureId, courseField, startAt, onChange }: { courseId: string; lectureId: string; courseField?: string; startAt?: number; onChange: () => void }) {
  const [l, setL] = useState<StudyLecture | null>(null);
  const [view, setView] = useState<"watch" | "summary" | "terms" | "diagram" | "video" | "teach" | "read" | "sheet" | "slides" | "portions" | "text">("summary");
  // A video lecture opens on its video.
  useEffect(() => {
    if (l?.youtube || l?.videoFile) setView("watch");
  }, [l?.id]);
  const player = useRef<HTMLAudioElement>(null);
  // Where the recording is (the full text marks the line being heard).
  const [heard, setHeard] = useState<number>();
  // The audio review's speed (0.25×–4×), the same as every player.
  const [speakRate, setSpeakRate] = useSpeed();
  // Making image occlusion cards (design ImageOcclusion).
  const [occ, setOcc] = useState(false);
  // "Explain this": text she selected in the lecture, and its explanation.
  const [sel, setSel] = useState("");
  const [explained, setExplained] = useState("");
  const [explaining, setExplaining] = useState(false);
  const pickSelection = () => {
    const t = window.getSelection()?.toString().trim() ?? "";
    if (t.length >= 3 && t !== sel) { setSel(t.slice(0, 3000)); setExplained(""); }
  };
  const explainSel = async (kind: "explain" | "simple" | "example") => {
    setExplaining(true);
    const r = await call(api<{ text: string }>(`/api/study/courses/${courseId}/lectures/${lectureId}/explain`, { method: "POST", body: { text: sel, kind } }));
    setExplaining(false);
    if (r) setExplained(r.text);
  };
  const selToCard = async () => {
    const front = L(`מה המשמעות של: "${sel.slice(0, 200)}"?`, `What does this mean: "${sel.slice(0, 200)}"?`);
    const r = await call(api(`/api/study/courses/${courseId}/cards`, { method: "POST", body: { front, back: explained.slice(0, 3000), lectureId } }));
    if (r) { toast(L("נוספה כרטיסייה", "Card added")); onChange(); }
  };
  const [busy, setBusy] = useState("");
  const [format, setFormat] = useState<StudyFormat>("text");
  const base = `/api/study/courses/${courseId}/lectures/${lectureId}`;
  useEffect(() => void api<StudyLecture>(base).then(setL, (e: Error) => toast(e.message)), [base]);
  const [playing, setPlaying] = useState(false);
  // The two-voice podcast (design Podcast): the line being heard, or null when it is not playing.
  const [talkLine, setTalkLine] = useState<number | null>(null);
  const podcast = async () => {
    if (talkLine !== null) {
      stopSpeaking();
      setTalkLine(null);
      return;
    }
    setPlaying(false);
    let text = l?.podcast;
    if (!text) {
      setBusy("podcast");
      const r = await call(api<StudyLecture>(`${base}/podcast`, { method: "POST" }));
      setBusy("");
      if (!r?.podcast) return;
      setL(r);
      text = r.podcast;
    }
    setTalkLine(0);
    speakDialog(parsePodcast(text), () => setTalkLine(null), speakRate, 0, setTalkLine);
  };
  useEffect(() => () => stopSpeaking(), []);
  if (!l) return <p className="muted">…</p>;
  const run = async (what: string, p: () => Promise<unknown>) => {
    setBusy(what);
    await p();
    setBusy("");
  };
  const summarize = () => run("summary", async () => {
    const r = await call(api<StudyLecture>(`${base}/summarize`, { method: "POST" }));
    if (r) { setL(r); onChange(); }
  });
  /** The spoken review: made once by the chat model, then read aloud with her chosen voice. */
  const listen = async () => {
    if (playing) {
      stopSpeaking();
      setPlaying(false);
      return;
    }
    let text = l.audio;
    if (!text) {
      setBusy("audio");
      const r = await call(api<StudyLecture>(`${base}/audio`, { method: "POST" }));
      setBusy("");
      if (!r?.audio) return;
      setL(r);
      text = r.audio;
    }
    setPlaying(true);
    void speak(text, () => setPlaying(false), speakRate);
  };
  const makeCards = (cloze = false) => run(cloze ? "cloze" : "cards", async () => {
    const r = await call(api<{ cards: StudyCard[] }>(`${base}/cards`, { method: "POST", body: { format, count: 12, ...(cloze ? { cloze: true } : {}) } }));
    if (r) { toast(L(`נוצרו ${r.cards.length} כרטיסיות`, `${r.cards.length} cards made`)); onChange(); }
  });
  return (
    <article className="study-lecture card">
      <h2 dir="auto">{l.title}</h2>
      {l.web && <p className="muted small">🔗 {L("נשמר מ:", "Saved from:")} <a href={l.web} target="_blank" rel="noopener noreferrer" dir="ltr">{l.web.replace(/^https?:\/\//, "").slice(0, 80)}</a></p>}
      {l.recording && <LectureAudio courseId={courseId} lecture={l} player={player} {...(startAt !== undefined && !(l.youtube || l.videoFile) ? { startAt } : {})} onRemoved={() => setL({ ...l, recording: undefined })} onTime={(t) => setHeard(Math.floor(t))} />}
      {l.recording && !(l.youtube || l.videoFile) && <StudyTimeNotes base={base} lecture={l} now={heard ?? 0} onLecture={setL} onSeek={(sec) => { const a = player.current; if (a) { a.currentTime = sec; void a.play().catch(() => undefined); } }} />}
      <div className="seg-pills" role="tablist" aria-label={L("תצוגה", "View")}>
        {(["watch", "summary", "terms", "diagram", "sheet", "slides", "video", "teach", "read", "portions", "text"] as const).filter((v) => (v !== "watch" || l.youtube || l.videoFile) && (v !== "portions" || l.text.length > 12_000)).map((v) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
            {{ watch: L("▶ הרצאה בווידאו", "▶ Video lecture"), summary: L("סיכום", "Summary"), terms: L("מונחים", "Terms"), diagram: L("תרשים", "Diagram"), video: L("🎬 סרטון", "🎬 Video"), teach: L("🎓 ללמד בחזרה", "🎓 Teach back"), read: L("🖍 קריאה והדגשה", "🖍 Read and highlight"), sheet: L("📄 דף סיכום", "📄 One-page sheet"), portions: L("📖 קריאה במנות", "📖 Read in portions"), slides: L("📑 שקפים", "📑 Slides"), text: L("הטקסט המלא", "Full text") }[v]}
          </button>
        ))}
      </div>
      <div className="study-lecture-body" onMouseUp={pickSelection} onTouchEnd={() => setTimeout(pickSelection, 50)} onKeyUp={pickSelection}>
        {view === "watch" ? <StudyVideoLecture base={base} lecture={l} {...(startAt !== undefined ? { startAt } : {})} onLecture={setL} />
          : view === "video" ? <StudyVideo base={base} lecture={l} onLecture={setL} />
          : view === "teach" ? <StudyTeachBack base={base} lecture={l} />
          : view === "slides" ? <StudySlides base={base} slides={l.slides ?? []} heard={heard} hasRecording={!!l.recording} onSlides={(sl) => setL({ ...l, slides: sl })} onSeek={(sec) => { const a = player.current; if (a) { a.currentTime = sec; void a.play().catch(() => undefined); } }} />
          : view === "sheet" ? <StudySheet lecture={l} {...(l.diagram ? { diagram: <FlowView src={l.diagram} /> } : {})} />
          : view === "portions" ? <StudyPortions base={base} lecture={l} onLecture={setL} onCards={onChange} />
          : view === "read" ? <StudyHighlights key={l.id} base={base} text={l.text} initial={l.highlights ?? []} onCards={onChange} />
          : view === "text" ? <div className="study-text" dir="auto">{l.recording ? <StampedText text={l.text} {...(heard !== undefined ? { now: heard } : {})} onSeek={(sec) => { const a = player.current; if (a) { a.currentTime = sec; void a.play().catch(() => undefined); } }} /> : l.youtube ? <StampedText text={l.text} onSeek={(sec) => window.open(`https://www.youtube.com/watch?v=${l.youtube}&t=${sec}s`, "_blank", "noopener")} /> : <ReadAlong text={l.text} plain />}</div>
          : !l.summary ? (
            <div className="study-empty">
              <p className="muted">{L("עוד לא סוכם. הסיכום, המונחים והתרשים נכתבים מהטקסט של ההרצאה בלבד.", "Not summarized yet. The summary, terms and diagram come from the lecture's text only.")}</p>
              <button type="button" className="primary" disabled={!!busy} onClick={() => void summarize()}>{busy === "summary" ? L("מסכם… (הרצאה ארוכה לוקחת כמה דקות)", "Summarizing… (a long lecture takes a few minutes)") : L("סכם את ההרצאה", "Summarize the lecture")}</button>
            </div>
          ) : view === "summary" ? <ReadAlong text={l.summary} />
          : view === "terms" ? <TermList terms={l.terms ?? []} courseId={courseId} />
          : l.diagram ? <FlowView src={l.diagram} /> : <p className="muted">{L("בהרצאה הזאת אין תהליך שמתאים לתרשים.", "This lecture has no process that fits a diagram.")}</p>}
      </div>
      <LectureNotes key={l.id} base={base} notes={l.notes ?? ""} />
      <LecturePictures key={`p${l.id}`} base={base} />
      {sel && (
        <div className="study-explain" aria-live="polite">
          <p className="muted small" dir="auto">{L("נבחר: ", "Selected: ")}“{sel.length > 140 ? `${sel.slice(0, 140)}…` : sel}”</p>
          <div className="study-actions">
            {(["explain", "simple", "example"] as const).map((k) => <button key={k} type="button" disabled={explaining} onClick={() => void explainSel(k)}>{{ explain: L("הסבר", "Explain"), simple: L("בפשטות", "Simpler"), example: L("דוגמה", "Example") }[k]}</button>)}
            {explained && <button type="button" onClick={() => void selToCard()}>{L("לכרטיסייה", "To a card")}</button>}
            <button type="button" className="ghost" onClick={() => { setSel(""); setExplained(""); }}>{L("סגירה", "Close")}</button>
          </div>
          {explaining && <p className="muted">{L("מסבירה…", "Explaining…")}</p>}
          {explained && <div dir="auto"><RichText text={explained} /></div>}
        </div>
      )}
      <div className="study-actions">
        <button type="button" className={playing ? "primary" : ""} disabled={busy === "audio"} onClick={() => void listen()}>{busy === "audio" ? L("כותב סקירה קולית…", "Writing the audio review…") : playing ? L("⏹ עצירה", "⏹ Stop") : L("🎧 האזנה לסקירה (כ-3 דקות)", "🎧 Listen to a review (about 3 minutes)")}</button>
        <button type="button" className={talkLine !== null ? "primary" : ""} disabled={busy === "podcast"} onClick={() => void podcast()}>{busy === "podcast" ? L("כותב שיחה בין שני מגישים…", "Writing a talk between two hosts…") : talkLine !== null ? L("⏹ עצירה", "⏹ Stop") : L("🎙 פודקאסט בשני קולות", "🎙 A two-voice podcast")}</button>
        <SpeedSelect rate={speakRate} onRate={setSpeakRate} />
      </div>
      {!l.youtube && !l.videoFile && <StudyTopicVideos key={`videos-${l.id}`} courseId={courseId} topic={`${l.title} ${(l.terms ?? []).slice(0, 2).map((t) => t.term).join(" ")}`.trim()} />}
      {talkLine !== null && l.podcast && (() => { const line = parsePodcast(l.podcast)[talkLine]; return line ? <p className={`study-podcast-line host${line.host}`} dir="auto"><b>{line.host ? L("איתי", "Itai") : L("נועה", "Noa")}:</b> {line.text}</p> : null; })()}
      {l.summary && view !== "text" && <button type="button" className="small ghost" disabled={!!busy} onClick={() => void summarize()}>{busy === "summary" ? "…" : L("סכם מחדש", "Summarize again")}</button>}
      <h3>{L("להפוך לכרטיסיות, בפורמט:", "Make cards, studied as:")}</h3>
      <div className="study-formats" role="radiogroup" aria-label={L("פורמט", "Format")}>
        {STUDY_FORMATS.map((f) => <button key={f} type="button" role="radio" aria-checked={format === f} className={`chip${format === f ? " on" : ""}`} onClick={() => setFormat(f)}>{fmtName(f)}</button>)}
      </div>
      <div className="study-actions">
        <button type="button" className="primary" disabled={!!busy} onClick={() => void makeCards()}>{busy === "cards" ? L("יוצר כרטיסיות…", "Making cards…") : L("צור 12 כרטיסיות", "Make 12 cards")}</button>
        <button type="button" disabled={!!busy} aria-expanded={occ} onClick={() => setOcc(!occ)}>🖼 {L("כרטיסיות הסתרה על תמונה", "Image occlusion cards")}</button>
        <button type="button" disabled={!!busy} onClick={() => void makeCards(true)}>{busy === "cloze" ? L("יוצר…", "Making…") : L("השלמת משפטים (_____)", "Fill in the blank (_____)")}</button>
        <a className="button" href={`#/study/${courseId}/quiz?l=${l.id}`}>{L("בוחן על ההרצאה", "Quiz on this lecture")}</a>
        <button type="button" onClick={() => askChat(L(
          `מצא 3–5 סרטונים ומאמרים טובים על "${l.title}"${l.terms?.length ? ` (${l.terms.slice(0, 6).map((t) => t.en || t.term).join(", ")})` : ""}: עדיף בעברית, אחרת באנגלית, ממקורות אמינים (אוניברסיטאות, ארגוני בריאות, ספרות מקצועית). לכל אחד: קישור, מקור, אורך, ומשפט למה הוא עוזר.`,
          `Find 3–5 good videos and articles about "${l.title}"${l.terms?.length ? ` (${l.terms.slice(0, 6).map((t) => t.en || t.term).join(", ")})` : ""} from reliable sources (universities, health bodies, professional literature). For each: link, source, length, and one line on why it helps.`,
        ))}>{L("מצא סרטונים ומאמרים", "Find videos and articles")}</button>
        {clinicalField(courseField) && <button type="button" disabled={!!busy} onClick={() => void run("drugs", async () => {
          const r = await call(api<{ drugs: StudyDrug[] }>(`${base}/drugs`, { method: "POST" }));
          if (r) { toast(L("כרטיסי התרופות עודכנו", "Drug cards updated")); onChange(); go(`#/study/${courseId}/drugs`); }
        })}>{busy === "drugs" ? L("כותב כרטיסי תרופות…", "Writing drug cards…") : L("כרטיסי תרופות מההרצאה", "Drug cards from this lecture")}</button>}
        <button type="button" className="ghost" onClick={async () => {
          if (!confirm(L("למחוק את ההרצאה? הכרטיסיות שלה נשארות.", "Delete this lecture? Its cards stay."))) return;
          if (await call(api(base, { method: "DELETE" }))) { onChange(); go(`#/study/${courseId}`); }
        }}>{L("מחק הרצאה", "Delete lecture")}</button>
      </div>
      {occ && <OcclusionEditor courseId={courseId} lectureId={l.id} onDone={(n) => { setOcc(false); toast(L(`נוצרו ${n} כרטיסיות הסתרה`, `${n} occlusion cards made`)); onChange(); }} />}
    </article>
  );
}

/**
 * Free pictures, animations (GIF) and videos of the lecture's topic from Wikimedia Commons, each with its licence and
 * author. A video shows its still here and opens on Commons (the page plays nothing from another site).
 */
function LecturePictures({ base }: { base: string }) {
  const [kind, setKind] = useState<StudyMediaKind>("image");
  const [got, setGot] = useState<Partial<Record<StudyMediaKind, { query: string; pictures: StudyPicture[] }>>>({});
  const [busy, setBusy] = useState(false);
  const find = async (k: StudyMediaKind) => {
    setKind(k);
    if (got[k] || busy) return;
    setBusy(true);
    const x = await call(api<{ query: string; pictures: StudyPicture[] }>(`${base}/pictures?kind=${k}`));
    setBusy(false);
    if (x) setGot((g) => ({ ...g, [k]: x }));
  };
  const r = got[kind];
  const KINDS: Array<[StudyMediaKind, string, string]> = [["image", "תמונות", "Pictures"], ["gif", "אנימציות", "Animations"], ["video", "סרטונים", "Videos"]];
  return (
    <details className="study-notes" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && !got.image && !busy) void find("image"); }}>
      <summary>{L("תמונות, אנימציות וסרטונים מוויקישיתוף", "Pictures, animations and videos from Wikimedia")}</summary>
      <div className="seg-pills" role="tablist" aria-label={L("סוג", "Kind")} style={{ marginTop: 8 }}>
        {KINDS.map(([k, he, en]) => <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? "on" : ""} onClick={() => void find(k)}>{L(he, en)}</button>)}
      </div>
      {busy && <p className="muted small">{L("מחפש…", "Searching…")}</p>}
      {r && (r.pictures.length ? (
        <div className="study-pics">
          {r.pictures.map((p, i) => (
            <figure key={i}>
              {p.video && p.page ? <a href={p.page} target="_blank" rel="noreferrer noopener" className="study-pic-video" aria-label={L("צפייה בסרטון בוויקישיתוף", "Watch the video on Wikimedia")}><img src={p.src} alt={r.query} loading="lazy" /><span aria-hidden="true">▶</span></a> : <img src={p.src} alt={r.query} loading="lazy" />}
              <figcaption className="small muted" dir="auto">{p.page ? <a href={p.page} target="_blank" rel="noreferrer noopener">{p.artist}</a> : p.artist} · {p.license}</figcaption>
            </figure>
          ))}
        </div>
      ) : <p className="muted small">{L(`לא נמצא ל-"${r.query}".`, `Nothing found for "${r.query}".`)}</p>)}
      {r && <p className="muted small">{kind === "video" ? L("סרטון נפתח בוויקישיתוף. ", "A video opens on Wikimedia. ") : ""}{L("חומר חופשי מוויקישיתוף לפי המונחים של ההרצאה. כדאי לוודא שהוא מתאים לחומר.", "Free material from Wikimedia Commons by the lecture's terms. Check it matches the material.")}</p>}
    </details>
  );
}

/** Her own notes beside the summary, saved as she types (a short pause). */
function LectureNotes({ base, notes }: { base: string; notes: string }) {
  const [text, setText] = useState(notes);
  const [state, setState] = useState<"" | "saving" | "saved">("");
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setState("saving");
    const t = setTimeout(() => void api(base, { method: "PATCH", body: { notes: text } }).then(() => setState("saved"), (e: Error) => { setState(""); toast(e.message); }), 700);
    return () => clearTimeout(t);
  }, [text, base]);
  return (
    <details className="study-notes" open={!!notes}>
      <summary>{L("ההערות שלי", "My notes")}{state === "saving" ? L(" · שומר…", " · saving…") : state === "saved" ? L(" · נשמר", " · saved") : ""}</summary>
      <textarea rows={4} dir="auto" value={text} onChange={(e) => setText(e.target.value)} placeholder={L("מה המרצה הדגיש, מה לשאול, מה לא הבנתי…", "What the lecturer stressed, what to ask, what I did not get…")} aria-label={L("ההערות שלי", "My notes")} />
      {(() => {
        const n = noteCards(text).length;
        return n ? (
          <button type="button" className="small" onClick={async () => { await api(base, { method: "PATCH", body: { notes: text } }).catch(() => undefined); const r = await call(api<{ added: number }>(`${base}/note-cards`, { method: "POST" })); if (r) toast(r.added ? L(`נוספו ${r.added} כרטיסיות`, `${r.added} cards added`) : L("כל השורות כבר כרטיסיות", "Every line is a card already")); }}>📇 {L(`להפוך ${n} שורות עם :: לכרטיסיות`, `Make cards from ${n} lines with ::`)}</button>
        ) : <span className="muted small">{L("טיפ: שורה כמו \"ברדיקרדיה :: דופק מתחת ל-60\" הופכת לכרטיסייה.", "Tip: a line like \"bradycardia :: a pulse under 60\" becomes a card.")}</span>;
      })()}
    </details>
  );
}

function TermList({ terms, courseId }: { terms: StudyTerm[]; courseId?: string }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!terms.length) return <p className="muted">{L("אין מונחים.", "No terms.")}</p>;
  return (
    <dl className="study-terms">
      {terms.map((t, i) => (
        <div key={i}>
          <dt dir="auto">{t.term}{t.en && t.en !== t.term ? <span className="muted" dir="ltr"> · {t.en}</span> : null}</dt>
          <dd dir="auto">{t.explain}</dd>
          {courseId && <dd><button type="button" className="ghost small" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>🔎 {L("איפה עוד המונח מופיע", "Where else it appears")}</button></dd>}
          {courseId && open === i && <dd><WhereTerm courseId={courseId} term={t.term} {...(t.en ? { en: t.en } : {})} /></dd>}
        </div>
      ))}
    </dl>
  );
}

/** Where else a term appears in the course (design WhereTerm): each lecture with the places, opening at the minute. */
function WhereTerm({ courseId, term, en }: { courseId: string; term: string; en?: string }) {
  const [places, setPlaces] = useState<TermPlace[] | null>(null);
  useEffect(() => void api<{ places: TermPlace[] }>(`/api/study/courses/${courseId}/where?term=${encodeURIComponent(term)}${en ? `&en=${encodeURIComponent(en)}` : ""}`).then((r) => setPlaces(r.places), (e: Error) => toast(e.message)), [courseId, term, en]);
  if (!places) return <p className="muted small">…</p>;
  if (!places.length) return <p className="muted small">{L("המונח לא מופיע בטקסט של ההרצאות.", "The term does not appear in the lectures' text.")}</p>;
  return (
    <ul className="study-where">
      {places.map((p) => (
        <li key={p.lectureId}>
          <a href={`#/study/${courseId}/l/${p.lectureId}`}><b dir="auto">{p.title}</b></a> <span className="muted small">{L(`· ${p.count} פעמים`, `· ${p.count} times`)}</span>
          {p.spots.map((s, j) => (
            <a key={j} className="study-where-spot small" href={`#/study/${courseId}/l/${p.lectureId}${s.at !== undefined ? `/${s.at}` : ""}`}>
              {s.at !== undefined && <span className="study-stamp" dir="ltr">▶ {clockOf(s.at)}</span>}{s.page ? <span className="muted">{L(`עמ׳ ${s.page} `, `p. ${s.page} `)}</span> : null}<span dir="auto">{s.text}</span>
            </a>
          ))}
        </li>
      ))}
    </ul>
  );
}

/** Every term of the course's lectures in one list, with where each one appears. */
export function Glossary({ courseId, lectures }: { courseId: string; lectures: LectureRow[] }) {
  const [q, setQ] = useState("");
  const all = lectures.flatMap((l) => (l.terms ?? []).map((t) => ({ ...t, from: l.title })));
  const shown = all.filter((t) => !q || `${t.term} ${t.en ?? ""} ${t.explain}`.toLowerCase().includes(q.toLowerCase())).sort((a, b) => a.term.localeCompare(b.term, "he"));
  return (
    <section className="study-glossary">
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L("חיפוש מונח, בעברית או באנגלית", "Search a term, Hebrew or English")} aria-label={L("חיפוש", "Search")} dir="auto" />
      {!all.length ? <p className="muted">{L("המילון מתמלא מהמונחים של כל הרצאה שסוכמה.", "The glossary fills from the terms of every summarized lecture.")}</p> : <TermList terms={shown} courseId={courseId} />}
    </section>
  );
}

export const RATINGS: Array<[number, [string, string], string]> = [
  [1, ["שוב", "Again"], "bad"],
  [2, ["קשה", "Hard"], "warn"],
  [3, ["טוב", "Good"], "accent"],
  [4, ["קל", "Easy"], "good"],
];
