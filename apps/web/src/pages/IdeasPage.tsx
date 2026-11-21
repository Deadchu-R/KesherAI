import { useEffect, useRef, useState } from "react";
import type { Idea, IdeaKind, IdeaProgress, IdeaSession, IdeaStage, IdeaVerdict } from "@kesher/shared";
import { api, withToken } from "../api";
import { getLocale, he$ } from "../i18n";
import { createConversation, toast } from "../library";
import { openWithDraft } from "../phone";
import { openMic } from "../mic-access";
import { nativeRec, useLongRecorder } from "../long-recorder";
import { RecNote } from "../RecNote";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
type Row = Omit<IdeaSession, "transcript" | "ideas"> & { count: number; good: number; titles?: string[] };

const VERDICT: Record<IdeaVerdict, [string, string, string]> = {
  good: ["👍 טוב", "👍 Good", "good"],
  maybe: ["🤔 אולי", "🤔 Maybe", "maybe"],
  weak: ["👎 חלש", "👎 Weak", "weak"],
};
const KIND: Record<IdeaKind, [string, string]> = {
  idea: ["💡 רעיון", "💡 Idea"],
  task: ["✅ משימה", "✅ Task"],
  question: ["❓ שאלה", "❓ Question"],
};
/** Recording lengths in minutes; 30 is the longest a dump may run. */
const MINUTES = [5, 10, 15, 30];
/** The server's two plain-English failures, in the page's language (anything else is shown as it came). */
const errorText = (e?: string) => (/^No speech was found/.test(e ?? "") ? L("לא נמצא דיבור בהקלטה. נסו להקליט קרוב יותר למיקרופון.", "No speech was found in the recording. Try recording closer to the microphone.") : /^No ideas were found/.test(e ?? "") ? L("לא נמצאו רעיונות במה שנאמר.", "No ideas were found in what was said.") : e);
const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * "Open mind" (#/ideas, design IdeaSession): record yourself thinking aloud (up to 30 minutes, on the computer or the
 * phone; the audio goes to the PC and is transcribed there), then review every idea, task and question (edit, merge,
 * split, delete) and send each on: a chat, a deep research report, the task inbox or a note in Knowledge.
 */
export function IdeasPage() {
  const [sessions, setSessions] = useState<Row[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const load = () => void api<{ sessions: Row[] }>(`/api/ideas${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`).then((r) => setSessions(r.sessions), (e: Error) => toast(e.message));
  // Searching waits for a short pause in typing.
  useEffect(() => {
    const t = window.setTimeout(load, q ? 250 : 0);
    return () => window.clearTimeout(t);
  }, [q]);
  return (
    <div className="page ideas-page">
      <header className="page-head">
        <h1>🧠 {L("מוח פתוח", "Open mind")}</h1>
        <p className="muted">{L("ממלמלים כל רעיון שעולה, בלי לסנן. בסוף KesherAI מוציא את הרעיונות, ממיין אותם ומציע מחקר.", "Mumble every idea that comes, unfiltered. Then KesherAI pulls out the ideas, sorts them and offers research.")}</p>
      </header>
      <div className="ideas-layout">
        <Recorder onDone={(id) => { load(); setOpen(id); }} />
        <section className="ideas-main">
          {open ? <SessionView id={open} onBack={() => { setOpen(null); load(); }} /> : (
            <>
              <h2>{L("סשנים קודמים", "Earlier sessions")}</h2>
              <input type="search" className="ideas-search" value={q} onChange={(e) => setQ(e.target.value)} dir="auto" placeholder={L("חיפוש בתמלולים וברעיונות…", "Search transcripts and ideas…")} aria-label={L("חיפוש בסשנים", "Search sessions")} />
              {!sessions.length && <p className="muted">{q.trim() ? L("לא נמצא סשן כזה.", "No session matches.") : L("עוד אין. התחילו הקלטה, או הדביקו טקסט.", "None yet. Start a recording, or paste text.")}</p>}
              <ul className="ideas-sessions">
                {sessions.map((s) => (
                  <li key={s.id}>
                    <button type="button" className="ideas-session-row" onClick={() => setOpen(s.id)}>
                      <b>{new Date(s.t).toLocaleString(getLocale() === "he" ? "he-IL" : "en-GB", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })}</b>
                      <span className="muted small">{s.seconds ? `${Math.round(s.seconds / 60)} ${L("דק׳", "min")} · ` : ""}{s.status === "done" ? L(`${s.count} פריטים, ${s.good} טובים`, `${s.count} items, ${s.good} good`) : s.status === "error" ? L("נכשל", "Failed") : L("ממיין…", "Sorting…")}</span>
                      {!!s.titles?.length && <span className="ideas-session-titles small" dir="auto">{s.titles.join(" · ")}</span>}
                    </button>
                  </li>
                ))}
              </ul>
              <PasteText onDone={(id) => { load(); setOpen(id); }} />
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/** The recorder: one big button, a length (at most 30 minutes), a timer with a level meter, pause, finish. */
function Recorder({ onDone }: { onDone: (id: string) => void }) {
  const [minutes, setMinutes] = useState(30);
  const [sending, setSending] = useState(false);
  const [sendMb, setSendMb] = useState(0);
  const [levels, setLevels] = useState<number[]>(Array(14).fill(2));
  const [failed, setFailed] = useState<{ blob: Blob; seconds: number } | null>(null);
  // One shared recorder (long-recorder.ts): in the phone app natively, in the background, with a notification;
  // elsewhere the page records and keeps every 5 seconds in the browser, so nothing is lost on leaving or a crash.
  const long = useLongRecorder("ideas");
  const mic = useRef<{ stream: MediaStream; close: () => void } | null>(null);
  const finishing = useRef(false);
  // A send that failed leaves the recording kept: Finish again, Resume, or Try again below.
  const state = sending ? "sending" : failed && long.status === "finishing" ? "interrupted" : long.status;
  const live = state === "recording" || state === "paused" || state === "silenced";
  const liveRef = useRef(live);
  liveRef.current = live;

  const send = async (blob: Blob, seconds: number) => {
    setSendMb(Math.max(0.1, Math.round(blob.size / 1e5) / 10));
    setSending(true);
    const res = await fetch(withToken("/api/ideas/record"), { method: "POST", headers: { "content-type": "application/x-kesher-audio", "x-audio-type": blob.type || "audio/webm", "x-seconds": String(Math.round(seconds)) }, body: blob }).catch(() => undefined);
    setSending(false);
    const s = res?.ok ? ((await res.json()) as IdeaSession) : undefined;
    if (!s) {
      setFailed({ blob, seconds });
      return toast(res ? ((await res.json().catch(() => ({}))) as { error?: string }).error ?? L("השליחה נכשלה.", "Sending failed.") : L("השליחה נכשלה.", "Sending failed."));
    }
    setFailed(null);
    await long.done();
    onDone(s.id);
  };

  /** Opens the microphone with a level meter (the page's own recording; the phone app meters natively). */
  const openStream = async (): Promise<MediaStream | undefined> => {
    if (long.native) return undefined;
    const stream = await openMic({ echoCancellation: true, noiseSuppression: true });
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 64;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.frequencyBinCount);
    const meter = window.setInterval(() => {
      an.getByteFrequencyData(buf);
      setLevels(Array.from({ length: 14 }, (_, i) => 2 + Math.round(((buf[i + 1] ?? 0) / 255) * 26)));
    }, 120);
    mic.current = { stream, close: () => { window.clearInterval(meter); void ctx.close(); stream.getTracks().forEach((t) => t.stop()); } };
    return stream;
  };

  const start = async (resume = false) => {
    let stream: MediaStream | undefined;
    try {
      stream = await openStream();
      if (resume) await long.resume(stream);
      else if (!(await long.start(stream, { minutes }))) {
        mic.current?.close();
        return toast(L("הקלטה אחרת (בלימודים) עדיין שמורה בטלפון. סיימו אותה קודם.", "Another recording (Study) is still kept on the phone. Finish it first."));
      }
    } catch (e) {
      mic.current?.close();
      return toast((e as Error).message);
    }
    finishing.current = false;
  };

  const finish = async () => {
    if (finishing.current) return;
    finishing.current = true;
    const take = await long.finish().catch((e: Error) => (toast(e.message), undefined));
    mic.current?.close();
    mic.current = null;
    if (take?.audio && take.audio.size > 1000) await send(take.audio, take.seconds);
    else if (take) {
      toast(L("לא הוקלט כלום.", "Nothing was recorded."));
      await long.done();
    }
    finishing.current = false;
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  // The chosen length (kept with the session, so a resumed one keeps it) ends the recording.
  const limit = Number(long.pending?.meta.minutes ?? minutes) * 60;
  useEffect(() => {
    if (long.status === "recording" && long.secs >= limit) void finishRef.current();
  }, [long.status, long.secs, limit]);
  // The phone app's level: one loudness, spread over the bars.
  useEffect(() => {
    if (long.native) setLevels(Array.from({ length: 14 }, (_, i) => 2 + Math.round(long.level * 26 * (0.55 + 0.45 * Math.abs(Math.sin(long.secs * 1.7 + i))))));
  }, [long.native, long.level, long.secs]);
  // Leaving the page: the page's own recording is sent; the phone app's goes on (it is found again on return).
  useEffect(() => () => { if (!nativeRec() && liveRef.current) void finishRef.current(); }, []);

  const pct = Math.min(1, long.secs / limit);
  return (
    <section className="card ideas-rec">
      <b>{L("הקלטה", "Recording")}</b>
      <span className="muted small">{L("שבו בנוח, דברו כל מה שעולה. אפשר לחזור על עצמכם, לקפוץ בין נושאים ולשתוק.", "Sit back and say whatever comes. Repeat yourself, jump between topics, be quiet a while.")}</span>
      {state === "idle" ? (
        <button type="button" className="ideas-dial ideas-big" onClick={() => void start()} aria-label={L("להתחיל להקליט", "Start recording")}>
          <span className="ideas-big-mic" aria-hidden="true">🎙</span>
          <b>{L("להקליט", "Record")}</b>
        </button>
      ) : (
        <div className={`ideas-dial ${state === "recording" ? "rec" : "paused"}`} style={{ ["--p" as string]: String(pct) }}>
          <b dir="ltr">{clock(long.secs)}</b>
          <span className="muted small">{L(`מתוך ${clock(limit)}`, `of ${clock(limit)}`)}</span>
        </div>
      )}
      <div className="ideas-levels" aria-hidden="true">{levels.map((h, i) => <span key={i} style={{ height: state === "recording" ? h : 2 }} />)}</div>
      <RecNote status={long.status} native={long.native} />
      {state === "idle" && (
        <div className="ideas-mins" role="radiogroup" aria-label={L("כמה זמן", "How long")}>
          {MINUTES.map((m) => <button type="button" key={m} role="radio" aria-checked={minutes === m} className={minutes === m ? "on" : ""} onClick={() => setMinutes(m)}>{L(`${m} דק׳`, `${m} min`)}</button>)}
        </div>
      )}
      <div className="row">
        {live && <button type="button" onClick={() => void long.pause(state !== "paused")} disabled={state === "silenced"}>{state === "paused" ? `▶ ${L("להמשיך", "Resume")}` : `⏸ ${L("השהיה", "Pause")}`}</button>}
        {state === "interrupted" && <button type="button" onClick={() => void start(true)}>▶ {L("להמשיך להקליט", "Resume recording")}</button>}
        {(live || state === "interrupted") && <button type="button" className="primary" onClick={() => void finish()}>⏹ {L("לסיים ולמיין", "Finish and sort")}</button>}
        {state === "interrupted" && <button type="button" className="ghost" onClick={() => confirm(L("למחוק את ההקלטה?", "Delete the recording?")) && void long.done()}>{L("למחוק", "Delete")}</button>}
        {(state === "sending" || state === "finishing") && <span className="muted">{state === "sending" && sendMb ? L(`שולח ${sendMb} MB למחשב…`, `Sending ${sendMb} MB to the computer…`) : L("שולח…", "Sending…")}</span>}
      </div>
      {failed && (
        <p className="small">
          {L("ההקלטה לא נשלחה, אבל היא שמורה כאן:", "The recording was not sent, but it is kept here:")}{" "}
          <button type="button" className="link" onClick={() => void send(failed.blob, failed.seconds)}>{L("לנסות שוב", "Try again")}</button>{" · "}
          <a href={URL.createObjectURL(failed.blob)} download={`ideas-${new Date().toISOString().slice(0, 16)}.${failed.blob.type.includes("wav") ? "wav" : "webm"}`}>{L("להוריד", "Download")}</a>
        </p>
      )}
    </section>
  );
}

/** Text instead of a recording. */
function PasteText({ onDone }: { onDone: (id: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <details className="ideas-paste">
      <summary>{L("או להדביק טקסט / תמלול", "Or paste text / a transcript")}</summary>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} dir="auto" placeholder={L("כל מה שחשבתם, כמו שזה…", "Everything you thought, as it came…")} />
      <button type="button" disabled={busy || !text.trim()} onClick={async () => {
        setBusy(true);
        try {
          const s = await api<IdeaSession>("/api/ideas/text", { method: "POST", body: { text } });
          setText("");
          onDone(s.id);
        } catch (e) {
          toast((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}>{L("למיין", "Sort")}</button>
    </details>
  );
}

type Filter = "all" | IdeaVerdict | IdeaKind | "tried" | "new";

/** One session: its ideas, tasks and questions; filters; her review (edit, merge, split, delete); research one or all. */
function SessionView({ id, onBack }: { id: string; onBack: () => void }) {
  const [s, setS] = useState<IdeaSession | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [showText, setShowText] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const lang = getLocale() === "he" ? "he" : "en";
  const load = () => void api<IdeaSession>(`/api/ideas/${id}`).then(setS, (e: Error) => toast(e.message));
  useEffect(load, [id]);
  // While it is sorting or researching, look again every few seconds.
  const live = !!s && (s.status === "transcribing" || s.status === "sorting" || !!s.researchAll || s.ideas.some((i) => i.research?.status === "running"));
  useEffect(() => {
    if (!live) return;
    const t = window.setInterval(load, 4000);
    return () => window.clearInterval(t);
  }, [live, id]);
  if (!s) return <p className="muted">…</p>;
  /** Calls the server and shows the session it answers with; errors as a toast. */
  const act = async (path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown, done?: string) => {
    try {
      setS(await api<IdeaSession>(`/api/ideas/${id}${path}`, { method, ...(body === undefined ? {} : { body }) }));
      if (done) toast(done);
      return true;
    } catch (e) {
      toast((e as Error).message);
      return false;
    }
  };
  const research = async (idea: Idea) => {
    if (idea.research?.conversationId && idea.research.status !== "error") return void (location.hash = `#/c/${idea.research.conversationId}`);
    try {
      await api(`/api/ideas/${id}/ideas/${idea.id}/research`, { method: "POST", body: { lang } });
      toast(L("המחקר המעמיק התחיל בצ'אט חדש; הדוח ייפתח שם כמסמך", "Deep research started in a new chat; the report opens there as a document"));
      load();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const toChat = async (idea: Idea) => {
    const cid = await createConversation({ kind: "chat" }, { open: false });
    if (cid) openWithDraft(cid, idea.prompt);
  };
  const all = async () => {
    try {
      setS(await api<IdeaSession>(`/api/ideas/${id}/${s.researchAll ? "research-all/stop" : "research-all"}`, { method: "POST", body: { lang } }));
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const merge = async () => {
    if (await act("/merge", "POST", { ids: picked }, L("אוחדו לפריט אחד", "Merged into one"))) setPicked([]);
  };
  const n = (f: (i: Idea) => boolean) => s.ideas.filter(f).length;
  const kindOf = (i: Idea): IdeaKind => i.kind ?? "idea";
  const shown = s.ideas.filter((i) => filter === "all" || (filter === "tried" ? i.tried === "yes" : filter === "new" ? i.tried !== "yes" : filter in KIND ? kindOf(i) === filter : i.verdict === filter));
  const researched = n((i) => i.research?.status === "done");
  const pills: Array<[Filter, string, number]> = [
    ["all", L("הכל", "All"), s.ideas.length],
    ["idea", L("רעיונות", "Ideas"), n((i) => kindOf(i) === "idea")],
    ["task", L("משימות", "Tasks"), n((i) => kindOf(i) === "task")],
    ["question", L("שאלות", "Questions"), n((i) => kindOf(i) === "question")],
    ["good", L("טובים", "Good"), n((i) => i.verdict === "good")],
    ["maybe", L("אולי", "Maybe"), n((i) => i.verdict === "maybe")],
    ["weak", L("חלשים", "Weak"), n((i) => i.verdict === "weak")],
    ["tried", L("ניסית בעבר", "Tried before"), n((i) => i.tried === "yes")],
    ["new", L("חדשים", "New"), n((i) => i.tried !== "yes")],
  ];
  return (
    <div className="ideas-session">
      <div className="row ideas-session-head">
        <button type="button" className="link" onClick={onBack}>‹ {L("כל הסשנים", "All sessions")}</button>
        <b>{new Date(s.t).toLocaleString(lang === "he" ? "he-IL" : "en-GB", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })}{s.seconds ? ` · ${Math.round(s.seconds / 60)} ${L("דקות", "min")}` : ""}</b>
        <span className="grow" />
        {(s.status === "done" || s.status === "error") && !!s.transcript && <button type="button" title={L("קורא את התמלול שוב, כל פעם לעומק גדול יותר; הרעיונות שכבר יש נשמרים", "Reads the transcript again, a level deeper each time; the ideas you have are kept")} onClick={() => void act("/deeper", "POST")}>🔎 {L("פענוח שוב", "Analyse again")} · {L("עומק", "depth")} {(s.depth ?? 1) + 1}</button>}
        {s.status === "done" && <button type="button" className={s.researchAll ? "" : "primary"} onClick={() => void all()}>{s.researchAll ? `⏹ ${L("לעצור את המחקר ברצף", "Stop researching")}` : `🔬 ${L("מחקר על הכל ברצף", "Research all in a row")}`} ({researched}/{s.ideas.length})</button>}
        <button type="button" className="icon-btn" title={L("מחיקת הסשן", "Delete the session")} aria-label={L("מחיקת הסשן", "Delete the session")} onClick={async () => { if (confirm(L("למחוק את הסשן? צ'אטי המחקר, ההערות והמשימות נשארים.", "Delete the session? Research chats, notes and tasks stay."))) { await api(`/api/ideas/${id}`, { method: "DELETE" }); onBack(); } }}>🗑</button>
      </div>
      {(s.status === "transcribing" || s.status === "sorting") && <AnalysisProgress s={s} />}
      {s.deeperError && <p className="error">{L("הפענוח העמוק יותר נכשל; הרעיונות הקודמים נשמרו: ", "The deeper pass failed; your earlier ideas are kept: ")}{errorText(s.deeperError)}</p>}
      {s.status === "error" && <p className="error">{errorText(s.error)}</p>}
      {s.status === "done" && s.summary && <p className="ideas-summary" role="note">💭 {L("לא נמצאו רעיונות ברורים, אז זה מה שדובר וכמה כיוונים אפשריים (מסומנים כהסקה):", "No clear ideas came out, so here is what was talked about and a few possible directions (marked as inferred):")} <span className="muted">{s.summary}</span></p>}
      {s.status === "done" && (
        <>
          <div className="ideas-filters" role="tablist">
            {pills.filter(([f, , c]) => f === "all" || c > 0).map(([f, label, c]) => <button type="button" key={f} role="tab" aria-selected={filter === f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{label} {c}</button>)}
          </div>
          {picked.length > 0 && (
            <div className="ideas-mergebar" role="status">
              <span>{L(`נבחרו ${picked.length}`, `${picked.length} chosen`)}</span>
              <button type="button" className="primary" disabled={picked.length < 2} onClick={() => void merge()}>🔗 {L("לאחד", "Merge")}</button>
              <button type="button" className="link" onClick={() => setPicked([])}>{L("ביטול", "Cancel")}</button>
            </div>
          )}
          <ul className="ideas-list">
            {shown.map((i) => (
              <IdeaCard
                key={i.id}
                idea={i}
                picked={picked.includes(i.id)}
                onPick={(on) => setPicked((p) => (on ? [...p, i.id] : p.filter((x) => x !== i.id)))}
                act={(path, method, body, done) => act(`/ideas/${i.id}${path}`, method, body, done)}
                onResearch={() => void research(i)}
                onChat={() => void toChat(i)}
                lang={lang}
              />
            ))}
          </ul>
        </>
      )}
      {s.transcript && (
        <details className="ideas-transcript" open={showText} onToggle={(e) => setShowText((e.target as HTMLDetailsElement).open)}>
          <summary>{L("התמלול המלא", "The full transcript")}</summary>
          <p dir="auto">{s.transcript}</p>
        </details>
      )}
    </div>
  );
}

type Act = (path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown, done?: string) => Promise<boolean>;

/**
 * One idea, task or question: her words, the prompt, the next step; the four ways on (chat, deep research, task inbox,
 * note in Knowledge) and her review (choose for merging, edit, split, delete).
 */
const STAGES: Array<[IdeaStage, string, string, string, string]> = [
  ["transcribing", "מתמלל את ההקלטה", "Transcribing the recording", "מקשיב לכל מילה, בלי למהר.", "Listening to every word, no rush."],
  ["splitting", "מפריד לרעיונות, משימות ושאלות", "Splitting into ideas, tasks and questions", "מסדר את המחשבות שלך בקבוצות.", "Sorting your thoughts into groups."],
  ["writing", "בודק מה כבר ניסית וכותב צעדים הבאים", "Checking what you tried and writing next steps", "כמעט שם: נותן לכל רעיון צעד ראשון.", "Almost there: giving each idea a first step."],
];
const mins = (sec: number) => (sec < 90 ? L("פחות מדקה", "under a minute") : L(`כ-${Math.round(sec / 60)} דק׳`, `about ${Math.round(sec / 60)} min`));

/**
 * What an analysis has done so far (design IdeaProgress): the steps ticked as they finish, the current one with what
 * it found (minutes read, "3 ideas so far · last: …"), the time it has taken and a rough time left. The state comes
 * from the server with each poll of the session, so it is right after leaving and coming back, and the seconds are
 * counted from the server's clock (a phone's clock may differ).
 */
function AnalysisProgress({ s }: { s: IdeaSession }) {
  const p: IdeaProgress | undefined = s.progress;
  const [tick, setTick] = useState(0);
  const seen = useRef({ at: Date.now(), p });
  if (seen.current.p !== p) seen.current = { at: Date.now(), p };
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  void tick;
  const stage: IdeaStage = p?.stage ?? (s.status === "transcribing" ? "transcribing" : "splitting");
  const fromSpeech = s.status === "transcribing" || stage === "transcribing" || !!p?.audioSeconds;
  const shown = STAGES.filter(([k]) => fromSpeech || k !== "transcribing");
  const at = shown.findIndex(([k]) => k === stage);
  // Seconds since the analysis (and this stage) began, by the server's clock plus what passed here since the poll.
  const since = (t?: number) => (p?.now && t ? Math.max(0, (p.now - t + (Date.now() - seen.current.at)) / 1000) : 0);
  const elapsed = since(p?.startedAt);
  const inStage = since(p?.stageAt);
  const audio = p?.audioSeconds ?? 0;
  const expected = p?.expectedSeconds ?? 0;
  const read = audio && expected ? Math.min(audio * 0.95, audio * (inStage / expected)) : 0;
  const left = stage === "transcribing" ? (expected ? Math.max(30, expected - inStage) + 60 : 0) : stage === "splitting" ? 90 : 20;
  const f = p?.found;
  const so = f ? f.ideas + f.tasks + f.questions : 0;
  const counts = f && so ? [f.ideas ? L(`${f.ideas} רעיונות`, `${f.ideas} ideas`) : "", f.tasks ? L(`${f.tasks} משימות`, `${f.tasks} tasks`) : "", f.questions ? L(`${f.questions} שאלות`, `${f.questions} questions`) : ""].filter(Boolean).join(" · ") : "";
  const detail = (k: IdeaStage) => {
    if (k === "transcribing" && read) return L(`בערך ${Math.floor(read / 60)} מתוך ${Math.round(audio / 60)} דקות הוקראו`, `about ${Math.floor(read / 60)} of ${Math.round(audio / 60)} minutes read`);
    if (k === "splitting" && p?.part && p.part.of > 1 && !counts) return L(`חלק ${p.part.done + 1} מתוך ${p.part.of}`, `part ${p.part.done + 1} of ${p.part.of}`);
    if (k === "splitting" && counts) return `${p?.part && p.part.of > 1 ? L(`חלק ${p.part.done + 1}/${p.part.of} · `, `part ${p.part.done + 1}/${p.part.of} · `) : ""}${counts}${f?.last ? L(` · אחרון: "${f.last}"`, ` · last: "${f.last}"`) : ""}`;
    if (k === "writing" && p?.checked) return L(`${p.checked.done} מתוך ${p.checked.of} נבדקו`, `${p.checked.done} of ${p.checked.of} checked`);
    return "";
  };
  const line = STAGES[Math.max(0, STAGES.findIndex(([k]) => k === stage))]!;
  return (
    <div className="ideas-progress stack" aria-live="polite">
      <h3>{L("חושב על מה שאמרת…", "Thinking through what you said…")}{(p?.level ?? 1) > 1 && <span className="idea-tag">{L("עומק", "depth")} {p?.level}</span>}</h3>
      <p className="muted">{L(line[3], line[4])}</p>
      <ol className="cr-steps">
        {shown.map(([k, he, en], i) => {
          const state = i < at ? "done" : i === at ? "now" : "next";
          return <li key={k} className={state}><span aria-hidden>{state === "done" ? "✓" : state === "now" ? "⏳" : "○"}</span> <span>{L(he, en)}{state === "now" && detail(k) ? ` · ${detail(k)}` : ""}</span>{state === "now" && <span className="sr-only">{L(" (עכשיו)", " (now)")}</span>}</li>;
        })}
      </ol>
      <span className="muted small">{p ? `${L("עברו", "Elapsed")} ${clock(elapsed)}${left ? ` · ${L("נשאר", "left")} ${mins(left)}` : ""} · ` : ""}{L("אפשר לצאת ולחזור; זה ממשיך במחשב.", "You can leave and come back; it carries on on the computer.")}</span>
    </div>
  );
}

function IdeaCard({ idea: i, picked, onPick, act, onResearch, onChat, lang }: { idea: Idea; picked: boolean; onPick: (on: boolean) => void; act: Act; onResearch: () => void; onChat: () => void; lang: string }) {
  const [mode, setMode] = useState<"view" | "edit" | "split">("view");
  const [draft, setDraft] = useState({ title: i.title, prompt: i.prompt, quote: i.quote ?? "", next: i.next ?? "", kind: i.kind ?? "idea" });
  const [parts, setParts] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<boolean>) => {
    setBusy(true);
    const ok = await f().finally(() => setBusy(false));
    if (ok) setMode("view");
  };
  const kind = i.kind ?? "idea";
  return (
    <li className={`card idea ${VERDICT[i.verdict][2]}${picked ? " picked" : ""}`}>
      <div className="idea-top">
        <input type="checkbox" checked={picked} onChange={(e) => onPick(e.target.checked)} aria-label={L("לבחור לאיחוד", "Choose to merge")} title={L("לבחור לאיחוד", "Choose to merge")} />
        <b dir="auto" className="idea-title">{i.title}</b>
        <span className="idea-tag">{L(...KIND[kind])}</span>
        <span className={`idea-tag ${VERDICT[i.verdict][2]}`} title={i.why}>{L(VERDICT[i.verdict][0], VERDICT[i.verdict][1])}</span>
        {i.inferred && <span className="idea-tag" title={L("לא נאמר במפורש: הסקה ממה שאמרת", "Not said outright: inferred from what you said")}>💡 {L("הסקה", "Inferred")}</span>}
        {i.tried === "yes" ? <span className="idea-tag tried" title={i.triedNote}>↺ {L("ניסית בעבר", "Tried before")}</span> : <span className="idea-tag">✦ {L("חדש", "New")}</span>}
      </div>
      {mode === "edit" ? (
        <form className="idea-edit" onSubmit={(e) => { e.preventDefault(); void run(() => act("", "PATCH", draft, L("נשמר", "Saved"))); }}>
          <label>{L("כותרת", "Title")}<input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} dir="auto" maxLength={120} /></label>
          <label>{L("סוג", "Kind")}
            <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as IdeaKind })}>
              {(Object.keys(KIND) as IdeaKind[]).map((k) => <option key={k} value={k}>{L(...KIND[k])}</option>)}
            </select>
          </label>
          <label>{L("המילים שלך", "Your words")}<textarea value={draft.quote} onChange={(e) => setDraft({ ...draft, quote: e.target.value })} dir="auto" rows={2} /></label>
          <label>{L("הפרומפט", "The prompt")}<textarea value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} dir="auto" rows={4} /></label>
          <label>{L("הצעד הבא", "Next step")}<input value={draft.next} onChange={(e) => setDraft({ ...draft, next: e.target.value })} dir="auto" /></label>
          <div className="row">
            <button type="submit" className="primary" disabled={busy}>{L("לשמור", "Save")}</button>
            <button type="button" onClick={() => setMode("view")}>{L("ביטול", "Cancel")}</button>
          </div>
        </form>
      ) : mode === "split" ? (
        <div className="idea-edit">
          <label>{L("כל חלק בשורה משלו (או ריק, ו-KesherAI יפצל)", "Each part on its own line (or empty, and KesherAI splits it)")}
            <textarea value={parts} onChange={(e) => setParts(e.target.value)} dir="auto" rows={4} />
          </label>
          <div className="row">
            <button type="button" className="primary" disabled={busy} onClick={() => void run(() => act("/split", "POST", { parts: parts.split("\n") }, L("פוצל", "Split")))}>{busy ? "…" : `✂ ${L("לפצל", "Split")}`}</button>
            <button type="button" onClick={() => setMode("view")}>{L("ביטול", "Cancel")}</button>
          </div>
        </div>
      ) : (
        <>
          {i.quote && <blockquote className="idea-quote" dir="auto">“{i.quote}”</blockquote>}
          <p className="idea-prompt" dir="auto">{i.prompt}</p>
          {i.next && <p className="idea-next small" dir="auto">➜ <b>{L("הצעד הבא:", "Next step:")}</b> {i.next}</p>}
          {i.why && <p className="muted small" dir="auto">{i.why}</p>}
        </>
      )}
      {i.tried === "yes" && mode === "view" && (
        <p className="small" dir="auto">↺ {i.triedNote} {i.triedIn?.map((c) => <a key={c.conversationId} href={`#/c/${c.conversationId}`} className="idea-was">{c.title}</a>)}</p>
      )}
      <div className="idea-meta">
        <span>📁 {i.projects.length ? i.projects.join(", ") : L("לא שייך לפרויקט", "No project")}</span>
        {i.audience && <span>👥 {i.audience}</span>}
        {i.category && <span>🏷 {i.category}</span>}
      </div>
      {mode === "view" && (
        <>
          <div className="idea-actions">
            <button type="button" onClick={onChat}>💬 {L("לצ'אט", "Chat")}</button>
            <button type="button" className={i.research?.status === "done" ? "primary" : ""} onClick={onResearch}>
              {i.research?.status === "done" ? `📄 ${L("הדוח מוכן", "Report ready")}` : i.research?.status === "running" ? `⏳ ${L("חוקר…", "Researching…")}` : i.research?.status === "error" ? `↻ ${L("שוב מחקר", "Retry research")}` : `🔬 ${L("מחקר מעמיק", "Deep research")}`}
            </button>
            <button type="button" disabled={busy || !!i.task} onClick={() => void run(() => act("/task", "POST", undefined, L("נוסף לתיבת המשימות", "Added to the task inbox")))}>{i.task ? `✓ ${L("בתיבת המשימות", "In the task inbox")}` : `📥 ${L("לתיבת המשימות", "To the task inbox")}`}</button>
            <button type="button" disabled={busy || !!i.note} onClick={() => void run(() => act("/note", "POST", { lang }, L("נשמר כהערה בידע", "Saved as a note in Knowledge")))}>{i.note ? `✓ ${L("שמור בידע", "In Knowledge")}` : `📝 ${L("הערה לידע", "Note to Knowledge")}`}</button>
          </div>
          <div className="idea-review">
            <button type="button" className="link" onClick={() => { setDraft({ title: i.title, prompt: i.prompt, quote: i.quote ?? "", next: i.next ?? "", kind }); setMode("edit"); }}>✎ {L("עריכה", "Edit")}</button>
            <button type="button" className="link" onClick={() => { setParts(""); setMode("split"); }}>✂ {L("פיצול", "Split")}</button>
            <button type="button" className="link danger" onClick={() => { if (confirm(L("למחוק את הפריט?", "Delete this item?"))) void act("", "DELETE", undefined, L("נמחק", "Deleted")); }}>🗑 {L("מחיקה", "Delete")}</button>
          </div>
        </>
      )}
    </li>
  );
}
