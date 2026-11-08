import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Status { enabled: boolean; configured: boolean; running: boolean; bot?: string; chats: number; pairCode: string; error?: string }

/**
 * Settings → Phone → Telegram: talk to KesherAI from Telegram through a bot
 * of your own. The token and pairing are set on this computer only.
 */
export function TelegramSection() {
  const [s, setS] = useState<Status | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => void api<Status>("/api/telegram").then(setS, () => undefined);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
      setToken("");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
      load();
    }
  };
  if (!s) return null;
  const local = !!s.pairCode;

  return (
    <section className="card stack telegram">
      <div className="row">
        <h2 className="grow">{L("טלגרם", "Telegram")}</h2>
        {s.configured && (
          <label className="row small">
            <input type="checkbox" checked={s.enabled} disabled={busy || !local} onChange={(e) => void run(() => api("/api/telegram", { method: "PUT", body: { enabled: e.target.checked } }))} /> {L("פעיל", "On")}
          </label>
        )}
      </div>
      <p className="muted">{L("לכתוב ל-KesherAI מטלגרם, מכל מקום, דרך בוט פרטי שלך. המודלים נשארים במחשב, ואישורים מגיעים ככפתורים בצ'אט. רק צ'אט שחובר עם הקוד מכאן מקבל תשובה.", "Write to KesherAI from Telegram, from anywhere, through a bot of your own. The models stay on this computer, and approvals come as buttons in the chat. Only a chat paired with the code shown here gets answers.")}</p>

      {!s.configured && !local ? (
        <p>{L("מגדירים את זה במחשב שמריץ את KesherAI: הגדרות ← טלפון ← טלגרם.", "Set it up on the computer that runs KesherAI: Settings → Phone → Telegram.")}</p>
      ) : !s.configured ? (
        <>
          <ol className="tg-steps">
            <li>{L("בטלגרם, פתח את ", "In Telegram, open ")}<bdi><b dir="ltr">@BotFather</b></bdi>{L(" ושלח ", " and send ")}<bdi><code dir="ltr">/newbot</code></bdi>.</li>
            <li>{L("בחר שם ושם משתמש לבוט (נגמר ב-bot).", "Pick a name and a username for the bot (ending in bot).")}</li>
            <li>{L("העתק את הטוקן שהוא נותן והדבק כאן:", "Copy the token it gives and paste it here:")}</li>
          </ol>
          <div className="row">
            <input className="grow" type="password" autoComplete="off" dir="ltr" value={token} onChange={(e) => setToken(e.target.value)} placeholder="123456789:AA…" aria-label={L("טוקן של הבוט", "Bot token")} />
            <button type="button" className="primary" disabled={busy || !token.trim()} onClick={() => void run(() => api("/api/telegram", { method: "PUT", body: { token } }))}>{L("חבר", "Connect")}</button>
          </div>
          <small className="muted">{L("הטוקן נשמר רק במחשב הזה. בוט בטלגרם הוא בחינם.", "The token stays on this computer only. A Telegram bot is free.")}</small>
        </>
      ) : (
        <>
          <div className="row wrap">
            <span className={`dot ${s.running && !s.error ? "on" : "off"}`} aria-hidden="true" />
            <span>{s.bot ? <b dir="ltr">@{s.bot}</b> : L("הבוט", "The bot")}</span>
            <span className="muted">· {s.running ? (s.error ? L(`לא מצליח להגיע לטלגרם: ${s.error}`, `Cannot reach Telegram: ${s.error}`) : L("מחובר", "Running")) : L("כבוי", "Off")}</span>
            <span className="muted">· {L(`צ'אטים מחוברים: ${s.chats}`, `Paired chats: ${s.chats}`)}</span>
          </div>
          {local && (
            <div className="tg-pair">
              <span>{L("כדי לחבר את הטלגרם שלך, שלח לבוט:", "To pair your Telegram, send the bot:")}</span>
              <code dir="ltr" className="tg-code">/start {s.pairCode}</code>
              {s.bot && <a href={`https://t.me/${s.bot}?start=${s.pairCode}`} target="_blank" rel="noopener noreferrer">{L("או פתח את הבוט בטלגרם", "or open the bot in Telegram")}</a>}
              <small className="muted">{L("הקוד מתחלף אחרי כל חיבור. בצ'אט: /new מתחיל שיחה חדשה.", "The code changes after each pairing. In the chat, /new starts a fresh conversation.")}</small>
            </div>
          )}
          {local && (
            <div className="row wrap">
              <button type="button" disabled={busy || !s.chats} onClick={() => void run(() => api("/api/telegram/unpair", { method: "POST" }))}>{L("נתק את כל הצ'אטים", "Unpair all chats")}</button>
              <button type="button" className="danger" disabled={busy} onClick={() => confirm(L("לשכוח את הבוט ואת הצ'אטים?", "Forget the bot and the chats?")) && void run(() => api("/api/telegram", { method: "DELETE" }))}>{L("הסר את הבוט", "Remove the bot")}</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
