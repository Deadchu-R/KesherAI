import { useEffect, useRef, useState } from "react";
import { api, isRemote, withToken } from "./api";
import { desktop } from "./library";
import { getLocale } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface PaneTab {
  id: number;
  title: string;
  url: string;
  active: boolean;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
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
export function BrowserPanel({ onClose }: { onClose: () => void }) {
  // The pane is the computer's own app window; another computer's window or the phone sees pictures of it.
  const native = isRemote() ? undefined : desktop()?.browser;
  const [st, setSt] = useState<PaneState>({ tabs: [], notice: "" });
  const [error, setError] = useState("");
  const [addr, setAddr] = useState("");
  const [editing, setEditing] = useState(false);
  const area = useRef<HTMLDivElement>(null);
  const [shot, setShot] = useState(0);
  const active = st.tabs.find((t) => t.active);

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
          setSt(s);
          setError("");
          setShot((n) => n + 1);
        },
        (e: Error) => !stop && setError(e.message),
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
        <span className="grow" />
        <button type="button" className="icon-btn" aria-label={L("סגור את הדפדפן", "Close the browser")} onClick={onClose}>✕</button>
      </div>
      <form
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
      </form>
      {st.notice && (
        <p className="muted small browser-notice">
          {st.notice} <button type="button" className="link" onClick={() => void cmd("dismiss")}>{L("הבנתי", "OK")}</button>
        </p>
      )}
      {error && <p className="error small">{error}</p>}
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
