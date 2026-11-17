import { useEffect, useRef, useState } from "react";
import type { Idea, IdeaSession, IdeaVerdict } from "@kesher/shared";
import { api, withToken } from "../api";
import { getLocale, he$ } from "../i18n";
import { createConversation, toast } from "../library";
import { openWithDraft } from "../phone";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
type Row = Omit<IdeaSession, "transcript" | "ideas"> & { count: number; good: number };

const VERDICT: Record<IdeaVerdict, [string, string, string]> = {
  good: ["👍 טוב", "👍 Good", "good"],
  maybe: ["🤔 אולי", "🤔 Maybe", "maybe"],
  weak: ["👎 חלש", "👎 Weak", "weak"],
};
const MINUTES = [5, 10, 15, 30, 0];
const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * "Open mind" (#/ideas, design IdeaSession): record yourself thinking aloud for as long as you choose, then see every
 * idea sorted (good / maybe / weak, tried before or new, which project, who for), research one or all in a row.
 */
export function IdeasPage() {
  const [sessions, setSessions] = useState<Row[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const load = () => void api<{ sessions: Row[] }>("/api/ideas").then((r) => setSessions(r.sessions), (e: Error) => toast(e.message));
  useEffect(load, []);
  return (
    <main className="page ideas-page">
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
              {!sessions.length && <p className="muted">{L("עוד אין. התחילו הקלטה, או הדביקו טקסט.", "None yet. Start a recording, or paste text.")}</p>}
              <ul className="ideas-sessions">
                {sessions.map((s) => (
                  <li key={s.id}>
                    <button type="button" className="ideas-session-row" onClick={() => setOpen(s.id)}>
                      <b>{new Date(s.t).toLocaleString(getLocale() === "he" ? "he-IL" : "en-GB", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })}</b>
                      <span className="muted small">{s.seconds ? `${Math.round(s.seconds / 60)} ${L("דק׳", "min")} · ` : ""}{s.status === "done" ? L(`${s.count} רעיונות, ${s.good} טובים`, `${s.count} ideas, ${s.good} good`) : s.status === "error" ? L("נכשל", "Failed") : L("ממיין…", "Sorting…")}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <PasteText onDone={(id) => { load(); setOpen(id); }} />
            </>
          )}
        </section>
      </div>
    </main>
  );
}

/** The recorder: a length (or until stopped), a timer with a level meter, pause, finish. */
function Recorder({ onDone }: { onDone: (id: string) => void }) {
  const [minutes, setMinutes] = useState(15);
  const [state, setState] = useState<"idle" | "rec" | "paused" | "sending">("idle");
  const [secs, setSecs] = useState(0);
  const [levels, setLevels] = useState<number[]>(Array(14).fill(2));
  const [failed, setFailed] = useState<Blob | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const tick = useRef<number>(0);
  const stopAll = useRef<() => void>(() => undefined);
  const secsRef = useRef(0);

  const send = async (blob: Blob, seconds: number) => {
    setState("sending");
    const res = await fetch(withToken("/api/ideas/record"), { method: "POST", headers: { "content-type": "application/x-kesher-audio", "x-audio-type": blob.type || "audio/webm", "x-seconds": String(Math.round(seconds)) }, body: blob }).catch(() => undefined);
    setState("idle");
    const s = res?.ok ? ((await res.json()) as IdeaSession) : undefined;
    if (!s) {
      setFailed(blob);
      return toast(res ? ((await res.json().catch(() => ({}))) as { error?: string }).error ?? L("השליחה נכשלה.", "Sending failed.") : L("השליחה נכשלה.", "Sending failed."));
    }
    setFailed(null);
    onDone(s.id);
  };

  const start = async () => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      return toast(L("אין גישה למיקרופון.", "No access to the microphone."));
    }
    const type = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported?.(t)) ?? "";
    const r = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32_000 } : undefined);
    chunks.current = [];
    r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    // A level meter, so she sees it hears her.
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 64;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.frequencyBinCount);
    const meter = window.setInterval(() => {
      an.getByteFrequencyData(buf);
      setLevels(Array.from({ length: 14 }, (_, i) => 2 + Math.round(((buf[i + 1] ?? 0) / 255) * 26)));
    }, 120);
    r.onstop = () => {
      window.clearInterval(meter);
      window.clearInterval(tick.current);
      void ctx.close();
      stream.getTracks().forEach((t) => t.stop());
      void send(new Blob(chunks.current, { type: r.mimeType || type || "audio/webm" }), secsRef.current);
    };
    r.start(5000);
    rec.current = r;
    secsRef.current = 0;
    setSecs(0);
    setState("rec");
    stopAll.current = () => r.state !== "inactive" && r.stop();
    tick.current = window.setInterval(() => {
      if (r.state !== "recording") return;
      secsRef.current += 1;
      setSecs(secsRef.current);
      if (minutes && secsRef.current >= minutes * 60) r.stop();
    }, 1000);
  };
  useEffect(() => () => stopAll.current(), []);

  const pause = () => {
    const r = rec.current;
    if (!r) return;
    if (r.state === "recording") {
      r.pause();
      setState("paused");
    } else if (r.state === "paused") {
      r.resume();
      setState("rec");
    }
  };
  const total = minutes * 60;
  const pct = total ? Math.min(1, secs / total) : 0;
  return (
    <section className="card ideas-rec">
      <b>{L("הקלטה", "Recording")}</b>
      <span className="muted small">{L("שבו בנוח, דברו כל מה שעולה. אפשר לחזור על עצמכם, לקפוץ בין נושאים ולשתוק.", "Sit back and say whatever comes. Repeat yourself, jump between topics, be quiet a while.")}</span>
      <div className={`ideas-dial ${state}`} style={{ ["--p" as string]: String(pct) }}>
        <b dir="ltr">{clock(secs)}</b>
        <span className="muted small">{minutes ? L(`מתוך ${clock(total)}`, `of ${clock(total)}`) : L("עד שתעצרו", "until you stop")}</span>
      </div>
      <div className="ideas-levels" aria-hidden="true">{levels.map((h, i) => <span key={i} style={{ height: state === "rec" ? h : 2 }} />)}</div>
      {state === "idle" && (
        <div className="ideas-mins" role="radiogroup" aria-label={L("כמה זמן", "How long")}>
          {MINUTES.map((m) => <button type="button" key={m} role="radio" aria-checked={minutes === m} className={minutes === m ? "on" : ""} onClick={() => setMinutes(m)}>{m ? (m === 5 ? L("5 דק׳", "5 min") : m) : L("עד שאעצור", "Until I stop")}</button>)}
        </div>
      )}
      <div className="row">
        {state === "idle" && <button type="button" className="primary" onClick={() => void start()}>🎙 {L("להתחיל", "Start")}</button>}
        {(state === "rec" || state === "paused") && <button type="button" onClick={pause}>{state === "paused" ? `▶ ${L("להמשיך", "Resume")}` : `⏸ ${L("השהיה", "Pause")}`}</button>}
        {(state === "rec" || state === "paused") && <button type="button" className="primary" onClick={() => rec.current?.stop()}>⏹ {L("לסיים ולמיין", "Finish and sort")}</button>}
        {state === "sending" && <span className="muted">{L("שולח…", "Sending…")}</span>}
      </div>
      {failed && (
        <p className="small">
          {L("ההקלטה לא נשלחה, אבל היא שמורה כאן:", "The recording was not sent, but it is kept here:")}{" "}
          <button type="button" className="link" onClick={() => void send(failed, secsRef.current)}>{L("לנסות שוב", "Try again")}</button>{" · "}
          <a href={URL.createObjectURL(failed)} download={`ideas-${new Date().toISOString().slice(0, 16)}.webm`}>{L("להוריד", "Download")}</a>
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

type Filter = "all" | IdeaVerdict | "tried" | "new";

/** One session: its ideas, filters, research one or all. */
function SessionView({ id, onBack }: { id: string; onBack: () => void }) {
  const [s, setS] = useState<IdeaSession | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [showText, setShowText] = useState(false);
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
  const research = async (idea: Idea) => {
    if (idea.research?.conversationId && idea.research.status !== "error") return void (location.hash = `#/c/${idea.research.conversationId}`);
    try {
      await api(`/api/ideas/${id}/ideas/${idea.id}/research`, { method: "POST", body: { lang } });
      toast(L("המחקר התחיל בצ'אט חדש", "Research started in a new chat"));
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
  const n = (f: (i: Idea) => boolean) => s.ideas.filter(f).length;
  const shown = s.ideas.filter((i) => filter === "all" || (filter === "tried" ? i.tried === "yes" : filter === "new" ? i.tried !== "yes" : i.verdict === filter));
  const researched = n((i) => i.research?.status === "done");
  const pills: Array<[Filter, string, number]> = [
    ["all", L("הכל", "All"), s.ideas.length],
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
        {s.status === "done" && <button type="button" className={s.researchAll ? "" : "primary"} onClick={() => void all()}>{s.researchAll ? `⏹ ${L("לעצור את המחקר ברצף", "Stop researching")}` : `🔬 ${L("מחקר על הכל ברצף", "Research all in a row")}`} ({researched}/{s.ideas.length})</button>}
        <button type="button" className="icon-btn" title={L("מחיקת הסשן", "Delete the session")} onClick={async () => { if (confirm(L("למחוק את הסשן? צ'אטי המחקר נשארים.", "Delete the session? Research chats stay."))) { await api(`/api/ideas/${id}`, { method: "DELETE" }); onBack(); } }}>🗑</button>
      </div>
      {s.status === "transcribing" && <p className="muted">⏳ {L("מתמלל את ההקלטה… (הקלטה ארוכה לוקחת כמה דקות)", "Transcribing the recording… (a long one takes a few minutes)")}</p>}
      {s.status === "sorting" && <p className="muted">⏳ {L("מוציא את הרעיונות וממיין…", "Pulling out the ideas and sorting…")}</p>}
      {s.status === "error" && <p className="error">{s.error}</p>}
      {s.status === "done" && (
        <>
          <div className="ideas-filters" role="tablist">
            {pills.map(([f, label, c]) => <button type="button" key={f} role="tab" aria-selected={filter === f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{label} {c}</button>)}
          </div>
          <ul className="ideas-list">
            {shown.map((i) => (
              <li key={i.id} className={`card idea ${VERDICT[i.verdict][2]}`}>
                <div className="idea-top">
                  <b dir="auto">{i.title}</b>
                  <span className={`idea-tag ${VERDICT[i.verdict][2]}`} title={i.why}>{L(VERDICT[i.verdict][0], VERDICT[i.verdict][1])}</span>
                  {i.tried === "yes" ? <span className="idea-tag tried" title={i.triedNote}>↺ {L("ניסית בעבר", "Tried before")}</span> : <span className="idea-tag">✦ {L("חדש", "New")}</span>}
                </div>
                <p className="muted small" dir="auto">{i.why}</p>
                <p className="idea-prompt" dir="auto">“{i.prompt}”</p>
                {i.tried === "yes" && (
                  <p className="small" dir="auto">↺ {i.triedNote} {i.triedIn?.map((c) => <a key={c.conversationId} href={`#/c/${c.conversationId}`} className="idea-was">{c.title}</a>)}</p>
                )}
                <div className="idea-meta">
                  <span>📁 {i.projects.length ? i.projects.join(", ") : L("לא שייך לפרויקט", "No project")}</span>
                  {i.audience && <span>👥 {i.audience}</span>}
                  {i.category && <span>🏷 {i.category}</span>}
                </div>
                <div className="row">
                  <button type="button" className={i.research?.status === "done" ? "primary" : ""} onClick={() => void research(i)}>
                    {i.research?.status === "done" ? `📄 ${L("המחקר מוכן", "Research ready")}` : i.research?.status === "running" ? `⏳ ${L("חוקר…", "Researching…")}` : i.research?.status === "error" ? `↻ ${L("לנסות שוב מחקר", "Retry research")}` : `🔬 ${L("מחקר", "Research")}`}
                  </button>
                  <button type="button" onClick={() => void toChat(i)}>💬 {L("לצ'אט כפרומפט", "To a chat as a prompt")}</button>
                </div>
              </li>
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
