import { lazy, Suspense, useEffect, useRef, useState, type ComponentType, type LazyExoticComponent, type PointerEvent as ReactPointerEvent } from "react";
import { isEditShortcut, type TextSpan } from "@kesher/shared";
import { CodeView } from "./ide/CodeView";
import type { PanelItem } from "./doc-items";
import { BUILT_IN, type SurfaceItem, type SurfacePanelProps } from "./surfaces";
import type { CanvasItem } from "./chat/canvas-items";
import { getLocale, he$ } from "./i18n";

const DesignBoard = lazy(() => import("./DesignBoard").then((m) => ({ default: m.DesignBoard })));
// A surface's panel (documents, sheets, decks, editors…; surfaces.ts), loaded the first time that surface opens.
const panels = new Map<string, LazyExoticComponent<ComponentType<SurfacePanelProps>>>();
function surfacePanel(id: string): { Panel: LazyExoticComponent<ComponentType<SurfacePanelProps>>; className: string } | undefined {
  const s = BUILT_IN.find((x) => x.id === id);
  if (!s) return undefined;
  if (!panels.has(id)) panels.set(id, lazy(s.panel));
  return { Panel: panels.get(id)!, className: s.panelClass ?? "" };
}
// Pictures, PBR map sets and code diffs (CanvasPanel.tsx, design ChatCanvas), loaded when first opened.
const CanvasPanel = lazy(() => import("./CanvasPanel").then((m) => ({ default: m.CanvasPanel })));
// "Edit with AI" on a selection in the code (SpanEdit.tsx), loaded when first used.
const SpanEdit = lazy(() => import("./SpanEdit").then((m) => ({ default: m.SpanEdit })));

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/**
 * Artifacts (design ArtifactPanel, like Claude's): a page the model wrote in a ```html block opens live in a panel
 * beside the chat, with preview and code, its versions in this chat, reload, full screen and download. Selecting part
 * of the code shows "Edit with AI" (SpanEdit.tsx): the model rewrites only that part, and the accepted change becomes
 * the panel's newest version (kept while the panel is open, like the other versions it lists).
 *
 * It runs in a sandboxed frame with no same-origin access (it cannot reach KesherAI, its files or the app key) and a
 * content policy that blocks the network: scripts and styles inside the page only, pictures from data: and blob:.
 *
 * The same panel shows a document, sheet or slide deck a tool wrote (DocPanel.tsx, design DocPanel). On a wide
 * screen it sits beside the chat and its edge drags to resize it; under 1100 px it is a full-screen sheet with
 * "Back to chat".
 */

/** Every page block seen, by a short key (the blocks on screen carry it as data-artifact). */
const known = new Map<string, string>();
let versions: string[] = [];
/**
 * Set when "Edit this" in the code adds a version: that version (`at`) is shown under the key of the one before it
 * (`from`), so the Code tab stays mounted and its "Saved · Undo" bar stays on screen.
 */
let accepted: { at: number; from: number } | null = null;
let current = -1;
/** The item open in a surface's panel (a document, sheet, deck, an editor's file…), if any. */
let item: SurfaceItem | null = null;
/** The picture, PBR set or diff open in the panel (the side canvas), if any. */
let media: CanvasItem | null = null;
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
  media = null;
  if (!versions.includes(code)) versions.push(code);
  current = versions.indexOf(code);
  accepted = null;
  item = null;
  changed();
}

/**
 * Opens the panel on a document, sheet or slide deck (a chat card's Open, or a tool's edit while the model works).
 *
 * @param p - The item: its kind, id, the chat it was opened from and its title.
 */
export function openItem(p: PanelItem): void {
  openSurface({ surface: p.kind, ...p });
}

/**
 * Opens the panel on an item of a chat surface (surfaces.ts): a card's Open, a file's "Open in chat", or the agent's
 * `open_in_chat`. On the phone the panel is full screen.
 *
 * @param p - The item and the surface that shows it.
 */
export function openSurface(p: SurfaceItem): void {
  item = p;
  media = null;
  versions = [];
  accepted = null;
  current = -1;
  changed();
}

/**
 * Opens the side canvas on a picture (zoom, compare, history), a PBR map set (the maps and a lit sphere) or a code
 * diff (its versions in this chat).
 *
 * @param m - What to show, with its versions.
 */
export function openCanvas(m: CanvasItem): void {
  media = m;
  item = null;
  versions = [];
  accepted = null;
  current = -1;
  changed();
}

/** Closes the panel (✕, or "Back to chat" on the phone). */
export function closePanel(): void {
  item = null;
  media = null;
  current = -1;
  changed();
}

const WIDTH_KEY = "kesher.artifactWidth";

/** Sets the panel's width (a wide screen only), kept for next time; the chat beside it moves over with it. */
function setWidth(px: number | null): void {
  const root = document.documentElement.style;
  if (px === null) root.removeProperty("--artifact-w");
  else root.setProperty("--artifact-w", `${Math.round(px)}px`);
}

/** The panel's edge: dragging it resizes the panel (between 320 px and 85% of the window); a double click resets. */
function ResizeEdge() {
  useEffect(() => {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    if (saved > 0) setWidth(Math.min(saved, innerWidth * 0.85));
  }, []);
  const start = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const edge = e.currentTarget;
    edge.setPointerCapture(e.pointerId);
    // The panel sits at the inline end: on the right in English, on the left in Hebrew.
    const rtl = getComputedStyle(edge).direction === "rtl";
    let w = 0;
    const move = (ev: PointerEvent) => {
      w = Math.max(320, Math.min(innerWidth * 0.85, (rtl ? ev.clientX : innerWidth - ev.clientX) - 8));
      setWidth(w);
    };
    const end = () => {
      edge.removeEventListener("pointermove", move);
      edge.removeEventListener("pointerup", end);
      edge.removeEventListener("pointercancel", end);
      if (w) localStorage.setItem(WIDTH_KEY, String(Math.round(w)));
    };
    edge.addEventListener("pointermove", move);
    edge.addEventListener("pointerup", end);
    edge.addEventListener("pointercancel", end);
  };
  const reset = () => {
    localStorage.removeItem(WIDTH_KEY);
    setWidth(null);
  };
  return <div className="artifact-resize" role="separator" aria-orientation="vertical" aria-label={L("גרירה לשינוי הרוחב", "Drag to resize")} onPointerDown={start} onDoubleClick={reset} />;
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
      accepted = null;
      current = -1;
      item = null;
      media = null;
      changed();
    };
    addEventListener("hashchange", away);
    return () => {
      listeners.delete(f);
      removeEventListener("hashchange", away);
    };
  }, []);
  useEffect(() => {
    document.body.classList.toggle("artifact-open", current >= 0 || !!item || !!media);
  });
  if (media) {
    return (
      <aside className={`artifact-panel canvas-panel${full ? " full" : ""}`} aria-label={L("קנבס צד", "Side canvas")}>
        <ResizeEdge />
        <Suspense fallback={<p className="muted small">…</p>}><CanvasPanel item={media} full={full} onFull={() => setFull((f) => !f)} onClose={() => { setFull(false); closePanel(); }} /></Suspense>
      </aside>
    );
  }
  const surface = item ? surfacePanel(item.surface) : undefined;
  if (item && surface) {
    const { Panel, className } = surface;
    return (
      <aside className={`artifact-panel ${className}${full ? " full" : ""}`} aria-label={item.title || L("פריט מהצ'אט", "An item from the chat")}>
        <ResizeEdge />
        <Suspense fallback={<p className="muted small">…</p>}><Panel key={`${item.surface}:${item.id}`} item={item} full={full} onFull={() => setFull((f) => !f)} /></Suspense>
      </aside>
    );
  }
  if (current < 0 || !versions[current]) return null;
  const code = versions[current]!;
  const title = /<title>([^<]{1,80})<\/title>/i.exec(code)?.[1]?.trim() || L("דף מהצ'אט", "A page from the chat");
  const close = () => {
    setFull(false);
    closePanel();
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
      <ResizeEdge />
      <div className="artifact-bar">
        <button type="button" className="ghost artifact-back" onClick={close}>‹ {L("חזרה לצ'אט", "Back to chat")}</button>
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
        <button type="button" className="ghost artifact-close" title={L("סגור", "Close")} aria-label={L("סגור", "Close")} onClick={close}>✕</button>
      </div>
      {tab === "canvas" ? (
        <Suspense fallback={<p className="muted small">…</p>}><DesignBoard screens={versions} onPick={(i) => { current = i; changed(); }} /></Suspense>
      ) : tab === "preview" ? (
        <iframe key={`${current}-${reload}`} className="artifact-frame" title={title} sandbox="allow-scripts allow-forms allow-modals" srcDoc={framed(code)} />
      ) : (
        <CodeTab key={accepted && current === accepted.at ? accepted.from : current} code={code} title={title} />
      )}
      <p className="muted small artifact-note">{L("רץ בתיבה סגורה: בלי גישה לקבצים, לחשבונות או לרשת.", "Runs in a closed box: no access to files, accounts or the network.")}</p>
    </aside>
  );
}

/**
 * The Code tab: the page's code, and "Edit with AI" on a selection in it. On the computer a mouse up shows the bubble,
 * on the phone the selection handles do (selectionchange). An accepted change is added as the newest version.
 */
function CodeTab({ code, title }: { code: string; title: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [span, setSpan] = useState<TextSpan | null>(null);
  const pick = () => {
    const s = getSelection();
    const el = box.current?.querySelector("code");
    if (!s || s.isCollapsed || !el || !s.rangeCount) return;
    const r = s.getRangeAt(0);
    if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return;
    void import("./SpanEdit").then(({ textOffset }) => {
      const start = textOffset(el, r.startContainer, r.startOffset);
      const end = textOffset(el, r.endContainer, r.endOffset);
      if (end > start && code.slice(start, end).trim()) setSpan({ start, end });
    });
  };
  useEffect(() => {
    const onChange = () => {
      if (matchMedia("(pointer: coarse)").matches) pick();
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  });
  const accept = (next: string) => {
    const from = accepted && accepted.at === current ? accepted.from : current;
    versions.push(next);
    current = versions.length - 1;
    accepted = { at: current, from };
    changed();
  };
  // Ctrl/Cmd+K on a selection in the code opens "Edit this" (the bubble mounts, then opens its box at once).
  const [askAt, setAskAt] = useState(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = getSelection()?.anchorNode;
      if (!isEditShortcut(e) || !a || !box.current?.contains(a)) return;
      e.preventDefault();
      pick();
      setAskAt(Date.now());
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  return (
    <>
      <div className="artifact-code" ref={box} onMouseUp={pick} onTouchEnd={pick}><CodeView code={code} language="html" /></div>
      {span && (
        <Suspense fallback={null}>
          <SpanEdit key={`${span.start}-${span.end}`} source={code} span={span} kind="code" language="html" title={title} askAt={askAt} onAccept={accept} onClose={() => { setSpan(null); getSelection()?.removeAllRanges(); }} />
        </Suspense>
      )}
    </>
  );
}
