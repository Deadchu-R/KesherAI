import { useCallback, useEffect, useRef, useState } from "react";
import { addr, computeSheet, docxFiles, fenceAt, isEditShortcut, locateSpan, sheetCsv, showValue, xlsxFiles, type Deck, type Sheet, type TextSpan } from "@kesher/shared";
import { api, withToken } from "./api";
import { closePanel, openItem } from "./ArtifactPanel";
import { ITEM_KINDS, selectionMessage, type ItemKind, type PanelItem } from "./doc-items";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";
import { RichText } from "./RichText";
import { SpanEdit } from "./SpanEdit";
import { DocsPage, printDoc, saveOffice } from "./pages/DocsPage";
import { SheetsPage } from "./pages/SheetsPage";
import { downloadPptx, printDeckPdf, SlidesPage, SlideView } from "./pages/SlidesPage";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/*
 * Documents, sheets and slide decks beside the chat (design DocPanel, like Claude's artifacts and ChatGPT's canvas):
 * a tool's edit shows as a compact card in the chat, and the item opens in the side panel (desktop) or a full-screen
 * sheet with a back button (phone). The panel shows it live (it follows the model's next edits), its versions (view
 * an older one, restore it), Edit (the item's own editor inside the panel), "Open full page" and the downloads the
 * editors have. Selecting text in a document shows an "Edit with AI" bubble (SpanEdit.tsx): the model rewrites only that
 * span, shown as a diff to accept; elsewhere (or when the span cannot be found) a small box asks the chat about the part.
 * Everything goes through the server's API, so the phone connected to the PC works the same.
 */

/** A version as the server keeps it: its revision, time and number, and the item's fields then. */
type Version = { rev: number; at: string; ver?: number } & Record<string, unknown>;
/** An item as the server sends it (a Doc, Sheet or Deck), with the fields the panel reads. */
type Loaded = { id: string; title: string; rev: number; ver?: number; convId?: string; versions?: Version[] } & Record<string, unknown>;

/** Each kind's name, for the card and the panel. */
const KIND_NAME: Record<ItemKind, [string, string]> = { doc: ["מסמך", "Document"], sheet: ["גיליון", "Sheet"], deck: ["מצגת", "Slides"] };

const narrow = () => matchMedia("(max-width: 1099px)").matches;
const fileName = (t: string, fallback: string) => t.replace(/[\\/:*?"<>|]+/g, "").slice(0, 80) || fallback;

/**
 * A tool's edit of a document, sheet or deck in the chat: its icon, title, kind and version ("v3"), and Open. While
 * the model is working (`live`), the newest card opens the panel by itself on a wide screen (on the phone it waits
 * for a tap, so the chat stays in view).
 *
 * @param props - `item` (kind, id, chat, title), `ver` (the version this edit made) and `live`.
 */
export function ItemCard({ item, ver, live = false }: { item: PanelItem; ver?: number; live?: boolean }) {
  const meta = ITEM_KINDS[item.kind];
  const [he, en] = KIND_NAME[item.kind];
  useEffect(() => {
    if (live && !narrow()) openItem(item);
    // Only when the card first shows: a later re-render must not open the panel again after she closed it.
  }, []);
  return (
    <button type="button" className="item-card" onClick={() => openItem(item)} aria-label={`${L("פתיחה", "Open")}: ${item.title || L(he, en)}`}>
      <span className="item-card-icon" aria-hidden>{meta.icon}</span>
      <span className="item-card-text">
        <strong dir="auto">{item.title || L(he, en)}</strong>
        <small className="muted">{L(he, en)}{ver ? ` · v${ver}` : ""}</small>
      </span>
      <span className="item-card-open">{L("פתיחה", "Open")} ›</span>
    </button>
  );
}

/**
 * The side panel's content for a document, sheet or deck: the bar (title, version, Edit, full page, download,
 * close or back), the live view or the editor, and the selection box.
 *
 * @param props - `item`: what to show (the panel keys it, so another item starts fresh); `full` and `onFull`: the
 *   panel's full-screen state.
 */
export function ItemPanel({ item, full, onFull }: { item: PanelItem; full: boolean; onFull: () => void }) {
  const meta = ITEM_KINDS[item.kind];
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState("");
  const [viewVer, setViewVer] = useState<number | null>(null);
  const [edit, setEdit] = useState(false);
  const [picked, setPicked] = useState("");
  /** Where the selection is in the document's markdown (for "Edit with AI"), and whether she chose to ask the chat instead. */
  const [span, setSpan] = useState<TextSpan | null>(null);
  const [asking, setAsking] = useState(false);
  /** When Ctrl/Cmd+K was pressed on a selection (the "Edit this" box opens at once). */
  const [askAt, setAskAt] = useState(0);
  const [ask, setAsk] = useState("");
  const [sending, setSending] = useState(false);
  const view = useRef<HTMLDivElement>(null);
  const load = useCallback(() => void api<Loaded>(`${meta.api}/${item.id}`).then((d) => { setData(d); setFailed(""); }, (e: Error) => setFailed(e.message)), [meta.api, item.id]);
  useEffect(load, [load]);
  // The model's next edits (and her own in the editor) show live.
  useEffect(() => {
    const es = new EventSource(withToken(`${meta.api}/${item.id}/events`));
    let rev = -1;
    es.onmessage = (e) => {
      const m = JSON.parse(e.data as string) as { rev?: number };
      if (typeof m.rev !== "number") return;
      if (m.rev === -1) setFailed(L("הפריט נמחק.", "This item was deleted."));
      else if (rev >= 0 && m.rev !== rev) load();
      rev = m.rev;
    };
    return () => es.close();
  }, [meta.api, item.id, load]);
  const [he, en] = KIND_NAME[item.kind];
  const title = data?.title || item.title || L(he, en);
  const current = data ? (data.ver ?? (data.versions?.length ?? 0) + 1) : 0;
  const old = viewVer !== null ? data?.versions?.find((v) => (v.ver ?? -1) === viewVer) : undefined;
  // The item as shown: the current state, or an older version's fields over it.
  const shown = data ? ({ ...data, ...(old ?? {}) } as Loaded) : null;

  const restore = () => {
    if (!old) return;
    void api<Loaded>(`${meta.api}/${item.id}/restore`, { method: "POST", body: { rev: old.rev } }).then(
      (d) => { setData(d); setViewVer(null); toast(L(`חזרנו לגרסה ${old.ver ?? ""}`, `Back to version ${old.ver ?? ""}`)); },
      (e: Error) => toast(e.message),
    );
  };
  const download = (format: string) => {
    if (!shown) return;
    const name = fileName(shown.title, item.kind === "deck" ? "slides" : item.kind === "sheet" ? "sheet" : "document");
    const save = (blob: Blob, ext: string) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${name}.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    };
    if (item.kind === "doc") {
      const body = String(shown.body ?? "");
      if (format === "pdf") printDoc(shown.title, view.current?.querySelector(".doc-panel-body")?.innerHTML ?? "");
      else if (format === "md") save(new Blob([`# ${shown.title}\n\n${body}\n`], { type: "text/markdown" }), "md");
      else saveOffice(docxFiles(shown.title, body), `${name}.docx`, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    } else if (item.kind === "sheet") {
      const sheet = shown as unknown as Sheet;
      if (format === "csv") save(new Blob([`${String.fromCharCode(0xfeff)}${sheetCsv(sheet)}`], { type: "text/csv;charset=utf-8" }), "csv");
      else saveOffice(xlsxFiles(sheet), `${name}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    } else {
      const deck = shown as unknown as Deck;
      if (format === "pdf") printDeckPdf(deck);
      else downloadPptx(deck);
    }
  };
  const formats: Array<[string, string]> = item.kind === "doc" ? [["pdf", "PDF"], ["docx", "Word"], ["md", "Markdown"]] : item.kind === "sheet" ? [["csv", "CSV"], ["xlsx", "Excel"]] : [["pdf", "PDF"], ["pptx", "PowerPoint"]];

  // A selection inside the view opens the box (mouse up on the computer, touch end or the selection handles on the phone).
  const pick = () => {
    const s = getSelection();
    const text = s?.toString().trim() ?? "";
    if (!text || !s?.anchorNode || !view.current?.contains(s.anchorNode)) return;
    setPicked(text);
    setAsking(false);
    const body = item.kind === "doc" && viewVer === null && data ? String(data.body ?? "") : "";
    if (!body) return setSpan(null);
    // Where on screen the selection starts, as a share of the shown text: picks between repeats of the same words.
    const range = s.getRangeAt(0);
    const before = document.createRange();
    before.selectNodeContents(view.current);
    before.setEnd(range.startContainer, range.startOffset);
    const share = before.toString().length / Math.max(1, view.current.textContent?.length ?? 1);
    setSpan(locateSpan(body, text, Math.round(share * body.length)));
  };
  const dropPick = () => {
    setAskAt(0);
    setPicked("");
    setSpan(null);
    setAsking(false);
    getSelection()?.removeAllRanges();
  };
  /** "Edit with AI" accepted: the new markdown saved from the revision shown, as a new version. */
  const saveSpan = async (next: string) => {
    if (!data) return;
    const d = await api<Loaded>(`${meta.api}/${item.id}`, { method: "PUT", body: { body: next, rev: data.rev } });
    setData((cur) => ({ ...(cur ?? d), ...d }));
    load();
    toast(L("השינוי נשמר כגרסה חדשה.", "Saved as a new version."));
  };
  useEffect(() => {
    const onChange = () => {
      // The phone's selection handles move without a touch end on the view: follow them.
      if (matchMedia("(pointer: coarse)").matches) pick();
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  });
  // Ctrl/Cmd+K on a selection in the document opens "Edit this" (keyboard, with Shift+arrows or a mouse selection).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isEditShortcut(e) || edit || !view.current) return;
      const a = getSelection()?.anchorNode;
      if (!a || !view.current.contains(a)) return;
      e.preventDefault();
      pick();
      setAskAt(Date.now());
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  const sendPicked = async (change: boolean) => {
    if (!ask.trim() || !data) return;
    setSending(true);
    try {
      const conv = item.convId ?? data.convId ?? (await api<{ id: string }>("/api/conversations", { method: "POST", body: { kind: "chat" } })).id;
      const text = selectionMessage({ kind: item.kind, id: item.id, title, selection: picked, instruction: ask, change, he: getLocale() === "he" });
      await api(`/api/conversations/${conv}/messages`, { method: "POST", body: { text } });
      setAsk("");
      setPicked("");
      getSelection()?.removeAllRanges();
      toast(change ? L("נשלח לצ'אט. השינוי יופיע כאן כשיסתיים.", "Sent to the chat. The change shows here when it is done.") : L("נשלח לצ'אט.", "Sent to the chat."));
      // On the phone the sheet covers the chat: back to it, to read the answer.
      if (narrow()) closePanel();
      if (!item.convId && !data.convId) location.hash = `#/c/${conv}`;
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  // A selection inside a document's code block is edited as code (kept left-to-right, no prose rewriting).
  const fence = span && data && typeof data.body === "string" ? fenceAt(data.body, span) : null;
  const Editor = item.kind === "doc" ? DocsPage : item.kind === "sheet" ? SheetsPage : SlidesPage;
  return (
    <>
      <div className="artifact-bar">
        <button type="button" className="ghost artifact-back" onClick={closePanel}>‹ {L("חזרה לצ'אט", "Back to chat")}</button>
        <span aria-hidden>{meta.icon}</span>
        <strong className="grow" dir="auto">{title}</strong>
        {!!data?.versions?.length && !edit && (
          <select value={viewVer ?? ""} onChange={(e) => setViewVer(e.target.value ? Number(e.target.value) : null)} aria-label={L("גרסה", "Version")}>
            <option value="">{`v${current} · ${L("עכשיו", "now")}`}</option>
            {[...data.versions].reverse().filter((v) => v.ver).map((v) => (
              <option key={v.rev} value={v.ver}>{`v${v.ver} · ${new Date(v.at).toLocaleTimeString(getLocale() === "he" ? "he-IL" : "en-GB", { hour: "2-digit", minute: "2-digit" })}`}</option>
            ))}
          </select>
        )}
        <div className="artifact-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={!edit} className={!edit ? "on" : ""} onClick={() => setEdit(false)}>{L("תצוגה", "View")}</button>
          <button type="button" role="tab" aria-selected={edit} className={edit ? "on" : ""} onClick={() => { setEdit(true); setViewVer(null); setPicked(""); }}>✎ {L("עריכה", "Edit")}</button>
        </div>
        <details className="doc-panel-menu">
          <summary className="ghost" title={L("הורדה", "Download")} aria-label={L("הורדה", "Download")}>⬇</summary>
          <div className="doc-panel-menu-list">
            {formats.map(([k, label]) => <button key={k} type="button" className="ghost" onClick={(e) => { (e.currentTarget.closest("details") as HTMLDetailsElement).open = false; download(k); }}>{label}</button>)}
          </div>
        </details>
        <button type="button" className="ghost" title={L("פתיחה בעמוד מלא", "Open full page")} aria-label={L("פתיחה בעמוד מלא", "Open full page")} onClick={() => { location.hash = `${meta.page}${item.id}`; }}>↗</button>
        <button type="button" className="ghost artifact-wide-only" title={L("מסך מלא", "Full screen")} aria-label={L("מסך מלא", "Full screen")} aria-pressed={full} onClick={onFull}>⛶</button>
        <button type="button" className="ghost artifact-close" title={L("סגור", "Close")} aria-label={L("סגור", "Close")} onClick={closePanel}>✕</button>
      </div>
      {old && (
        <div className="doc-panel-old" role="status">
          <span className="grow">{L(`מוצגת גרסה ${old.ver} (ישנה)`, `Showing version ${old.ver} (older)`)}</span>
          <button type="button" onClick={restore}>{L("לחזור לגרסה הזאת", "Restore this version")}</button>
          <button type="button" className="ghost" onClick={() => setViewVer(null)}>{L("לגרסה הנוכחית", "Current version")}</button>
        </div>
      )}
      {failed ? (
        <p className="muted doc-panel-empty" role="alert">{failed}</p>
      ) : !shown ? (
        <p className="muted doc-panel-empty">…</p>
      ) : edit ? (
        <div className="doc-panel-edit"><Editor id={item.id} /></div>
      ) : (
        <div className="doc-panel-view" ref={view} onMouseUp={pick} onTouchEnd={pick}>
          <ItemView kind={item.kind} item={shown} />
        </div>
      )}
      {picked && !edit && span && !asking && !old && data ? (
        <SpanEdit key={`${span.start}-${span.end}`} source={String(data.body ?? "")} span={span} kind={fence ? "code" : "doc"} language={fence?.language} fenced={!!fence} title={title} askAt={askAt} onAccept={saveSpan} onAsk={() => setAsking(true)} onClose={dropPick} />
      ) : picked && !edit && (
        <form className="doc-panel-ask" onSubmit={(e) => { e.preventDefault(); void sendPicked(true); }}>
          <div className="row">
            <q className="muted small grow" dir="auto">{picked.length > 120 ? `${picked.slice(0, 120)}…` : picked}</q>
            <button type="button" className="ghost small" aria-label={L("ביטול", "Cancel")} onClick={dropPick}>✕</button>
          </div>
          <input dir="auto" autoFocus={!narrow()} value={ask} onChange={(e) => setAsk(e.target.value)} placeholder={L("מה לעשות עם החלק הזה?", "What to do with this part?")} aria-label={L("הבקשה על החלק שנבחר", "Your request about the selected part")} />
          <div className="row">
            <button type="button" className="ghost" disabled={!ask.trim() || sending} onClick={() => void sendPicked(false)}>💬 {L("לשאול על זה", "Ask about this")}</button>
            <button type="submit" disabled={!ask.trim() || sending}>✎ {L("לשנות את זה", "Change this")}</button>
          </div>
        </form>
      )}
    </>
  );
}

/** The item drawn as it reads: a document's text, a sheet's table (its values), or a deck's slides. */
function ItemView({ kind, item }: { kind: ItemKind; item: Loaded }) {
  if (kind === "doc") {
    return (
      <article className="docs-page doc-panel-doc">
        <h1 dir="auto">{item.title}</h1>
        <div className="doc-panel-body"><RichText text={String(item.body ?? "")} /></div>
      </article>
    );
  }
  if (kind === "sheet") {
    const sheet = item as unknown as Sheet;
    const cells = sheet.cells ?? {};
    const values = computeSheet(cells);
    // The used part only, at most 200 rows (the editor shows the rest).
    let cols = 0;
    let rows = 0;
    for (const a of Object.keys(cells)) {
      const m = /^([A-Z]+)(\d+)$/.exec(a);
      if (!m) continue;
      const c = [...m[1]!].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
      cols = Math.max(cols, c);
      rows = Math.max(rows, Number(m[2]));
    }
    if (!cols) return <p className="muted doc-panel-empty">{L("הגיליון ריק.", "The sheet is empty.")}</p>;
    return (
      <div className="doc-panel-sheet">
        <table>
          <tbody>
            {Array.from({ length: Math.min(rows, 200) }, (_, r) => (
              <tr key={r}>{Array.from({ length: Math.min(cols, 52) }, (_, c) => <td key={c} dir="auto">{showValue(values[addr(c, r)])}</td>)}</tr>
            ))}
          </tbody>
        </table>
        {rows > 200 && <p className="muted small">{L(`ועוד ${rows - 200} שורות בעריכה`, `${rows - 200} more rows in Edit`)}</p>}
      </div>
    );
  }
  const deck = item as unknown as Deck;
  if (!deck.slides?.length) return <p className="muted doc-panel-empty">{L("אין שקפים עדיין.", "No slides yet.")}</p>;
  return (
    <div className="doc-panel-deck">
      {deck.slides.map((s, i) => (
        <figure key={s.id || i}>
          <SlideView slide={s} theme={deck.theme} />
          <figcaption className="muted small">{i + 1}</figcaption>
        </figure>
      ))}
    </div>
  );
}
