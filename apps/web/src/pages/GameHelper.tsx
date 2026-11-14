import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale } from "../i18n";
import { toast } from "../library";
import { ConversationPage } from "./Conversation";
import { PadHints } from "../PadHints";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/**
 * The Game Helper's window over the game (`#/game/<chat>/<picture>`), opened by Ctrl+Shift+G: the picture just taken,
 * three big questions on the controller's buttons (as Gaming Copilot's suggestions), and the game's own chat, which
 * remembers earlier questions. B (or Esc) closes it and the game is in front again.
 *
 * @param props.hash - The address after `#`.
 */
export function GameHelper({ hash }: { hash: string }) {
  const [, , chatId = "", file = ""] = hash.split("/").map((x) => decodeURIComponent(x));
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<{ title?: string }>(`/api/conversations/${encodeURIComponent(chatId)}`)
      .then((c) => setTitle((c.title ?? "").replace(/^🎮\s*/, "")))
      .catch(() => undefined);
  }, [chatId]);

  const ask = async (text: string, web = false) => {
    setBusy(true);
    try {
      await api(`/api/conversations/${encodeURIComponent(chatId)}/messages`, { method: "POST", body: { text, web } });
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const game = title || L("המשחק", "the game");
  const QUESTIONS = [
    { pad: "X", cls: "x", label: L("מה עושים כאן?", "What do I do here?"), text: L(`אני משחק ב-${game}. לפי התמונה, מה עליי לעשות עכשיו? צעדים קצרים.`, `I'm playing ${game}. From the picture, what should I do now? Short steps.`), web: false },
    { pad: "Y", cls: "y", label: L("מה רואים במסך?", "What's on my screen?"), text: L("תסביר בקצרה מה רואים בתמונה: אויבים, פריטים, משימה, מפה.", "Briefly explain what is in the picture: enemies, items, the objective, the map."), web: false },
    { pad: "RB", cls: "lr", label: L("מדריך מהאינטרנט", "Guide from the web"), text: L(`חפש מדריך ל-${game} למקום הזה במשחק (לפי התמונה), וסכם את הצעדים עם מקורות.`, `Search for a ${game} guide for this point in the game (from the picture) and sum up the steps, with sources.`), web: true },
  ];

  // The controller's X / Y / RB ask; B closes the window (gamepad.ts asks the page first).
  useEffect(() => {
    const on = (e: Event) => {
      const b = (e as CustomEvent<string>).detail;
      const q = QUESTIONS.find((x) => x.pad === b);
      if (q && !busy) {
        e.preventDefault();
        void ask(q.text, q.web);
      } else if (b === "B" && !document.querySelector('[role="dialog"]')) {
        e.preventDefault();
        window.close();
      }
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector('[role="dialog"]')) window.close();
    };
    window.addEventListener("kesher:pad-button", on);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("kesher:pad-button", on);
      window.removeEventListener("keydown", esc);
    };
  });

  return (
    <div className="game-helper">
      <PadHints />
      <header className="row game-head">
        <span className="game-title grow" dir="auto">🎮 {title || L("עוזר משחקים", "Game Helper")}</span>
        <button type="button" data-pad="B" className="game-close" onClick={() => window.close()} aria-label={L("חזרה למשחק", "Back to the game")} title={L("חזרה למשחק (B / Esc)", "Back to the game (B / Esc)")}>✕</button>
      </header>
      {file ? (
        <img className="game-shot" src={`/api/game-helper/${encodeURIComponent(chatId)}/shot/${encodeURIComponent(file)}`} alt={L("התמונה מהמשחק שתישלח עם השאלה", "The picture of the game sent with the question")} />
      ) : (
        <p className="muted small">{L("לא צולמה תמונה (אין משחק בחזית). אפשר לשאול בכל זאת.", "No picture was taken (no game in front). You can still ask.")}</p>
      )}
      <div className="game-asks">
        {QUESTIONS.map((q) => (
          <button key={q.pad} type="button" className="game-ask" disabled={busy} onClick={() => void ask(q.text, q.web)}>
            <span className={`pad-btn ${q.cls}`} aria-hidden="true">{q.pad}</span>
            {q.label}
          </button>
        ))}
      </div>
      <div className="game-chat">
        <ConversationPage id={chatId} />
      </div>
    </div>
  );
}
