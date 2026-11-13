import { useEffect, useRef, useState } from "react";
import { unzip } from "fflate";
import { api, isRemote } from "./api";
import { getLocale } from "./i18n";
import { Select } from "./ui/Select";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);
const NAMES = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini", openwebui: "Open WebUI", jan: "Jan" } as const;

/** Takes the chats file out of an export's zip (only that file is read). */
function chatsFileFromZip(file: File): Promise<string> {
  return file.arrayBuffer().then(
    (buf) =>
      new Promise<string>((resolve, reject) => {
        unzip(new Uint8Array(buf), { filter: (f) => /(^|\/)(conversations|MyActivity)\.json$/i.test(f.name) || /(gemini|bard)[^/]*\/[^/]+\.(json|html)$/i.test(f.name) }, (err, files) => {
          if (err) return reject(err);
          // Prefer conversations.json (ChatGPT, Claude); in a Takeout zip the Gemini folder's MyActivity.json.
          const names = Object.keys(files).sort((a, b) => Number(/conversations/i.test(b)) - Number(/conversations/i.test(a)) || Number(/gemini|bard/i.test(b)) - Number(/gemini|bard/i.test(a)));
          const first = names[0];
          if (!first) return reject(new Error(L("לא מצאתי בקובץ ה-zip את conversations.json או MyActivity.json.", "The zip has no conversations.json or MyActivity.json.")));
          resolve(new TextDecoder().decode(files[first]));
        });
      }),
  );
}

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

  // Gemini's export has no chat ids: how its prompts are grouped into chats is the user's choice.
  const [split, setSplit] = useState<"day" | "gap" | "one">("day");
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
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const pick = async (file: File) => {
    setBusy(true);
    setResult(null);
    try {
      const text = /\.zip$/i.test(file.name) ? await chatsFileFromZip(file) : await file.text();
      // Google Takeout gives My Activity as HTML unless JSON is chosen: both are read.
      const isHtml = /^\s*<(!doctype|html)/i.test(text) || /class="outer-cell/.test(text.slice(0, 200_000));
      let data: unknown;
      if (!isHtml) {
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error(L("הקובץ אינו קובץ ייצוא מוכר (JSON או MyActivity.html של Google).", "The file is not a known export (JSON, or Google's MyActivity.html)."));
        }
      }
      const r = await api<{ source: keyof typeof NAMES; found: number; added: number; skipped: number }>("/api/import/chats", { method: "POST", body: { ...(isHtml ? { html: text } : { data }), geminiSplit: split } });
      const from = NAMES[r.source];
      setResult({
        ok: true,
        text:
          L(`נוספו ${r.added} צ'אטים מ-${from}.`, `Added ${r.added} chats from ${from}.`) +
          (r.skipped ? L(` ${r.skipped} כבר היו כאן.`, ` ${r.skipped} were here already.`) : "") +
          (r.added ? L(" הם ברשימת הצ'אטים, ואפשר להמשיך כל אחד מהם עם מודל מקומי.", " They are in your chat list; you can continue any of them with a local model.") : ""),
      });
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
      loadCounts();
    }
  };

  return (
    <section className="card stack">
      <h2>{L("ייבוא צ'אטים", "Import chats")}</h2>
      <p className="muted">{L("הבא את היסטוריית הצ'אטים שלך מ-ChatGPT, Claude, Gemini או Open WebUI. הם נשמרים כאן במחשב, ואפשר לחפש בהם ולהמשיך אותם.", "Bring your chat history from ChatGPT, Claude, Gemini or Open WebUI. The chats are kept on this computer, and you can search and continue them.")}</p>
      <ul className="muted small">
        <li><strong>ChatGPT</strong>: {L("הגדרות ← בקרת נתונים ← ייצוא נתונים. מגיע מייל עם קובץ zip.", "Settings → Data controls → Export data. You get an email with a zip.")}</li>
        <li><strong>Claude</strong>: {L("הגדרות ← פרטיות ← ייצוא נתונים. מגיע מייל עם קובץ zip.", "Settings → Privacy → Export data. You get an email with a zip.")}</li>
        <li><strong>Open WebUI</strong>: {L("הגדרות ← בקרת נתונים ← ייצוא צ'אטים (קובץ json).", "Settings → Data Controls → Export Chats (a json file).")}</li>
        <li><strong>Gemini</strong>: {L("ב-takeout.google.com בחר רק ב-My Activity, ובתוכו Gemini Apps. אפשר להעלות את קובץ ה-zip שמתקבל, או את MyActivity.html (ברירת המחדל של Google) או MyActivity.json מתוכו.", "At takeout.google.com choose only My Activity, with Gemini Apps inside it. Upload the zip you get, or the MyActivity.html (Google's default) or MyActivity.json inside it.")}</li>
      </ul>
      <label className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <span>{L("Gemini: איך לחלק לשיחות", "Gemini: how to group into chats")}</span>
        <Select value={split} onChange={(e) => setSplit(e.target.value as typeof split)}>
          <option value="day">{L("שיחה לכל יום", "One chat per day")}</option>
          <option value="one">{L("הכול בשיחה אחת", "Everything in one chat")}</option>
          <option value="gap">{L("שיחה חדשה אחרי חצי שעה של שקט (הרבה שיחות קטנות)", "A new chat after 30 quiet minutes (many small chats)")}</option>
        </Select>
      </label>
      <p className="muted small">{L("בייצוא של Google אין סימון של שיחות, רק שאלות עם זמנים, ולכן החלוקה היא ניחוש.", "Google's export has no chat ids, only prompts with times, so the grouping is a guess.")}</p>
      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={() => input.current?.click()}>{busy ? L("מייבא…", "Importing…") : L("בחר קובץ zip או json", "Choose the zip or json file")}</button>
        {jan > 0 && <button type="button" disabled={busy} onClick={() => void fromJan()}>{L(`ייבוא ${jan} צ'אטים מ-Jan במחשב הזה`, `Import ${jan} chats from Jan on this computer`)}</button>}
        <input ref={input} type="file" accept=".zip,.json,.html,.htm,application/zip,application/json,text/html" hidden onChange={(e) => e.target.files?.[0] && void pick(e.target.files[0])} />
      </div>
      {(Object.keys(counts) as Array<keyof typeof NAMES>).filter((k) => counts[k]! > 0 && k in NAMES && !isRemote()).length > 0 && (
        <div className="row wrap">
          {(Object.keys(counts) as Array<keyof typeof NAMES>).filter((k) => counts[k]! > 0 && k in NAMES).map((k) => (
            <button key={k} type="button" className="danger small" disabled={busy} onClick={() => void removeImported(k)}>{L(`מחק ${counts[k]} צ'אטים שיובאו מ-${NAMES[k]}`, `Delete ${counts[k]} chats imported from ${NAMES[k]}`)}</button>
          ))}
        </div>
      )}
      {result && <p className={result.ok ? "pill good" : "error"} role="status">{result.text}</p>}
      <ClaudeCodeSessions />
    </section>
  );
}
