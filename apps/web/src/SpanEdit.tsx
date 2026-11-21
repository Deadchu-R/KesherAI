import { useCallback, useEffect, useRef, useState } from "react";
import { appliedSpan, bubblePlace, isEditShortcut, QUICK_ACTIONS, quickActionInstruction, spanContext, undoSpan, wordDiff, type AppliedSpan, type BubblePlace, type QuickActionId, type TextSpan } from "@kesher/shared";
import { streamPost } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/*
 * Highlight-to-edit in the side panel (design DocPanel "Edit with AI", as Claude's and ChatGPT's canvas): a selection
 * in a document or in a page's code shows a small "Edit with AI" bubble; tapping it asks what to change, the model
 * rewrites only that span (shared/span-edit.ts, POST /api/span-edit), and the change shows inline as a word diff with
 * Accept / Reject / Try again. Accept hands the whole new text to the panel, which saves it as a new version the way
 * an edit always did, and "Undo" puts the old text of the span back (another version). The bubble also offers quick
 * actions (shorter, clearer, translate he↔en, fix grammar) that skip the instruction box, and Ctrl/Cmd+K opens it on
 * a selection. The rewrite streams in as the model writes it. Everything goes through the server's API, so the phone
 * connected to the PC works the same; on a computer the bubble floats above the selection, on a phone it sits at the
 * bottom of the panel, clear of the finger, the selection handles and the system's own menu.
 */

/**
 * The offset of a point inside a container's text (for a code view, where the text on screen is the source).
 *
 * @param container - The element whose text is the source.
 * @param node - The point's node; `offset` its offset there.
 */
export function textOffset(container: Node, node: Node, offset: number): number {
  const r = document.createRange();
  r.selectNodeContents(container);
  r.setEnd(node, offset);
  return r.toString().length;
}

/** The last line box of the current selection, in viewport pixels (where the bubble hangs), or null with no selection. */
function selectionAnchor(): { top: number; bottom: number; left: number; right: number } | null {
  const s = getSelection();
  if (!s || s.isCollapsed || !s.rangeCount) return null;
  const range = s.getRangeAt(0);
  const rects = range.getClientRects();
  const r = rects.length ? rects[rects.length - 1]! : range.getBoundingClientRect();
  return r.width || r.height ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right } : null;
}

/** What the server streams back from POST /api/span-edit. */
type SpanEvent = { type: "delta"; text: string } | { type: "done"; text: string } | { type: "error"; message: string };

/**
 * The bubble, the request, and the diff for one selected span.
 *
 * @param props.source - The whole text now (a document's markdown, a page's code).
 * @param props.span - The selected span in it.
 * @param props.kind - A markdown document or code (`language`); `title` names the item for the model.
 * @param props.fenced - The span is a code block inside a document: the answer may not contain code fences.
 * @param props.askAt - When Ctrl/Cmd+K was pressed (ms): a bubble that mounts right after it opens the box at once.
 * @param props.onAccept - Saves the new whole text (a new version); a rejected promise keeps the diff open.
 * @param props.onAsk - Optional: ask the chat about the part instead (the old box).
 * @param props.onClose - The selection is dropped (Reject, ✕, or after Accept).
 */
export function SpanEdit({ source, span, kind, language, title, fenced, askAt, onAccept, onAsk, onClose }: {
  source: string;
  span: TextSpan;
  kind: "doc" | "code";
  language?: string;
  title?: string;
  fenced?: boolean;
  askAt?: number;
  onAccept: (next: string) => Promise<void> | void;
  onAsk?: () => void;
  onClose: () => void;
}) {
  const [stage, setStage] = useState<"bubble" | "ask" | "working" | "diff" | "done">(askAt && Date.now() - askAt < 1500 ? "ask" : "bubble");
  const [text, setText] = useState("");
  const [quick, setQuick] = useState<QuickActionId | null>(null);
  const [answer, setAnswer] = useState("");
  const [partial, setPartial] = useState("");
  const [place, setPlace] = useState<BubblePlace | null>(null);
  const stop = useRef<AbortController | null>(null);
  const applied = useRef<AppliedSpan | null>(null);
  const latest = useRef(source);
  latest.current = source;
  // The span is frozen while the box is open: the text it was cut from is what the diff and the undo are about.
  const selected = source.slice(span.start, span.end);
  const short = selected.trim().replace(/\s+/g, " ");
  const dir = kind === "code" ? "ltr" : "auto";
  const coarse = matchMedia("(pointer: coarse)").matches;

  /** The bubble floats above the selection on a computer, and follows it when the panel scrolls. */
  const follow = useCallback(() => {
    const a = selectionAnchor();
    if (a) setPlace(bubblePlace(a, { width: innerWidth, height: innerHeight }, { width: 360, height: 84 }));
  }, []);
  useEffect(() => {
    if (coarse || stage !== "bubble") return;
    follow();
    addEventListener("scroll", follow, true);
    addEventListener("resize", follow);
    return () => {
      removeEventListener("scroll", follow, true);
      removeEventListener("resize", follow);
    };
  }, [coarse, stage, follow]);

  /** Sends one instruction and shows the answer as it is written. */
  const run = async (instruction: string) => {
    if (!instruction.trim()) return;
    stop.current?.abort();
    const ac = new AbortController();
    stop.current = ac;
    setPartial("");
    setStage("working");
    let final: string | null = null;
    let failed = "";
    try {
      await streamPost<SpanEvent>("/api/span-edit", { kind, language, title, fenced, stream: true, ...spanContext(source, span), instruction }, (e) => {
        if (e.type === "delta") setPartial(e.text);
        else if (e.type === "done") final = e.text;
        else failed = e.message;
      }, ac.signal);
    } catch (e) {
      if (ac.signal.aborted) return;
      failed = (e as Error).message;
    }
    if (ac.signal.aborted) return;
    if (final === null) {
      toast(failed || L("המודל לא החזיר תשובה.", "The model gave no answer."));
      return setStage("ask");
    }
    setAnswer(final);
    setStage("diff");
  };
  const rewrite = () => void run(quick ? quickActionInstruction(quick, selected, kind) : text);
  const runQuick = (id: QuickActionId) => {
    const a = QUICK_ACTIONS.find((q) => q.id === id)!;
    setQuick(id);
    setText(L(a.he, a.en));
    void run(quickActionInstruction(id, selected, kind));
  };
  const accept = async () => {
    try {
      const next = appliedSpan(source, span, answer);
      await onAccept(next.text);
      applied.current = next;
      setStage("done");
    } catch (e) {
      toast((e as Error).message);
    }
  };
  /** Puts the old text of the span back, as another version, if the replacement is still where it was put. */
  const undo = async () => {
    const back = applied.current ? undoSpan(latest.current, applied.current) : null;
    if (back === null) return toast(L("הטקסט השתנה מאז, אז אי אפשר לבטל אוטומטית. אפשר לחזור לגרסה קודמת מרשימת הגרסאות.", "The text has changed since, so it cannot be undone automatically. Go back from the version list."));
    try {
      await onAccept(back);
      toast(L("השינוי בוטל.", "Change undone."));
      onClose();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const cancel = () => {
    stop.current?.abort();
    setStage("ask");
  };

  // Keyboard: Ctrl/Cmd+K opens the box, Esc stops or closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditShortcut(e)) {
        e.preventDefault();
        setStage((s) => (s === "bubble" ? "ask" : s));
      } else if (e.key === "Escape") {
        if (stage === "working") cancel();
        else onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  useEffect(() => () => stop.current?.abort(), []);

  if (stage === "bubble") {
    const floating = !coarse && place;
    return (
      <div
        className={`span-edit-bubble${floating ? " floating" : ""}`}
        style={floating ? { top: place.top, left: place.left } : undefined}
        role="toolbar"
        aria-label={L("עריכת החלק שנבחר", "Edit the selected part")}
      >
        <button type="button" className="primary" title={L("ערוך את זה (Ctrl+K)", "Edit this (Ctrl+K)")} onClick={() => setStage("ask")}>✎ {L("ערוך את זה", "Edit this")}</button>
        {onAsk && <button type="button" className="ghost" onClick={onAsk}>💬 {L("לשאול", "Ask")}</button>}
        <button type="button" className="ghost" aria-label={L("ביטול", "Cancel")} onClick={onClose}>✕</button>
        <div className="span-edit-quick" role="group" aria-label={L("פעולות מהירות", "Quick actions")}>
          {QUICK_ACTIONS.map((a) => <button key={a.id} type="button" className="chip-text" onClick={() => runQuick(a.id)}>{L(a.he, a.en)}</button>)}
        </div>
      </div>
    );
  }
  if (stage === "done") {
    return (
      <div className="doc-panel-ask span-edit" role="status">
        <div className="row">
          <span className="grow">✓ {L("נשמר כגרסה חדשה", "Saved as a new version")}</span>
          <button type="button" onClick={() => void undo()}>↶ {L("ביטול השינוי", "Undo")}</button>
          <button type="button" className="ghost" aria-label={L("סגירה", "Close")} onClick={onClose}>✕</button>
        </div>
      </div>
    );
  }
  return (
    <form className="doc-panel-ask span-edit" onSubmit={(e) => { e.preventDefault(); rewrite(); }}>
      <div className="row">
        <q className="muted small grow" dir={dir}>{short.length > 120 ? `${short.slice(0, 120)}…` : short}</q>
        <button type="button" className="ghost small" aria-label={L("ביטול", "Cancel")} onClick={() => { stop.current?.abort(); onClose(); }}>✕</button>
      </div>
      {stage === "diff" && (
        <div className={`span-edit-diff${kind === "code" ? " code" : ""}`} dir={dir} aria-label={L("השינוי המוצע", "The proposed change")}>
          {wordDiff(selected.trim(), answer.trim()).map((p, i) =>
            p.op === "same" ? <span key={i}>{p.text}</span> : p.op === "del" ? <del key={i}>{p.text}</del> : <ins key={i}>{p.text}</ins>,
          )}
          {!answer.trim() && <p className="muted small">{L("המודל הציע למחוק את החלק הזה.", "The model suggests deleting this part.")}</p>}
        </div>
      )}
      {stage === "working" && (
        <div className={`span-edit-diff live${kind === "code" ? " code" : ""}`} dir={dir} aria-label={L("הכתיבה מחדש מתקדמת", "The rewrite as it is written")}>
          {partial ? <ins>{partial}</ins> : <span className="muted">…</span>}
        </div>
      )}
      <input
        dir="auto"
        autoFocus={stage === "ask" && !coarse}
        value={text}
        disabled={stage === "working"}
        onChange={(e) => { setText(e.target.value); setQuick(null); }}
        placeholder={L("מה לשנות? למשל: קצר יותר, רשמי יותר", "What to change? e.g. shorter, more formal")}
        aria-label={L("מה לשנות בחלק שנבחר", "What to change in the selected part")}
      />
      {stage === "ask" && (
        <div className="span-edit-quick" role="group" aria-label={L("פעולות מהירות", "Quick actions")}>
          {QUICK_ACTIONS.map((a) => <button key={a.id} type="button" className="chip-text" onClick={() => runQuick(a.id)}>{L(a.he, a.en)}</button>)}
        </div>
      )}
      <div className="row">
        {stage === "working" ? (
          <>
            <span className="muted small grow" role="status">{L("כותב מחדש…", "Rewriting…")}</span>
            <button type="button" className="ghost" onClick={cancel}>{L("עצור", "Stop")}</button>
          </>
        ) : stage === "diff" ? (
          <>
            <button type="button" className="primary" autoFocus={!coarse} onClick={() => void accept()}>✓ {L("אישור", "Accept")}</button>
            <button type="button" onClick={onClose}>✕ {L("דחייה", "Reject")}</button>
            <button type="submit" className="ghost" disabled={!quick && !text.trim()}>↻ {L("שוב", "Try again")}</button>
          </>
        ) : (
          <>
            {onAsk && <button type="button" className="ghost" onClick={onAsk}>💬 {L("לשאול בצ'אט", "Ask in chat")}</button>}
            <button type="submit" className="primary" disabled={!text.trim()}>✨ {L("לכתוב מחדש", "Rewrite")}</button>
          </>
        )}
      </div>
    </form>
  );
}
