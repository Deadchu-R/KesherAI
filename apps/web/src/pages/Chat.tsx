import { useRef, useState } from "react";
import { streamChat, type ChatMessage } from "../api";
import { useModels } from "../useModels";
import { t } from "../i18n";

/** Chat with any chat model, local or cloud, streamed token by token. */
export function ChatPage() {
  const { models, errors } = useModels("chat");
  const [modelId, setModelId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = modelId || models[0]?.id || "";

  async function send() {
    const text = input.trim();
    if (!text || !selected || busy) return;
    const history: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages([...history, { role: "assistant", content: "" }]);
    setInput("");
    setError("");
    abort.current = new AbortController();
    setBusy(true);
    try {
      await streamChat(
        selected,
        history,
        (ev) => {
          if (ev.type === "delta") {
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1]!;
              next[next.length - 1] = { ...last, content: last.content + ev.text };
              return next;
            });
          } else if (ev.type === "error") setError(ev.message);
        },
        abort.current.signal,
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      abort.current = null;
      setBusy(false);
    }
  }

  return (
    <>
      <div className="topbar">
        <select value={selected} onChange={(e) => setModelId(e.target.value)} aria-label={t("pickModel")} style={{ minWidth: 260 }}>
            {models.length === 0 && <option value="">{t("noModels")}</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} · {m.providerId} ({m.location})
              </option>
            ))}
        </select>
        <button type="button" onClick={() => setMessages([])}>{t("newChat")}</button>
        {errors.map((e) => (
          <span key={e.providerId} className="pill bad" title={e.message}>{e.providerId}: {t("offline")}</span>
        ))}
      </div>
      <div className="chat">
        <div className="messages" aria-live="polite">
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>{m.content || (busy && i === messages.length - 1 ? "…" : "")}</div>
          ))}
          {error && <p className="error">{error}</p>}
        </div>
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <div className="box">
            <textarea
              rows={2}
              value={input}
              placeholder={t("messagePlaceholder")}
              aria-label={t("messagePlaceholder")}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            {busy ? (
              <button type="button" onClick={() => abort.current?.abort()}>{t("stop")}</button>
            ) : (
              <button type="submit" className="primary" disabled={!selected || !input.trim()}>{t("send")}</button>
            )}
          </div>
        </form>
      </div>
    </>
  );
}
