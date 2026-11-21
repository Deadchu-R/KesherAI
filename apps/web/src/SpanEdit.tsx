import { useRef, useState } from "react";
import { applySpan, spanContext, wordDiff, type TextSpan } from "@kesher/shared";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/*
 * Highlight-to-edit in the side panel (design DocPanel "Edit with AI", as Claude's and ChatGPT's canvas): a selection
 * in a document or in a page's code shows a small "Edit with AI" bubble; tapping it asks what to change, the model
 * rewrites only that span (shared/span-edit.ts, POST /api/span-edit), and the change shows inline as a word diff with
 * Accept / Reject / Try again. Accept hands the whole new text to the panel, which saves it as a new version the way
 * an edit always did. Everything goes through the server's API, so the phone connected to the PC works the same; the
 * bubble sits at the bottom of the panel, clear of the phone's selection handles and menu.
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

/**
 * The bubble, the request, and the diff for one selected span.
 *
 * @param props.source - The whole text now (a document's markdown, a page's code).
 * @param props.span - The selected span in it.
 * @param props.kind - A markdown document or code (`language`); `title` names the item for the model.
 * @param props.onAccept - Saves the new whole text (a new version); a rejected promise keeps the diff open.
 * @param props.onAsk - Optional: ask the chat about the part instead (the old box).
 * @param props.onClose - The selection is dropped (Reject, ✕, or after Accept).
 */
export function SpanEdit({ source, span, kind, language, title, onAccept, onAsk, onClose }: {
  source: string;
  span: TextSpan;
  kind: "doc" | "code";
  language?: string;
  title?: string;
  onAccept: (next: string) => Promise<void> | void;
  onAsk?: () => void;
  onClose: () => void;
}) {
  const [stage, setStage] = useState<"bubble" | "ask" | "working" | "diff">("bubble");
  const [instruction, setInstruction] = useState("");
  const [answer, setAnswer] = useState("");
  const stop = useRef<AbortController | null>(null);
  const selected = source.slice(span.start, span.end);
  const short = selected.trim().replace(/\s+/g, " ");

  const rewrite = async () => {
    if (!instruction.trim()) return;
    stop.current?.abort();
    const ac = new AbortController();
    stop.current = ac;
    setStage("working");
    try {
      const ctx = spanContext(source, span);
      const r = await api<{ text: string }>("/api/span-edit", { method: "POST", signal: ac.signal, body: { kind, language, title, ...ctx, instruction } });
      if (ac.signal.aborted) return;
      setAnswer(r.text);
      setStage("diff");
    } catch (e) {
      if (ac.signal.aborted) return;
      toast((e as Error).message);
      setStage("ask");
    }
  };
  const accept = async () => {
    try {
      await onAccept(applySpan(source, span, answer));
      onClose();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const cancel = () => {
    stop.current?.abort();
    setStage("ask");
  };

  if (stage === "bubble") {
    return (
      <div className="span-edit-bubble" role="toolbar" aria-label={L("עריכת החלק שנבחר", "Edit the selected part")}>
        <button type="button" className="primary" onClick={() => setStage("ask")}>✨ {L("עריכה עם AI", "Edit with AI")}</button>
        {onAsk && <button type="button" className="ghost" onClick={onAsk}>💬 {L("לשאול", "Ask")}</button>}
        <button type="button" className="ghost" aria-label={L("ביטול", "Cancel")} onClick={onClose}>✕</button>
      </div>
    );
  }
  return (
    <form className="doc-panel-ask span-edit" onSubmit={(e) => { e.preventDefault(); void rewrite(); }}>
      <div className="row">
        <q className="muted small grow" dir="auto">{short.length > 120 ? `${short.slice(0, 120)}…` : short}</q>
        <button type="button" className="ghost small" aria-label={L("ביטול", "Cancel")} onClick={() => { stop.current?.abort(); onClose(); }}>✕</button>
      </div>
      {stage === "diff" && (
        <div className={`span-edit-diff${kind === "code" ? " code" : ""}`} dir={kind === "code" ? "ltr" : "auto"} aria-label={L("השינוי המוצע", "The proposed change")}>
          {wordDiff(selected.trim(), answer.trim()).map((p, i) =>
            p.op === "same" ? <span key={i}>{p.text}</span> : p.op === "del" ? <del key={i}>{p.text}</del> : <ins key={i}>{p.text}</ins>,
          )}
          {!answer.trim() && <p className="muted small">{L("המודל הציע למחוק את החלק הזה.", "The model suggests deleting this part.")}</p>}
        </div>
      )}
      <input
        dir="auto"
        autoFocus={stage === "ask" && !matchMedia("(pointer: coarse)").matches}
        value={instruction}
        disabled={stage === "working"}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder={L("מה לשנות? למשל: קצר יותר, רשמי יותר", "What to change? e.g. shorter, more formal")}
        aria-label={L("מה לשנות בחלק שנבחר", "What to change in the selected part")}
      />
      <div className="row">
        {stage === "working" ? (
          <>
            <span className="muted small grow" role="status">{L("כותב מחדש…", "Rewriting…")}</span>
            <button type="button" className="ghost" onClick={cancel}>{L("עצור", "Stop")}</button>
          </>
        ) : stage === "diff" ? (
          <>
            <button type="button" className="primary" onClick={() => void accept()}>✓ {L("אישור", "Accept")}</button>
            <button type="button" onClick={onClose}>✕ {L("דחייה", "Reject")}</button>
            <button type="submit" className="ghost" disabled={!instruction.trim()}>↻ {L("שוב", "Try again")}</button>
          </>
        ) : (
          <>
            {onAsk && <button type="button" className="ghost" onClick={onAsk}>💬 {L("לשאול בצ'אט", "Ask in chat")}</button>}
            <button type="submit" className="primary" disabled={!instruction.trim()}>✨ {L("לכתוב מחדש", "Rewrite")}</button>
          </>
        )}
      </div>
    </form>
  );
}
