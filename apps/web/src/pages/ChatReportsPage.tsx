import { originalSections } from "../chat-report-text";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { ModelSuggest } from "../ModelSuggest";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { text, unzipSome, waTitle } from "../ImportPeopleChats";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

type Kind = "couple" | "ex" | "friends" | "family" | "group" | "work";
type Voice = "coach" | "friend" | "roast";
interface Quote { who: string; at: string; text: string }
interface Person { name: string; messages: number; words: number; starts: number; replyMinutes?: number; questions: number; laughs: number; love: number; night: number; topEmojis: string[] }
interface Numbers { messages: number; from: string; to: string; days: number; people: Person[]; hours: number[]; months: Array<{ month: string; messages: number }>; busiestDay?: { day: string; messages: number }; longestSilence?: { from: string; to: string; days: number }; longestStreak: number; topWords: string[] }
interface Report { mixed?: boolean; headline: string; read: string; kinder?: string; moves?: { keep: string[]; stop: string[]; say: string[] }; askMore: string[]; wouldHelp: Array<{ ask: string; kind: "text" | "export" }>; scores: Array<{ name: string; value: string; measured: boolean; of5?: number }>; findings: Array<{ title: string; body: string; measured: boolean; quotes: Quote[] }>; turningPoint?: { when: string; what: string; quotes: Quote[] }; roles: Array<{ name: string; role: string }>; next: string; story?: Array<{ title: string; body: string; quotes: Quote[] }> }
/** A chat already uploaded (kept with the report made from it). */
interface KnownChat { id: string; title: string; source: string; messages: number; from?: string; to?: string; people: number; createdAt: string }
interface Stored { id: string; title: string; kind: Kind; voice: Voice; me?: string; createdAt: string; status: "reading" | "writing" | "done" | "error"; progress?: { part: number; parts: number; total: number }; step?: { key: ImportStepKey; detail?: string }; error?: string; numbers: Numbers; report?: Report; followUps: Array<{ q: string; a: string; quotes: Quote[]; at: string }>; version?: number; origin?: "brandon"; hasChat?: boolean; imported?: string }
interface Item { id: string; title: string; kind: Kind; status: Stored["status"]; createdAt: string; messages: number }
interface Body { source: "whatsapp" | "instagram"; title: string; text?: string; parts?: unknown[] }
interface Peek { title: string; messages: number; from: string; to: string; people: Array<{ name: string; messages: number }> }

const KINDS: Array<[Kind, string, string]> = [["couple", "זוג", "Couple"], ["ex", "אקסים", "Exes"], ["friends", "חברים", "Friends"], ["family", "משפחה", "Family"], ["group", "קבוצה", "Group"], ["work", "עבודה", "Work"]];
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
        <h2>{L("אנליזת מערכות יחסים", "Relationship analysis")}</h2>
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

type ImportStepKey = "open" | "wait" | "read" | "parts" | "write";
const IMPORT_STEPS: Array<[ImportStepKey, string, string]> = [["open", "פותח את הקישור בדפדפן של KesherAI במחשב", "Opening the link in KesherAI's browser on the computer"], ["wait", "מחכה שהדף ייטען עד הסוף", "Waiting for the page to load fully"], ["read", "קורא את הטקסט של הדוח", "Reading the report's text"], ["parts", "המודל קורא את הדוח, חלק אחרי חלק", "The model reads the report, part by part"], ["write", "מסדר אותו כאן בצורת הדוח", "Laying it out here as a report"]];

/**
 * An import's steps, live (design ImportSteps): each one ticked when done, the current one with what it found (the
 * page's length, part 3 of 8), so a long import never looks stuck.
 */
function ImportProgress({ r }: { r: Stored }) {
  const keys = IMPORT_STEPS.map(([k]) => k);
  const at = r.step ? keys.indexOf(r.step.key) : r.status === "writing" ? 4 : 2;
  const fromLink = r.step?.key === "open" || r.step?.key === "wait" || at > 1;
  const detail = (k: ImportStepKey) => {
    const d = r.step?.key === k ? r.step.detail : undefined;
    if (k === "wait" && d) return L(`${Number(d).toLocaleString()} תווים עד עכשיו`, `${Number(d).toLocaleString()} characters so far`);
    if (k === "read" && d) return L(`${Number(d).toLocaleString()} תווים`, `${Number(d).toLocaleString()} characters`);
    if (k === "parts" && r.progress) return L(`חלק ${Math.min(r.progress.part, r.progress.parts)} מתוך ${r.progress.parts}`, `part ${Math.min(r.progress.part, r.progress.parts)} of ${r.progress.parts}`);
    return "";
  };
  return (
    <div className="cr-card navy stack" aria-live="polite">
      <h3>{L("מייבא את הדוח…", "Importing the report…")}</h3>
      <ol className="cr-steps">
        {IMPORT_STEPS.filter(([k]) => fromLink || (k !== "open" && k !== "wait")).map(([k, he, en]) => {
          const i = keys.indexOf(k);
          const state = i < at ? "done" : i === at ? "now" : "next";
          return <li key={k} className={state}><span aria-hidden>{state === "done" ? "✓" : state === "now" ? "⏳" : "○"}</span> <span>{L(he, en)}{detail(k) ? ` · ${detail(k)}` : ""}</span>{state === "now" && <span className="sr-only">{L(" (עכשיו)", " (now)")}</span>}</li>;
        })}
      </ol>
      <span className="muted small">{L("המודל על המחשב שלך. אפשר לצאת ולחזור; הייבוא ממשיך.", "The model on your computer. You can leave and come back; the import goes on.")}</span>
    </div>
  );
}

const STEPS = 7;
const STEP_NAMES: Array<[string, string]> = [["איזה צ'אט", "The chat"], ["האפליקציה", "The app"], ["הייצוא", "The export"], ["מי אתה", "Who you are"], ["השמות", "The names"], ["שפת הדוח", "Language"], ["רקע", "Backstory"]];
const KIND_ICONS: Record<Kind, string> = { couple: "💞", ex: "💔", friends: "🫂", family: "🏠", group: "👥", work: "💼" };

/** Brandon's setup, one question a screen (RESEARCH_LOG "Brandon's whole path"). */
function NewReport({ onMade }: { onMade: (id: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState(1);
  const [kind, setKind] = useState<Kind>("friends");
  const [app, setApp] = useState<"whatsapp" | "instagram">("whatsapp");
  const [body, setBody] = useState<Body | null>(null);
  const [peek, setPeek] = useState<Peek | null>(null);
  const [me, setMe] = useState("");
  const [names, setNames] = useState<Record<string, string>>({});
  const [lang, setLang] = useState<"he" | "en">(getLocale() === "he" ? "he" : "en");
  const [voice, setVoice] = useState<Voice>("friend");
  const [backstory, setBackstory] = useState("");
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [known, setKnown] = useState<KnownChat[]>([]);
  useEffect(() => void api<{ chats: KnownChat[] }>("/api/chat-reports/chats").then((r) => setKnown(r.chats), () => undefined), []);
  const go = (n: number) => setStep(Math.max(1, Math.min(STEPS, n)));
  /** A chat already uploaded: no new upload, the same next steps. */
  const reuse = async (c: KnownChat) => {
    setBusy(true);
    try {
      const b = { fromReport: c.id } as unknown as Body;
      const p = await api<Peek>("/api/chat-reports/peek", { method: "POST", body: b });
      setBody(b);
      setPeek(p);
      if (p.people.length > 2 && kind !== "group" && kind !== "family" && kind !== "work") setKind("group");
      go(4);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pick = async (files: File[]) => {
    setBusy(true);
    try {
      const b = await readChat(files);
      const p = await api<Peek>("/api/chat-reports/peek", { method: "POST", body: b });
      setBody(b);
      setPeek(p);
      if (p.people.length > 2 && kind !== "group" && kind !== "family" && kind !== "work") setKind("group");
      go(4);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  const make = async () => {
    if (!body) return go(3);
    setBusy(true);
    try {
      const clean = Object.fromEntries(Object.entries(names).filter(([k, v]) => v.trim() && v.trim() !== k));
      const r = await api<{ id: string }>("/api/chat-reports", { method: "POST", body: { ...body, kind, voice, lang, ...(me ? { me } : {}), ...(backstory.trim() ? { backstory } : {}), ...(Object.keys(clean).length ? { names: clean } : {}) } });
      onMade(r.id);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (importing) return <ImportBrandon onMade={onMade} onBack={() => setImporting(false)} />;
  const opt = (on: boolean, label: React.ReactNode, onClick: () => void, extra?: React.ReactNode) => <button type="button" className={`cr-opt${on ? " on" : ""}`} onClick={onClick}>{label}{extra}</button>;
  const people = peek?.people.slice(0, 12) ?? [];
  return (
    <section className="card stack cr-wizard">
      {step === 1 && <ModelSuggest tool="chat-report" />}
      <div className="row muted small"><span className="grow">{L(`${step} מתוך ${STEPS}`, `${step} of ${STEPS}`)}</span><span>{L(...STEP_NAMES[step - 1]!)}</span></div>
      <div className="cr-track" role="progressbar" aria-valuemin={1} aria-valuemax={STEPS} aria-valuenow={step}><span style={{ width: `${(step / STEPS) * 100}%` }} /></div>
      {step === 1 && (
        <>
          <h2>{L("על מה הצ'אט?", "What is the chat?")}</h2>
          {KINDS.map(([k, he, en]) => opt(kind === k, <>{KIND_ICONS[k]} {L(he, en)}</>, () => { setKind(k); go(2); }))}
          <button type="button" className="link small" onClick={() => setImporting(true)}>{L("יש לך כבר דוח מ-What Brandon Thinks? ייבא אותו", "Already have a report from What Brandon Thinks? Import it")}</button>
        </>
      )}
      {step === 2 && (
        <>
          <h2>{L("מאיזו אפליקציה?", "Which app?")}</h2>
          {opt(app === "whatsapp", "WhatsApp", () => { setApp("whatsapp"); go(3); })}
          {opt(app === "instagram", "Instagram", () => { setApp("instagram"); go(3); })}
        </>
      )}
      {step === 3 && (
        <>
          <h2>{L("הייצוא של הצ'אט", "The chat's export")}</h2>
          <p className="muted small">{app === "whatsapp"
            ? L("בצ'אט: ⋮ ← עוד ← ייצוא צ'אט ← בלי מדיה. העלה את ה-txt או ה-zip.", "In the chat: ⋮ → More → Export chat → Without media. Upload the .txt or the zip.")
            : L("הגדרות ← מרכז החשבונות ← הורדת המידע שלך ← רק הודעות, ב-JSON. העלה את קובצי message_1.json של השיחה.", "Settings → Accounts Center → Download your information → only Messages, in JSON. Upload the chat's message_1.json files.")}</p>
          <button type="button" className="cr-drop" disabled={busy} onClick={() => input.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) void pick([...e.dataTransfer.files]); }}>
            {busy ? L("פותח…", "Opening…") : peek ? <span dir="auto"><b>{peek.title}</b> · {peek.messages.toLocaleString()} {L("הודעות", "messages")}</span> : L("גרור לכאן או בחר קובץ", "Drop it here or choose a file")}
          </button>
          <input ref={input} type="file" multiple hidden accept=".txt,.zip,.json,text/plain,application/zip,application/json" onChange={(e) => e.target.files?.length && void pick([...e.target.files])} />
          <p className="muted small">{L("הקובץ נפתח על המחשב הזה. שום הודעה לא יוצאת ממנו.", "The file is opened on this computer. No message leaves it.")}</p>
          {known.length > 0 && <>
            <h3 className="small">{L("או צ'אט שכבר העלית", "Or a chat you already uploaded")}</h3>
            {known.map((c) => opt(false, <span className="grow" style={{ display: "flex", flexDirection: "column", gap: 2 }}><b dir="auto">{c.title}</b><small className="muted">{c.messages.toLocaleString()} {L("הודעות", "messages")}{c.from ? ` · ${monthName(c.from)}–${monthName(c.to ?? c.from)}` : ""}</small></span>, () => void reuse(c)))}
          </>}
        </>
      )}
      {step === 4 && (
        <>
          <h2>{L("מי מהם אתה?", "Which one is you?")}</h2>
          <p className="muted small">{L("ככה הדוח ידבר אליך.", "So the report can speak to you.")}</p>
          {people.map((p) => opt(me === p.name, <><span className="cr-initial" aria-hidden>{Array.from(p.name.replace(/[^\p{L}\p{N}]/gu, ""))[0] ?? "?"}</span><span className="grow" dir="auto">{p.name}</span></>, () => { setMe(p.name); go(5); }, <small className="muted">{p.messages.toLocaleString()}</small>))}
          {opt(me === "", L("אני לא בצ'אט", "I'm not in it"), () => { setMe(""); go(5); })}
        </>
      )}
      {step === 5 && (
        <>
          <h2>{L("איך לקרוא להם?", "What to call them?")}</h2>
          <p className="muted small">{L("החלף כינויים ואימוג'ים בשמות פשוטים, כדי שהדוח יהיה ברור.", "Swap nicknames and emojis for plain first names, so the report reads clearly.")}</p>
          {people.map((p) => <label key={p.name} className="row"><span className="cr-initial" aria-hidden>{Array.from((names[p.name] ?? p.name).replace(/[^\p{L}\p{N}]/gu, ""))[0] ?? "?"}</span><input className="grow" dir="auto" maxLength={60} value={names[p.name] ?? p.name} onChange={(e) => setNames({ ...names, [p.name]: e.target.value })} aria-label={L(`שם חדש ל-${p.name}`, `New name for ${p.name}`)} /></label>)}
        </>
      )}
      {step === 6 && (
        <>
          <h2>{L("באיזו שפה הדוח?", "The report's language?")}</h2>
          <p className="muted small">{L("יכולה להיות שונה מהשפה של הצ'אט.", "It can differ from the chat's.")}</p>
          {opt(lang === "he", "עברית", () => { setLang("he"); go(7); })}
          {opt(lang === "en", "English", () => { setLang("en"); go(7); })}
        </>
      )}
      {step === 7 && (
        <>
          <h2>{L("משהו שכדאי שאדע?", "Anything I should know?")}</h2>
          <p className="muted small">{L("קצת הקשר עושה הבדל גדול. אפשר גם לדלג.", "A little context goes a long way. You can also skip it.")}</p>
          <textarea rows={5} value={backstory} onChange={(e) => setBackstory(e.target.value)} placeholder={L("איך הכרתם, מה קרה לאחרונה, מה רצית לדעת…", "How you met, what happened lately, what you want to know…")} />
          <span className="muted small">{L("הקול של הדוח", "The report's voice")}</span>
          <div className="row wrap" role="radiogroup">{VOICES.map(([v, he, en]) => <button key={v} type="button" role="radio" aria-checked={voice === v} className={`chip${voice === v ? " on" : ""}`} onClick={() => setVoice(v)}>{L(he, en)}</button>)}</div>
          <button type="button" className="primary cr-go" disabled={busy || !body} onClick={() => void make()}>{L("כתוב את הדוח", "Write the report")}</button>
          <span className="muted small">{L("נקרא על המחשב שלך. צ'אט ארוך לוקח כמה דקות.", "Read on your computer. A long chat takes a few minutes.")}</span>
        </>
      )}
      <div className="row">
        {step > 1 && <button type="button" className="ghost" onClick={() => go(step - 1)}>{L("→ חזרה", "← Back")}</button>}
        <span className="grow" />
        {step >= 4 && step < STEPS && <button type="button" onClick={() => go(step + 1)} disabled={!body}>{L("המשך ←", "Next →")}</button>}
      </div>
    </section>
  );
}

/** A report from What Brandon Thinks: its link (read in KesherAI's own browser), a PDF of it, or its text. */
function ImportBrandon({ onMade, onBack }: { onMade: (id: string) => void; onBack: () => void }) {
  const [how, setHow] = useState<"url" | "pdf" | "text">("url");
  const [url, setUrl] = useState("");
  const [textIn, setTextIn] = useState("");
  const [busy, setBusy] = useState(false);
  const pdfInput = useRef<HTMLInputElement>(null);
  const send = async (b: Record<string, string>) => {
    setBusy(true);
    try {
      const r = await api<{ id: string }>("/api/chat-reports/import", { method: "POST", body: { ...b, lang: getLocale() === "he" ? "he" : "en" } });
      onMade(r.id);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pdf = async (f: File) => {
    const bytes = new Uint8Array(await f.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    await send({ pdf: btoa(bin) });
  };
  return (
    <section className="card stack">
      <h2>{L("ייבוא דוח מ-What Brandon Thinks", "Import a report from What Brandon Thinks")}</h2>
      <div className="row wrap" role="radiogroup">{([["url", "קישור לדוח", "The report's link"], ["pdf", "PDF", "PDF"], ["text", "הדבקת טקסט", "Paste its text"]] as const).map(([v, he, en]) => <button key={v} type="button" role="radio" aria-checked={how === v} className={`chip${how === v ? " on" : ""}`} onClick={() => setHow(v)}>{L(he, en)}</button>)}</div>
      {how === "url" && <><input dir="ltr" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.whatbrandonthinks.com/…" aria-label={L("הקישור לדוח", "The report's link")} /><p className="muted small">{L("קשר פותח את הדוח בדפדפן הפנימי שלו (עם החשבון שלך שם), קורא אותו ומסדר אותו כאן.", "KesherAI opens the report in its own browser (with your sign-in there), reads it and lays it out here.")}</p><button type="button" className="primary" disabled={busy || !/^https:\/\//.test(url)} onClick={() => void send({ url })}>{busy ? L("מייבא…", "Importing…") : L("ייבא", "Import")}</button></>}
      {how === "pdf" && <><p className="muted small">{L("בדף הדוח: הדפס ← שמור כ-PDF, ואז בחר את הקובץ.", "On the report's page: Print → Save as PDF, then choose the file.")}</p><button type="button" className="primary" disabled={busy} onClick={() => pdfInput.current?.click()}>{busy ? L("מייבא…", "Importing…") : L("בחר PDF", "Choose the PDF")}</button><input ref={pdfInput} type="file" hidden accept="application/pdf,.pdf" onChange={(e) => e.target.files?.[0] && void pdf(e.target.files[0])} /></>}
      {how === "text" && <><textarea rows={8} value={textIn} onChange={(e) => setTextIn(e.target.value)} placeholder={L("הדבק כאן את כל הטקסט של הדוח", "Paste the report's whole text here")} /><button type="button" className="primary" disabled={busy || textIn.trim().length < 200} onClick={() => void send({ text: textIn })}>{busy ? L("מייבא…", "Importing…") : L("ייבא", "Import")}</button></>}
      <p className="muted small">{L("אחר כך אפשר להוסיף את הצ'אט עצמו, כדי לבדוק ציטוטים, לשאול ולעדכן.", "Later you can add the chat itself, to check quotes, ask and update.")}</p>
      <p className="muted small">{L("לדוח שלך, לשימוש שלך. KesherAI לא קשור ל-What Brandon Thinks.", "For your own report, for your own use. KesherAI is not affiliated with What Brandon Thinks.")}</p>
      <button type="button" className="ghost" onClick={onBack}>{L("→ חזרה", "← Back")}</button>
    </section>
  );
}

const PERSON_COLORS = ["#5b7cfa", "#f06292", "#7fe0c0", "#f5d36b", "#c4b5ff", "#ffb48a"];
const initial = (name: string) => Array.from(name.replace(/[^\p{L}\p{N}]/gu, ""))[0] ?? "?";
const mins = (m: number) => (m < 60 ? `${Math.round(m)} ${L("דק'", "min")}` : `${Math.round(m / 6) / 10} ${L("ש'", "h")}`);
const dayName = (d: string) => (d ? new Date(d).toLocaleDateString(getLocale() === "he" ? "he-IL" : undefined, { day: "numeric", month: "numeric", year: "numeric" }) : "");
const monthName = (d: string) => (d ? new Date(d).toLocaleDateString(getLocale() === "he" ? "he-IL" : undefined, { month: "long", year: "numeric" }) : "");

/** Little prizes counted from the numbers (no model): the fastest replier, who opens, the night owl, who laughs most. */
function awards(n: Numbers): Array<{ icon: string; title: string; who: string }> {
  const ppl = n.people.filter((p) => p.messages >= 10);
  if (ppl.length < 2) return [];
  const top = <K extends keyof Person>(k: K, low = false) => [...ppl].filter((p) => typeof p[k] === "number").sort((a, b) => (low ? (a[k] as number) - (b[k] as number) : (b[k] as number) - (a[k] as number)))[0];
  const out: Array<{ icon: string; title: string; who: string }> = [];
  const fast = top("replyMinutes", true);
  if (fast?.replyMinutes !== undefined) out.push({ icon: "⚡", title: L("הכי מהיר בתשובות", "Fastest replier"), who: fast.name });
  const opener = top("starts");
  if (opener && opener.starts > 0) out.push({ icon: "🌅", title: L("פותח/ת השיחות", "Opens the conversations"), who: opener.name });
  const owl = top("night");
  if (owl && owl.night > 0) out.push({ icon: "🦉", title: L("ינשוף הלילה", "Night owl"), who: owl.name });
  const laugh = top("laughs");
  if (laugh && laugh.laughs > 0) out.push({ icon: "😂", title: L("הכי צוחק/ת", "Laughs the most"), who: laugh.name });
  const ask = top("questions");
  if (ask && ask.questions > 0) out.push({ icon: "❓", title: L("שואל/ת הכי הרבה", "Asks the most"), who: ask.name });
  const love = top("love");
  if (love && love.love > 0) out.push({ icon: "❤️", title: L("הכי הרבה אהבה", "Most love"), who: love.name });
  return out.slice(0, 6);
}

/** The full report (asked 2026-11-18): the original text of an imported report, or KesherAI's own long read, with a contents list. */
function FullReport({ sections, bubbles, original }: { sections: Array<{ title: string; body: string; quotes: Quote[] }>; bubbles: (q: Quote[]) => ReactNode; original: boolean }) {
  const words = sections.reduce((n, x) => n + x.body.split(/\s+/).length, 0);
  const named = sections.filter((x) => x.title);
  return (
    <div className="cr-full w6">
      <div className="cr-full-text">
        <h3>📖 {L("הדוח המלא", "The full report")}</h3>
        <p className="muted small">{original ? L("הטקסט המקורי של הדוח, כמו שנכתב ב-What Brandon Thinks", "The report's original text, as What Brandon Thinks wrote it") : L("הקריאה הארוכה של KesherAI, עם ציטוטים שנבדקו מול הצ'אט", "KesherAI's long read, with quotes checked against the chat")} · {named.length > 1 ? `${named.length} ${L("פרקים", "chapters")} · ` : ""}{L(`כ-${Math.max(1, Math.round(words / 200))} דקות קריאה`, `about ${Math.max(1, Math.round(words / 200))} minutes to read`)}</p>
        {sections.map((x, i) => (
          <section key={i} id={`cr-full-${i}`} className="cr-full-part">
            {x.title && <h4 dir="auto">{x.title}</h4>}
            {x.body.split(/\n{2,}/).map((para, j) => <p key={j} dir="auto">{para}</p>)}
            {bubbles(x.quotes)}
          </section>
        ))}
      </div>
      {named.length > 1 && (
        <nav className="cr-full-toc" aria-label={L("תוכן הדוח", "The report's contents")}>
          <b>{L("בדוח הזה", "In this report")}</b>
          {sections.map((x, i) => x.title && <button key={i} type="button" className="link" dir="auto" onClick={() => document.getElementById(`cr-full-${i}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}>{x.title}</button>)}
        </nav>
      )}
    </div>
  );
}

function ReportView({ id, onGone }: { id: string; onGone: () => void }) {
  const [r, setR] = useState<Stored | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const addInput = useRef<HTMLInputElement>(null);
  const [page, setPage] = useState(0);
  const [all, setAll] = useState(() => { try { return localStorage.getItem("kesher-report-all") === "1"; } catch { return false; } });
  const swipe = useRef(0);
  const count = useRef(1);
  // ← and → turn the pages (in Hebrew ← is the next page), unless she is typing.
  useEffect(() => {
    if (all) return;
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest?.("input, textarea, select") || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      const next = (e.key === "ArrowLeft") === (getLocale() === "he") ? 1 : -1;
      setPage((p) => Math.max(0, Math.min(count.current - 1, p + next)));
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [all]);
  const load = () => void api<Stored>(`/api/chat-reports/${id}`).then(setR, () => onGone());
  useEffect(load, [id]);
  useEffect(() => {
    if (!r || r.status === "done" || r.status === "error") return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [r?.status]);
  if (!r) return <p className="muted">{L("טוען…", "Loading…")}</p>;
  const n = r.numbers;
  const rep = r.report;
  const colorOf = (name: string) => PERSON_COLORS[Math.max(0, n.people.findIndex((p) => p.name === name)) % PERSON_COLORS.length]!;
  const total = n.people.reduce((s, p) => s + p.messages, 0) || 1;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); load(); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const ask = (question: string) => run(async () => { await api(`/api/chat-reports/${id}/ask`, { method: "POST", body: { question } }); setQ(""); });
  const tell = (text: string) => run(async () => { await api(`/api/chat-reports/${id}/add`, { method: "POST", body: { text } }); setQ(""); });
  const addExport = (files: File[]) => run(async () => { const b = await readChat(files); await api(`/api/chat-reports/${id}/add`, { method: "POST", body: { source: b.source, title: b.title, chatText: b.text, parts: b.parts } }); });
  const who = (name: string, me?: boolean) => <span className="cr-who"><span className="cr-av" style={{ background: colorOf(name) }} aria-hidden>{initial(name)}</span><span dir="auto">{name}{me ? L(" (אתה)", " (you)") : ""}</span></span>;
  const bubbles = (qs: Quote[]) => qs.length > 0 && (
    <div className="cr-bubbles">
      {qs.map((x, i) => <div key={i} className={`cr-bubble${x.who === r.me ? " mine" : ""}`} dir="auto"><small style={{ color: colorOf(x.who) }}>{x.who}{x.at ? ` · ${when(x.at)}` : ""}</small>{x.text}</div>)}
    </div>
  );
  const tag = (measured: boolean) => <span className="cr-tag">{measured ? L("נמדד", "measured") : L("נקרא", "read")}</span>;
  const max = Math.max(1, ...n.hours);
  const peak = n.hours.indexOf(max);
  const deg = (() => { let a = 0; return n.people.slice(0, 6).map((p) => { const from = a; a += (p.messages / total) * 100; return `${colorOf(p.name)} ${from}% ${a}%`; }).join(","); })();
  const starts = n.people.reduce((s, p) => s + p.starts, 0) || 1;
  const opener = [...n.people].sort((a, b) => b.starts - a.starts)[0];
  const me = n.people.find((p) => p.name === r.me);
  const other = n.people.find((p) => p.name !== r.me && p.replyMinutes !== undefined);
  const prizes = awards(n);
  const emojis = [...new Set(n.people.flatMap((p) => p.topEmojis))].slice(0, 6);
  const laughs = n.people.reduce((s, p) => s + p.laughs, 0);
  const tones = ["lav", "pink", "peach", "mint", "yel", "navy"];
  // The report in chapters, as What Brandon Thinks (asked 2026-11-18): one at a time, with the chapters on top,
  // ← → and swipe; or all on one page. A chapter with nothing in it is left out.
  type Chapter = { id: string; name: [string, string]; has: boolean; body: ReactNode };
  const all7: Chapter[] = [
    { id: "open", name: ["פתיחה", "Opening"], has: true, body: (
      <div className="cr-hero">
      {rep ? <h1 className="cr-headline" dir="auto">"{rep.headline}"</h1>
        : r.status === "error" ? <div className="stack"><p className="bad" dir="auto">{r.error}</p>{r.hasChat !== false && <button type="button" className="primary" style={{ alignSelf: "flex-start" }} onClick={() => void api(`/api/chat-reports/${id}/retry`, { method: "POST", body: {} }).then(() => window.location.reload(), (e: Error) => toast(e.message))}>{L("↻ לנסות שוב", "↻ Try again")}</button>}</div>
        : r.origin === "brandon" && !rep ? <ImportProgress r={r} />
        : <div className="cr-card navy stack"><h3>{r.status === "writing" ? L("כותב את הדוח…", "Writing the report…") : L(`קורא חלק ${r.progress?.part ?? 1} מתוך ${r.progress?.parts ?? "?"}…`, `Reading part ${r.progress?.part ?? 1} of ${r.progress?.parts ?? "?"}…`)}</h3><progress max={(r.progress?.parts ?? 1) + 1} value={r.status === "writing" ? r.progress?.parts ?? 1 : (r.progress?.part ?? 1) - 1} /><span className="muted small">{L("המודל על המחשב שלך. אפשר לצאת ולחזור; הדוח ממשיך להיכתב.", "The model on your computer. You can leave and come back; it keeps writing.")}</span></div>}
      {n.people.length > 0 && <div className="row wrap">{n.people.slice(0, 6).map((p) => <span key={p.name}>{who(p.name, p.name === r.me)}</span>)}{n.from && <span className="muted small">· {monthName(n.from)} – {monthName(n.to)}</span>}</div>}
      {rep?.read && <p className="cr-read" dir="auto">{rep.read}</p>}
      {rep?.mixed && <p className="cr-kinder">{L("המודל ערבב כאן אותיות משפות אחרות, כלומר העברית שלו חלשה. מודל צ'אט כללי (לא מודל קוד) יכתוב עברית טובה יותר: בחר אחד בעמוד ", "The model mixed in letters of other languages here: its Hebrew is weak. A general chat model (not a coding one) writes better Hebrew: choose one on the ")}<a href="#/models">{L("המודלים", "Models page")}</a>{L(" ושלח שוב מ'רוצה לדעת עוד'.", " and send again from \"Want to know more\".")}</p>}
      {rep?.kinder && <p className="cr-kinder" dir="auto">{L("ובקריאה רכה יותר: ", "Read more kindly: ")}{rep.kinder}</p>}
      </div>
    ) },
    // KesherAI's own long read, and an imported report's original text (both, when the chat was added to an import).
    { id: "full", name: ["📖 הדוח המלא", "📖 The full report"], has: !!rep?.story?.length, body: <FullReport sections={rep?.story ?? []} bubbles={bubbles} original={false} /> },
    { id: "original", name: ["📜 הדוח של Brandon", "📜 Brandon's report"], has: !!r.imported, body: <FullReport sections={originalSections(r.imported ?? "")} bubbles={bubbles} original /> },
    { id: "numbers", name: ["המספרים", "The numbers"], has: n.messages > 0 || n.people.length > 1, body: <>
      {n.people.length > 1 && (
        <div className="cr-card lav w2">
          <h3>{L("מי מדבר כמה", "Who talks how much")}</h3>
          <div className="cr-share"><div className="cr-donut" style={{ background: `conic-gradient(${deg})` }} aria-hidden />
            <ol className="cr-rank">{n.people.slice(0, 6).map((p) => <li key={p.name}>{who(p.name)}<b>{Math.round((p.messages / total) * 100)}% · {p.messages.toLocaleString()}</b></li>)}</ol></div>
        </div>
      )}
      {(opener || me?.replyMinutes !== undefined) && (
        <>
          {opener && opener.starts > 0 && <div className="cr-card pink w2"><h3>{L("מי פותח שיחות", "Who opens")}</h3><p className="cr-big">{Math.round((opener.starts / starts) * 100)}%<small dir="auto">{L(`מהשיחות נפתחות ע״י ${opener.name}`, `of conversations are opened by ${opener.name}`)}</small></p></div>}
          {(me ?? n.people[0])?.replyMinutes !== undefined && <div className="cr-card mint w2"><h3>{L("זמן תגובה", "Reply time")}</h3><p className="cr-big">{mins((me ?? n.people[0])!.replyMinutes!)}<small dir="auto">{(me ?? n.people[0])!.name}{other && other.name !== (me ?? n.people[0])!.name ? ` · ${other.name}: ${mins(other.replyMinutes!)}` : ""}</small></p></div>}
        </>
      )}
      {n.messages > 0 && (
        <div className="cr-card yel w4">
          <h3>{L("מתי מדברים", "When you talk")}</h3>
          <div className="cr-bars" aria-label={L("הודעות לפי שעה", "Messages by hour")}>{n.hours.map((h, i) => <div key={i} title={`${String(i).padStart(2, "0")}:00 · ${h}`} style={{ height: `${Math.max(2, (h / max) * 100)}%` }} />)}</div>
          <div className="cr-axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
          <p className="cr-note">{L(`השעה הכי חמה: ${String(peak).padStart(2, "0")}:00`, `The busiest hour: ${String(peak).padStart(2, "0")}:00`)}</p>
        </div>
      )}
      {(n.busiestDay || n.longestSilence || n.longestStreak > 1) && (
        <div className="cr-stack w2">
          {n.busiestDay && <div className="cr-card peach"><h3>{L("היום הכי עמוס", "The busiest day")}</h3><p className="cr-big">{n.busiestDay.messages.toLocaleString()}<small>{L("הודעות ב-", "messages on ")}{dayName(n.busiestDay.day)}</small></p></div>}
          {n.longestSilence ? <div className="cr-card navy"><h3>{L("השתיקה הכי ארוכה", "The longest silence")}</h3><p className="cr-big">{n.longestSilence.days} {L("ימים", "days")}<small>{monthName(n.longestSilence.from)}</small></p></div>
            : n.longestStreak > 1 && <div className="cr-card navy"><h3>{L("הרצף הכי ארוך", "The longest streak")}</h3><p className="cr-big">{n.longestStreak} {L("ימים", "days")}<small>{L("ברצף בלי יום שקט", "in a row without a quiet day")}</small></p></div>}
        </div>
      )}
      {(emojis.length > 0 || laughs > 0) && <div className="cr-card mint w2"><h3>{L("האמוג'ים שלכם", "Your emojis")}</h3>{emojis.length > 0 && <div className="cr-emojis">{emojis.join(" ")}</div>}{laughs > 0 && <p className="cr-note">{L(`צחקתם ${laughs.toLocaleString()} פעמים בכתב.`, `You laughed in writing ${laughs.toLocaleString()} times.`)}</p>}{n.topWords.length > 0 && <p className="muted small" dir="auto">{L("מילים שחוזרות: ", "Words that come back: ")}{n.topWords.slice(0, 8).join(" · ")}</p>}</div>}
</> },
    { id: "reads", name: ["הקריאות שלי", "My reads"], has: !!rep && (rep.scores.length > 0 || rep.roles.length > 0) || prizes.length > 0, body: <>
      {rep && rep.scores.length > 0 && (
        <div className="cr-card beige w3">
          <h3>{L("הקריאות שלי", "My reads")}</h3>
          <div className="cr-scores">{rep.scores.map((x) => (
            <div key={x.name} className="cr-score"><b dir="auto">{x.name}</b>
              {x.of5 ? <span className="cr-dots" aria-label={`${x.of5}/5`}>{[1, 2, 3, 4, 5].map((i) => <i key={i} className={i <= x.of5! ? "on" : ""} />)}</span> : <span className="cr-val" dir="auto">{x.value}</span>}
              {x.of5 && x.value ? <small className="muted" dir="auto">{x.value}</small> : null}{tag(x.measured)}
            </div>))}</div>
        </div>
      )}
      {rep && rep.roles.length > 0 && <div className="cr-card beige w2"><h3>{L("מי מה בצ'אט", "Who is who")}</h3><div className="stack">{rep.roles.map((x) => <div key={x.name}>{who(x.name)} <span dir="auto">{x.role}</span></div>)}</div></div>}
      {prizes.length > 0 && <div className="cr-card lav w3"><h3>{L("פרסים", "Awards")}</h3><div className="cr-awards">{prizes.map((a) => <div key={a.title}><span aria-hidden>{a.icon}</span> <b>{a.title}</b><br />{who(a.who)}</div>)}</div></div>}
</> },
    { id: "findings", name: ["ממצאים", "Findings"], has: !!rep?.findings.length, body: <>
      {rep?.findings.map((f, i) => (
        <div key={i} className={`cr-card w3 ${tones[(i + 1) % tones.length]}`}>
          <h3 dir="auto">{f.title} {tag(f.measured)}</h3>
          <p dir="auto">{f.body}</p>
          {bubbles(f.quotes)}
        </div>
      ))}
</> },
    { id: "turning", name: ["נקודת המפנה", "The turning point"], has: !!rep?.turningPoint, body: <>
      {rep?.turningPoint && <div className="cr-card navy w6"><h3>{L("נקודת המפנה", "The turning point")} <small className="muted">{rep.turningPoint.when}</small></h3><p dir="auto">{rep.turningPoint.what}</p>{bubbles(rep.turningPoint.quotes)}</div>}
</> },
    { id: "next", name: ["הצעד הבא", "Your next move"], has: !!rep && !!(rep.moves || rep.next), body: <>
      {rep && (rep.moves || rep.next) && (
        <div className="cr-card yel w2">
          <h3>{L("הצעד הבא", "Your next move")}</h3>
          {rep.moves ? <div className="stack">
            {rep.moves.keep.map((x, i) => <div key={`k${i}`} dir="auto">✅ <b>{L("להמשיך:", "Keep:")}</b> {x}</div>)}
            {rep.moves.stop.map((x, i) => <div key={`s${i}`} dir="auto">✋ <b>{L("להפסיק:", "Stop:")}</b> {x}</div>)}
            {rep.moves.say.map((x, i) => <div key={`t${i}`} dir="auto">💬 <b>{L("לנסות להגיד:", "Try saying:")}</b> "{x}"</div>)}
          </div> : <p dir="auto">{rep.next}</p>}
        </div>
      )}
</> },
    { id: "more", name: ["עוד", "More"], has: r.followUps.length > 0 || (!!rep && r.status === "done"), body: <>
      {r.followUps.map((f, i) => <div key={i} className="cr-card beige w6"><h3 dir="auto">{f.q}</h3><p dir="auto">{f.a}</p>{bubbles(f.quotes)}</div>)}
      {rep && r.status === "done" && (
        <div className="cr-card navy stack w6">
          <h3>{L("רוצה לדעת עוד?", "Want to know more?")}</h3>
          {rep.askMore.length > 0 && <div className="row wrap">{rep.askMore.map((x) => <button key={x} type="button" className="cr-ask" disabled={busy} onClick={() => void ask(x)} dir="auto">{x}</button>)}</div>}
          {rep.wouldHelp.length > 0 && <><p className="muted small">{L("מה יעזור לי לקרוא טוב יותר:", "What would help me read it better:")}</p><ul className="cr-help">{rep.wouldHelp.map((x) => <li key={x.ask} dir="auto">{x.ask} {x.kind === "export" && <button type="button" className="link small" onClick={() => addInput.current?.click()}>{L("+ הוסף ייצוא", "+ add an export")}</button>}</li>)}</ul></>}
          <form className="row" onSubmit={(e) => { e.preventDefault(); if (q.trim()) void (q.trim().endsWith("?") ? ask(q) : tell(q)); }}>
            <input className="grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L("שאל (עם ?) או ספר עוד…", "Ask (with ?) or tell me more…")} aria-label={L("שאלה או עוד מידע", "A question or more context")} dir="auto" />
            <button type="button" className="ghost" disabled={busy} onClick={() => addInput.current?.click()}>{L("+ עוד ייצוא", "+ Another export")}</button>
            <button type="submit" className="primary" disabled={busy || !q.trim()}>{busy ? L("רגע…", "One moment…") : L("שלח", "Send")}</button>
          </form>
          <input ref={addInput} type="file" multiple hidden accept=".txt,.zip,.json,text/plain,application/zip,application/json" onChange={(e) => e.target.files?.length && void addExport([...e.target.files])} />
          <span className="muted small">{L("שאלה מקבלת תשובה מהצ'אט. מידע חדש או עוד ייצוא מעדכנים את הדוח לגרסה הבאה.", "A question is answered from the chat. New context or another export updates the report to its next version.")}</span>
        </div>
      )}
</> },
  ];
  const chapters = all7.filter((c) => c.has);
  count.current = chapters.length;
  const at = Math.min(page, chapters.length - 1);
  const go = (i: number) => { setPage(Math.max(0, Math.min(chapters.length - 1, i))); scrollTo({ top: 0, behavior: "smooth" }); };
  const shown = all ? chapters : [chapters[at]!];
  return (
    <div className="cr-story">
      <div className="row"><span className="cr-narrator" aria-hidden>{r.voice === "roast" ? "🌶️" : r.voice === "coach" ? "🧭" : "🦉"}</span>
        <div className="grow"><b>{r.origin === "brandon" ? L("דוח מ-What Brandon Thinks", "A report from What Brandon Thinks") : L(`הקורא של קשר · ${VOICES.find((v) => v[0] === r.voice)![1]}`, `KesherAI's reader · ${VOICES.find((v) => v[0] === r.voice)![2]}`)}</b>
          <div className="muted small" dir="auto">{n.messages ? `${L("קרא", "Read")} ${n.messages.toLocaleString()} ${L("הודעות", "messages")} · ` : ""}{r.title}{(r.version ?? 1) > 1 ? ` · ${L("גרסה", "version")} ${r.version}` : ""}</div></div>
        <button type="button" className="ghost small" onClick={() => { if (confirm(L("למחוק את הדוח ואת העותק של הצ'אט?", "Delete the report and its copy of the chat?"))) void api(`/api/chat-reports/${id}`, { method: "DELETE" }).then(onGone); }}>{L("מחק", "Delete")}</button>
      </div>
      {/* A new version being written (or one that went on by itself after a restart), over the one shown. */}
      {rep && (r.status === "reading" || r.status === "writing") && (
        <div className="card row cr-next" role="status"><span aria-hidden>⏳</span><span className="small grow">{r.status === "writing" ? L("כותב את הגרסה הבאה… (ממשיך גם אחרי הפעלה מחדש)", "Writing the next version… (it goes on after a restart too)") : L(`קורא חלק ${r.progress?.part ?? 1} מתוך ${r.progress?.parts ?? "?"} לגרסה הבאה… (ממשיך גם אחרי הפעלה מחדש)`, `Reading part ${r.progress?.part ?? 1} of ${r.progress?.parts ?? "?"} for the next version… (it goes on after a restart too)`)}</span></div>
      )}
      {!all && chapters.length > 1 && (
        <nav className="cr-chapters" aria-label={L("פרקי הדוח", "The report's chapters")}>
          <div className="cr-segs" aria-hidden>{chapters.map((c, i) => <span key={c.id} className={i < at ? "done" : i === at ? "on" : ""} />)}</div>
          <div className="cr-chapter-names">{chapters.map((c, i) => <button key={c.id} type="button" className={i === at ? "on" : ""} aria-current={i === at ? "step" : undefined} onClick={() => go(i)}>{L(...c.name)}</button>)}</div>
        </nav>
      )}
      <div className="cr-pages" onTouchStart={(e) => { swipe.current = e.touches[0]!.clientX; }} onTouchEnd={(e) => {
        const dx = e.changedTouches[0]!.clientX - swipe.current;
        // A swipe of 60px turns the page; in Hebrew the next page is to the left, as in a book.
        if (!all && Math.abs(dx) > 60) go(at + ((dx < 0) === (getLocale() === "he") ? 1 : -1));
      }}>
      {shown.map((c) => c.id === "open" ? <Fragment key={c.id}>{c.body}</Fragment> : <div key={c.id} className="cr-grid">{all && <h2 className="cr-chapter-title w6">{L(...c.name)}</h2>}{c.body}</div>)}
      </div>
      {chapters.length > 1 && (
        <div className="row cr-turn">
          {!all && <button type="button" disabled={at === 0} onClick={() => go(at - 1)}>{getLocale() === "he" ? "→" : "←"} <span className="cr-turn-name">{at > 0 ? L(...chapters[at - 1]!.name) : ""}</span></button>}
          <span className="grow" />
          <button type="button" className="link small" onClick={() => { setAll(!all); try { localStorage.setItem("kesher-report-all", all ? "0" : "1"); } catch { /* this visit */ } }}>{all ? L("בפרקים", "In chapters") : L("הכל בעמוד אחד", "All on one page")}</button>
          <span className="grow" />
          {!all && <button type="button" className="primary" disabled={at === chapters.length - 1} onClick={() => go(at + 1)}>{at < chapters.length - 1 ? L(...chapters[at + 1]!.name) : L("סוף", "The end")} {getLocale() === "he" ? "←" : "→"}</button>}
        </div>
      )}
      <p className="muted small cr-foot">{L("פרשנות של הודעות, לא הוכחה ולא ייעוץ מקצועי. כל ציטוט נבדק מול הצ'אט.", "A reading of messages, not proof and not professional advice. Every quote is checked against the chat.")}</p>
    </div>
  );
}
