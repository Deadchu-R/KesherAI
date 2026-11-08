import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Status {
  enabled: boolean;
  configured: boolean;
  running: boolean;
  allowed: boolean;
  local: boolean;
  bot?: string;
  chats: Array<{ id: number; name: string; pairedAt?: string }>;
  pairing?: { code: string; expiresAt: string };
  approveCommands: boolean;
  log: Array<{ at: string; what: string }>;
  error?: string;
}

const when = (iso: string) => new Date(iso).toLocaleString(getLocale() === "he" ? "he-IL" : undefined, { dateStyle: "short", timeStyle: "short" });

/**
 * Settings → Phone → Telegram: talk to KesherAI from Telegram through a bot
 * of your own. Safety first: pairing only on purpose, warnings, a lock,
 * and every setting on this computer only.
 */
export function TelegramSection() {
  const [s, setS] = useState<Status | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const load = () => void api<Status>("/api/telegram").then(setS, () => undefined);
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
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
  const put = (body: Record<string, unknown>) => run(() => api("/api/telegram", { method: "PUT", body }));
  const minutesLeft = s.pairing ? Math.max(0, Math.ceil((Date.parse(s.pairing.expiresAt) - Date.now()) / 60_000)) : 0;

  return (
    <section className="card stack telegram">
      <div className="row">
        <h2 className="grow">{L("טלגרם", "Telegram")}</h2>
        {s.configured && s.local && (
          <label className="row small">
            <input type="checkbox" checked={s.enabled} disabled={busy || !s.allowed} onChange={(e) => void put({ enabled: e.target.checked })} /> {L("פעיל", "On")}
          </label>
        )}
      </div>
      <p className="muted">{L("לכתוב ל-KesherAI מטלגרם, מכל מקום, דרך בוט פרטי שלך. המודלים נשארים במחשב.", "Write to KesherAI from Telegram, from anywhere, through a bot of your own. The models stay on this computer.")}</p>

      <div className="tg-warn" role="note">
        <b>⚠ {L("לפני שמחברים", "Before you connect")}</b>
        <ul>
          <li>{L("מי שמחזיק בצ'אט המחובר יכול לדבר עם המחשב שלך. הפעל אימות דו-שלבי בטלגרם (הגדרות ← פרטיות ואבטחה ← אימות דו-שלבי).", "Whoever holds the paired chat can talk to your computer. Turn on Telegram's two-step verification (Settings → Privacy and Security → Two-Step Verification).")}</li>
          <li>{L("הודעות לבוט עוברות דרך השרתים של טלגרם ואינן מוצפנות מקצה לקצה. אל תשלח סיסמאות או מידע רגיש, ולעבודה רגישה השתמש באפליקציית KesherAI.", "Messages to a bot go through Telegram's servers and are not end-to-end encrypted. Do not send passwords or sensitive data; for sensitive work use the KesherAI app.")}</li>
          <li>{L("אל תשתף את הטוקן. אם הוא דלף: ב-@BotFather שלח ‎/revoke, ואז הסר את הבוט כאן.", "Never share the token. If it leaked: send /revoke to @BotFather, then remove the bot here.")}</li>
          <li>{L("צ'אט מטלגרם תמיד שואל לפני כל שינוי, ואין לו שליטה על המסך או הדפדפן. פקודות מאשרים רק במחשב או באפליקציה. ‎/lock בצ'אט מכבה את הבוט מיד.", "A Telegram chat always asks before any change and has no screen or browser control. Commands are approved only on the computer or in the app. /lock in the chat turns the bot off at once.")}</li>
        </ul>
      </div>

      {!s.allowed && <p className="bad">{L("מצב עסקי פעיל, והארגון לא מתיר טלגרם.", "Business mode is on and the organisation does not allow Telegram.")}</p>}

      {!s.local ? (
        <p>{s.configured ? L(`הבוט ${s.running ? "פועל" : "כבוי"}. מגדירים אותו רק במחשב שמריץ את KesherAI.`, `The bot is ${s.running ? "running" : "off"}. It is set up only on the computer that runs KesherAI.`) : L("מגדירים את זה במחשב שמריץ את KesherAI: הגדרות ← טלפון ← טלגרם.", "Set it up on the computer that runs KesherAI: Settings → Phone → Telegram.")}</p>
      ) : !s.configured ? (
        <>
          <label className="row small tg-ok"><input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} /> {L("קראתי והבנתי את האזהרות", "I read and understood the warnings")}</label>
          <ol className="tg-steps">
            <li>{L("בטלגרם, פתח את ", "In Telegram, open ")}<bdi><b dir="ltr">@BotFather</b></bdi>{L(" ושלח ", " and send ")}<bdi><code dir="ltr">/newbot</code></bdi>.</li>
            <li>{L("בחר שם ושם משתמש לבוט (נגמר ב-bot).", "Pick a name and a username for the bot (ending in bot).")}</li>
            <li>{L("העתק את הטוקן שהוא נותן והדבק כאן:", "Copy the token it gives and paste it here:")}</li>
          </ol>
          <div className="row">
            <input className="grow" type="password" autoComplete="off" dir="ltr" value={token} disabled={!understood} onChange={(e) => setToken(e.target.value)} placeholder="123456789:AA…" aria-label={L("טוקן של הבוט", "Bot token")} />
            <button type="button" className="primary" disabled={busy || !token.trim() || !understood || !s.allowed} onClick={() => void put({ token })}>{L("חבר", "Connect")}</button>
          </div>
          <small className="muted">{L("הטוקן נשמר רק במחשב הזה ולא נשלח לשום מקום חוץ מטלגרם.", "The token stays on this computer and goes nowhere but Telegram.")}</small>
        </>
      ) : (
        <>
          <div className="row wrap">
            <span className={`dot ${s.running && !s.error ? "on" : "off"}`} aria-hidden="true" />
            <span>{s.bot ? <bdi><b dir="ltr">@{s.bot}</b></bdi> : L("הבוט", "The bot")}</span>
            <span className="muted">· {s.running ? (s.error ? L(`לא מצליח להגיע לטלגרם: ${s.error}`, `Cannot reach Telegram: ${s.error}`) : L("פועל", "Running")) : L("כבוי", "Off")}</span>
          </div>

          <h3>{L("צ'אטים מחוברים", "Paired chats")}</h3>
          {s.chats.length ? (
            <ul className="tg-chats">
              {s.chats.map((c) => (
                <li key={c.id}>
                  <span className="grow">{c.name}{c.pairedAt && <small className="muted"> · {L("חובר ב-", "paired ")}{when(c.pairedAt)}</small>}</span>
                  <button type="button" disabled={busy} onClick={() => void run(() => api(`/api/telegram/chats/${c.id}`, { method: "DELETE" }))}>{L("נתק", "Unpair")}</button>
                </li>
              ))}
            </ul>
          ) : <p className="muted">{L("אין עדיין.", "None yet.")}</p>}

          {s.pairing ? (
            <div className="tg-pair">
              <span>{L(`החיבור פתוח עוד ${minutesLeft} דקות, לצ'אט אחד. שלח לבוט:`, `Pairing is open for ${minutesLeft} more minutes, for one chat. Send the bot:`)}</span>
              <code dir="ltr" className="tg-code">/start {s.pairing.code}</code>
              {s.bot && <a href={`https://t.me/${s.bot}?start=${s.pairing.code}`} target="_blank" rel="noopener noreferrer">{L("או פתח את הבוט בטלגרם", "or open the bot in Telegram")}</a>}
              <small className="muted">{L("אל תשתף את הקוד. חמישה ניסיונות שגויים סוגרים את החיבור, ותקבל התראה על כל חיבור.", "Do not share the code. Five wrong tries close pairing, and you are told about every pairing.")}</small>
              <div><button type="button" onClick={() => void run(() => api("/api/telegram/pair", { method: "DELETE" }))}>{L("סגור חיבור", "Close pairing")}</button></div>
            </div>
          ) : (
            <div><button type="button" className="primary" disabled={busy || !s.running} onClick={() => void run(() => api("/api/telegram/pair", { method: "POST" }))}>{L("חבר צ'אט (ל-10 דקות)", "Pair a chat (for 10 minutes)")}</button></div>
          )}

          <label className="row small tg-cmd">
            <input type="checkbox" checked={s.approveCommands} disabled={busy} onChange={(e) => {
              if (e.target.checked && !confirm(L("לאפשר לאשר פקודות מטלגרם? מי שמחזיק בצ'אט יוכל להריץ פקודות במחשב אחרי אישור. מומלץ להשאיר כבוי.", "Allow approving commands from Telegram? Whoever holds the chat could run commands on this computer after approving. Best left off."))) return;
              void put({ approveCommands: e.target.checked });
            }} />
            {L("לאפשר לאשר פקודות מטלגרם (לא מומלץ)", "Allow approving commands from Telegram (not recommended)")}
          </label>

          {s.log.length > 0 && (
            <details className="tg-log">
              <summary>{L("מה קרה לאחרונה", "Recent activity")}</summary>
              <ul>{s.log.map((l) => <li key={l.at + l.what}><small className="muted">{when(l.at)}</small> {l.what}</li>)}</ul>
            </details>
          )}

          <div className="row wrap">
            <button type="button" className="danger" disabled={busy} onClick={() => confirm(L("להסיר את הבוט ואת כל הצ'אטים? (מומלץ גם לשלוח ‎/revoke ל-@BotFather)", "Remove the bot and every chat? (Also send /revoke to @BotFather.)")) && void run(() => api("/api/telegram", { method: "DELETE" }))}>{L("הסר את הבוט", "Remove the bot")}</button>
          </div>
        </>
      )}
    </section>
  );
}
