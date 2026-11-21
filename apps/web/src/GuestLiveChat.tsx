import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { RichText } from "./RichText";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** One message as a guest sees it (core routes/shared-chat.ts): who wrote it, its text only. */
interface LiveMessage { seq: number; role: "user" | "assistant"; from: string; guest: boolean; text: string }
/** The chat live (GET /api/guest/chats/:id/live). */
interface Live {
  title: string;
  busy: boolean;
  messages: LiveMessage[];
  writing: string;
  typing: string[];
  replies: { canSend: true; tools: boolean; perMinute: number } | { canSend: false; why: { he: string; en: string } };
}

/**
 * The owner's chat as a guest sees it (FEATURE_REVIEW 2026-11-21 "Allow replies"): live, with the answer as it is
 * written, who wrote each message, who is typing and, when the owner allows replies and the guest may write, a
 * composer. Asked again every 1.5 seconds while something happens, every 5 seconds when quiet (not while hidden).
 *
 * @param id - The chat.
 * @param me - The guest's own name (their messages show as "You").
 * @param onLeft - Called with what is left of today's answers after a message.
 */
export function GuestLiveChat({ id, me, onLeft }: { id: string; me: string; onLeft: (left: number) => void }) {
  const [live, setLive] = useState<Live | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const last = useRef(0);
  const beat = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const read = useCallback(async () => {
    clearTimeout(timer.current);
    let quick = true;
    if (!document.hidden) {
      try {
        const r = await api<Live>(`/api/guest/chats/${encodeURIComponent(id)}/live?after=${last.current}`);
        setLive((old) => ({ ...r, messages: [...(old?.messages ?? []), ...r.messages] }));
        if (r.messages.length) last.current = r.messages[r.messages.length - 1]!.seq;
        quick = r.busy || r.typing.length > 0 || r.replies.canSend;
      } catch (e) {
        setError((e as Error).message);
        quick = false;
      }
    }
    timer.current = setTimeout(() => void read(), quick ? 1500 : 5000);
  }, [id]);
  useEffect(() => {
    last.current = 0;
    setLive(null);
    void read();
    return () => clearTimeout(timer.current);
  }, [read]);

  /** At most one typing beat in 2 seconds (the server takes one a second). */
  const typed = (v: string) => {
    setText(v);
    if (!live?.replies.canSend || !v.trim() || Date.now() - beat.current < 2000) return;
    beat.current = Date.now();
    void api(`/api/guest/chats/${encodeURIComponent(id)}/typing`, { method: "POST" }).catch(() => undefined);
  };
  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    setError("");
    try {
      const r = await api<{ left: number }>(`/api/guest/chats/${encodeURIComponent(id)}/reply`, { method: "POST", body: { text } });
      setText("");
      onLeft(r.left);
      setTimeout(() => void read(), 400);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  if (!live) return <p className="muted small">{error || L("טוען…", "Loading…")}</p>;
  const who = (m: LiveMessage) => (m.role === "assistant" ? "KesherAI" : m.guest ? (m.from === me ? L("את/ה", "You") : m.from) : L("הבעלים", "Owner"));
  return (
    <section className="stack guest-chat-view">
      {live.messages.map((m) => (
        <div key={m.seq} className={m.role === "user" ? `msg user${m.guest ? " from-guest" : ""}` : "msg"} dir="auto">
          <span className="guest-from" dir="auto">{who(m)}</span>
          {m.role === "user" ? m.text : <RichText text={m.text} />}
        </div>
      ))}
      {live.busy && (live.writing ? (
        <div className="msg guest-writing" dir="auto" aria-live="polite">
          <span className="guest-from">KesherAI</span>
          <RichText text={live.writing} />
        </div>
      ) : <p className="muted small" role="status">{L("עונה…", "Answering…")}</p>)}
      {live.typing.length > 0 && <p className="muted small guest-typing" role="status">✎ {L(`${live.typing.join(", ")} מקליד…`, `${live.typing.join(", ")} typing…`)}</p>}
      {error && <p className="error small" role="alert" dir="auto">{error}</p>}
      {live.replies.canSend ? (
        <form className="row guest-compose" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <textarea value={text} onChange={(e) => typed(e.target.value)} rows={2} maxLength={4000} dir="auto" aria-label={L("הודעה לשיחה", "Message to the chat")} placeholder={L(`כותב/ת בתור ${me}…`, `Writing as ${me}…`)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
          <button type="submit" className="primary" disabled={!text.trim() || sending}>{L("שלח", "Send")}</button>
        </form>
      ) : (
        <p className="muted small" dir="auto">{L(live.replies.why.he, live.replies.why.en)}</p>
      )}
      {live.replies.canSend && <p className="muted small">{live.replies.tools ? L("הבעלים מאשר כל פעולה של כלי שהודעה שלך מבקשת.", "The owner approves every tool action your message asks for.") : L("הודעות של אורחים נענות בלי כלים.", "Guests' messages are answered without tools.")}</p>}
    </section>
  );
}
