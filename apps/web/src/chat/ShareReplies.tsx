import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** The owner's reply settings on a share (core shared-chat.ts). */
interface Replies { on: boolean; until: string | null; tools: boolean; perMinute: number; muted: string[] }
/** The room as the owner sees it (GET /api/conversations/:id/share/room). */
interface Room {
  project: { id: string; name: string } | null;
  replies: Replies | null;
  ended: boolean;
  guests: Array<{ id: string; name: string; role: "read" | "edit"; muted: boolean; typing: boolean }>;
  messages: Array<{ seq: number; name: string; text: string; at: string }>;
}

/**
 * "Allow replies" in the share sheet (FEATURE_REVIEW 2026-11-21): the project's guests write in this chat, see the
 * answer as it is written and who is typing. Off by default; the owner picks how long, how many messages a minute,
 * whether guests' messages may use tools (each action still asks here), and can mute or remove a guest and delete
 * their messages. Read every 3 seconds while replies are on.
 */
export function ShareReplies({ convId }: { convId: string }) {
  const [room, setRoom] = useState<Room | null>(null);
  const [hours, setHours] = useState(24);
  const load = useCallback(() => api<Room>(`/api/conversations/${encodeURIComponent(convId)}/share/room`).then(setRoom, () => undefined), [convId]);
  useEffect(() => {
    void load();
  }, [load]);
  const on = !!room?.replies?.on && !room.ended;
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => { if (!document.hidden) void load(); }, 3000);
    return () => clearInterval(t);
  }, [on, load]);
  const put = (body: Record<string, unknown>) =>
    void api(`/api/conversations/${encodeURIComponent(convId)}/share/replies`, { method: "PUT", body }).then(() => load(), (e: Error) => toast(e.message));
  const mute = (guest: string, muted: boolean) =>
    void api(`/api/conversations/${encodeURIComponent(convId)}/share/mute`, { method: "POST", body: { guest, muted } }).then(() => load(), (e: Error) => toast(e.message));
  const remove = (guest: string, name: string) => {
    if (!room?.project || !confirm(L(`להוציא את ${name} מהפרויקט? המפתח שלו יפסיק לעבוד מיד.`, `Remove ${name} from the project? Their key stops working at once.`))) return;
    void api(`/api/projects/${encodeURIComponent(room.project.id)}/guests/${encodeURIComponent(guest)}`, { method: "DELETE" }).then(() => load(), (e: Error) => toast(e.message));
  };
  const drop = (seq: number) =>
    void api(`/api/conversations/${encodeURIComponent(convId)}/guest-messages/${seq}`, { method: "DELETE" }).then(() => load(), (e: Error) => toast(e.message));
  if (!room) return null;
  if (!room.project) {
    return <p className="muted small share-replies-note">{L("כדי שאנשים יוכלו להגיב כאן: העבירו את השיחה לפרויקט והזמינו אותם מכפתור השיתוף של הפרויקט.", "To let people reply here: move this chat into a project and invite them from the project's Share button.")}</p>;
  }
  const typing = room.guests.filter((g) => g.typing).map((g) => g.name);
  return (
    <section className="stack share-replies" aria-label={L("תגובות של אורחים", "Guests' replies")}>
      <label className="row share-replies-switch">
        <input type="checkbox" checked={on} onChange={(e) => put(e.target.checked ? { on: true, hours } : { on: false })} />
        <span className="grow">
          <b>{L("לאפשר תגובות", "Allow replies")}</b>
          <span className="muted small block">{L(`אורחי "${room.project.name}" עם הרשאת כתיבה יכולים לכתוב בשיחה, לראות את התשובה נכתבת ומי מקליד.`, `Guests of "${room.project.name}" who can write may reply here and see the answer as it is written and who is typing.`)}</span>
        </span>
      </label>
      {room.ended && room.replies?.on && <p className="small share-warn">{L("זמן התגובות נגמר. הפעילו שוב כדי לפתוח מחדש.", "Replies have ended. Turn them on again to reopen.")}</p>}
      <div className="row share-replies-opts">
        <label className="row small">
          {L("עד:", "For:")}
          <select value={hours} onChange={(e) => { const h = Number(e.target.value); setHours(h); if (on) put({ hours: h }); }}>
            <option value={1}>{L("שעה", "1 hour")}</option>
            <option value={24}>{L("יום", "1 day")}</option>
            <option value={168}>{L("שבוע", "7 days")}</option>
            <option value={0}>{L("כל עוד הקישור עובד", "While the link works")}</option>
          </select>
        </label>
        <label className="row small">
          {L("הודעות בדקה לאורח:", "Messages a minute each:")}
          <select value={room.replies?.perMinute ?? 6} onChange={(e) => put({ perMinute: Number(e.target.value) })}>
            {[2, 6, 12].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>
      {on && room.replies?.until && <p className="muted small">{L(`התגובות נסגרות ב-${new Date(room.replies.until).toLocaleString("he-IL")}`, `Replies close ${new Date(room.replies.until).toLocaleString()}`)}</p>}
      {on && (
        <label className="row share-replies-switch">
          <input type="checkbox" checked={!!room.replies?.tools} onChange={(e) => put({ tools: e.target.checked })} />
          <span className="grow">
            <b>{L("אורחים יכולים להשתמש בכלים", "Guests may use tools")}</b>
            <span className="muted small block">{L("קבצים, דפדפן, מחשב ומנועים. כל פעולה תחכה לאישור שלך כאן, בלי \"תמיד\". כבוי: הודעה של אורח נענית בלי כלים.", "Files, browser, computer and engines. Every action waits for your yes here, never \"Always\". Off: a guest's message is answered with no tools.")}</span>
          </span>
        </label>
      )}
      {on && typing.length > 0 && <p className="muted small share-typing" role="status">✎ {L(`${typing.join(", ")} מקליד…`, `${typing.join(", ")} typing…`)}</p>}
      {room.guests.length > 0 && (
        <ul className="stack share-guests">
          {room.guests.map((g) => (
            <li key={g.id} className="row share-guest">
              <span className="grow share-guest-name" dir="auto">
                {g.name} <span className="muted small">· {g.role === "edit" ? L("כתיבה", "write") : L("צפייה", "read")}{g.muted ? ` · ${L("מושתק", "muted")}` : ""}</span>
              </span>
              <button type="button" className="ghost small" onClick={() => mute(g.id, !g.muted)}>{g.muted ? L("בטל השתקה", "Unmute") : L("השתק", "Mute")}</button>
              <button type="button" className="ghost small danger-text" onClick={() => remove(g.id, g.name)}>{L("הוצא", "Remove")}</button>
            </li>
          ))}
        </ul>
      )}
      {room.messages.length > 0 && (
        <details className="share-guest-msgs">
          <summary className="small">{L(`הודעות של אורחים (${room.messages.length})`, `Guests' messages (${room.messages.length})`)}</summary>
          <ul className="stack">
            {room.messages.map((m) => (
              <li key={m.seq} className="row share-guest-msg">
                <span className="grow small" dir="auto"><b>{m.name}:</b> {m.text}</span>
                <button type="button" className="ghost small danger-text" onClick={() => drop(m.seq)} aria-label={L(`מחק את ההודעה של ${m.name}`, `Delete ${m.name}'s message`)}>{L("מחק", "Delete")}</button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/**
 * Tells a shared chat's guests that the owner is typing: one beat in 3 seconds while the composer has text. Only for
 * chats in a project (only those can have replies); when the server answers that replies are off, it stops asking for
 * a minute, so ordinary chats cost at most one small request a minute while typing.
 *
 * @param convId - The chat.
 * @param text - The composer's text now.
 * @param enabled - Whether this chat could have replies (a chat in a project).
 */
export function useOwnerTyping(convId: string, text: string, enabled: boolean): void {
  const next = useRef(0);
  useEffect(() => {
    next.current = 0;
  }, [convId]);
  useEffect(() => {
    if (!enabled || !text.trim() || Date.now() < next.current) return;
    next.current = Date.now() + 3000;
    void api<{ on: boolean }>(`/api/conversations/${encodeURIComponent(convId)}/typing`, { method: "POST" }).then(
      (r) => { if (!r.on) next.current = Date.now() + 60_000; },
      () => { next.current = Date.now() + 60_000; },
    );
  }, [convId, text, enabled]);
}
