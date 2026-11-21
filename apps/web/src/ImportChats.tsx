import { useEffect, useMemo, useRef, useState } from "react";
import { api, isRemote, withToken } from "./api";
import { refreshLibrary } from "./library";
import { getLocale, he$ } from "./i18n";
import { Select } from "./ui/Select";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
const NAMES = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini", openwebui: "Open WebUI", lmstudio: "LM Studio", jan: "Jan" } as const;

interface ClaudeSession { file: string; sessionId: string; title: string; cwd?: string; updatedAt: string; size: number }

/**
 * Claude Code's sessions on this computer: one click continues one in a code chat on the local model, in the
 * same folder (for when Claude's usage is used up). Only on the computer itself: session files can hold
 * secrets from commands.
 */
function ClaudeCodeSessions() {
  const [list, setList] = useState<ClaudeSession[] | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    if (isRemote()) return;
    void api<{ sessions: ClaudeSession[] }>("/api/import/claude-code").then((r) => setList(r.sessions), () => setList([]));
  }, []);
  if (!list?.length) return null;
  const go = async (x: ClaudeSession) => {
    setBusy(x.file);
    setErr("");
    try {
      const r = await api<{ id?: string }>("/api/import/claude-code", { method: "POST", body: { file: x.file } });
      if (r.id) location.hash = `#/c/${r.id}`;
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="stack cc-sessions">
      <h3>{L("להמשיך סשן של Claude Code", "Continue a Claude Code session")}</h3>
      <p className="muted small">{L("כשה־usage של Claude נגמר: הסשן נפתח כשיחת קוד באותה תיקייה, על המודל המקומי. המילים נשמרות, וכל צעד של כלי הופך לשורה קצרה. פלט הפקודות לא מועתק.", "When Claude's usage runs out: the session opens as a code chat in the same folder, on the local model. The words are kept and each tool step becomes a short line; command output is not copied.")}</p>
      <ul className="cc-list">
        {list.slice(0, 8).map((x) => (
          <li key={x.file} className="row wrap">
            <span className="grow" dir="auto"><strong>{x.title}</strong><br /><span className="muted small" dir="ltr">{x.cwd ?? ""}</span> <span className="muted small">· {new Date(x.updatedAt).toLocaleString(getLocale() === "he" ? "he-IL" : undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span></span>
            <button type="button" disabled={!!busy} onClick={() => void go(x)}>{busy === x.file ? "…" : L("המשך בקשר", "Continue here")}</button>
          </li>
        ))}
      </ul>
      {err && <p className="error small">{err}</p>}
    </div>
  );
}

/** What the computer found in an uploaded export (import-session.ts `ImportPreview`). */
interface ImportPreview {
  token: string;
  fileName: string;
  source: keyof typeof NAMES;
  chats: Array<{ key: string; title: string; createdAt: string; updatedAt: string; messages: number; branches: number; files: number; have: boolean }>;
  personas: Array<{ name: string; instructions: string; have: boolean }>;
  from?: string;
  to?: string;
  broken: number;
  geminiSplit: "day" | "gap" | "one";
}

/**
 * Sends an export file to the computer as it is, with the progress (XHR: fetch has no upload progress).
 *
 * @param file - The file the user chose.
 * @param onProgress - Percent sent.
 * @returns The preview.
 */
function uploadExport(file: File, onProgress: (pct: number) => void): Promise<ImportPreview> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", withToken("/api/import/upload"));
    x.setRequestHeader("content-type", "application/x-kesher-import");
    x.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    x.onload = () => {
      let j: ImportPreview & { error?: string };
      try {
        j = JSON.parse(x.responseText) as ImportPreview & { error?: string };
      } catch {
        return reject(new Error(String(x.status)));
      }
      if (x.status >= 400 || j.error) reject(new Error(j.error ?? String(x.status)));
      else resolve(j);
    };
    x.onerror = () => reject(new Error(L("השליחה למחשב נכשלה. בדקו את החיבור ונסו שוב.", "Sending to the computer failed. Check the connection and try again.")));
    x.send(file);
  });
}

const day = (iso: string) => new Date(iso).toLocaleDateString(getLocale() === "he" ? "he-IL" : undefined, { day: "numeric", month: "short", year: "numeric" });
/** Rows drawn at first (a big export has thousands): "Show more" adds more. */
const PAGE = 150;

/**
 * The preview of an export: counts, dates, the chats to pick (new ones picked), the personas found, and Import.
 *
 * @param props.preview - What the computer found.
 * @param props.onPreview - A new preview (Gemini grouped another way).
 * @param props.onDone - After the import, with its counts.
 * @param props.onCancel - After the upload is dropped.
 */
function ImportPreviewPanel({ preview, onPreview, onDone, onCancel }: { preview: ImportPreview; onPreview: (p: ImportPreview) => void; onDone: (r: { source: keyof typeof NAMES; added: number; skipped: number; personas: number }) => void; onCancel: () => void }) {
  const [picked, setPicked] = useState(() => new Set(preview.chats.filter((c) => !c.have).map((c) => c.key)));
  const [personas, setPersonas] = useState(() => new Set(preview.personas.map((p, i) => (p.have ? -1 : i)).filter((i) => i >= 0)));
  const [filter, setFilter] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    setPicked(new Set(preview.chats.filter((c) => !c.have).map((c) => c.key)));
  }, [preview]);
  const list = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? preview.chats.filter((c) => c.title.toLowerCase().includes(q)) : preview.chats;
  }, [preview, filter]);
  const totals = useMemo(() => preview.chats.reduce((t, c) => ({ branches: t.branches + c.branches, files: t.files + c.files, have: t.have + Number(c.have) }), { branches: 0, files: 0, have: 0 }), [preview]);
  const from = NAMES[preview.source] ?? preview.source;
  const toggle = (key: string) => setPicked((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const setAll = (keys: string[], on: boolean) => setPicked((s) => { const n = new Set(s); for (const k of keys) if (on) n.add(k); else n.delete(k); return n; });
  const regroup = async (geminiSplit: string) => {
    setBusy(true);
    try {
      const r = await api<{ preview: ImportPreview }>("/api/import/preview", { method: "POST", body: { token: preview.token, geminiSplit } });
      onPreview(r.preview);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const go = async () => {
    setBusy(true);
    setErr("");
    try {
      const all = picked.size === preview.chats.length;
      onDone(await api("/api/import/commit", { method: "POST", body: { token: preview.token, ...(all ? {} : { keys: [...picked] }), personas: [...personas] } }));
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  const cancel = async () => {
    await api(`/api/import/upload?token=${encodeURIComponent(preview.token)}`, { method: "DELETE" }).catch(() => undefined);
    onCancel();
  };
  return (
    <div className="import-preview stack" role="region" aria-label={L("תצוגה מקדימה של הייבוא", "Import preview")}>
      <h3 dir="auto">{L(`מה יש בקובץ מ-${from}`, `What the ${from} file holds`)}</h3>
      <p className="import-sum">
        <span className="pill">{L(`${preview.chats.length} צ'אטים`, `${preview.chats.length} chats`)}</span>
        {totals.branches > 0 && <span className="pill">⑂ {L(`${totals.branches} ענפים`, `${totals.branches} branches`)}</span>}
        {totals.files > 0 && <span className="pill">📎 {L(`${totals.files} קבצים ותמונות`, `${totals.files} files and pictures`)}</span>}
        {preview.from && preview.to && <span className="pill">{day(preview.from)} – {day(preview.to)}</span>}
        {totals.have > 0 && <span className="pill">{L(`${totals.have} כבר כאן`, `${totals.have} here already`)}</span>}
      </p>
      <p className="muted small" dir="auto"><bdi>{preview.fileName}</bdi>{preview.broken > 0 && L(` · ${preview.broken} פריטים לא נקראו (הקובץ אולי חתוך)`, ` · ${preview.broken} items could not be read (the file may be cut off)`)}</p>
      {preview.source === "gemini" && (
        <label className="row wrap" style={{ gap: 8 }}>
          <span>{L("צ'אטים בלי מזהה: איך לחלק", "Prompts with no chat id: how to group")}</span>
          <Select value={preview.geminiSplit} disabled={busy} onChange={(e) => void regroup(e.target.value)}>
            <option value="day">{L("שיחה לכל יום", "One chat per day")}</option>
            <option value="one">{L("הכול בשיחה אחת", "Everything in one chat")}</option>
            <option value="gap">{L("שיחה חדשה אחרי חצי שעה של שקט", "A new chat after 30 quiet minutes")}</option>
          </Select>
        </label>
      )}
      <div className="row wrap import-tools">
        <input type="search" className="import-filter grow" value={filter} onChange={(e) => { setFilter(e.target.value); setShown(PAGE); }} placeholder={L("חיפוש לפי שם", "Search by name")} aria-label={L("חיפוש לפי שם", "Search by name")} dir="auto" />
        <button type="button" className="small" onClick={() => setAll(list.map((c) => c.key), true)}>{L("בחר הכול", "Select all")}</button>
        <button type="button" className="small" onClick={() => setAll(list.map((c) => c.key), false)}>{L("נקה", "None")}</button>
      </div>
      <ul className="import-list">
        {list.slice(0, shown).map((c) => (
          <li key={c.key}>
            <label className="row">
              <input type="checkbox" checked={picked.has(c.key)} onChange={() => toggle(c.key)} />
              <span className="grow">
                <span className="import-title" dir="auto">{c.title}</span>
                <span className="muted small">
                  {day(c.updatedAt)} · {L(`${c.messages} הודעות`, `${c.messages} messages`)}
                  {c.branches > 0 && ` · ⑂ ${c.branches}`}
                  {c.files > 0 && ` · 📎 ${c.files}`}
                  {c.have && ` · ${L("כבר כאן", "here already")}`}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {list.length > shown && <button type="button" className="small" onClick={() => setShown(shown + PAGE)}>{L(`הצג עוד (${list.length - shown})`, `Show more (${list.length - shown})`)}</button>}
      {preview.personas.length > 0 && (
        <div className="stack">
          <h4>{L("הוראות שנמצאו: להוסיף כפרסונות", "Instructions found: add as personas")}</h4>
          <ul className="import-list">
            {preview.personas.map((p, i) => (
              <li key={i}>
                <label className="row">
                  <input type="checkbox" disabled={p.have} checked={personas.has(i)} onChange={() => setPersonas((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; })} />
                  <span className="grow">
                    <span className="import-title" dir="auto">{p.name}</span>
                    <span className="muted small" dir="auto">{p.have ? L("כבר כאן · ", "here already · ") : ""}{p.instructions.slice(0, 140)}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
      {err && <p className="error small">{err}</p>}
      <div className="row wrap">
        <button type="button" className="primary" disabled={busy || (!picked.size && !personas.size)} onClick={() => void go()}>
          {busy ? L("מייבא…", "Importing…") : L(`ייבוא ${picked.size} צ'אטים`, `Import ${picked.size} chats`)}
        </button>
        <button type="button" disabled={busy} onClick={() => void cancel()}>{L("ביטול", "Cancel")}</button>
      </div>
    </div>
  );
}

/** Settings → Import chats: brings chat history from ChatGPT, Claude or Gemini into KesherAI. */
export function ImportChats() {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  // Jan keeps its chats as files on this computer: offered in one click when there are some (computer only).
  const [jan, setJan] = useState(0);
  useEffect(() => {
    void api<{ found: number }>("/api/import/jan").then((r) => setJan(r.found), () => setJan(0));
  }, []);
  const fromJan = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api<{ added: number; skipped: number }>("/api/import/jan", { method: "POST", body: {} });
      setResult({ ok: true, text: L(`נוספו ${r.added} צ'אטים מ-Jan.`, `Added ${r.added} chats from Jan.`) + (r.skipped ? L(` ${r.skipped} כבר היו כאן.`, ` ${r.skipped} were here already.`) : "") });
      setJan(0);
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const [counts, setCounts] = useState<Record<string, number>>({});
  const loadCounts = () => void api<{ counts: Record<string, number> }>("/api/import/chats/counts").then((r) => setCounts(r.counts), () => undefined);
  useEffect(loadCounts, []);
  const removeImported = async (source: keyof typeof NAMES) => {
    if (!confirm(L(`למחוק את כל ${counts[source]} הצ'אטים שיובאו מ-${NAMES[source]}? אי אפשר לבטל את זה. הקובץ המקורי שלכם לא נמחק.`, `Delete all ${counts[source]} chats imported from ${NAMES[source]}? This cannot be undone. Your original file is not deleted.`))) return;
    setBusy(true);
    try {
      const r = await api<{ removed: number }>(`/api/import/chats?source=${source}`, { method: "DELETE" });
      setResult({ ok: true, text: L(`נמחקו ${r.removed} צ'אטים שיובאו מ-${NAMES[source]}.`, `Deleted ${r.removed} chats imported from ${NAMES[source]}.`) });
      loadCounts();
      void refreshLibrary();
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  // The preview of the file sent (or the one left open when the page was closed, e.g. the phone switched apps).
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [sent, setSent] = useState<number | null>(null);
  useEffect(() => {
    void api<{ preview: ImportPreview | null }>("/api/import/preview", { method: "POST", body: {} }).then((r) => r.preview && setPreview(r.preview), () => undefined);
  }, []);
  const pick = async (file: File) => {
    setBusy(true);
    setResult(null);
    setSent(0);
    try {
      // The file goes to the computer as it is (a zip of any size, from the phone too) and is read there in a stream.
      setPreview(await uploadExport(file, setSent));
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
      setSent(null);
      if (input.current) input.current.value = "";
    }
  };
  const done = (r: { source: keyof typeof NAMES; added: number; skipped: number; personas: number }) => {
    const from = NAMES[r.source] ?? r.source;
    setPreview(null);
    setResult({
      ok: true,
      text:
        L(`נוספו ${r.added} צ'אטים מ-${from}.`, `Added ${r.added} chats from ${from}.`) +
        (r.skipped ? L(` ${r.skipped} כבר היו כאן.`, ` ${r.skipped} were here already.`) : "") +
        (r.personas ? L(` נוספו ${r.personas} פרסונות.`, ` Added ${r.personas} personas.`) : "") +
        (r.added ? L(" הם ברשימת הצ'אטים, מסומנים \"יובא מ-\", ואפשר לחפש בהם ולהמשיך כל אחד עם מודל מקומי.", " They are in your chat list, marked \"Imported from\"; you can search them and continue any of them with a local model.") : ""),
    });
    loadCounts();
    void refreshLibrary();
  };

  return (
    <section className="card stack">
      <h2>{L("ייבוא צ'אטים", "Import chats")}</h2>
      <p className="muted">{L("הבא את היסטוריית הצ'אטים שלך מ-ChatGPT, Claude, Gemini, Open WebUI או LM Studio: ענפים, תמונות, קבצים וקוד נשמרים, והוראות אישיות הופכות לפרסונות. לפני הייבוא רואים מה יש בקובץ ובוחרים. הכול נשאר במחשב הזה, גם כששולחים מהטלפון.", "Bring your chat history from ChatGPT, Claude, Gemini, Open WebUI or LM Studio: branches, pictures, files and code are kept, and custom instructions become personas. You see what the file holds and pick before importing. Everything stays on this computer, also when sent from the phone.")}</p>
      <ul className="muted small">
        <li><strong>ChatGPT</strong>: {L("הגדרות ← בקרת נתונים ← ייצוא נתונים. מגיע מייל עם קובץ zip.", "Settings → Data controls → Export data. You get an email with a zip.")}</li>
        <li><strong>Claude</strong>: {L("הגדרות ← פרטיות ← ייצוא נתונים. מגיע מייל עם קובץ zip.", "Settings → Privacy → Export data. You get an email with a zip.")}</li>
        <li><strong>Open WebUI</strong>: {L("הגדרות ← בקרת נתונים ← ייצוא צ'אטים (קובץ json).", "Settings → Data Controls → Export Chats (a json file).")}</li>
        <li><strong>LM Studio</strong>: {L("קובץ ‎.conversation.json מתיקיית conversations של LM Studio.", "A .conversation.json file from LM Studio's conversations folder.")}</li>
        <li><strong>Gemini</strong>: {L("ב-takeout.google.com בחר רק ב-My Activity, ובתוכו Gemini Apps. אפשר להעלות את קובץ ה-zip שמתקבל, או את MyActivity.html (ברירת המחדל של Google) או MyActivity.json מתוכו.", "At takeout.google.com choose only My Activity, with Gemini Apps inside it. Upload the zip you get, or the MyActivity.html (Google's default) or MyActivity.json inside it.")}</li>
      </ul>
      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={() => input.current?.click()}>{sent !== null ? L(`שולח למחשב… ${sent}%`, `Sending to the computer… ${sent}%`) : busy ? L("קורא…", "Reading…") : L("בחר קובץ zip, json או html", "Choose the zip, json or html file")}</button>
        {jan > 0 && <button type="button" disabled={busy} onClick={() => void fromJan()}>{L(`ייבוא ${jan} צ'אטים מ-Jan במחשב הזה`, `Import ${jan} chats from Jan on this computer`)}</button>}
        <input ref={input} type="file" accept=".zip,.json,.html,.htm,application/zip,application/json,text/html" hidden disabled={!!preview} onChange={(e) => e.target.files?.[0] && void pick(e.target.files[0])} />
      </div>
      {(Object.keys(counts) as Array<keyof typeof NAMES>).filter((k) => counts[k]! > 0 && k in NAMES && !isRemote()).length > 0 && (
        <div className="row wrap">
          {(Object.keys(counts) as Array<keyof typeof NAMES>).filter((k) => counts[k]! > 0 && k in NAMES).map((k) => (
            <button key={k} type="button" className="danger small" disabled={busy} onClick={() => void removeImported(k)}>{L(`מחק ${counts[k]} צ'אטים שיובאו מ-${NAMES[k]}`, `Delete ${counts[k]} chats imported from ${NAMES[k]}`)}</button>
          ))}
        </div>
      )}
      {preview && <ImportPreviewPanel preview={preview} onPreview={setPreview} onDone={done} onCancel={() => setPreview(null)} />}
      {result && <p className={result.ok ? "pill good" : "error"} role="status">{result.text}</p>}
      <ClaudeCodeSessions />
    </section>
  );
}
