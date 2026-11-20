import { useEffect, useRef, useState } from "react";
import { api, isRemote, withToken } from "./api";
import { desktop } from "./library";
import { getLocale, he$ } from "./i18n";
import { SaveToCourse, type WebClip } from "./SaveToCourse";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

interface PaneTab {
  id: number;
  title: string;
  url: string;
  active: boolean;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
}
/** One action of the model's browser tools (browser-safety.ts BrowserAction). */
interface BrowserAction {
  at: string;
  tool: string;
  site?: string;
  target?: string;
  ok: boolean;
  note?: string;
}

/** What a browser tool did, in words ("Click", "Open"…). */
export function actionWord(tool: string): string {
  const words: Record<string, [string, string]> = {
    browser_tabs: ["רשימת לשוניות", "List tabs"],
    browser_read: ["קריאת הדף", "Read the page"],
    browser_snapshot: ["קריאת הדף", "Read the page"],
    browser_screenshot: ["צילום הדף", "Picture of the page"],
    browser_open: ["פתיחה", "Open"],
    browser_click: ["לחיצה", "Click"],
    browser_type: ["הקלדה", "Type"],
    browser_select: ["בחירה ברשימה", "Pick from a list"],
    browser_hover: ["ריחוף", "Hover"],
    browser_scroll: ["גלילה", "Scroll"],
    browser_press_key: ["מקשים", "Keys"],
    browser_navigate: ["ניווט", "Navigate"],
    browser_close_tab: ["סגירת לשונית", "Close a tab"],
    browser_wait: ["המתנה", "Wait"],
    browser_console: ["קריאת הקונסול", "Read the console"],
    browser_network: ["קריאת בקשות הרשת", "Read network requests"],
    browser_network_request: ["פרטי בקשת רשת", "Network request details"],
    browser_eval: ["הרצת קוד בדף", "Run code in the page"],
    browser_dialog: ["תשובה לחלון קופץ", "Answer a pop-up"],
    browser_upload: ["העלאת קובץ", "Upload a file"],
    browser_click_at: ["לחיצה בנקודה", "Click a point"],
    stop: ["נעצר", "Stopped"],
  };
  const w = words[tool];
  return w ? L(w[0], w[1]) : tool;
}

interface PaneState {
  tabs: PaneTab[];
  notice: string;
}

/**
 * The Browser pane beside a chat: KesherAI's own browser, which the model reads and acts on while you watch
 * (like Claude's browser pane).
 * - In the desktop app the page itself is drawn by the app over the area below the address bar.
 * - On the phone (or any other screen) the pane shows pictures of the computer's browser that refresh,
 *   and a tap on the picture is a click there.
 */
export function BrowserPanel() {
  // The pane is the computer's own app window; another computer's window or the phone sees pictures of it.
  const native = isRemote() ? undefined : desktop()?.browser;
  const [st, setSt] = useState<PaneState>({ tabs: [], notice: "" });
  const [error, setError] = useState("");
  const [clip, setClip] = useState<WebClip | null>(null);
  // "🎓 To course": the page in front (or what is selected on it) into a course (design SaveToCourse).
  const toCourse = async () => {
    setError("");
    try {
      const p = await api<WebClip>("/api/browser/pane/page");
      if (!(p.selection || p.text).trim()) return setError(L("בדף הזה אין טקסט לשמור.", "This page has no text to save."));
      setClip(p);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const [addr, setAddr] = useState("");
  const [editing, setEditing] = useState(false);
  const area = useRef<HTMLDivElement>(null);
  const [shot, setShot] = useState(0);
  const [noApp, setNoApp] = useState(false);
  const lastKey = useRef("");
  const ticks = useRef(0);
  const active = st.tabs.find((t) => t.active);
  // The model's actions here (the "doing now" strip, its log and the one Stop), read every 2 seconds.
  const [act, setAct] = useState<{ active: boolean; log: BrowserAction[] }>({ active: false, log: [] });
  const [logOpen, setLogOpen] = useState(false);
  useEffect(() => {
    let stop = false;
    const read = () => void api<{ active: boolean; log: BrowserAction[] }>("/api/browser/activity").then((a) => !stop && setAct(a), () => undefined);
    read();
    const tm = setInterval(() => !document.hidden && read(), 2000);
    return () => {
      stop = true;
      clearInterval(tm);
    };
  }, []);
  const lastAct = act.log.at(-1);
  const stopModel = () => void api("/api/browser/stop", { method: "POST" }).then(() => setAct((a) => ({ ...a, active: false })), (e: Error) => setError(e.message));

  // The tabs: pushed by the app on the computer, read every 2 seconds elsewhere.
  useEffect(() => {
    if (native) {
      void native.call("state").then((s) => s && !(s as { error?: string }).error && setSt(s as PaneState));
      return native.onState((s) => setSt(s as PaneState));
    }
    let stop = false;
    const read = () =>
      void api<PaneState>("/api/browser/pane").then(
        (s) => {
          if (stop) return;
          // A new picture when the page changed, and otherwise every third read (about 6 s): fewer pictures over
          // a phone's connection (security and performance scan 50).
          const key = JSON.stringify(s);
          ticks.current++;
          if (key !== lastKey.current || ticks.current % 3 === 0) setShot((n) => n + 1);
          lastKey.current = key;
          setSt(s);
          setError("");
        },
        (e: Error) => {
          if (stop) return;
          // No KesherAI app open on the computer: no pane to show (the server says so in English).
          if (/desktop app/.test(e.message)) setNoApp(true);
          else setError(e.message);
        },
      );
    read();
    const tm = setInterval(() => !document.hidden && read(), 2000);
    return () => {
      stop = true;
      clearInterval(tm);
    };
  }, [native]);

  useEffect(() => {
    if (!editing) setAddr(active?.url && active.url !== "about:blank" ? active.url : "");
  }, [active?.url, editing]);

  // Desktop: the app lays the page over this area; it follows the area's size and place, and goes away with it.
  useEffect(() => {
    if (!native || !area.current) return;
    const el = area.current;
    const send = () => {
      const r = el.getBoundingClientRect();
      void native.call("bounds", r.width > 20 && r.height > 20 ? { x: r.left, y: r.top, width: r.width, height: r.height } : null);
    };
    send();
    const ro = new ResizeObserver(send);
    ro.observe(el);
    addEventListener("resize", send);
    addEventListener("scroll", send, true);
    return () => {
      ro.disconnect();
      removeEventListener("resize", send);
      removeEventListener("scroll", send, true);
      void native.call("bounds", null);
    };
  }, [native, st.tabs.length > 0]);

  const cmd = async (c: string, arg?: unknown) => {
    setError("");
    try {
      if (native) {
        const r = (await native.call(c, arg)) as { error?: string } | undefined;
        if (r && typeof r === "object" && r.error) setError(r.error);
      } else {
        const body: Record<string, unknown> = { cmd: c };
        if (c === "go") body.url = arg;
        else if (c === "nav") body.what = arg;
        else if (c === "select" || c === "close") body.id = arg;
        await api("/api/browser/pane", { method: "POST", body });
        setTimeout(() => setShot((n) => n + 1), 600);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const tap = (e: React.MouseEvent<HTMLImageElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    void api("/api/browser/pane", { method: "POST", body: { cmd: "tap", x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height } })
      .then(() => setTimeout(() => setShot((n) => n + 1), 700))
      .catch((err: Error) => setError(err.message));
  };

  if (noApp)
    return (
      <section className="browser-pane" aria-label={L("דפדפן", "Browser")}>
        <p className="muted small browser-empty">{L("הדפדפן של KesherAI רץ באפליקציה במחשב. פתחו את KesherAI במחשב, והדפדפן שלו יופיע כאן.", "KesherAI's browser runs in the app on the computer. Open KesherAI there and its browser shows here.")}</p>
      </section>
    );

  return (
    <section className="browser-pane" aria-label={L("דפדפן", "Browser")}>
      <div className="browser-tabs" role="tablist">
        {st.tabs.map((t) => (
          <div key={t.id} className={`browser-tab${t.active ? " on" : ""}`} role="tab" aria-selected={t.active}>
            <button type="button" className="browser-tab-title" onClick={() => void cmd("select", t.id)} title={t.url}>
              {t.loading ? "⏳ " : ""}
              {t.title || L("לשונית חדשה", "New tab")}
            </button>
            <button type="button" className="icon-btn" aria-label={L("סגור לשונית", "Close tab")} onClick={() => void cmd("close", t.id)}>×</button>
          </div>
        ))}
        <button type="button" className="icon-btn" aria-label={L("לשונית חדשה", "New tab")} title={L("לשונית חדשה", "New tab")} onClick={() => void cmd("new")}>＋</button>
      </div>
      {/* Browser controls read left to right in every language, as in every browser. */}
      <form
        dir="ltr"
        className="browser-bar"
        onSubmit={(e) => {
          e.preventDefault();
          setEditing(false);
          if (addr.trim()) void cmd("go", addr.trim());
        }}
      >
        <button type="button" className="icon-btn" disabled={!active?.canBack} aria-label={L("אחורה", "Back")} onClick={() => void cmd("nav", "back")}>‹</button>
        <button type="button" className="icon-btn" disabled={!active?.canForward} aria-label={L("קדימה", "Forward")} onClick={() => void cmd("nav", "forward")}>›</button>
        <button type="button" className="icon-btn" disabled={!active} aria-label={active?.loading ? L("עצור", "Stop") : L("רענן", "Reload")} onClick={() => void cmd("nav", active?.loading ? "stop" : "reload")}>{active?.loading ? "✕" : "↻"}</button>
        <input dir="ltr" value={addr} onFocus={() => setEditing(true)} onBlur={() => setEditing(false)} onChange={(e) => setAddr(e.target.value)} placeholder={L("כתובת או חיפוש", "Address or search")} aria-label={L("כתובת", "Address")} />
        <button type="button" className="browser-to-course" disabled={!active} title={L("שמירת הדף, או מה שסימנת בו, לקורס", "Save the page, or what you selected on it, to a course")} onClick={() => void toCourse()}>🎓 {L("לקורס", "To course")}</button>
      </form>
      {st.notice && (
        <p className="muted small browser-notice">
          {st.notice} <button type="button" className="link" onClick={() => void cmd("dismiss")}>{L("הבנתי", "OK")}</button>
        </p>
      )}
      {(act.active || logOpen) && lastAct && (
        <div className={`browser-activity${act.active ? " on" : ""}`} role="status">
          <span className="grow" dir="auto">
            {act.active ? "🤖 " : ""}
            {actionWord(lastAct.tool)}
            {lastAct.target ? `: ${lastAct.target}` : ""}
            {lastAct.site ? ` · ${lastAct.site}` : ""}
          </span>
          {act.active && (
            <button type="button" className="danger" onClick={stopModel} title={L("עוצר את כל מה שהמודל וסוכני העזר עושים בדפדפן (גם Ctrl+Alt+Esc)", "Stops everything the model and its helpers do in the browser (also Ctrl+Alt+Esc)")}>
              ⏹ {L("עצור", "Stop")}
            </button>
          )}
          <button type="button" className="link" aria-expanded={logOpen} onClick={() => setLogOpen(!logOpen)}>{logOpen ? L("סגור יומן", "Hide log") : L("יומן", "Log")}</button>
        </div>
      )}
      {!act.active && !logOpen && act.log.length > 0 && (
        <button type="button" className="link small browser-log-open" onClick={() => setLogOpen(true)}>{L("יומן הפעולות של המודל", "The model's browser log")}</button>
      )}
      {logOpen && (
        <ol className="browser-log small" aria-label={L("יומן הפעולות של המודל בדפדפן", "The model's browser actions")}>
          {[...act.log].reverse().slice(0, 30).map((a, i) => (
            <li key={`${a.at}-${i}`} className={a.ok ? "" : "error"} dir="auto">
              <time className="muted" dir="ltr">{new Date(a.at).toLocaleTimeString(getLocale() === "he" ? "he-IL" : "en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time> {actionWord(a.tool)}
              {a.target ? `: ${a.target}` : ""}
              {a.site ? ` · ${a.site}` : ""}
              {a.note ? ` — ${a.note}` : ""}
            </li>
          ))}
        </ol>
      )}
      {error && <p className="error small">{error}</p>}
      {clip && <SaveToCourse clip={clip} onClose={() => setClip(null)} />}
      {!st.tabs.length ? (
        <div className="browser-empty muted small">
          <p>{L("הדפדפן של KesherAI: המודל יכול לפתוח כאן דפים, לקרוא אותם, ללחוץ ולהקליד — ואתם רואים כל צעד.", "KesherAI's browser: the model can open pages here, read them, click and type, and you see every step.")}</p>
          <p>{L("הוא נפרד מהדפדפן שלכם (בלי ההתחברויות שלכם), לא מקליד סיסמאות ולא מוריד קבצים. כתבו כתובת למעלה כדי להתחיל.", "It is separate from your own browser (none of your sign-ins), never types passwords and never downloads files. Type an address above to start.")}</p>
        </div>
      ) : native ? (
        <div ref={area} className="browser-area" />
      ) : (
        <div className="browser-area">
          {active && <img src={withToken(`/api/browser/pane/shot?n=${shot}`)} alt={active.title} onClick={tap} draggable={false} />}
        </div>
      )}
    </section>
  );
}
