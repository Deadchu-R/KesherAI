import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale } from "../i18n";
import { toast } from "../library";
import { refreshPrompts, usePrompts, type SavedPrompt } from "../SlashMenu";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);
type Draft = Omit<SavedPrompt, "id"> & { id?: string };
const HE_TITLES: Record<string, string> = { summarize: "סיכום", translate: "תרגום (עברית ⇄ אנגלית)", fix: "תיקון באג", explain: "הסבר פשוט", email: "כתיבת מייל", review: "סקירת קוד" };

/** The prompt library: prompts run with `/command` in any message box. */
export function PromptsPage() {
  const prompts = usePrompts();
  const [templates, setTemplates] = useState<Draft[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    void api<{ templates: Draft[] }>("/api/prompts").then((r) => setTemplates(r.templates), () => undefined);
  }, []);
  const save = async (d: Draft) => {
    try {
      await api("/api/prompts", { method: "POST", body: d });
      setDraft(null);
      await refreshPrompts();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const remove = async (p: SavedPrompt) => {
    await api(`/api/prompts/${p.id}`, { method: "DELETE" }).catch((e: Error) => toast(e.message));
    await refreshPrompts();
  };
  const have = new Set(prompts.map((p) => p.command));
  const title = (tp: Draft) => (getLocale() === "he" ? HE_TITLES[tp.command] ?? tp.title : tp.title);
  return (
    <div className="page prompts">
      <div className="page-head">
        <h1>{L("פרומפטים", "Prompts")}</h1>
        <p className="muted">{L("פרומפטים שמורים שמפעילים בהקלדת / בכל תיבת הודעה. {{input}} בפרומפט מוחלף במה שכותבים אחרי הפקודה, למשל: /translate בוקר טוב", "Saved prompts you run by typing / in any message box. {{input}} in a prompt is replaced by what you write after the command, e.g. /translate good morning")}</p>
      </div>
      {draft ? (
        <form className="card kb-form" onSubmit={(e) => { e.preventDefault(); void save(draft); }}>
          <div className="row">
            <label>{L("פקודה", "Command")}<input dir="ltr" value={`/${draft.command}`} onChange={(e) => setDraft({ ...draft, command: e.target.value.replace(/^\/+/, "") })} autoFocus /></label>
            <label className="grow">{L("כותרת", "Title")}<input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
          </div>
          <label>{L("הפרומפט", "The prompt")}<textarea rows={7} dir="auto" value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} placeholder={"…\n\n{{input}}"} /></label>
          <div className="row">
            <button type="submit" className="primary" disabled={!draft.command.trim() || !draft.text.trim()}>{L("שמור", "Save")}</button>
            <button type="button" onClick={() => setDraft(null)}>{L("ביטול", "Cancel")}</button>
          </div>
        </form>
      ) : (
        <div className="row"><button type="button" className="primary" onClick={() => setDraft({ command: "", title: "", text: "" })}>{L("+ פרומפט חדש", "+ New prompt")}</button></div>
      )}
      {prompts.map((p) => (
        <section key={p.id} className="card persona-card">
          <div className="row">
            <strong className="slash-cmd" dir="ltr">/{p.command}</strong>
            <span className="muted small" dir="auto">{p.title}</span>
            <span className="grow" />
            <button type="button" onClick={() => setDraft(p)}>{L("עריכה", "Edit")}</button>
            <button type="button" onClick={() => void remove(p)}>{L("מחיקה", "Delete")}</button>
          </div>
          <p className="muted small persona-text" dir="auto">{p.text.length > 240 ? `${p.text.slice(0, 240)}…` : p.text}</p>
        </section>
      ))}
      {!draft && templates.some((tp) => !have.has(tp.command)) && (
        <section className="card">
          <h3>{L("להוסיף בלחיצה", "Add with one click")}</h3>
          <div className="persona-templates">
            {templates.filter((tp) => !have.has(tp.command)).map((tp) => (
              <button key={tp.command} type="button" onClick={() => void save({ ...tp, title: title(tp) })}>
                {title(tp)} <span className="slash-cmd muted" dir="ltr">/{tp.command}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
