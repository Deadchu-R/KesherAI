import { useEffect, useRef, useState } from "react";
import { api, isRemote } from "../api";
import { getLocale, he$ } from "../i18n";
import { createConversation, toast } from "../library";
import { openWithVoice } from "../phone";
import { startGamepad } from "../gamepad";
import { LineIcon } from "../ui/Glyph";
import { CONSOLE_TILES, consoleOn, gamePrompt, gridCols, gridMove, setConsoleOn, type ConsoleTile, type GameAsk, type PadDir } from "../console-mode";
import { ConversationPage } from "./Conversation";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

const PAD_DIRS: Record<string, PadDir> = { UP: "up", DOWN: "down", LEFT: "left", RIGHT: "right" };
const KEY_DIRS: Record<string, PadDir> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

/** Turns console mode on (and opens its home) or off (back to the usual look). */
export function switchConsole(on: boolean): void {
  setConsoleOn(on);
  location.hash = on ? "#/console" : "#/";
}

let watching = false;

/**
 * While console mode is on, on the PC only: when KesherAI loses the focus (the player went back to the game) it asks
 * the server once, a few seconds later, which game is in front, and again every two minutes while it stays away, so
 * the game helper knows the game. Only the window's name is read; nothing runs while KesherAI is in front.
 */
export function watchGameWhileAway(): void {
  if (watching || isRemote()) return;
  watching = true;
  let timer: number | undefined;
  const look = () => {
    timer = undefined;
    if (!consoleOn() || document.hasFocus()) return;
    void api("/api/game-helper/seen", { method: "POST" }).catch(() => undefined);
    timer = window.setTimeout(look, 120_000);
  };
  window.addEventListener("blur", () => {
    if (consoleOn() && timer === undefined) timer = window.setTimeout(look, 3000);
  });
  window.addEventListener("focus", () => {
    window.clearTimeout(timer);
    timer = undefined;
  });
}

/** A controller button and what it does, for the footer. */
function Hint({ b, cls, text }: { b: string; cls: string; text: string }) {
  return (
    <span className="pad-hint">
      <span className={`pad-btn ${cls}`} aria-hidden="true">{b}</span>
      {text}
    </span>
  );
}

/**
 * Console mode (`#/console`, `#/console/game`): a full-screen home for a handheld or a TV, as the Xbox full-screen
 * experience and Steam Big Picture: "continue" with the last chat, then big tiles (chat, voice, game helper, images,
 * models, the PC, settings), moved through with the D-pad or stick, with the controller's buttons always shown along
 * the bottom. View+Menu held switches it off (or the Leave button). No animations, for the battery.
 *
 * @param props.hash - The address after `#`.
 */
export function ConsoleMode({ hash }: { hash: string }) {
  useEffect(() => {
    startGamepad();
    watchGameWhileAway();
    const off = () => switchConsole(false);
    window.addEventListener("kesher:console", off);
    return () => window.removeEventListener("kesher:console", off);
  }, []);
  return hash.startsWith("#/console/game") ? <ConsoleGame /> : <ConsoleHome />;
}

/** The tiles and the "continue" card. */
function ConsoleHome() {
  const [last, setLast] = useState<{ id: string; title: string } | null>(null);
  const [at, setAt] = useState(0);
  const [cols, setCols] = useState(() => gridCols(innerWidth));
  const tiles = useRef<Array<HTMLButtonElement | null>>([]);
  const resume = useRef<HTMLAnchorElement | null>(null);
  const rtl = getLocale() === "he";

  useEffect(() => {
    void api<Array<{ id: string; title?: string; kind?: string }>>("/api/conversations")
      .then((list) => {
        const c = list.find((x) => x.kind !== "code");
        if (c) {
          setLast({ id: c.id, title: c.title || L("צ'אט", "Chat") });
          setAt(-1);
        }
      })
      .catch(() => undefined);
    const resize = () => setCols(gridCols(innerWidth));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  // The focus follows the chosen tile (shown with the bold ring, as the controller's look).
  useEffect(() => {
    const el = at < 0 ? resume.current : tiles.current[at];
    (el?.focus as ((o?: FocusOptions & { focusVisible?: boolean }) => void) | undefined)?.call(el, { preventScroll: false, focusVisible: true });
  }, [at, last]);

  const go = (dir: PadDir) => setAt((i) => gridMove(i, CONSOLE_TILES.length, cols, dir, { rtl, header: !!last }));

  // The controller's directions (gamepad.ts asks the page first); B stays here (Leave is a tile of its own).
  useEffect(() => {
    const on = (e: Event) => {
      const b = (e as CustomEvent<string>).detail;
      const dir = PAD_DIRS[b];
      if (dir) {
        e.preventDefault();
        go(dir);
      } else if (b === "B" || b === "LB" || b === "RB") e.preventDefault();
    };
    window.addEventListener("kesher:pad-button", on);
    return () => window.removeEventListener("kesher:pad-button", on);
  });

  const open = async (t: ConsoleTile) => {
    if (t.id === "voice") {
      try {
        const id = await createConversation({ kind: "chat" }, { open: false });
        if (id) openWithVoice(id);
      } catch (e) {
        toast((e as Error).message);
      }
      return;
    }
    if (t.href) location.hash = t.href;
  };

  return (
    <main className="console" aria-label={L("מצב קונסולה", "Console mode")}>
      <header className="row console-head">
        <span className="console-title grow">KesherAI</span>
        <button type="button" className="console-leave" onClick={() => switchConsole(false)}>
          {L("יציאה ממצב קונסולה", "Leave console mode")}
        </button>
      </header>
      <div
        className="console-grid"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        onKeyDown={(e) => {
          const dir = KEY_DIRS[e.key];
          if (!dir || e.altKey || e.ctrlKey || e.metaKey) return;
          e.preventDefault();
          go(dir);
        }}
      >
        {last && (
          <a ref={resume} className="console-resume" href={`#/c/${encodeURIComponent(last.id)}`} onFocus={() => setAt(-1)}>
            <LineIcon name="play" size={34} />
            <span className="console-resume-text">
              <span className="small muted">{L("להמשיך מאיפה שהפסקת", "Jump back in")}</span>
              <span className="console-resume-title" dir="auto">{last.title}</span>
            </span>
          </a>
        )}
        {CONSOLE_TILES.map((t, i) => (
          <button key={t.id} ref={(el) => void (tiles.current[i] = el)} type="button" className="console-tile" onFocus={() => setAt(i)} onClick={() => void open(t)}>
            <LineIcon name={t.icon} size={44} />
            <span>{L(t.he, t.en)}</span>
          </button>
        ))}
      </div>
      <footer className="console-hints" role="note" aria-label={L("כפתורי השלט", "Controller buttons")}>
        <Hint b="A" cls="a" text={L("בחירה", "Choose")} />
        <Hint b="✥" cls="m" text={L("תזוזה", "Move")} />
        <Hint b="⧉+≡" cls="m" text={L("החזקה: יציאה", "Hold: leave")} />
      </footer>
    </main>
  );
}

/** The game helper: the game being played, short tips, a guide with spoilers hidden, a picture to ask about. */
function ConsoleGame() {
  const [chat, setChat] = useState<{ chatId: string; game: string } | null>(null);
  const [shot, setShot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const he = getLocale() === "he";
  const remote = isRemote();

  useEffect(() => {
    void api<{ chatId: string; game: string }>("/api/game-helper/open", { method: "POST" })
      .then((c) => {
        setChat(c);
        // A picture taken with the Game Helper key (Ctrl+Alt+G or a back button) waits for the next question.
        return api<{ waiting: string | null }>(`/api/game-helper/${encodeURIComponent(c.chatId)}`).then((w) => setShot(w.waiting));
      })
      .catch((e: Error) => toast(e.message));
  }, []);

  const ask = async (kind: GameAsk) => {
    if (!chat || busy) return;
    setBusy(true);
    try {
      let k = kind;
      if (kind === "shot" && !shot) {
        // No picture waits: take one now, on the PC (the phone cannot see the PC's game).
        const r = remote ? {} : await api<{ file?: string }>("/api/game-helper/capture", { method: "POST" }).catch(() => ({} as { file?: string }));
        if (r.file) setShot(r.file);
        else {
          toast(remote
            ? L("צילום המשחק עובד במחשב עצמו.", "A picture of the game works on the PC itself.")
            : L("המשחק לא בחזית. בתוך המשחק לוחצים Ctrl+Alt+G (או כפתור אחורי) כדי לשאול עם תמונה.", "The game is not in front. In the game, press Ctrl+Alt+G (or a back button) to ask with a picture."));
          k = "tip";
        }
      }
      const q = gamePrompt(k, chat.game, he);
      await api(`/api/conversations/${encodeURIComponent(chat.chatId)}/messages`, { method: "POST", body: { text: q.text, web: q.web } });
      // The server attaches the waiting picture to this message and it is used up.
      if (k === "shot") setShot(null);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // X: tips · Y: the picture · RB: the guide · B: back to the console home.
  useEffect(() => {
    const on = (e: Event) => {
      const b = (e as CustomEvent<string>).detail;
      const kind: GameAsk | undefined = b === "X" ? "tip" : b === "Y" ? "shot" : b === "RB" ? "guide" : undefined;
      if (kind) {
        e.preventDefault();
        void ask(kind);
      } else if (b === "B" && !document.querySelector('[role="dialog"]')) {
        e.preventDefault();
        location.hash = "#/console";
      }
    };
    window.addEventListener("kesher:pad-button", on);
    return () => window.removeEventListener("kesher:pad-button", on);
  });

  const ASKS: Array<{ kind: GameAsk; pad: string; cls: string; label: string }> = [
    { kind: "tip", pad: "X", cls: "x", label: L("טיפ קצר", "Quick tip") },
    { kind: "shot", pad: "Y", cls: "y", label: shot ? L("לשאול על התמונה", "Ask about the picture") : L("צילום ושאלה", "Screenshot and ask") },
    { kind: "guide", pad: "RB", cls: "lr", label: L("מדריך (ספוילרים מוסתרים)", "Guide (spoilers hidden)") },
  ];

  return (
    <main className="console console-game" aria-label={L("עוזר משחק", "Game helper")}>
      <header className="row console-head">
        <button type="button" className="console-back" onClick={() => (location.hash = "#/console")} aria-label={L("חזרה", "Back")}>
          <span className="pad-btn b" aria-hidden="true">B</span>
        </button>
        <span className="console-title grow" dir="auto">
          {chat?.game ? `🎮 ${chat.game}` : L("עוזר משחק", "Game helper")}
        </span>
      </header>
      {chat && !chat.game && <p className="muted">{L("לא זוהה משחק פתוח. אפשר לשאול בכל זאת.", "No running game found. You can still ask.")}</p>}
      <div className="row console-asks">
        {ASKS.map((q) => (
          <button key={q.kind} type="button" className="console-ask" disabled={!chat || busy} onClick={() => void ask(q.kind)}>
            <span className={`pad-btn ${q.cls}`} aria-hidden="true">{q.pad}</span>
            {q.label}
          </button>
        ))}
        {shot && chat && <img className="console-shot" src={`/api/game-helper/${encodeURIComponent(chat.chatId)}/shot/${encodeURIComponent(shot)}`} alt={L("התמונה מהמשחק שתישלח עם השאלה", "The picture of the game sent with the question")} />}
      </div>
      <div className="console-chat game-chat">{chat && <ConversationPage id={chat.chatId} />}</div>
      <footer className="console-hints" role="note" aria-label={L("כפתורי השלט", "Controller buttons")}>
        <Hint b="X" cls="x" text={L("טיפ", "Tip")} />
        <Hint b="Y" cls="y" text={L("תמונה", "Picture")} />
        <Hint b="RB" cls="lr" text={L("מדריך", "Guide")} />
        <Hint b="⧉" cls="m" text={L("כתיבה", "Type")} />
        <Hint b="R3" cls="m" text={L("דיבור", "Speak")} />
        <Hint b="B" cls="b" text={L("חזרה", "Back")} />
      </footer>
    </main>
  );
}

/** Settings → Keyboard and helpers: console mode on this device, and how to switch it with the controller. */
export function ConsoleModeSetting() {
  return (
    <section className="card stack">
      <h2>{L("מצב קונסולה", "Console mode")}</h2>
      <p className="muted small">
        {L("מסך מלא עם כפתורים גדולים לשלט (ROG Xbox Ally X, Steam Deck, מחשב בטלוויזיה), עם עוזר משחק. גם: החזקת ⧉ View ו-≡ Menu יחד.", "Full screen with big buttons for a controller (ROG Xbox Ally X, Steam Deck, a PC on the TV), with a game helper. Also: hold ⧉ View and ≡ Menu together.")}
      </p>
      <div className="row">
        <button type="button" className="primary" onClick={() => switchConsole(true)}>{L("למצב קונסולה", "Open console mode")}</button>
      </div>
    </section>
  );
}
