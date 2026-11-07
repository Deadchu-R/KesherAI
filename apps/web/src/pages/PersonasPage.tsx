import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale } from "../i18n";
import { createConversation, refreshLibrary, toast } from "../library";
import { ModelMenu } from "../ModelMenu";
import { refreshPersonas, usePersonas, type Persona } from "../Personas";
import { useModels } from "../useModels";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);
type Draft = Omit<Persona, "id"> & { id?: string };
const HE_NAMES: Record<string, string> = { "Unity mentor": "מנטור Unity", "Code reviewer": "סוקר קוד", Translator: "מתרגם", Editor: "עורך לשון", Teacher: "מורה" };
const localName = (n: string) => (getLocale() === "he" ? HE_NAMES[n] ?? n : n);

/** Personas: saved assistants with their own instructions, model and knowledge base. */
export function PersonasPage() {
  const personas = usePersonas();
  const { models } = useModels("chat");
  const [templates, setTemplates] = useState<Draft[]>([]);
  const [bases, setBases] = useState<string[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    void api<{ templates: Draft[] }>("/api/personas").then((r) => setTemplates(r.templates), () => undefined);
    void api<{ bases: Array<{ name: string }> }>("/api/knowledge").then((r) => setBases(r.bases.map((b) => b.name)), () => undefined);
  }, []);
  const save = async () => {
    if (!draft) return;
    try {
      await api("/api/personas", { method: "POST", body: draft });
      setDraft(null);
      await refreshPersonas();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const remove = async (p: Persona) => {
    if (!confirm(L(`למחוק את "${p.name}"?`, `Delete "${p.name}"?`))) return;
    await api(`/api/personas/${p.id}`, { method: "DELETE" }).catch((e: Error) => toast(e.message));
    await refreshPersonas();
  };
  const chat = async (p: Persona) => {
    const id = await createConversation({ kind: "chat", personaId: p.id, ...(p.modelId ? { modelId: p.modelId } : {}) }).catch((e: Error) => (toast(e.message), ""));
    if (id) void refreshLibrary().catch(() => undefined);
  };
  return (
    <div className="page personas">
      <div className="page-head">
        <h1>{L("פרסונות", "Personas")}</h1>
        <p className="muted">{L("עוזרים שמורים עם הוראות משלהם — ואם תרצו גם מודל ומאגר ידע משלהם. בוחרים פרסונה בתיבת ההודעה, ואפשר להחליף באמצע שיחה.", "Saved assistants with their own instructions, and if you like their own model and knowledge base. Pick one in the message box; you can switch in the middle of a chat.")}</p>
      </div>
      {draft ? (
        <form className="card kb-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <div className="row">
            <label className="persona-icon">{L("סמל", "Icon")}<input value={draft.icon ?? ""} onChange={(e) => setDraft({ ...draft, icon: e.target.value })} maxLength={4} /></label>
            <label className="grow">{L("שם", "Name")}<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus /></label>
          </div>
          <label>{L("הוראות — מי היא, איך היא עונה, מה חשוב לה", "Instructions — who it is, how it answers, what matters")}<textarea rows={7} dir="auto" value={draft.instructions} onChange={(e) => setDraft({ ...draft, instructions: e.target.value })} /></label>
          <div className="row">
            <span className="muted small">{L("מודל:", "Model:")}</span>
            <ModelMenu models={models} value={draft.modelId ?? ""} onChange={(id) => setDraft({ ...draft, modelId: id })} />
            {draft.modelId && <button type="button" className="as-link" onClick={() => { const { modelId: _m, ...rest } = draft; setDraft(rest); }}>{L("המודל הרגיל", "Usual model")}</button>}
          </div>
          {!!bases.length && (
            <label>
              {L("מאגר ידע לחפש בו קודם", "Knowledge base to search first")}
              <select value={draft.knowledge ?? ""} onChange={(e) => setDraft({ ...draft, knowledge: e.target.value })}>
                <option value="">{L("ללא", "None")}</option>
                {bases.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </label>
          )}
          <div className="row">
            <button type="submit" className="primary" disabled={!draft.name.trim() || !draft.instructions.trim()}>{L("שמור", "Save")}</button>
            <button type="button" onClick={() => setDraft(null)}>{L("ביטול", "Cancel")}</button>
          </div>
        </form>
      ) : (
        <div className="row"><button type="button" className="primary" onClick={() => setDraft({ name: "", instructions: "" })}>{L("+ פרסונה חדשה", "+ New persona")}</button></div>
      )}
      {personas.map((p) => (
        <section key={p.id} className="card persona-card">
          <div className="row">
            <span className="persona-mark" aria-hidden>{p.icon || p.name.slice(0, 1)}</span>
            <strong>{p.name}</strong>
            <span className="muted small">{[p.modelId?.split("/").slice(-1)[0], p.knowledge && `${L("ידע", "Knowledge")}: ${p.knowledge}`].filter(Boolean).join(" · ")}</span>
            <span className="grow" />
            <button type="button" className="primary" onClick={() => void chat(p)}>{L("שיחה חדשה", "New chat")}</button>
            <button type="button" onClick={() => setDraft(p)}>{L("עריכה", "Edit")}</button>
            <button type="button" onClick={() => void remove(p)}>{L("מחיקה", "Delete")}</button>
          </div>
          <p className="muted small persona-text" dir="auto">{p.instructions.length > 220 ? `${p.instructions.slice(0, 220)}…` : p.instructions}</p>
        </section>
      ))}
      {!draft && (
        <section className="card">
          <h3>{L("להתחיל מתבנית", "Start from a template")}</h3>
          <div className="persona-templates">
            {templates.map((tp) => (
              <button key={tp.name} type="button" onClick={() => setDraft({ ...tp, name: localName(tp.name) })}>
                <span aria-hidden>{tp.icon}</span> {localName(tp.name)}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
