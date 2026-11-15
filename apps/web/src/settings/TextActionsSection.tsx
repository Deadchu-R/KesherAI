import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

type Action = { label: string; prompt: string };

/**
 * The Text Helper's own quick actions (as AnythingLLM's Magic Beacon custom actions): a button's name and what it
 * asks the model about the selected text. Shown after the built-in ones (Summarize, Translate…), up to 12.
 */
export function TextActionsSection() {
  const [list, setList] = useState<Action[] | null>(null);
  const [draft, setDraft] = useState<Action>({ label: "", prompt: "" });
  useEffect(() => {
    void api<{ actions: Action[] }>("/api/text-helper/actions").then((r) => setList(r.actions), () => setList([]));
  }, []);
  const save = (next: Action[]) =>
    void api<{ actions: Action[] }>("/api/text-helper/actions", { method: "PUT", body: { actions: next } }).then(
      (r) => setList(r.actions),
      (e: Error) => toast(e.message),
    );
  if (!list) return null;
  return (
    <section className="card stack">
      <h2>{L("פעולות משלך בעוזר הטקסט", "Your own Text helper actions")}</h2>
      <p className="muted small">{L("כפתורים נוספים בחלון של Ctrl+Alt+K, אחרי סיכום, תרגום ותיקון. הטקסט המסומן נשלח עם ההוראה.", "Extra buttons in the Ctrl+Alt+K window, after Summarize, Translate and Fix. The selected text goes with the instruction.")}</p>
      {list.map((a, i) => (
        <div key={i} className="row kbd-row">
          <strong dir="auto">{a.label}</strong>
          <span className="grow muted small" dir="auto">{a.prompt.length > 90 ? `${a.prompt.slice(0, 90)}…` : a.prompt}</span>
          <button type="button" onClick={() => save(list.filter((_, j) => j !== i))}>{L("הסרה", "Remove")}</button>
        </div>
      ))}
      {list.length < 12 && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); if (!draft.label.trim() || !draft.prompt.trim()) return; save([...list, draft]); setDraft({ label: "", prompt: "" }); }}>
          <input dir="auto" value={draft.label} maxLength={40} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder={L("שם הכפתור, למשל: מייל רשמי", "The button's name, e.g. Formal email")} aria-label={L("שם הכפתור", "The button's name")} />
          <textarea dir="auto" rows={2} value={draft.prompt} maxLength={1000} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} placeholder={L("מה לבקש, למשל: כתוב את זה מחדש כמייל רשמי באנגלית", "What to ask, e.g. Rewrite this as a formal email in English")} aria-label={L("ההוראה", "The instruction")} />
          <button type="submit" className="primary" disabled={!draft.label.trim() || !draft.prompt.trim()}>{L("הוספה", "Add")}</button>
        </form>
      )}
    </section>
  );
}
