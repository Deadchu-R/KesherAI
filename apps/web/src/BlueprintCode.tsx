import { useEffect, useMemo, useRef, useState } from "react";
import { blueprintToCode, codeText, type CodeNode } from "@kesher/shared";
import { getLocale } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/**
 * The Blueprint as code: read it like a script (each event a block, lines in
 * the order the exec wires run them). Click a line: its node flashes in the
 * graph. A node chosen in the graph lights its lines here. "Edit" turns it
 * into text you can change; "Apply" sends the new code to the model, which
 * changes the graph to match (as one undo step in the editor).
 */
export function BlueprintCode({ nodes, selected, onPick, onApply, editable, busy }: { nodes: CodeNode[]; selected: Set<string>; onPick: (node: string) => void; onApply: (code: string, before: string) => void; editable: boolean; busy: boolean }) {
  const lines = useMemo(() => blueprintToCode(nodes), [nodes]);
  const text = useMemo(() => codeText(lines), [lines]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  useEffect(() => {
    if (!editing) setDraft(text);
  }, [text, editing]);
  const first = useRef<HTMLLIElement | null>(null);
  useEffect(() => first.current?.scrollIntoView({ block: "nearest" }), [selected]);
  let marked = false;
  return (
    <div className="bp-code">
      <div className="row bp-code-bar">
        <strong className="grow small">{L("ה-Blueprint כקוד", "The Blueprint as code")}</strong>
        {editable && !editing && <button type="button" onClick={() => setEditing(true)}>{L("עריכה", "Edit")}</button>}
        {editing && (
          <>
            <button type="button" onClick={() => { setEditing(false); setDraft(text); }}>{L("ביטול", "Cancel")}</button>
            <button type="button" className="primary" disabled={busy || draft === text} onClick={() => { onApply(draft, text); setEditing(false); }}>{busy ? L("המודל עובד…", "Working…") : L("✨ החל על הגרף", "✨ Apply to the graph")}</button>
          </>
        )}
      </div>
      {editing ? (
        <textarea className="bp-code-edit" dir="ltr" spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={L("קוד ה-Blueprint", "Blueprint code")} />
      ) : (
        <ol className="bp-code-lines" dir="ltr">
          {lines.map((l, i) => {
            const on = !!l.node && selected.has(l.node);
            const ref = on && !marked ? first : undefined;
            if (on) marked = true;
            return (
              <li key={i} ref={ref} className={`${on ? "on" : ""}${l.node ? " link" : ""}`} onClick={() => l.node && onPick(l.node)} title={l.node ? L("הצג בגרף", "Show in the graph") : undefined}>
                <span className="ln">{i + 1}</span>
                <code style={{ paddingInlineStart: `${l.depth * 2}ch` }}>{l.text || " "}</code>
              </li>
            );
          })}
        </ol>
      )}
      <p className="muted small">{L("הקוד נכתב מהגרף (לא C++ אמיתי). לחיצה על שורה מהבהבת את הנוד שלה.", "Written from the graph (not real C++). Click a line to flash its node.")}</p>
    </div>
  );
}
