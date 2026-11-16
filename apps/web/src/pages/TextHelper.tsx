import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale } from "../i18n";
import { desktop, toast } from "../library";
import { ConversationPage } from "./Conversation";
import { LineIcon } from "../ui/Glyph";
import { actionPrompt } from "../text-helper-prompts";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/**
 * The Text Helper's window (`#/text/<chat>/<selection>`), opened by Ctrl+Alt+K over any app: the selected text,
 * quick actions, a free question, and the answer, which can be copied or put back in place of the selection.
 * Esc closes it.
 *
 * @param props.hash - The address after `#`.
 */
export function TextHelper({ hash }: { hash: string }) {
  const [, , chatId = "", selId = ""] = hash.split("/").map((x) => decodeURIComponent(x));
  const [text, setText] = useState<string | null>(null);
  const [cut, setCut] = useState(false);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState("");
  const [question, setQuestion] = useState("");
  const inWindow = !!desktop()?.textPaste;
  // The user's own quick actions (Settings → Keyboard and helpers).
  const [mine, setMine] = useState<Array<{ label: string; prompt: string }>>([]);
  useEffect(() => {
    void api<{ actions: Array<{ label: string; prompt: string }> }>("/api/text-helper/actions").then((r) => setMine(r.actions), () => undefined);
  }, []);

  useEffect(() => {
    void api<{ text: string; cut?: boolean }>(`/api/text-helper/${encodeURIComponent(selId)}`)
      .then((r) => {
        setText(r.text);
        setCut(!!r.cut);
      })
      .catch(() => setText(""));
  }, [selId]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector('[role="dialog"]')) {
        if (inWindow) window.close();
        else history.back();
      }
    };
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [inWindow]);

  /** Sends a question to the helper's chat, then keeps the answer for Copy / Replace. */
  const ask = async (prompt: string) => {
    setBusy(true);
    setAnswer("");
    try {
      await api(`/api/conversations/${encodeURIComponent(chatId)}/messages`, { method: "POST", body: { text: prompt } });
      // The answer comes in the chat below. Wait on the small activity list (not the whole chat, which grows with
      // every question; scan 64), then read the chat once: its last reply is the answer.
      let seen = false;
      for (let i = 0; i < 600; i++) {
        await new Promise((r) => setTimeout(r, 700));
        const act = await api<Record<string, string>>("/api/conversations/activity");
        if (act[chatId] === "running") seen = true;
        // Done once it was seen running (or it never showed as running within ~3 s: a very quick answer).
        else if (seen || i >= 3) break;
      }
      const c = await api<{ events?: Array<{ type: string; turn?: number; text?: string }> }>(`/api/conversations/${encodeURIComponent(chatId)}`);
      const replies = (c.events ?? []).filter((e) => e.type === "assistant" && e.text);
      const last = replies.at(-1)?.turn;
      setAnswer(replies.filter((e) => e.turn === last).map((e) => e.text).join("").trim());
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(answer).then(() => toast(L("הועתק", "Copied")), () => toast(L("לא ניתן להעתיק", "Could not copy")));
  };
  const replace = async () => {
    const r = await desktop()?.textPaste?.(answer);
    if (r?.error) toast(r.error);
    else if (r && !r.pasted) toast(L("הועתק. הדביקו עם Ctrl+V", "Copied. Paste it with Ctrl+V"));
  };

  const t = text ?? "";
  const actions: Array<{ kind: Parameters<typeof actionPrompt>[0]; icon: string; label: string }> = [
    { kind: "summarize", icon: "page", label: L("סיכום", "Summarize") },
    { kind: "translate", icon: "globe", label: L("תרגום", "Translate") },
    { kind: "fix", icon: "check", label: L("תיקון שגיאות", "Fix mistakes") },
    { kind: "simpler", icon: "pencil", label: L("פשוט יותר", "Simpler") },
    { kind: "explain", icon: "sparkle", label: L("הסבר", "Explain") },
    { kind: "reply", icon: "chat", label: L("תשובה", "Reply") },
  ];

  return (
    <div className="text-helper">
      <header className="row text-head">
        <LineIcon name="pencil" />
        <span className="grow text-title">{L("עוזר טקסט", "Text helper")}</span>
        <button type="button" className="icon-btn" onClick={() => (inWindow ? window.close() : history.back())} aria-label={L("סגירה (Esc)", "Close (Esc)")} title={L("סגירה (Esc)", "Close (Esc)")}>
          <LineIcon name="close" size={16} />
        </button>
      </header>
      {text === null ? (
        <p className="muted small">{L("קורא…", "Reading…")}</p>
      ) : t ? (
        <>
          <blockquote className="text-sel" dir="auto">{t}</blockquote>
          {cut && <p className="muted small">{L("הטקסט קוצר ל-20,000 תווים", "The text was cut to 20,000 characters")}</p>}
        </>
      ) : (
        <p className="muted small">{L("לא נבחר טקסט. סמנו טקסט בכל אפליקציה ולחצו Ctrl+Alt+K. אפשר גם לשאול כאן.", "No text was selected. Select text in any app and press Ctrl+Alt+K. You can also ask here.")}</p>
      )}
      {t && (
        <div className="text-actions">
          {actions.map((a) => (
            <button key={a.kind} type="button" disabled={busy} onClick={() => void ask(actionPrompt(a.kind, t, getLocale()))}>
              <LineIcon name={a.icon} size={16} />
              {a.label}
            </button>
          ))}
          {mine.map((a, i) => (
            <button key={`mine-${i}`} type="button" disabled={busy} title={a.prompt} onClick={() => void ask(`${a.prompt}\n\n"""\n${t}\n"""`)} dir="auto">
              <LineIcon name="star" size={16} />
              {a.label}
            </button>
          ))}
        </div>
      )}
      <form
        className="row text-ask"
        onSubmit={(e) => {
          e.preventDefault();
          if (!question.trim()) return;
          void ask(t ? `${question.trim()}\n\n"""\n${t}\n"""` : question.trim());
          setQuestion("");
        }}
      >
        <input className="grow" dir="auto" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={t ? L("שאלה על הטקסט…", "Ask about the text…") : L("שאלה…", "Ask…")} disabled={busy} />
        <button type="submit" className="primary" disabled={busy || !question.trim()}>{L("שליחה", "Send")}</button>
      </form>
      {answer && !busy && (
        <div className="row text-use">
          <button type="button" onClick={() => void copy()}><LineIcon name="clipboard" size={16} />{L("העתקה", "Copy")}</button>
          {inWindow && <button type="button" onClick={() => void replace()} title={L("מדביק במקום הטקסט שסומן", "Pastes it in place of the selected text")}><LineIcon name="swap" size={16} />{L("החלפת הטקסט", "Replace the text")}</button>}
          {!inWindow && <a className="btn" href={`#/c/${encodeURIComponent(chatId)}`}>{L("פתיחה בצ'אט", "Open in chat")}</a>}
        </div>
      )}
      <div className="text-chat">
        <ConversationPage id={chatId} />
      </div>
    </div>
  );
}
