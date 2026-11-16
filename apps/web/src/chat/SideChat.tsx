import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { RichText } from "../RichText";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

interface SideTurn { role: "user" | "assistant"; text: string }

/**
 * The side chat (audit F3, like Claude's `/btw`): a quick question beside the chat that never enters it. The
 * chat's model answers with the chat as context; nothing is saved (the thread is gone when KesherAI restarts).
 * A panel beside the chat on a computer, a sheet over it on a phone.
 *
 * @param p.convId - The chat.
 * @param p.first - A question to ask right away (from `/side …`).
 * @param p.onClose - Closes the panel.
 */
export function SideChat({ convId, first, onClose }: { convId: string; first?: string; onClose: () => void }) {
  const [thread, setThread] = useState<SideTurn[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const asked = useRef("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void api<{ thread: SideTurn[] }>(`/api/conversations/${encodeURIComponent(convId)}/side`).then((r) => setThread(r.thread), () => undefined);
  }, [convId]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [thread, busy]);
  const ask = async (q: string) => {
    const question = q.trim();
    if (!question || busy) return;
    setBusy(true);
    setError("");
    setText("");
    setThread((t) => [...t, { role: "user", text: question }]);
    try {
      const r = await api<{ thread: SideTurn[] }>(`/api/conversations/${encodeURIComponent(convId)}/side`, { method: "POST", body: { text: question } });
      setThread(r.thread);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (first && asked.current !== first) {
      asked.current = first;
      void ask(first);
    }
  }, [first]);
  const clear = () => void api(`/api/conversations/${encodeURIComponent(convId)}/side`, { method: "DELETE" }).then(() => setThread([]), () => undefined);
  return (
    <aside className="side-chat" aria-label={L("צ׳אט צד", "Side chat")}>
      <div className="row side-chat-head">
        <strong className="grow">{L("צ׳אט צד", "Side chat")}</strong>
        {thread.length > 0 && <button type="button" className="link-btn small" onClick={clear}>{L("ניקוי", "Clear")}</button>}
        <button type="button" className="icon-btn" aria-label={L("סגירה", "Close")} onClick={onClose}>✕</button>
      </div>
      <p className="muted small">{L("שאלה בצד: המודל רואה את הצ׳אט, אבל שום דבר מכאן לא נכנס אליו.", "A question on the side: the model sees the chat, but nothing here goes into it.")}</p>
      <div className="side-chat-thread">
        {thread.map((t, i) => (t.role === "user" ? <div key={i} className="side-q" dir="auto">{t.text}</div> : <div key={i} className="side-a"><RichText text={t.text} /></div>))}
        {busy && <p className="muted small">{L("חושב…", "Thinking…")}</p>}
        {error && <p className="error small">{error}</p>}
        <div ref={end} />
      </div>
      <form className="side-chat-box" onSubmit={(e) => { e.preventDefault(); void ask(text); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={L("שאלה בצד…", "A side question…")} aria-label={L("שאלה בצד", "A side question")} dir="auto" />
        <button type="submit" className="primary" disabled={busy || !text.trim()}>{L("שאל", "Ask")}</button>
      </form>
    </aside>
  );
}
