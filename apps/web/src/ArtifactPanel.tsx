import { lazy, Suspense, useEffect, useState } from "react";
import { CodeView } from "./ide/CodeView";
import { getLocale, he$ } from "./i18n";

const DesignBoard = lazy(() => import("./DesignBoard").then((m) => ({ default: m.DesignBoard })));

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/**
 * Artifacts (design ArtifactPanel, like Claude's): a page the model wrote in a ```html block opens live in a panel
 * beside the chat, with preview and code, its versions in this chat, reload, full screen and download.
 *
 * It runs in a sandboxed frame with no same-origin access (it cannot reach KesherAI, its files or the app key) and a
 * content policy that blocks the network: scripts and styles inside the page only, pictures from data: and blob:.
 */

/** Every page block seen, by a short key (the blocks on screen carry it as data-artifact). */
const known = new Map<string, string>();
let versions: string[] = [];
let current = -1;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => f());

/** A page block's key (the same text, the same key). */
export function artifactKey(code: string): string {
  let h = 5381;
  for (let i = 0; i < code.length; i++) h = ((h << 5) + h + code.charCodeAt(i)) | 0;
  const key = `a${(h >>> 0).toString(36)}${code.length.toString(36)}`;
  known.set(key, code);
  return key;
}

/** Opens the panel on a page block; its versions are the page blocks of this chat on screen, in order. */
export function openArtifact(code: string): void {
  const keys = [...new Set([...document.querySelectorAll<HTMLElement>("[data-artifact]")].map((e) => e.dataset.artifact!))];
  versions = keys.map((k) => known.get(k)).filter((c): c is string => !!c);
  if (!versions.includes(code)) versions.push(code);
  current = versions.indexOf(code);
  changed();
}

/** Whether a code block is a page worth opening live: a whole document, or a snippet with markup and some length. */
export function isArtifact(language: string | undefined, code: string): boolean {
  const lang = (language ?? "").toLowerCase();
  if (lang === "svg") return /<svg[\s>]/i.test(code);
  if (lang !== "html" && lang !== "htm") return false;
  return /<!doctype html|<html[\s>]/i.test(code) || (code.split("\n").length >= 6 && /<(div|canvas|body|script|style|button|svg|main|section)[\s>]/i.test(code));
}

const POLICY = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'">`;

/** The page as the frame gets it: the content policy first, before anything of the page. */
export function framed(given: string): string {
  // A refresh that would move the frame to another site goes (its address could carry the page's text out).
  const code = given.replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*>/gi, "");
  if (/^\s*<svg[\s>]/i.test(code)) return `<!doctype html><html><head>${POLICY}<style>html,body{margin:0;height:100%;display:grid;place-items:center;background:#fff}</style></head><body>${code}</body></html>`;
  if (/<head[^>]*>/i.test(code)) return code.replace(/<head[^>]*>/i, (m) => `${m}${POLICY}`);
  if (/<html[^>]*>/i.test(code)) return code.replace(/<html[^>]*>/i, (m) => `${m}<head>${POLICY}</head>`);
  return `<!doctype html><html><head><meta charset="utf-8">${POLICY}</head><body>${code}</body></html>`;
}

/** The panel; rendered once by the app, hidden until something opens it. */
export function ArtifactPanel() {
  const [, tick] = useState(0);
  const [tab, setTab] = useState<"preview" | "code" | "canvas">("preview");
  const [full, setFull] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    listeners.add(f);
    // Another chat or page: the panel closes.
    const away = () => {
      versions = [];
      current = -1;
      changed();
    };
    addEventListener("hashchange", away);
    return () => {
      listeners.delete(f);
      removeEventListener("hashchange", away);
    };
  }, []);
  useEffect(() => {
    document.body.classList.toggle("artifact-open", current >= 0);
  });
  if (current < 0 || !versions[current]) return null;
  const code = versions[current]!;
  const title = /<title>([^<]{1,80})<\/title>/i.exec(code)?.[1]?.trim() || L("דף מהצ'אט", "A page from the chat");
  const close = () => {
    current = -1;
    setFull(false);
    changed();
  };
  const download = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([code], { type: "text/html" }));
    a.download = `${title.replace(/[\\/:*?"<>|]+/g, "").slice(0, 60) || "page"}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <aside className={`artifact-panel${full ? " full" : ""}`} aria-label={title}>
      <div className="artifact-bar">
        <strong className="grow" dir="auto">{title}</strong>
        {versions.length > 1 && (
          <select value={current} onChange={(e) => { current = Number(e.target.value); changed(); }} aria-label={L("גרסה", "Version")}>
            {versions.map((_, i) => <option key={i} value={i}>{L(`גרסה ${i + 1}`, `Version ${i + 1}`)}</option>)}
          </select>
        )}
        <div className="artifact-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "preview"} className={tab === "preview" ? "on" : ""} onClick={() => setTab("preview")}>{L("תצוגה", "Preview")}</button>
          <button type="button" role="tab" aria-selected={tab === "code"} className={tab === "code" ? "on" : ""} onClick={() => setTab("code")}>{L("קוד", "Code")}</button>
          <button type="button" role="tab" aria-selected={tab === "canvas"} className={tab === "canvas" ? "on" : ""} onClick={() => { setTab("canvas"); setFull(true); }}>🎨 {L("קנבס", "Canvas")}</button>
        </div>
        <button type="button" className="ghost" title={L("טען מחדש", "Reload")} aria-label={L("טען מחדש", "Reload")} onClick={() => setReload((n) => n + 1)}>↻</button>
        <button type="button" className="ghost" title={L("מסך מלא", "Full screen")} aria-label={L("מסך מלא", "Full screen")} onClick={() => setFull((f) => !f)}>⛶</button>
        <button type="button" className="ghost" title={L("הורד HTML", "Download HTML")} aria-label={L("הורד HTML", "Download HTML")} onClick={download}>⬇</button>
        <button type="button" className="ghost" title={L("סגור", "Close")} aria-label={L("סגור", "Close")} onClick={close}>✕</button>
      </div>
      {tab === "canvas" ? (
        <Suspense fallback={<p className="muted small">…</p>}><DesignBoard screens={versions} onPick={(i) => { current = i; changed(); }} /></Suspense>
      ) : tab === "preview" ? (
        <iframe key={`${current}-${reload}`} className="artifact-frame" title={title} sandbox="allow-scripts allow-forms allow-modals" srcDoc={framed(code)} />
      ) : (
        <div className="artifact-code"><CodeView code={code} language="html" /></div>
      )}
      <p className="muted small artifact-note">{L("רץ בתיבה סגורה: בלי גישה לקבצים, לחשבונות או לרשת.", "Runs in a closed box: no access to files, accounts or the network.")}</p>
    </aside>
  );
}
