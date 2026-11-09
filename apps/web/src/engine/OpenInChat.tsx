import { useEffect, useRef, useState } from "react";
import { getLocale } from "../i18n";
import { createConversation, toast, useLibrary } from "../library";
import { openWithDraft } from "../phone";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/**
 * "Open in chat": the project goes into a chat, a new one or one you pick,
 * so you keep working on it in words (the chat's Unity or Unreal tools).
 *
 * @param props.line - What goes into the message box (empty: no project yet).
 */
export function OpenInChat({ line }: { line: string }) {
  const { conversations } = useLibrary();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener("mousedown", close);
    return () => removeEventListener("mousedown", close);
  }, [open]);
  if (!line) return null;
  const newChat = () =>
    void createConversation({ kind: "chat" }).then((id) => id && openWithDraft(id, line), (e: Error) => toast(e.message));
  return (
    <div className="model-menu" ref={ref}>
      <button type="button" className="primary" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>💬 {L("פתח בצ'אט", "Open in chat")}</button>
      {open && (
        <div className="model-pop" role="menu">
          <button type="button" role="menuitem" onClick={() => { setOpen(false); newChat(); }}>＋ {L("צ'אט חדש", "New chat")}</button>
          <div className="model-group-head"><span>{L("או לצ'אט קיים", "Or into a chat")}</span></div>
          <div className="model-pop-list">
            {conversations.slice(0, 12).map((c) => (
              <button key={c.id} type="button" role="menuitem" onClick={() => { setOpen(false); openWithDraft(c.id, line); }}><span dir="auto">{c.title}</span></button>
            ))}
            {!conversations.length && <p className="muted small">{L("אין עדיין צ'אטים.", "No chats yet.")}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
