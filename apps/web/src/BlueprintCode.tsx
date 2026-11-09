import { useEffect, useMemo, useRef, useState } from "react";
import { blueprintToCode, blueprintToVerse, codeText, type CodeNode } from "@kesher/shared";
import { getLocale } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/**
 * The Blueprint as code: read it like a script (each event a block, lines in
 * the order the exec wires run them). Click a line: its node flashes in the
 * graph. A node chosen in the graph lights its lines here. "Edit" turns it
 * into text you can change; "Apply" sends the new code to the model, which
 * changes the graph to match (as one undo step in the editor).
 */
export function BlueprintCode({ nodes, selected, onPick, onApply, editable, busy, verse }: { nodes: CodeNode[]; selected: Set<string>; onPick: (node: string) => void; onApply: (code: string, before: string) => void; editable: boolean; busy: boolean; verse?: { name: string; translate: (draft: string) => Promise<string> } }) {
  // Unreal: the same graph as a first Verse version (Unreal 6 / UEFN), read-only, with an optional full translation by the model.
  const [lang, setLang] = useState<"code" | "verse">("code");
  const [aiVerse, setAiVerse] = useState("");
  const [translating, setTranslating] = useState(false);
  useEffect(() => {
    setAiVerse("");
  }, [nodes]);
  const lines = useMemo(() => (lang === "verse" && verse ? blueprintToVerse(nodes, verse.name) : blueprintToCode(nodes)), [nodes, lang, verse?.name]);
  const text = useMemo(() => codeText(lines), [lines]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  useEffect(() => {
    if (!editing) setDraft(text);
  }, [text, editing]);
  const first = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    first.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  let marked = false;
  return (
    <div className="bp-code">
      <div className="row bp-code-bar">
        <strong className="grow small">{L("ה-Blueprint כקוד", "The Blueprint as code")}</strong>
        {verse && !editing && (
          <span className="row bp-code-lang" role="tablist" aria-label={L("שפה", "Language")}>
            <button type="button" role="tab" aria-selected={lang === "code"} className={lang === "code" ? "on" : ""} onClick={() => setLang("code")}>{L("קוד", "Code")}</button>
            <button type="button" role="tab" aria-selected={lang === "verse"} className={lang === "verse" ? "on" : ""} onClick={() => setLang("verse")} title={L("Verse: שפת ה-gameplay של Unreal 6 ו-UEFN", "Verse: the gameplay language of Unreal 6 and UEFN")}>Verse</button>
          </span>
        )}
        {verse && lang === "verse" && (
          <button type="button" disabled={translating} onClick={() => { setTranslating(true); void verse.translate(text).then(setAiVerse, () => undefined).finally(() => setTranslating(false)); }}>{translating ? L("מתרגם…", "Translating…") : `✨ ${L("תרגום מלא עם AI", "Full translation with AI")}`}</button>
        )}
        {editable && !editing && lang === "code" && <button type="button" onClick={() => setEditing(true)}>{L("עריכה", "Edit")}</button>}
        {editing && (
          <>
            <button type="button" onClick={() => { setEditing(false); setDraft(text); }}>{L("ביטול", "Cancel")}</button>
            <button type="button" className="primary" disabled={busy || draft === text} onClick={() => { onApply(draft, text); setEditing(false); }}>{busy ? L("המודל עובד…", "Working…") : L("✨ החל על הגרף", "✨ Apply to the graph")}</button>
          </>
        )}
      </div>
      {lang === "verse" && aiVerse ? (
        <pre className="bp-code-ai" dir="ltr">{aiVerse}</pre>
      ) : editing ? (
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
      <p className="muted small">{lang === "verse" ? L("טיוטה ראשונה ב-Verse (Unreal 6 ו-UEFN): נקודת התחלה לקריאה ולהעברה, לא תרגום שנבדק. שורות עם # check צריכות בדיקה.", "A first Verse draft (Unreal 6 and UEFN): a starting point to read and port, not a checked translation. Lines with # check need a look.") : L("הקוד נכתב מהגרף (לא C++ אמיתי). לחיצה על שורה מהבהבת את הנוד שלה.", "Written from the graph (not real C++). Click a line to flash its node.")}</p>
    </div>
  );
}
