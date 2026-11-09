import { useEffect, useMemo, useRef, useState } from "react";
import { blueprintToCode, blueprintToVerse, codeText, type CodeNode } from "@kesher/shared";
import { getLocale } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/** The real languages a graph can be shown in. */
export type Lang = "cpp" | "verse" | "csharp";
const LANG_NAME: Record<Lang, string> = { cpp: "C++", verse: "Verse", csharp: "C#" };

/**
 * The Blueprint as code: read it like a script (each event a block, lines in
 * the order the exec wires run them). Click a line: its node flashes in the
 * graph. A node chosen in the graph lights its lines here. "Edit" turns it
 * into text you can change; "Apply" sends the new code to the model, which
 * changes the graph to match (as one undo step in the editor).
 */
export function BlueprintCode({ nodes, selected, onPick, onApply, editable, busy, translate }: { nodes: CodeNode[]; selected: Set<string>; onPick: (node: string) => void; onApply: (code: string, before: string) => void; editable: boolean; busy: boolean; translate?: { name: string; unity: boolean; run: (lang: Lang, draft: string) => Promise<string> } }) {
  // The same graph in a real language: Unreal → C++ and Verse (Unreal 6 / UEFN), Unity → C#. Verse has a mechanical
  // first draft; every language has a full translation by the model (read-only).
  const [lang, setLang] = useState<"code" | Lang>("code");
  const [ai, setAi] = useState<Partial<Record<Lang, string>>>({});
  const [translating, setTranslating] = useState(false);
  useEffect(() => {
    setAi({});
  }, [nodes]);
  const langs: Lang[] = translate ? (translate.unity ? ["csharp"] : ["cpp", "verse"]) : [];
  const lines = useMemo(() => (lang === "verse" && translate ? blueprintToVerse(nodes, translate.name) : blueprintToCode(nodes)), [nodes, lang, translate?.name]);
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
        <strong className="grow small">{translate?.unity ? L("הגרף כקוד", "The graph as code") : L("ה-Blueprint כקוד", "The Blueprint as code")}</strong>
        {langs.length > 0 && !editing && (
          <span className="row bp-code-lang" role="tablist" aria-label={L("שפה", "Language")}>
            <button type="button" role="tab" aria-selected={lang === "code"} className={lang === "code" ? "on" : ""} onClick={() => setLang("code")} title={L("הגרף כקוד פשוט לקריאה", "The graph as simple code to read")}>{L("קריאה", "Read")}</button>
            {langs.map((l) => <button key={l} type="button" role="tab" aria-selected={lang === l} className={lang === l ? "on" : ""} onClick={() => setLang(l)} title={l === "verse" ? L("Verse: שפת ה-gameplay של Unreal 6 ו-UEFN", "Verse: the gameplay language of Unreal 6 and UEFN") : undefined}>{LANG_NAME[l]}</button>)}
          </span>
        )}
        {translate && lang !== "code" && (
          <button type="button" disabled={translating} onClick={() => { const l = lang; setTranslating(true); void translate.run(l, l === "verse" ? text : "").then((c) => setAi((a) => ({ ...a, [l]: c })), () => undefined).finally(() => setTranslating(false)); }}>{translating ? L("מתרגם…", "Translating…") : `✨ ${ai[lang] ? L("תרגם שוב", "Translate again") : L(`תרגום ל-${LANG_NAME[lang]} עם AI`, `Translate to ${LANG_NAME[lang]} with AI`)}`}</button>
        )}
        {editable && !editing && lang === "code" && <button type="button" onClick={() => setEditing(true)}>{L("עריכה", "Edit")}</button>}
        {editing && (
          <>
            <button type="button" onClick={() => { setEditing(false); setDraft(text); }}>{L("ביטול", "Cancel")}</button>
            <button type="button" className="primary" disabled={busy || draft === text} onClick={() => { onApply(draft, text); setEditing(false); }}>{busy ? L("המודל עובד…", "Working…") : L("✨ החל על הגרף", "✨ Apply to the graph")}</button>
          </>
        )}
      </div>
      {lang !== "code" && ai[lang] ? (
        <pre className="bp-code-ai" dir="ltr">{ai[lang]}</pre>
      ) : lang === "cpp" || lang === "csharp" ? (
        <p className="muted bp-code-empty">{translating ? L("המודל כותב את הקוד…", "The model is writing the code…") : L(`לחצו "תרגום ל-${LANG_NAME[lang]}" כדי לראות את הגרף כקוד ${LANG_NAME[lang]} אמיתי.`, `Press "Translate to ${LANG_NAME[lang]}" to see the graph as real ${LANG_NAME[lang]}.`)}</p>
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
      <p className="muted small">{lang === "cpp" || lang === "csharp" ? L(`תרגום של המודל ל-${LANG_NAME[lang]}: לקריאה, ללמידה ולהעברה לקוד. שורות עם // check צריכות בדיקה.`, `The model's ${LANG_NAME[lang]} translation: to read, learn from and move into code. Lines with // check need a look.`) : lang === "verse" ? L("טיוטה ראשונה ב-Verse (Unreal 6 ו-UEFN): נקודת התחלה לקריאה ולהעברה, לא תרגום שנבדק. שורות עם # check צריכות בדיקה.", "A first Verse draft (Unreal 6 and UEFN): a starting point to read and port, not a checked translation. Lines with # check need a look.") : L("הקוד נכתב מהגרף (לא C++ אמיתי). לחיצה על שורה מהבהבת את הנוד שלה.", "Written from the graph (not real C++). Click a line to flash its node.")}</p>
    </div>
  );
}
