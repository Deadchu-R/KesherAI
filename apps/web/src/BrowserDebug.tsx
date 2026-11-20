import { useEffect, useState } from "react";
import { api, withToken } from "./api";
import { getLocale, he$ } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** One console line (cdp.ts ConsoleEntry). */
interface ConsoleLine {
  at: number;
  level: string;
  text: string;
  where?: string;
}
/** One request in the list (sign-in values hidden by the server). */
interface Request {
  n: number;
  method: string;
  url: string;
  type?: string;
  status?: number;
  size?: number;
  failed?: string;
}
interface Emulation {
  device: "phone" | "desktop" | "none";
  scheme: "dark" | "light" | "auto";
}
interface DebugState {
  url: string;
  emulation: Emulation;
  picking: boolean;
  picked: boolean;
  recording: boolean;
  console: ConsoleLine[];
  network: Request[];
}
/** One element (cdp.ts InspectInfo). */
interface Inspected {
  tag: string;
  attributes: Record<string, string>;
  box: { x: number; y: number; width: number; height: number };
  styles: Record<string, string>;
  text: string;
  html: string;
  cut: boolean;
}
interface TryResult {
  errors: ConsoleLine[];
  failed: Array<{ n: number; method: string; url: string; status?: number; failed?: string }>;
  views: Array<{ device: "phone" | "desktop"; overflow: number; asset: string }>;
}

type Tab = "console" | "network" | "elements";

/**
 * The browser pane's Debug drawer (docs/research/browser-computer-control.md, Phase 3), for the tab in front of
 * KesherAI's own browser: Console, Network (sign-in headers hidden) and Elements (the page's tree; tap a line or pick on
 * the page to inspect an element, which the page highlights), the view (390 px phone, desktop, dark), "Try my change"
 * (reload, errors, pictures at 390 px and on a desktop) and recording a GIF. Works the same on the phone: there "Pick"
 * means the next tap on the page's picture.
 *
 * @param p.native - The pane is drawn by the desktop app here (pick by clicking the page itself).
 * @param p.picking - Phone pick mode: the next tap on the picture picks (the panel reports it as `pickAt`).
 * @param p.setPicking - Turns phone pick mode on or off.
 * @param p.pickAt - The last tap in phone pick mode, as fractions of the picture.
 */
export function BrowserDebug(p: { native: boolean; picking: boolean; setPicking: (on: boolean) => void; pickAt: { fx: number; fy: number; n: number } | null }) {
  const [tab, setTab] = useState<Tab>("console");
  const [st, setSt] = useState<DebugState | null>(null);
  const [error, setError] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [detail, setDetail] = useState<{ n: number; text: string } | null>(null);
  const [tree, setTree] = useState<string[] | null>(null);
  const [el, setEl] = useState<Inspected | null>(null);
  const [busy, setBusy] = useState("");
  const [tried, setTried] = useState<TryResult | null>(null);
  const [rec, setRec] = useState<{ asset: string; mimeType: string; note?: string } | null>(null);

  // Polls every 2 seconds while open and visible (one small request: state, console and network together).
  useEffect(() => {
    let stop = false;
    const read = () =>
      void api<DebugState>("/api/browser/debug").then(
        (s) => {
          if (stop) return;
          setSt(s);
          setError("");
        },
        (e: Error) => !stop && setError(e.message),
      );
    read();
    const tm = setInterval(() => !document.hidden && read(), 2000);
    return () => {
      stop = true;
      clearInterval(tm);
    };
  }, []);

  const run = async <T,>(what: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(what);
    setError("");
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setBusy("");
    }
  };
  const inspect = (body: Record<string, unknown>) => void run("inspect", async () => setEl(await api<Inspected>("/api/browser/debug/inspect", { method: "POST", body })));
  const loadTree = () => void run("elements", async () => setTree((await api<{ tree: string }>("/api/browser/debug/elements")).tree.split("\n")));

  // An element picked on the page (desktop) or tapped on the picture (phone) opens in Elements (only on a new pick).
  useEffect(() => {
    if (st?.picked && !st.picking && tab === "elements" && busy !== "inspect") inspect({ picked: true });
  }, [st?.picked, st?.picking]);
  useEffect(() => {
    if (p.pickAt) {
      setTab("elements");
      inspect({ fx: p.pickAt.fx, fy: p.pickAt.fy });
    }
  }, [p.pickAt?.n]);
  useEffect(() => {
    if (tab === "elements" && !tree) loadTree();
  }, [tab]);

  const emulate = (body: Partial<Emulation>) => void run("view", async () => {
    const e = await api<Emulation>("/api/browser/debug/emulate", { method: "POST", body });
    setSt((s) => (s ? { ...s, emulation: e } : s));
  });
  const pick = () => {
    if (!p.native) return p.setPicking(!p.picking);
    void run("pick", () => api("/api/browser/debug/pick", { method: "POST", body: { on: !st?.picking } }));
  };
  const pickingNow = p.native ? !!st?.picking : p.picking;

  const lines = (st?.console ?? []).filter((l) => !errorsOnly || l.level === "error" || l.level === "warn" || l.level === "assert");
  const errorCount = (st?.console ?? []).filter((l) => l.level === "error").length;
  const failedCount = (st?.network ?? []).filter((r) => r.failed || (r.status ?? 0) >= 400).length;
  const view = st?.emulation ?? { device: "none", scheme: "auto" };

  return (
    <section className="browser-debug" aria-label={L("ניפוי באגים", "Debug")}>
      <div className="browser-debug-tools">
        <div className="browser-debug-seg" role="tablist" aria-label={L("לשוניות ניפוי", "Debug tabs")}>
          <button type="button" role="tab" aria-selected={tab === "console"} className={tab === "console" ? "on" : ""} onClick={() => setTab("console")}>
            {L("קונסול", "Console")}
            {errorCount > 0 && <span className="pill bad">{errorCount}</span>}
          </button>
          <button type="button" role="tab" aria-selected={tab === "network"} className={tab === "network" ? "on" : ""} onClick={() => setTab("network")}>
            {L("רשת", "Network")}
            {failedCount > 0 && <span className="pill bad">{failedCount}</span>}
          </button>
          <button type="button" role="tab" aria-selected={tab === "elements"} className={tab === "elements" ? "on" : ""} onClick={() => setTab("elements")}>
            {L("רכיבים", "Elements")}
          </button>
        </div>
        <div className="browser-debug-seg" role="group" aria-label={L("תצוגה", "View")}>
          <button type="button" aria-pressed={view.device === "phone"} className={view.device === "phone" ? "on" : ""} onClick={() => emulate({ device: view.device === "phone" ? "none" : "phone" })} title={L("הדף בטלפון ברוחב 390 פיקסלים", "The page on a 390 px phone")}>
            📱 390
          </button>
          <button type="button" aria-pressed={view.device === "desktop"} className={view.device === "desktop" ? "on" : ""} onClick={() => emulate({ device: view.device === "desktop" ? "none" : "desktop" })} title={L("הדף במחשב ברוחב 1280 פיקסלים", "The page on a 1280 px desktop")}>
            🖥 {L("מחשב", "Desktop")}
          </button>
          <button type="button" aria-pressed={view.scheme === "dark"} className={view.scheme === "dark" ? "on" : ""} onClick={() => emulate({ scheme: view.scheme === "dark" ? "auto" : "dark" })} title={L("הדף בצבעים כהים", "The page in dark colors")}>
            🌙 {L("כהה", "Dark")}
          </button>
        </div>
        <div className="browser-debug-actions">
          <button type="button" disabled={!!busy} onClick={() => void run("try", async () => setTried(await api<TryResult>("/api/browser/debug/try", { method: "POST" })))} title={L("טעינה מחדש, ואז שגיאות ותמונות של הדף ב-390 פיקסלים ובמחשב", "Reload, then errors and pictures of the page at 390 px and on a desktop")}>
            {busy === "try" ? "⏳" : "▶"} {L("נסה את השינוי", "Try my change")}
          </button>
          <button
            type="button"
            className={st?.recording ? "danger" : ""}
            disabled={busy === "record"}
            onClick={() =>
              void run("record", async () => {
                const r = await api<{ recording: boolean; asset?: string; mimeType?: string; note?: string }>("/api/browser/debug/record", { method: "POST", body: { action: st?.recording ? "stop" : "start" } });
                setSt((s) => (s ? { ...s, recording: r.recording } : s));
                if (r.asset) setRec({ asset: r.asset, mimeType: r.mimeType ?? "image/gif", ...(r.note ? { note: r.note } : {}) });
              })
            }
          >
            {st?.recording ? `⏹ ${L("עצור הקלטה", "Stop recording")}` : `⏺ ${L("הקלט GIF", "Record GIF")}`}
          </button>
        </div>
      </div>

      {error && <p className="error small" dir="auto">{error}</p>}

      {tried && (
        <div className="browser-debug-try">
          <p className="small" dir="auto">
            {tried.errors.length ? `⚠️ ${L(`${tried.errors.length} שגיאות ואזהרות בקונסול`, `${tried.errors.length} console errors and warnings`)}` : `✅ ${L("אין שגיאות בקונסול", "No console errors")}`}
            {" · "}
            {tried.failed.length ? `⚠️ ${L(`${tried.failed.length} בקשות נכשלו`, `${tried.failed.length} failed requests`)}` : `✅ ${L("כל הבקשות הצליחו", "All requests succeeded")}`}
            {" "}
            <button type="button" className="link" onClick={() => setTried(null)}>{L("סגור", "Close")}</button>
          </p>
          <div className="browser-debug-views">
            {tried.views.map((v) => (
              <figure key={v.device}>
                <a href={withToken(`/api/assets/${v.asset}`)} target="_blank" rel="noreferrer">
                  <img src={withToken(`/api/assets/${v.asset}`)} alt={v.device === "phone" ? L("הדף ב-390 פיקסלים", "The page at 390 px") : L("הדף במחשב", "The page on a desktop")} />
                </a>
                <figcaption className="small" dir="auto">
                  {v.device === "phone" ? L("טלפון, 390", "Phone, 390") : L("מחשב, 1280", "Desktop, 1280")}
                  {" · "}
                  {v.overflow ? `⚠️ ${L(`רחב מהמסך ב-${v.overflow} פיקסלים (גלילה הצידה או טקסט חתוך)`, `${v.overflow} px wider than the screen (side scroll or cut text)`)}` : L("נכנס ברוחב", "Fits the width")}
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      )}

      {rec && (
        <div className="browser-debug-try">
          {rec.note && <p className="muted small">{L("FFmpeg לא מותקן במחשב, אז ההקלטה נשמרה כ-GIF.", "FFmpeg is not on this computer, so the recording is a GIF.")}</p>}
          {rec.mimeType.startsWith("video/") ? <video src={withToken(`/api/assets/${rec.asset}`)} controls muted playsInline /> : <img src={withToken(`/api/assets/${rec.asset}`)} alt={L("ההקלטה", "The recording")} />}
          <p className="small">
            <a href={withToken(`/api/assets/${rec.asset}`)} download>{L("הורדה", "Download")}</a>{" "}
            <button type="button" className="link" onClick={() => setRec(null)}>{L("סגור", "Close")}</button>
          </p>
        </div>
      )}

      {tab === "console" && (
        <div className="browser-debug-body">
          <div className="browser-debug-row">
            <label className="small">
              <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} /> {L("רק שגיאות ואזהרות", "Errors and warnings only")}
            </label>
            <button type="button" className="link small" onClick={() => void run("clear", () => api("/api/browser/debug/clear", { method: "POST" }))}>{L("נקה", "Clear")}</button>
          </div>
          <ol className="browser-debug-list" dir="ltr">
            {lines.length ? (
              lines.slice(-200).map((l, i) => (
                <li key={`${l.at}-${i}`} className={`lvl-${l.level}`}>
                  <span className="mono">{l.text}</span>
                  {l.where && <span className="muted"> {l.where}</span>}
                </li>
              ))
            ) : (
              <li className="muted" dir="auto">{L("הקונסול ריק.", "The console is empty.")}</li>
            )}
          </ol>
        </div>
      )}

      {tab === "network" && (
        <div className="browser-debug-body">
          {detail ? (
            <>
              <p className="small">
                <button type="button" className="link" onClick={() => setDetail(null)}>‹ {L("לרשימה", "Back to the list")}</button>
                <span className="muted" dir="auto"> {L("כותרות התחברות וערכים סודיים מוסתרים.", "Sign-in headers and secret values are hidden.")}</span>
              </p>
              <pre className="browser-debug-pre" dir="ltr">{detail.text}</pre>
            </>
          ) : (
            <ol className="browser-debug-list" dir="ltr">
              {(st?.network ?? []).length ? (
                [...(st?.network ?? [])].reverse().map((r) => (
                  <li key={r.n} className={r.failed || (r.status ?? 0) >= 400 ? "lvl-error" : ""}>
                    <button type="button" className="link" onClick={() => void run("request", async () => setDetail({ n: r.n, text: (await api<{ text: string }>(`/api/browser/debug/request?n=${r.n}`)).text }))}>
                      <span className="mono">
                        {r.method} {r.failed ? "✕" : r.status ?? "…"}
                      </span>{" "}
                      {r.url}
                      {r.type ? <span className="muted"> · {r.type}</span> : null}
                      {r.size !== undefined ? <span className="muted"> · {Math.round(r.size / 102.4) / 10} KB</span> : null}
                    </button>
                  </li>
                ))
              ) : (
                <li className="muted" dir="auto">{L("אין בקשות עדיין.", "No requests yet.")}</li>
              )}
            </ol>
          )}
        </div>
      )}

      {tab === "elements" && (
        <div className="browser-debug-body">
          <div className="browser-debug-row">
            <button type="button" aria-pressed={pickingNow} className={pickingNow ? "on" : ""} onClick={pick}>
              🎯 {pickingNow ? (p.native ? L("לחצו על רכיב בדף…", "Click an element on the page…") : L("הקישו על רכיב בתמונה…", "Tap an element in the picture…")) : L("בחירה מהדף", "Pick on the page")}
            </button>
            <button type="button" className="link small" onClick={loadTree}>{busy === "elements" ? "⏳" : "↻"} {L("רענן", "Refresh")}</button>
          </div>
          {el && (
            <div className="browser-debug-el" dir="ltr">
              <p className="mono">
                &lt;{el.tag}
                {Object.entries(el.attributes).slice(0, 8).map(([k, v]) => ` ${k}="${v.slice(0, 60)}"`).join("")}&gt;
              </p>
              <p className="small">
                {el.box.width}×{el.box.height} px @ {el.box.x},{el.box.y}
              </p>
              {el.cut && <p className="small error" dir="auto">⚠️ {L("התוכן גדול מהתיבה ונחתך (טקסט חתוך?)", "Its content is bigger than its box and is cut off (cut text?)")}</p>}
              <dl className="browser-debug-styles small">
                {Object.entries(el.styles).map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
              <details className="small">
                <summary dir="auto">HTML</summary>
                <pre className="browser-debug-pre">{el.html}</pre>
              </details>
              <button type="button" className="link small" onClick={() => setEl(null)} dir="auto">{L("סגור", "Close")}</button>
            </div>
          )}
          <ol className="browser-debug-list browser-debug-tree" dir="ltr">
            {(tree ?? []).map((line, i) => {
              const ref = /\[ref=(e\d+)\]/.exec(line)?.[1];
              const depth = (/^ */.exec(line)?.[0].length ?? 0) / 2;
              const text = line.trim().replace(/ \[ref=e\d+\]/, "");
              return (
                <li key={i} style={{ paddingInlineStart: `${Math.min(depth, 12) * 10}px` }}>
                  {ref ? (
                    <button type="button" className="link" onClick={() => inspect({ ref })}>
                      {text}
                    </button>
                  ) : (
                    <span className="muted">{text}</span>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </section>
  );
}
