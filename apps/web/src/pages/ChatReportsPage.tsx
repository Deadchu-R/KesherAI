import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { text, unzipSome, waTitle } from "../ImportPeopleChats";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

type Kind = "couple" | "friends" | "family" | "group" | "work";
type Voice = "coach" | "friend" | "roast";
interface Quote { who: string; at: string; text: string }
interface Person { name: string; messages: number; words: number; starts: number; replyMinutes?: number; questions: number; laughs: number; love: number; topEmojis: string[] }
interface Numbers { messages: number; from: string; to: string; days: number; people: Person[]; hours: number[]; months: Array<{ month: string; messages: number }>; busiestDay?: { day: string; messages: number }; longestSilence?: { from: string; to: string; days: number }; longestStreak: number; topWords: string[] }
interface Report { headline: string; read: string; scores: Array<{ name: string; value: string; measured: boolean }>; findings: Array<{ title: string; body: string; measured: boolean; quotes: Quote[] }>; turningPoint?: { when: string; what: string; quotes: Quote[] }; roles: Array<{ name: string; role: string }>; next: string }
interface Stored { id: string; title: string; kind: Kind; voice: Voice; me?: string; createdAt: string; status: "reading" | "writing" | "done" | "error"; progress?: { part: number; parts: number; total: number }; error?: string; numbers: Numbers; report?: Report; followUps: Array<{ q: string; a: string; quotes: Quote[]; at: string }> }
interface Item { id: string; title: string; kind: Kind; status: Stored["status"]; createdAt: string; messages: number }
interface Body { source: "whatsapp" | "instagram"; title: string; text?: string; parts?: unknown[] }
interface Peek { title: string; messages: number; from: string; to: string; people: Array<{ name: string; messages: number }> }

const KINDS: Array<[Kind, string, string]> = [["couple", "זוג", "Couple"], ["friends", "חברים", "Friends"], ["family", "משפחה", "Family"], ["group", "קבוצה", "Group"], ["work", "עבודה", "Work"]];
const VOICES: Array<[Voice, string, string]> = [["coach", "מאמן", "Coach"], ["friend", "חבר כן", "Honest friend"], ["roast", "צולה", "Roaster"]];
const kindName = (k: Kind) => { const x = KINDS.find((y) => y[0] === k)!; return L(x[1], x[2]); };
const when = (at: string) => (at ? new Date(at).toLocaleString(getLocale() === "he" ? "he-IL" : undefined, { day: "numeric", month: "numeric", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");

/** Reads a chosen file into what the server parses (WhatsApp txt/zip, Instagram json/zip with one chat). */
async function readChat(files: File[]): Promise<Body> {
  const first = files[0]!;
  if (/\.zip$/i.test(first.name)) {
    const found = await unzipSome(first, (n) => /\.txt$/i.test(n) || /messages\/(inbox|message_requests)\/[^/]+\/message_\d+\.json$/i.test(n));
    const txt = Object.keys(found).find((n) => /\.txt$/i.test(n));
    if (txt) return { source: "whatsapp", title: waTitle(/_chat\.txt$/i.test(txt) ? first.name : txt), text: text(found[txt]!) };
    const threads = new Set(Object.keys(found).map((n) => /messages\/(?:inbox|message_requests)\/([^/]+)\//i.exec(n)?.[1] ?? ""));
    if (threads.size !== 1) throw new Error(L("ב-zip יש כמה שיחות אינסטגרם. בחר את קובצי message_1.json של שיחה אחת.", "The zip has several Instagram chats. Choose one chat's message_1.json files."));
    return { source: "instagram", title: "", parts: Object.values(found).map((b) => JSON.parse(text(b)) as unknown) };
  }
  if (/\.json$/i.test(first.name)) return { source: "instagram", title: "", parts: await Promise.all(files.filter((f) => /\.json$/i.test(f.name)).map((f) => f.text().then((t) => JSON.parse(t) as unknown))) };
  return { source: "whatsapp", title: waTitle(first.name), text: await first.text() };
}

/** #/chat-reports: a chat read into a report (RESEARCH_LOG "Chat reports"). */
export function ChatReportsPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [open, setOpen] = useState<string | "new" | null>(null);
  const load = () => void api<{ reports: Item[] }>("/api/chat-reports").then((r) => { setItems(r.reports); setOpen((o) => o ?? r.reports[0]?.id ?? "new"); }, () => undefined);
  useEffect(load, []);
  return (
    <div className="chat-reports">
      <aside className="card stack cr-list">
        <h2>{L("קריאת צ'אט", "Chat reading")}</h2>
        <button type="button" className="primary" onClick={() => setOpen("new")}>{L("+ דוח חדש", "+ New report")}</button>
        {items.map((it) => (
          <button key={it.id} type="button" className={`cr-item${open === it.id ? " active" : ""}`} onClick={() => setOpen(it.id)}>
            <span dir="auto">{it.title}</span>
            <small className="muted">{kindName(it.kind)} · {it.messages.toLocaleString()} {L("הודעות", "messages")}{it.status !== "done" ? ` · ${it.status === "error" ? L("נכשל", "failed") : L("נכתב…", "writing…")}` : ""}</small>
          </button>
        ))}
        <p className="muted small">{L("הכל נקרא על המחשב הזה. שום הודעה לא יוצאת ממנו.", "Everything is read on this computer. No message leaves it.")}</p>
      </aside>
      <main className="cr-main">
        {open === "new" ? <NewReport onMade={(id) => { load(); setOpen(id); }} /> : open ? <ReportView key={open} id={open} onGone={() => { setOpen(null); load(); }} /> : null}
      </main>
    </div>
  );
}

function NewReport({ onMade }: { onMade: (id: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [body, setBody] = useState<Body | null>(null);
  const [peek, setPeek] = useState<Peek | null>(null);
  const [kind, setKind] = useState<Kind>("friends");
  const [voice, setVoice] = useState<Voice>("friend");
  const [me, setMe] = useState("");
  const [backstory, setBackstory] = useState("");
  const [busy, setBusy] = useState(false);
  const pick = async (files: File[]) => {
    setBusy(true);
    try {
      const b = await readChat(files);
      const p = await api<Peek>("/api/chat-reports/peek", { method: "POST", body: b });
      setBody(b);
      setPeek(p);
      setKind(p.people.length > 2 ? "group" : "friends");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  const make = async () => {
    if (!body) return;
    setBusy(true);
    try {
      const r = await api<{ id: string }>("/api/chat-reports", { method: "POST", body: { ...body, kind, voice, lang: getLocale() === "he" ? "he" : "en", ...(me ? { me } : {}), ...(backstory ? { backstory } : {}) } });
      onMade(r.id);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const chips = <T extends string>(list: Array<[T, string, string]>, value: T, set: (v: T) => void, label: string) => (
    <div className="stack tight">
      <span className="muted small">{label}</span>
      <div className="row wrap" role="radiogroup" aria-label={label}>
        {list.map(([v, he, en]) => <button key={v} type="button" role="radio" aria-checked={value === v} className={`chip${value === v ? " on" : ""}`} onClick={() => set(v)}>{L(he, en)}</button>)}
      </div>
    </div>
  );
  return (
    <section className="card stack">
      <h2>{L("דוח חדש", "New report")}</h2>
      <button type="button" className="cr-drop" disabled={busy} onClick={() => input.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) void pick([...e.dataTransfer.files]); }}>
        {peek ? <span dir="auto"><b>{peek.title}</b> · {peek.messages.toLocaleString()} {L("הודעות", "messages")} · {peek.from} – {peek.to}</span> : L("גרור או בחר ייצוא צ'אט מוואטסאפ (‎.txt או ‎.zip, בלי מדיה) או מאינסטגרם (JSON)", "Drop or choose a chat export from WhatsApp (.txt or .zip, without media) or Instagram (JSON)")}
      </button>
      <input ref={input} type="file" multiple hidden accept=".txt,.zip,.json,text/plain,application/zip,application/json" onChange={(e) => e.target.files?.length && void pick([...e.target.files])} />
      {peek && (
        <>
          {chips(KINDS, kind, setKind, L("איזה צ'אט זה", "What chat is this"))}
          {chips([...peek.people.slice(0, 8).map((p) => [p.name, p.name, p.name] as [string, string, string]), ["", "אף אחד", "Nobody"]], me, setMe, L("מי אתה בצ'אט", "Who you are in it"))}
          {chips(VOICES, voice, setVoice, L("הקול של הדוח", "The report's voice"))}
          <textarea rows={3} value={backstory} onChange={(e) => setBackstory(e.target.value)} placeholder={L("רקע קצר (לא חובה): איך הכרתם, מה רצית לדעת…", "A little background (optional): how you met, what you want to know…")} />
          <button type="button" className="primary" disabled={busy} onClick={() => void make()}>{L("כתוב את הדוח", "Write the report")}</button>
          <p className="muted small">{L("המודל על המחשב הזה קורא את הצ'אט בחלקים. צ'אט ארוך לוקח כמה דקות.", "The model on this computer reads the chat in parts. A long chat takes a few minutes.")}</p>
        </>
      )}
    </section>
  );
}

function ReportView({ id, onGone }: { id: string; onGone: () => void }) {
  const [r, setR] = useState<Stored | null>(null);
  const [q, setQ] = useState("");
  const [asking, setAsking] = useState(false);
  const load = () => void api<Stored>(`/api/chat-reports/${id}`).then(setR, () => onGone());
  useEffect(load, [id]);
  useEffect(() => {
    if (!r || r.status === "done" || r.status === "error") return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [r?.status]);
  if (!r) return <p className="muted">{L("טוען…", "Loading…")}</p>;
  const n = r.numbers;
  const max = Math.max(1, ...n.hours);
  const ask = async () => {
    setAsking(true);
    try {
      await api(`/api/chat-reports/${id}/ask`, { method: "POST", body: { question: q } });
      setQ("");
      load();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setAsking(false);
    }
  };
  const quotes = (qs: Quote[]) => qs.map((x, i) => <blockquote key={i} className="cr-quote" dir="auto"><small className="muted">{x.who}{x.at ? `, ${when(x.at)}` : ""}</small><br />"{x.text}"</blockquote>);
  const tag = (measured: boolean) => <span className="cr-tag">{measured ? L("נמדד", "measured") : L("נקרא", "read")}</span>;
  const rep = r.report;
  return (
    <div className="stack">
      <section className="card stack">
        <div className="row"><small className="muted grow" dir="auto">{r.title} · {kindName(r.kind)} · {n.from} – {n.to}</small><button type="button" className="ghost small" onClick={() => { if (confirm(L("למחוק את הדוח ואת העותק של הצ'אט?", "Delete the report and its copy of the chat?"))) void api(`/api/chat-reports/${id}`, { method: "DELETE" }).then(onGone); }}>{L("מחק", "Delete")}</button></div>
        {rep ? <><h1 className="cr-headline" dir="auto">{rep.headline}</h1><p dir="auto">{rep.read}</p></>
          : r.status === "error" ? <p className="bad">{r.error}</p>
          : <><progress max={r.progress?.parts ?? 1} value={r.status === "writing" ? r.progress?.parts ?? 1 : (r.progress?.part ?? 0) - 1} /><span className="muted small">{r.status === "writing" ? L("כותב את הדוח…", "Writing the report…") : L(`קורא חלק ${r.progress?.part ?? 1} מתוך ${r.progress?.parts ?? "?"}…`, `Reading part ${r.progress?.part ?? 1} of ${r.progress?.parts ?? "?"}…`)}</span></>}
      </section>
      {rep && rep.scores.length > 0 && (
        <section className="card cr-scores">
          {rep.scores.map((s) => <div key={s.name}><b dir="auto">{s.value}</b><div className="muted small">{s.name}</div>{tag(s.measured)}</div>)}
        </section>
      )}
      <section className="card stack">
        <b>{L("מתי מדברים", "When you talk")}</b>
        <div className="cr-hours" aria-label={L("הודעות לפי שעה", "Messages by hour")}>
          {n.hours.map((h, i) => <div key={i} title={`${String(i).padStart(2, "0")}:00 · ${h}`} style={{ opacity: 0.12 + (0.88 * h) / max }} />)}
        </div>
        <div className="row muted small cr-hour-axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
        <ul className="plain small stack tight">
          {n.people.slice(0, 6).map((p) => (
            <li key={p.name} dir="auto"><b>{p.name}</b>: {p.messages.toLocaleString()} {L("הודעות", "messages")} · {L("פתח/ה", "opened")} {p.starts} {L("שיחות", "conversations")}{p.replyMinutes !== undefined ? ` · ${L("עונה בתוך", "replies in")} ${p.replyMinutes < 60 ? `${Math.round(p.replyMinutes)} ${L("דק'", "min")}` : `${Math.round(p.replyMinutes / 6) / 10} ${L("ש'", "h")}`}` : ""}{p.topEmojis.length ? ` · ${p.topEmojis.join(" ")}` : ""}</li>
          ))}
          {n.longestSilence && <li className="muted">{L(`השתיקה הכי ארוכה: ${n.longestSilence.days} ימים (${n.longestSilence.from})`, `Longest silence: ${n.longestSilence.days} days (${n.longestSilence.from})`)} · {L(`רצף הכי ארוך: ${n.longestStreak} ימים`, `Longest streak: ${n.longestStreak} days`)}</li>}
        </ul>
      </section>
      {rep && rep.findings.length > 0 && (
        <section className="card stack">
          <b>{L("מה ראיתי", "What I saw")}</b>
          {rep.findings.map((f, i) => <div key={i} className="cr-finding"><b dir="auto">{f.title}</b> {tag(f.measured)}<p dir="auto">{f.body}</p>{quotes(f.quotes)}</div>)}
        </section>
      )}
      {rep?.turningPoint && <section className="card stack"><b>{L("נקודת המפנה", "The turning point")} <small className="muted">{rep.turningPoint.when}</small></b><p dir="auto">{rep.turningPoint.what}</p>{quotes(rep.turningPoint.quotes)}</section>}
      {rep && rep.roles.length > 0 && <section className="card stack"><b>{L("מי מה בצ'אט", "Who is who")}</b><ul className="plain small stack tight">{rep.roles.map((x) => <li key={x.name} dir="auto"><b>{x.name}</b>: {x.role}</li>)}</ul></section>}
      {rep?.next && <section className="card stack"><b>{L("מה הלאה", "What next")}</b><p dir="auto">{rep.next}</p></section>}
      {r.followUps.map((f, i) => <section key={i} className="card stack"><b dir="auto">{f.q}</b><p dir="auto">{f.a}</p>{quotes(f.quotes)}</section>)}
      {r.status === "done" && (
        <form className="card row" onSubmit={(e) => { e.preventDefault(); if (q.trim()) void ask(); }}>
          <input className="grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L("שאל עוד משהו על הצ'אט הזה…", "Ask more about this chat…")} aria-label={L("שאלה על הצ'אט", "A question about the chat")} />
          <button type="submit" className="primary" disabled={asking || !q.trim()}>{asking ? L("חושב…", "Thinking…") : L("שאל", "Ask")}</button>
        </form>
      )}
      <p className="muted small">{L("זו פרשנות של הודעות, לא הוכחה ולא ייעוץ מקצועי. כל ציטוט נבדק מול הצ'אט.", "This is a reading of messages, not proof and not professional advice. Every quote is checked against the chat.")}</p>
    </div>
  );
}
