import { useEffect, useRef, useState } from "react";
import { unzip } from "fflate";
import { api } from "./api";
import { getLocale } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);
const NAMES = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini", openwebui: "Open WebUI", jan: "Jan" } as const;

/** Takes the chats file out of an export's zip (only that file is read). */
function chatsFileFromZip(file: File): Promise<string> {
  return file.arrayBuffer().then(
    (buf) =>
      new Promise<string>((resolve, reject) => {
        unzip(new Uint8Array(buf), { filter: (f) => /(^|\/)(conversations|MyActivity)\.json$/i.test(f.name) || /(gemini|bard)[^/]*\/[^/]+\.json$/i.test(f.name) }, (err, files) => {
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

  const pick = async (file: File) => {
    setBusy(true);
    setResult(null);
    try {
      const text = /\.zip$/i.test(file.name) ? await chatsFileFromZip(file) : await file.text();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(L("הקובץ אינו JSON. ב-Google Takeout בחר בפורמט JSON ל-My Activity.", "The file is not JSON. In Google Takeout, choose JSON as the My Activity format."));
      }
      const r = await api<{ source: keyof typeof NAMES; found: number; added: number; skipped: number }>("/api/import/chats", { method: "POST", body: { data } });
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
        <li><strong>Gemini</strong>: {L("ב-takeout.google.com בחר רק ב-My Activity, ובתוכו Gemini Apps, בפורמט JSON.", "At takeout.google.com choose only My Activity, with Gemini Apps inside it, in JSON format.")}</li>
      </ul>
      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={() => input.current?.click()}>{busy ? L("מייבא…", "Importing…") : L("בחר קובץ zip או json", "Choose the zip or json file")}</button>
        {jan > 0 && <button type="button" disabled={busy} onClick={() => void fromJan()}>{L(`ייבוא ${jan} צ'אטים מ-Jan במחשב הזה`, `Import ${jan} chats from Jan on this computer`)}</button>}
        <input ref={input} type="file" accept=".zip,.json,application/zip,application/json" hidden onChange={(e) => e.target.files?.[0] && void pick(e.target.files[0])} />
      </div>
      {result && <p className={result.ok ? "pill good" : "error"} role="status">{result.text}</p>}
    </section>
  );
}
