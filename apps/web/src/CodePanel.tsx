import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent } from "@kesher/shared";
import { api } from "./api";
import { closePanel, openSurface } from "./ArtifactPanel";
import { afterDecision, askMessage, buildFileTree, diffPath, diffStats, findInText, highlightLines, outlineOf, pairRows, parseDiff, rejectHunk, type Hunk, type TreeNode } from "./code-surface";
import { getLocale, he$ } from "./i18n";
import { languageOf } from "./ide/languages";
import { toast } from "./library";
import type { SurfaceCardProps, SurfacePanelProps } from "./surfaces";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
/** Monaco, the full editor: its chunk loads only when the user presses Edit on a computer. */
const CodeEditor = lazy(() => import("./ide/CodeEditor"));
const narrow = () => matchMedia("(max-width: 700px)").matches;

/** One open file: its text on disk, and what the user typed since (undefined: not edited). */
interface Doc { text: string; draft?: string; error?: string }
type Side = "tree" | "outline" | "search" | null;

/** The chat's name for a file: its last path part. */
const base = (p: string) => p.split("/").pop() ?? p;

/**
 * The card of a code file in the message: its name, language and "+12 -3" lines against the version before, and Open.
 *
 * @param props - `item` (path and the step's diff), `live`: the model is still working.
 */
export function CodeCard({ item }: SurfaceCardProps) {
  const path = item.path ?? item.id;
  const st = item.diff ? diffStats(parseDiff(item.diff)) : undefined;
  return (
    <button type="button" className="item-card code-card" onClick={() => openSurface(item)} aria-label={`${L("פתיחה", "Open")}: ${base(path)}`}>
      <span className="item-card-text">
        <strong dir="ltr">{base(path)}</strong>
        <small className="muted" dir="ltr">{languageOf(path)} · {path}</small>
      </span>
      {st && <span className="code-stat" dir="ltr"><b className="plus">+{st.added}</b> <b className="minus">−{st.removed}</b></span>}
      <span className="item-card-open">{L("פתיחה", "Open")} ›</span>
    </button>
  );
}

/**
 * The code surface (like Rider, in the chat): tabs of open files, the work folder's tree, an outline, search in the
 * file and the folder, coloured reading, the agent's changes as a diff with Accept / Reject per hunk, editing by hand
 * (Monaco on a computer, a plain text box on a phone; Ctrl+S saves), and "Ask about this" on selected lines.
 *
 * @param props - `item`: the file (and the step's diff); `full` and `onFull`: the panel's full-screen state.
 */
export function CodePanel({ item, full, onFull }: SurfacePanelProps) {
  const conv = item.convId ?? "";
  const first = item.path ?? item.id;
  const root = `/api/conversations/${encodeURIComponent(conv)}/files`;
  const [tabs, setTabs] = useState([first]);
  const [cur, setCur] = useState(first);
  const [docs, setDocs] = useState<Record<string, Doc>>({});
  const [files, setFiles] = useState<string[]>([]);
  const [hunks, setHunks] = useState<Record<string, Hunk[]>>(() => (item.diff ? { [diffPath(item.diff) ?? first]: parseDiff(item.diff) } : {}));
  const [view, setView] = useState<"code" | "diff">(item.diff ? "diff" : "code");
  const [editing, setEditing] = useState(false);
  const [side, setSide] = useState<Side>(() => (narrow() || item.diff ? null : "tree"));
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [jump, setJump] = useState({ line: 0, n: 0 });
  const [q, setQ] = useState("");
  const [folderSearch, setFolderSearch] = useState(false);
  const [hits, setHits] = useState<Array<{ path: string; line: number; text: string }>>([]);
  const [pick, setPick] = useState<{ from: number; to: number; text: string } | null>(null);
  const [ask, setAsk] = useState("");
  const [wide, setWide] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const doc = docs[cur];
  const language = languageOf(cur);
  const text = doc?.draft ?? doc?.text ?? "";
  const dirty = (p: string) => docs[p]?.draft !== undefined && docs[p]!.draft !== docs[p]!.text;

  // The chat's folder, and the agent's changes in this chat (the diff of each file it wrote).
  useEffect(() => {
    void api<{ files: Array<{ path: string }> }>(root).then((d) => setFiles(d.files.map((f) => f.path)), () => undefined);
    void api<{ events?: AgentEvent[] }>(`/api/conversations/${encodeURIComponent(conv)}`).then((c) => {
      const mine: Record<string, Hunk[]> = {};
      for (const e of c.events ?? []) {
        const p = e.type === "tool_result" && e.diff ? diffPath(e.diff) : undefined;
        if (p && e.type === "tool_result" && e.diff) mine[p] = parseDiff(e.diff);
      }
      setHunks((h) => ({ ...mine, ...h }));
    }, () => undefined);
  }, [conv, root]);

  // A file's text, the first time its tab shows.
  useEffect(() => {
    if (docs[cur]) return;
    void api<{ text: string }>(`${root}/text?path=${encodeURIComponent(cur)}`).then(
      (d) => setDocs((x) => ({ ...x, [cur]: { text: d.text } })),
      (e: Error) => setDocs((x) => ({ ...x, [cur]: { text: "", error: e.message } })),
    );
  }, [cur, root, docs]);

  // Side by side when the panel is wide enough, inline on a phone.
  useEffect(() => {
    const el = body.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWide(el.clientWidth >= 560));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Search in the folder (the server finds the lines), after a short pause in typing.
  useEffect(() => {
    if (!folderSearch || q.trim().length < 2) {
      setHits([]);
      return;
    }
    const t = setTimeout(() => void api<{ hits: Array<{ path: string; line: number; text: string }> }>(`${root}/search?q=${encodeURIComponent(q.trim())}`).then((d) => setHits(d.hits), () => setHits([])), 250);
    return () => clearTimeout(t);
  }, [q, folderSearch, root]);

  // Scroll to the line of the outline or a search hit (reading view).
  useEffect(() => {
    if (!jump.line || editing || view !== "code") return;
    const row = body.current?.querySelector<HTMLElement>(`[data-line="${jump.line}"]`);
    row?.scrollIntoView({ block: "center" });
    row?.classList.add("code-flash");
    const t = setTimeout(() => row?.classList.remove("code-flash"), 1200);
    return () => clearTimeout(t);
  }, [jump, editing, view, doc?.text]);

  const openFile = (p: string, line = 0) => {
    setTabs((t) => (t.includes(p) ? t : [...t, p]));
    setCur(p);
    setEditing(false);
    setView(hunks[p]?.length && !line ? "diff" : "code");
    setPick(null);
    if (line) setJump((j) => ({ line, n: j.n + 1 }));
    if (narrow()) setSide(null);
  };
  const closeTab = (p: string) => {
    if (dirty(p) && !confirm(L("יש שינויים שלא נשמרו. לסגור?", "There are unsaved changes. Close?"))) return;
    const rest = tabs.filter((t) => t !== p);
    if (!rest.length) return closePanel();
    setTabs(rest);
    if (cur === p) setCur(rest.at(-1)!);
    setDocs((d) => {
      const { [p]: _gone, ...keep } = d;
      return keep;
    });
  };

  const save = useCallback(async (p: string, value: string): Promise<boolean> => {
    try {
      await api(`${root}/text`, { method: "PUT", body: { path: p, text: value } });
      setDocs((d) => ({ ...d, [p]: { text: value } }));
      return true;
    } catch (e) {
      toast((e as Error).message);
      return false;
    }
  }, [root]);
  const saveCurrent = useCallback(async () => {
    const d = docs[cur];
    if (!d || d.draft === undefined || d.draft === d.text) return;
    if (await save(cur, d.draft)) toast(L("נשמר", "Saved"));
  }, [docs, cur, save]);
  // Ctrl+S / Cmd+S anywhere in the panel.
  const onKey = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void saveCurrent();
    }
  };

  const decide = async (i: number, reject: boolean) => {
    const list = hunks[cur] ?? [];
    if (reject) {
      const next = rejectHunk(text, list[i]!);
      if (next === undefined) return toast(L("הקוד השתנה מאז, אי אפשר להחזיר את השינוי הזה.", "The code changed since, so this change cannot be put back."));
      if (!(await save(cur, next))) return;
    }
    setHunks((h) => ({ ...h, [cur]: afterDecision(list, i, reject) }));
  };

  /** The selected lines of the reading view, from the line numbers of the rows the selection touches. */
  const onSelect = () => {
    const s = getSelection();
    if (!s || s.isCollapsed || !body.current?.contains(s.anchorNode)) return setPick(null);
    const row = (n: Node | null) => Number((n instanceof Element ? n : n?.parentElement)?.closest<HTMLElement>("[data-line]")?.dataset.line);
    const a = row(s.anchorNode);
    const b = row(s.focusNode);
    if (!a || !b) return setPick(null);
    setPick({ from: Math.min(a, b), to: Math.max(a, b), text: s.toString() });
  };
  const sendAsk = async (change: boolean) => {
    if (!pick || !ask.trim()) return;
    try {
      await api(`/api/conversations/${encodeURIComponent(conv)}/messages`, { method: "POST", body: { text: askMessage({ path: cur, selection: pick.text, from: pick.from, to: pick.to, instruction: ask, change, he: getLocale() === "he" }) } });
      toast(L("נשלח לצ'אט", "Sent to the chat"));
      setAsk("");
      setPick(null);
      if (narrow()) closePanel();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const lines = useMemo(() => (doc && !editing ? highlightLines(text, language) : []), [doc, editing, text, language]);
  const outline = useMemo(() => outlineOf(doc?.text ?? "", language), [doc?.text, language]);
  const tree = useMemo(() => buildFileTree(files), [files]);
  const found = useMemo(() => (side === "search" && !folderSearch ? findInText(text, q) : []), [side, folderSearch, text, q]);
  const list = hunks[cur] ?? [];
  const toggleSide = (s: Exclude<Side, null>) => setSide((x) => (x === s ? null : s));
  const goTo = (line: number) => {
    if (view === "diff") setView("code");
    setJump((j) => ({ line, n: j.n + 1 }));
    if (narrow()) setSide(null);
  };

  return (
    <div className="code-sf" onKeyDown={onKey}>
      <div className="artifact-bar">
        <button type="button" className="ghost artifact-back" onClick={closePanel}>‹ {L("חזרה לצ'אט", "Back to chat")}</button>
        <strong className="grow" dir="ltr">{base(cur)}</strong>
        <span className="muted small artifact-wide-only">{language}</span>
        <button type="button" className="ghost artifact-wide-only" title={L("מסך מלא", "Full screen")} aria-label={L("מסך מלא", "Full screen")} aria-pressed={full} onClick={onFull}>⛶</button>
        <button type="button" className="ghost artifact-close" title={L("סגור", "Close")} aria-label={L("סגור", "Close")} onClick={closePanel}>✕</button>
      </div>
      <div className="code-sf-tabs" role="tablist" dir="ltr">
        {tabs.map((p) => (
          <span key={p} className={`code-sf-tab${p === cur ? " on" : ""}`}>
            <button type="button" role="tab" aria-selected={p === cur} onClick={() => openFile(p)} title={p}>{base(p)}{dirty(p) ? " ●" : ""}</button>
            <button type="button" className="code-sf-x" aria-label={`${L("סגירת לשונית", "Close tab")}: ${base(p)}`} onClick={() => closeTab(p)}>×</button>
          </span>
        ))}
      </div>
      <div className="code-sf-tools">
        <button type="button" className={`ghost${side === "tree" ? " on" : ""}`} aria-pressed={side === "tree"} onClick={() => toggleSide("tree")}>🗂 {L("קבצים", "Files")}</button>
        <button type="button" className={`ghost${side === "outline" ? " on" : ""}`} aria-pressed={side === "outline"} onClick={() => toggleSide("outline")}>☰ {L("מבנה", "Outline")}</button>
        <button type="button" className={`ghost${side === "search" ? " on" : ""}`} aria-pressed={side === "search"} onClick={() => toggleSide("search")}>🔍 {L("חיפוש", "Search")}</button>
        <span className="grow" />
        {!editing && list.length > 0 && (
          <span className="code-sf-seg" role="group">
            <button type="button" className={view === "code" ? "on" : ""} aria-pressed={view === "code"} onClick={() => setView("code")}>{L("קוד", "Code")}</button>
            <button type="button" className={view === "diff" ? "on" : ""} aria-pressed={view === "diff"} onClick={() => setView("diff")}>{L("שינויים", "Changes")} {list.length}</button>
          </span>
        )}
        {editing ? (
          <>
            <button type="button" className="primary" disabled={!dirty(cur)} onClick={() => void saveCurrent()}>{L("שמירה", "Save")}</button>
            <button type="button" className="ghost" onClick={() => { setDocs((d) => ({ ...d, [cur]: { text: d[cur]!.text } })); setEditing(false); }}>{L("ביטול", "Cancel")}</button>
          </>
        ) : (
          <button type="button" className="ghost" disabled={!doc || !!doc.error} onClick={() => { setEditing(true); setView("code"); }}>✎ {L("עריכה", "Edit")}</button>
        )}
      </div>
      <div className="code-sf-main">
        {side && (
          <nav className="code-sf-side" aria-label={L("צד הקוד", "Code sidebar")} dir="ltr">
            {side === "tree" && (files.length ? <Tree nodes={tree} open={open} cur={cur} onToggle={(p) => setOpen((s) => { const n = new Set(s); if (!n.delete(p)) n.add(p); return n; })} onOpen={openFile} depth={0} /> : <p className="muted small">{L("אין קבצים בתיקייה", "No files in the folder")}</p>)}
            {side === "outline" && (outline.length ? outline.map((s) => <button key={`${s.line}:${s.name}`} type="button" className="tree-row file" onClick={() => goTo(s.line)}><span className="code-kind">{s.kind[0]}</span> {s.name}<span className="muted code-ln-n">{s.line}</span></button>) : <p className="muted small">{L("אין מבנה לשפה הזאת", "No outline for this language")}</p>)}
            {side === "search" && (
              <div className="code-sf-search">
                <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L("חיפוש…", "Search…")} aria-label={L("חיפוש", "Search")} dir="auto" />
                <label className="small"><input type="checkbox" checked={folderSearch} onChange={(e) => setFolderSearch(e.target.checked)} /> {L("בכל התיקייה", "In the whole folder")}</label>
                {(folderSearch ? hits : found.map((f) => ({ path: cur, ...f }))).map((h) => (
                  <button key={`${h.path}:${h.line}`} type="button" className="tree-row file code-hit" onClick={() => openFile(h.path, h.line)}>
                    <span className="muted code-ln-n">{folderSearch ? `${base(h.path)}:${h.line}` : h.line}</span> {h.text}
                  </button>
                ))}
              </div>
            )}
          </nav>
        )}
        <div className="code-sf-body" ref={body} onMouseUp={onSelect} onTouchEnd={() => setTimeout(onSelect, 50)} dir="ltr">
          {!doc ? <p className="muted small">…</p> : doc.error ? <p className="muted small" role="alert">{doc.error}</p> : editing ? (
            narrow() ? (
              <textarea className="code-sf-text" value={text} spellCheck={false} dir="ltr" aria-label={cur} onChange={(e) => setDocs((d) => ({ ...d, [cur]: { ...d[cur]!, draft: e.target.value } }))} />
            ) : (
              <Suspense fallback={<p className="muted small">…</p>}>
                <CodeEditor path={cur} value={text} language={language} onChange={(v) => setDocs((d) => ({ ...d, [cur]: { ...d[cur]!, draft: v } }))} onSave={() => void saveCurrent()} jump={jump} />
              </Suspense>
            )
          ) : view === "diff" && list.length ? (
            <DiffView hunks={list} wide={wide} onDecide={(i, r) => void decide(i, r)} />
          ) : (
            <pre className="code-sf-pre">{lines.map((h, i) => <div key={i} className="code-row" data-line={i + 1}><span className="code-ln" aria-hidden>{i + 1}</span><span className="code-tx" dangerouslySetInnerHTML={{ __html: h || "&#8203;" }} /></div>)}</pre>
          )}
        </div>
      </div>
      {pick && !editing && (
        <div className="code-sf-ask" dir="auto">
          <small className="muted" dir="ltr">{cur}:{pick.from === pick.to ? pick.from : `${pick.from}-${pick.to}`}</small>
          <input value={ask} onChange={(e) => setAsk(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void sendAsk(false); }} placeholder={L("שאלו על השורות האלה…", "Ask about these lines…")} aria-label={L("שאלה על השורות שנבחרו", "Question about the selected lines")} />
          <button type="button" className="primary" disabled={!ask.trim()} onClick={() => void sendAsk(false)}>{L("שאלה", "Ask")}</button>
          <button type="button" className="ghost" disabled={!ask.trim()} onClick={() => void sendAsk(true)}>{L("לשנות רק את זה", "Change only this")}</button>
        </div>
      )}
    </div>
  );
}

/** The folder's tree: folders open and close, a file opens in a tab. */
function Tree({ nodes, open, cur, onToggle, onOpen, depth }: { nodes: TreeNode[]; open: Set<string>; cur: string; onToggle: (p: string) => void; onOpen: (p: string) => void; depth: number }) {
  return (
    <>
      {nodes.map((n) => n.children ? (
        <div key={n.path}>
          <button type="button" className="tree-row" style={{ paddingInlineStart: 8 + depth * 14 }} aria-expanded={open.has(n.path)} onClick={() => onToggle(n.path)}>
            <span className={`chev ${open.has(n.path) ? "down" : ""}`} aria-hidden /> {n.name}
          </button>
          {open.has(n.path) && <Tree nodes={n.children} open={open} cur={cur} onToggle={onToggle} onOpen={onOpen} depth={depth + 1} />}
        </div>
      ) : (
        <button key={n.path} type="button" className={`tree-row file${cur === n.path ? " on" : ""}`} style={{ paddingInlineStart: 22 + depth * 14 }} onClick={() => onOpen(n.path)}>{n.name}</button>
      ))}
    </>
  );
}

/** The agent's changes: side by side when wide, inline on a phone; Accept keeps a change, Reject puts it back. */
function DiffView({ hunks, wide, onDecide }: { hunks: Hunk[]; wide: boolean; onDecide: (i: number, reject: boolean) => void }) {
  return (
    <div className={`code-diff${wide ? " wide" : ""}`}>
      {hunks.map((h, i) => (
        <section key={`${h.newStart}:${i}`} className="code-hunk">
          <header>
            <span className="muted small" dir="ltr">@@ {h.newStart}</span>
            <span className="grow" />
            <button type="button" className="ghost" onClick={() => onDecide(i, false)}>✓ {L("אישור", "Accept")}</button>
            <button type="button" className="ghost" onClick={() => onDecide(i, true)}>↶ {L("החזרה", "Reject")}</button>
          </header>
          {wide ? pairRows(h).map((r, k) => (
            <div key={k} className="code-pair">
              <code className={`dl ${r.l?.t === "-" ? "del" : ""}`}>{r.l?.text ?? ""}</code>
              <code className={`dl ${r.r?.t === "+" ? "add" : ""}`}>{r.r?.text ?? ""}</code>
            </div>
          )) : h.lines.map((l, k) => <code key={k} className={`dl ${l.t === "+" ? "add" : l.t === "-" ? "del" : ""}`}><i aria-hidden>{l.t === " " ? "" : l.t}</i>{l.text}</code>)}
        </section>
      ))}
    </div>
  );
}
