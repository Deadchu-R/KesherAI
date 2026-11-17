import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

interface Model { id: string; name: string; category?: string }

/**
 * Settings → Models → the model team (design ModelTeam, RESEARCH_LOG "Hebrew answers while coding"): the coding model
 * works with the user's own words; when its final answer comes out in another language or with mixed alphabets, the
 * translator puts the prose into the user's language and leaves code, files and commands as they are.
 */
export function ModelTeamSection() {
  const [translator, setTranslator] = useState<string | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  useEffect(() => {
    void api<{ translator: string }>("/api/model-team").then((r) => setTranslator(r.translator), () => undefined);
    void api<{ models: Model[] }>("/api/models").then((r) => setModels(r.models.filter((m) => (m.category ?? "chat") === "chat")), () => undefined);
  }, []);
  if (translator === null) return null;
  const save = (v: string) => {
    setTranslator(v);
    void api("/api/model-team", { method: "PUT", body: { translator: v } }).catch((e: Error) => toast(e.message));
  };
  return (
    <section className="card stack">
      <h2>{L("צוות המודלים", "The model team")}</h2>
      <p className="muted small">{L("המודל של הצ'אט מקבל את מה שכתבת כמו שהוא. אם התשובה שלו יוצאת באנגלית או עם אותיות משפות אחרות, המתרגם מעביר את הטקסט לשפה שבה כתבת. קוד, קבצים ופקודות נשארים כמו שהם.", "The chat's model gets your words as they are. When its answer comes out in English or with letters of other languages, the translator puts the text into the language you wrote in. Code, files and commands stay as they are.")}</p>
      <label className="row">
        <span className="grow">🗣️ {L("המתרגם", "The translator")}</span>
        <select value={translator} onChange={(e) => save(e.target.value)} aria-label={L("המתרגם", "The translator")}>
          <option value="main">{L("המודל של הצ'אט", "The chat's own model")}</option>
          {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          <option value="off">{L("כבוי", "Off")}</option>
        </select>
      </label>
      <p className="muted small">{L("מודל תרגום קטן (TranslateGemma) מהיר יותר מהמודל הגדול. הורד אותו מעמוד המודלים ובחר אותו כאן.", "A small translation model (TranslateGemma) is faster than the big one. Download it on the Models page and choose it here.")}</p>
    </section>
  );
}
