import { useEffect, useMemo, useRef, useState } from "react";
import { api, withToken } from "../api";
import { getLocale } from "../i18n";
import { createConversation, toast } from "../library";
import { MeetingRecorder } from "../MeetingRecorder";
import { Entities } from "../Entities";
import { Select } from "../ui/Select";

/** Hebrew or English, for this page's own words. */
const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Settings { enabled: boolean; intervalSec: number; excludeApps: string[]; keepFramesDays: number; keepTextDays: number; modelId?: string; allowCloud: boolean; pausedUntil?: number }
interface Info { settings: Settings; status: { running: boolean; lastCapture?: number; error?: string; ocr?: boolean; last?: { app: string; title: string; skipped?: string; idle?: boolean } }; days: string[]; platform: string }
interface Capture { t: number; app: string; title: string; text?: string; frame?: string; idle?: boolean; skipped?: string }
interface Observation { id: string; t0: number; t1: number; text: string; kind?: string }
interface Action { id: string; t: number; text: string; who?: string; state: "open" | "done" | "dismissed"; day?: string }
interface Stats { activeMinutes: number; apps: Array<{ app: string; minutes: number }>; switches: number; longestFocus: { app: string; minutes: number }; meetings: Array<{ t0: number; t1: number; title: string }>; hours: number[] }
interface Meeting { id: string; title: string; t0: number; t1?: number; segments: Array<{ t: number; text: string; who?: "me" | "others"; speaker?: number }>; summary?: string; decisions?: string[]; error?: string; recording?: { start: number; seconds: number } }
interface DayData { day: string; captures: Capture[]; meetings: Meeting[]; insights: { observations: Observation[]; actions: Action[]; summarizedTo: number; error?: string }; stats: Stats; entities: Array<{ id: string; name: string; kind: string }> }
interface SearchHit { kind: "screen" | "observation" | "entity" | "action" | "meeting"; day: string; t: number; title: string; snippet: string; frame?: string }

type Tab = "day" | "replay" | "reflect" | "entities" | "actions" | "search";

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const shift = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const hhmm = (t: number) => new Date(t).toLocaleTimeString(getLocale() === "he" ? "he-IL" : undefined, { hour: "2-digit", minute: "2-digit" });
const mins = (m: number) => (m >= 60 ? L(`${Math.floor(m / 60)} ש׳ ${Math.round(m % 60)} ד׳`, `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`) : L(`${Math.round(m)} ד׳`, `${Math.round(m)}m`));
const MEETING_WINDOW = /(zoom meeting|zoom workplace|microsoft teams|meet\.google|google meet|webex|skype|discord|huddle)/i;
const KINDS: Record<string, [string, string]> = { meeting: ["פגישה", "Meeting"], focus: ["ריכוז", "Focus"], communication: ["תקשורת", "Communication"], research: ["מחקר", "Research"], break: ["הפסקה", "Break"], other: ["אחר", "Other"] };
const kindName = (k: string) => (KINDS[k] ? L(...KINDS[k]) : k);
const frameUrl = (day: string, f: string) => withToken(`/api/journal/frame/${day}/${f}`);

/** A steady colour per app name, from the accent family. */
function appColor(app: string): string {
  let h = 0;
  for (const c of app) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${(h + 210) % 360} 45% 62%)`;
}

/**
 * "My day": what happened on this computer, written up by a model, from an
 * opt-in journal of the screen that stays on this computer.
 */
export function DayPage() {
  const [info, setInfo] = useState<Info | null>(null);
  const [tab, setTab] = useState<Tab>("day");
  const [day, setDay] = useState(today());
  const [data, setData] = useState<DayData | null>(null);
  const [replayAt, setReplayAt] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const loadInfo = () => api<Info>("/api/journal").then(setInfo, (e: Error) => toast(e.message));
  const loadDay = () => api<DayData>(`/api/journal/day/${day}`).then(setData, () => undefined);
  useEffect(() => {
    void loadInfo();
    const id = setInterval(loadInfo, 10_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    void loadDay();
    if (day !== today()) return;
    const id = setInterval(loadDay, 30_000);
    return () => clearInterval(id);
  }, [day]);

  if (!info) return <div className="page" />;
  const s = info.settings;
  const paused = !!s.pausedUntil && s.pausedUntil > Date.now();
  const save = async (patch: Partial<Settings>) => {
    await api("/api/journal/settings", { method: "PUT", body: patch }).catch((e: Error) => toast(e.message));
    await loadInfo();
  };

  if (!s.enabled && !info.days.length) return <Intro info={info} onOn={() => void save({ enabled: true })} />;

  const tabs: Array<[Tab, string]> = [
    ["day", L("היום", "Day")],
    ["replay", L("הקלטה", "Replay")],
    ["reflect", L("תמונת מצב", "Reflect")],
    ["entities", L("אנשים ופרויקטים", "People & projects")],
    ["actions", L("משימות", "Actions")],
    ["search", L("חיפוש", "Search")],
  ];

  return (
    <div className="page day-page">
      <header className="day-head">
        <div className="day-nav">
          <button type="button" className="icon-btn" aria-label={L("יום קודם", "Previous day")} onClick={() => setDay(shift(day, -1))}>‹</button>
          <input type="date" value={day} max={today()} onChange={(e) => e.target.value && setDay(e.target.value)} aria-label={L("יום", "Day")} />
          <button type="button" className="icon-btn" aria-label={L("יום הבא", "Next day")} disabled={day >= today()} onClick={() => setDay(shift(day, 1))}>›</button>
        </div>
        <span className={`rec-pill ${s.enabled && !paused ? "on" : ""}`}>
          {s.enabled ? (paused ? L(`מושהה עד ${hhmm(s.pausedUntil!)}`, `Paused until ${hhmm(s.pausedUntil!)}`) : L("מתעד את היום", "Recording your day")) : L("כבוי", "Off")}
        </span>
        <span className="grow" />
        <MeetingRecorder suggestedTitle={MEETING_WINDOW.test(`${info.status.last?.app ?? ""} ${info.status.last?.title ?? ""}`) ? info.status.last?.title : undefined} onDone={(d) => { setDay(d); void loadDay(); }} />
        {s.enabled && (paused ? <button type="button" onClick={() => void save({ pausedUntil: 0 })}>{L("המשך", "Resume")}</button> : <button type="button" onClick={() => void api("/api/journal/pause", { method: "POST", body: { minutes: 30 } }).then(loadInfo)}>{L("השהה ל-30 דקות", "Pause 30 min")}</button>)}
        {s.enabled && (
          <button
            type="button"
            onClick={() =>
              void api<{ removed: number }>("/api/journal/forget-recent", { method: "POST", body: { minutes: 15 } }).then((r) => {
                toast(L(`נמחקו ${r.removed} רגעים מ-15 הדקות האחרונות`, `Deleted ${r.removed} moments from the last 15 minutes`));
                void loadDay();
              })
            }
          >
            {L("מחק 15 דקות אחרונות", "Delete last 15 min")}
          </button>
        )}
        <button type="button" onClick={() => setShowSettings(!showSettings)}>{L("הגדרות", "Settings")}</button>
      </header>
      {info.status.error && <p className="error small">{L("הצילום האחרון נכשל: ", "The last capture failed: ")}{info.status.error}</p>}
      {showSettings && <JournalSettingsCard info={info} save={save} />}

      <div className="day-tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {tab === "day" && data && <DayView data={data} reload={loadDay} onReplay={(t) => { setReplayAt(t); setTab("replay"); }} />}
      {tab === "replay" && data && <Replay data={data} at={replayAt} />}
      {tab === "reflect" && data && <Reflect day={day} stats={data.stats} />}
      {tab === "entities" && <Entities />}
      {tab === "actions" && <Actions />}
      {tab === "search" && <Search onOpen={(d, t) => { setDay(d); setReplayAt(t); setTab("replay"); }} />}
    </div>
  );
}

function Intro({ onOn }: { info: Info; onOn: () => void }) {
  return (
    <div className="page day-page">
      <section className="day-intro">
        <h1>{L("היום שלי", "My day")}</h1>
        <p className="lede">{L("KesherAI יכול לזכור מה עשית במחשב ולכתוב לך את היום: פגישות, במה התמקדת, משימות שביקשו ממך, ואנשים ופרויקטים שחוזרים. אחר כך אפשר לחפש בכל זה או לגלול אחורה בזמן.", "KesherAI can remember what you did on this computer and write up your day: meetings, what you focused on, things people asked you to do, and the people and projects that keep coming up. Then you can search all of it or scroll back in time.")}</p>
        <ul className="day-promises">
          <li>{L("הכול נשאר במחשב הזה. שום דבר לא נשלח לאינטרנט, וזה לא נגיש מהטלפון.", "Everything stays on this computer. Nothing is sent anywhere, and it is not reachable from the phone.")}</li>
          <li>{L("לא מצלם מנהלי סיסמאות, חלונות גלישה בסתר, דפי התחברות, בנק ותשלום, ואת המסך הנעול.", "It never captures password managers, private browsing windows, sign-in, bank and payment pages, or the locked screen.")}</li>
          <li>{L("את הסיכום כותב מודל שרץ במחשב הזה, אלא אם תרשה אחרת.", "The write-up is done by a model on this computer, unless you allow otherwise.")}</li>
          <li>{L("תמונות נמחקות אחרי שבוע וטקסט אחרי 3 חודשים. אפשר להשהות, למחוק את 15 הדקות האחרונות או יום שלם.", "Pictures are deleted after a week and text after 3 months. You can pause, delete the last 15 minutes, or a whole day.")}</li>
          <li>{L("קריאת הטקסט שעל המסך נעשית במחשב הזה עם Tesseract (קוד פתוח). נתוני השפות, עברית ואנגלית, יורדים פעם אחת (בערך 15MB).", "The text on screen is read on this computer with Tesseract (open source); the Hebrew and English language data downloads once (about 15 MB).")}</li>
        </ul>
        <button type="button" className="primary big" onClick={onOn}>{L("התחל לתעד את היום", "Start recording my day")}</button>
      </section>
    </div>
  );
}

function JournalSettingsCard({ info, save }: { info: Info; save: (p: Partial<Settings>) => Promise<void> }) {
  const s = info.settings;
  const [exclude, setExclude] = useState(s.excludeApps.join(", "));
  const [models, setModels] = useState<Array<{ id: string; name?: string; location?: string }>>([]);
  useEffect(() => {
    api<Array<{ id: string; name?: string; location?: string; category?: string }>>("/api/models")
      .then((m) => setModels(m.filter((x) => !x.category || x.category === "chat")), () => undefined);
  }, []);
  return (
    <section className="card stack day-settings">
      <label className="row"><input type="checkbox" checked={s.enabled} onChange={(e) => void save({ enabled: e.target.checked })} />{L("לתעד את היום", "Record my day")}</label>
      <label className="stack"><span>{L("כל כמה שניות", "Every how many seconds")}</span>
        <Select value={s.intervalSec} onChange={(e) => void save({ intervalSec: Number(e.target.value) })}>{[15, 30, 60, 120].map((n) => <option key={n} value={n}>{n}</option>)}</Select>
      </label>
      <label className="stack"><span>{L("אפליקציות שלא לצלם (שמות תהליכים, מופרדים בפסיק)", "Apps never to capture (process names, comma-separated)")}</span>
        <input dir="ltr" value={exclude} placeholder="WhatsApp, Signal" onChange={(e) => setExclude(e.target.value)} onBlur={() => void save({ excludeApps: exclude.split(",").map((x) => x.trim()).filter(Boolean) })} />
      </label>
      <div className="row wrap">
        <label className="stack"><span>{L("לשמור תמונות (ימים)", "Keep pictures (days)")}</span><input type="number" min={1} max={365} value={s.keepFramesDays} onChange={(e) => void save({ keepFramesDays: Number(e.target.value) })} /></label>
        <label className="stack"><span>{L("לשמור טקסט (ימים)", "Keep text (days)")}</span><input type="number" min={1} max={3650} value={s.keepTextDays} onChange={(e) => void save({ keepTextDays: Number(e.target.value) })} /></label>
      </div>
      <label className="stack"><span>{L("המודל שכותב את הסיכום", "Model that writes the summary")}</span>
        <Select value={s.modelId ?? ""} onChange={(e) => void save({ modelId: e.target.value })}>
          <option value="">{L("מודל הצ'אט הפעיל", "The active chat model")}</option>
          {models.map((m) => <option key={m.id} value={m.id}>{m.name ?? m.id}{m.location === "cloud" ? " ☁" : ""}</option>)}
        </Select>
      </label>
      <label className="row"><input type="checkbox" checked={s.allowCloud} onChange={(e) => void save({ allowCloud: e.target.checked })} />{L("לאפשר למודל בענן לקרוא את הטקסט שעל המסך", "Let a cloud model read the text on screen")}</label>
      {info.status.last && <p className="muted small">{L("צילום אחרון: ", "Last capture: ")}{info.status.lastCapture ? hhmm(info.status.lastCapture) : ""} · {info.status.last.idle ? L("לא היית ליד המחשב", "you were away") : info.status.last.skipped ? L("דולג (חלון פרטי)", "skipped (private window)") : info.status.last.app}</p>}
    </section>
  );
}

/** Consecutive captures in the same app, merged. */
function blocks(caps: Capture[], gapMs: number) {
  const out: Array<{ app: string; title: string; t0: number; t1: number; firstFrame?: string; titles: Set<string> }> = [];
  for (const c of caps) {
    if (c.idle || c.skipped) continue;
    const last = out.at(-1);
    if (last && last.app === c.app && c.t - last.t1 < gapMs) {
      last.t1 = c.t;
      if (c.title) last.titles.add(c.title);
    } else out.push({ app: c.app, title: c.title, t0: c.t, t1: c.t, ...(c.frame ? { firstFrame: c.frame } : {}), titles: new Set(c.title ? [c.title] : []) });
  }
  return out.filter((b) => b.t1 - b.t0 >= 60_000 || out.length < 30);
}

function DayView({ data, reload, onReplay }: { data: DayData; reload: () => void; onReplay: (t: number) => void }) {
  const [busy, setBusy] = useState(false);
  const bl = useMemo(() => blocks(data.captures, 3 * 60_000), [data.captures]);
  const ins = data.insights;
  const summarize = async () => {
    setBusy(true);
    await api(`/api/journal/day/${data.day}/summarize`, { method: "POST", body: {} }).catch((e: Error) => toast(e.message));
    setBusy(false);
    reload();
  };
  if (!data.captures.length && !data.meetings.length) return <p className="muted day-empty">{L("אין עדיין כלום מהיום הזה.", "Nothing from this day yet.")}</p>;
  return (
    <div className="day-grid">
      <section className="day-story">
        <div className="row">
          <h2 className="grow">{L("מה עשית", "What you did")}</h2>
          <button type="button" disabled={busy} onClick={() => void summarize()}>{busy ? L("כותב…", "Writing…") : L("עדכן עכשיו", "Update now")}</button>
        </div>
        {ins.error && <p className="error small">{ins.error}</p>}
        {!ins.observations.length && !ins.error && <p className="muted small">{L("המודל כותב סיכום כל רבע שעה. אפשר גם ללחוץ \"עדכן עכשיו\".", "The model writes a summary every 15 minutes, or press Update now.")}</p>}
        <ol className="obs-list">
          {ins.observations.map((o) => (
            <li key={o.id} className={`obs ${o.kind ?? ""}`}>
              <button type="button" className="obs-time" dir="ltr" onClick={() => onReplay(o.t0)}>{hhmm(o.t0)}–{hhmm(o.t1)}</button>
              <p>{o.text}</p>
            </li>
          ))}
        </ol>
        {data.meetings.length > 0 && (
          <>
            <h3>{L("פגישות שהוקלטו", "Recorded meetings")}</h3>
            {data.meetings.map((m) => <MeetingCard key={m.id} day={data.day} m={m} reload={reload} />)}
          </>
        )}
        {data.stats.meetings.length > 0 && (
          <>
            <h3>{L("פגישות", "Meetings")}</h3>
            <ul className="plain">
              {data.stats.meetings.map((m) => <li key={m.t0}><button type="button" className="link-btn" dir="ltr" onClick={() => onReplay(m.t0)}>{hhmm(m.t0)}–{hhmm(m.t1)}</button> {m.title}</li>)}
            </ul>
          </>
        )}
        {ins.actions.length > 0 && (
          <>
            <h3>{L("משימות שעלו", "Things to do")}</h3>
            <ActionList actions={ins.actions.map((a) => ({ ...a, day: data.day }))} onChange={reload} />
          </>
        )}
        {data.entities.length > 0 && (
          <div className="chips-row">
            {data.entities.map((e) => <span key={e.id} className={`ent-chip ${e.kind}`}>{e.name}</span>)}
          </div>
        )}
      </section>
      <section className="day-timeline" aria-label={L("ציר זמן", "Timeline")}>
        <h2>{L("ציר זמן", "Timeline")}</h2>
        <ol>
          {bl.map((b) => (
            <li key={b.t0} style={{ "--app": appColor(b.app) } as React.CSSProperties}>
              <button type="button" onClick={() => onReplay(b.t0)}>
                <span className="tl-time">{hhmm(b.t0)}</span>
                <span className="tl-app">{b.app}</span>
                <span className="tl-dur">{mins((b.t1 - b.t0) / 60000 || 0.5)}</span>
                <span className="tl-title">{[...b.titles].slice(0, 2).join(" · ")}</span>
              </button>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function MeetingCard({ day, m, reload }: { day: string; m: Meeting; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // A kept recording: the transcript follows playback, and a line jumps the player to it.
  const player = useRef<HTMLAudioElement>(null);
  const [now, setNow] = useState(-1);
  const rec = m.recording;
  const at = (t: number) => (rec ? Math.max(0, (t - rec.start) / 1000) : 0);
  const current = rec && now >= 0 ? m.segments.reduce((best, x, i) => (at(x.t) <= now + 0.25 ? i : best), -1) : -1;
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (current < 0) return;
    list.current?.children[current]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [current]);
  const jump = (t: number) => {
    const a = player.current;
    if (!a) return;
    a.currentTime = at(t);
    void a.play();
  };
  return (
    <article className="meeting-card">
      <header className="row">
        <strong className="grow">{m.title}</strong>
        <span className="muted small" dir="ltr">{hhmm(m.t0)}{m.t1 ? `–${hhmm(m.t1)}` : ""}</span>
      </header>
      {m.summary && <p>{m.summary}</p>}
      {!!m.decisions?.length && (
        <>
          <h4>{L("החלטות", "Decisions")}</h4>
          <ul className="plain">{m.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul>
        </>
      )}
      {m.error && <p className="error small">{m.error}</p>}
      {rec && (
        <audio
          ref={player}
          className="meeting-player"
          controls
          preload="metadata"
          src={withToken(`/api/journal/meetings/${day}/${m.id}/recording`)}
          onPlay={() => setOpen(true)}
          onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
        />
      )}
      <div className="row small">
        <button type="button" className="link-btn" onClick={() => setOpen(!open)}>{open ? L("הסתר תמלול", "Hide transcript") : L(`תמלול (${m.segments.length})`, `Transcript (${m.segments.length})`)}</button>
        {(m.error || !m.summary) && <button type="button" className="link-btn" disabled={busy} onClick={() => { setBusy(true); void api(`/api/journal/meetings/${day}/${m.id}/finish`, { method: "POST", body: {} }).then(reload).finally(() => setBusy(false)); }}>{busy ? L("כותב…", "Writing…") : L("סכם שוב", "Write up again")}</button>}
        {m.segments.length > 0 && <button type="button" className="link-btn" onClick={() => void askAbout(m)}>{L("שאל על הפגישה", "Ask about this meeting")}</button>}
        {rec && <button type="button" className="link-btn" onClick={() => confirm(L("למחוק רק את ההקלטה? התמלול והסיכום נשארים.", "Delete only the recording? The transcript and write-up stay.")) && void api(`/api/journal/meetings/${day}/${m.id}/recording`, { method: "DELETE" }).then(reload)}>{L("מחק הקלטה", "Delete recording")}</button>}
        <button type="button" className="link-btn" onClick={() => void api(`/api/journal/meetings/${day}/${m.id}`, { method: "DELETE" }).then(reload)}>{L("מחק", "Delete")}</button>
      </div>
      {open && (
        <ol className="transcript" ref={list}>
          {m.segments.map((x, i) => <li key={`${x.t}-${x.who ?? ""}`} className={`${i === current ? "now" : ""}${rec ? " seekable" : ""}`} {...(rec ? { onClick: () => jump(x.t), title: L("נגן מכאן", "Play from here") } : {})}><span className="muted small" dir="ltr">{hhmm(x.t)}</span> {x.who && <strong className={`who ${x.who}${x.speaker ? ` s${(x.speaker - 1) % 6}` : ""}`}>{x.who === "me" ? L("אני", "Me") : x.speaker ? L(`דובר ${x.speaker}`, `Speaker ${x.speaker}`) : L("האחרים", "Others")}:</strong>} {x.text}</li>)}
        </ol>
      )}
    </article>
  );
}

/** Opens a chat about a meeting: its write-up and transcript go in the first message. */
async function askAbout(m: Meeting): Promise<void> {
  const lines = m.segments.map((x) => `[${hhmm(x.t)}] ${x.who === "me" ? "Me: " : x.speaker ? `Speaker ${x.speaker}: ` : x.who === "others" ? "Others: " : ""}${x.text}`).join("\n");
  const id = await createConversation({ kind: "chat" });
  if (!id) return;
  const text = L(
    `זו הפגישה "${m.title}". אני אשאל עליה שאלות; ענה רק לפי מה שנאמר בה. בינתיים אשר בקצרה שקראת.`,
    `This is the meeting "${m.title}". I will ask questions about it; answer only from what was said. For now, just confirm briefly that you read it.`,
  ) + `\n\n${m.summary ? `${L("סיכום", "Summary")}: ${m.summary}\n\n` : ""}${L("תמלול", "Transcript")} ("Me" = ${L("אני", "me")}):\n${lines.slice(-60_000)}`;
  await api(`/api/conversations/${id}/messages`, { method: "POST", body: { text } }).catch(() => undefined);
}

function Replay({ data, at }: { data: DayData; at: number | null }) {
  const frames = useMemo(() => data.captures.filter((c) => c.frame), [data.captures]);
  const startIdx = () => {
    if (at === null) return Math.max(0, frames.length - 1);
    const i = frames.findIndex((f) => f.t >= at);
    return i < 0 ? frames.length - 1 : i;
  };
  const [i, setI] = useState(startIdx);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    setI(startIdx());
  }, [at, frames.length]);
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setI((x) => (x + 1 < frames.length ? x + 1 : (setPlaying(false), x))), 400);
    return () => clearInterval(id);
  }, [playing, frames.length]);
  const f = frames[i];
  // Preload the next pictures so scrubbing feels like video.
  const pre = useRef<HTMLImageElement[]>([]);
  useEffect(() => {
    pre.current = frames.slice(i + 1, i + 4).map((x) => Object.assign(new Image(), { src: frameUrl(data.day, x.frame!) }));
  }, [i]);
  if (!frames.length) return <p className="muted day-empty">{L("אין תמונות מהיום הזה (הן נמחקות אחרי כמה ימים, לפי ההגדרות).", "No pictures from this day (they are deleted after some days, as set).")}</p>;
  return (
    <div className="replay">
      <div className="replay-screen">{f && <img src={frameUrl(data.day, f.frame!)} alt={`${f.app} ${f.title}`} />}</div>
      <div className="replay-bar" dir="ltr">
        <button type="button" className="icon-btn" aria-label={playing ? L("עצור", "Pause") : L("נגן", "Play")} onClick={() => setPlaying(!playing)}>{playing ? "❚❚" : "▶"}</button>
        <input type="range" min={0} max={frames.length - 1} value={i} onChange={(e) => { setPlaying(false); setI(Number(e.target.value)); }} aria-label={L("זמן", "Time")} />
        <span className="replay-time">{f ? hhmm(f.t) : ""}</span>
      </div>
      {f && <p className="replay-caption"><strong>{f.app}</strong> {f.title}</p>}
    </div>
  );
}

function Reflect({ day, stats }: { day: string; stats: Stats }) {
  const [week, setWeek] = useState<Array<{ day: string; stats: Stats }>>([]);
  useEffect(() => {
    api<Array<{ day: string; stats: Stats }>>(`/api/journal/week/${day}`).then(setWeek, () => undefined);
  }, [day]);
  const maxDay = Math.max(1, ...week.map((w) => w.stats.activeMinutes));
  const maxApp = Math.max(1, ...stats.apps.map((a) => a.minutes));
  const maxHour = Math.max(1, ...stats.hours);
  const perHour = stats.activeMinutes ? (stats.switches / (stats.activeMinutes / 60)).toFixed(0) : "0";
  return (
    <div className="reflect">
      <div className="reflect-figures">
        <div><strong>{mins(stats.activeMinutes)}</strong><span>{L("ליד המחשב", "at the computer")}</span></div>
        <div><strong>{mins(stats.longestFocus.minutes)}</strong><span>{L(`הריכוז הארוך ביותר (${stats.longestFocus.app || "—"})`, `longest focus (${stats.longestFocus.app || "—"})`)}</span></div>
        <div><strong>{perHour}</strong><span>{L("מעברים בין אפליקציות בשעה", "app switches per hour")}</span></div>
        <div><strong>{stats.meetings.length}</strong><span>{L("פגישות", "meetings")}</span></div>
      </div>
      <section>
        <h3>{L("לאן הלך הזמן", "Where the time went")}</h3>
        <ul className="bars">
          {stats.apps.slice(0, 10).map((a) => (
            <li key={a.app}><span className="bar-label">{a.app}</span><span className="bar-track"><span style={{ width: `${(a.minutes / maxApp) * 100}%`, background: appColor(a.app) }} /></span><span className="bar-val">{mins(a.minutes)}</span></li>
          ))}
        </ul>
      </section>
      <section>
        <h3>{L("לפי שעה", "By hour")}</h3>
        <div className="hours">
          {stats.hours.map((m, h) => <span key={h} title={`${h}:00 · ${mins(m)}`} style={{ height: `${(m / maxHour) * 100}%` }} data-h={h % 3 === 0 ? h : ""} />)}
        </div>
      </section>
      <section>
        <h3>{L("השבוע", "This week")}</h3>
        <div className="week">
          {week.map((w) => (
            <div key={w.day} className={w.day === day ? "on" : ""}>
              <span className="week-bar" style={{ height: `${(w.stats.activeMinutes / maxDay) * 100}%` }} />
              <span className="week-label">{new Date(`${w.day}T12:00:00`).toLocaleDateString(getLocale() === "he" ? "he-IL" : undefined, { weekday: "short" })}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function ActionList({ actions, onChange }: { actions: Action[]; onChange: () => void }) {
  const set = (a: Action, state: Action["state"]) => void api(`/api/journal/actions/${a.day}/${a.id}`, { method: "PATCH", body: { state } }).then(onChange);
  return (
    <ul className="act-list">
      {actions.map((a) => (
        <li key={a.id} className={a.state}>
          <label className="row"><input type="checkbox" checked={a.state === "done"} onChange={(e) => set(a, e.target.checked ? "done" : "open")} /><span className="grow">{a.text}{a.who && <span className="muted small"> · {a.who}</span>}</span></label>
          {a.state === "open" && <button type="button" className="link-btn small" onClick={() => set(a, "dismissed")}>{L("לא רלוונטי", "Not relevant")}</button>}
        </li>
      ))}
    </ul>
  );
}

function Actions() {
  const [list, setList] = useState<Action[] | null>(null);
  const load = () => api<Action[]>("/api/journal/actions").then(setList, () => undefined);
  useEffect(() => void load(), []);
  if (!list) return null;
  return (
    <section className="stack">
      <p className="muted small">{L("דברים שהמודל ראה שביקשו ממך או שהבטחת, מ-30 הימים האחרונים. שום דבר לא נשלח בשמך.", "Things the model saw you were asked to do or promised, from the last 30 days. Nothing is sent on your behalf.")}</p>
      {list.length ? <ActionList actions={list} onChange={load} /> : <p className="muted">{L("אין משימות פתוחות.", "No open actions.")}</p>}
    </section>
  );
}

function Search({ onOpen }: { onOpen: (day: string, t: number) => void }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<{ journal: SearchHit[]; conversations: Array<{ id: string; title: string; snippet: string }> } | null>(null);
  const run = (v: string) => (v.trim() ? api<typeof res>(`/api/journal/search?q=${encodeURIComponent(v)}`).then(setRes, () => undefined) : setRes(null));
  const label: Record<SearchHit["kind"], string> = { meeting: L("בפגישה", "In a meeting"), screen: L("על המסך", "On screen"), observation: L("בסיכום", "In the summary"), entity: L("אדם/פרויקט", "Person/project"), action: L("משימה", "Action") };
  return (
    <div className="stack">
      <form onSubmit={(e) => { e.preventDefault(); void run(q); }} className="row">
        <input className="grow" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={L("חפש בכל מה שראית ובכל השיחות…", "Search everything you saw and every conversation…")} />
        <button type="submit" className="primary">{L("חפש", "Search")}</button>
      </form>
      {res && (
        <>
          {res.conversations.length > 0 && (
            <section>
              <h3>{L("שיחות", "Conversations")}</h3>
              <ul className="hits">
                {res.conversations.map((c) => <li key={c.id}><a href={`#/c/${c.id}`}><strong>{c.title}</strong><span className="muted small">{c.snippet}</span></a></li>)}
              </ul>
            </section>
          )}
          <section>
            <h3>{L("היומן", "Journal")}</h3>
            {!res.journal.length && <p className="muted">{L("לא נמצא.", "Nothing found.")}</p>}
            <ul className="hits">
              {res.journal.map((h, i) => (
                <li key={i}>
                  <button type="button" onClick={() => onOpen(h.day, h.t)}>
                    {h.frame && <img src={frameUrl(h.day, h.frame)} alt="" loading="lazy" />}
                    <span className="stack">
                      <span className="muted small">{label[h.kind]} · {new Date(h.t).toLocaleString(getLocale() === "he" ? "he-IL" : undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}</span>
                      {h.title && <strong>{h.kind === "observation" ? kindName(h.title) : h.title}</strong>}
                      <span className="small">{h.snippet}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
