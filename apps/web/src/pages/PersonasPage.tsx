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
  const [describe, setDescribe] = useState("");
  const [building, setBuilding] = useState(false);
  // Agent Builder: the chat model writes the assistant from a description; you review it before saving.
  const build = async () => {
    if (!describe.trim()) return;
    setBuilding(true);
    try {
      setDraft(await api<Draft>("/api/personas/build", { method: "POST", body: { description: describe } }));
      setDescribe("");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBuilding(false);
    }
  };
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
          <details className="persona-more">
            <summary>{L("עוד: איך המודל כותב, והצעות פתיחה", "More: how the model writes, and opening suggestions")}</summary>
            <label>
              {L(`טמפרטורה: ${draft.params?.temperature ?? L("ברירת המחדל של המודל", "the model's default")}`, `Temperature: ${draft.params?.temperature ?? "the model's default"}`)}
              <input type="range" min={0} max={2} step={0.1} value={draft.params?.temperature ?? 0.7} onChange={(e) => setDraft({ ...draft, params: { ...draft.params, temperature: Number(e.target.value) } })} />
              <span className="muted small">{L("נמוך = יציב ומדויק (קוד), גבוה = מגוון ויצירתי (כתיבה).", "Low = steady and exact (code), high = varied and creative (writing).")}</span>
            </label>
            {draft.params?.temperature !== undefined && <button type="button" className="as-link small" onClick={() => { const { temperature: _t, ...rest } = draft.params ?? {}; setDraft({ ...draft, params: rest }); }}>{L("חזרה לברירת המחדל", "Back to the default")}</button>}
            <label>
              {L("הצעות פתיחה (אחת בכל שורה), מוצגות כשמתחילים צ'אט איתה", "Opening suggestions (one per line), shown when a chat starts with it")}
              <textarea rows={3} dir="auto" value={(draft.starters ?? []).join("\n")} onChange={(e) => setDraft({ ...draft, starters: e.target.value.split("\n") })} />
            </label>
          </details>
          <div className="row">
            <button type="submit" className="primary" disabled={!draft.name.trim() || !draft.instructions.trim()}>{L("שמור", "Save")}</button>
            <button type="button" onClick={() => setDraft(null)}>{L("ביטול", "Cancel")}</button>
          </div>
        </form>
      ) : (
        <>
        <form className="card stack builder" onSubmit={(e) => { e.preventDefault(); void build(); }}>
          <strong>{L("תאר עוזר במילים", "Describe an assistant in words")}</strong>
          <textarea rows={3} dir="auto" value={describe} onChange={(e) => setDescribe(e.target.value)} placeholder={L("למשל: עוזר שעובר על קוד Unreal C++ שלי, מסביר באגים בעברית ומציע תיקונים קצרים", "e.g. An assistant that reviews my Unreal C++ code, explains bugs simply and suggests short fixes")} />
          <div className="row">
            <span className="muted small grow">{L("מודל הצ'אט כותב שם, הוראות, ובוחר מודל ומאגר ידע מתאימים. תראה הכול ותוכל לשנות לפני שמירה.", "The chat model writes a name and instructions, and picks a fitting model and knowledge base. You see it all and can change it before saving.")}</span>
            <button type="submit" className="primary" disabled={building || !describe.trim()}>{building ? L("בונה…", "Building…") : L("בנה עוזר", "Build it")}</button>
          </div>
        </form>
        <div className="row"><button type="button" className="primary" onClick={() => setDraft({ name: "", instructions: "" })}>{L("+ פרסונה חדשה", "+ New persona")}</button></div>
        </>
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
      {!draft && <FoundPersonas />}
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

interface FoundPersona { app: string; name: string; instructions: string; params?: { temperature?: number }; starters?: string[]; have: boolean }

/**
 * Personas other apps on this computer have: LM Studio presets and Ollama
 * models made with a Modelfile, added in one click (with their settings and
 * example openings). Computer only; hidden when there are none.
 */
function FoundPersonas() {
  const [found, setFound] = useState<FoundPersona[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<{ found: FoundPersona[] }>("/api/personas/found").then((r) => setFound(r.found.filter((f) => !f.have)), () => setFound([]));
  }, []);
  if (!found.length) return null;
  const key = (f: FoundPersona) => `${f.app}\u0000${f.name}`;
  const add = async () => {
    setBusy(true);
    try {
      const items = found.filter((f) => picked.has(key(f))).map((f) => ({ app: f.app, name: f.name }));
      const r = await api<{ added: string[] }>("/api/personas/found/import", { method: "POST", body: { items } });
      toast(L(`נוספו ${r.added.length} פרסונות.`, `Added ${r.added.length} personas.`));
      setFound((fs) => fs.filter((f) => !picked.has(key(f))));
      setPicked(new Set());
      await refreshPersonas();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card stack">
      <h3>{L("נמצאו באפליקציות אחרות במחשב", "Found in other apps on this computer")}</h3>
      <p className="muted small">{L("presets של LM Studio ומודלים של Ollama שנבנו עם Modelfile. ההוראות, ההגדרות והדוגמאות שלהם עוברים, והקבצים המקוריים רק נקראים.", "LM Studio presets and Ollama models built with a Modelfile. Their instructions, settings and examples come along; the original files are only read.")}</p>
      <ul className="list">
        {found.map((f) => (
          <li key={key(f)}>
            <label className="row found-persona">
              <input type="checkbox" checked={picked.has(key(f))} onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(key(f)); else n.delete(key(f)); return n; })} />
              <span className="grow">
                <strong>{f.name}</strong> <span className="pill">{f.app}</span>
                <span className="muted small persona-text" dir="auto">{f.instructions.length > 160 ? `${f.instructions.slice(0, 160)}…` : f.instructions}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="row"><button type="button" className="primary" disabled={!picked.size || busy} onClick={() => void add()}>{L(`הוסף ${picked.size || ""}`, `Add ${picked.size || ""}`)}</button></div>
    </section>
  );
}
